import { Prisma } from "@prisma/client"
import { createHash } from "node:crypto"

export function costObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function auditCostKey(taskId: number, provider: string, sourceId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["asin-actual-cost-v1", taskId, provider, sourceId]))
    .digest("hex")
}

/** No token-price estimates, model markup, credit conversion or fabricated zero invoices. */
export function actualGatewayCost(value: unknown): Prisma.Decimal | null {
  const billing = costObject(value)
  if (
    billing.estimated === true ||
    billing.currency !== "CNY" ||
    typeof billing.requestId !== "string" ||
    !billing.requestId.trim()
  )
    return null
  if (typeof billing.costCny !== "string" && typeof billing.costCny !== "number") return null
  if (String(billing.costCny).trim() === "") return null
  try {
    const amount = new Prisma.Decimal(billing.costCny)
    return amount.isFinite() && amount.gte(0) && amount.lt(1000000)
      ? amount.toDecimalPlaces(6)
      : null
  } catch {
    return null
  }
}

export function tokenCount(usage: unknown, ...keys: string[]): number | null {
  const data = costObject(usage)
  for (const key of keys) {
    const value = data[key]
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 2147483647
    )
      return value
  }
  return null
}

export function modelCostUsage(billingValue: unknown, tokens: unknown, state: string) {
  const billing = costObject(billingValue)
  const amount = actualGatewayCost(billing)
  return {
    costCny: amount,
    costStatus: amount === null ? "UNKNOWN" : "KNOWN",
    usage: {
      state,
      promptTokens: tokenCount(
        tokens,
        "prompt_tokens",
        "input_tokens",
        "promptTokens",
        "promptTokenCount"
      ),
      completionTokens: tokenCount(
        tokens,
        "completion_tokens",
        "output_tokens",
        "completionTokens",
        "candidatesTokenCount"
      ),
      thinkingTokens:
        tokenCount(tokens, "thinking_tokens", "thinkingTokens", "thoughtsTokenCount") ??
        tokenCount(costObject(tokens).completion_tokens_details, "reasoning_tokens"),
      gatewayRequestId: typeof billing.requestId === "string" ? billing.requestId : null,
      gatewayRequestIds: Array.isArray(billing.requestIds)
        ? billing.requestIds.filter(id => typeof id === "string")
        : [],
      upstreamCostCny: amount === null ? null : String(billing.costCny),
      currency: amount === null ? null : "CNY",
      missingReason:
        amount === null ? "未取得有效的上游人民币账单；金额未知，不按token估价、不记为免费" : null,
    },
  }
}

export interface AuditEvidenceReceipt {
  provider: string
  state: string
  httpStatus: number | null
  businessCode: unknown
  consumedQuota: unknown
  mcpIsError?: unknown
  mcpContent?: unknown
  hasResponse?: boolean | number | bigint
  endpoint?: string | null
  errorCode?: string | null
  toolName?: string | null
}

/** Only supplier-returned quota; absent/invalid values are not zero. */
export function actualQuota(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "")
    return null
  const quota = Number(value)
  return Number.isFinite(quota) && quota >= 0 && quota <= Number.MAX_SAFE_INTEGER ? quota : null
}

export function mcpEstimate(
  usage: Record<string, unknown>,
  price: {
    markupPriceCny: unknown
    updatedAt: Date | string
    active: boolean
    unit: string
  } | null,
  capturedAt: Date
) {
  const snapshot =
    price && price.active && price.unit === "call"
      ? actualQuota(String(price.markupPriceCny))
      : null
  // Match the project's successful-tool-call pricing. Failed/unknown outcomes have no billing evidence.
  const isEstimable = usage.successfulCalls === 1 && snapshot !== null
  return {
    estimateVersion: 1,
    estimateStatus: isEstimable ? "ESTIMATED" : "UNKNOWN",
    estimatedCostCny: isEstimable
      ? new Prisma.Decimal(String(price!.markupPriceCny)).toDecimalPlaces(6).toString()
      : null,
    estimateUnitPriceCny: snapshot === null ? null : String(price!.markupPriceCny),
    estimatePriceKey: "MCP_CALL",
    estimatePriceUpdatedAt: snapshot === null ? null : new Date(price!.updatedAt).toISOString(),
    estimateCapturedAt: capturedAt.toISOString(),
    estimateBasis: "PROJECT_SUCCESSFUL_CALL_PRICE",
    estimateReason: isEstimable
      ? "项目配置单价×已确认成功调用次数，仅为估算费用，非供应商实际账单；历史回执按首次归集时配置估算"
      : snapshot === null
        ? "缺少有效且启用的MCP按次单价"
        : "调用失败或结果未确认，无法确认计费次数，不估作0元",
  }
}

