import { uiText } from "../../common/i18n/request-language"
import type { AuditBoardItem } from "../types/audit.types"
import type { TrafficPrecompute, TrafficSuggestionBlock } from "../types/de.types"

/** Finalized scoring state owns the recommendation state, including J2. */
export function buildTrafficSuggestionsFromScore(
  items: AuditBoardItem[],
  pc: TrafficPrecompute | undefined
): TrafficSuggestionBlock[] {
  return items
    .filter(item => ["G1", "G3", "I3", "J2"].includes(item.id))
    .map(item => {
      const base = { ruleId: item.id, subDimension: item.name, maxScore: item.maxScore }
      if (item.status !== "verified" || item.score === null) {
        return {
          ...base,
          deducted: 0,
          level: "pending" as const,
          summary:
            item.status === "na"
              ? `不适用：${item.naReason || "本项不适用"}`
              : `证据不足：${item.pendingReason || "缺少本项核查依据"}`,
        }
      }
      const deducted = Math.max(0, Math.round((item.maxScore - item.score) * 100) / 100)
      if (!deducted)
        return { ...base, deducted, level: "ok" as const, summary: "已核验，本项未发现问题。" }
      const level =
        item.id === "G1"
          ? g1Level(deducted)
          : item.id === "I3"
            ? i3Level(deducted)
            : g3Level(deducted)
      const bt = pc?.bsrTrend
      const summary =
        item.id === "I3" && bt?.available
          ? `前7天均BSR ${bt.prev7AvgBsr} → 后7天均BSR ${bt.last7AvgBsr}，保持率${bt.retainedPct}%；检查近期排名变化及商品、竞品和口碑变化。`
          : item.deductions
              .map(d => d.reason)
              .filter(Boolean)
              .join("；") || "已确认本项存在问题，请结合核查依据优化。"
      return {
        ...base,
        deducted,
        level,
        summary,
        ...(item.id === "G1" && pc?.positionAllocation?.length
          ? { positionTable: pc.positionAllocation }
          : {}),
        ...(item.id === "G3" && pc?.opportunityList?.length
          ? { opportunityTable: pc.opportunityList }
          : {}),
      }
    })
}

/**
 * 流量四子维度建议兜底（v2.0 §八）：LLM 未输出 trafficSuggestions 时，
 * 用「流量诊断预计算」块生成 G1/G3 的降级建议；I3 自 v2.2 起 BSR 口径——
 * 预计算块 bsrTrend 数据充足即按公式评分，不足则 ⏸ 待核；J2 缺词族合并数据 → ⏸ 待核行。
 * 仅含数据驱动内容；AI 摘要留待 LLM 输出时覆盖。
 */

/** 扣分 → 建议级别（v2.0 §八分级表） */
function g1Level(deducted: number): TrafficSuggestionBlock["level"] {
  if (deducted >= 6) return "urgent"
  if (deducted >= 3) return "important"
  return "optimize"
}

function g3Level(deducted: number): TrafficSuggestionBlock["level"] {
  if (deducted >= 4) return "urgent"
  if (deducted >= 2) return "important"
  return "optimize"
}

/** I3 分级（v2.0 §八：≥5 urgent / 2.4~5 important / >0~2.4 optimize） */
function i3Level(deducted: number): TrafficSuggestionBlock["level"] {
  if (deducted >= 5) return "urgent"
  if (deducted >= 2.4) return "important"
  return "optimize"
}

