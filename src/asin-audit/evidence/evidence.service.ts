import { isUpstreamQuotaError, quotaFailure } from "../../common/errors/upstream-quota"
import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { randomUUID } from "node:crypto"
import { hashJson } from "../../common/utils/canonical-json"
import { auditDataSource } from "../../audit/audit-data"
import { parseAmazonAuditTarget, type Country } from "../../audit/audit.marketplace"
import { AuditService } from "../../audit/audit.service"
import { localizeErrorMessage, uiLanguage, uiText } from "../../common/i18n/request-language"
import {
  ASIN_EVIDENCE_SOURCE,
  AsinAuditBilling,
  isAsinAuditFixedModel,
} from "../asin-audit.billing"
import { EvidenceRequestDto } from "../dto/evidence.dto"
import type { ReviewPainPointsDto } from "../dto/review-pain-points.dto"
import { ReviewAnalysisService } from "../review-analysis.service"
import { ReviewPainPointsService } from "../review-pain-points.service"
import { filterCompetitorCandidates } from "../rules/competitor-filter"
import { computeBsrTrendPrecompute } from "../rules/traffic-precompute"
import type {
  AuditDetailResponse,
  AuditEvidence,
  DeEvidenceResult,
  ListingEvidence,
  ProductParamsEvidence,
  ReviewEvidence,
} from "../types/audit.types"
import type { Market } from "../types/scout.types"
import { adaptAuditDetail, extractReviewComments } from "./adapt-audit-detail"
import { adaptAsinPerformanceE, adaptCompetitorC, adaptKeywordTrafficD } from "./adapters"
import { SellerSpriteMcpClient } from "./mcp.client"
import { SifApiError, SifClient } from "./sif.client"

import type { EvidenceGroup } from "../types/de.types"
import type {
  SifAsinKeywordsMonthlyData,
  SifAsinOpTrafficTrendData,
  SifKeywordOverviewRow,
} from "../types/sif.types"
import { adaptXiyouD, xiyouBsrSeries, xiyouKeywords } from "./xiyou-adapters"
import {
  XiyouApiError,
  XiyouClient,
  finiteNumber,
  type XiyouBsrTrend,
  type XiyouInfo,
  type XiyouKeyword,
  type XiyouMarketRow,
  type XiyouPriceTrend,
} from "./xiyou.client"

const ASIN_RE = /^[A-Z0-9]{10}$/

export type EvidenceCard = "A" | "P" | "B" | "C" | "D" | "E"

export type EvidenceSseEvent =
  | { type: "progress"; card: EvidenceCard; message: string }
  | { type: "warning"; message: string }
  | { type: "evidence"; card: EvidenceCard; data: unknown }
  | { type: "done"; result: AuditEvidence; checklist: EvidenceChecklist }
  | { type: "error"; message: string; code?: number }

/** 页面 8 项取证清单（对应前端 AuditEvidenceChecklist；逐项 status/source/missingReason） */
export interface EvidenceChecklistItem {
  status: "fetched" | "missing" | "skipped"
  source?: "crawler" | "apify" | "sif" | "xiyou" | "mcp" | "ai"
  missingReason?: string
  fetchedAt?: string
  /** 仅 reviews 项：痛点模型是否已产出 */
  hasPainPoints?: boolean
  /** 仅 module 模式 reviews 项：亮点是否已产出 */
  hasHighlights?: boolean
  /** 仅 reviews 项：评论统计与正文分别表示 */
  hasReviewText?: boolean
  reviewTextMissingReason?: string
  /** 仅 skipped 项：说明 */
  note?: string
}

export interface EvidenceChecklist {
  listing: EvidenceChecklistItem // 当前 Listing 内容：A.filled 且 title 非空
  qa: EvidenceChecklistItem // Q&A：A.qa 非空数组
  aplus: EvidenceChecklistItem // A+：模块或图片非空，或 hasAplus=true
  images: EvidenceChecklistItem // 主副图：A.productImages 非空数组
  params: EvidenceChecklistItem // 参数信息：P.filled
  reviews: EvidenceChecklistItem // 评论分析：B.filled（评分或评论数）
  traffic: EvidenceChecklistItem // 关键词与流量：D.filled
  ads: EvidenceChecklistItem // 广告数据：上传链路，本接口不包含
}

export function normalizeAsin(input: string): string {
  const trimmed = input.trim().toUpperCase()
  if (!ASIN_RE.test(trimmed)) {
    throw new BadRequestException(
      uiText("ASIN 格式无效（需 10 位字母数字）", "Invalid ASIN: expected 10 letters or digits")
    )
  }
  return trimmed
}

const COUNTRY_MARKET: Record<string, Market> = {
  US: "amazon_us",
  UK: "amazon_uk",
  DE: "amazon_de",
}

function trendDateRange(): { startDate: string; endDate: string } {
  const end = new Date()
  const start = new Date(end.getTime() - 30 * 86_400_000)
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  }
}

