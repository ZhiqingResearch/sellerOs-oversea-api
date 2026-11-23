import { uiText } from "../../common/i18n/request-language"
import { auditLabel } from "../audit-labels"
import { computeTrafficPrecompute } from "../rules/traffic-precompute"
import type {
  AsinPerformanceEvidence,
  AsinPriceBsrSnapshot,
  CompetitorEvidenceDe,
  CompetitorKeywordRow,
  KeywordTrafficEvidence,
  KeywordTrafficTopRow,
} from "../types/de.types"
import type {
  SifAsinKeywordRow,
  SifAsinKeywordsMonthlyData,
  SifAsinKeywordsWeeklyData,
  SifAsinOpTrafficTrendData,
  SifBatchAsinPriceData,
  SifKeywordOverviewRow,
  SifVariantLastSalesRow,
} from "../types/sif.types"

export function sifFmtVol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ""
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

const KW_TAG_MAP: Record<string, string> = {
  isMainKw: "核心",
  isAccurateAboveKw: "品类",
  isAccurateKw: "功能属性",
  isAccurateTailKw: "场景",
  isAC: "核心",
  isPurchaseKw: "功能属性",
  isQualityKw: "人群",
}

export function sifKwTags(tagList: string[] | undefined): string[] {
  const out: string[] = []
  for (const t of tagList ?? []) {
    const mapped = KW_TAG_MAP[t] && auditLabel(KW_TAG_MAP[t])
    if (mapped && !out.includes(mapped)) out.push(mapped)
  }
  return out.length ? out : [auditLabel("品类")]
}

export function sifHeat(
  searchVol: number | null | undefined,
  aba: number | null | undefined
): string {
  if (searchVol != null && searchVol >= 80_000) return uiText("搜索量高", "High search volume")
  if (aba != null && aba <= 500) return uiText("购买率较高", "High purchase rate")
  return uiText("搜索量中", "Moderate search volume")
}

function keywordSearchVolNum(
  k: SifAsinKeywordRow,
  ov: Record<string, SifKeywordOverviewRow>
): number {
  const o = ov[k.keyword]
  return o?.estSearchesNum ?? k.searchVolume ?? 0
}

function mapKeywordRow(
  k: SifAsinKeywordRow,
  ov: Record<string, SifKeywordOverviewRow>,
  totalScoreSum: number
): KeywordTrafficTopRow {
  const o = ov[k.keyword] ?? {}
  const searchVol = o.estSearchesNum ?? k.searchVolume
  const aba = k.searchRank ?? o.searchesRank ?? null
  const nf = pickLast(k.naturalPositionSeq)
  const sp = pickLast(k.spPositionSeq)
  const nfRank = nf?.allPageRank != null ? String(nf.allPageRank) : uiText("无排名", "Unranked")
  const spRank = sp?.allPageRank != null ? String(sp.allPageRank) : uiText("无排名", "Unranked")

  return {
    kw: k.keyword,
    searchVol: sifFmtVol(searchVol),
    contribution: +(((k.totalScore ?? 0) / totalScoreSum) * 100).toFixed(2),
    aba,
    heat: sifHeat(searchVol, aba),
    ranking: uiText(`自然${nfRank} / 广告${spRank}`, `Organic ${nfRank} / Ads ${spRank}`),
    tags: sifKwTags(k.keywordTags),
  }
}

/** D 卡：asinKeywordsWeekly + batchKeywordOverview → 关键词与流量 */
export function adaptKeywordTrafficD(
  kwResp: SifAsinKeywordsWeeklyData,
  overviewList: SifKeywordOverviewRow[]
): KeywordTrafficEvidence {
  const list = kwResp.list ?? []
  const totalScoreSum = list.reduce((s, k) => s + (k.totalScore ?? 0), 0) || 1

  const ov: Record<string, SifKeywordOverviewRow> = {}
  for (const o of overviewList) {
    ov[o.keyword] = o
  }

  const kwTop = list.slice(0, 10).map(k => mapKeywordRow(k, ov, totalScoreSum))
  const kwDetail = [...list]
    .sort((a, b) => keywordSearchVolNum(b, ov) - keywordSearchVolNum(a, ov))
    .slice(0, 50)
    .map(k => mapKeywordRow(k, ov, totalScoreSum))

  const trafficPrecompute = computeTrafficPrecompute(list, overviewList)

  const core = list.filter(k => (k.keywordTags ?? []).includes("isMainKw")).length
  const organic = list.filter(k => (k.naturalPositionSeq ?? []).length > 0).length
  const ad = list.filter(k => (k.spPositionSeq ?? []).length > 0 || (k.adScore ?? 0) > 0).length
  // 机会词口径与第⑧维/优化阶段统一（searches>1000 + 自然非首页 + 购买率达标）
  const opportunity = trafficPrecompute.opportunityCount ?? 0

  const headKw = kwTop[0]?.kw ?? "—"
  const headContrib = kwTop[0]?.contribution ?? 0

  return {
    filled: list.length > 0,
    ...(!list.length
      ? { missingReason: "关键词接口未返回词级数据，不能确认首页命中、机会词承接及词族曝光" }
      : {}),
    period: { startDate: kwResp.startDate, endDate: kwResp.endDate },
    trafficPrecompute,
    summary: !list.length
      ? {
          coreCognition: "关键词接口返回空列表，尚无可核验的关键词证据。",
          trafficStory: "未返回数据不代表真实流量为零，也不能判断机会词已充分承接或流量结构正常。",
        }
      : {
      coreCognition:
        uiText(
          `该 ASIN 共反查到 ${kwResp.total ?? list.length} 个流量词，按 Sif 总流量得分排序，`,
          `${kwResp.total ?? list.length} traffic keywords were found, ranked by total SIF traffic score. `
        ) +
        uiText(
          `核心流量集中在「${headKw}」等头部词。`,
          `Core traffic is concentrated in leading keywords such as "${headKw}".`
        ),
      trafficStory:
        uiText(
          `头部词「${headKw}」流量贡献约 ${headContrib}%，`,
          `The leading keyword "${headKw}" contributes about ${headContrib}% of traffic. `
        ) +
        uiText(
          `自然流量词 ${organic} 个、广告曝光词 ${ad} 个，机会词 ${opportunity} 个可作为拓展方向。`,
          `There are ${organic} organic keywords, ${ad} ad-exposure keywords and ${opportunity} opportunity keywords to explore.`
        ),
    },
    kwStats: {
      reversed: kwResp.total ?? list.length,
      core,
      organic,
      ad,
      opportunity,
    },
    kwTop,
    kwDetail,
  }
}

