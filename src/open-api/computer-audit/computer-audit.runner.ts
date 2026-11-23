import { savedUiLanguage, withOutputLanguage } from "../../common/i18n/ai-language"
import { withUiLanguage } from "../../common/i18n/request-language"
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Interval } from "@nestjs/schedule"
import { Prisma, type AsinAuditTask, type AsinAuditTaskPayload } from "@prisma/client"
import axios from "axios"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { buildReviewPainPointsSkill } from "../../asin-audit/prompts/skill-assembler"
import type { AuditEvidence } from "../../asin-audit/types/audit.types"
import { AiGatewayProvider } from "../../common/providers/ai-gateway.provider"
import { PrismaService } from "../../prisma/prisma.service"
import {
  AutomotiveAuditLockService,
  MissingCrawlerReceipt,
} from "../automotive-audit/automotive-audit-lock.service"
import { asJson } from "../automotive-audit/automotive-audit.types"
import { CreateComputerAuditDto } from "./computer-audit.dto"
import {
  COMPUTER_CONSISTENCY_PROMPT,
  COMPUTER_RULE_VERSION,
  adaptComputerProduct,
  buildComputerResult,
  buildPartialComputerResult,
  computerOptimizePrompt,
  computerScorePrompt,
  finalizeComputerOptimization,
  readComputerScore,
  readPartialComputerOptimization,
  getConfigurationReview,
  hashComputerValue,
  parseComputerJson,
  validateComputerConsistency,
} from "./computer-audit.kernel"
import {
  ComputerAuditError,
  type ComputerPhase,
  type JsonRecord,
  type RecordedHttp,
} from "./computer-audit.types"
import { mergeOutputGap, planOptimizationRecovery, planScoreRecovery, type OutputGap } from "./computer-output-recovery"
import { ComputerMcpClient } from "./computer-mcp.client"
import { ComputerSifClient } from "./computer-sif.client"
import { ComputerTrafficCollector } from "./computer-traffic"

type Task = AsinAuditTask & { payload: AsinAuditTaskPayload | null }