/**
 * ASIN 审计取证编排（合成版：一次返回六卡）。
 * - 爬虫路（A/P/B）：复用 AuditService（audit/detail 同源爬虫/Apify 兜底 + 分来源缓存）→ adaptAuditDetail；
 *   失败只 warning 降级为空卡，不中断。
 * - SIF 路（D→C→E）：等价迁移 fetch-de-evidence；我方关键词主请求失败 = 整体失败（流内 error）。
 * - B 卡 AI 痛点：评论非空时串行调 ReviewPainPointsService（含计费）补 richPainPoints；失败回退基础卡。
 * - estimatedPoints 仅估值落字段（SIF 口径），不用于扣费。
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name)

  constructor(
    private readonly sif: SifClient,
    private readonly mcp: SellerSpriteMcpClient,
    private readonly audit: AuditService,
    private readonly billing: AsinAuditBilling,
    private readonly painPoints: ReviewPainPointsService,
    private readonly reviewAnalysis: ReviewAnalysisService,
    @Optional() private readonly xiyou?: XiyouClient,
    @Optional() private readonly config?: ConfigService
  ) {}

  /** 开流前校验：解析 asin 与 country（400），返回归一值 */
  resolve(dto: EvidenceRequestDto): { asin: string; country: string; productUrl: string | null } {
    const rawAsin = dto.asin?.trim()
    const rawUrl = dto.productUrl?.trim()
    if (rawUrl) {
      const target = parseAmazonAuditTarget(rawUrl)
      if (!target)
        throw new BadRequestException(
          uiText(
            "请提供 US、UK 或 DE 站点的 Amazon 商品详情地址",
            "Please provide an Amazon product URL from the US, UK or DE marketplace"
          )
        )
      if (rawAsin && normalizeAsin(rawAsin) !== target.asin) {
        throw new BadRequestException(
          uiText("ASIN 与商品地址不一致", "The ASIN does not match the product URL")
        )
      }
      if (dto.country && dto.country !== String(target.country)) {
        throw new BadRequestException(
          uiText(
            "所选站点与商品地址不一致",
            "The selected marketplace does not match the product URL"
          )
        )
      }
      return { asin: target.asin, country: target.country, productUrl: rawUrl }
    }
    if (rawAsin)
      return { asin: normalizeAsin(rawAsin), country: dto.country ?? "US", productUrl: null }
    throw new BadRequestException(
      uiText("需提供 asin 或 productUrl", "Either asin or productUrl is required")
    )
  }

  async run(
    dto: EvidenceRequestDto,
    resolved: { asin: string; country: string; productUrl: string | null },
    userId: number,
    emit: (ev: EvidenceSseEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (dto.scene === "evidence-module") {
      dto = { ...dto, clientRequestId: dto.clientRequestId ?? randomUUID() }
    }
    const { asin, country, productUrl } = resolved
    const warnings: string[] = []

    // 固定积分预检（仅取证模块场景：scene=audit 审计链取证免费，成本含在打分 20 内；
    // 非固定价模型返回 false 保持按量口径，无需预检）
    if (dto.scene === "evidence-module") {
      await this.billing.assertFixedStageAffordable(userId, dto.model, "evidence")
    }

    // 两路并行：爬虫 A/P/B 与 SIF D/C/E（SIF 主请求失败会 reject → 整体 error）
    const product = this.collectAuditCards(dto, asin, country, productUrl, warnings, emit)
    const [abpc, de] = await Promise.all([
      product,
      this.collectDeCards(asin, country, warnings, emit, signal, product),
    ])
    if (signal?.aborted) return

    // B 卡评论分析按 scene 分流：evidence-module=双输出（亮点+痛点带 quote）；audit/缺省=现有差评痛点链路（原样）
    const B =
      dto.scene === "evidence-module"
        ? await this.enrichBWithAnalysis(dto, userId, warnings, emit, abpc)
        : await this.enrichBWithPainPoints(dto, userId, warnings, emit, abpc)

    const productSource = auditDataSource(abpc.raw?.data)
    const evidenceSource = productSource === "apify" ? ("apify" as const) : ("erp" as const)
    const hasReviewText = Boolean(abpc.raw && extractReviewComments(abpc.raw).commentList.length)
    const reviewTextMissingReason = hasReviewText
      ? undefined
      : productSource === "apify"
        ? uiText(
            "备用数据源未获取评论正文，暂无法生成评论亮点与痛点",
            "The fallback data source did not provide review text. Review highlights and pain points cannot be generated yet."
          )
        : uiText(
            "商品详情未获取评论正文，暂无法生成评论亮点与痛点",
            "Product details did not include review text. Review highlights and pain points cannot be generated yet."
          )
    if (reviewTextMissingReason && abpc.raw) {
      warnings.push(reviewTextMissingReason)
      emit({ type: "warning", message: reviewTextMissingReason })
    }
    const productChecklistItem = (fetched: boolean, missingReason?: string) =>
      this.checklistItem(fetched, productSource, missingReason, abpc.raw?.fetchedAt)

    const result: AuditEvidence = {
      asin,
      country,
      market: COUNTRY_MARKET[country] ?? "amazon_us",
      A: abpc.A,
      P: abpc.P,
      B,
      C: de.C,
      D: de.D,
      E: de.E,
      meta: {
        primarySource: de.meta.primarySource,
        ...(dto.scene === "evidence-module" ? { generationRequestId: dto.clientRequestId } : {}),
        sources: {
          ...(abpc.A.filled ? { A: [evidenceSource] } : {}),
          ...(abpc.P.filled ? { P: [evidenceSource] } : {}),
          ...(B.filled ? { B: [evidenceSource] } : {}),
          ...(de.C.filled ? { C: de.meta.sources.C } : {}),
          D: de.meta.sources.D,
          E: de.meta.sources.E,
        },
        sifDataReady: de.meta.sifDataReady,
        sifWarnings: warnings,
        fetchedAt: new Date().toISOString(),
        estimatedPoints: de.meta.estimatedPoints,
      },
    }
    const checklist: EvidenceChecklist = {
      listing: productChecklistItem(
        Boolean(abpc.A.filled && abpc.A.title),
        uiText("商品详情未返回标题", "Product title was not returned")
      ),
      qa: productChecklistItem(
        (abpc.A.qa?.length ?? 0) > 0,
        uiText("商品详情未返回 Q&A", "Product Q&A was not returned")
      ),
      aplus: productChecklistItem(
        (abpc.A.aplusModules?.length ?? 0) > 0 ||
          (abpc.A.aplusImages?.length ?? 0) > 0 ||
          abpc.A.hasAplus === true,
        uiText("商品详情未返回 A+ 内容", "A+ content was not returned")
      ),
      images: productChecklistItem(
        (abpc.A.productImages?.length ?? 0) > 0,
        uiText("商品详情未返回主副图", "Product images were not returned")
      ),
      params: productChecklistItem(
        abpc.P.filled,
        abpc.P.missingReason ??
          uiText("商品详情未返回参数", "Product specifications were not returned")
      ),
      reviews: {
        ...productChecklistItem(
          B.filled,
          B.missingReason ??
            uiText("商品详情未返回评分或评论数", "Product rating or review count was not returned")
        ),
        hasReviewText,
        ...(reviewTextMissingReason ? { reviewTextMissingReason } : {}),
        hasPainPoints: (B.richPainPoints?.length ?? 0) > 0,
        ...(dto.scene === "evidence-module"
          ? { hasHighlights: (B.highlights?.length ?? 0) > 0 }
          : {}),
      },
      traffic: this.checklistItem(de.D.filled, de.D.group?.source ?? "sif", "本期未返回流量词"),
      ads: {
        status: "skipped",
        note: uiText(
          "广告报表为用户上传链路（/api/ad-cleaning/tasks），本接口不包含",
          "Advertising reports must be uploaded via /api/ad-cleaning/tasks and are not included in this endpoint"
        ),
      },
    }
    this.logger.log(
      `[asin-audit] evidence done userId=${userId} asin=${asin} cards=A:${abpc.A.filled},P:${abpc.P.filled},B:${B.filled},C:${de.C.filled},D:${de.D.filled},E:${de.E.filled} warnings=${warnings.length}`
    )
    // 固定积分扣费（成功后扣）：仅取证模块场景收 5；scene=audit 审计链取证不扣
    // （成本含在后续打分 20 内）。非固定价模型 chargeFixedStage 返回 false 不扣，
    // 内嵌 B 卡 AI 调用按量计费维持原口径。source 用取证专用子来源（label「ASIN 取证」）
    if (dto.scene === "evidence-module") {
      await this.billing.chargeFixedStage(
        userId,
        dto.model,
        "evidence",
        {
          scene: dto.scene,
          resultHash: hashJson(JSON.parse(JSON.stringify(result)) as unknown),
          ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
        },
        ASIN_EVIDENCE_SOURCE
      )
    }
    emit({ type: "done", result, checklist })
  }

  /** 清单单项：fetched 带来源与时间；missing 带原因 */
  private checklistItem(
    fetched: boolean,
    source: EvidenceChecklistItem["source"],
    missingReason?: string,
    fetchedAt = new Date().toISOString()
  ): EvidenceChecklistItem {
    return fetched
      ? { status: "fetched", source, fetchedAt }
      : { status: "missing", source, missingReason }
  }

  /** 爬虫路：audit/detail 同源数据 → adapt A/P/B；失败降级空卡（不中断） */
  private async collectAuditCards(
    dto: EvidenceRequestDto,
    asin: string,
    country: string,
    productUrl: string | null,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void
  ): Promise<{
    A: ListingEvidence
    P: ProductParamsEvidence
    B: ReviewEvidence
    raw: AuditDetailResponse | null
  }> {
    emit({
      type: "progress",
      card: "A",
      message: uiText(
        "正在抓取商品详情（标题/五点/参数/评论）…",
        "Fetching product details (title, bullets, specifications and reviews)…"
      ),
    })
    const empty = {
      A: { filled: false } as ListingEvidence,
      P: {
        filled: false,
        missingReason: uiText("商品详情抓取失败", "Could not fetch product details"),
      } as ProductParamsEvidence,
      B: {
        filled: false,
        missingReason: uiText("商品详情抓取失败", "Could not fetch product details"),
      } as ReviewEvidence,
      raw: null,
    }
    try {
      const row = await this.audit.findDetail({
        ...(productUrl ? { url: productUrl } : {}),
        ...(productUrl ? {} : { asin }),
        country: country as Country,
      })
      const resp: AuditDetailResponse = {
        id: row.id,
        url: row.url,
        platform: row.platform,
        country: row.country,
        asin: row.asin,
        name: row.name,
        data: row.data as Record<string, unknown> | null,
        fetchedAt: row.fetchedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }
      if (auditDataSource(resp.data) === "apify") {
        const message = uiText(
          "本次使用备用数据源，部分内容可能未获取。",
          "A fallback data source was used. Some content may be unavailable."
        )
        warnings.push(message)
        emit({ type: "warning", message })
      }
      const adapted = adaptAuditDetail(resp)
      emit({ type: "evidence", card: "A", data: adapted.A })
      emit({ type: "evidence", card: "P", data: adapted.P })
      emit({ type: "evidence", card: "B", data: adapted.B })
      return { A: adapted.A, P: adapted.P, B: adapted.B, raw: resp }
    } catch {
      const msg = uiText(
        "商品详情暂时无法获取，请稍后重试",
        "Product details are temporarily unavailable. Please try again later."
      )
      warnings.push(uiText(`ABPC 取证：${msg}`, `Product evidence: ${localizeErrorMessage(msg)}`))
      emit({
        type: "warning",
        message: uiText(`ABPC 取证：${msg}`, `Product evidence: ${localizeErrorMessage(msg)}`),
      })
      return empty
    }
  }

  /** SIF 路：等价迁移 fetch-de-evidence（D→C→E）；我方关键词主请求失败直接抛 → 整体 error */
  private async collectDeCards(
    asin: string,
    country: string,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void,
    signal?: AbortSignal,
    product?: Promise<{ A: ListingEvidence; P: ProductParamsEvidence }>
  ): Promise<DeEvidenceResult> {
    type Source = "sif" | "xiyou"
    const primarySource: Source =
      this.config?.get<string>("ASIN_EVIDENCE_PRIMARY_SOURCE") === "xiyou" ? "xiyou" : "sif"
    const order: Source[] = primarySource === "xiyou" ? ["xiyou", "sif"] : ["sif", "xiyou"]
    let accountError: SifApiError | undefined
    let sifDataReady: boolean | null = null
    let readiness: Promise<void> | undefined
    let endDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    let startDate = new Date(Date.parse(endDate) - 29 * 86_400_000).toISOString().slice(0, 10)
    let requestedPeriod = { startDate, endDate }
    const active = () => {
      if (signal?.aborted) throw new Error(uiText("取证连接已关闭", "Evidence connection closed"))
    }
    const note = (message: string) => {
      warnings.push(message)
      emit({ type: "warning", message })
    }
    const eligible = (error: unknown) =>
      (error instanceof SifApiError || error instanceof XiyouApiError) &&
      ["auth", "quota", "rate_limit", "transport", "response", "service"].includes(error.kind)
    const kind = (error: unknown) =>
      error instanceof SifApiError || error instanceof XiyouApiError ? error.kind : "unknown"
    const remember = (error: unknown) => {
      if (error instanceof SifApiError && ["auth", "quota"].includes(error.kind))
        accountError = error
    }
    const sifCall = async <T>(fn: () => Promise<T>): Promise<T> => {
      active()
      if (accountError) {
        if (this.sif.cachedOnly) return this.sif.cachedOnly(accountError, fn)
        throw accountError
      }
      try {
        return await fn()
      } catch (error) {
        remember(error)
        throw error
      }
    }
    const ensureSifReady = () =>
      (readiness ??= (async () => {
        try {
          const ready = await sifCall(() => this.sif.getLastDataTime(country, "last_30d"))
          sifDataReady = this.checkDataReady(ready?.list ?? [], ["asinKeywordSummary", "last_30d"])
          const module = ready?.list?.find(m => m.moduleCode === "asinKeywordSummary") as
            | { endTime?: string }
            | undefined
          if (
            primarySource === "sif" &&
            module?.endTime &&
            /^\d{4}-\d{2}-\d{2}/.test(module.endTime)
          ) {
            endDate = module.endTime.slice(0, 10)
            startDate = new Date(Date.parse(endDate) - 29 * 86_400_000).toISOString().slice(0, 10)
            requestedPeriod = { startDate, endDate }
          }
          for (const warning of this.dataReadyWarnings(ready?.list ?? [], [
            "asinKeywordSummary",
            "last_30d",
          ]))
            note(warning)
        } catch (error) {
          active()
          remember(error)
          note(uiText("SIF就绪检查暂不可用，继续获取实际数据", "SIF readiness check unavailable. Continuing with data retrieval."))
        }
      })())
    const sifRequest = async <T>(fn: () => Promise<T>) => {
      await ensureSifReady()
      return sifCall(fn)
    }
    const xy = () => {
      active()
      if (!this.xiyou) throw new XiyouApiError("auth")
      return this.xiyou
    }
    let infoPromise: Promise<XiyouInfo | undefined> | undefined
    const info = () =>
      (infoPromise ??= xy()
        .info(country, asin)
        .then(data => data.entities.find(row => row.asin === asin)))
    const marketRows = new Map<string, XiyouMarketRow | undefined>()
    const failedWords = new Map<string, unknown>()
    const marketInfo = async (keys: string[]) => {
      const normalized = [...new Set(keys.map(key => key.trim().toLowerCase()))]
      const missing = normalized.filter(key => !marketRows.has(key) && !failedWords.has(key))
      if (missing.length) {
        try {
          const result = await xy().market(country, missing)
          const rows = new Map(result.list.map(row => [row.searchTerm.trim().toLowerCase(), row]))
          for (const key of missing) marketRows.set(key, rows.get(key))
        } catch (error) {
          missing.forEach(key => failedWords.set(key, error))
          throw error
        }
      }
      const failed = normalized.find(key => failedWords.has(key))
      if (failed) throw failedWords.get(failed)
      return normalized.flatMap(key => (marketRows.get(key) ? [marketRows.get(key)!] : []))
    }
    const metadata = (
      source: Source,
      status: EvidenceGroup["status"],
      error?: unknown,
      attempted = error !== undefined && eligible(error)
    ): EvidenceGroup => ({
      source,
      primarySource,
      status,
      contract: source === "sif" ? "sif" : "xiyou-v1",
      fetchedAt: new Date().toISOString(),
      fallbackAttempted: attempted,
      primaryResult: error === undefined ? "success" : kind(error),
      ...(error !== undefined
        ? {
            fallbackReason: attempted
              ? uiText("主数据源暂不可用，已尝试备用数据源", "The primary source was unavailable. The fallback was attempted.")
              : uiText("该数据请求未完成，未启动备用数据源", "The request was incomplete. No fallback was started."),
          }
        : {}),
    })
    const group = async <T>(
      sif: () => Promise<T>,
      xiyou: () => Promise<T>,
      empty: T
    ): Promise<{ value: T; meta: EvidenceGroup }> => {
      const call = (source: Source) => {
        active()
        return source === "sif" ? sifRequest(sif) : xiyou()
      }
      try {
        return { value: await call(order[0]), meta: metadata(order[0], "success") }
      } catch (error) {
        active()
        if (!eligible(error)) {
          note(uiText("部分数据暂不可用", "Some data is unavailable"))
          return { value: empty, meta: metadata(order[0], "unavailable", error, false) }
        }
        try {
          const value = await call(order[1])
          note(uiText("主数据源暂不可用，已使用备用数据源", "The primary source was unavailable. The fallback was used."))
          return {
            value,
            meta: { ...metadata(order[1], "success", error), fallbackResult: "success" },
          }
        } catch (fallbackError) {
          active()
          note(uiText("主备数据源暂不可用，部分证据缺失", "Both sources are unavailable. Some evidence is missing."))
          return {
            value: empty,
            meta: {
              ...metadata(order[0], "unavailable", error),
              fallbackResult: kind(fallbackError),
            },
          }
        }
      }
    }
    type KeywordResult = {
      card: DeEvidenceResult["D"]
      raw?: SifAsinKeywordsMonthlyData
      overview?: SifKeywordOverviewRow[]
      rows?: XiyouKeyword[]
      market?: XiyouMarketRow[]
      meta: EvidenceGroup
      error?: unknown
    }
    const partialSif = (raw: SifAsinKeywordsMonthlyData) => {
      const card = adaptKeywordTrafficD(raw, [])
      for (const row of [...card.kwTop, ...card.kwDetail]) {
        row.searchVol = uiText("未知", "Unknown")
        row.heat = uiText("补量缺失", "Search volume unavailable")
      }
      if (card.kwStats) card.kwStats.opportunity = null
      if (card.trafficPrecompute) {
        card.trafficPrecompute.pendingRules = ["G1", "G3", "J2"]
        card.trafficPrecompute.homepageHitTier = null
        card.trafficPrecompute.opportunityCount = null
        card.trafficPrecompute.summaryLines = [
          uiText("已保留SIF词池与排名；补量缺失，相关评分待核，不适用原搜索量分档。", "SIF keywords and ranks were retained. Search-volume tiers and related scores are pending."),
        ]
        delete card.trafficPrecompute.tierBuckets
        delete card.trafficPrecompute.opportunityList
        delete card.trafficPrecompute.positionAllocation
        delete card.trafficPrecompute.concentration
      }
      return card
    }
    const keywordGroup = async (
      asins: string[],
      limit: number,
      competitor: boolean,
      ownOverview: SifKeywordOverviewRow[] = []
    ): Promise<KeywordResult> => {
      const attemptSif = async (): Promise<KeywordResult> => {
        let raw: SifAsinKeywordsMonthlyData | undefined
        try {
          raw = await sifRequest(() =>
            this.sif.asinKeywordsMonthly(country, asins, { last30d: true })
          )
          const keywords = (raw?.list ?? []).map(row => row.keyword)
          const originalTopKws = new Set(keywords.slice(0, competitor ? 20 : 10))
          // 竞品仅补原前 20 条中最终输出的词，保留其余词原有的搜索量回落。
          const keys = competitor
            ? [...new Set(keywords)].slice(0, 10).filter(keyword => originalTopKws.has(keyword))
            : [...originalTopKws]
          const available = new Map(ownOverview.map(row => [row.keyword, row]))
          const missing = keys.filter(keyword => available.get(keyword)?.estSearchesNum == null)
          const overview = [
            ...keys
              .filter(keyword => !missing.includes(keyword))
              .map(keyword => available.get(keyword)!),
            ...(missing.length
              ? await sifRequest(() => this.sif.batchKeywordOverview(country, missing))
              : []),
          ]
          return {
            card: adaptKeywordTrafficD(raw ?? { list: [] }, overview ?? []),
            raw,
            overview: overview ?? [],
            meta: metadata("sif", "success"),
          }
        } catch (error) {
          return {
            card: raw ? partialSif(raw) : adaptKeywordTrafficD({ list: [] }, []),
            raw,
            overview: [],
            meta: metadata("sif", raw ? "partial" : "unavailable"),
            error,
          }
        }
      }
      const attemptXiyou = async (): Promise<KeywordResult> => {
        let rows: XiyouKeyword[] = []
        const missingAsins: string[] = []
        let providerTotal = 0
        const providerCounts = new Map<
          string,
          { asin: string; fetchedCount: number; providerTotal?: number }
        >()
        let truncated = false
        let error: unknown
        let obtained = false
        const period = { startDate, endDate }
        try {
          const results = await Promise.all(
            asins.map(async target => {
              try {
                const result = await xy().keywords(
                  country,
                  target,
                  period.startDate,
                  period.endDate
                )
                obtained = true
                providerTotal += result.total ?? result.list.length
                providerCounts.set(target, {
                  asin: target,
                  fetchedCount: result.list.length,
                  providerTotal: result.total,
                })
                if (
                  result.list.length >= 10000 ||
                  (result.total !== undefined && result.total > result.list.length)
                )
                  truncated = true
                return result.list.map(row => ({ ...row, contributingAsins: [target] }))
              } catch (failure) {
                missingAsins.push(target)
                if (!error || !eligible(failure)) error = failure
                return []
              }
            })
          )
          rows = xiyouKeywords(results.flat())
          let market: XiyouMarketRow[] = []
          if (obtained && rows.length) {
            try {
              market = await marketInfo(rows.slice(0, limit).map(k => k.searchTerm))
            } catch (failure) {
              if (!error || !eligible(failure)) error = failure
            }
          }
          return {
            card: adaptXiyouD(asin, rows, market),
            rows,
            market,
            error,
            meta: {
              ...metadata("xiyou", !obtained ? "unavailable" : error ? "partial" : "success"),
              requestedPeriod: period,
              period: { completeness: "unknown" },
              fetchedCount: rows.length,
              providerTotal,
              providerCounts: asins.flatMap(asin =>
                providerCounts.has(asin) ? [providerCounts.get(asin)!] : []
              ),
              coverage: truncated ? "truncated" : "unknown",
              missingAsins,
            },
          }
        } catch (failure) {
          active()
          return {
            card: adaptXiyouD(asin, rows, []),
            rows,
            error: failure,
            meta: metadata("xiyou", obtained ? "partial" : "unavailable"),
          }
        }
      }
      const first = await (primarySource === "sif" ? attemptSif() : attemptXiyou())
      active()
      if (!first.error) return first
      if (!eligible(first.error)) {
        if (!competitor && first.meta.status === "unavailable") throw first.error
        first.meta = {
          ...first.meta,
          ...metadata(primarySource, first.meta.status, first.error, false),
        }
        return first
      }
      const second = await (primarySource === "sif" ? attemptXiyou() : attemptSif())
      active()
      const selected =
        second.meta.status === "success" ? second : first.meta.status === "partial" ? first : second
      selected.meta = {
        ...selected.meta,
        ...metadata(selected.meta.source, selected.meta.status, first.error),
        fallbackResult: second.error ? "unavailable" : "success",
      }
      if (selected.meta.status === "unavailable" && !competitor)
        throw (isUpstreamQuotaError(first.error) || isUpstreamQuotaError(second.error))
          ? quotaFailure(isUpstreamQuotaError(first.error) ? first.error : second.error, "not_charged")
          : new Error(uiText("主备数据源均无法取得关键词，请稍后重试", "Neither source could retrieve keywords. Please try again later."))
      if (selected.meta.status === "partial")
        note(uiText("主备补量暂不可用，已保留可用词池与排名，相关评分待核", "Available keywords and ranks were retained. Related scores are pending."))
      else note(uiText("主数据源暂不可用，已使用备用数据源；周期完整性未知", "Fallback data was used. Period completeness is unknown."))
      return selected
    }
    emit({ type: "progress", card: "D", message: uiText("正在反查近 30 天核心流量词…", "Looking up traffic keywords for the past 30 days…") })
    const d = await keywordGroup([asin], 50, false)
    const D = d.card
    D.group = { ...d.meta, ...(d.meta.source === "sif" ? { period: d.card.period } : {}) }
    emit({ type: "evidence", card: "D", data: D })
    let C: DeEvidenceResult["C"] = { filled: false, missingReason: uiText("未找到竞品 ASIN", "No competitor ASIN found") }
    let targetInfo: XiyouInfo | undefined
    let targetReference: EvidenceGroup | undefined
    try {
      active()
      const { items } = await this.mcp.callAsinCompetitor(asin, country, 10)
      const candidates = items
        .map(it => ({
          asin: typeof it.asin === "string" ? it.asin.trim() : "",
          title: typeof it.title === "string" ? it.title : undefined,
          brand: typeof it.brand === "string" ? it.brand : undefined,
          nodeLabelPath: typeof it.nodeLabelPath === "string" ? it.nodeLabelPath : undefined,
        }))
        .filter(c => c.asin)
      if (candidates.length) {
        const cards = await product
        let targetRef: { title?: string; brand?: string } = {
          title: cards?.A.title,
          brand: cards?.A.brand,
        }
        if (!targetRef.title) {
          const ref = await group(
            async () => {
              const data = await this.sif.batchAsinDetail(country, [asin])
              return data?.list?.find(row => row.asin === asin) as
                | { title?: string; brand?: string }
                | undefined
            },
            async () => {
              targetInfo = await info()
              return targetInfo
            },
            undefined
          )
          targetReference = ref.meta
          targetRef = ref.value ?? {}
        }
        const { kept, dropped } = filterCompetitorCandidates(candidates, targetRef, 3)
        for (const row of dropped) note(uiText(`竞品 ${row.asin} 已过滤：${row.reason}`, `Competitor ${row.asin} excluded: ${localizeErrorMessage(row.reason)}`))
        const asins = kept.map(row => row.asin)
        if (!asins.length) C = { filled: false, missingReason: uiText("竞品经配件/周边过滤后无匹配", "No competitor matched after excluding accessories") }
        if (asins.length) {
          const c = await keywordGroup(
            asins,
            20,
            true,
            d.meta.source === "sif" && d.meta.status === "success" ? d.overview : undefined
          )
          C =
            c.meta.source === "sif"
              ? adaptCompetitorC(
                  asins,
                  c.raw ?? { list: [] },
                  c.overview ?? [],
                  D.kwTop[0]?.kw ?? ""
                )
              : {
                  filled: c.card.filled,
                  competitorAsins: asins,
                  sharedKeywords: c.card.kwTop
                    .filter(row =>
                      D.kwDetail.some(own => own.kw.toLowerCase() === row.kw.toLowerCase())
                    )
                    .map(row => row.kw),
                  keywords: c.card.kwTop.map(row => ({
                    kw: row.kw,
                    tier: uiText("未知", "Unknown"),
                    searches: row.searchVol,
                  })),
                }
          C.group = c.meta
          if (c.meta.status === "partial" && c.meta.source === "sif")
            for (const row of C.keywords ?? []) {
              row.tier = uiText("未知", "Unknown")
              row.searches = uiText("未知", "Unknown")
            }
          C.sharedKeywordScope = uiText("D展示候选词与C流量Top10交集，非全池共有词", "Overlap between displayed D candidates and the top 10 C keywords")
          if (c.meta.status === "unavailable")
            C = { ...C, filled: false, missingReason: uiText("竞品关键词暂不可用", "Competitor keywords are unavailable") }
        }
      }
    } catch {
      active()
      note(uiText("竞品查询失败，已保留其他证据", "Competitor lookup failed. Other evidence was retained."))
      C = { filled: false, missingReason: uiText("竞品数据暂不可用", "Competitor data is unavailable") }
    }
    if (targetReference) C.targetReference = targetReference
    emit({ type: "evidence", card: "C", data: C })
    const sifRange = trendDateRange()
    const sales = await group(
      () => this.sif.variantLastSales(country, asin),
      async () => {
        const data = await xy().orders(country, asin)
        return data.entities.map(row => ({ asin: row.asin, orders: finiteNumber(row.orders) }))
      },
      []
    )
    const price = await group(
      () => this.sif.batchAsinPrice(country, [asin]),
      async () => {
        targetInfo = await info()
        return {
          list: targetInfo
            ? [
                {
                  asin,
                  currentPrice: finiteNumber(targetInfo.price) ?? undefined,
                  listedDate: targetInfo.streetDate || undefined,
                },
              ]
            : [],
        }
      },
      { list: [] }
    )
    let xyPrice: XiyouPriceTrend | undefined
    let xyBsr: XiyouBsrTrend | undefined
    let sifTrendPromise: Promise<SifAsinOpTrafficTrendData> | undefined
    const sifTrend = () =>
      (sifTrendPromise ??= this.sif.asinOpTrafficTrend(
        country,
        asin,
        sifRange.startDate,
        sifRange.endDate
      ))
    const priceTrend = await group(
      sifTrend,
      async () => {
        xyPrice = await xy().prices(country, asin, startDate, endDate)
        return {}
      },
      {}
    )
    const trend = await group(
      sifTrend,
      async () => {
        xyBsr = await xy().bsr(country, asin, startDate, endDate)
        if (!targetInfo) {
          try {
            targetInfo = await info()
          } catch {
            /* no reliable category means pending */
          }
        }
        return xiyouBsrSeries(xyBsr, targetInfo, startDate, endDate)
      },
      {}
    )
    const E = adaptAsinPerformanceE(
      asin,
      sales.meta.source === "sif" ? sales.value : [],
      price.value,
      priceTrend.value
    )
    const bsrSnapshot = adaptAsinPerformanceE(asin, [], { list: [] }, trend.value)
    E.priceBsr.bsr = bsrSnapshot.priceBsr.bsr
    E.priceBsr.bsrTrend = bsrSnapshot.priceBsr.bsrTrend
    const current = price.value.list.find(row => row.asin === asin)
    E.priceBsr.currentPrice = finiteNumber(current?.currentPrice)
    E.priceBsr.currentPriceType = "product"
    E.priceBsr.currentPriceDate =
      current && "lastUpdate" in current ? (current.lastUpdate ?? null) : price.meta.fetchedAt
    E.priceBsr.currentPriceDateType =
      current && "lastUpdate" in current && current.lastUpdate ? "provider" : "fetchedAt"
    E.priceBsr.currency =
      targetInfo?.currency ||
      ({ US: "USD", UK: "GBP", DE: "EUR" } as Record<string, string>)[country]
    if (sales.meta.source === "xiyou")
      E.ordersLast30Days =
        (sales.value as Array<{ asin: string; orders?: number | null }>).find(
          row => row.asin === asin
        )?.orders ?? null
    if (price.meta.source === "xiyou") {
      E.priceBsr.currentPrice = finiteNumber(
        price.value.list.find(row => row.asin === asin)?.currentPrice
      )
      E.priceBsr.currentPriceType = "product"
      E.priceBsr.currentPriceDate = price.meta.fetchedAt
      E.priceBsr.listedDate =
        targetInfo?.streetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetInfo.streetDate)
          ? targetInfo.streetDate
          : null
      // A current product price is not evidence of a Buybox offer.
      E.priceBsr.buyboxPrice =
        priceTrend.meta.source === "sif"
          ? adaptAsinPerformanceE(asin, [], { list: [] }, priceTrend.value).priceBsr.buyboxPrice
          : null
    }
    if (priceTrend.meta.source === "xiyou") {
      const latest = xyPrice?.trends
        .filter(
          row =>
            row.date >= startDate &&
            row.date <= endDate &&
            finiteNumber(row.priceDistribution?.display) !== null
        )
        .sort((a, b) => a.date.localeCompare(b.date))
        .at(-1)
      E.priceBsr.displayPrice = finiteNumber(latest?.priceDistribution?.display)
      E.priceBsr.displayPriceDate = latest?.date ?? null
      E.priceBsr.coupon = uiText("未知", "Unknown")
      if (latest) {
        const coupon = latest.priceDistribution?.coupon
        E.priceBsr.trendPriceObservation = {
          date: latest.date,
          display: finiteNumber(latest.priceDistribution?.display),
          deal: finiteNumber(latest.priceDistribution?.deal),
          coupon: Array.isArray(coupon) ? coupon : null,
          couponStatus: coupon?.length ? "observed" : "unknown",
        }
        const couponText = coupon
          ?.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .join("；")
        if (couponText) E.priceBsr.coupon = couponText
      }
      E.priceBsr.buyboxPrice = null
    }
    const trendMeta = (
      result: { value: SifAsinOpTrafficTrendData; meta: EvidenceGroup },
      notice?: string,
      observedDates: string[] = []
    ): EvidenceGroup => ({
      ...result.meta,
      ...(result.meta.source === "xiyou"
        ? {
            requestedPeriod,
            period: {
              startDate: observedDates
                .filter(date => date >= startDate && date <= endDate)
                .sort()[0],
              endDate: observedDates
                .filter(date => date >= startDate && date <= endDate)
                .sort()
                .at(-1),
              completeness: "unknown",
            },
            dateRangeNotice: notice,
            categoryId: "categoryId" in result.value ? String(result.value.categoryId) : undefined,
          }
        : {
            requestedPeriod: sifRange,
            period: result.value.dates?.length
              ? { startDate: result.value.dates[0], endDate: result.value.dates.at(-1) }
              : undefined,
          }),
    })
    E.groups = {
      orders: { ...sales.meta, period: { completeness: "unknown" } },
      price: { ...price.meta, period: { completeness: "unknown" } },
      priceTrend: trendMeta(
        priceTrend,
        xyPrice?.dateRangeNotice,
        xyPrice?.trends.map(row => row.date)
      ),
      bsr: trendMeta(
        trend,
        xyBsr?.dateRangeNotice,
        xyBsr?.trends.map(row => row.date)
      ),
    }
    E.filled = [
      E.boughtInPastMonth,
      E.ordersLast30Days,
      E.priceBsr.currentPrice,
      E.priceBsr.buyboxPrice,
      E.priceBsr.displayPrice,
      E.priceBsr.bsr,
      E.priceBsr.listedDate,
    ].some(value => value !== null && value !== undefined)
    if (D.trafficPrecompute) {
      D.trafficPrecompute.bsrTrend = computeBsrTrendPrecompute(trend.value)
      emit({ type: "evidence", card: "D", data: D })
    }
    emit({ type: "evidence", card: "E", data: E })
    const sourcesE = [
      ...new Set(
        Object.values(E.groups)
          .filter(g => g.status !== "unavailable")
          .map(g => g.source)
      ),
    ]
    return {
      asin,
      country,
      C,
      D,
      E,
      meta: {
        primarySource,
        sources: {
          C: C.filled
            ? [
                ...new Set<"mcp" | "sif" | "xiyou">([
                  "mcp",
                  ...(C.group ? [C.group.source] : []),
                  ...(targetReference ? [targetReference.source] : []),
                ]),
              ]
            : undefined,
          D: [D.group.source],
          E: sourcesE,
        },
        sifDataReady,
        sifWarnings: warnings,
        fetchedAt: new Date().toISOString(),
        ...(C.group?.source !== "xiyou" &&
        C.group?.status !== "partial" &&
        d.meta.source === "sif" &&
        d.meta.status === "success" &&
        sourcesE.every(source => source === "sif")
          ? { estimatedPoints: 2 + Math.min(d.card.kwTop.length, 10) + 1 + 2 + 1 }
          : {}),
      },
    }
  }

  private checkDataReady(
    modules: { moduleCode: string; dataReady: boolean }[],
    codes: string[]
  ): boolean | null {
    if (!modules?.length) return null
    for (const code of codes) {
      const mod = modules.find(m => m.moduleCode === code)
      if (mod && mod.dataReady === false) return false
    }
    return true
  }

  private dataReadyWarnings(
    modules: { moduleCode: string; name: string; dataReady: boolean }[],
    codes: string[]
  ): string[] {
    if (!modules?.length) return []
    const warnings: string[] = []
    for (const code of codes) {
      const mod = modules.find(m => m.moduleCode === code)
      if (mod && mod.dataReady === false) {
        warnings.push(
          uiText(
            `${mod.name ?? code} 数据尚未就绪（dataReady=false）`,
            `${code} data is not ready (dataReady=false)`
          )
        )
      }
    }
    return warnings
  }

  /** B 卡 AI 痛点：评论非空调痛点服务（含计费）；失败/空评论回退基础卡 */
  private async enrichBWithPainPoints(
    dto: EvidenceRequestDto,
    userId: number,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void,
    abpc: {
      A: ListingEvidence
      P: ProductParamsEvidence
      B: ReviewEvidence
      raw: AuditDetailResponse | null
    }
  ): Promise<ReviewEvidence> {
    const baseB = abpc.B
    if (!baseB.filled || !abpc.raw) return baseB

    const comments = extractReviewComments(abpc.raw)
    if (!comments.commentList.length) return baseB

    emit({
      type: "progress",
      card: "B",
      message: uiText("正在分析评论 Top5 痛点…", "Analysing the top 5 review pain points…"),
    })
    try {
      const painPointsDto: ReviewPainPointsDto = {
        model: dto.model,
        commentList: comments.commentList,
        ...(comments.starPercent.length ? { starPercent: comments.starPercent } : {}),
        ...(comments.reviewCount !== undefined ? { reviewCount: comments.reviewCount } : {}),
        responseLanguage: dto.responseLanguage ?? uiLanguage(),
        ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
      }
      // 固定价模型时跳过内嵌按量扣费（审计链免费 / 取证模块由流程价 5 覆盖）
      const outcome = await this.painPoints.run(painPointsDto, userId, {
        skipUsageCharge: isAsinAuditFixedModel(dto.model),
      })
      if (!outcome.painPoints.length) return baseB
      const enriched: ReviewEvidence = { ...baseB, richPainPoints: outcome.painPoints }
      emit({ type: "evidence", card: "B", data: enriched })
      return enriched
    } catch (e) {
      const msg = isUpstreamQuotaError(e) ? uiText("部分数据未获取", "Some data is unavailable") : e instanceof Error ? e.message : String(e)
      warnings.push(
        uiText(
          `评论痛点分析失败：${msg}`,
          `Review pain-point analysis failed: ${localizeErrorMessage(msg)}`
        )
      )
      emit({
        type: "warning",
        message: uiText(
          `评论痛点分析失败：${msg}`,
          `Review pain-point analysis failed: ${localizeErrorMessage(msg)}`
        ),
      })
      return baseB
    }
  }

  /** module 场景：评论分析双输出（好评亮点 + 差评痛点带 quote）；失败降级基础卡（不中断） */
  private async enrichBWithAnalysis(
    dto: EvidenceRequestDto,
    userId: number,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void,
    abpc: {
      A: ListingEvidence
      P: ProductParamsEvidence
      B: ReviewEvidence
      raw: AuditDetailResponse | null
    }
  ): Promise<ReviewEvidence> {
    const baseB = abpc.B
    if (!baseB.filled || !abpc.raw) return baseB

    const comments = extractReviewComments(abpc.raw)
    if (!comments.commentList.length) return baseB

    emit({
      type: "progress",
      card: "B",
      message: uiText("正在分析评论亮点与痛点…", "Analysing review highlights and pain points…"),
    })
    try {
      const analysisDto: ReviewPainPointsDto = {
        model: dto.model,
        commentList: comments.commentList,
        ...(comments.starPercent.length ? { starPercent: comments.starPercent } : {}),
        ...(comments.reviewCount !== undefined ? { reviewCount: comments.reviewCount } : {}),
        responseLanguage: dto.responseLanguage ?? uiLanguage(),
        ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
      }
      // 固定价模型时跳过内嵌按量扣费（取证模块由流程价 5 覆盖）；
      // 非固定价模型按量回落时用取证专用 source，meta.scene 供区分审计链
      const outcome = await this.reviewAnalysis.run(analysisDto, userId, {
        skipUsageCharge: isAsinAuditFixedModel(dto.model),
        source: ASIN_EVIDENCE_SOURCE,
        meta: { scene: dto.scene },
      })
      if (!outcome.highlights.length && !outcome.painPoints.length) return baseB
      const enriched: ReviewEvidence = {
        ...baseB,
        ...(outcome.painPoints.length ? { richPainPoints: outcome.painPoints } : {}),
        ...(outcome.highlights.length ? { highlights: outcome.highlights } : {}),
      }
      emit({ type: "evidence", card: "B", data: enriched })
      return enriched
    } catch (e) {
      const msg = isUpstreamQuotaError(e) ? uiText("部分数据未获取", "Some data is unavailable") : e instanceof Error ? e.message : String(e)
      warnings.push(
        uiText(`评论分析失败：${msg}`, `Review analysis failed: ${localizeErrorMessage(msg)}`)
      )
      emit({
        type: "warning",
        message: uiText(
          `评论分析失败：${msg}`,
          `Review analysis failed: ${localizeErrorMessage(msg)}`
        ),
      })
      return baseB
    }
  }

  /** SIF 错误 → 流内 error 事件结构 */
  toErrorEvent(err: unknown): { message: string; code?: number } {
    if (err instanceof SifApiError) {
      return { message: localizeErrorMessage(err.message), code: err.code }
    }
    return {
      message: localizeErrorMessage(
        err instanceof Error ? err.message : uiText("取证失败", "Evidence collection failed")
      ),
    }
  }
}
