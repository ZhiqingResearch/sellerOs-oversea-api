import { uiText } from "../common/i18n/request-language"
import { projectListingAttributeCriterion } from "./listing-attribute-score"
import { findListingBulletDataPoint } from "./listing-bullet-data"

/** 原文证据只约束已有评分检查点；模型取证，程序按原规则计算。 */
export interface ListingScoreSource {
  mode?: "standard" | "custom"
  title: string
  itemHighlights: string
  bullets: string[]
  description: string
  searchTerms: string
  keywordDataBlock?: string
  /** 原始属性字段；统计行保留为证据，由属性核算排除，不代表后台必填清单。 */
  structuredAttributes?: Array<{ name: string; value: string }>
  /** 仅服务端从本次首次评估冻结，不能从客户端输入接收。 */
  longtailTerms?: string[]
}

interface EvidenceDeduction {
  ruleId: string
  points: number
  reason: string
  evidence: string
  checkId?: string
}

export interface ListingEvidenceProjection {
  score: number
  description: string
  deductions: EvidenceDeduction[]
  assessment: Record<string, unknown>
}

const MEDIUM_RELATIONS = ["IS_A", "USED_TO", "USED_BY", "USED_FOR_EVE"]
const DESCRIPTION_CHECKS = ["specifications", "overview_scenes"]
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const normalizeText = (value: string): string => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
const roundScore = (value: number): number => Math.round(value * 10000) / 10000
const fail = (message: string): never => { throw new Error("Source evidence check: " + message) }

/** 只读取专用结构化原文块，历史请求不强行猜测字段边界。 */
export function parseListingScoreSource(userPrompt: string): ListingScoreSource | undefined {
  const startTag = "<listing-scoring-source>", endTag = "</listing-scoring-source>"
  const prompt = userPrompt.trimEnd()
  const start = prompt.lastIndexOf(startTag)
  if (start < 0 || !prompt.endsWith(endTag)) return undefined
  try {
    const value: unknown = JSON.parse(prompt.slice(start + startTag.length, -endTag.length))
    if (!isRecord(value) || !Array.isArray(value.bullets) || value.bullets.some(item => typeof item !== "string")) return undefined
    const getText = (key: string): string | undefined => {
      const item = value[key]
      return typeof item === "string" ? item : Array.isArray(item) && item.every(text => typeof text === "string") ? item.join(" ") : undefined
    }
    const title = getText("title"), itemHighlights = getText("itemHighlights")
    const description = getText("description"), searchTerms = getText("searchTerms")
    if ([title, itemHighlights, description, searchTerms].some(item => item === undefined)) return undefined
    const mode = /^mode[：:]\s*(standard|custom)(?:\r?\n|$)/.exec(userPrompt)?.[1] as "standard" | "custom" | undefined
    return {
      ...(mode ? { mode } : {}),
      title: title!, itemHighlights: itemHighlights!, description: description!, searchTerms: searchTerms!,
      bullets: [...value.bullets] as string[],
      ...(Array.isArray(value.structuredAttributes) && value.structuredAttributes.length > 0 &&
        value.structuredAttributes.every(item => isRecord(item) && typeof item.name === "string" && typeof item.value === "string")
        ? { structuredAttributes: value.structuredAttributes.map(item => ({ name: item.name as string, value: item.value as string })) } : {}),
      ...(typeof value.keywordDataBlock === "string" ? { keywordDataBlock: value.keywordDataBlock } : {}),
    }
  } catch { return undefined }
}

