import { uiText } from "../common/i18n/request-language"
import { isCdqScoreReport } from "./listing-cdq-score"
import { getListingEvidenceError, type ListingScoreSource } from "./listing-score-evidence"

// 与用户确认的四维提示词一致；数值为各检查点累计扣分上限。
const LISTING_RULES: Record<string, Record<string, number>> = {
  "0:0": { "attribute.required": 30 },
  "0:1": { "title.complete": 8, "title.length": 5, "title.repeat": 2.5, "title.case": 4, "title.prohibited": 25 },
  "0:2": { "variant.value": 8, "variant.format": 4, "variant.duplicate": 4 },
  "0:3": { "image.compliance": 6, "image.zoom": 3, "image.count": 3, "image.coverage": 3 },
  "0:4": { "aplus.modules": 2, "aplus.comparison": 1.5, "aplus.scene": 1.5 },
  "0:5": { "bullet.count": 5 },
  "1:0": { "keyword.core": 7 },
  "1:1": { "keyword.sa": 7 },
  "1:2": { "keyword.longtail": 5 },
  "1:3": { "keyword.searchTerms": 4 },
  "1:4": { "keyword.relevance": 2 },
  "2:0": { "cosmo.common": 10 },
  "2:1": { "cosmo.category": 6 },
  "2:2": { "cosmo.medium": 4 },
  "3:0": { "alexa.title": 7 },
  "3:1": { "alexa.bulletData": 5 },
  "3:2": { "alexa.description": 2 },
}

export interface ListingRuleContext {
  sourceFacts?: ListingScoreSource
  /** 后端已成功读取的副图数量；未获取图片证据时不设置，不能以0代替未知。 */
  confirmedSecondaryCount?: number
}

// 仅编码文档已有的四类图片覆盖和两类描述扣分，不新增评分检查点。
const FIXED_RULE_CHECKS: Record<string, { points: number; checkIds: string[] }> = {
  "image.coverage": { points: 0.75, checkIds: ["scene", "detail", "dimensions", "package"] },
  "alexa.description": { points: 1, checkIds: ["specifications", "overview_scenes"] },
}

export function getListingCriterionRules(dimensionIndex: number, criterionIndex: number): Record<string, number> {
  return { ...LISTING_RULES[`${dimensionIndex}:${criterionIndex}`] }
}

export function getListingCriterionCheckIds(dimensionIndex: number, criterionIndex: number): Record<string, string[]> {
  return Object.fromEntries(Object.keys(getListingCriterionRules(dimensionIndex, criterionIndex))
    .filter(ruleId => Object.hasOwn(FIXED_RULE_CHECKS, ruleId))
    .map(ruleId => [ruleId, [...FIXED_RULE_CHECKS[ruleId].checkIds]]))
}

/** 仅维度层原有额外惩罚，子项扣分不能再次放到维度层。 */
export function getListingDimensionRules(index: number): Record<string, number> {
  return index === 1 ? { "keyword.titleLength": 10 } : index === 3 ? { "alexa.stuffing": 5 } : {}
}

export function getListingDimensionRuleError(index: number, dimension: {
  score: number; criteria: Array<{ score: number | null }>; deductions?: unknown
}): string | null {
  if (index === 0) return null // CDQ由六项按有效满分折算。
  const extra = dimension.criteria.reduce((sum, criterion) => sum + Number(criterion.score), 0) - dimension.score
  const deductions = dimension.deductions ?? []
  if (!Array.isArray(deductions)) return uiText("维度扣分列表格式错误", "Invalid dimension deduction list")
  const rules = getListingDimensionRules(index)
  const ruleId = Object.keys(rules)[0] ?? ""
  const limit = rules[ruleId] ?? 0
  let sum = 0
  const seen = new Set<string>()
  for (const deduction of deductions) {
    if (!ruleId || !deduction || deduction.ruleId !== ruleId || typeof deduction.evidence !== "string" ||
      !deduction.evidence.trim() || typeof deduction.reason !== "string" || !deduction.reason.trim() ||
      typeof deduction.points !== "number" || deduction.points <= 0 || !Number.isFinite(deduction.points))
      return uiText("维度额外扣分必须属于原有规则并提供具体证据", "Each dimension penalty must cite an allowed rule and specific evidence")
    if (seen.has(deduction.evidence.trim())) return uiText("维度额外扣分证据重复", "Duplicate evidence for a dimension penalty")
    seen.add(deduction.evidence.trim())
    sum += deduction.points
  }
  const criterionSum = dimension.criteria.reduce((total, criterion) => total + Number(criterion.score), 0)
  if (sum > limit || Math.abs(Math.min(criterionSum, sum) - extra) > 0.0001)
    return uiText("维度额外扣分与原有上限、证据不一致", "Dimension deductions conflict with the cap or supporting evidence")
  return null
}

