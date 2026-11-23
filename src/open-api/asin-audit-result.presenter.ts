import { auditLabel } from "../asin-audit/audit-labels"
import { uiLanguage, uiText } from "../common/i18n/request-language"
import { cleanOptimizationText } from "./computer-audit/computer-audit.kernel"

type AuditRecord = Record<string, unknown>

function asRecord(value: unknown): AuditRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AuditRecord) : {}
}

function asRecords(value: unknown): AuditRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function joinLines(values: string[]): string | null {
  return [...new Set(values.filter(Boolean))].join("\n") || null
}

function getValidity(value: unknown): boolean | null {
  const status = asRecord(value).status
  return status === "VALID" ? true : status === "INVALID" ? false : null
}

/** Presentation only: never reevaluate rules or mutate the stored audit snapshot. */
function buildGapRemarks(value: unknown): string | null {
  return joinLines(
    asRecords(value).map(gap => {
      const missing = asRecords(gap.missingData)
        .map(item => asText(item.data))
        .filter(Boolean)
      const reason = missing.length ? missing.join("、") : asText(gap.reason)
      const confirmed = asNumber(gap.confirmedDeductedPoints) ?? 0
      if (uiLanguage() === "en-US")
        return `${asText(gap.ruleId)} ${auditLabel(asText(gap.name))}: ${reason || "Insufficient evidence"}. ${confirmed > 0 ? `Confirmed deduction: ${confirmed} points. Further deductions are unverified.` : "Deductions and vetoes cannot be verified without evidence."}`.trim()
      return `${asText(gap.ruleId)} ${auditLabel(asText(gap.name))}：${reason || "缺少核查依据"}${confirmed > 0 ? `；已确认扣${confirmed}分，剩余部分缺证据，不能确认是否另有扣分。` : "；缺证据部分不能确认是否扣分或触发否决。"}`.trim()
    })
  )
}

export interface AutomotiveAuditResultView {
  score: number | null
  grade: string | null
  isAsinValid: boolean | null
  isSkuValid: boolean | null
  vetoSummary: string | null
  optimizationSummary: string | null
  coverageRate: number | null
  remarks: string | null
}

function buildAutomotiveResult(result: AuditRecord): AutomotiveAuditResultView {
  const summary = asRecord(result.summary)
  const validation = asRecord(result.validation)
  const vetoes = asRecords(result.vetoItems).map(
    item => `${asText(item.ruleId)} ${auditLabel(asText(item.name))}：${asText(item.reason)}`
  )
  const deductions = asRecords(result.deductions)
    .filter(item => (asNumber(item.points) ?? 0) > 0)
    .map(item =>
      uiText(
        `${asText(item.ruleId)} ${auditLabel(asText(item.name))}（扣${asNumber(item.points) ?? 0}分）：${asText(item.reason)}`,
        `${asText(item.ruleId)} ${auditLabel(asText(item.name))} (deduct ${asNumber(item.points) ?? 0} points): ${asText(item.reason)}`
      )
    )
  return {
    score: asNumber(summary.score),
    grade: asText(summary.grade) || null,
    isAsinValid: getValidity(validation.asin),
    isSkuValid: getValidity(validation.sku),
    vetoSummary: joinLines(vetoes),
    optimizationSummary: joinLines([
      ...vetoes.map(text =>
        uiText(`一票否决（最终0分/D）：${text}`, `Veto (final score 0/D): ${text}`)
      ),
      ...deductions,
    ]),
    coverageRate: asNumber(summary.coverageRate),
    remarks: joinLines([
      ...["asin", "sku"]
        .filter(key => getValidity(validation[key]) === null)
        .map(key =>
          uiText(
            `${key.toUpperCase()}有效性：${asText(asRecord(validation[key]).reason) || "缺少独立核验依据"}`,
            `${key.toUpperCase()} validity: ${asText(asRecord(validation[key]).reason) || "No independent verification"}`
          )
        ),
      buildGapRemarks(result.dataGaps) ?? "",
    ]),
  }
}

export interface AuditDomainView {
  status: string
  score: number | null
  diagnosis: string
  deductionSummary: string | null
  optimizationSuggestions: string | null
  coverageRate: number | null
  remarks: string | null
}

function buildDeductionSummary(part: AuditRecord): string | null {
  const groups = new Map<string, { name: string; points: number; lines: string[] }>()
  for (const item of asRecords(part.deductions)) {
    const points = asNumber(item.points) ?? 0
    if (points <= 0) continue
    const boardId = asText(item.boardId)
    const board = asRecords(part.boards).find(row => row.id === boardId)
    const group = groups.get(boardId) ?? {
      name: auditLabel(asText(board?.name)),
      points: 0,
      lines: [],
    }
    group.points += points
    group.lines.push(
      uiText(
        `${asText(item.ruleId)} ${auditLabel(asText(item.name))}：扣${points}分；${asText(item.reason)}`,
        `${asText(item.ruleId)} ${auditLabel(asText(item.name))}: deduct ${points} points. ${asText(item.reason)}`
      )
    )
    groups.set(boardId, group)
  }
  return joinLines(
    [...groups].map(([id, group]) =>
      uiText(
        `${id} ${group.name}（合计扣${Number(group.points.toFixed(4))}分）\n${group.lines.join("\n")}`,
        `${id} ${group.name} (total deduction: ${Number(group.points.toFixed(4))} points)\n${group.lines.join("\n")}`
      ).trim()
    )
  )
}