export function getListingEvidenceRequirement(dimensionIndex: number, criterionIndex: number, source?: ListingScoreSource): Record<string, unknown> | undefined {
  const key = `${dimensionIndex}:${criterionIndex}`
  const common = "Copy quote/quotes exactly from the named listing-scoring-source field, never from currentCriterion or another score. Include misses. Use title, itemHighlights, description, searchTerms or bullets.1 (one-based). Compute scores and deductions from the supplied formula."
  if (key === "0:0" && source?.structuredAttributes?.length) return {
    instructions: "Return one attributeChecks row per actual structured attribute, using its one-based index. Exclude ASIN, BSR and review statistics. Include correct and pending rows without merging or duplicating indices. Use numeric weights 3/2/1. Take the first evidenced issue in contradiction, wrong field, unit, marketing order; use PENDING for unresolved issues. For comparison cite the actual title, itemHighlights, description, bullets.1 or attributes.1 value. Compare like with like: Printer is not evidence of incompatible models; a pack-count conflict needs package-level facts; a color conflict needs actual colors in both fields. Use exact, contiguous source excerpts without ellipses. A neutral product description is PRODUCT_DESCRIPTION, not MARKETING. An ambiguous Page Yield is PENDING. Give a specific, supported field change, or say which evidence is needed, in the requested interface language. Do not expose weights or calculate lost points as raw percentages. Use NONE for a correct field. Do not invent missing template attributes.",
    assessment: { attributeChecks: [{ index: 1, weight: 2, errorType: "NONE | CONTRADICTION | TYPE_MISMATCH | WRONG_FIELD | GRANULARITY | PRODUCT_DESCRIPTION | UNIT_MISMATCH | MISSING_UNIT | MARKETING | PENDING", comparison: [{ field: "Source field such as attributes.2 or bullets.1; use [] for comparison when unnecessary", quote: "Exact source excerpt supporting the comparison" }], suggestion: "Actionable change; NONE may be empty, PENDING identifies what to verify" }] },
    formula: "W=sum of all assessed non-statistical attribute weights. Deduction per item=30*weight*severity/W, with severity 100%, 50% or 0%. Score=30 minus the sum of deductions.",
  }
  if (key === "1:2") return {
    instructions: common + "Check long-tail terms only in bullets, description and searchTerms. Include all candidates and misses. Exclude cross-category terms from provided B/C research; infer the candidates only when no such data is available. Do not shrink or replace the frozen list. Match complete terms with case, whitespace and punctuation normalized. The server verifies matches and assigns basis from the actual research provided.",
    assessment: { basis: "provided | inferred", terms: [{ term: "Candidate long-tail keyword", field: "bullets.1 | description | searchTerms | empty string", quote: "Original phrase containing the term, empty if absent" }], excludedTerms: [{ term: "Cross-category term from the provided list only", reason: "Specific reason the term does not fit this product; use [] when there are no exclusions" }] },
    formula: "Coverage=matched terms/all eligible terms. Score=5*min(coverage/0.7,1). Unavailable backend search terms do not turn a miss in other fields into a hit.",
  }
  if (key === "2:2") return {
    instructions: common + "List each of the four relation types exactly once. Use an empty quote for an uncovered relationship. For IS_A cite the product identity; for USED_TO cite a specific purpose or action; for USED_BY cite a specific user; for USED_FOR_EVE cite an occasion or activity. Ink alone does not prove all four. Use distinct, meaningful excerpts for distinct relationships without paraphrasing evidence.",
    assessment: { relations: MEDIUM_RELATIONS.map(type => ({ type, field: "Actual source field, empty when uncovered", quote: "Verbatim evidence for this relationship, empty when uncovered" })) },
    formula: "At least three covered relations earn 4. Otherwise score=max(0,4-1.5*max(0,3-covered count)).",
  }
  if (key === "3:1") return {
    instructions: common + "Assess all N bullets once each, with one-based indices. For a qualifying bullet quote the exact numerical fact, named specification or certification within that bullet. ET-2850 can be a model specification and 24/7 support is a measurable service duration. Exclude vague claims such as premium, rigorous testing and dozens. For a miss use empty kind and quote. Do not borrow facts from another bullet.",
    assessment: { bullets: [{ index: 1, kind: "numeric | specification | certification | empty string", quote: "Exact data point from this bullet, empty when unqualified" }] },
    formula: "Standard: 5 × qualifying bullets / N (zero if N=0). Custom: min(5, 5 × qualifying bullets / 6), even when N differs from six. Evaluate every supplied bullet.",
  }
  if (key === "3:2") return {
    instructions: common + "Check only the actual description. For specifications cite a field plus its value (including HTML table cells); adjectives alone are insufficient. For overview_scenes cite at least two distinct non-overlapping complete use cases. Do not split one phrase into artificial scenes or count paraphrases twice. A missing check has isPresent=false and quotes=[]. Do not deduct for extra format or wording requirements.",
    assessment: { checks: DESCRIPTION_CHECKS.map(checkId => ({ checkId, isPresent: "boolean", quotes: ["Verbatim evidence for this check; [] when absent"] })) },
    formula: "Maximum 3. Deduct 1 for missing specifications and 1 for missing overview scenes, each at most once.",
  }
  return undefined
}