export function buildTrafficSuggestionsFromPrecompute(
  pc: TrafficPrecompute | undefined
): TrafficSuggestionBlock[] | undefined {
  // G1 · 当日核心词首页观测率（最高扣 8）
  const g1: TrafficSuggestionBlock = (() => {
    if (!pc?.homepageHitTier || pc.pendingRules?.includes("G1") || pc.structure?.totalKw === 0) {
      return {
        subDimension: uiText("当日核心词首页观测率", "Daily core-keyword first-page visibility"),
        ruleId: "G1",
        deducted: 0,
        maxScore: 8,
        level: "pending",
        summary: uiText(
          "⏸ 固定词池抓取状态不明或口径未冻结，本次不评分",
          "⏸ Keyword-pool collection status or scope is unconfirmed; not scored"
        ),
      }
    }
    const hp = pc.homepageHitTier
    const deducted = hp.max - hp.score
    if (deducted === 0) {
      return {
        subDimension: uiText("当日核心词首页观测率", "Daily core-keyword first-page visibility"),
        ruleId: "G1",
        deducted: 0,
        maxScore: 8,
        level: "ok",
        summary: uiText("✅ 核心词首页覆盖良好", "✅ Good first-page coverage for core keywords"),
      }
    }
    return {
      subDimension: uiText("当日核心词首页观测率", "Daily core-keyword first-page visibility"),
      ruleId: "G1",
      deducted,
      maxScore: hp.max,
      level: g1Level(deducted),
      summary: uiText(
        `按搜索量 Top10 中仅 ${pc.top10Page1Hits} 个自然排名进首页（建议得分 ${hp.score}/${hp.max}）`,
        `Only ${pc.top10Page1Hits} of the top 10 keywords by search volume rank organically on page 1 (suggested score ${hp.score}/${hp.max})`
      ),
      ...(pc.positionAllocation?.length ? { positionTable: pc.positionAllocation } : {}),
    }
  })()

  // I3 · 排名趋势与稳定性（最高扣 8）——v2.2 BSR 口径：预计算块有 14 天序列即按公式评分
  const i3: TrafficSuggestionBlock = (() => {
    const bt = pc?.bsrTrend
    if (!bt?.available) {
      return {
        subDimension: uiText("排名趋势与稳定性", "Ranking trend and stability"),
        ruleId: "I3",
        deducted: 0,
        maxScore: 8,
        level: "pending",
        summary: uiText(
          `⏸ ${bt?.reason ?? "日级排名序列不足（需近 14 天 BSR：前 7 天 vs 后 7 天）"}，本次只诊断不评分`,
          `⏸ ${bt?.reason ?? "Insufficient daily rankings (14 days of BSR required)"}; diagnostic only, not scored`
        ),
      }
    }
    const deducted = Math.round((bt.tier.max - bt.tier.score) * 100) / 100
    if (deducted <= 0) {
      return {
        subDimension: uiText("排名趋势与稳定性", "Ranking trend and stability"),
        ruleId: "I3",
        deducted: 0,
        maxScore: 8,
        level: "ok",
        summary: uiText(
          `✅ 排名保持稳定（前 7 天均 BSR ${bt.prev7AvgBsr} vs 后 7 天均 ${bt.last7AvgBsr}，保持率 ${bt.retainedPct}%）`,
          `✅ Rankings are stable (first 7-day mean BSR ${bt.prev7AvgBsr} vs last 7-day mean ${bt.last7AvgBsr}; retention ${bt.retainedPct}%)`
        ),
      }
    }
    const declineNote =
      bt.declinedDays > 0
        ? uiText(
            `；尾部连续劣于基线 ${bt.declinedDays} 天`,
            `; worse than baseline for the last ${bt.declinedDays} consecutive days`
          )
        : ""
    return {
      subDimension: uiText("排名趋势与稳定性", "Ranking trend and stability"),
      ruleId: "I3",
      deducted,
      maxScore: 8,
      level: i3Level(deducted),
      summary: uiText(
        `前 7 天均 BSR ${bt.prev7AvgBsr} → 后 7 天均 ${bt.last7AvgBsr}，保持率 ${bt.retainedPct}%，扣 ${deducted} 分${declineNote}`,
        `First 7-day mean BSR ${bt.prev7AvgBsr} → last 7-day mean ${bt.last7AvgBsr}; retention ${bt.retainedPct}%; deducted ${deducted} points${declineNote}`
      ),
    }
  })()

  // G3 · 合格机会词曝光承接（最高扣 6）
  const g3: TrafficSuggestionBlock = (() => {
    if (!pc || pc.pendingRules?.includes("G3") || pc.structure?.totalKw === 0) {
      return {
        subDimension: uiText("合格机会词曝光承接", "Qualified opportunity-keyword coverage"),
        ruleId: "G3",
        deducted: 0,
        maxScore: 6,
        level: "pending",
        summary: uiText(
          "⏸ 机会词池采集状态不明，本次不评分",
          "⏸ Opportunity-keyword collection status is unconfirmed; not scored"
        ),
      }
    }
    // 预计算无「冻结需求权重 × 自然排名观测」明细，按机会词存在与否给保守扣分（与旧口径一致）
    const deducted = pc.opportunityCount === 0 ? 0 : 2
    if (deducted === 0) {
      return {
        subDimension: uiText("合格机会词曝光承接", "Qualified opportunity-keyword coverage"),
        ruleId: "G3",
        deducted: 0,
        maxScore: 6,
        level: "ok",
        summary: uiText(
          "✅ 未识别到待承接机会词",
          "✅ No uncovered opportunity keywords identified"
        ),
      }
    }
    return {
      subDimension: uiText("合格机会词曝光承接", "Qualified opportunity-keyword coverage"),
      ruleId: "G3",
      deducted,
      maxScore: 6,
      level: g3Level(deducted),
      summary: uiText(
        `识别到 ${pc.opportunityCount} 个机会词待文案承接（覆盖率需结合 Listing 交叉比对）`,
        `${pc.opportunityCount} opportunity keywords need listing coverage (cross-check against the listing)`
      ),
      ...(pc.opportunityList?.length ? { opportunityTable: pc.opportunityList } : {}),
    }
  })()

  // J2 · 流量来源韧性（最高扣 6）——预计算无词族合并，恒待核
  const j2: TrafficSuggestionBlock = {
    subDimension: uiText("流量来源韧性", "Traffic-source resilience"),
    ruleId: "J2",
    deducted: 0,
    maxScore: 6,
    level: "pending",
    summary: uiText(
      "⏸ 词族合并基准未冻结，本次只诊断不评分",
      "⏸ Keyword-family grouping is unconfirmed; diagnostic only, not scored"
    ),
  }

  // 扣分越多越靠前（v2.0 §八总原则）；待核与满分排后
  return [g1, i3, g3, j2].sort(
    (a, b) =>
      (b.level === "urgent" ? 3 : b.level === "important" ? 2 : b.level === "optimize" ? 1 : 0) -
      (a.level === "urgent" ? 3 : a.level === "important" ? 2 : a.level === "optimize" ? 1 : 0)
  )
}