export function getListingCriterionRuleError(
  dimensionIndex: number,
  criterionIndex: number,
  criterion: { score: unknown; deductions?: unknown },
  context: ListingRuleContext = {}
): string | null {
  const rules = LISTING_RULES[`${dimensionIndex}:${criterionIndex}`]
  if (!rules || !Array.isArray(criterion.deductions)) return uiText("评分项或扣分列表不符合规则", "Invalid criterion or deduction list")
  if (context.sourceFacts) {
    const evidenceError = getListingEvidenceError(dimensionIndex, criterionIndex, criterion, context.sourceFacts)
    if (evidenceError) return evidenceError
  }
  const totals: Record<string, number> = {}
  const evidenceKeys = new Set<string>()
  const checkKeys = new Set<string>()
  for (const deduction of criterion.deductions) {
    if (!deduction || typeof deduction.points !== "number" || !Number.isFinite(deduction.points) ||
      deduction.points <= 0 || typeof deduction.reason !== "string" || !deduction.reason.trim())
      return uiText("扣分记录必须有正数points和具体reason；无扣分时deductions必须为[]", "Deductions need positive points and a specific reason; use [] when none apply")
    if (!deduction || typeof deduction.ruleId !== "string" || !Object.hasOwn(rules, deduction.ruleId))
      return uiText("扣分必须引用当前评分项允许的ruleId，不得新增或跨项扣分", "Use a ruleId allowed for this criterion")
    if (typeof deduction.evidence !== "string" || !deduction.evidence.trim())
      return uiText("扣分必须提供原始字段或图片的具体证据", "Cite the actual source field or image for each deduction")
    const fixedCheck = FIXED_RULE_CHECKS[deduction.ruleId]
    if (fixedCheck) {
      if (typeof deduction.checkId !== "string" || !fixedCheck.checkIds.includes(deduction.checkId))
        return uiText(`${deduction.ruleId}必须逐项提供checkId：${fixedCheck.checkIds.join("、")}`, `${deduction.ruleId} requires one checkId per deduction from: ${fixedCheck.checkIds.join(", ")}`)
      if (Math.abs(deduction.points - fixedCheck.points) > 0.0001)
        return uiText(`${deduction.ruleId}每个检查点固定扣${fixedCheck.points}分，不得合并或更改分值`, `Each ${deduction.ruleId} check costs exactly ${fixedCheck.points} points`)
      const checkKey = `${deduction.ruleId}:${deduction.checkId}`
      if (checkKeys.has(checkKey)) return uiText(`${checkKey}只能扣分一次，不得换说法重复扣分`, `Count ${checkKey} only once`)
      checkKeys.add(checkKey)
    }
    const key = `${deduction.ruleId}:${fixedCheck ? deduction.checkId : ""}:${deduction.evidence.trim().toLowerCase()}`
    if (evidenceKeys.has(key)) return uiText("同一检查点的同一证据不得重复扣分", "Do not deduct twice for the same evidence at the same checkpoint")
    evidenceKeys.add(key)
    totals[deduction.ruleId] = (totals[deduction.ruleId] ?? 0) + Number(deduction.points)
    if (!Number.isFinite(totals[deduction.ruleId]) || totals[deduction.ruleId] > rules[deduction.ruleId] + 0.0001)
      return uiText(`检查点${deduction.ruleId}的累计扣分超过${rules[deduction.ruleId]}分`, `Total deductions under ${deduction.ruleId} exceed ${rules[deduction.ruleId]} points`)
  }
  if (dimensionIndex === 0 && criterionIndex === 3 && criterion.score !== null &&
    context.confirmedSecondaryCount !== undefined) {
    const count = context.confirmedSecondaryCount
    if (!Number.isSafeInteger(count) || count < 0) return uiText("后端确认的副图数量必须为非负整数", "The confirmed secondary image count must be a nonnegative integer")
    const expectedDeduction = Math.max(0, 3 - 0.5 * count)
    if (Math.abs((totals["image.count"] ?? 0) - expectedDeduction) > 0.0001)
      return uiText(`后端确认副图${count}张，数量得分为3×min(${count},6)/6，image.count累计应扣${expectedDeduction}分`, `The confirmed secondary image count is ${count}. Points=3*min(${count},6)/6; the image.count deduction must total ${expectedDeduction}`)
  }
  if (totals["title.prohibited"] !== undefined &&
    (criterion.score !== 0 || Object.keys(totals).length !== 1 || totals["title.prohibited"] !== 25))
    return uiText("标题违禁仅该项25分归零，不叠加其他标题检查点扣分", "A prohibited title loses precisely its 25 points without stacking other title deductions")
  if (dimensionIndex === 0 && criterionIndex === 5 && criterion.score !== null &&
    ![0, 2.5, 5].includes(Number(criterion.score))) return uiText("五点条数仅对应0、2.5、5分", "Bullet-count scores may only be 0, 2.5 or 5")
  return null
}