@Injectable()
export class ComputerAuditRunner implements OnModuleDestroy {
  private readonly logger = new Logger(ComputerAuditRunner.name)
  private isStopping = false
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly gateway: AiGatewayProvider,
    private readonly lock: AutomotiveAuditLockService
  ) {}
  onModuleDestroy() {
    this.isStopping = true
  }

  @Interval(3000)
  async tick() {
    if (this.isStopping || !this.lock.hasCapacity) return
    try {
      const pending = await this.lock.findNextAudit(this.prisma, "COMPUTER")
      if (!pending) return
      await this.lock.runJob("audit", pending.id, async assertLock => {
        const task = await this.prisma.asinAuditTask.findFirst({
          where: { id: pending.id, auditType: "COMPUTER", status: { in: ["QUEUED", "RUNNING"] } },
          orderBy: { id: "asc" },
          include: { payload: true },
        })
        if (task) {
          const language = savedUiLanguage((task.payload?.config as { responseLanguage?: string } | null)?.responseLanguage)
          await withUiLanguage(language, () => this._run(task, assertLock))
        }
      })
    } catch {
      this.logger.error("电脑审计调度中断，保留阶段记录，禁止盲目重新调用")
    }
  }

  private async _http(
    taskId: number,
    assertLock: () => Promise<void>,
    provider: "CRAWLER" | "SIF",
    url: string,
    method: string,
    body: unknown,
    headers: Record<string, string>,
    isCacheOnly = false
  ) {
    const request = { url, method, ...(body === undefined ? {} : { body }) }
    const requestKey = hashComputerValue({ provider, request })
    let existing = await this.prisma.asinAuditCrawlSnapshot.findFirst({
      where: { taskId, provider, requestKey },
    })
    if (provider === "CRAWLER" && existing && ["SUBMITTING", "UNKNOWN"].includes(existing.state)) {
      // An operator may have obtained a separate receipt for this exact original request.
      const replacement = await this.prisma.asinAuditCrawlSnapshot.findFirst({
        where: {
          taskId,
          provider,
          state: "RECEIVED",
          httpStatus: 200,
          AND: [
            { request: { path: "$.originalSnapshotId", equals: existing.id } },
            { request: { path: "$.purpose", equals: "MANUAL_SINGLE_VERIFICATION" } },
          ],
        },
        orderBy: { id: "desc" },
      })
      if (replacement) {
        const saved = replacement.request as JsonRecord
        const expectedKey = hashComputerValue({
          originalKey: requestKey,
          attempt: replacement.snapshotId,
        })
        if (
          replacement.requestKey !== expectedKey ||
          saved.method !== method ||
          saved.url !== url ||
          !isDeepStrictEqual(saved.body, body)
        )
          throw new ComputerAuditError("AUDIT_CACHE_MISMATCH", "补充回执与原爬虫请求不匹配")
        existing = replacement
      }
    }
    if (existing) {
      if (
        existing.state !== "RECEIVED" ||
        existing.rawResponse === null ||
        existing.httpStatus === null
      )
        throw new ComputerAuditError(
          `${provider}_OUTCOME_UNKNOWN`,
          "已有外部请求失败或结果未知，不自动重发"
        )
      if (createHash("sha256").update(existing.rawResponse).digest("hex") !== existing.responseHash)
        throw new ComputerAuditError("AUDIT_CACHE_MISMATCH", "原始响应哈希不匹配")
      return {
        status: existing.httpStatus,
        raw: existing.rawResponse,
        snapshotId: existing.snapshotId,
      }
    }
    if (isCacheOnly) throw new MissingCrawlerReceipt()
    await assertLock()
    const row = await this.prisma.asinAuditCrawlSnapshot.create({
      data: {
        taskId,
        snapshotId: `crawl_${randomUUID()}`,
        provider,
        requestKey,
        request: asJson(request),
      },
    })
    await assertLock()
    const start = Date.now()
    let response: { status: number; data: string }
    try {
      response = await axios.request<string>({
        url,
        method,
        data: body,
        headers,
        timeout: provider === "CRAWLER" ? 600_000 : 120_000,
        signal: provider === "CRAWLER" ? AbortSignal.timeout(600_000) : undefined,
        maxRedirects: 0,
        responseType: "text",
        transformResponse: [(value: string) => value],
        validateStatus: () => true,
      })
    } catch {
      await this.prisma.asinAuditCrawlSnapshot.update({
        where: { id: row.id },
        data: {
          state: "UNKNOWN",
          durationMs: Date.now() - start,
          error: { code: `${provider}_TRANSPORT_ERROR`, message: "连接中断或超时，不自动重发" },
        },
        select: { id: true },
      })
      throw new ComputerAuditError(
        `${provider}_TRANSPORT_ERROR`,
        "外部请求中断或超时，已保留请求记录"
      )
    }
    // Persist receipt before interpretation, including HTTP error/non-JSON bodies.
    const raw = response.data
    await this.prisma.asinAuditCrawlSnapshot.update({
      where: { id: row.id },
      data: {
        state: "RECEIVED",
        rawResponse: raw,
        responseHash: createHash("sha256").update(raw).digest("hex"),
        httpStatus: response.status,
        durationMs: Date.now() - start,
        fetchedAt: new Date(),
      },
      select: { id: true },
    })
    await assertLock()
    return { status: response.status, raw, snapshotId: row.snapshotId }
  }

  private async _mcp<T>(
    taskId: number,
    assertLock: () => Promise<void>,
    request: JsonRecord,
    work: () => Promise<T>
  ): Promise<T> {
    const requestKey = hashComputerValue({ provider: "MCP", request })
    const existing = await this.prisma.asinAuditCrawlSnapshot.findFirst({
      where: { taskId, provider: "MCP", requestKey },
    })
    if (existing) {
      if (existing.state !== "RECEIVED" || !existing.rawResponse)
        throw new ComputerAuditError("MCP_OUTCOME_UNKNOWN", "已有竞品请求结果未知，不自动重发")
      if (createHash("sha256").update(existing.rawResponse).digest("hex") !== existing.responseHash)
        throw new ComputerAuditError("AUDIT_CACHE_MISMATCH", "竞品缓存哈希错误")
      return JSON.parse(existing.rawResponse) as T
    }
    await assertLock()
    const row = await this.prisma.asinAuditCrawlSnapshot.create({
      data: {
        taskId,
        snapshotId: `evidence_${randomUUID()}`,
        provider: "MCP",
        requestKey,
        request: asJson(request),
      },
    })
    await assertLock()
    try {
      const result = await work()
      const raw = JSON.stringify(result)
      await this.prisma.asinAuditCrawlSnapshot.update({
        where: { id: row.id },
        data: {
          state: "RECEIVED",
          rawResponse: raw,
          responseHash: createHash("sha256").update(raw).digest("hex"),
          fetchedAt: new Date(),
        },
        select: { id: true },
      })
      return result
    } catch {
      await this.prisma.asinAuditCrawlSnapshot.update({
        where: { id: row.id },
        data: {
          state: "UNKNOWN",
          error: { code: "MCP_REQUEST_FAILED", message: "竞品请求未完成，不自动重试" },
        },
        select: { id: true },
      })
      throw new ComputerAuditError("MCP_REQUEST_FAILED", "竞品查询失败，已有证据保留")
    }
  }

  private async _getRecordedCompetitorTool(taskId: number, asin: string, url: string) {
    const row = await this.prisma.asinAuditCrawlSnapshot.findFirst({
      where: { taskId, provider: "MCP" },
      orderBy: { id: "asc" },
      select: { request: true, requestKey: true },
    })
    if (!row) return undefined
    const saved = row.request as JsonRecord
    const args = saved.arguments as JsonRecord | undefined
    if (
      saved.url !== url ||
      typeof saved.name !== "string" ||
      args?.asin !== asin ||
      args.marketplace !== "US" ||
      args.size !== 10
    )
      return undefined
    // Use the application's original key order (MySQL JSON reorders object keys).
    const request = { name: saved.name, arguments: { marketplace: "US", asin, size: 10 }, url }
    if (hashComputerValue({ provider: "MCP", request }) !== row.requestKey)
      throw new ComputerAuditError("AUDIT_CACHE_MISMATCH", "竞品取证请求与已存快照不匹配")
    return saved.name
  }

  private async _phase<T>(
    task: Task,
    phases: Record<string, ComputerPhase>,
    name: string,
    model: string,
    request: { system: string; user: string },
    parse: (text: string) => T,
    assertLock: () => Promise<void>
  ): Promise<T> {
    const inputHash = hashComputerValue({ model, request, version: COMPUTER_RULE_VERSION })
    let phase = phases[name]
    if (phase && phase.inputHash !== inputHash)
      throw new ComputerAuditError("AUDIT_CACHE_MISMATCH", "阶段缓存与输入不匹配")
    const save = () =>
      this.prisma.asinAuditTaskPayload.update({
        where: { taskId: task.id },
        data: { phases: asJson(phases) },
        select: { id: true },
      })
    const cached =
      phase &&
      (["RECEIVED", "COMPLETED"].includes(phase.state) ||
        (phase.state === "FAILED" &&
          (["score", "optimize"].includes(name) || /^(score|optimize)_repair_/.test(name))))
    if (cached) {
      let result: T
      try {
        result = parse(phase.content ?? "")
      } catch {
        throw new ComputerAuditError("MODEL_RESPONSE_INVALID", "阶段原文未通过校验")
      }
      if (phase.state !== "COMPLETED") {
        await assertLock()
        phase.result = result
        phase.state = "COMPLETED"
        await save()
      }
      return result
    }
    if (phase)
      throw new ComputerAuditError(
        "MODEL_OUTCOME_UNKNOWN",
        `模型阶段 ${name} 已有请求，结果待核对，不自动重新调用`
      )
    phase = { state: "SUBMITTING", inputHash, request, content: "", finishReason: null }
    phases[name] = phase
    await assertLock()
    await save()
    await assertLock()
    let hasTransportFailed = false
    try {
      for await (const event of this.gateway.streamChat(withOutputLanguage(request.system), request.user, {
        model,
        operationName: `电脑审计:${name}`,
        temperature: 0,
        maxOutputTokens: name === "score" || name === "optimize" ? 16000 : 6000,
        resolveBilling: true,
        onFinishReason: reason => {
          phase.finishReason = reason
        },
      })) {
        if (event.type === "text") phase.content += event.content
        if (event.type === "usage") phase.usage = event.rawUsage ?? event.usage
        if (event.type === "billing") phase.billing = event.billing
      }
    } catch {
      hasTransportFailed = true
    }
    await assertLock()
    phase.streamInterrupted = hasTransportFailed
    phase.state = "RECEIVED"
    await save()
    await assertLock()
    let result: T
    try {
      result = parse(phase.content ?? "")
    } catch {
      phase.state = hasTransportFailed ? "UNKNOWN" : "FAILED"
      await save()
      throw new ComputerAuditError(
        hasTransportFailed ? "MODEL_REQUEST_FAILED" : "MODEL_RESPONSE_INVALID",
        `模型${name}阶段未取得可验证结果，原文保留，不自动重新调用`
      )
    }
    phase.result = result
    phase.state = "COMPLETED"
    await save()
    return result
  }

  private async _recoverOutput<T>(
    task: Task,
    phases: Record<string, ComputerPhase>,
    name: "score" | "optimize",
    model: string,
    request: { system: string; user: string },
    parse: (text: string) => T,
    assertLock: () => Promise<void>,
    allowSupplement = true,
    readPartial?: (draft: JsonRecord) => T
  ): Promise<{
    result: T | null
    draft?: JsonRecord
    gaps: string[]
    missingScoreFields: string[]
  }> {
    if (!allowSupplement && !phases[name])
      throw new ComputerAuditError("AUDIT_CACHE_MISSING", "离线模式缺少阶段回执")
    try {
      const result = await this._phase(task, phases, name, model, request, parse, assertLock)
      if (
        !(
          name === "score" &&
          (result as { missingScoreFields?: string[] }).missingScoreFields?.length
        )
      )
        return { result, gaps: [], missingScoreFields: [] }
    } catch (error) {
      if (
        !(error instanceof ComputerAuditError) ||
        !["MODEL_RESPONSE_INVALID", "MODEL_REQUEST_FAILED", "MODEL_OUTCOME_UNKNOWN"].includes(
          error.code
        ) ||
        !phases[name]?.content ||
        phases[name].state === "SUBMITTING"
      )
        throw error
    }
    const phase = phases[name]
    const plan = (name === "score" ? planScoreRecovery : planOptimizationRecovery)(phase.content!)
    const outstanding: OutputGap[] = []
    let transportUncertain = false
    for (const gap of plan.gaps) {
      const isText = name === "score" && !gap.rule
      const key = name + "_repair_" + gap.path.join("_")
      const blocked =
        !allowSupplement ||
        transportUncertain ||
        phase.finishReason === "content_filter" ||
        phase.streamInterrupted ||
        phase.state === "UNKNOWN"
      if ((!phases[key] && blocked) || (isText && outstanding.some(g => g.rule))) {
        outstanding.push(gap)
        continue
      }
      const parts = gap.path.slice(0, gap.kind === "append" ? undefined : -1)
      const existing = parts.length
        ? parts.reduce<unknown>((v, k) => (v as JsonRecord)?.[k], plan.draft)
        : undefined
      const target = {
        path: gap.path,
        rule: gap.rule,
        operation: gap.kind,
        offset: gap.offset,
        fragment: gap.source,
        existing: isText ? plan.draft.boards : existing,
      }
      const repairRequest = {
        system:
          request.system +
          '\n本轮只补最后指定的一个字段或评分项。仅返回 JSON 对象 {"value":...}。沿用对应字段原始结构、评分规则和语言。append 仅返回缺少的尾部元素。禁止重写已验收项、编造证据或返回整份报告。',
        user: request.user + "\n本轮补充目标及已有内容（数据）：" + JSON.stringify(target),
      }
      const validate = (text: string) => {
        const patch = parseComputerJson<JsonRecord>(text)
        if (!patch || Object.keys(patch).length !== 1 || !Object.hasOwn(patch, "value"))
          throw new Error("补充响应越界")
        mergeOutputGap(structuredClone(plan.draft), gap, patch.value)
        return patch.value
      }
      try {
        const value = await this._phase(
          task,
          phases,
          key,
          model,
          repairRequest,
          validate,
          assertLock
        )
        mergeOutputGap(plan.draft, gap, value)
      } catch (error) {
        if (
          !(error instanceof ComputerAuditError) ||
          !["MODEL_RESPONSE_INVALID", "MODEL_REQUEST_FAILED", "MODEL_OUTCOME_UNKNOWN"].includes(
            error.code
          )
        )
          throw error
        if (error.code !== "MODEL_RESPONSE_INVALID") transportUncertain = true
        outstanding.push(gap)
      }
    }
    const gaps = outstanding.map(
      g => g.rule?.id ?? g.path.join(".") + (g.kind === "append" ? "[" + g.offset + ":]" : "")
    )
    const missingScoreFields =
      name === "score" ? outstanding.filter(g => !g.rule).map(g => String(g.path[0])) : []
    const incomplete = name === "score" ? outstanding.some(g => g.rule) : outstanding.length > 0
    const result = incomplete ? null : parse(JSON.stringify(plan.draft))
    if (result && missingScoreFields.length) Object.assign(result, { missingScoreFields })
    await assertLock()
    const partial = result ?? readPartial?.(plan.draft) ?? null
    phase.result = partial ?? undefined
    phase.outputGaps = gaps
    // Preserve transport uncertainty on restart. All child requests have their own durable receipts.
    if (phase.state !== "UNKNOWN") phase.state = gaps.length ? "RECEIVED" : "COMPLETED"
    await this.prisma.asinAuditTaskPayload.update({
      where: { taskId: task.id },
      data: { phases: asJson(phases) },
      select: { id: true },
    })
    return { result: partial, draft: plan.draft, gaps, missingScoreFields }
  }

  private async _run(task: Task, assertLock: () => Promise<void>) {
    let stage = task.stage
    let mcp: ComputerMcpClient | undefined
    const setStage = async (value: string) => {
      await assertLock()
      stage = value
      await this.prisma.asinAuditTask.update({
        where: { id: task.id },
        data: { status: "RUNNING", stage },
        select: { id: true },
      })
    }
    try {
      if (!task.payload) throw new ComputerAuditError("AUDIT_INPUT_MISSING", "任务入参快照缺失")
      const app = await this.prisma.openApiApp.findUnique({
        where: { appId: task.appId },
        select: { status: true, isComputerAuditEnabled: true },
      })
      if (app?.status !== "ACTIVE" || !app.isComputerAuditEnabled)
        throw new ComputerAuditError("COMPUTER_AUDIT_FORBIDDEN", "接入方已停用或电脑审计权限已撤销")
      const settings = task.payload.config as Record<string, string>
      if (settings.ruleVersion !== COMPUTER_RULE_VERSION)
        throw new ComputerAuditError("AUDIT_VERSION_CHANGED", "规则版本变化，不自动重审旧任务")
      const currentGateway = this.config.get<string>(
        "AI_GATEWAY_BASE_URL",
        "https://ai-gateway-api-dev.zhilingtech.com/v1"
      )
      if (currentGateway !== settings.gatewayBaseUrl)
        throw new ComputerAuditError("AUDIT_CONFIG_CHANGED", "网关配置与受理快照不同")
      const input = task.payload.input as unknown as CreateComputerAuditDto
      const phases = (task.payload.phases ?? {}) as unknown as Record<string, ComputerPhase>
      const http: RecordedHttp = (...args) => this._http(task.id, assertLock, ...args)
      // Keep identical transport semantics to CrawlerProvider and automotive audit.
      const crawlerHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.get<string>("CRAWLER_API_TOKEN", "")}`,
      }
      const productUrl = `https://www.amazon.com/dp/${task.asin}`
      const warnings: string[] = []
      const { product, adapted, isSoldOut } = await this.lock.reuseOrRunCrawler(
        assertLock,
        async isCacheOnly => {
          if (!isCacheOnly) await setStage("CRAWLING")
          const crawl = (path: string) =>
            this._http(
              task.id,
              assertLock,
              "CRAWLER",
              `${settings.crawlerBaseUrl.replace(/\/$/, "")}/${path}`,
              "POST",
              { url: productUrl },
              crawlerHeaders,
              isCacheOnly
            )
          const crawled = await crawl("audit")
          if (crawled.status !== 200)
            throw new ComputerAuditError(
              "CRAWLER_HTTP_ERROR",
              `爬虫HTTP ${crawled.status}，响应已保存`
            )
          const { product, adapted, isSoldOut } = adaptComputerProduct(
            task.asin,
            JSON.parse(crawled.raw),
            task.createdAt.toISOString()
          )
          if (!adapted.A.secondTitle && isSoldOut !== true) {
            const highlights = await crawl("highlights")
            if (highlights.status === 200) {
              const raw = JSON.parse(highlights.raw) as {
                code?: number
                data?: { title?: string; second_title?: string }
              }
              if (
                raw.code === 200 &&
                raw.data &&
                raw.data.title?.trim() === adapted.A.title?.trim()
              )
                adapted.A.secondTitle = raw.data.second_title || null
              else warnings.push("补抓商品亮点与原标题不一致或响应无效，未混用不同版本商品内容")
            } else warnings.push(`商品亮点补抓HTTP ${highlights.status}，仅使用已有内容`)
          }
          return { product, adapted, isSoldOut }
        }
      )
      const configurationReview = getConfigurationReview(
        input,
        adapted.A.title ?? "",
        adapted.A.secondTitle ?? ""
      )
      if (isSoldOut === true) {
        await this._complete(
          task.id,
          {
            schemaVersion: "1",
            auditType: "COMPUTER",
            ruleVersion: COMPUTER_RULE_VERSION,
            isSoldOut: true,
            listing: {
              status: "SKIPPED",
              score: null,
              reason: "爬虫确认缺货，沿原脚本跳过内容及评分",
            },
            keywordTraffic: { status: "SKIPPED", score: null, reason: "缺货跳过取证与评分" },
            configurationReview,
          },
          null,
          null
        )
        return
      }
      await setStage("EVIDENCE")
      // Freeze provider origins to the received task; credentials remain runtime-only.
      const scopedConfig = new ConfigService({
        ...process.env,
        SIF_BASE_URL: settings.sifBaseUrl,
        SIF_API_KEY: this.config.get<string>("SIF_API_KEY"),
        SELLERSPRITE_MCP_URL: settings.mcpUrl,
        SELLERSPRITE_SECRET_KEY: this.config.get<string>("SELLERSPRITE_SECRET_KEY"),
      })
      const sif = new ComputerSifClient(scopedConfig, http)
      mcp = new ComputerMcpClient(
        scopedConfig,
        (request, work) =>
          this._mcp(task.id, assertLock, { ...request, url: settings.mcpUrl }, work),
        await this._getRecordedCompetitorTool(task.id, task.asin, settings.mcpUrl)
      )
      const de = await new ComputerTrafficCollector(sif, mcp, task.createdAt).collect(
        task.asin,
        "US",
        warnings,
        () => {}
      )
      const evidence: AuditEvidence = {
        asin: task.asin,
        country: "US",
        market: "amazon_us",
        A: adapted.A,
        P: adapted.P,
        B: adapted.B,
        C: de.C,
        D: de.D,
        E: de.E,
        meta: {
          ...de.meta,
          sources: { ...de.meta.sources, A: ["erp"], P: ["erp"], B: ["erp"] },
          fetchedAt: task.createdAt.toISOString(),
          sifWarnings: warnings,
        },
      }
      await setStage("TEXT_REVIEW")
      if (evidence.B.reviewSamples?.length) {
        const comments = evidence.B.reviewSamples.slice(0, 200).map(r => r.text.slice(0, 600))
        try {
          evidence.B.richPainPoints = await this._phase(
            task,
            phases,
            "reviews",
            settings.model,
            {
              system:
                buildReviewPainPointsSkill() +
                "\n中文说明，返回{painPoints:[{text,freq,quote}]}；quote必须连续摘录一条评论原文，不得将优点当痛点。没有明确差评可返回空数组。",
              user: JSON.stringify({ comments }),
            },
            text => {
              const raw = parseComputerJson<{
                painPoints: { text: string; freq?: number; quote: string }[]
              }>(text)
              if (
                !Array.isArray(raw.painPoints) ||
                raw.painPoints.some(
                  item =>
                    !item.text ||
                    !item.quote ||
                    !comments.some(comment => comment.includes(item.quote))
                )
              )
                throw new Error("评论引用无效")
              return raw.painPoints
            },
            assertLock
          )
          evidence.B.painPoints = evidence.B.richPainPoints.map(item => item.text)
        } catch (error) {
          if (!(error instanceof ComputerAuditError)) throw error
          warnings.push("评论痛点阶段未取得有效结果；保留评论原文，不将缺少分析当作没有差评")
        }
      }
      await this.prisma.asinAuditTaskPayload.update({
        where: { taskId: task.id },
        data: { normalizedInput: asJson({ evidence, configurationReview, isSoldOut, product }) },
        select: { id: true },
      })
      const textInput = {
        title: evidence.A.title ?? "",
        bullets: evidence.A.bullets ?? [],
        description: evidence.A.description ?? "",
      }
      const parseConsistency = (text: string) =>
        validateComputerConsistency(parseComputerJson(text), evidence)
      let consistency =
        !textInput.title || (!textInput.bullets.length && !textInput.description.trim())
          ? validateComputerConsistency(
              { hasContradiction: null, reason: "标题或全部正文缺失", contradictions: [] },
              evidence
            )
          : await this._phase(
              task,
              phases,
              "consistency",
              settings.model,
              { system: COMPUTER_CONSISTENCY_PROMPT, user: JSON.stringify(textInput) },
              parseConsistency,
              assertLock
            )
      if (consistency.hasContradiction)
        consistency = await this._phase(
          task,
          phases,
          "consistencyVerification",
          settings.model,
          {
            system:
              COMPUTER_CONSISTENCY_PROMPT +
              "\n本轮独立复核draft；不得为了保持一致接受初判，重新检查全部正文。",
            user: JSON.stringify({ ...textInput, draft: consistency }),
          },
          parseConsistency,
          assertLock
        )
      await setStage("SCORING")
      const scoreRequest = computerScorePrompt(
        evidence,
        consistency,
        configurationReview,
        settings.scoreOutputFormat === "compact"
      )
      if (settings.outputFormatVersion === "2")
        scoreRequest.user +=
          "\n每个评分项只写必要证据和扣分原因。保留 24 项及其顺序，诊断和行动只引用规则编号，省去重复转述，用紧凑 JSON 闭合整份输出。"
      const scoreOutput = await this._recoverOutput(
        task,
        phases,
        "score",
        settings.model,
        scoreRequest,
        text => readComputerScore(text, evidence),
        assertLock
      )
      const score = scoreOutput.result
      if (!score) {
        const result = buildPartialComputerResult(
          scoreOutput.draft!,
          scoreOutput.gaps,
          scoreOutput.missingScoreFields,
          evidence,
          consistency,
          configurationReview,
          settings.model
        )
        await assertLock()
        await this._complete(
          task.id,
          { ...result, isSoldOut },
          result.listing.score,
          result.keywordTraffic.score
        )
        return
      }
      await setStage("OPTIMIZING")
      const optimizeRequest = computerOptimizePrompt(evidence, score, configurationReview)
      if (settings.outputFormatVersion === "2")
        optimizeRequest.user +=
          "\n紧凑输出 JSON，先写完整 Listing。字段理由只写一次，避免重复引文，策略使用短句。"
      const optimizeOutput = await this._recoverOutput(
        task,
        phases,
        "optimize",
        settings.model,
        optimizeRequest,
        text => finalizeComputerOptimization(text, evidence, score),
        assertLock,
        true,
        draft => readPartialComputerOptimization(draft, evidence, score)
      )
      const optimization = optimizeOutput.result!
      const gaps = [...scoreOutput.gaps, ...optimizeOutput.gaps]
      const snapshotIds = (
        await this.prisma.asinAuditCrawlSnapshot.findMany({
          where: { taskId: task.id },
          select: { snapshotId: true },
          orderBy: { id: "asc" },
        })
      ).map(row => row.snapshotId)
      const result = {
        ...buildComputerResult(
          evidence,
          score,
          optimization,
          consistency,
          configurationReview,
          snapshotIds,
          settings.model
        ),
        isSoldOut,
        ...(gaps.length ? { completionStatus: "PARTIAL", outputGaps: gaps } : {}),
      }
      await assertLock()
      await this._complete(task.id, result, result.listing.score, result.keywordTraffic.score)
    } catch (error) {
      await assertLock()
      const code = error instanceof ComputerAuditError ? error.code : "AUDIT_EXECUTION_FAILED"
      await this.prisma.asinAuditTask.update({
        where: { id: task.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: {
            code,
            stage,
            message:
              error instanceof ComputerAuditError
                ? error.message
                : "审计执行失败，已有阶段及响应保留，不自动重新调用",
          },
        },
        select: { id: true },
      })
      this.logger.warn(`电脑审计 ${task.taskId} ${code}`)
    } finally {
      if (mcp) await mcp.close().catch(() => {})
    }
  }

  private async _complete(
    taskId: number,
    result: unknown,
    listingScore: number | null,
    trafficScore: number | null
  ) {
    await this.prisma.$transaction([
      this.prisma.asinAuditTaskPayload.update({
        where: { taskId },
        data: { result: asJson(result) },
        select: { id: true },
      }),
      this.prisma.asinAuditTask.update({
        where: { id: taskId },
        data: {
          status: "COMPLETED",
          stage: "FINISHED",
          completedAt: new Date(),
          listingScore,
          trafficScore,
          error: Prisma.DbNull,
        },
        select: { id: true },
      }),
    ])
  }
}
