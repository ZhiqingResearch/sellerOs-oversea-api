import { uiText } from "../i18n/request-language"
import { HttpException } from "@nestjs/common"

export const UPSTREAM_QUOTA_CODE = "UPSTREAM_QUOTA_EXHAUSTED"
export const QUOTA_NO_CHARGE_MESSAGE = "数据未获取，未扣除积分"
export type QuotaChargeState = "not_charged" | "charged" | "unknown"
export type QuotaScope = "operation" | "step" | "item" | "partial"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}

/** Only use on supplier responses, never on arbitrary user/billing exceptions. */
export function isQuotaResponse(value: unknown): boolean {
  const body = record(value)
  const nested = record(body.error)
  const data = record(body.data)
  const response = record(body.response)
  const payload = record(response.data)
  const payloadError = record(payload.error)
  const codes = [
    body.code,
    body.type,
    body.reason,
    nested.code,
    nested.type,
    data.reason,
    payload.code,
    payload.reason,
    payloadError.code,
    payloadError.type,
  ]
  if (
    codes.some(
      code =>
        typeof code === "string" &&
        /^(insufficient_quota|quota_exhausted|insufficient_balance|insufficient_credits|credit_balance_exhausted|billing_hard_limit_reached|monthly_exhausted|weekly_exhausted|payment_required|UPSTREAM_QUOTA_EXHAUSTED)$/i.test(
          code
        )
    )
  )
    return true
  if (body.status === 402 || body.statusCode === 402 || response.status === 402) return true
  const text = [
    typeof value === "string" ? value : "",
    body.message,
    nested.message,
    data.message,
    payload.message,
    payloadError.message,
    typeof response.data === "string" ? response.data : "",
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
  if (
    /(?:rate[ _-]*limit|per[ _-]*(?:minute|second)|requests? per|每(?:秒|分钟)|请求频率|限流)/i.test(
      text
    )
  )
    return false
  if (codes.some(code => typeof code === "string" && /^quota_exceeded$/i.test(code))) return true
  if (/credit[ _-]*card/i.test(text)) return false
  if (/^(?:余额不足|额度不足|配额不足|配额已耗尽|配额已用完)[。！!\s]*$/.test(text.trim()))
    return true
  return /(?:insufficient|not enough|exhausted|no|out of)[ _-]*(?:account[ _-]*)?(?:credits?|balance|quota)|(?:credits?|balance|quota)[ _-]*(?:is[ _-]*)?(?:exhausted|depleted|exceeded)|(?:账户|账号|服务|API|api).{0,8}(?:余额不足|额度不足|配额.{0,4}(?:用完|耗尽))|(?:月|周)(?:度)?(?:额度|配额).{0,4}(?:耗尽|用完)|\b(?:insufficient_quota|insufficient_balance)\b/i.test(
    text
  )
}

export class UpstreamQuotaError extends HttpException {
  readonly kind = "quota"
  constructor(
    readonly provider: string,
    status = 502,
    message = "数据未获取",
    cause?: unknown
  ) {
    super({ code: UPSTREAM_QUOTA_CODE, message }, status, { cause })
  }
}

export function isUpstreamQuotaError(error: unknown): boolean {
  const value = record(error)
  if (
    error instanceof UpstreamQuotaError ||
    value.kind === "quota" ||
    value.kind === "permanent_quota"
  )
    return true
  if (error instanceof HttpException)
    return record(error.getResponse()).code === UPSTREAM_QUOTA_CODE
  return false
}

export function quotaMessage(charge: QuotaChargeState, scope: QuotaScope = "operation"): string {
  if (scope === "partial") return uiText("部分数据未获取", "Some data is unavailable.")
  const prefix = scope === "step" ? "该步骤" : scope === "item" ? "该项" : ""
  const subject = scope === "step" ? "This step" : scope === "item" ? "This item" : "The request"
  return charge === "not_charged"
    ? uiText(`${prefix}${QUOTA_NO_CHARGE_MESSAGE}`, `${subject} returned no data. No credits were charged.`)
    : uiText(`${prefix}数据未获取`, `${subject} returned no data.`)
}

/** The business call site supplies charge facts; providers cannot promise no charge. */
export function quotaFailure(
  error: unknown,
  charge: QuotaChargeState,
  scope: QuotaScope = "operation"
): unknown {
  if (!isUpstreamQuotaError(error)) return error
  const status = error instanceof HttpException ? error.getStatus() : 502
  return new UpstreamQuotaError(
    error instanceof UpstreamQuotaError ? error.provider : "upstream",
    status,
    quotaMessage(charge, scope),
    error
  )
}

export async function beforeQuotaCharge<T>(
  call: Promise<T>,
  scope: QuotaScope = "operation"
): Promise<T> {
  try {
    return await call
  } catch (error) {
    throw quotaFailure(error, "not_charged", scope)
  }
}

export async function* streamBeforeQuotaCharge<T>(
  stream: AsyncIterable<T>,
  scope: QuotaScope = "operation"
): AsyncGenerator<T> {
  try {
    yield* stream
  } catch (error) {
    throw quotaFailure(error, "not_charged", scope)
  }
}

/** Supplier task errors have separate billing facts, including partially delivered batches. */
export function quotaTaskMessage(
  error: unknown,
  charge: QuotaChargeState,
  fallback: string,
  scope: QuotaScope = "operation"
): string {
  return isUpstreamQuotaError(error) ||
    (!(error instanceof HttpException) && isQuotaResponse(error))
    ? quotaMessage(charge, scope)
    : fallback
}
