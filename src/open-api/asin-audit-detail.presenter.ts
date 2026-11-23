import { createHash } from "node:crypto"
import { auditLabel } from "../asin-audit/audit-labels"
import { uiText } from "../common/i18n/request-language"
import {
  auditNumber,
  auditObject,
  auditRows,
  auditText,
  auditTexts,
  type AuditEvidenceSnapshot,
  type AuditObject,
} from "./asin-audit-detail.utils"
import {
  buildAuditKeywords,
  buildAuditTrends,
  buildListingFacts,
} from "./asin-audit-evidence.presenter"
import { cleanOptimizationText } from "./computer-audit/computer-audit.kernel"

const DETAIL_VERSION = "asin-diagnosis-detail-v1"
const PRIORITY_VERSION = "asin-diagnosis-priority-v1"
const IMPORTANT_COMPUTER_RULES = new Set(["A1", "E1", "F1", "F3", "G1", "G3", "I3"])
const IMPORTANT_AUTOMOTIVE_RULES = new Set([
  "M1-2.2",
  "M1-2.3",
  "M1-3.1",
  "M1-3.2",
  "M1-3.3",
  "M1-5.1",
  "M2-2.1.1",
  "M2-2.1.2",
  "M2-2.2.1",
])

function detailId(taskId: string, kind: string, domain: string, ruleCode: string) {
  return `${kind}_${createHash("sha256")
    .update(JSON.stringify([taskId, domain, ruleCode]))
    .digest("hex")
    .slice(0, 24)}`
}

function evidenceRows(value: unknown): { reference: string | null; quote: string | null }[] {
  return auditRows(value)
    .map(item => ({
      reference:
        (auditText(item.ref) ??
          auditText(item.path) ??
          auditText(item.field) ??
          auditLabel(auditText(item.name) ?? "")) ||
        null,
      quote: auditText(item.quote) ?? auditText(item.value) ?? auditText(item.category),
    }))
    .filter(item => item.reference !== null || item.quote !== null)
}

function gapRows(value: unknown, domain: string) {
  return auditRows(value).map(gap => ({
    domain: domain === "automotive" ? (String(gap.ruleId).startsWith("M2") ? "oe" : "cdq") : domain,
    ruleCode: auditText(gap.ruleId),
    name: auditLabel(auditText(gap.name) ?? "") || null,
    reason: auditText(gap.reason),
    excludedPoints: auditNumber(gap.excludedPoints),
    confirmedDeductedPoints: auditNumber(gap.confirmedDeductedPoints),
    missingData: auditRows(gap.missingData).map(item => ({
      data: auditText(item.data),
      remedy: auditText(item.remedy),
      location: auditText(item.location),
    })),
  }))
}

