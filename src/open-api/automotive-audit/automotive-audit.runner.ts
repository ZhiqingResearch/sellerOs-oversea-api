import { savedUiLanguage, withOutputLanguage } from "../../common/i18n/ai-language"
import { withUiLanguage } from "../../common/i18n/request-language"
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Interval } from "@nestjs/schedule"
import type { AsinAuditTask, AsinAuditTaskPayload } from "@prisma/client"
import { Prisma } from "@prisma/client"
import axios, { AxiosResponse } from "axios"
import { createHash, randomUUID } from "node:crypto"
import { AiGatewayProvider } from "../../common/providers/ai-gateway.provider"
import { PrismaService } from "../../prisma/prisma.service"
import type {
  AuditConfig,
  AuditData,
  AuditImage,
  AuditImageState,
  AuditInput,
  AuditPhase,
  AuditPhaseState,
  AuditReview,
  PhaseMap,
} from "./automotive-audit.types"
import { asJson } from "./automotive-audit.types"

import {
  AutomotiveAuditLockService,
  MissingCrawlerReceipt,
} from "./automotive-audit-lock.service"
const CRAWLER_TIMEOUT_MS = 600_000
type PendingTask = AsinAuditTask & { payload: AsinAuditTaskPayload | null }

class AuditExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