function buildOptimizationSuggestions(value: unknown, isListing: boolean): string | null {
  const optimization = asRecord(value)
  const lines: string[] = []
  if (isListing) {
    for (const item of asRecords(optimization.actions))
      lines.push([asText(item.title), asText(item.action)].filter(Boolean).join("："))
    for (const item of asRecords(optimization.fieldRewrites))
      lines.push([asText(item.field), asText(item.reason)].filter(Boolean).join("："))
    for (const key of ["imageSellingPoints", "aplusModules", "differentiationUSPs"]) {
      for (const item of asRecords(optimization[key]))
        lines.push(
          [
            asText(item.name) || asText(item.title),
            asText(item.description) || asText(item.analysis),
          ]
            .filter(Boolean)
            .join("：")
        )
    }
  } else {
    for (const item of asRecords(optimization.suggestions))
      lines.push([asText(item.ruleId), asText(item.summary)].filter(Boolean).join("："))
    for (const item of asRecords(optimization.keywordTiers)) {
      const keywords = Array.isArray(item.keywords) ? item.keywords.map(asText).filter(Boolean) : []
      if (keywords.length)
        lines.push(
          uiText(
            `建议关键词（${asText(item.label) || asText(item.tier)}）：${keywords.join("、")}`,
            `Suggested keywords (${asText(item.label) || asText(item.tier)}): ${keywords.join(", ")}`
          )
        )
    }
    for (const item of asRecords(optimization.reviewStrategies))
      lines.push([asText(item.painPoint), asText(item.improvement)].filter(Boolean).join("："))
  }
  return joinLines(lines.map(cleanOptimizationText))
}

function buildDomain(part: AuditRecord, isListing: boolean): AuditDomainView {
  const status = asText(part.status) || "INSUFFICIENT_EVIDENCE"
  const isSkipped = status === "SKIPPED"
  return {
    status,
    score: isSkipped ? null : asNumber(part.score),
    diagnosis: asText(part.diagnosis) || asText(part.reason),
    deductionSummary: isSkipped ? null : buildDeductionSummary(part),
    optimizationSuggestions: isSkipped
      ? null
      : buildOptimizationSuggestions(part.optimization, isListing),
    coverageRate: isSkipped ? null : asNumber(asRecord(part.scoring).coverageRate),
    remarks: isSkipped ? asText(part.reason) || null : buildGapRemarks(part.dataGaps),
  }
}

export interface ComputerAuditResultView {
  completionStatus?: "PARTIAL"
  outputGaps?: string[]
  missingScoreFields?: string[]
  isSoldOut: boolean | null
  listing: AuditDomainView & { consistencyConclusion: string | null }
  keywordTraffic: AuditDomainView
  configurationReview: { status: string; conclusion: string | null; remarks: string | null }
}

function buildComputerResult(result: AuditRecord): ComputerAuditResultView {
  const listing = asRecord(result.listing)
  const listingView = buildDomain(listing, true)
  const consistency = asRecord(listing.consistencyCheck)
  const configuration = asRecord(result.configurationReview)
  return {
    ...(result.completionStatus === "PARTIAL"
      ? {
          completionStatus: "PARTIAL" as const,
          outputGaps: Array.isArray(result.outputGaps) ? result.outputGaps.map(asText) : [],
        }
      : {}),
    ...(Array.isArray(result.missingScoreFields)
      ? { missingScoreFields: result.missingScoreFields.map(asText) }
      : {}),
    isSoldOut: typeof result.isSoldOut === "boolean" ? result.isSoldOut : null,
    listing: {
      ...listingView,
      remarks: joinLines([
        listingView.remarks ?? "",
        Array.isArray(consistency.missingSources) && consistency.missingSources.length
          ? uiText(
              `内容一致性核查缺少：${consistency.missingSources.map(asText).join("、")}；结论仅覆盖已提供的正文。`,
              `Missing sources: ${consistency.missingSources.map(asText).join(", ")}. Consistency findings cover the provided text only.`
            )
          : "",
      ]),
      consistencyConclusion: joinLines([
        asText(consistency.summary),
        ...asRecords(consistency.contradictions).map(item =>
          uiText(
            `标题「${asText(item.titleQuote)}」与${asText(item.field)}「${asText(item.contentQuote)}」：${asText(item.explanation)}`,
            `Title “${asText(item.titleQuote)}” and ${asText(item.field)} “${asText(item.contentQuote)}”: ${asText(item.explanation)}`
          )
        ),
      ]),
    },
    keywordTraffic: buildDomain(asRecord(result.keywordTraffic), false),
    configurationReview: {
      status: asText(configuration.status) || "INSUFFICIENT_EVIDENCE",
      conclusion: asText(configuration.summary) || null,
      remarks: joinLines(
        [configuration.dataGaps, configuration.ambiguities].flatMap(items =>
          Array.isArray(items) ? items.map(asText) : []
        )
      ),
    },
  }
}

export function buildAuditResultView(auditType: string, value: unknown) {
  if (value === null || value === undefined) return null
  const result = asRecord(value)
  return auditType === "COMPUTER" ? buildComputerResult(result) : buildAutomotiveResult(result)
}