function getFieldText(source: ListingScoreSource, field: unknown): string {
  if (typeof field !== "string") return fail("field must identify an original source field")
  if (["title", "itemHighlights", "description", "searchTerms"].includes(field)) return source[field as "title" | "itemHighlights" | "description" | "searchTerms"]
  const match = /^bullets\.(\d+)$/.exec(field)
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= source.bullets.length) return source.bullets[Number(match[1]) - 1]
  return fail(`Unknown evidence field: ${field}`)
}

function validateQuote(source: ListingScoreSource, field: unknown, quote: unknown): string {
  if (typeof quote !== "string" || !quote.trim()) return fail(`A positive finding for ${String(field)} needs a nonempty source quotation`)
  if (!normalizeText(getFieldText(source, field)).includes(normalizeText(quote))) return fail(`${String(field)} does not contain the quote "${quote}"; cite the actual field`)
  return quote.trim()
}

/** COSMO允许多个原文字段；仅在真实原文连续命中时纠正模型误标的出处。 */
function resolveRelationQuote(source: ListingScoreSource, field: unknown, quote: string): { field: string; quote: string } {
  const fields = ["title", "itemHighlights", "description", "searchTerms", ...source.bullets.map((_, index) => `bullets.${index + 1}`)]
  const candidates = typeof field === "string" && fields.includes(field)
    ? [field, ...fields.filter(candidate => candidate !== field)] : fields
  const matched = quote.trim() && candidates.find(candidate => normalizeText(getFieldText(source, candidate)).includes(normalizeText(quote)))
  if (matched) return { field: matched, quote: validateQuote(source, matched, quote) }
  return { field: String(field), quote: validateQuote(source, field, quote) }
}

function getEntries(assessment: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const entries = assessment[name]
  if (!Array.isArray(entries) || entries.some(item => !isRecord(item))) return fail(`assessment.${name} must be an array of per-item objects`)
  return entries as Record<string, unknown>[]
}

function getProvidedKeywords(source: ListingScoreSource): Array<{ tier: string; term: string }> {
  return [...(source.keywordDataBlock ?? "").matchAll(/^\s*\[([SABC])\]\s*(.*?)\s*(?:—|–|\s+-\s+|\|)\s*月搜索量.*$/gm)]
    .map(match => ({ tier: match[1], term: match[2].trim() })).filter(item => item.term)
}

function getKeywordTokens(value: string): Array<{ text: string; start: number; end: number }> {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({
    text: normalizeText(match[0]), start: match.index!, end: match.index! + match[0].length,
  }))
}

const normalizeKeyword = (value: string): string => getKeywordTokens(value).map(token => token.text).join(" ")

/** 关键词覆盖为文本事实：只在原规则允许的字段内匹配，不依赖模型填写field/quote。 */
function findLongtailEvidence(source: ListingScoreSource, term: string): { field: string; quote: string } {
  const expected = getKeywordTokens(term).map(token => token.text)
  if (!expected.length) return fail(`The long-tail candidate "${term}" contains no valid tokens`)
  const fields = [
    ...source.bullets.map((text, index) => ({ field: `bullets.${index + 1}`, text })),
    { field: "description", text: source.description },
    { field: "searchTerms", text: source.searchTerms },
  ]
  for (const { field, text } of fields) {
    const tokens = getKeywordTokens(text)
    for (let index = 0; index <= tokens.length - expected.length; index++) {
      if (expected.every((word, offset) => tokens[index + offset].text === word)) {
        return { field, quote: text.slice(tokens[index].start, tokens[index + expected.length - 1].end) }
      }
    }
  }
  return { field: "", quote: "" }
}