/** Reuse success classification, but count receipts without converting retail rates to actual costs. */
export function evidenceCallUsage(receipt: AuditEvidenceReceipt) {
  const hasHttpSuccess =
    receipt.httpStatus !== null && receipt.httpStatus >= 200 && receipt.httpStatus < 300
  let successfulCalls: number | null = null
  let businessCode = receipt.businessCode ?? null
  if (receipt.provider === "SIF" && receipt.state === "RECEIVED") {
    successfulCalls = hasHttpSuccess && receipt.businessCode === 1 ? 1 : 0
  } else if (receipt.provider === "MCP" && receipt.state === "RECEIVED" && receipt.hasResponse) {
    // SellerSprite returns MCP content, not an HTTP envelope. Check both transport and business errors.
    successfulCalls = receipt.mcpIsError === true ? 0 : 1
    const text = (Array.isArray(receipt.mcpContent) ? receipt.mcpContent : [])
      .map(costObject)
      .filter(item => item.type === "text" && typeof item.text === "string")
      .map(item => String(item.text))
      .join("")
    if (text.trim()) {
      try {
        const parsed = costObject(JSON.parse(text))
        businessCode = parsed.code ?? null
        if (
          parsed.code !== undefined &&
          parsed.code !== null &&
          (typeof parsed.code !== "string" || !["OK", "SUCCESS"].includes(parsed.code))
        )
          successfulCalls = 0
      } catch {
        // Existing MCP counting treats successfully returned non-JSON content as one call.
      }
    }
  } else if (receipt.provider === "CRAWLER" && receipt.state === "RECEIVED") {
    successfulCalls = hasHttpSuccess && receipt.businessCode === 200 ? 1 : 0
  }
  return {
    costCny: null,
    costStatus: "UNKNOWN",
    usage: {
      callUsageVersion: 2,
      requestCount: receipt.state === "RECEIVED" ? 1 : null,
      responseCount: receipt.state === "RECEIVED" ? 1 : 0,
      successfulCalls,
      failedCalls: successfulCalls === null ? null : 1 - successfulCalls,
      httpStatus: receipt.httpStatus,
      businessCode,
      mcpIsError: typeof receipt.mcpIsError === "boolean" ? receipt.mcpIsError : null,
      consumedQuota: receipt.consumedQuota ?? null,
      actualQuota: receipt.provider === "SIF" ? actualQuota(receipt.consumedQuota) : null,
      quotaStatus:
        receipt.provider !== "SIF"
          ? "NOT_APPLICABLE"
          : actualQuota(receipt.consumedQuota) === null
            ? "UNKNOWN"
            : "REPORTED",
      toolName: costEndpoint(receipt.toolName),
      endpoint: receipt.endpoint ?? null,
      errorCode: receipt.errorCode ?? null,
      upstreamCostCny: null,
      upstreamCostStatus: "UNKNOWN",
      currency: null,
      missingReason: "未取得供应商实际人民币账单；项目单价估算费用单独列示，不当作实际账单或0元",
      countReason:
        receipt.state === "RECEIVED"
          ? "每份原始请求回执计1次；包括HTTP或业务失败，缓存读取不增加次数"
          : "请求结果尚未确认；保留快照及状态，不假定已成功或未发生调用",
    },
  }
}

/** Keep only the endpoint/tool identity, never credentials or query parameters. */
export function costEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null
  if (/^[a-zA-Z0-9_]+$/.test(value)) return value
  try {
    return new URL(value, value.startsWith("/") ? "https://endpoint.invalid" : undefined).pathname
  } catch {
    return null
  }
}