/** C 卡：competitor_lookup 竞品 ASIN + SIF 反查关键词 → 竞品关键词分析 */
export function adaptCompetitorC(
  competitorAsins: string[],
  kwResp: SifAsinKeywordsMonthlyData,
  overviewList: SifKeywordOverviewRow[],
  queryKeyword: string
): CompetitorEvidenceDe {
  if (!competitorAsins.length) {
    return { filled: false, missingReason: uiText("未找到竞品数据", "No competitor data found") }
  }

  const ov: Record<string, SifKeywordOverviewRow> = {}
  for (const o of overviewList) ov[o.keyword] = o

  const list = kwResp.list ?? []
  const seen = new Set<string>()
  const keywords: CompetitorKeywordRow[] = []

  for (const k of list) {
    if (seen.has(k.keyword)) continue
    seen.add(k.keyword)
    const searchVol = ov[k.keyword]?.estSearchesNum ?? k.searchVolume ?? 0
    const tier =
      searchVol >= 200_000 ? "S" : searchVol >= 50_000 ? "A" : searchVol >= 20_000 ? "B" : "C"
    keywords.push({
      kw: k.keyword,
      tier,
      searches: sifFmtVol(searchVol),
    })
    if (keywords.length >= 10) break
  }

  return {
    filled: true,
    competitorAsins,
    sharedKeywords: queryKeyword ? [queryKeyword] : [],
    keywords,
  }
}

function pickLast<T>(arr: T[] | undefined): T | undefined {
  if (!arr?.length) return undefined
  return arr[arr.length - 1]
}

function formatCoupon(couponRaw: number | null | undefined): string {
  if (couponRaw == null || !Number.isFinite(couponRaw)) return uiText("未知", "Unknown")
  return couponRaw < 0 ? `${Math.round(couponRaw * 100)}%` : `$${couponRaw}`
}

/** E 卡：variantLastSales + batchAsinPrice + asinOpTrafficTrend → ASIN 分析（Sif 可覆盖字段） */
export function adaptAsinPerformanceE(
  asin: string,
  salesResp: SifVariantLastSalesRow[] | null | undefined,
  priceResp: SifBatchAsinPriceData | null | undefined,
  trendResp: SifAsinOpTrafficTrendData | null | undefined
): AsinPerformanceEvidence {
  const sale: Partial<SifVariantLastSalesRow> =
    salesResp?.find(row => row.asin?.toUpperCase() === asin.toUpperCase()) ?? {}
  const price: Partial<SifBatchAsinPriceData["list"][number]> =
    priceResp?.list?.find(row => row.asin?.toUpperCase() === asin.toUpperCase()) ?? {}
  const trend = trendResp ?? {}
  const finite = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : null
  const lastIdx = trend.dates?.length ? trend.dates.length - 1 : -1

  const pickAt = <T>(arr: T[] | undefined): T | null => {
    if (lastIdx < 0 || !arr || arr[lastIdx] === undefined) return null
    return arr[lastIdx] ?? null
  }

  let bsrTrend: string | null = null
  if (trend.bsr && trend.bsr.length >= 2) {
    const cur = trend.bsr[trend.bsr.length - 1]
    const prev = trend.bsr[trend.bsr.length - 2]
    if (cur != null && prev != null) {
      bsrTrend =
        cur < prev
          ? uiText("较上期改善", "Improved since the previous period")
          : cur > prev
            ? uiText("较上期下滑", "Declined since the previous period")
            : uiText("持平", "Unchanged")
    }
  }

  const priceBsr: AsinPriceBsrSnapshot = {
    buyboxPrice: finite(pickAt(trend.buyboxPrice)) ?? finite(price.currentPrice),
    bsr: finite(pickAt(trend.bsr)),
    bsrTrend,
    coupon: formatCoupon(pickAt(trend.couponInfo)),
    listedDate: price.listedDate ?? null,
    pricePriorityTags: price.pricePriorityTags,
    priceExceptionTags: price.priceExceptionTags,
  }

  return {
    filled: true,
    asin,
    boughtInPastMonth: finite(sale.boughtInPastMonth),
    priceBsr,
    sales: null,
    traffic: null,
    ad: null,
    profit: null,
    inventory: null,
  }
}