/** 候选分区先于命中核验，防止把首轮遗漏的provided分母永久冻结。 */
function getLongtailCandidatePlan(assessment: Record<string, unknown>, source: ListingScoreSource): { terms: string[]; basis: string } {
  const entries = getEntries(assessment, "terms")
  if (!entries.length) return fail("Provide the complete nonempty candidate list including uncovered terms")
  const terms: string[] = [], seen = new Set<string>()
  for (const item of entries) {
    if (typeof item.term !== "string" || !item.term.trim()) return fail("A long-tail candidate cannot be empty")
    const term = normalizeKeyword(item.term)
    if (!term) return fail(`The long-tail candidate "${item.term}" contains no valid tokens`)
    if (seen.has(term)) return fail(`Duplicate long-tail term: ${item.term}`)
    seen.add(term)
    terms.push(item.term.trim())
  }
  const provided = getProvidedKeywords(source)
  const providedKeys = new Set(provided.map(item => normalizeKeyword(item.term)))
  const providedLongtailKeys = new Set(provided.filter(item => ["B", "C"].includes(item.tier)).map(item => normalizeKeyword(item.term)))
  const excluded = assessment.excludedTerms === undefined ? [] : getEntries(assessment, "excludedTerms")
  const excludedKeys = new Set<string>()
  for (const item of excluded) {
    if (typeof item.term !== "string" || typeof item.reason !== "string" || !item.reason.trim()) return fail("Each cross-category exclusion needs a specific term and reason")
    const term = normalizeKeyword(item.term)
    if (!providedKeys.has(term) || seen.has(term) || excludedKeys.has(term)) return fail(`Excluded term "${item.term}" must be in the supplied research and distinct from the candidates`)
    excludedKeys.add(term)
  }
  // <3阈值针对整个S/A/B/C词库；长尾分母只取其中未被明确排除的B/C。
  const availableCount = [...providedKeys].filter(term => !excludedKeys.has(term)).length
  const remaining = [...providedLongtailKeys].filter(term => !excludedKeys.has(term))
  const isUsingProvided = remaining.length > 0 && availableCount >= 3
  if (isUsingProvided && (remaining.some(term => !seen.has(term)) || [...seen].some(term => !remaining.includes(term)))) {
    return fail("Check every provided B/C term, retain misses and explain cross-category exclusions")
  }
  if (source.longtailTerms) {
    const expected = new Set(source.longtailTerms.map(normalizeKeyword))
    if (expected.size !== seen.size || [...expected].some(term => !seen.has(term))) return fail("The candidate list differs from the frozen set. Keep all misses and the original denominator")
  }
  return { terms, basis: isUsingProvided ? "provided" : "inferred" }
}

/** 仅合法候选分区可冻结，不要求模型field/quote或分数正确。 */
export function getListingLongtailTerms(criterion: { assessment?: unknown }, source: ListingScoreSource): string[] | undefined {
  if (!isRecord(criterion.assessment)) return undefined
  try { return getLongtailCandidatePlan(criterion.assessment, source).terms }
  catch { return undefined }
}

function projectLongtail(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const { terms, basis } = getLongtailCandidatePlan(assessment, source)
  const missing: string[] = [], covered: string[] = []
  const normalizedTerms = terms.map(term => {
    const evidence = findLongtailEvidence(source, term)
    if (evidence.quote) covered.push(term)
    else missing.push(term)
    return { term, ...evidence }
  })
  const score = roundScore(5 * Math.min(covered.length / terms.length / 0.7, 1))
  const description = uiText(`长尾词覆盖${covered.length}/${terms.length}（${roundScore(covered.length / terms.length * 100)}%）；${basis === "provided" ? "依据提供词表" : "依据行业推断词表"}${missing.length ? `；未覆盖：${missing.join("、")}` : ""}。`, `Long-tail coverage ${covered.length}/${terms.length} (${roundScore(covered.length / terms.length * 100)}%); ${basis === "provided" ? "provided keyword list" : "industry-inferred keyword list"}.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`)
  return { score, description, assessment: { ...assessment, basis, terms: normalizedTerms }, deductions: score < 5 ? [{ ruleId: "keyword.longtail", points: roundScore(5 - score), reason: uiText(`长尾词覆盖率低于70%；未覆盖：${missing.join("、")}`, `Long-tail coverage below 70%; missing: ${missing.join(", ")}`), evidence: description }] : [] }
}

