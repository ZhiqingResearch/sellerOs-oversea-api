import type {
  KeywordTrafficEvidence,
  KeywordTrafficTopRow,
  TrafficPrecompute,
} from "../types/de.types"
import type { SifAsinOpTrafficTrendData } from "../types/sif.types"
import { sifFmtVol } from "./adapters"
import {
  finiteNumber,
  XiyouBsrTrend,
  XiyouInfo,
  XiyouKeyword,
  XiyouMarketRow,
} from "./xiyou.client"

export function xiyouKeywords(rows: XiyouKeyword[]): XiyouKeyword[] {
  const seen = new Map<string, XiyouKeyword>()
  for (const row of rows) {
    const key = row.searchTerm?.trim().toLowerCase()
    if (!key) continue
    const previous = seen.get(key)
    const asins = [
      ...new Set([...(previous?.contributingAsins ?? []), ...(row.contributingAsins ?? [])]),
    ]
    if (
      !previous ||
      (finiteNumber(row.trafficSummary?.traffic?.total) ?? 0) >
        (finiteNumber(previous.trafficSummary?.traffic?.total) ?? 0)
    )
      seen.set(key, { ...row, searchTerm: row.searchTerm.trim(), contributingAsins: asins })
    else previous.contributingAsins = asins
  }
  return [...seen.values()].sort(
    (a, b) =>
      (finiteNumber(b.trafficSummary?.traffic?.total) ?? 0) -
        (finiteNumber(a.trafficSummary?.traffic?.total) ?? 0) ||
      a.searchTerm.toLowerCase().localeCompare(b.searchTerm.toLowerCase())
  )
}

export function adaptXiyouD(
  asin: string,
  rows: XiyouKeyword[],
  market: XiyouMarketRow[]
): KeywordTrafficEvidence {
  const list = xiyouKeywords(rows)
  const total = list.reduce(
    (sum, row) => sum + (finiteNumber(row.trafficSummary?.traffic?.total) ?? 0),
    0
  )
  const totalKnown = list.every(row => finiteNumber(row.trafficSummary?.traffic?.total) !== null)
  const byKey = new Map(market.map(row => [row.searchTerm.trim().toLowerCase(), row]))
  const mapRow = (row: XiyouKeyword): KeywordTrafficTopRow => {
    const report = byKey.get(row.searchTerm.toLowerCase())?.abaReport
    const volume = finiteNumber(report?.weeklySearchVolume)
    const share = finiteNumber(
      report?.topAsins?.find(a => a.asin.toUpperCase() === asin)?.conversionShare
    )
    const ranks = (row.ranks ?? [])
      .map(r => ({
        position: r.position,
        page: finiteNumber(r.page),
        pageRank: finiteNumber(r.pageRank),
        totalRank: finiteNumber(r.totalRank),
        rankTime: r.rankTime,
      }))
      .sort((a, b) => (Date.parse(b.rankTime ?? "") || 0) - (Date.parse(a.rankTime ?? "") || 0))
    const natural = ranks.find(r => r.position === "or")
    const ad = ranks.find(r => r.position === "sp")
    return {
      traffic: {
        total: finiteNumber(row.trafficSummary?.traffic?.total),
        organic: finiteNumber(row.trafficSummary?.traffic?.organic),
        advertising: finiteNumber(row.trafficSummary?.traffic?.advertising),
      },
      contributingAsins: row.contributingAsins,
      kw: row.searchTerm,
      searchVol: volume === null ? "未知" : `${sifFmtVol(volume)}（周）`,
      weeklySearchVolume: volume,
      searchPeriod: { startDate: report?.reportFromDate, endDate: report?.reportToDate },
      conversionSharePct: share === null ? null : share * 100,
      contribution:
        totalKnown && total > 0 && finiteNumber(row.trafficSummary?.traffic?.total) !== null
          ? +(((finiteNumber(row.trafficSummary?.traffic?.total) ?? 0) * 100) / total).toFixed(2)
          : null,
      aba: finiteNumber(report?.searchFrequencyRank),
      heat: "周量，不适用原分档",
      tags: [],
      ranks,
      ranking: `自然${natural?.totalRank ?? "未知"} / 广告${ad?.totalRank ?? "未知"}`,
    }
  }
  const mapped = list.map(mapRow)
  const percentage = (field: "organic" | "advertising") =>
    total > 0 &&
    list.every(
      row =>
        finiteNumber(row.trafficSummary?.traffic?.total) !== null &&
        finiteNumber(row.trafficSummary?.traffic?.[field]) !== null
    )
      ? +(
          (100 *
            list.reduce(
              (sum, row) => sum + finiteNumber(row.trafficSummary?.traffic?.[field])!,
              0
            )) /
          total
        ).toFixed(2)
      : null
  const naturalPct = percentage("organic")
  const advertisingPct = percentage("advertising")
  const pc: TrafficPrecompute = {
    pendingRules: ["G1", "G3", "J2"],
    top10Page1Hits: null,
    homepageHitTier: null,
    weightedNaturalPct: naturalPct,
    naturalHealthTier: null,
    opportunityCount: null,
    top1ConcentrationPct: total > 0 ? (mapped[0]?.contribution ?? null) : null,
    concentrationTier: null,
    summaryLines: ["备用来源词池仅作诊断，周量不适用原分档；排名日期不代表当日完整观测。"],
  }
  return {
    filled: list.length > 0,
    ...(list.length ? {} : { missingReason: "本期未返回流量词" }),
    kwTop: mapped.slice(0, 10),
    kwDetail: mapped
      .slice(0, 50)
      .sort((a, b) => (b.weeklySearchVolume ?? -1) - (a.weeklySearchVolume ?? -1)),
    trafficPrecompute: pc,
    summary: {
      coreCognition: `备用数据源返回 ${list.length} 个流量词，流量占比仅限已取得词池。`,
      trafficStory: `已取词池自然流量占比 ${naturalPct ?? "未知"}%，广告流量占比 ${advertisingPct ?? "未知"}%；流量候选词按周搜索量排序；核心标签、完整性与当日排名观测未知。`,
    },
  }
}

export function xiyouBsrSeries(
  data: XiyouBsrTrend,
  info: XiyouInfo | undefined,
  startDate: string,
  endDate: string
): SifAsinOpTrafficTrendData & { categoryId?: string } {
  const ids = new Set((data.categoryTree ?? []).map(c => c.categoryId))
  const categoryId =
    info?.amzCategoryTree?.path?.find(c => ids.has(c.categoryId))?.categoryId ??
    (data.categoryTree?.filter(c => c.root).length === 1
      ? data.categoryTree.find(c => c.root)?.categoryId
      : undefined)
  if (!categoryId) return {}
  const byDate = new Map<string, number | null>()
  const conflicts = new Set<string>()
  for (const row of data.trends) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date < startDate || row.date > endDate)
      continue
    const value = finiteNumber(row.values?.find(v => v.categoryId === categoryId)?.rank)
    // Conflicting duplicates are unknown, never choose whichever gives the better score.
    if (byDate.has(row.date) && byDate.get(row.date) !== value) conflicts.add(row.date)
    byDate.set(
      row.date,
      conflicts.has(row.date) ? null : value !== null && value > 0 ? value : null
    )
  }
  const dates: string[] = []
  for (let day = Date.parse(startDate); day <= Date.parse(endDate); day += 86_400_000)
    dates.push(new Date(day).toISOString().slice(0, 10))
  return { categoryId, dates, bsr: dates.map(day => byDate.get(day) ?? null) }
}
