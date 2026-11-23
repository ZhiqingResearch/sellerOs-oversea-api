import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { randomUUID } from "node:crypto"
import { beforeQuotaCharge } from "../../common/errors/upstream-quota"
import { withOutputLanguage } from "../../common/i18n/ai-language"
import { uiText } from "../../common/i18n/request-language"
import { AiGatewayProvider } from "../../common/providers/ai-gateway.provider"
import { PrismaService } from "../../prisma/prisma.service"
import { FIXED_MODULE_CREDITS } from "../../usage/fixed-module-credits"
import { ListingModelSelectionGuard } from "../guards/listing-model-selection.guard"
import { DEFAULT_LISTING_AI_MODEL, type ListingAiModel } from "../listing-ai.models"
import { ListingDocumentService } from "../listing-document.service"
import { ListingGenerationService } from "../listing-generation.service"
import { ListingRunService } from "../listing-run.service"
import { AMAZON_CATEGORIES } from "./automotive.categories"
import {
  AutomotiveDataDto,
  type GenerateAutomotiveDto,
  type MatchCategoryDto,
  type PrepareAutomotiveDto,
} from "./automotive.dto"
import { automotiveGenerationPrompt, categoryPrompt, EXTRACTION_PROMPT } from "./automotive.prompts"
import {
  assertAutomotiveReady,
  finalizeAutomotive,
  mergeAutomotiveCandidates,
  normalizeAutomotiveData,
  productSource,
  productTitle,
  stableHash,
} from "./automotive.rules"
import {
  object,
  string,
  strings,
  type AutomotiveMarket,
  type AutomotiveSource,
  type JsonRecord,
} from "./automotive.types"

const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as Prisma.InputJsonValue
const safeMessage = (e: unknown) =>
  e instanceof Error ? e.message : uiText("汽配处理失败", "Automotive listing processing failed")