function projectMediumRelations(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const relations = getEntries(assessment, "relations")
  if (relations.length !== MEDIUM_RELATIONS.length) return fail("Include all four medium-priority relations")
  const seen = new Set<string>(), quotedRelations = new Set<string>(), covered: string[] = [], missing: string[] = []
  const normalizedRelations: Record<string, unknown>[] = []
  for (const item of relations) {
    if (typeof item.type !== "string" || !MEDIUM_RELATIONS.includes(item.type) || seen.has(item.type)) return fail("Invalid or duplicate medium-priority relation")
    seen.add(item.type)
    if (typeof item.quote !== "string") return fail(`${item.type} is missing quote; use an empty string for a miss`)
    if (item.quote.trim()) {
      const evidence = resolveRelationQuote(source, item.field, item.quote)
      const quote = evidence.quote
      normalizedRelations.push({ ...item, ...evidence })
      const quoteKey = normalizeKeyword(quote)
      if (quotedRelations.has(quoteKey)) return fail(`COSMO ${item.type} reuses "${quote}". Cite distinct evidence for identity, action, user and occasion`)
      quotedRelations.add(quoteKey)
      covered.push(item.type)
    } else {
      if (item.field !== "") return fail(`field must be empty for the uncovered relation ${item.type}`)
      normalizedRelations.push({ ...item })
      missing.push(item.type)
    }
  }
  const points = Math.min(4, 1.5 * Math.max(0, 3 - covered.length))
  const description = uiText(`中优先级关系已覆盖${covered.length}类${covered.length ? `：${covered.join("、")}` : ""}；未覆盖：${missing.length ? missing.join("、") : "无"}。`, `Medium-priority relations cover ${covered.length} categories${covered.length ? `: ${covered.join(", ")}` : ""}; missing: ${missing.length ? missing.join(", ") : "none"}.`)
  return { score: roundScore(4 - points), description, assessment: { ...assessment, relations: normalizedRelations }, deductions: points > 0 ? [{ ruleId: "cosmo.medium", points, reason: uiText(`中优先级关系仅覆盖${covered.length}类，未达到3类；待补充：${missing.join("、")}`, `Medium-priority relations cover ${covered.length} categories, below the 3-category threshold; add: ${missing.join(", ")}`), evidence: description }] : [] }
}

function validateBulletDataPoint(kind: unknown, quote: string): void {
  if (!["numeric", "specification", "certification"].includes(String(kind))) return fail("A qualifying bullet requires numeric, specification or certification")
  const text = normalizeText(quote)
  if (kind === "numeric" && !/\d/.test(text)) return fail("Numeric evidence must contain an actual number. Vague quantities such as dozens do not qualify")
  // 仅排除原规则明确不承认可验证数据的空泛话术，不另列产品规格白名单。
  if (/^(?:premium|best|high[- ]quality|superior quality|professional quality|rigorous (?:quality )?testing|quality testing|consistent[, ]+reliable performance|reliable performance|strict (?:shipping )?tests?|dozens(?: of)?(?: strict)?(?: shipping)?(?: tests?)?|优质|高品质|严格(?:质量)?测试|品质保证)[.!。\s]*$/i.test(text))
    return fail("Generic quality or testing claims are not named specifications, certifications or metrics")
  if (kind !== "numeric" && !/\d/.test(text) && /(?:every (?:bottle|page)|your (?:work|satisfaction)|our (?:commitment|standard)|rigorous (?:quality )?testing|quality you can trust|colors that pop|professionally polished|fade-resistant colors|razor-sharp text|dozens of)/i.test(text))
    return fail("Quote only the specific specification or certification, not an entire promotional bullet")
}

