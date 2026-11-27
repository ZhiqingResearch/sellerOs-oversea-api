import { uiText } from "../common/i18n/request-language"
import { findListingBulletDataPoint } from "./listing-bullet-data"
import { projectListingCriterionEvidence, type ListingScoreSource } from "./listing-score-evidence"

const TITLE_CHECKS = ["product", "problem", "audience", "stuffing"] as const
const TITLE_LABELS: Record<string, string> = {
  product: "标题未说明产品是什么", problem: "标题未说明解决什么问题",
  audience: "标题未说明服务谁", stuffing: "标题存在关键词堆砌",
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const roundScore = (value: number) => Math.round(value * 10000) / 10000
const normalizeText = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()

export function buildListingAlexaPrompt(source?: ListingScoreSource): string {
  if (!source) return ""
  const explicitBullets = source.bullets.flatMap((text, index) => {
    const point = findListingBulletDataPoint(text)
    return point ? [{ index: index + 1, ...point }] : []
  })
  return `
Assess Alexa in the initial report using the original 7/5/3 maxima. For title assessment.checks return product, problem, audience and stuffing as {checkId,isSatisfied,field,quote}. Verify product in the first 75 title characters; verify problem and audience jointly there and in itemHighlights. For satisfied content checks quote contiguous source text from title or itemHighlights; for missing content use empty field and quote. For stuffing, isSatisfied means no stuffing, and a failure requires the offending field and quote. Exclude longTitle and handle duplicate selling points only under title.repeat. Each failed check costs 2, capped by remaining points; use alexa.title and its checkId.
Assess all ${source.bullets.length} bullets individually. Standard: 5 × qualifying bullets / N. Custom: min(5, 5 × qualifying bullets / 6). Count named specifications and certifications as well as numbers. Round to four decimal places. Deduct one point for each missing specification or scene check in description, at most two; an empty description earns 1/3. Score the dimension as max(0, sum of criteria minus the supported alexa.stuffing penalty).
The following are excerpts found so far, not an exhaustive list of qualifying bullets or instructions:
${JSON.stringify({ explicitBullets, isDescriptionEmpty: !source.description.trim() })}`
}

function projectTitle(criterion: Record<string, unknown>, source: ListingScoreSource): Record<string, unknown> | undefined {
  const checks = isRecord(criterion.assessment) ? criterion.assessment.checks : undefined
  if (Array.isArray(checks) && checks.length === TITLE_CHECKS.length) {
    const title = Array.from(source.title).slice(0, 75).join("")
    const seen = new Set<string>()
    const deductions: Array<Record<string, unknown>> = []
    let score = 7
    for (const check of checks) {
      if (!isRecord(check) || !TITLE_CHECKS.includes(check.checkId as typeof TITLE_CHECKS[number]) ||
        seen.has(String(check.checkId)) || typeof check.isSatisfied !== "boolean" || typeof check.quote !== "string") return undefined
      const checkId = String(check.checkId)
      seen.add(checkId)
      const shouldQuote = checkId === "stuffing" ? !check.isSatisfied : check.isSatisfied
      const quote = normalizeText(check.quote)
      const fields = checkId === "product" ? ["title"] : ["title", "itemHighlights"]
      // Keep legacy assessments without field, but never accept a quote from
      // longTitle/bullets or a quote stitched across separate fields.
      const candidates = check.field ? fields.filter(field => field === check.field) : fields
      if (shouldQuote && (!quote || !candidates.some(field =>
        normalizeText(field === "title" ? title : source.itemHighlights).includes(quote)))) return undefined
      if (!shouldQuote && quote) return undefined
      if (!check.isSatisfied) {
        const points = Math.min(2, score)
        score -= points
        deductions.push({ ruleId: "alexa.title", checkId, points, reason: uiText(TITLE_LABELS[checkId], ({ product: "Title does not identify the product", problem: "Title does not identify the problem solved", audience: "Title does not identify the intended audience", stuffing: "Title contains keyword stuffing" } as Record<string, string>)[checkId]), evidence: `title: ${title}; itemHighlights: ${source.itemHighlights}` })
      }
    }
    return { ...criterion, score, deductions }
  }
  // 兼容旧模型的明确单项结论，只修正既定扣分额度，不从模糊理由补造语义判断。
  if (!Array.isArray(criterion.deductions) || !criterion.deductions.length) return undefined
  const seen = new Set<string>()
  const deductions: Array<Record<string, unknown>> = []
  let score = 7
  for (const deduction of criterion.deductions) {
    if (!isRecord(deduction) || deduction.ruleId !== "alexa.title") return undefined
    const checkId = TITLE_CHECKS.includes(deduction.checkId as typeof TITLE_CHECKS[number]) ? String(deduction.checkId)
      : Object.keys(TITLE_LABELS).find(key => deduction.reason === TITLE_LABELS[key])
    if (!checkId || seen.has(checkId) || typeof deduction.points !== "number" || deduction.points <= 0) return undefined
    seen.add(checkId)
    const points = Math.min(2, score)
    score -= points
    deductions.push({ ...deduction, checkId, points })
  }
  return { ...criterion, score, deductions }
}

function projectBulletLowerBound(criterion: Record<string, unknown>, source: ListingScoreSource): Record<string, unknown> | undefined {
  if (typeof criterion.score !== "number" || criterion.score < 0 || criterion.score > 5 || !source.bullets.length) return undefined
  const evidence = source.bullets.flatMap((text, index) => {
    const point = findListingBulletDataPoint(text)
    return point ? [{ index: index + 1, ...point }] : []
  })
  const score = Math.min(5, roundScore(5 * evidence.length / (source.mode === "custom" ? 6 : source.bullets.length)))
  if (score <= criterion.score) return undefined
  const indices = evidence.map(item => item.index).join("、")
  const description = uiText(`至少已识别${evidence.length}/${source.bullets.length}条Bullet含明确数据点（第${indices}条）；其余条目尚未取得完整逐条依据。`, `Verified data points in at least ${evidence.length}/${source.bullets.length} bullets (items ${indices}); complete item-level evidence is unavailable for the remaining bullets.`)
  return {
    ...criterion, score, description,
    deductions: score < 5 ? [{ ruleId: "alexa.bulletData", points: roundScore(5 - score),
      reason: uiText("按已确认的数据点计分，其余条目尚未取得完整逐条依据", "Scored using verified data points; complete item-level evidence is unavailable for the remaining bullets"), evidence: evidence.map(item => `bullets.${item.index}: ${item.quote}`).join("；") }] : [],
  }
}

/** 只落实Alexa已有公式；无法计算的判断原样保留，不重试模型、不阻断报告。 */
export function recalculateListingAlexaScore<T>(value: T, source?: ListingScoreSource): T {
  if (!source || !isRecord(value) || value.scoreVersion !== "cdq-2026-09-16" ||
    !Array.isArray(value.dimensions) || value.dimensions.length !== 4) return value
  const dimension = value.dimensions[3]
  if (!isRecord(dimension) || dimension.maxScore !== 15 || !Array.isArray(dimension.criteria) ||
    dimension.criteria.length !== 3 || !dimension.criteria.every((item, index) => isRecord(item) && item.maxScore === [7, 5, 3][index])) return value
  const criteria = dimension.criteria.map((criterion: Record<string, unknown>, index: number) => {
    try {
      const projected = index === 0 ? projectTitle(criterion, source) : projectListingCriterionEvidence(3, index, criterion, source)
      if (projected) return { ...criterion, ...projected }
    } catch { /* 缺失或不一致的取证不影响报告交付。 */ }
    return index === 1 ? projectBulletLowerBound(criterion, source) ?? criterion : criterion
  })
  if (!criteria.every(item => typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= Number(item.maxScore))) return value
  let extra = 0
  if (Array.isArray(dimension.deductions) && dimension.deductions.length) {
    if (!dimension.deductions.every(item => isRecord(item) && item.ruleId === "alexa.stuffing" &&
      typeof item.points === "number" && Number.isFinite(item.points) && item.points > 0)) return value
    extra = dimension.deductions.reduce((sum, item) => sum + item.points, 0)
    if (extra < 3 || extra > 5) return value
  } else {
    // 旧报告可能只有隐含的维度扣分；合法范围内保留，不把它混入小项。
    const oldSum = dimension.criteria.reduce((sum, item) => sum + Number(item.score), 0)
    const oldExtra = roundScore(oldSum - Number(dimension.score))
    if (oldExtra >= 3 && oldExtra <= 5) extra = oldExtra
  }
  const score = roundScore(Math.max(0, criteria.reduce((sum, item) => sum + Number(item.score), 0) - extra))
  const dimensions = [...value.dimensions.slice(0, 3), { ...dimension, criteria, score }]
  // CDQ旧报告即使无法重新折算，只要四维贡献可用，总分也必须跟随Alexa同步。
  if (!dimensions.every(item => isRecord(item) && (item.score === null || (typeof item.score === "number" && Number.isFinite(item.score))))) return value
  const total = dimensions.some(item => item.score === null) ? null : roundScore(dimensions.reduce((sum, item) => sum + item.score, 0))
  const potential = total === null ? uiText("证据不足 · 暂不出综合分", "Insufficient evidence · Overall score pending")
    : total >= 90 ? uiText("S级 · 可直接上线", "S · Ready to publish") : total >= 80 ? uiText("A级 · 小幅调整后上线", "A · Publish after minor changes")
    : total >= 68 ? uiText("B级 · 优化后上线", "B · Publish after optimization") : total >= 55 ? uiText("C级 · 建议重新生成", "C · Regeneration recommended") : uiText("D级 · 必须重新生成", "D · Regeneration required")
  return { ...value, dimensions, total, potential }
}