@Injectable()
export class AutomotiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: ListingRunService,
    private readonly documents: ListingDocumentService,
    private readonly gateway: AiGatewayProvider,
    private readonly generations: ListingGenerationService,
    private readonly models: ListingModelSelectionGuard
  ) {}

  private async record(userId: number, runId: string) {
    const record = await this.prisma.history.findFirst({
      where: { userId, listingRun: { runId } },
      include: { listingRun: true },
    })
    if (!record)
      throw new NotFoundException({
        code: "AUTOMOTIVE_RUN_NOT_FOUND",
        message: uiText("生成记录不存在", "Generation record not found"),
      })
    return record
  }

  /** 仅在短事务里认领/写快照，网络调用始终在事务外。 */
  private async stage(
    userId: number,
    runId: string,
    key: "categoryMatch" | "preparation",
    inputHash: string,
    value?: JsonRecord
  ) {
    return this.prisma.$transaction(
      async tx => {
        const rows = await tx.$queryRaw<
          { id: number }[]
        >`SELECT h.id FROM History h JOIN ListingRun r ON r.historyId=h.id WHERE r.runId=${runId} AND h.userId=${userId} FOR UPDATE`
        if (!rows.length)
          throw new NotFoundException(uiText("生成记录不存在", "Generation record not found"))
        const current = await tx.history.findUniqueOrThrow({ where: { id: rows[0].id } })
        const data = object(current.data),
          prior = object(data[key])
        if (prior.inputHash && prior.inputHash !== inputHash)
          throw new ConflictException({
            code: "AUTOMOTIVE_INPUT_CONFLICT",
            message: uiText(
              "本轮输入已改变，请使用新的runId",
              "The input has changed. Please use a new runId."
            ),
          })
        if (!value && prior.inputHash) return { snapshot: prior, claimed: false }
        const run = await tx.listingRun.findUniqueOrThrow({ where: { runId } })
        if (
          !value &&
          (await tx.listingGenerationTask.findFirst({ where: { listingRunId: run.id } }))
        )
          throw new ConflictException(
            uiText(
              "该工作流已提交生成，不能更改原始资料",
              "Generation has already been submitted. The original data is locked."
            )
          )
        const snapshot: JsonRecord = { ...prior, inputHash, ...(value || { status: "RUNNING" }) }
        const report = { ...data, [key]: snapshot }
        await tx.history.update({
          where: { id: current.id },
          data: { data: json(report), version: { increment: 1 } },
        })
        await tx.historyRevision.create({
          data: { historyId: current.id, version: current.version + 1, data: json(report) },
        })
        await tx.listingRun.update({
          where: { runId },
          data: {
            stage: key === "categoryMatch" ? "category_match" : "input_analysis",
            status: snapshot.status === "FAILED" ? "FAILED" : "ANALYZING",
            error: string(snapshot.error) || null,
          },
        })
        return { snapshot, claimed: !value }
      },
      { maxWait: 10_000, timeout: 60_000 }
    )
  }

  private async step(
    userId: number,
    runId: string,
    operation: string,
    model: string,
    system: string,
    prompt: string,
    valid: (x: JsonRecord) => boolean
  ) {
    if (Buffer.byteLength(prompt, "utf8") > 4 * 1024 * 1024)
      throw new BadRequestException(
        uiText(
          "产品资料超过4MB，请精简后重新提交",
          "Product information exceeds 4 MB. Shorten it and submit again."
        )
      )
    const run = await this.prisma.listingRun.findFirstOrThrow({
      where: { runId, history: { userId } },
    })
    const step = await this.prisma.listingAiStep.create({
      data: { listingRunId: run.id, operation, model },
    })
    try {
      const result = await beforeQuotaCharge(
        this.gateway.generateJson<JsonRecord>(withOutputLanguage(system), prompt, {
          model,
          temperature: 0,
          maxAttempts: 1,
          operationName: `Listing ${operation}`,
          isDataValid: valid,
        }),
        "operation"
      )
      const usage = {
        ...result.tokenUsage,
        totalTokens:
          result.tokenUsage.promptTokens +
          result.tokenUsage.completionTokens +
          result.tokenUsage.thinkingTokens,
      }
      await this.prisma.listingAiStep.update({
        where: { id: step.id },
        data: {
          status: "COMPLETED",
          outputText: JSON.stringify(result.data),
          requestId: result.requestId,
          model: result.model,
        },
      })
      return { ...result, usage }
    } catch (e) {
      await this.prisma.listingAiStep.update({
        where: { id: step.id },
        data: { status: "FAILED", error: safeMessage(e).slice(0, 1000) },
      })
      throw e
    }
  }

  async match(userId: number, dto: MatchCategoryDto) {
    if (![dto.keyword, dto.productTitle, dto.documentUrl].some(x => string(x)))
      throw new BadRequestException({
        code: "AUTOMOTIVE_INPUT_REQUIRED",
        message: uiText(
          "请输入完整描述、商品标题或文档URL",
          "Enter a full description, product title or document URL."
        ),
      })
    const runId = dto.runId || randomUUID(),
      model = dto.model || DEFAULT_LISTING_AI_MODEL
    await this.models.assertAllowed(userId, [model])
    const input = {
      keyword: string(dto.keyword),
      productTitle: string(dto.productTitle),
      documentUrl: string(dto.documentUrl),
      market: dto.market,
      model,
    }
    const hash = stableHash(input)
    await this.runs.create(userId, {
      runId,
      title: (
        input.keyword ||
        input.productTitle ||
        uiText("文档类目识别", "Document category identification")
      ).slice(0, 450),
    })
    const claim = await this.stage(userId, runId, "categoryMatch", hash)
    if (!claim.claimed) return this.matchView(runId, claim.snapshot)
    const sources: AutomotiveSource[] = []
    if (input.keyword)
      sources.push({
        sourceId: "text-1",
        type: "TEXT",
        status: "SUCCEEDED",
        name: uiText("用户输入", "User input"),
        content: input.keyword,
      })
    if (input.productTitle)
      sources.push({
        sourceId: "title-1",
        type: "PRODUCT_TITLE",
        status: "SUCCEEDED",
        name: uiText("商品标题", "Product title"),
        content: input.productTitle,
      })
    let cleanupKey: string | undefined
    const warnings: string[] = []
    try {
      if (input.documentUrl) {
        try {
          const doc = await this.documents.readAutomotive(userId, { url: input.documentUrl }, model)
          cleanupKey = doc.cleanupKey
          sources.push(doc.source)
        } catch (e) {
          if (e instanceof BadRequestException) throw e
          sources.push({
            sourceId: "document-1",
            type: "DOCUMENT",
            status: "FAILED",
            name: uiText("文档", "Document"),
            content: "",
            error: uiText(
              "文档读取失败，请检查文件地址或重新上传",
              "Could not read the document. Check its URL or upload it again."
            ),
          })
          warnings.push(
            uiText(
              "文档读取失败，本次仅使用其余有效资料",
              "The document could not be read. Classification uses the remaining sources."
            )
          )
        }
      }
      if (!sources.some(x => x.status === "SUCCEEDED" && x.content))
        throw new BadGatewayException({
          code: "AUTOMOTIVE_SOURCES_UNAVAILABLE",
          message: uiText(
            "没有可用于分类的资料",
            "No information is available for classification."
          ),
        })
      await this.stage(userId, runId, "categoryMatch", hash, {
        status: "RUNNING",
        market: dto.market,
        model,
        sources,
      })
      const result = await this.step(
        userId,
        runId,
        "category_match",
        model,
        categoryPrompt(dto.market),
        JSON.stringify(sources),
        x =>
          typeof x?.category === "string" &&
          ["AUTOMOTIVE", "GENERAL", "UNKNOWN"].includes(
            string(object(x.classification).decision)
          ) &&
          typeof object(x.classification).reason === "string"
      )
      const category =
        (AMAZON_CATEGORIES[dto.market] || []).find(
          c => c.toLowerCase() === string(result.data.category).toLowerCase()
        ) || ""
      if (!AMAZON_CATEGORIES[dto.market])
        warnings.push(
          uiText(
            "本站点尚无完整大类表，已返回专用汽配判断",
            "This marketplace lacks a full category table. Only the automotive classification is available."
          )
        )
      const snapshot = {
        status: "READY",
        market: dto.market,
        model,
        productTitle: input.productTitle,
        sources,
        category,
        classification: {
          ...object(result.data.classification),
          basis: "MODEL",
          requiresConfirmation: object(result.data.classification).decision !== "GENERAL",
        },
        warnings,
        tokenUsage: result.usage,
      }
      await this.stage(userId, runId, "categoryMatch", hash, snapshot)
      return this.matchView(runId, snapshot)
    } catch (e) {
      await this.stage(userId, runId, "categoryMatch", hash, {
        status: "FAILED",
        market: dto.market,
        model,
        sources,
        error: safeMessage(e),
      })
      throw e
    } finally {
      await this.documents.cleanupAutomotive(cleanupKey)
    }
  }

  private matchView(
    runId: string,
    snapshot: JsonRecord
  ): JsonRecord & { runId: string; matchStatus: unknown } {
    const { inputHash: _hash, status, ...view } = snapshot
    void _hash
    return { ...view, runId, matchStatus: status, pollUrl: `/api/listing/automotive/runs/${runId}` }
  }

  async prepare(userId: number, dto: PrepareAutomotiveDto) {
    const manual = dto.category?.source === "USER" && dto.category?.userSelectedAutomotive === true
    if (dto.category?.userSelectedAutomotive && !manual)
      throw new BadRequestException(
        uiText(
          "自动类目不能标记为用户手选",
          "An automatically selected category cannot be marked as selected by the user."
        )
      )
    if (manual)
      await this.runs.create(userId, {
        runId: dto.runId,
        title: (
          string(dto.text) ||
          productTitle(dto.productDetail) ||
          uiText("汽配资料", "Automotive product information")
        ).slice(0, 450),
      })
    const record = await this.record(userId, dto.runId),
      match = object(object(record.data).categoryMatch)
    if (!manual && match.status !== "READY")
      throw new BadRequestException({
        code: "AUTOMOTIVE_CATEGORY_MATCH_REQUIRED",
        message: uiText("请先完成类目识别", "Complete category identification first."),
      })
    if (
      match.status === "READY" &&
      ((dto.market && dto.market !== match.market) ||
        (dto.model && dto.model !== match.model) ||
        dto.text !== undefined ||
        dto.document)
    )
      throw new ConflictException(
        uiText(
          "请勿覆盖已分类的文字、文档、站点或模型，修改资料请重新分类",
          "The classified inputs have changed. Classify the new information again."
        )
      )
    const market = string(match.market) || dto.market,
      model = string(match.model) || dto.model || DEFAULT_LISTING_AI_MODEL
    if (!market)
      throw new BadRequestException(uiText("缺少目标站点", "Target marketplace is missing"))
    await this.models.assertAllowed(userId, [model])
    if (dto.discardProductSource && dto.productDetail)
      throw new BadRequestException(
        uiText(
          "放弃商品来源时不可同时传商品数据",
          "Omit product data when excluding the product source."
        )
      )
    if (match.productTitle && !dto.productDetail && !dto.discardProductSource)
      throw new BadRequestException({
        code: "AUTOMOTIVE_PRODUCT_DATA_REQUIRED",
        message: uiText(
          "请提交此前提取的完整商品数据",
          "Submit the complete product data extracted earlier."
        ),
      })
    if (
      dto.productDetail &&
      match.productTitle &&
      productTitle(dto.productDetail) !== match.productTitle
    )
      throw new ConflictException(
        uiText(
          "商品标题已经改变，请重新分类",
          "The product title has changed. Classify the product again."
        )
      )
    const sources: AutomotiveSource[] =
      match.status === "READY"
        ? (match.sources as AutomotiveSource[]).filter(s => s.type === "TEXT")
        : []
    if (manual && match.status !== "READY" && string(dto.text))
      sources.push({
        sourceId: "text-1",
        type: "TEXT",
        status: "SUCCEEDED",
        name: uiText("用户输入", "User input"),
        content: string(dto.text),
      })
    const product = productSource(dto.productDetail)
    if (product) sources.push(product)
    if (match.status === "READY")
      sources.push(...(match.sources as AutomotiveSource[]).filter(s => s.type === "DOCUMENT"))
    const classification = manual
      ? {
          decision: "AUTOMOTIVE",
          basis: "USER",
          categoryKey: "",
          reason: uiText(
            "用户选择汽车配件流程",
            "The user selected the automotive parts workflow."
          ),
          requiresConfirmation: false,
        }
      : match.classification
    const hash = stableHash({
      matchHash: match.inputHash || "",
      market,
      model,
      sources,
      category: dto.category,
      document: dto.document || null,
      discardProductSource: !!dto.discardProductSource,
    })
    const claimed = await this.stage(userId, dto.runId, "preparation", hash)
    if (!claimed.claimed) return this.preparationView(dto.runId, claimed.snapshot)
    let cleanupKey: string | undefined
    try {
      if (!match.inputHash && dto.document) {
        const doc = await this.documents.readAutomotive(userId, dto.document, model)
        sources.push(doc.source)
        cleanupKey = doc.cleanupKey
      }
      if (!sources.some(s => s.status === "SUCCEEDED" && s.content))
        throw new BadRequestException(
          uiText(
            "缺少可提取的文字、商品或文档资料",
            "No text, product or document information is available for extraction."
          )
        )
      await this.stage(userId, dto.runId, "preparation", hash, {
        status: "RUNNING",
        market,
        model,
        sources,
        classification,
      })
      const result = await this.step(
        userId,
        dto.runId,
        "input_analysis",
        model,
        EXTRACTION_PROMPT,
        JSON.stringify(sources),
        x =>
          Array.isArray(x?.candidates) &&
          (x.candidates as unknown[]).every(
            c =>
              sources.some(s => s.sourceId === object(c).sourceId) &&
              !!object(c).data &&
              typeof object(c).data === "object"
          )
      )
      const merged = mergeAutomotiveCandidates(result.data.candidates, sources)
      const snapshot = {
        status: "READY",
        market,
        model,
        sources,
        classification,
        ...merged,
        discardProductSource: !!dto.discardProductSource,
        warnings: [
          ...strings(result.data.warnings),
          ...sources.map(s => s.error || "").filter(Boolean),
        ],
        tokenUsage: result.usage,
      }
      await this.stage(userId, dto.runId, "preparation", hash, snapshot)
      return this.preparationView(dto.runId, snapshot)
    } catch (e) {
      await this.stage(userId, dto.runId, "preparation", hash, {
        status: "FAILED",
        sources,
        market,
        model,
        classification,
        error: safeMessage(e),
      })
      throw e
    } finally {
      await this.documents.cleanupAutomotive(cleanupKey)
    }
  }

  private preparationView(
    runId: string,
    snapshot: JsonRecord
  ): JsonRecord & { runId: string; preparationStatus: unknown } {
    const { inputHash: _hash, status, ...view } = snapshot
    void _hash
    return {
      ...view,
      runId,
      preparationStatus: status,
      pollUrl: `/api/listing/automotive/runs/${runId}`,
    }
  }

  async generate(userId: number, dto: GenerateAutomotiveDto) {
    if (!dto.automotiveData)
      throw new BadRequestException(
        uiText("缺少汽配确认资料", "Confirmed automotive data is missing.")
      )
    const validation = await validate(plainToInstance(AutomotiveDataDto, dto.automotiveData), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
    if (validation.length)
      throw new BadRequestException({
        code: "AUTOMOTIVE_FIELDS_REQUIRED",
        message: uiText(
          "汽配资料字段或格式不完整",
          "The automotive data is incomplete or incorrectly formatted."
        ),
        details: { fields: validation.map(v => v.property) },
      })
    const data = normalizeAutomotiveData(dto.automotiveData)
    assertAutomotiveReady(data)
    const record = await this.record(userId, dto.runId),
      prep = object(object(record.data).preparation)
    if (prep.status !== "READY")
      throw new BadRequestException({
        code: "AUTOMOTIVE_PREPARATION_NOT_READY",
        message: uiText("请先完成汽配资料提取", "Complete automotive data extraction first."),
      })
    const sensitiveWords = [...new Set(strings(dto.sensitiveWords))]
    const inputHash = stableHash({ data, sensitiveWords })
    const existing = await this.prisma.listingGenerationTask.findUnique({
      where: { attemptId: dto.attemptId },
    })
    if (existing) {
      if (existing.listingRunId !== record.listingRun!.id)
        throw new NotFoundException(uiText("生成任务不存在", "Generation task not found"))
      const context = object(object(existing.input).context)
      if (context.workflow !== "automotive" || context.confirmedInputHash !== inputHash)
        throw new ConflictException(
          uiText(
            "该attemptId已用于不同输入",
            "This attemptId is already associated with different input"
          )
        )
      return {
        runId: dto.runId,
        attemptId: dto.attemptId,
        status: existing.status,
        creditsOnSuccess: FIXED_MODULE_CREDITS["listing.generate"],
        pollUrl: `/api/listing/automotive/runs/${dto.runId}?attemptId=${dto.attemptId}`,
      }
    }
    await this.models.assertAllowed(userId, [prep.model])
    const market = prep.market as AutomotiveMarket
    const submitted = await this.generations.submit(
      userId,
      {
        runId: dto.runId,
        attemptId: dto.attemptId,
        planIndex: 0,
        generationBillingId: dto.attemptId,
        main: {
          operation: "generation",
          model: prep.model as ListingAiModel,
          systemPrompt: automotiveGenerationPrompt(market, data),
          userPrompt: `请根据确认资料生成一个完整汽配Listing JSON。本次临时敏感词尽量避用，不可修改真实品牌/OE：${JSON.stringify(sensitiveWords)}`,
          temperature: 0.2,
        },
        context: {
          workflow: "automotive",
          confirmedInputHash: inputHash,
          rulesVersion: "automotive-v1",
          automotiveData: data,
          sensitiveWords,
          params: { mode: "automotive", market, model: prep.model, keyword: data.product },
        },
      },
      undefined,
      "automotive"
    )
    return {
      ...submitted,
      status: "QUEUED",
      creditsOnSuccess: FIXED_MODULE_CREDITS["listing.generate"],
      pollUrl: `/api/listing/automotive/runs/${dto.runId}?attemptId=${dto.attemptId}`,
    }
  }

  async read(userId: number, runId: string, attemptId?: string) {
    const record = await this.record(userId, runId),
      data = object(record.data)
    const match = object(data.categoryMatch),
      prep = object(data.preparation)
    const task = await this.prisma.listingGenerationTask.findFirst({
      where: { listingRunId: record.listingRun!.id, ...(attemptId ? { attemptId } : {}) },
      orderBy: { id: "desc" },
    })
    if (attemptId && !task)
      throw new NotFoundException(uiText("生成任务不存在", "Generation task not found"))
    let generation: {
      attemptId: string
      status: string
      stage: string
      error: string | null
      creditsCharged: string
      result: ReturnType<typeof finalizeAutomotive> | null
      partialText: string | null
      scoreResult: JsonRecord | null
      score: number | null
      scoreError: string | null
      canRetryScore: boolean
    } | null = null
    if (task && object(object(task.input).context).workflow === "automotive") {
      const step = await this.prisma.listingAiStep.findUnique({ where: { id: task.mainStepId } })
      const log = step?.usageLogId
        ? await this.prisma.usageLog.findUnique({
            where: { id: step.usageLogId },
            select: { credits: true },
          })
        : null
      const taskInput = object(task.input)
      const result = (taskInput.result || null) as ReturnType<typeof finalizeAutomotive> | null
      const scoreResult = taskInput.scoreResult ? object(taskInput.scoreResult) : null
      generation = {
        attemptId: task.attemptId,
        status: task.status,
        stage:
          task.status === "READY"
            ? "result_validation"
            : ["SCORE_QUEUED", "SCORING", "SCORE_READY"].includes(task.status)
              ? "auto_score"
              : task.status.toLowerCase(),
        error: task.error,
        creditsCharged: log?.credits?.toString() || "0",
        result,
        partialText: ["PARTIAL", "FAILED"].includes(task.status) ? step?.outputText || null : null,
        scoreResult,
        score: typeof scoreResult?.total === "number" ? scoreResult.total : null,
        scoreError: string(taskInput.scoreError) || null,
        canRetryScore:
          task.status === "PARTIAL" &&
          !!taskInput.scoreError &&
          !!taskInput.autoScore &&
          !!result &&
          object(object(record.listingRun?.attempts)["0"]).attemptId === task.attemptId,
      }
    }
    return {
      runId,
      categoryMatch: match.inputHash ? this.matchView(runId, match) : null,
      preparationStatus: prep.status || null,
      preparation: prep.inputHash ? this.preparationView(runId, prep) : null,
      generation,
    }
  }
}