function projectBulletData(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const bullets = getEntries(assessment, "bullets")
  if (bullets.length !== source.bullets.length) return fail(`Assess all ${source.bullets.length} bullets once, without omission or merging`)
  const seen = new Set<number>(), qualified: number[] = [], unqualified: number[] = []
  const normalizedBullets: Record<string, unknown>[] = []
  for (const item of bullets) {
    if (!Number.isSafeInteger(item.index) || Number(item.index) < 1 || Number(item.index) > source.bullets.length || seen.has(Number(item.index))) return fail("Bullet indices must be unique and between 1 and the actual count")
    const index = Number(item.index)
    seen.add(index)
    if (typeof item.quote !== "string") return fail(`Bullet ${index} needs quote; use an empty string for a miss`)
    const explicit = !item.quote.trim() ? findListingBulletDataPoint(source.bullets[index - 1]) : undefined
    const normalized = explicit ? { ...item, ...explicit } : item
    normalizedBullets.push(normalized)
    if (!(normalized.quote as string).trim()) {
      if (item.kind !== "" && item.kind !== undefined) return fail(`Bullet ${index} needs an empty kind when there is no data point`)
      unqualified.push(index)
    } else {
      const quote = validateQuote(source, `bullets.${index}`, normalized.quote)
      validateBulletDataPoint(normalized.kind, quote)
      qualified.push(index)
    }
  }
  qualified.sort((a, b) => a - b); unqualified.sort((a, b) => a - b)
  const denominator = source.mode === "custom" ? 6 : source.bullets.length
  const score = denominator ? Math.min(5, roundScore(5 * qualified.length / denominator)) : 0
  const description = uiText(`逐条核验${source.bullets.length}条Bullet，合格${qualified.length}条${qualified.length ? `（${qualified.join("、")}）` : ""}${unqualified.length ? `；未含可验证数据点：${unqualified.join("、")}` : ""}。`, `Verified ${source.bullets.length} bullets; ${qualified.length} qualify${qualified.length ? ` (${qualified.join(", ")})` : ""}.${unqualified.length ? ` No verifiable data point in: ${unqualified.join(", ")}.` : ""}`)
  return { score, description, assessment: { ...assessment, bullets: normalizedBullets }, deductions: score < 5 ? [{ ruleId: "alexa.bulletData", points: roundScore(5 - score), reason: !source.bullets.length ? uiText("未提供Bullet，实际条数为0", "No bullets provided; actual count is zero") : unqualified.length ? uiText(`Bullet ${unqualified.join("、")}缺少具名规格、认证或数字指标${source.mode === "custom" ? "；按custom固定6条基准计分" : ""}`, `Bullets ${unqualified.join(", ")} lack named specifications, certifications or numerical metrics${source.mode === "custom" ? "; custom scoring uses the fixed 6-bullet baseline" : ""}`) : uiText(`custom按固定6条基准计分，本次实际核验${source.bullets.length}条、合格${qualified.length}条`, `Custom scoring uses the fixed 6-bullet baseline; ${source.bullets.length} verified and ${qualified.length} qualified`), evidence: description }] : [] }
}

function hasSpecificationStructure(quote: string): boolean {
  const isSpecificationLabel = (label: string) => !/^(?:(?:product\s+)?overview|description|产品(?:概述|描述))$/i.test(label.trim())
  // 仅结构识别副本去除行内HTML标记，原quote仍由validateQuote逐字核对出处。
  const plain = quote.replace(/\*\*/g, "").replace(/<\/?(?:strong|b|em|i|span|u|small|sup|sub|mark|a|code)\b[^>]*>/gi, "")
  const fields = [...plain.matchAll(/(?:^|[\r\n;]|\.\s+)\s*([\p{L}\p{N}][\p{L}\p{N} _/()-]{0,70})\s*[:：]\s*([^\r\n;]+)/gu)]
  if (fields.some(match => isSpecificationLabel(match[1]) && match[2].trim())) return true
  const cells = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
  return [...quote.matchAll(cells)].some(match => {
    const label = match[1].replace(/<[^>]*>/g, "").trim()
    const value = match[2].replace(/<[^>]*>/g, "").trim()
    return !!label && !!value && isSpecificationLabel(label)
  })
}

function hasSeparateSceneQuotes(description: string, quotes: string[]): boolean {
  const text = normalizeText(description)
  const normalized = quotes.map(normalizeText)
  for (let left = 0; left < normalized.length; left++) {
    for (let right = left + 1; right < normalized.length; right++) {
      if (normalized[left].includes(normalized[right]) || normalized[right].includes(normalized[left])) return false
    }
  }
  // 任意两个引用都须能在描述中对应不重叠的片段，而不是重叠截词凑两个场景。
  const getPositions = (quote: string): number[] => {
    const positions: number[] = []
    for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) positions.push(start)
    return positions
  }
  return normalized.every((quote, index) => normalized.slice(index + 1).every(other =>
    getPositions(quote).some(start => getPositions(other).some(otherStart =>
      start + quote.length <= otherStart || otherStart + other.length <= start))))
}

