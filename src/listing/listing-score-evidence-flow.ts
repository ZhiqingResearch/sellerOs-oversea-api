import { isCdqScoreReport } from "./listing-cdq-score"
import { parseListingJsonObject } from "./listing-result-parser"
import {
  getListingEvidenceRequirement,
  getListingLongtailTerms,
  projectListingCriterionEvidence,
  type ListingScoreSource,
} from "./listing-score-evidence"

const EVIDENCE_CRITERIA = [[1, 2], [2, 2], [3, 1], [3, 2]] as const
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 同次请求首次列出的候选词保持不变，不能通过删除未覆盖词抬高分数。 */
export function lockListingLongtailTerms(criterion: unknown, source: ListingScoreSource): void {
  if (source.longtailTerms || !isRecord(criterion)) return
  const terms = getListingLongtailTerms(criterion, source)
  if (terms) source.longtailTerms = terms
}

export function buildListingEvidencePrompt(
  source?: ListingScoreSource,
  requestedCriteria?: readonly { dimensionIndex: number; criterionIndex: number }[]
): string {
  if (!source) return ""
  const isRequested = (dimensionIndex: number, criterionIndex: number): boolean =>
    !requestedCriteria || requestedCriteria.some(item => item.dimensionIndex === dimensionIndex && item.criterionIndex === criterionIndex)
  const attributeRequirement = isRequested(0, 0) ? getListingEvidenceRequirement(0, 0, source) : undefined
  const evidenceCriteria = EVIDENCE_CRITERIA.filter(([dimensionIndex, criterionIndex]) => isRequested(dimensionIndex, criterionIndex))
  const requirements = evidenceCriteria.map(([dimensionIndex, criterionIndex]) => ({
    dimensionIndex, criterionIndex, assessmentRequirement: getListingEvidenceRequirement(dimensionIndex, criterionIndex),
  }))
  if (!attributeRequirement && !evidenceCriteria.length) return ""
  return `
Use listing-scoring-source as field-specific product evidence. For each requested assessment provide actual findings at the indicated indices. Keep source excerpts contiguous. A bullet may cite only its own text, and description checks may cite only the description. Mark unavailable evidence explicitly. Freeze the entire long-tail set including misses; distinguish inferred terms from measured research.
${attributeRequirement ? `Structured attribute assessment (0:0): ${JSON.stringify(attributeRequirement)}` : ""}
${JSON.stringify(requirements)}
For an initial report calculate scores and deductions immediately. For a correction return only the requested items.`
}

/** 先核实事实、再投影分数；无效事实保留待局部补齐，不丢掉原始模型输出。 */
export function projectListingReportEvidence(text: string, source?: ListingScoreSource): string {
  if (!source) return text
  let report: Record<string, unknown>
  try { report = parseListingJsonObject(text) } catch { return text }
  if (!isCdqScoreReport(report) || !Array.isArray(report.dimensions)) return text
  const criteria: ReadonlyArray<readonly [number, number]> = source.structuredAttributes?.length
    ? [[0, 0], ...EVIDENCE_CRITERIA] : EVIDENCE_CRITERIA
  for (const [dimensionIndex, criterionIndex] of criteria) {
    const dimension = report.dimensions[dimensionIndex]
    if (!isRecord(dimension) || !Array.isArray(dimension.criteria)) continue
    const criterion = dimension.criteria[criterionIndex]
    if (!isRecord(criterion)) continue
    if (dimensionIndex === 1) lockListingLongtailTerms(criterion, source)
    const oldSum = dimension.criteria.reduce((sum, item) => sum + (isRecord(item) ? Number(item.score) : NaN), 0)
    const extra = Math.max(0, oldSum - Number(dimension.score))
    try {
      const projected = projectListingCriterionEvidence(dimensionIndex, criterionIndex, criterion, source)
      if (!projected) continue
      Object.assign(criterion, projected)
      const newSum = dimension.criteria.reduce((sum, item) => sum + (isRecord(item) ? Number(item.score) : NaN), 0)
      if (dimensionIndex !== 0 && Number.isFinite(newSum) && Number.isFinite(extra))
        dimension.score = Math.round(Math.max(0, newSum - extra) * 10000) / 10000
    } catch {
      // 保持待校对状态；现有恢复流程会携带具体证据错误重新取证。
    }
  }
  return JSON.stringify(report)
}
