import { isDeepStrictEqual } from "node:util"

export interface ListingPlanSnapshot extends Record<string, unknown> {
  planIndex?: number
  result?: Record<string, unknown>
  score?: number | null
  scoreResult?: { total?: unknown; suggestions?: unknown[] }
  optimization?: Record<string, unknown>
}

export function getOptimizationPlan(
  data: Record<string, unknown>,
  planIndex: number
): ListingPlanSnapshot | undefined {
  if (Array.isArray(data.plans)) {
    return (
      (data.plans as (ListingPlanSnapshot | null)[]).find(
        (plan, index) => plan && (plan.planIndex ?? index) === planIndex
      ) ?? undefined
    )
  }
  return planIndex === 0 && data.result
    ? {
        result: data.result as Record<string, unknown>,
        scoreResult: data.scoreResult as ListingPlanSnapshot["scoreResult"],
        score: data.score as number | undefined,
      }
    : undefined
}

export function hasComparableScore(score: unknown): score is number {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100
}

function normalizeCopyValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ") || null
  if (Array.isArray(value)) return value.length ? value.map(normalizeCopyValue) : null
  return value ?? null
}

/** Ignore only our attempt receipt; changes to any source content invalidate adoption. */
export function isOptimizationSourceCurrent(
  current: ListingPlanSnapshot | undefined,
  baseline: ListingPlanSnapshot
): boolean {
  if (!current) return false
  const currentContent = { ...current }
  const baselineContent = { ...baseline }
  delete currentContent.optimization
  delete currentContent.planIndex
  delete baselineContent.optimization
  delete baselineContent.planIndex
  return isDeepStrictEqual(currentContent, baselineContent)
}

export function buildOptimizationPlan(
  current: ListingPlanSnapshot,
  baseline: ListingPlanSnapshot,
  attemptId: string,
  result?: Record<string, unknown>,
  scoreResult?: Record<string, unknown>,
  error?: string
): ListingPlanSnapshot & { optimization: Record<string, unknown> } {
  const previousScore = baseline.scoreResult?.total
  const candidateScore = scoreResult?.total
  const fields = [
    "title",
    "description",
    "bullets",
    "itemHighlights",
    "searchTerms",
    "structuredAttributes",
    "keyFeatures",
    "productAttributes",
    "shortDescription",
    "productHighlights",
    "modules",
    "attributes",
    "highlights",
    "hashtags",
    "characteristics",
    "searchClusters",
    "itemSpecifics",
    "keywords",
    "descriptionSections",
  ]
  const hasChanges =
    result &&
    fields.some(
      field =>
        !isDeepStrictEqual(
          normalizeCopyValue(result[field]),
          normalizeCopyValue(baseline.result?.[field])
        )
    )
  const status = !isOptimizationSourceCurrent(current, baseline)
    ? "STALE"
    : !result
      ? "FAILED"
      : !hasComparableScore(candidateScore) || !hasComparableScore(previousScore)
        ? "SCORE_FAILED"
        : candidateScore < previousScore
          ? "REJECTED"
          : !hasChanges
            ? "UNCHANGED"
            : "ACCEPTED"
  const retained = { ...current }
  if (status === "ACCEPTED") {
    delete retained.genThinking
    delete retained.scoreThinking
  }
  return {
    ...retained,
    ...(status === "ACCEPTED"
      ? {
          result,
          scoreResult,
          score: candidateScore as number,
        }
      : {}),
    optimization: {
      attemptId,
      status,
      previousScore,
      candidateScore: candidateScore ?? null,
      ...(result ? { candidateResult: result } : {}),
      ...(scoreResult ? { candidateScoreResult: scoreResult } : {}),
      ...(error ? { error } : {}),
    },
  }
}