function buildChecks(result: AuditObject, auditType: string, taskId: string) {
  const rows =
    auditType === "COMPUTER"
      ? ["listing", "keywordTraffic"].flatMap(domain =>
          auditRows(auditObject(result[domain]).boards).flatMap(board =>
            auditRows(board.items).map(item => ({ domain, board, item }))
          )
        )
      : auditRows(result.rules).map(item => ({
          domain: String(item.ruleId).startsWith("M2") ? "oe" : "cdq",
          board: { id: item.dimensionCode, name: item.dimensionCode },
          item,
        }))
  return rows.flatMap(({ domain, board, item }) => {
    const ruleCode = auditText(item.ruleId) ?? auditText(item.id)
    if (!ruleCode) return []
    const isComputer = auditType === "COMPUTER"
    const deductions = isComputer
      ? auditRows(item.deductions)
      : auditRows(result.deductions).filter(d => d.ruleId === ruleCode)
    const deductedPoints = isComputer
      ? Math.max(
          auditNumber(item.confirmedDeductedPoints) ?? 0,
          deductions.reduce((sum, d) => sum + Math.max(0, auditNumber(d.points) ?? 0), 0)
        )
      : auditNumber(item.deductedPoints)
    const isVeto = !isComputer && auditRows(result.vetoItems).some(v => v.ruleId === ruleCode)
    const rawStatus = auditText(item.status) ?? "UNKNOWN"
    const hasEvidenceLimits =
      item.hasEvidenceLimits === true || ["pending", "UNVERIFIED", "PARTIAL"].includes(rawStatus)
    const isFailed = isVeto || (deductedPoints ?? 0) > 0 || ["FAIL", "FAILED"].includes(rawStatus)
    const status = hasEvidenceLimits
      ? isFailed
        ? "PARTIAL"
        : "INSUFFICIENT_EVIDENCE"
      : ["NA", "N/A", "na", "not_applicable"].includes(rawStatus)
        ? "NOT_APPLICABLE"
        : isFailed
          ? "FAIL"
          : ["PASS", "verified", "PASS_WITH_NOTE"].includes(rawStatus)
            ? "PASS"
            : "UNKNOWN"
    const reasons = deductions.flatMap(d => auditText(d.reason) ?? [])
    const reason =
      [
        ...new Set(
          [
            ...reasons,
            auditText(item.reason),
            auditText(item.pendingReason),
            auditText(item.naReason),
          ].filter((text): text is string => text !== null)
        ),
      ].join("；") || null
    return [
      {
        checkId: detailId(taskId, "check", domain, ruleCode),
        domain,
        ruleCode,
        name: auditLabel(auditText(item.name) ?? "") || null,
        dimensionCode: auditText(board.id),
        dimensionName: auditLabel(auditText(board.name) ?? "") || null,
        kind: isComputer ? "SCORE" : auditText(item.kind),
        status,
        rawStatus,
        hasEvidenceLimits,
        isVeto,
        score: auditNumber(isComputer ? item.score : item.earnedPoints),
        maxScore: auditNumber(isComputer ? item.maxScore : item.maxPoints),
        evaluatedMaxScore: auditNumber(isComputer ? item.evaluatedMaxScore : item.evaluatedPoints),
        evaluatedEarnedScore: auditNumber(
          isComputer ? item.evaluatedEarnedScore : item.earnedPoints
        ),
        deductedPoints,
        reason,
        deductionReasons: reasons,
        basis: {
          type: "STORED_AUDIT_RULE",
          ruleCode,
          ruleVersion: auditText(result.ruleVersion),
          explanation: reason,
          evidence: evidenceRows(item.evidence),
          checks: auditRows(item.checks).map(check => ({
            name: auditLabel(auditText(check.name) ?? "") || null,
            status: auditText(check.status),
            detail: auditText(check.detail),
            evidence: evidenceRows(check.evidence),
          })),
          // Historical computer rows contain adjudications, but not always source-located quotations.
          evidenceStatus:
            evidenceRows(item.evidence).length || auditRows(item.checks).length
              ? "SOURCE_DETAILS_AVAILABLE"
              : "STORED_JUDGMENT_ONLY",
        },
      },
    ]
  })
}

function buildRecommendations(result: AuditObject, auditType: string, taskId: string) {
  if (auditType !== "COMPUTER") return []
  const listing = auditObject(auditObject(result.listing).optimization)
  const traffic = auditObject(auditObject(result.keywordTraffic).optimization)
  return [
    ...auditRows(listing.actions).map(item => ({
      domain: "listing",
      ruleCode: null as string | null,
      title: auditText(item.title),
      action: auditText(item.action),
    })),
    ...auditRows(listing.fieldRewrites).map(item => ({
      domain: "listing",
      ruleCode: null as string | null,
      title: auditText(item.field),
      action: auditText(item.reason),
    })),
    ...auditRows(traffic.suggestions).map(item => ({
      domain: "keywordTraffic",
      ruleCode: auditText(item.ruleId),
      title: auditText(item.ruleId),
      action: auditText(item.summary),
    })),
  ]
    .filter(item => item.action)
    .map(item => ({
      ...item,
      title: item.title ? cleanOptimizationText(item.title) : null,
      action: cleanOptimizationText(item.action!),
      recommendationId: detailId(
        taskId,
        "recommendation",
        item.domain,
        JSON.stringify([item.ruleCode, item.title, item.action])
      ),
      sourceType: "STORED_AUDIT_RECOMMENDATION",
    }))
}

function buildConfiguration(result: AuditObject) {
  const config = auditObject(result.configurationReview)
  const numbers = (value: unknown) =>
    Array.isArray(value) ? value.flatMap(item => auditNumber(item) ?? []) : []
  const evidence = (value: unknown) =>
    auditRows(value).map(item => ({
      field: auditText(item.field),
      kind: auditText(item.kind),
      quote: auditText(item.quote),
      capacityGb: auditNumber(item.capacityGb),
    }))
  return {
    status: auditText(config.status) ?? "INSUFFICIENT_EVIDENCE",
    conclusion: auditText(config.summary),
    differences: auditRows(config.differences).map(item => ({
      field: auditText(item.field),
      expectedValues: numbers(item.expectedValues),
      actualValues: numbers(item.actualValues),
      reason: auditText(item.reason),
      evidence: evidence(item.evidence),
    })),
    expectedConfigurations: auditRows(config.expectedConfigurations).map(item => ({
      ramGb: auditNumber(item.ramGb),
      storageGb: auditNumber(item.storageGb),
    })),
    observedConfigurations: auditRows(config.observedConfigurations).map(item => ({
      source: auditText(item.source),
      ramGb: numbers(item.ramGb),
      storageGb: numbers(item.storageGb),
    })),
    evidence: evidence(config.evidence),
    hasPairMismatch: config.hasPairMismatch === true,
    missingData: auditTexts(config.dataGaps),
    ambiguities: auditTexts(config.ambiguities),
  }
}

