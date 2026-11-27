import { Logger } from "@nestjs/common"
import { uiLanguage, uiText } from "../common/i18n/request-language"
import { isJsonObject } from "../common/utils/canonical-json"
import { parseListingJsonObject } from "./listing-result-parser"
import { CDQ_CRITERION_NAMES_EN, CDQ_DIMENSION_NAMES_EN, CDQ_WEIGHT_NOTE_EN } from "./listing-cdq-labels"
import { CDQ_SCORE_VERSION } from "./listing-cdq-score"
import { formatCdqSubtitle, recalculateCdqScoreSummary } from "./listing-cdq-summary"
import { recalculateListingAlexaScore } from "./listing-alexa-score"
import { validateScoreReport } from "./listing-score-recovery"
import { validateListingReportRules, type ListingRuleContext } from "./listing-score-rules"
import { recalculateListingAttributeScore } from "./listing-attribute-normalization"
import { normalizeListingScoreArithmetic, normalizeListingScoreStructure } from "./listing-score-normalization"
import { reconcileListingDescriptionScore } from "./listing-description-score"
import { SEARCH_TERMS_UNAVAILABLE } from "./listing-search-terms-score"

const SCORE_SOURCE_LABELS_EN = new Map([
  ["官方", "Official"],
  ["行业研究", "Industry research"],
  ["操作建议", "Practical guidance"],
])
const CDQ_WEIGHT_NOTE_ZH =
  /^(?:(?:说明|注|优化)\s*[：:]\s*)?CDQ\s*权重为内部整理口径[，,]\s*不是\s*Amazon\s*官方评分算法[。.]?$/i
const QUOTE_OR_BULLET_FORMULA =
  /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|(?<!\w)'[^'\n]+'(?!\w)|\x60[^\x60\n]*\x60|\b5\s*[×*]\s*合格条数\s*[/÷]\s*(N\b|6\b|实际条数)/g

function localizeBulletFormula(text: string, sourceText?: string): string {
  return text.replace(QUOTE_OR_BULLET_FORMULA, (match, denominator: string | undefined) =>
    denominator && !sourceText?.includes(match)
      ? `5 × qualifying bullets / ${denominator === "实际条数" ? "actual bullet count" : denominator}`
      : match
  )
}

/** 只检查能否展示；算术、证据、规则差异都不能把已有完整报告变成错误页。 */
export function prepareListingScoreDelivery(
  text: string,
  market?: string,
  context?: ListingRuleContext
): string | undefined {
  let report: Record<string, unknown>
  if (!text.trim()) return undefined
  try { report = parseListingJsonObject(text) } catch {
    // 原始输出已单独保存；格式未完整返回也交付中性占位，不把已有正文变成错误页。
    report = {}
  }
  report = normalizeListingScoreStructure(report, market)
  if (!Array.isArray(report.dimensions) || !report.dimensions.length) return undefined
  // 缺失的纯展示字段只补空容器，不补造评分、扣分理由或建议。
  if (!Array.isArray(report.suggestions)) report.suggestions = []
  else report.suggestions = report.suggestions.filter(value => typeof value === "string")
  if (typeof report.potential !== "string") report.potential = ""
  delete report.validationStatus
  delete report.validationWarnings
  report = normalizeListingScoreArithmetic(report)
  report = recalculateListingAlexaScore(report, context?.sourceFacts)
  report = recalculateListingAttributeScore(report, context?.sourceFacts)
  report = reconcileListingDescriptionScore(report, context?.sourceFacts)
  try {
    validateListingReportRules(report, context)
    report = parseListingJsonObject(validateScoreReport(JSON.stringify(report), market))
  } catch (error) {
    Logger.warn(error instanceof Error ? error.message : "评分一致性待核对", "ListingScoreDelivery")
    // 细则得分、扣分与证据保留；校验是诊断，不是交付门槛。
    report.validationStatus = "BEST_EFFORT"
  }
  // 汇总由已交付的细则得分计算，不触发规则校对或模型重试。
  report = normalizeListingScoreArithmetic(report)
  report = recalculateCdqScoreSummary(report)
  if (report.scoreVersion === CDQ_SCORE_VERSION) {
    const isEnglish = uiLanguage() === "en-US"
    const sourceText = context?.sourceFacts ? JSON.stringify(context.sourceFacts) : undefined
    const dimensions = report.dimensions as Array<{
      name: string
      criteria: Array<{ name: string; source?: unknown; status?: unknown; description?: unknown; deductions: Array<{ reason: string }> }>
      cdq?: unknown
      subtitle?: string
    }>
    const searchTerms = dimensions[1].criteria[3]
    if (searchTerms.status === "UNAVAILABLE" && SEARCH_TERMS_UNAVAILABLE.some(label => label === searchTerms.description))
      searchTerms.description = uiText(...SEARCH_TERMS_UNAVAILABLE)
    report.suggestions = (report.suggestions as string[]).map(suggestion => {
      const text = suggestion.trim()
      if (sourceText?.includes(text)) return suggestion
      if (!isEnglish && text === CDQ_WEIGHT_NOTE_EN)
        return "CDQ权重为内部整理口径，不是Amazon官方评分算法。"
      return isEnglish && CDQ_WEIGHT_NOTE_ZH.test(text) ? CDQ_WEIGHT_NOTE_EN : suggestion
    })
    if (isEnglish) {
      dimensions.forEach((dimension, index) => {
        dimension.name = CDQ_DIMENSION_NAMES_EN[index]
        dimension.criteria.forEach((criterion, criterionIndex) => {
          criterion.name = CDQ_CRITERION_NAMES_EN[index][criterionIndex]
          if (typeof criterion.source === "string")
            criterion.source = SCORE_SOURCE_LABELS_EN.get(criterion.source.trim()) ?? criterion.source
        })
      })
      const bullet = dimensions[3].criteria[1]
      if (typeof bullet.description === "string")
        bullet.description = localizeBulletFormula(bullet.description, sourceText)
      for (const deduction of bullet.deductions)
        deduction.reason = localizeBulletFormula(deduction.reason, sourceText)
      const [dimension] = dimensions
      const cdq = dimension.cdq
      if (isJsonObject(cdq) && typeof cdq.effectiveMax === "number" && typeof cdq.applicableMax === "number" &&
        (typeof cdq.normalizedScore === "number" || cdq.normalizedScore === null)) {
        dimension.subtitle = formatCdqSubtitle(cdq.normalizedScore, cdq.effectiveMax, cdq.applicableMax)
      }
    }
  }
  return JSON.stringify(report)
}