@Injectable()
export class AutomotiveAuditRunner implements OnModuleDestroy {
  private readonly logger = new Logger(AutomotiveAuditRunner.name)
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
      const pending = await this.lock.findNextAudit(this.prisma, "AUTOMOTIVE")
      if (!pending) return
      await this.lock.runJob("audit", pending.id, async assertLock => {
        const task = await this.prisma.asinAuditTask.findFirst({
          where: { id: pending.id, auditType: "AUTOMOTIVE", status: { in: ["QUEUED", "RUNNING"] } },
          orderBy: { id: "asc" },
          include: { payload: true },
        })
        if (task) {
          const language = savedUiLanguage((task.payload?.config as { responseLanguage?: string } | null)?.responseLanguage)
          await withUiLanguage(language, () => this._run(task, assertLock))
        }
      })
    } catch (error) {
      const code =
        error instanceof Error && error.message === "AUDIT_LOCK_LOST"
          ? "AUDIT_LOCK_LOST"
          : error instanceof Prisma.PrismaClientKnownRequestError
            ? error.code
            : "AUDIT_SCHEDULER_FAILED"
      this.logger.error(`汽配审计调度异常 ${code}；持久化阶段保留，下次调度核对后恢复`)
    }
  }

  private async _run(task: PendingTask, assertLock: () => Promise<void>) {
    let stage = task.stage
    const phases = (task.payload?.phases ?? {}) as PhaseMap
    const setStage = async (next: string) => {
      await assertLock()
      stage = next
      await this.prisma.asinAuditTask.update({
        where: { id: task.id },
        data: { status: "RUNNING", stage },
      })
    }
    try {
      if (!task.payload) throw new AuditExecutionError("AUDIT_INPUT_MISSING", "审计入参快照缺失")
      const app = await this.prisma.openApiApp.findUnique({
        where: { appId: task.appId },
        select: { status: true, isAutomotiveAuditEnabled: true },
      })
      if (app?.status !== "ACTIVE" || !app.isAutomotiveAuditEnabled)
        throw new AuditExecutionError("AUTOMOTIVE_AUDIT_FORBIDDEN", "接入方已停用或审计权限已撤销")
      const kernel = await import("./kernel/index.mjs")
      const config = task.payload.config as unknown as AuditConfig
      if (config.ruleVersion !== kernel.RULE_VERSION)
        throw new AuditExecutionError(
          "AUDIT_VERSION_CHANGED",
          "任务规则版本已变化，保留原阶段结果，不自动重跑"
        )
      const snapshot = await this.lock.reuseOrRunCrawler(assertLock, async isCacheOnly => {
        if (!isCacheOnly) await setStage("CRAWLING")
        return this._crawl(task, config, assertLock, isCacheOnly)
      })
      let body: unknown
      try {
        body = JSON.parse(snapshot.rawResponse!)
      } catch {
        throw new AuditExecutionError(
          "CRAWLER_INVALID_RESPONSE",
          "爬虫响应不是有效JSON，原文已保存"
        )
      }
      let normalized: AuditInput
      try {
        normalized = kernel.createAuditInput(task.payload.input as AuditData, body, {
          ...snapshot,
          fetchedAt: snapshot.fetchedAt?.toISOString(),
        })
      } catch (error) {
        const code =
          error instanceof Error &&
          [
            "CRAWLER_INVALID_RESPONSE",
            "CRAWLER_ASIN_MISMATCH",
            "CRAWLER_PRODUCT_INCOMPLETE",
          ].includes(error.message)
            ? error.message
            : "CRAWLER_INVALID_RESPONSE"
        throw new AuditExecutionError(code, "爬虫商品结构或目标ASIN身份校验失败，原文已保存")
      }
      await this.prisma.asinAuditCrawlSnapshot.update({
        where: { id: snapshot.id },
        data: { productPointer: normalized.productPointer },
      })
      await this.prisma.asinAuditTaskPayload.update({
        where: { taskId: task.id },
        data: { normalizedInput: asJson(normalized) },
        select: { id: true },
      })
      await setStage("TEXT_REVIEW")
      const reviews: Partial<Record<AuditPhase, AuditReview>> = {}
      for (const phase of ["semantic", "rules"] as AuditPhase[])
        reviews[phase] = await this._review(
          task.id,
          normalized,
          phase,
          [],
          phases,
          config,
          assertLock
        )
      await setStage("IMAGE_REVIEW")
      const imageState = await this._images(task.id, normalized, phases, assertLock)
      const images = imageState.images
      if (
        images.some(image => image.imageId.startsWith("aplus:")) &&
        !imageState.failures.some(item => item.imageId.startsWith("aplus:"))
      )
        reviews.visual = await this._review(
          task.id,
          normalized,
          "visual",
          images,
          phases,
          config,
          assertLock
        )
      reviews.snapshot = await this._review(
        task.id,
        normalized,
        "snapshot",
        images,
        phases,
        config,
        assertLock
      )
      reviews.snapshot.originalMainImage = imageState.originalMainImage
      await setStage("SCORING")
      let detail: AuditData
      try {
        detail = kernel.calculateAudit(normalized, reviews, {
          registeredBrand: config.registeredBrand,
          unavailableImageIds: imageState.failures.map(item => item.imageId),
        })
      } catch (error) {
        if (error instanceof Error && error.message.includes("模块可评价满分为0"))
          throw new AuditExecutionError(
            "INSUFFICIENT_SCORING_EVIDENCE",
            "某模块没有可评价项目，无法计算60/40加权得分；已有证据已保存"
          )
        throw error
      }
      const result = kernel.toPublicResult(detail, snapshot.snapshotId)
      result.model = config.model
      result.ruleConfig = { registeredBrand: config.registeredBrand }
      result.imageAcquisitionGaps = imageState.failures
      await assertLock()
      await this.prisma.$transaction([
        this.prisma.asinAuditTaskPayload.update({
          where: { taskId: task.id },
          data: { auditDetail: asJson(detail), result: asJson(result) },
          select: { id: true },
        }),
        this.prisma.asinAuditTask.update({
          where: { id: task.id },
          data: {
            status: "COMPLETED",
            stage: "FINISHED",
            completedAt: new Date(),
            score: result.summary.score,
            grade: result.summary.grade,
            coverageRate: result.summary.coverageRate,
            error: Prisma.DbNull,
          },
        }),
      ])
    } catch (error) {
      await assertLock() // Never let an obsolete worker overwrite a newer outcome.
      const known = error instanceof AuditExecutionError
      const failure = {
        code: known ? error.code : "AUDIT_EXECUTION_FAILED",
        message: known ? error.message : "审计处理失败，已保存阶段数据，不自动重复调用",
        stage,
      }
      await this.prisma.asinAuditTask.update({
        where: { id: task.id },
        data: { status: "FAILED", completedAt: new Date(), error: failure },
      })
      this.logger.warn(`汽配审计 ${task.taskId} ${failure.code}`)
    }
  }

  private async _crawl(task: PendingTask, config: AuditConfig, assertLock: () => Promise<void>, isCacheOnly = false) {
    const existing = await this.prisma.asinAuditCrawlSnapshot.findFirst({
      where: { taskId: task.id, provider: "CRAWLER" },
      orderBy: { id: "desc" },
    })
    if (existing) {
      if (existing.state === "RECEIVED") {
        if (existing.httpStatus !== 200)
          throw new AuditExecutionError(
            "CRAWLER_HTTP_ERROR",
            `爬虫返回HTTP ${existing.httpStatus}，原文已保存`
          )
        return existing
      }
      throw new AuditExecutionError(
        "CRAWLER_OUTCOME_UNKNOWN",
        "上次爬虫请求未完整结束，禁止自动重复请求"
      )
    }
    if (isCacheOnly) throw new MissingCrawlerReceipt()
    await assertLock()
    const endpoint = `${config.crawlerBaseUrl.replace(/\/$/, "")}/variant`
    const body = { url: `https://www.amazon.com/dp/${task.asin}` }
    const snapshot = await this.prisma.asinAuditCrawlSnapshot.create({
      data: {
        snapshotId: `crawl_${randomUUID()}`,
        taskId: task.id,
        request: { method: "POST", url: endpoint, body },
      },
    })
    await assertLock()
    const startedAt = Date.now()
    let response: AxiosResponse<string>
    let rawResponse: string
    try {
      // Node fetch rejects port 6666 before sending. Match the existing crawler
      // provider's Node HTTP transport and retain non-JSON/5xx bodies verbatim.
      response = await axios.post<string>(endpoint, body, {
        maxRedirects: 0,
        timeout: CRAWLER_TIMEOUT_MS,
        signal: AbortSignal.timeout(CRAWLER_TIMEOUT_MS),
        responseType: "text",
        transformResponse: [(value: string) => value],
        validateStatus: () => true,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.get<string>("CRAWLER_API_TOKEN", "")}`,
        },
      })
      rawResponse = response.data
    } catch {
      await this.prisma.asinAuditCrawlSnapshot.update({
        where: { id: snapshot.id },
        data: {
          state: "UNKNOWN",
          durationMs: Date.now() - startedAt,
          error: { code: "CRAWLER_TRANSPORT_ERROR", message: "请求中断或超时，未自动重试" },
        },
      })
      throw new AuditExecutionError("CRAWLER_TRANSPORT_ERROR", "爬虫请求中断或超时，未自动重试")
    }
    await assertLock()
    const saved = await this.prisma.asinAuditCrawlSnapshot.update({
      where: { id: snapshot.id },
      data: {
        state: "RECEIVED",
        httpStatus: response.status,
        rawResponse,
        responseHash: createHash("sha256").update(rawResponse).digest("hex"),
        fetchedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    })
    if (response.status !== 200)
      throw new AuditExecutionError(
        "CRAWLER_HTTP_ERROR",
        `爬虫返回HTTP ${response.status}，完整响应已保存`
      )
    return saved
  }

  private async _savePhases(taskId: number, phases: PhaseMap) {
    await this.prisma.asinAuditTaskPayload.update({
      where: { taskId },
      data: { phases: asJson(phases) },
      select: { id: true },
    })
  }

  private async _images(
    taskId: number,
    task: AuditInput,
    phases: PhaseMap,
    assertLock: () => Promise<void>
  ) {
    if (phases.images?.state === "COMPLETED") return phases.images as AuditImageState
    const kernel = await import("./kernel/index.mjs")
    const imageState: AuditImageState = (phases.images as AuditImageState | undefined) ?? {
      state: "PREPARING",
      images: [],
      failures: [],
    }
    phases.images = imageState
    const download = async (url: string) => {
      const parsed = new URL(url)
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "m.media-amazon.com" ||
        parsed.username ||
        parsed.password ||
        parsed.port
      )
        throw new Error("INVALID_IMAGE_SOURCE")
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error("IMAGE_DOWNLOAD_FAILED")
      const mime = response.headers.get("content-type")?.split(";")[0]
      if (!mime || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime))
        throw new Error("IMAGE_FORMAT_INVALID")
      const bytes = Buffer.from(await response.arrayBuffer())
      return {
        url,
        mime,
        sha256: kernel.hashValue(bytes),
        byteLength: bytes.length,
        base64: bytes.toString("base64"),
        technical: await kernel.inspectImage(bytes),
      }
    }
    for (const entry of kernel.getImageEntries(task)) {
      if (
        imageState.images.some((image: AuditImage) => image.imageId === entry.imageId) ||
        imageState.failures.some(item => item.imageId === entry.imageId)
      )
        continue
      await assertLock()
      try {
        imageState.images.push({ ...entry, ...(await download(entry.url)) })
      } catch {
        imageState.failures.push({ ...entry, reason: "图片未能取得或解码，不据此认定商品图片违规" })
      }
      await this._savePhases(taskId, phases)
    }
    if (!imageState.originalMainImage) {
      const original = kernel.getOriginalImageUrl(task.product.imageUrl)
      await assertLock()
      try {
        if (!original) throw new Error("NO_SOURCE_IMAGE")
        const { base64, ...metadata } = await download(original)
        imageState.originalMainImage = {
          status: "success",
          derivedFrom: task.product.imageUrl,
          ...metadata,
          metrics: await kernel.measureImage(Buffer.from(base64, "base64")),
        }
      } catch {
        imageState.originalMainImage = {
          status: "unavailable",
          reason: "源图未能核验，不用展示图尺寸冒充上传源图尺寸",
        }
      }
    }
    imageState.state = "COMPLETED"
    await this._savePhases(taskId, phases)
    return imageState
  }

  private async _review(
    taskId: number,
    task: AuditInput,
    phase: AuditPhase,
    images: AuditImage[],
    phases: PhaseMap,
    config: AuditConfig,
    assertLock: () => Promise<void>
  ) {
    const kernel = await import("./kernel/index.mjs")
    const metadata = images.map(image => {
      const copy: Partial<AuditImage> = { ...image }
      delete copy.base64
      return copy as AuditData
    })
    const request = kernel.buildModelRequest(task, phase, metadata)
    const inputHash = kernel.hashValue({ request, config, images: metadata })
    for (const image of images) {
      if (kernel.hashValue(Buffer.from(image.base64, "base64")) !== image.sha256) {
        throw new AuditExecutionError("AUDIT_CACHE_MISMATCH", "图片缓存字节与哈希不一致，禁止使用")
      }
    }
    let cached: AuditPhaseState | undefined = phases[phase]
    const isCacheHit = Boolean(cached)
    if (cached && cached.inputHash !== inputHash)
      throw new AuditExecutionError(
        "AUDIT_CACHE_MISMATCH",
        "阶段缓存与当前证据或配置不一致，禁止复用"
      )
    if (cached?.state === "COMPLETED" && cached.result) return cached.result
    if (cached?.state === "SUBMITTING" || cached?.state === "UNKNOWN" || cached?.state === "FAILED")
      throw new AuditExecutionError(
        "MODEL_OUTCOME_UNKNOWN",
        "已有模型请求失败或结果不明确，不自动重复调用"
      )
    if (!cached) {
      if (
        this.config.get<string>(
          "AI_GATEWAY_BASE_URL",
          "https://ai-gateway-api-dev.zhilingtech.com/v1"
        ) !== config.gatewayBaseUrl
      )
        throw new AuditExecutionError(
          "AUDIT_CONFIG_CHANGED",
          "模型网关配置与任务快照不同，未调用模型"
        )
      await assertLock()
      cached = {
        state: "SUBMITTING",
        inputHash,
        request,
        model: config.model,
        startedAt: new Date().toISOString(),
        content: "",
        usage: null,
      }
      phases[phase] = cached
      await this._savePhases(taskId, phases)
      await assertLock()
      // Send the exact downloaded bytes whose hashes and pixel metrics were saved.
      const content = Array.isArray(request.content)
        ? request.content.map((part: AuditData) => {
            if (part.type !== "image_url") return part
            const image = images.find(item => item.url === (part.image_url as { url: string }).url)!
            return {
              type: "image_url",
              image_url: { url: `data:${image.mime};base64,${image.base64}` },
            }
          })
        : request.content
      try {
        for await (const event of this.gateway.streamChat(
          withOutputLanguage(request.prompt),
          typeof content === "string" ? content : "",
          {
            model: config.model,
            userContent: content,
            maxOutputTokens: request.maxOutputTokens,
            operationName: `汽配审计:${phase}`,
            resolveBilling: true,
            temperature: 0.2,
          }
        )) {
          if (event.type === "text") cached.content = (cached.content ?? "") + event.content
          if (event.type === "usage") cached.usage = event.rawUsage ?? event.usage
          if (event.type === "billing") cached.billing = event.billing
        }
        cached.state = "RECEIVED"
        await this._savePhases(taskId, phases) // Persist raw completion before validating it.
      } catch {
        // Billing lookup can fail after a complete answer. Keep a fully validated
        // answer usable; never buy another completion just to recover its invoice.
        let hasCompleteAnswer = false
        try {
          kernel.validateModelResponse(task, phase, cached.content ?? "", metadata)
          hasCompleteAnswer = true
        } catch {
          /* incomplete or invalid answer */
        }
        cached.state = hasCompleteAnswer ? "RECEIVED" : "UNKNOWN"
        cached.transportWarning = "流结束或账单查询异常；保留已接收内容和用量"
        await this._savePhases(taskId, phases)
        if (!hasCompleteAnswer)
          throw new AuditExecutionError(
            "MODEL_REQUEST_FAILED",
            `模型${phase}阶段失败，接收内容已保存，不自动重试`
          )
      }
    }
    try {
      const review = kernel.validateModelResponse(task, phase, cached.content ?? "", metadata)
      cached.result = {
        status: "success",
        model: config.model,
        inputHash,
        review,
        images: metadata,
        usage: cached.usage,
        isCacheHit,
        completedAt: new Date().toISOString(),
      }
      cached.state = "COMPLETED"
      await this._savePhases(taskId, phases)
      return cached.result
    } catch {
      cached.state = "FAILED"
      await this._savePhases(taskId, phases)
      throw new AuditExecutionError(
        "MODEL_RESPONSE_INVALID",
        `模型${phase}阶段返回结构或引用无效，原文已保存`
      )
    }
  }
}