/** Pure read model. Does not rescore, retrieve upstream data or write the task. */
export function buildAuditDetailView(
  taskId: string,
  auditType: string,
  asin: string,
  value: unknown,
  snapshots: AuditEvidenceSnapshot[],
  windowDays = 30
) {
  const result = auditObject(value)
  const checks = buildChecks(result, auditType, taskId)
  const recommendations = buildRecommendations(result, auditType, taskId)
  const dataGaps =
    auditType === "COMPUTER"
      ? ["listing", "keywordTraffic"].flatMap(domain =>
          gapRows(auditObject(result[domain]).dataGaps, domain)
        )
      : gapRows(result.dataGaps, "automotive")
  const config = buildConfiguration(result)
  const consistency = auditObject(auditObject(result.listing).consistencyCheck)
  const hasConfigurationConflict =
    auditType === "COMPUTER" &&
    (config.status === "MISMATCH" || consistency.hasContradiction === true)
  const issueChecks = checks.filter(
    check => check.isVeto || (check.deductedPoints ?? 0) > 0 || check.status === "FAIL"
  )
  // A configuration/content conflict is one F1 issue, even if it is also exposed in the configuration tab.
  if (hasConfigurationConflict && !issueChecks.some(check => check.ruleCode === "F1")) {
    const existing = checks.find(check => check.ruleCode === "F1")
    if (existing) issueChecks.push(existing)
  }
  const issues = issueChecks.map(check => {
    const isCritical = check.isVeto || (check.ruleCode === "F1" && hasConfigurationConflict)
    const isImportant = (
      auditType === "COMPUTER" ? IMPORTANT_COMPUTER_RULES : IMPORTANT_AUTOMOTIVE_RULES
    ).has(check.ruleCode)
    const priority = isCritical ? "P0" : isImportant ? "P1" : "P2"
    const associated = recommendations.filter(
      item => item.domain === check.domain && item.ruleCode === check.ruleCode
    )
    return {
      issueId: detailId(taskId, "issue", check.domain, check.ruleCode),
      ruleCode: check.ruleCode,
      domain: check.domain,
      priority,
      priorityBasis: isCritical
        ? uiText(
            "确认的一票否决或正确配置/标题内容冲突",
            "Confirmed veto or conflict with verified configuration or title"
          )
        : isImportant
          ? uiText(
              "优先级规则表中的核心规格、主图或可见度规则",
              "Priority rule for core specifications, the main image or visibility"
            )
          : uiText(
              "优先级规则表中的其他已确认改进项",
              "Other confirmed improvement in the priority rules"
            ),
      title: check.name,
      explanation:
        check.ruleCode === "F1" && hasConfigurationConflict
          ? [
              check.reason,
              config.status === "MISMATCH" ? config.conclusion : null,
              auditText(consistency.summary),
            ]
              .filter(Boolean)
              .join("；")
          : check.reason,
      deductedPoints: check.deductedPoints,
      checkId: check.checkId as string | null,
      hasEvidenceLimits: check.hasEvidenceLimits,
      basis: check.basis,
      missingEvidence: dataGaps.filter(gap => gap.ruleCode === check.ruleCode),
      suggestedAction: associated.length
        ? associated.map(item => item.action).join("；")
        : `根据核查依据修正「${check.name ?? check.ruleCode}」涉及的已确认问题，并在修改后复核。`,
      actionSource: associated.length ? "STORED_RULE_RECOMMENDATION" : "RULE_REMEDIATION_TEMPLATE",
    }
  })
  if (hasConfigurationConflict && !issues.some(issue => issue.ruleCode === "F1")) {
    issues.push({
      issueId: detailId(taskId, "issue", "configuration", "CONFIGURATION_CONFLICT"),
      ruleCode: "CONFIGURATION_CONFLICT",
      domain: "configuration",
      priority: "P0",
      priorityBasis: uiText(
        "确认的正确配置/标题内容冲突",
        "Confirmed configuration or title conflict"
      ),
      title: uiText("链接配置或内容矛盾", "Listing configuration or content conflict"),
      explanation: config.conclusion ?? auditText(consistency.summary),
      deductedPoints: null,
      checkId: null,
      hasEvidenceLimits: config.missingData.length > 0,
      basis: {
        type: "STORED_AUDIT_RULE",
        ruleCode: "CONFIGURATION_CONFLICT",
        ruleVersion: auditText(result.ruleVersion),
        explanation: config.conclusion,
        evidence: [],
        checks: [],
        evidenceStatus: "STORED_JUDGMENT_ONLY",
      },
      missingEvidence: [],
      suggestedAction: uiText(
        "核对正确配置与平台内容，修正已确认的配置冲突。",
        "Compare the verified configuration with the listing and correct the confirmed conflict."
      ),
      actionSource: "RULE_REMEDIATION_TEMPLATE",
    })
  }
  issues.sort(
    (a, b) => a.priority.localeCompare(b.priority) || a.ruleCode.localeCompare(b.ruleCode)
  )
  const unavailable = (reason: string) => ({ status: "NOT_CONNECTED", reason })
  return {
    schemaVersion: DETAIL_VERSION,
    reportId: taskId,
    ruleVersion: auditText(result.ruleVersion),
    priorityPolicyVersion: PRIORITY_VERSION,
    ...(result.completionStatus === "PARTIAL"
      ? { completionStatus: "PARTIAL", outputGaps: auditTexts(result.outputGaps) }
      : {}),
    ...(auditType === "COMPUTER" && Array.isArray(result.missingScoreFields)
      ? { missingScoreFields: auditTexts(result.missingScoreFields) }
      : {}),
    scoreScope: {
      mode:
        result.completionStatus === "PARTIAL"
          ? "ORIGINAL_PARTIAL_AUDIT"
          : "ORIGINAL_COMPLETED_AUDIT",
      isRecalculated: false,
      explanation: uiText(
        "得分、扣分及问题来自已完成审计；windowDays只筛选已保存的日级趋势，不重算审计或将月汇总改成周数据",
        "Scores, deductions and issues come from the completed audit. windowDays filters saved daily trends only."
      ),
    },
    issues,
    issueCounts: {
      P0: issues.filter(i => i.priority === "P0").length,
      P1: issues.filter(i => i.priority === "P1").length,
      P2: issues.filter(i => i.priority === "P2").length,
    },
    checks,
    dataGaps,
    recommendations,
    configuration:
      auditType === "COMPUTER"
        ? config
        : {
            ...buildConfiguration({}),
            status: "NOT_APPLICABLE",
            conclusion: uiText(
              "汽配使用自身规则核查，不使用电脑内存/硬盘配置审查",
              "Automotive audits use automotive rules. Computer RAM and storage checks do not apply."
            ),
          },
    consistency:
      auditType === "COMPUTER"
        ? {
            hasContradiction:
              typeof consistency.hasContradiction === "boolean"
                ? consistency.hasContradiction
                : null,
            summary: auditText(consistency.summary),
            checkedSources: auditTexts(consistency.checkedSources),
            missingSources: auditTexts(consistency.missingSources),
            contradictions: auditRows(consistency.contradictions).map(item => ({
              field: auditText(item.field),
              titleQuote: auditText(item.titleQuote),
              contentQuote: auditText(item.contentQuote),
              explanation: auditText(item.explanation),
            })),
          }
        : null,
    listingFacts: buildListingFacts(asin, snapshots),
    trends: buildAuditTrends(asin, snapshots, windowDays),
    keywords: buildAuditKeywords(asin, snapshots, auditObject(result.keywordTraffic).optimization),
    businessModules: {
      advertising: unavailable(
        uiText(
          "未接入实际广告花费、曝光、点击、订单、销售额及归因周期",
          "Ad spend, impressions, clicks, orders, sales and attribution periods are unavailable."
        )
      ),
      profit: unavailable(
        uiText(
          "未接入订单收入、真实成本、费用与广告分摊数据",
          "Order revenue, costs, fees and allocated advertising spend are unavailable."
        )
      ),
      inventory: unavailable(
        uiText(
          "未接入企业库存池、子体映射、可售、在途、需求及补货参数",
          "Enterprise inventory, variation mapping, available and incoming stock, demand and replenishment parameters are unavailable."
        )
      ),
      trafficSources: unavailable(
        uiText(
          "未接入SP推荐来源页面和完整变体流量分布",
          "Sponsored Products referral pages and complete variation traffic shares are unavailable."
        )
      ),
    },
  }
}