/** 新生成的CDQ报告必须通过规则检查；历史展示仍兼容旧JSON。 */
export function validateListingReportRules(report: Record<string, unknown>, context: ListingRuleContext = {}): void {
  if (!isCdqScoreReport(report)) return
  const dimensions = report.dimensions as Array<{ score: number; deductions?: unknown; criteria: Array<{ score: number | null; deductions?: unknown }> }>
  dimensions.forEach((dimension, dimensionIndex) => {
    const dimensionError = getListingDimensionRuleError(dimensionIndex, dimension)
    if (dimensionError) throw new Error(dimensionError)
    dimension.criteria.forEach((criterion, criterionIndex) => {
      const error = getListingCriterionRuleError(dimensionIndex, criterionIndex, criterion, context)
      if (error) throw new Error(error)
    })
  })
}

/** 新版CDQ文档3.1.1/3.1.2/规则1.3；只更新结构化属性口径，不新增输出字段或拦截。 */
export const LISTING_ATTRIBUTE_RULE_PROMPT =
  "For structured attributes, use all verified visible attributes when the category template is unavailable. Omit statistics. Missing recommended fields carry no deduction. Use weights 3/2/1 and severity fractions 100%/50%/0%. Uncertain importance defaults to 2; explain equal weighting only when classification is impossible. Apply the first evidenced issue in order: contradiction, wrong field/type/granularity or repeated description, unit/scale, promotional language. Contradictions require two specifically comparable facts. Generic categories and distinct bases of measurement are insufficient. A wrong field/type/granularity, contradiction or wrong magnitude loses the full share; a repeated neutral description, missing unit with plausible value or marketing language loses half. An unresolved basis or missing physical evidence loses none. Score=30 minus the sum of deductions; each deduction=30*weight*severity/total assessed weight, rounded to at most four decimals. Include correct attributes in the denominator. Describe the verified scope and counts. Give the field, current value, consequences and a supported change in each reason. Reserve weight calculations for attributePresentation. Put unresolved issues in suggestions. Only mark the criterion unavailable if the attributes themselves are missing. These weighted rules take precedence over simplified examples; attributePresentation is optional. Do not equate the number of visible attributes with the required count. Compute the score, description and deductions from the same assessment. Do not copy example facts into this assessment. Compare actual field names and values on both sides. Compatible Devices=Printer cannot contradict a specific HP or Epson model. A neutral product description in an identifier field is not marketing."

export const LISTING_RULE_CHECK_PROMPT = `
For scoreVersion=cdq-2026-09-16 apply the supplied CDQ rules and the following per-criterion caps, indexed from zero. Each deduction has ruleId, positive points, reason and evidence (field and actual value, or labeled image and observation). Deduct once per checkpoint and evidence item. Never move a rule to another criterion.
${JSON.stringify(LISTING_RULES)}
${LISTING_ATTRIBUTE_RULE_PROMPT}
Only keyword.titleLength (10 for a title over 75 characters) and alexa.stuffing (3–5) may reduce the respective dimension score below its criterion sum. Record each in dimension.deductions. Floor at zero. COSMO has no additional dimension deduction. CDQ is normalized over available evidence. A prohibited title loses precisely the title criterion's 25 points. bullet.count scores the count only.
Main image: white RGB(255,255,255), no watermark/text/border, at least 85% occupancy. Included components are allowed. Zoom uses only the original longest edge. Secondary count points=3*min(N,6)/6, excluding main and A+ images. Five secondary images lose 0.5. Unknown count is not zero. Each missing coverage type costs exactly 0.75 with a distinct checkId: scene, detail, dimensions or package. A+ is scored independently.
For alexa.description, assess specifications and overview_scenes separately, deducting 1 per missing checkId up to 2 out of 3. No additional deductions for formatting. For unavailable backend keywords, use description="Search terms unavailable", score=4, status="UNAVAILABLE", deductions=[].
`