function projectDescription(assessment: Record<string, unknown>, source: ListingScoreSource): ListingEvidenceProjection {
  const checks = getEntries(assessment, "checks")
  if (checks.length !== DESCRIPTION_CHECKS.length) return fail("Check specifications and overview_scenes separately")
  const seen = new Set<string>(), deductions: EvidenceDeduction[] = [], states: string[] = []
  for (const item of checks) {
    if (typeof item.checkId !== "string" || !DESCRIPTION_CHECKS.includes(item.checkId) || seen.has(item.checkId) || typeof item.isPresent !== "boolean" || !Array.isArray(item.quotes) || item.quotes.some(quote => typeof quote !== "string")) return fail("Provide both unique checkIds, each with a boolean isPresent and a quotes array")
    seen.add(item.checkId)
    const name = item.checkId === "specifications" ? uiText("结构化规格段", "Structured specifications section") : uiText("PRODUCT OVERVIEW具体场景", "Specific PRODUCT OVERVIEW use cases")
    if (item.isPresent) {
      const quotes = (item.quotes as string[]).map(quote => validateQuote(source, "description", quote))
      const quoteKeys = new Set(quotes.map(normalizeText))
      if (quotes.length !== quoteKeys.size || quotes.length < (item.checkId === "overview_scenes" ? 2 : 1)) return fail(`${item.checkId} needs ${item.checkId === "overview_scenes" ? "two distinct source scenes" : "a source specification field and its value"}`)
      if (item.checkId === "specifications" && !quotes.some(hasSpecificationStructure)) return fail("Cite a field and value in the description text or HTML table for specifications")
      if (item.checkId === "overview_scenes" && !hasSeparateSceneQuotes(source.description, quotes)) return fail("Quote two complete distinct non-overlapping scenes for overview_scenes")
      states.push(uiText(`${name}已核验`, `${name} verified`))
    } else {
      if (item.quotes.length) return fail(`For an unmet ${name} check, quotes must be empty`)
      states.push(uiText(`${name}缺失`, `${name} missing`))
      deductions.push({ ruleId: "alexa.description", checkId: item.checkId, points: 1, reason: uiText(`缺少${name}`, `Missing ${name}`), evidence: source.description.trim() ? uiText(`description逐项核验：未确认${name}；不得以Bullet或页面摘要代替描述。`, `Description check: ${name} not verified; bullets or page summaries cannot substitute for the description.`) : uiText("description为空，未提供独立产品描述。", "Description is empty; no standalone product description was provided.") })
    }
  }
  return { score: 3 - deductions.length, description: uiText(`${states.join("；")}。`, `${states.join(". ")}.`), deductions, assessment }
}

export function projectListingCriterionEvidence(
  dimensionIndex: number,
  criterionIndex: number,
  criterion: { assessment?: unknown; score?: unknown },
  source: ListingScoreSource
): ListingEvidenceProjection | undefined {
  const key = `${dimensionIndex}:${criterionIndex}`
  if (key === "0:0") return source.structuredAttributes?.length
    ? projectListingAttributeCriterion(criterion, { ...source, structuredAttributes: source.structuredAttributes }) : undefined
  if (!getListingEvidenceRequirement(dimensionIndex, criterionIndex)) return undefined
  // 空description是已确定的输入事实，直接按既有两项各扣1分；不让跨字段引用或漏填assessment阻断评分。
  if (key === "3:2" && !source.description.trim()) return projectDescription({
    checks: DESCRIPTION_CHECKS.map(checkId => ({ checkId, isPresent: false, quotes: [] })),
  }, source)
  if (!isRecord(criterion.assessment)) return fail(`Missing assessment for ${key}. Include item-level evidence even for full marks`)
  if (key === "1:2") return projectLongtail(criterion.assessment, source)
  if (key === "2:2") return projectMediumRelations(criterion.assessment, source)
  if (key === "3:1") return projectBulletData(criterion.assessment, source)
  return projectDescription(criterion.assessment, source)
}

export function getListingEvidenceError(
  dimensionIndex: number,
  criterionIndex: number,
  criterion: { assessment?: unknown; score?: unknown },
  source: ListingScoreSource
): string | null {
  try {
    const projected = projectListingCriterionEvidence(dimensionIndex, criterionIndex, criterion, source)
    if (projected && (typeof criterion.score !== "number" || Math.abs(projected.score - criterion.score) > 0.0001)) return "Use the score calculated from the individual source checks."
    return null
  } catch (error) { return error instanceof Error ? error.message : String(error) }
}
