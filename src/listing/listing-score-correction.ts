import { withListingOutputLanguage } from "./listing.prompts"
import { uiText, withUiLanguage } from "../common/i18n/request-language"
import { englishScoreReference } from "./listing-score-reference"
import { BadGatewayException } from "@nestjs/common"
import { parseListingJsonObject } from "./listing-result-parser"
import { validateScoreCore, validateScoreReport } from "./listing-score-recovery"
import { validateListingScoreOutput } from "./listing-score-validation"

import { isCdqScoreReport } from "./listing-cdq-score"
import { CDQ_CRITERION_NAMES_EN, CDQ_DIMENSION_NAME_PATTERNS } from "./listing-cdq-labels"
import { formatListingScorePotential } from "./listing-cdq-summary"
import { normalizeCdqImageCriterion } from "./listing-cdq-image-score"
import { getListingEvidenceRequirement, projectListingCriterionEvidence } from "./listing-score-evidence"
import { buildListingEvidencePrompt, lockListingLongtailTerms } from "./listing-score-evidence-flow"
import { getListingCriterionRuleError, getListingCriterionRules, getListingCriterionCheckIds, getListingDimensionRuleError, getListingDimensionRules, LISTING_RULE_CHECK_PROMPT, validateListingReportRules, type ListingRuleContext } from "./listing-score-rules"

interface ScoreDeduction {
  points: number
  reason: string
  ruleId?: string
  evidence?: string
  checkId?: string
}

