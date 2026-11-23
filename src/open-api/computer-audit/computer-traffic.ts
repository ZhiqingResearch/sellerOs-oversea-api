import {
  adaptAsinPerformanceE,
  adaptCompetitorC,
  adaptKeywordTrafficD,
} from "../../asin-audit/evidence/adapters"
import type { EvidenceSseEvent } from "../../asin-audit/evidence/evidence.service"
import { filterCompetitorCandidates } from "../../asin-audit/rules/competitor-filter"
import { computeBsrTrendPrecompute } from "../../asin-audit/rules/traffic-precompute"
import type { DeEvidenceResult } from "../../asin-audit/types/audit.types"
import { ComputerMcpClient } from "./computer-mcp.client"
import { ComputerSifClient } from "./computer-sif.client"
function trendDateRange(fetchedAt: Date) {
  return {
    startDate: new Date(fetchedAt.getTime() - 30 * 86400000).toISOString().slice(0, 10),
    endDate: fetchedAt.toISOString().slice(0, 10),
  }
}
export class ComputerTrafficCollector {
  constructor(
    private readonly sif: ComputerSifClient,
    private readonly mcp: ComputerMcpClient,
    private readonly fetchedAt: Date
  ) {}
  async collect(
    asin: string,
    country: string,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void
  ): Promise<DeEvidenceResult> {
    emit({ type: "progress", card: "D", message: "检查 SIF 数据就绪状态…" })
    let sifDataReady: boolean | null = null
    try {
      const ready = await this.sif.getLastDataTime(country, "last_30d")
      sifDataReady = this._checkDataReady(ready.list ?? [], ["asinKeywordSummary", "last_30d"])
      for (const w of this._dataReadyWarnings(ready.list ?? [], [
        "asinKeywordSummary",
        "last_30d",
      ])) {
        warnings.push(w)
        emit({ type: "warning", message: w })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`数据就绪检查跳过：${msg}`)
      emit({ type: "warning", message: `数据就绪检查跳过：${msg}` })
    }

    emit({ type: "progress", card: "D", message: "正在反查近 30 天核心流量词…" })
    const kwResp = await this.sif.asinKeywordsMonthly(country, [asin], { last30d: true })

    const topKeywords = (kwResp.list ?? []).slice(0, 10).map(k => k.keyword)
    emit({
      type: "progress",
      card: "D",
      message: `补全 ${topKeywords.length} 个关键词搜索量…`,
    })
    const overview = topKeywords.length
      ? await this.sif.batchKeywordOverview(country, topKeywords)
      : []

    const D = adaptKeywordTrafficD(kwResp, overview)
    emit({ type: "evidence", card: "D", data: D })

    // C 卡：按目标 ASIN 查同款竞品（MCP asin_competitor），配件/周边过滤后取前 3，再反查竞品关键词。
    // 曾用 keyword 版 competitor_lookup（D 卡 Top1 词查榜）——关键词宽匹配+按销量排序会被
    // 配件/耗材霸榜（HP 笔记本查出打印纸），已废弃。
    let C: DeEvidenceResult["C"] = { filled: false, missingReason: "未找到竞品 ASIN" }
    try {
      emit({ type: "progress", card: "C", message: "正在按 ASIN 查询同类竞品…" })
      const { items } = await this.mcp.callAsinCompetitor(asin, country, 10)
      const candidates = items
        .map(it => ({
          asin: typeof it.asin === "string" ? it.asin.trim() : "",
          title: typeof it.title === "string" ? it.title : undefined,
          brand: typeof it.brand === "string" ? it.brand : undefined,
          nodeLabelPath: typeof it.nodeLabelPath === "string" ? it.nodeLabelPath : undefined,
        }))
        .filter(c => c.asin.length > 0)

      if (!candidates.length) {
        C = { filled: false, missingReason: "未找到竞品 ASIN" }
      } else {
        // 目标标题/品牌做过滤参照；拿不到则跳过过滤（缺参照宁可放行，避免误杀）
        let targetRef: { title?: string; brand?: string } = {}
        try {
          const detail = await this.sif.batchAsinDetail(country, [asin])
          targetRef = { title: detail.list?.[0]?.title, brand: detail.list?.[0]?.brand }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          warnings.push(`竞品品类过滤参照获取失败，跳过过滤：${msg}`)
          emit({ type: "warning", message: `竞品品类过滤参照获取失败，跳过过滤：${msg}` })
        }
        const { kept, dropped } = filterCompetitorCandidates(candidates, targetRef, 3)
        for (const d of dropped) {
          warnings.push(`竞品 ${d.asin} 已过滤：${d.reason}`)
          emit({ type: "warning", message: `竞品 ${d.asin} 已过滤：${d.reason}` })
        }
        const competitorAsins = kept.map(k => k.asin)

        if (!competitorAsins.length) {
          C = { filled: false, missingReason: "竞品经配件/周边过滤后无匹配" }
        } else {
          emit({
            type: "progress",
            card: "C",
            message: `反查 ${competitorAsins.length} 个竞品的关键词…`,
          })
          const compKwResp = await this.sif.asinKeywordsMonthly(country, competitorAsins, {
            last30d: true,
          })
          const compTopKws = (compKwResp.list ?? []).slice(0, 20).map(k => k.keyword)
          const compOverview = compTopKws.length
            ? await this.sif.batchKeywordOverview(country, compTopKws)
            : []
          C = adaptCompetitorC(competitorAsins, compKwResp, compOverview, D.kwTop[0]?.kw ?? "")
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`竞品查询失败：${msg}`)
      emit({ type: "warning", message: `竞品查询失败：${msg}` })
      C = { filled: false, missingReason: msg }
    }
    emit({ type: "evidence", card: "C", data: C })

    const { startDate, endDate } = trendDateRange(this.fetchedAt)
    emit({ type: "progress", card: "E", message: "正在拉取前台销量与 BSR 趋势…" })
    const [sales, price, trend] = await Promise.all([
      this.sif.variantLastSales(country, asin).catch((e: unknown) => {
        warnings.push(`前台销量获取失败：${e instanceof Error ? e.message : String(e)}`)
        return []
      }),
      this.sif.batchAsinPrice(country, [asin]).catch((e: unknown) => {
        warnings.push(`价格/coupon 获取失败：${e instanceof Error ? e.message : String(e)}`)
        return { list: [] }
      }),
      this.sif
        .asinOpTrafficTrend(country, asin, startDate, endDate)
        .then(data => {
          if (data) return data
          const message = `未查询到该 ASIN 在 Amazon ${country} 的运营趋势数据`
          warnings.push(message)
          emit({ type: "warning", message })
          return {}
        })
        .catch((e: unknown) => {
          warnings.push(`BSR 趋势获取失败：${e instanceof Error ? e.message : String(e)}`)
          return {}
        }),
    ])

    const E = adaptAsinPerformanceE(asin, sales, price, trend)

    // I3 排名趋势（BSR 口径）：30 天日级序列已在 hand，裁近 14 天算前 7 vs 后 7 挂进 D 卡预计算块
    if (D.trafficPrecompute) {
      D.trafficPrecompute.bsrTrend = computeBsrTrendPrecompute(trend)
      // trend 就绪后 D 卡重推一次（含 bsrTrend，供前端流式渲染走势图）——B 卡基础版→增强版双推同款，覆盖渲染
      emit({ type: "evidence", card: "D", data: D })
    }
    emit({ type: "evidence", card: "E", data: E })

    // 单次 D+C+E：lastDataTime(0) + kwMonthly(1) + overview(≤10) + asinDetail 目标参照(1)
    //   + sales(1) + price(2) + trend(1)；竞品反查词与 MCP 竞品查询沿用原口径不计入
    const estimatedPoints = 2 + Math.min(topKeywords.length, 10) + 1 + 2 + 1

    return {
      asin,
      country,
      C,
      D,
      E,
      meta: {
        sources: { C: C.filled ? ["mcp"] : undefined, D: ["sif"], E: ["sif"] },
        sifDataReady,
        sifWarnings: warnings,
        fetchedAt: new Date().toISOString(),
        estimatedPoints,
      },
    }
  }

  private _checkDataReady(
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

  private _dataReadyWarnings(
    modules: { moduleCode: string; name: string; dataReady: boolean }[],
    codes: string[]
  ): string[] {
    if (!modules?.length) return []
    const warnings: string[] = []
    for (const code of codes) {
      const mod = modules.find(m => m.moduleCode === code)
      if (mod && mod.dataReady === false) {
        warnings.push(`${mod.name ?? code} 数据尚未就绪（dataReady=false）`)
      }
    }
    return warnings
  }
}
