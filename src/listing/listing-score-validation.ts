import { uiText } from "../common/i18n/request-language"
import { BadGatewayException } from "@nestjs/common"
import { parseListingJsonObject } from "./listing-result-parser"

import { isCdqScoreReport, normalizeCdqScoreReport } from "./listing-cdq-score"
import { normalizeUnavailableSearchTerms } from "./listing-search-terms-score"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 仅验证已有评分，不猜测得分、不补造理由、不触发模型重试。 */
export function validateListingScoreOutput(text: string): string {
  let result: Record<string, unknown>
  try {
    result = normalizeUnavailableSearchTerms(parseListingJsonObject(text))
  } catch {
    throw new BadGatewayException(uiText("AI 评分未返回完整 JSON，本次评分未扣费，请稍后重试", "The score response is not a complete JSON object. No credits were charged."))
  }
  if (isCdqScoreReport(result)) {
    try { return JSON.stringify(normalizeCdqScoreReport(result)) }
    catch { throw new BadGatewayException(uiText("CDQ评分数据与取证状态不一致，本次未扣费", "The CDQ score is inconsistent with its evidence status. No credits were charged.")) }
  }
  if (!Number.isFinite(result.total) || !Array.isArray(result.dimensions) || !result.dimensions.length) {
    throw new BadGatewayException(uiText("AI 评分数据格式异常，本次评分未扣费", "The score report has an invalid format. No credits were charged."))
  }
  for (const dimension of result.dimensions) {
    if (!isRecord(dimension) || !Array.isArray(dimension.criteria) || !dimension.criteria.length) {
      throw new BadGatewayException(uiText("AI 评分缺少细则，本次评分未扣费", "The score report is missing criteria. No credits were charged."))
    }
    for (const criterion of dimension.criteria) {
      if (!isRecord(criterion)) throw new BadGatewayException(uiText("AI 评分细则异常，本次评分未扣费", "The report contains an invalid criterion. No credits were charged."))
      const { score, maxScore } = criterion
      const deductions = criterion.deductions ?? []
      const fail = () => {
        throw new BadGatewayException(uiText("AI 评分的得分与扣分依据不一致，本次评分未扣费", "The score does not match its deductions. No credits were charged."))
      }
      if (typeof score !== "number" || !Number.isFinite(score) || typeof maxScore !== "number" ||
        !Number.isFinite(maxScore) || maxScore <= 0 || score < 0 || !Array.isArray(deductions)) fail()
      let deducted = 0
      for (const deduction of deductions as unknown[]) {
        if (!isRecord(deduction) || typeof deduction.points !== "number" ||
          !Number.isFinite(deduction.points) || deduction.points < 0 ||
          (deduction.points > 0 && (typeof deduction.reason !== "string" || !deduction.reason.trim()))) fail()
        deducted += (deduction as { points: number }).points
      }
      // 允许前端沿用既有的越界裁剪；但不允许无依据的低分通过。
      if (deducted > (maxScore as number) ||
        Math.abs(Math.min(score as number, maxScore as number) + deducted - (maxScore as number)) > 0.0001) fail()
      criterion.deductions = (deductions as Array<{ points: number }>).filter(deduction => deduction.points > 0)
    }
  }
  return JSON.stringify(result)
}