/** 仅采用显式checkId，兼容模型把标签写进evidence；固定分值依已有规则计算。 */
function normalizeCorrectionDeductions(deductions: ScoreDeduction[]): ScoreDeduction[] {
  return deductions.flatMap(deduction => {
    // 非法或非正扣分交由原校验拒绝，不能因存在检查点标签擅自转成正扣分。
    if (!deduction || typeof deduction.points !== "number" || !Number.isFinite(deduction.points) || deduction.points <= 0)
      return [deduction]
    const allowed = deduction.ruleId === "image.coverage"
      ? { ids: ["scene", "detail", "dimensions", "package"], points: 0.75 }
      : deduction.ruleId === "alexa.description"
        ? { ids: ["specifications", "overview_scenes"], points: 1 } : null
    if (!allowed) return [deduction]
    const ids = deduction.checkId ? [deduction.checkId]
      : typeof deduction.evidence === "string"
        ? [...deduction.evidence.matchAll(/\bcheckId["']?\s*[:=]\s*["']?([a-z_]+)/g)].map(match => match[1]) : []
    if (!ids.length || ids.some(id => !allowed.ids.includes(id)) || new Set(ids).size !== ids.length)
      return [deduction]
    return ids.map(checkId => ({ ...deduction, checkId, points: allowed.points }))
  })
}

interface ScoreCriterion {
  assessment?: Record<string, unknown>
  name: string
  maxScore: number
  score: number
  description?: string
  deductions?: ScoreDeduction[]
}

interface ScoreDimension {
  name: string
  maxScore: number
  score: number
  criteria: ScoreCriterion[]
  deductions?: ScoreDeduction[]
}

export interface ScoreCorrectionReport extends Record<string, unknown> {
  mode?: string
  total: number
  dimensions: ScoreDimension[]
  suggestions: string[]
  potential: string
  severeDefects?: unknown[]
}

interface CriterionCorrection {
  assessment?: Record<string, unknown>
  dimensionIndex: number
  criterionIndex: number
  score: number | null
  status?: string
  description: string
  deductions: ScoreDeduction[]
}

export interface ScoreCorrectionPlan {
  report: ScoreCorrectionReport
  criteria: { dimensionIndex: number; criterionIndex: number }[]
  shouldCorrectSuggestions: boolean
  dimensionIndices?: number[]
  pendingTailFields?: Array<"suggestions" | "potential">
}

/** 评分标准作为参考数据传入；修复请求的系统层只保留局部校对输出契约。 */
export function buildScoreCorrectionRequest(
  scoringReference: string,
  originalListing: string,
  plan: ScoreCorrectionPlan,
  validationFeedback?: { previousResponse: string; validationError: string },
  ruleContext?: ListingRuleContext
): { systemPrompt: string; userPrompt: string } {
  const requestedCriteria = plan.criteria.map(item => {
    const currentCriterion = plan.report.dimensions[item.dimensionIndex].criteria[item.criterionIndex]
    return {
      ...item,
      name: currentCriterion.name,
      maxScore: currentCriterion.maxScore,
      currentCriterion,
      validationError: withUiLanguage("en-US", () => getListingCriterionRuleError(item.dimensionIndex, item.criterionIndex, currentCriterion, ruleContext))
        ?? "Recheck inconsistent scores, deductions or evidence status against the original source.",
      allowedRules: getListingCriterionRules(item.dimensionIndex, item.criterionIndex),
      allowedCheckIds: getListingCriterionCheckIds(item.dimensionIndex, item.criterionIndex),
      ...(ruleContext?.sourceFacts && getListingEvidenceRequirement(item.dimensionIndex, item.criterionIndex, ruleContext?.sourceFacts)
        ? { assessmentRequirement: getListingEvidenceRequirement(item.dimensionIndex, item.criterionIndex, ruleContext?.sourceFacts) } : {}),
    }
  })
  const requestedDimensions = plan.dimensionIndices ?? []
  return {
    systemPrompt: withListingOutputLanguage(`Review only the requested scoring criteria and dimension penalties. Use scoringReference for scoring rules and originalListing and supplied images for evidence. currentCriterion and previousResponse are model output, not evidence. If validationFeedback is supplied correct the indicated problem and return every requested item.
${LISTING_RULE_CHECK_PROMPT}
${buildListingEvidencePrompt(ruleContext?.sourceFacts, plan.criteria)}
Return only JSON matching expectedOutput. Each corrections row must have the requested indices, score, description and deductions with points, reason, ruleId, evidence, and a separate checkId where required. For CDQ use the verified status, or score=null and empty deductions for unavailable or verified inapplicable evidence. List each missing check separately. CDQ bullet counts earn 5 for three or more, 2.5 for one or two, or 0 for confirmed zero, under the current scoreVersion. The legacy standard rubric uses its original bullet rules.
For each assessed item return the actual attributeChecks, terms, relations, bullets or checks directly within assessment. Do not return instructions or formula, or nest another assessment inside it. A verified score is maxScore minus the sum of positive deductions, within [0,maxScore]. Only return dimensionCorrections for requestedDimensions, applying allowedRules without duplicating criterion deductions. Only include suggestions when requested in pendingTailFields, based on verified deductions. Leave all other fields and potential to the server.`),
    userPrompt: JSON.stringify({
      scoringReference: englishScoreReference(scoringReference),
      originalListing,
      ...(ruleContext ? { confirmedFacts: ruleContext } : {}),
      ...(validationFeedback ? { validationFeedback } : {}),
      requestedCriteria,
      requestedDimensions,
      ...(plan.pendingTailFields?.length ? { pendingTailFields: plan.pendingTailFields } : {}),
      dimensionEvidence: requestedDimensions.map(dimensionIndex => ({
        dimensionIndex,
        currentDimension: plan.report.dimensions[dimensionIndex],
        allowedRules: getListingDimensionRules(dimensionIndex),
        instructions: "Verify only dimension penalties in allowedRules. Exclude deductions already counted in criteria. Use [] if no allowed and evidenced penalty applies.",
        validationError: withUiLanguage("en-US", () => getListingDimensionRuleError(dimensionIndex, plan.report.dimensions[dimensionIndex])),
      })),
      expectedOutput: {
        ...(plan.pendingTailFields?.includes("suggestions")
          ? { suggestions: "string[]: suggest actions only for verified deductions; do not add facts" } : {}),
        corrections: requestedCriteria.map(item => ({
          dimensionIndex: item.dimensionIndex,
          criterionIndex: item.criterionIndex,
          score: "number, or null for unavailable or inapplicable CDQ evidence",
          ...(isCdqScoreReport(plan.report) && item.dimensionIndex === 0
            ? { status: "VERIFIED | MISSING | UNAVAILABLE | NOT_APPLICABLE" } : {}),
          description: "string: source evidence and finding",
          ...(ruleContext?.sourceFacts && getListingEvidenceRequirement(item.dimensionIndex, item.criterionIndex, ruleContext?.sourceFacts)
            ? { assessment: getListingEvidenceRequirement(item.dimensionIndex, item.criterionIndex, ruleContext?.sourceFacts)?.assessment } : {}),
          deductions: "array: [] when there are no deductions; otherwise include points, reason, ruleId, evidence and any required checkId",
        })),
        ...(requestedDimensions.length ? {
          dimensionCorrections: requestedDimensions.map(dimensionIndex => ({
            dimensionIndex,
            allowedRules: getListingDimensionRules(dimensionIndex),
            deductions: "array: additional dimension penalties under allowedRules only; [] when unsupported or inapplicable",
          })),
        } : {}),
      },
    }),
  }
}

// 仅识别数量配额类说法；字数、权重、具体条目编号不属于条数限制。
const BULLET_COUNT_RULE =
  /(?:bullets?|商品要点|五点)[^。\n]{0,90}(?:(?:超过|少于|多于|至多|至少|恰好|精简|缩减|限制|限定|控制|保留|减少|增加|补足|补齐|调整|建议)[^。\n]{0,30}(?:\d+|[一二三四五六七八九十]+)\s*条|(?:\d+|[一二三四五六七八九十]+)\s*条[^。\n]{0,12}(?:上限|下限|以内|以上|过多|过少))|(?:limit|reduce|trim|exactly|maximum|minimum|at most|at least)[^.!?\n]{0,35}(?:\d+|five|six|seven)\s*(?:bullets?|bullet points)/i

function hasCountRule(value: unknown): boolean {
  return typeof value === "string" && BULLET_COUNT_RULE.test(value)
}

export const CDQ_DIMENSION_METADATA = [
  { name: "CDQ完整性", namePattern: CDQ_DIMENSION_NAME_PATTERNS[0], maxScore: 40, criteria: [
    ["结构化属性", 30], ["标题质量", 25], ["变体质量", 20], ["图片质量", 15], ["A+ 内容", 5], ["五点描述", 5],
  ] },
  { name: "关键词覆盖", namePattern: CDQ_DIMENSION_NAME_PATTERNS[1], maxScore: 25, criteria: [
    ["核心关键词进入标题前75字符", 7], ["S/A级关键词覆盖标题和Bullet", 7], ["B/C级长尾词覆盖", 5],
    ["后台搜索词写满且与标题不重复", 4], ["关键词真实可承接", 2],
  ] },
  { name: "COSMO关系覆盖", namePattern: CDQ_DIMENSION_NAME_PATTERNS[2], maxScore: 20, criteria: [
    ["通用高优先级4类全部覆盖", 10], ["品类驱动关系已覆盖", 6], ["中优先级关系覆盖至少3类", 4],
  ] },
  { name: "Alexa语义质量", namePattern: CDQ_DIMENSION_NAME_PATTERNS[3], maxScore: 15, criteria: [
    ["标题语义连贯性", 7], ["每条Bullet包含可验证数据点", 5], ["描述包含具体使用场景与结构化规格", 3],
  ] },
] as const

/** 仅恢复已知版本、完整索引的固定元数据；得分、状态和事实仍须逐项校对。 */
function normalizeCdqCorrectionMetadata(report: ScoreCorrectionReport): boolean {
  if (!isCdqScoreReport(report) || !Array.isArray(report.dimensions) ||
    report.dimensions.length !== CDQ_DIMENSION_METADATA.length ||
    report.dimensions.some((dimension, index) => !dimension || typeof dimension !== "object" ||
      !Array.isArray(dimension.criteria) || dimension.criteria.length !== CDQ_DIMENSION_METADATA[index].criteria.length))
    return false
  let hasChanges = false
  report.dimensions.forEach((dimension, index) => {
    const metadata = CDQ_DIMENSION_METADATA[index]
    const dimensionRecord = dimension as unknown as Record<string, unknown>
    if (typeof dimension.name !== "string" || !metadata.namePattern.test(dimension.name)) {
      dimension.name = metadata.name
      hasChanges = true
    }
    for (const field of ["maxScore", "weight"]) {
      if (dimensionRecord[field] !== metadata.maxScore) {
        dimensionRecord[field] = metadata.maxScore
        hasChanges = true
      }
    }
    dimension.criteria.forEach((criterion, criterionIndex) => {
      if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
        criterion = {} as ScoreCriterion
        dimension.criteria[criterionIndex] = criterion
        hasChanges = true
      }
      const [name, maxScore] = metadata.criteria[criterionIndex]
      if (typeof criterion.name !== "string" || !criterion.name.trim()) {
        criterion.name = name
        hasChanges = true
      }
      if (criterion.maxScore !== maxScore) {
        criterion.maxScore = maxScore
        hasChanges = true
      }
    })
  })
  return hasChanges
}

export function buildScoreCorrectionPlan(
  text: string,
  market?: string,
  shouldValidateRules = false,
  ruleContext?: ListingRuleContext
): ScoreCorrectionPlan | null {
  let report: ScoreCorrectionReport
  try {
    report = parseListingJsonObject(text) as ScoreCorrectionReport
  } catch {
    return null
  }
  // 新版允许五点按条数评分、未获取项留空，不应用旧版条数纠错或整维减半。
  const isCdq = isCdqScoreReport(report)
  const hasMetadataChanges = normalizeCdqCorrectionMetadata(report)
  if (!Array.isArray(report.dimensions)) return null
  const isStandardAmazon =
    !isCdq && report.mode === "standard" &&
    (market?.startsWith("amazon_") || /CDQ/i.test(report.dimensions[0]?.name ?? ""))
  const criteria: ScoreCorrectionPlan["criteria"] = []
  const shape = structuredClone(report)
  report.dimensions.forEach((dimension, dimensionIndex) => {
    if (!Array.isArray(dimension?.criteria)) return
    dimension.criteria.forEach((criterion, criterionIndex) => {
      if (
        !criterion ||
        typeof criterion.name !== "string" ||
        !Number.isFinite(criterion.maxScore)
      )
        return
      let shouldCorrect =
        isStandardAmazon &&
        (hasCountRule(criterion.description) ||
          (Array.isArray(criterion.deductions) &&
            criterion.deductions.some(item => hasCountRule(item?.reason))))
      try {
        if (isCdq && (typeof criterion.description !== "string" || !criterion.description.trim() ||
          !Array.isArray(criterion.deductions) ||
          (criterion.score !== null && (typeof criterion.score !== "number" || !Number.isFinite(criterion.score) ||
            criterion.score < 0 || criterion.score > criterion.maxScore))))
          throw new Error("评分事实字段尚未完整核验")
        if (isCdq && dimensionIndex === 0) {
          const status = (criterion as unknown as { status?: string }).status
          if (!["VERIFIED", "MISSING", "UNAVAILABLE", "NOT_APPLICABLE"].includes(status ?? "") ||
            (["UNAVAILABLE", "NOT_APPLICABLE"].includes(status ?? "") && criterion.score !== null))
            throw new Error(uiText("取证状态与得分不一致", "Evidence status is inconsistent with the score"))
        }
        if (isCdq && criterion.score === null) {
          const status = (criterion as unknown as { status?: string }).status
          if (dimensionIndex !== 0 || !["UNAVAILABLE", "NOT_APPLICABLE"].includes(status ?? "") ||
            (status === "NOT_APPLICABLE" && ![2, 4].includes(criterionIndex)) || criterion.deductions?.length)
            throw new Error("未获取项的取证状态不正确")
        } else validateListingScoreOutput(
          JSON.stringify({ total: criterion.score, dimensions: [{ criteria: [criterion] }] })
        )
        if (isCdq && dimensionIndex === 0 && criterionIndex === 3 && criterion.score !== null) {
          const normalizedCriterion = structuredClone(criterion)
          normalizeCdqImageCriterion(normalizedCriterion as unknown as Record<string, unknown>)
          if (shouldValidateRules && getListingCriterionRuleError(dimensionIndex, criterionIndex, normalizedCriterion, ruleContext))
            throw new Error("图片说明与已确认的图片证据不一致")
        }
        if (isCdq && shouldValidateRules && getListingCriterionRuleError(dimensionIndex, criterionIndex, criterion, ruleContext))
          throw new Error("扣分不符合规则")
      } catch {
        shouldCorrect = true
      }
      if (shouldCorrect) {
        criteria.push({ dimensionIndex, criterionIndex })
        // 仅用于验证其他字段与完整结构；此占位值绝不作为结果返回。
        shape.dimensions[dimensionIndex].criteria[criterionIndex] = {
          ...criterion,
          score: criterion.maxScore,
          description: "仅用于结构验证的占位，必须完成原始资料校对后才能输出",
          ...(isCdq && dimensionIndex === 0 ? { status: "VERIFIED" } : {}),
          deductions: [],
        }
      }
    })
  })
  const shouldCorrectSuggestions =
    !!isStandardAmazon && Array.isArray(report.suggestions) && report.suggestions.some(hasCountRule)
  const dimensionIndices = isCdq && shouldValidateRules ? report.dimensions.flatMap((dimension, index) => {
    if (index === 0 || (typeof dimension.score === "number" && Number.isFinite(dimension.score) &&
      dimension.score >= 0 && dimension.score <= dimension.maxScore &&
      dimension.criteria.every(criterion => typeof criterion.score === "number" && Number.isFinite(criterion.score)) &&
      !getListingDimensionRuleError(index, dimension))) return []
    shape.dimensions[index].score = Math.round(Math.min(dimension.maxScore, shape.dimensions[index].criteria.reduce((sum, criterion) => sum + Number(criterion.score), 0)) * 10000) / 10000
    return [index]
  }) : []
  const pendingTailFields: Array<"suggestions" | "potential"> = []
  if (isCdq) {
    if (!Array.isArray(report.suggestions) || report.suggestions.some(value => typeof value !== "string"))
      pendingTailFields.push("suggestions")
    if (typeof report.potential !== "string" || !report.potential.trim()) pendingTailFields.push("potential")
  }
  if (!criteria.length && !shouldCorrectSuggestions && !dimensionIndices.length && !hasMetadataChanges && !pendingTailFields.length) return null
  validateScoreCore(shape, market)
  if (!isCdq && (!Array.isArray(report.suggestions) || typeof report.potential !== "string")) return null
  return { report, criteria, shouldCorrectSuggestions, ...(dimensionIndices.length ? { dimensionIndices } : {}),
    ...(pendingTailFields.length ? { pendingTailFields } : {}) }
}

const isCorrectionRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const CORRECTION_FIELDS = ["dimensionIndex", "criterionIndex", "score", "status", "description", "deductions", "assessment"]

/** 单项校验与严格合并共用；不会借用其他项目的占位分数来通过验证。 */
function validateCriterionCorrection(
  input: CriterionCorrection,
  plan: ScoreCorrectionPlan,
  shouldValidateRules: boolean,
  ruleContext?: ListingRuleContext
): CriterionCorrection {
  const fail = (reason = "Invalid correction items or scores"): never => { throw new Error(reason) }
  if (!isCorrectionRecord(input) || Object.keys(input).some(key => !CORRECTION_FIELDS.includes(key)) ||
    !plan.criteria.some(item => item.dimensionIndex === input.dimensionIndex && item.criterionIndex === input.criterionIndex))
    return fail()
  const correction = structuredClone(input)
  const isCdq = isCdqScoreReport(plan.report)
  if (isCdq && correction.dimensionIndex === 0 && correction.status === undefined) {
    const existing = plan.report.dimensions[correction.dimensionIndex].criteria[correction.criterionIndex] as unknown as { status?: string }
    if (existing.status !== undefined) correction.status = existing.status
  }
  if (shouldValidateRules && isCdq && ruleContext?.sourceFacts) {
    if (correction.dimensionIndex === 1 && correction.criterionIndex === 2)
      lockListingLongtailTerms(correction, ruleContext.sourceFacts)
    const projected = projectListingCriterionEvidence(correction.dimensionIndex, correction.criterionIndex, correction, ruleContext.sourceFacts)
    if (projected) Object.assign(correction, projected)
  }
  const { dimensionIndex, criterionIndex, score, description, deductions } = correction
  const maxScore = plan.report.dimensions[dimensionIndex].criteria[criterionIndex].maxScore
  if (typeof description !== "string" || !description.trim() || !Array.isArray(deductions)) return fail()
  if (correction.status !== undefined && (!isCdq ||
    !["VERIFIED", "MISSING", "UNAVAILABLE", "NOT_APPLICABLE"].includes(correction.status))) return fail()
  if (isCdq && dimensionIndex === 0 &&
    !["VERIFIED", "MISSING", "UNAVAILABLE", "NOT_APPLICABLE"].includes(correction.status ?? ""))
    return fail("Evidence status is missing or invalid")
  if (score === null
    ? !isCdq || dimensionIndex !== 0 || !["UNAVAILABLE", "NOT_APPLICABLE"].includes(correction.status ?? "") ||
      deductions.length > 0 || (correction.status === "NOT_APPLICABLE" && ![2, 4].includes(criterionIndex))
    : !Number.isFinite(score) || score < 0 || score > maxScore) return fail()
  if (isCdq && dimensionIndex === 0 &&
    ["UNAVAILABLE", "NOT_APPLICABLE"].includes(correction.status ?? "") && score !== null) return fail("Evidence status is inconsistent with the score")
  let correctedDeductions = shouldValidateRules ? normalizeCorrectionDeductions(deductions) : deductions
  let correctedScore = score
  if (shouldValidateRules && isCdq && score !== null) {
    const computedScore = correctedDeductions.length
      ? Math.round((maxScore - correctedDeductions.reduce((sum, deduction) => sum + Number(deduction?.points), 0)) * 10000) / 10000
      : score
    const candidate = { score: computedScore, description, deductions: correctedDeductions,
      ...(correction.assessment ? { assessment: correction.assessment } : {}) }
    if (dimensionIndex === 0 && criterionIndex === 3) normalizeCdqImageCriterion(candidate)
    const ruleError = withUiLanguage("en-US", () => getListingCriterionRuleError(dimensionIndex, criterionIndex, candidate, ruleContext))
    if (candidate.score < 0 || ruleError) return fail(ruleError ?? "Deductions exceed the maximum score")
    correctedScore = candidate.score
    correctedDeductions = candidate.deductions
  }
  if (correctedScore !== null) withUiLanguage("en-US", () => validateListingScoreOutput(JSON.stringify({
    total: correctedScore, dimensions: [{ criteria: [{ maxScore, score: correctedScore, deductions: correctedDeductions }] }],
  })))
  if (shouldValidateRules && isCdq) {
    const ruleError = withUiLanguage("en-US", () => getListingCriterionRuleError(dimensionIndex, criterionIndex,
      { ...correction, score: correctedScore, deductions: correctedDeductions }, ruleContext))
    if (ruleError) return fail(ruleError)
  }
  return { ...correction, score: correctedScore, deductions: correctedDeductions }
}

export interface ScoreCorrectionProgress {
  plan: ScoreCorrectionPlan
  acceptedCriteria: ScoreCorrectionPlan["criteria"]
  acceptedDimensions: number[]
  hasAcceptedSuggestions: boolean
  validationErrors: string[]
}

function getCorrectionIndex(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const index = Number(value)
    if (Number.isSafeInteger(index)) return index
  }
  return undefined
}

function normalizeCorrectionName(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  return value.normalize("NFKC").trim().replace(/\s*\(\d+(?:\.\d+)?(?:分)?\)\s*$/, "")
    .replace(/[\s\p{P}]/gu, "").toLowerCase()
}

/** 完整报告仅按唯一名称提取已请求项目，数组位置与报告总分均不作为依据。 */
function extractNamedReportCorrections(patch: Record<string, unknown>, plan: ScoreCorrectionPlan): Record<string, unknown> {
  if (!isCdqScoreReport(patch) || !Array.isArray(patch.dimensions) || patch.dimensions.length !== CDQ_DIMENSION_METADATA.length)
    return patch
  const dimensions = new Map<number, Record<string, unknown>>()
  for (const value of patch.dimensions) {
    if (!isCorrectionRecord(value) || typeof value.name !== "string" || !Array.isArray(value.criteria)) return patch
    const matches = CDQ_DIMENSION_METADATA.flatMap((metadata, index) => metadata.namePattern.test(value.name as string) ? [index] : [])
    if (matches.length !== 1 || dimensions.has(matches[0])) return patch
    dimensions.set(matches[0], value)
  }
  const corrections = plan.criteria.flatMap(target => {
    const dimension = dimensions.get(target.dimensionIndex)!
    const original = plan.report.dimensions[target.dimensionIndex]?.criteria[target.criterionIndex]
    const canonicalName = CDQ_DIMENSION_METADATA[target.dimensionIndex]?.criteria[target.criterionIndex]?.[0]
    const names = [original?.name, canonicalName, CDQ_CRITERION_NAMES_EN[target.dimensionIndex]?.[target.criterionIndex]]
      .map(normalizeCorrectionName)
      .filter((name): name is string => !!name)
    const matches = (dimension.criteria as unknown[]).filter(isCorrectionRecord)
      .filter(criterion => names.includes(normalizeCorrectionName(criterion.name) ?? ""))
    if (matches.length !== 1) return []
    const fields = Object.fromEntries(CORRECTION_FIELDS.filter(field => Object.hasOwn(matches[0], field))
      .map(field => [field, matches[0][field]]))
    return [{ ...fields, ...target }]
  })
  return {
    corrections,
    ...(plan.dimensionIndices?.length ? { dimensionCorrections: plan.dimensionIndices.map(dimensionIndex => ({
      dimensionIndex, deductions: dimensions.get(dimensionIndex)?.deductions,
    })) } : {}),
    ...(plan.pendingTailFields?.includes("suggestions") ? { suggestions: patch.suggestions } : {}),
  }
}

/** 仅提取约定的修复外壳；单项请求可绑定无索引的单项对象，显式错误索引不能被覆盖。 */
function parseCorrectionProgress(text: string, plan: ScoreCorrectionPlan): Record<string, unknown> {
  const plainText = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  let patch = parseListingJsonObject(plainText.startsWith("[") ? '{"corrections":' + plainText + '}' : plainText)
  for (let depth = 0; depth < 2; depth++) {
    if (Object.hasOwn(patch, "corrections") || Object.hasOwn(patch, "dimensionCorrections")) break
    const wrapped = [patch.data, patch.result].find(isCorrectionRecord)
    if (!wrapped) break
    patch = wrapped
  }
  if (!Object.hasOwn(patch, "corrections") && Object.hasOwn(patch, "dimensions"))
    patch = extractNamedReportCorrections(patch, plan)
  if (!Object.hasOwn(patch, "corrections") && !Object.hasOwn(patch, "dimensions") &&
    plan.criteria.length === 1 && (Object.hasOwn(patch, "score") || Object.hasOwn(patch, "assessment"))) {
    const target = plan.criteria[0]
    patch = { corrections: [{ ...patch,
      ...(!Object.hasOwn(patch, "dimensionIndex") ? { dimensionIndex: target.dimensionIndex } : {}),
      ...(!Object.hasOwn(patch, "criterionIndex") ? { criterionIndex: target.criterionIndex } : {}),
    }] }
  }
  return patch
}

/** 反馈使用投影器相同的原始索引口径，统计行不要求模型补写。 */
function getIncompleteAttributeFeedback(criterion: CriterionCorrection, context: ListingRuleContext): string | undefined {
  if (criterion.dimensionIndex !== 0 || criterion.criterionIndex !== 0 || !context.sourceFacts?.structuredAttributes?.length)
    return undefined
  if (projectListingCriterionEvidence(0, 0, criterion, context.sourceFacts)) return undefined
  const statistics = /^(?:asin|bsr|best sellers? rank|customer reviews?|reviews?|review count|ratings?|rating count|评论数|商品评分|客户评价|评分)$/i
  const expected = context.sourceFacts.structuredAttributes.flatMap((attribute, index) =>
    attribute.name.trim() && !statistics.test(attribute.name.normalize("NFKC").replace(/\s+/g, " ").trim()) ? [index + 1] : [])
  if (!expected.length) return undefined
  const checks = isCorrectionRecord(criterion.assessment) && Array.isArray(criterion.assessment.attributeChecks)
    ? criterion.assessment.attributeChecks : []
  const indices = checks.filter(isCorrectionRecord).map(check => getCorrectionIndex(check.index))
  const missing = expected.filter(index => !indices.includes(index))
  const duplicate = [...new Set(indices.filter((index, offset) => index !== undefined && indices.indexOf(index) !== offset))]
  const unexpected = [...new Set(indices.filter(index => index !== undefined && !expected.includes(index)))]
  return [
    `Return all ${expected.length} attributeChecks at indices [${expected.join(",")}].`,
    missing.length && `Missing indices: ${missing.join(", ")}.`,
    duplicate.length && `Duplicate indices: ${duplicate.join(", ")}.`,
    unexpected.length && `Non-attribute or out-of-range indices: ${unexpected.join(", ")}.`,
    "Include index, weight (1/2/3), errorType, comparison and suggestion for every attribute, including correct and pending items. Recalculate the score.",
  ].filter(Boolean).join(" ")
}

/** 只去掉与已核验子项完全相同的跨层重复；原始响应及子项扣分始终保留。 */
function removeRepeatedCriterionDeductions(
  deductions: unknown[],
  dimensionIndex: number,
  plan: ScoreCorrectionPlan,
  context?: ListingRuleContext
): unknown[] {
  const verifiedDeductions = plan.report.dimensions[dimensionIndex].criteria.flatMap((criterion, criterionIndex) => {
    if (plan.criteria.some(item => item.dimensionIndex === dimensionIndex && item.criterionIndex === criterionIndex)) return []
    if (typeof criterion.score !== "number" || !Number.isFinite(criterion.score) || criterion.score < 0 || criterion.score > criterion.maxScore)
      return []
    try {
      validateListingScoreOutput(JSON.stringify({ total: criterion.score, dimensions: [{ criteria: [criterion] }] }))
      if (getListingCriterionRuleError(dimensionIndex, criterionIndex, criterion, context)) return []
    } catch { return [] }
    return criterion.deductions ?? []
  })
  return deductions.filter(deduction => !isCorrectionRecord(deduction) || !verifiedDeductions.some(verified =>
    typeof deduction.ruleId === "string" && deduction.ruleId === verified.ruleId &&
    typeof deduction.points === "number" && deduction.points === verified.points &&
    typeof deduction.evidence === "string" && typeof verified.evidence === "string" &&
    deduction.evidence.trim() === verified.evidence.trim()))
}

/** 接收通过核验的项目并保留进度；遗漏或失败项目继续待核验，绝不填入默认得分。 */
export function acceptScoreCorrectionProgress(
  text: string,
  originalPlan: ScoreCorrectionPlan,
  market?: string,
  ruleContext?: ListingRuleContext
): ScoreCorrectionProgress {
  const plan = structuredClone(originalPlan)
  const progress: ScoreCorrectionProgress = {
    plan, acceptedCriteria: [], acceptedDimensions: [], hasAcceptedSuggestions: false, validationErrors: [],
  }
  let patch: Record<string, unknown>
  try { patch = withUiLanguage("en-US", () => parseCorrectionProgress(text, plan)) }
  catch (error) {
    progress.validationErrors.push(error instanceof Error ? error.message : "The correction is not a complete JSON object")
    return progress
  }
  const corrections = Array.isArray(patch.corrections) ? patch.corrections.filter(isCorrectionRecord) : []
  for (const target of originalPlan.criteria) {
    const key = target.dimensionIndex + ":" + target.criterionIndex
    const matches = corrections.filter(item => getCorrectionIndex(item.dimensionIndex) === target.dimensionIndex &&
      getCorrectionIndex(item.criterionIndex) === target.criterionIndex)
    if (matches.length !== 1) {
      progress.validationErrors.push(key + (matches.length
        ? ": return exactly one assessment for this criterion"
        : ": supply the missing assessment using the original evidence"))
      continue
    }
    const candidate = Object.fromEntries(CORRECTION_FIELDS.filter(field => Object.hasOwn(matches[0], field))
      .map(field => [field, matches[0][field]])) as unknown as CriterionCorrection
    Object.assign(candidate, target)
    // 未通过的候选词不能锁定后续请求；只提交通过校验后的取证状态。
    const candidateContext = ruleContext ? structuredClone(ruleContext) : undefined
    try {
      const attributeError = candidateContext ? getIncompleteAttributeFeedback(candidate, candidateContext) : undefined
      if (attributeError) throw new Error(attributeError)
      const corrected = validateCriterionCorrection(candidate, plan, true, candidateContext)
      const { dimensionIndex, criterionIndex, ...fields } = corrected
      const dimension = plan.report.dimensions[dimensionIndex]
      const oldSum = dimension.criteria.reduce((sum, item) => sum + Number(item.score), 0)
      const extra = Math.max(0, oldSum - Number(dimension.score))
      Object.assign(dimension.criteria[criterionIndex], fields)
      if (dimensionIndex !== 0 || !isCdqScoreReport(plan.report)) {
        const newSum = dimension.criteria.reduce((sum, item) => sum + Number(item.score), 0)
        if (isCdqScoreReport(plan.report)) {
          if (!plan.dimensionIndices?.includes(dimensionIndex) && Number.isFinite(newSum))
            dimension.score = Math.max(0, Math.round((newSum - (dimension.deductions ?? []).reduce((sum, item) => sum + item.points, 0)) * 10000) / 10000)
        } else if (Number.isFinite(newSum) && Number.isFinite(extra)) {
          const hasHalfPenalty = /CDQ/i.test(dimension.name) && oldSum > 0 && dimension.score === Math.floor(oldSum / 2)
          dimension.score = Math.round(Math.max(0, Math.min(dimension.maxScore, hasHalfPenalty ? Math.floor(newSum / 2) : newSum - extra)) * 10000) / 10000
        }
      }
      if (ruleContext?.sourceFacts && candidateContext?.sourceFacts?.longtailTerms && !ruleContext.sourceFacts.longtailTerms)
        ruleContext.sourceFacts.longtailTerms = candidateContext.sourceFacts.longtailTerms
      plan.criteria = plan.criteria.filter(item => item.dimensionIndex !== dimensionIndex || item.criterionIndex !== criterionIndex)
      progress.acceptedCriteria.push(target)
    } catch (error) {
      progress.validationErrors.push(key + ": " + (error instanceof Error ? error.message : "Source verification failed"))
    }
  }
  const dimensionCorrections = Array.isArray(patch.dimensionCorrections) ? patch.dimensionCorrections.filter(isCorrectionRecord) : []
  for (const dimensionIndex of originalPlan.dimensionIndices ?? []) {
    const matches = dimensionCorrections.filter(item => getCorrectionIndex(item.dimensionIndex) === dimensionIndex)
    if (matches.length !== 1 || !Array.isArray(matches[0].deductions)) {
      progress.validationErrors.push("Dimension " + dimensionIndex + (matches.length > 1
        ? ": duplicate response" : ": provide a valid list of dimension deductions"))
      continue
    }
    // 只检查既有维度规则和证据，不依赖尚未补齐的小项得分。
    const deductions = removeRepeatedCriterionDeductions(matches[0].deductions, dimensionIndex, plan, ruleContext)
    const ruleError = withUiLanguage("en-US", () => getListingDimensionRuleError(dimensionIndex, { score: 0, criteria: [], deductions }))
    if (ruleError) { progress.validationErrors.push(`Dimension ${dimensionIndex}: ` + ruleError); continue }
    const dimension = plan.report.dimensions[dimensionIndex]
    dimension.deductions = structuredClone(deductions) as ScoreDeduction[]
    const sum = dimension.criteria.reduce((value, criterion) => value + Number(criterion.score), 0)
    if (Number.isFinite(sum)) dimension.score = Math.max(0, Math.round((sum - dimension.deductions.reduce((value, item) => value + item.points, 0)) * 10000) / 10000)
    plan.dimensionIndices = plan.dimensionIndices?.filter(index => index !== dimensionIndex)
    progress.acceptedDimensions.push(dimensionIndex)
  }
  if (originalPlan.pendingTailFields?.includes("suggestions")) {
    if (Array.isArray(patch.suggestions) && patch.suggestions.every(value => typeof value === "string")) {
      plan.report.suggestions = [...patch.suggestions]
      plan.pendingTailFields = plan.pendingTailFields?.filter(field => field !== "suggestions")
      progress.hasAcceptedSuggestions = true
    } else progress.validationErrors.push("suggestions: supply the missing suggestions")
  }
  return progress
}

/** 只合并指定异常项；已有合规评分、图片证据和维度级惩罚由服务端保留。 */
export function mergeScoreCorrection(
  text: string,
  plan: ScoreCorrectionPlan,
  market?: string,
  shouldValidateRules = false,
  ruleContext?: ListingRuleContext
): string {
  const patch = withUiLanguage("en-US", () => parseListingJsonObject(text)) as {
    corrections: CriterionCorrection[]
    suggestions?: string[]
    dimensionCorrections?: Array<{ dimensionIndex: number; deductions: ScoreDeduction[] }>
  }
  const fail = (reason = "Invalid correction items or scores", displayReason = reason): never => {
    throw new BadGatewayException(
      uiText(`评分校对失败：${displayReason}，原始结果已保存，本次未扣费`, `Score correction failed: ${reason}. The original result was saved without a charge.`),
      { cause: new Error(reason) },
    )
  }
  if (
    Object.keys(patch).some(key => key !== "corrections" && !(plan.dimensionIndices?.length && key === "dimensionCorrections") &&
      !(plan.pendingTailFields?.includes("suggestions") && key === "suggestions")) ||
    !Array.isArray(patch.corrections) ||
    patch.corrections.length !== plan.criteria.length
  )
    return fail("The response does not match the requested correction items", "返回格式与指定校对项不一致")
  const result = structuredClone(plan.report)
  if (plan.pendingTailFields?.includes("suggestions")) {
    if (!Array.isArray(patch.suggestions) || patch.suggestions.some(value => typeof value !== "string"))
      return fail("Missing suggestions were not supplied", "缺失建议尚未补齐")
    result.suggestions = patch.suggestions
  }
  const dimensionCorrections = patch.dimensionCorrections ?? []
  if (!Array.isArray(dimensionCorrections) || dimensionCorrections.length !== (plan.dimensionIndices?.length ?? 0)) return fail()
  const correctedDimensions = new Set<number>()
  for (const correction of dimensionCorrections) {
    if (!correction || Object.keys(correction).some(key => !["dimensionIndex", "deductions"].includes(key)) ||
      !plan.dimensionIndices?.includes(correction.dimensionIndex) || correctedDimensions.has(correction.dimensionIndex) ||
      !Array.isArray(correction.deductions)) return fail()
    correctedDimensions.add(correction.dimensionIndex)
    result.dimensions[correction.dimensionIndex].deductions = correction.deductions
  }
  const seen = new Set<string>()
  for (const correction of patch.corrections) {
    const key = correction?.dimensionIndex + ":" + correction?.criterionIndex
    if (seen.has(key)) return fail()
    seen.add(key)
    let corrected: CriterionCorrection
    try { corrected = validateCriterionCorrection(correction, plan, shouldValidateRules, ruleContext) }
    catch (error) { return fail(error instanceof Error ? error.message : "Incomplete criterion evidence") }
    const { dimensionIndex, criterionIndex, ...fields } = corrected
    Object.assign(result.dimensions[dimensionIndex].criteria[criterionIndex], fields)
  }
  if (plan.shouldCorrectSuggestions) {
    // 移除不适用的条数建议，不让模型改写其他建议或把错误依据再传给模型。
    result.suggestions = plan.report.suggestions.filter((value: string) => !hasCountRule(value))
  }
  for (const [index, dimension] of result.dimensions.entries()) {
    if (!plan.criteria.some(item => item.dimensionIndex === index) && !correctedDimensions.has(index)) continue
    const original = plan.report.dimensions[index]
    const oldSum = original.criteria.reduce((sum, item) => sum + Number(item.score), 0)
    const newSum = dimension.criteria.reduce((sum, item) => sum + Number(item.score), 0)
    if (isCdqScoreReport(result) && index === 0) continue
    if (correctedDimensions.has(index)) {
      dimension.score = Math.max(0, Math.round((newSum - dimension.deductions!.reduce((sum, item) => sum + item.points, 0)) * 10000) / 10000)
      continue
    }
    const hasHalfPenalty =
      /CDQ/i.test(dimension.name) && oldSum > 0 && original.score === Math.floor(oldSum / 2)
    dimension.score =
      Math.round(
        Math.max(
          0,
          Math.min(
            dimension.maxScore,
            hasHalfPenalty ? Math.floor(newSum / 2) : newSum - Math.max(0, oldSum - original.score)
          )
        ) * 10000
      ) / 10000
  }
  if (isCdqScoreReport(result)) {
    // CDQ评级由既定总分规则计算，可恢复缺失potential；不接受模型改写既有尾部。
    const validated = validateScoreReport(validateListingScoreOutput(JSON.stringify(result)), market)
    if (shouldValidateRules) validateListingReportRules(JSON.parse(validated), ruleContext)
    return validated
  }
  if (plan.criteria.length) {
    const sum = result.dimensions.reduce((value, dimension) => value + dimension.score, 0)
    const hasPolicyCap = /^D\s*(?:级|·)/.test(plan.report.potential) && plan.report.total <= 54
    result.total = result.severeDefects?.length
      ? 0
      : hasPolicyCap
        ? Math.min(plan.report.total, sum)
        : Math.min(100, Math.round(sum * 10000) / 10000)
    // Amazon 评级与展示端使用同一分段；其他平台保留其自己的评级契约。
    if (market?.startsWith("amazon_") || /CDQ/i.test(result.dimensions[0].name))
      result.potential = formatListingScorePotential(result.total)
  }
  const validated = validateScoreReport(JSON.stringify(result), market)
  if (buildScoreCorrectionPlan(validated, market)) return fail()
  return validated
}
