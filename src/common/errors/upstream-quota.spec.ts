import { ArgumentsHost, BadRequestException } from "@nestjs/common"
import { Logger as WinstonLogger } from "winston"
import { ToolboxErrorFilter } from "../../llm-toolbox/llm-toolbox.controller"
import { AllExceptionsFilter } from "../filters/http-exception.filter"
import {
  beforeQuotaCharge,
  isQuotaResponse,
  isUpstreamQuotaError,
  quotaFailure,
  quotaTaskMessage,
  streamBeforeQuotaCharge,
  UpstreamQuotaError,
} from "./upstream-quota"

describe("supplier quota messages", () => {
  it.each([
    { status: 402 },
    { code: "insufficient_quota", status: 429 },
    { code: "quota_exceeded", message: "monthly budget depleted" },
    { response: { status: 402, data: {} } },
    { response: { status: 403, data: { error: { code: "insufficient_balance" } } } },
    { error: { message: "insufficient credits" } },
    { reason: "MONTHLY_EXHAUSTED", status: 403 },
    "API 配额已用完",
  ])("recognizes explicit supplier rejection: %j", value => {
    expect(isQuotaResponse(value)).toBe(true)
  })
  it.each([
    { status: 429 },
    { status: 403 },
    { code: "quota_exceeded", message: "requests per minute exceeded" },
    { response: { status: 429, data: { error: { code: "rate_limit_exceeded" } } } },
    "no credit card required",
    "insufficient credit card information",
    { code: "insufficient_permissions" },
    "insufficient permissions",
    "invalid credit card",
    "quota per minute rate limit",
    "quota exceeded per minute",
    "每分钟配额已用完",
    "network timeout",
  ])("does not confuse limits/auth/network: %j", value => {
    expect(isQuotaResponse(value)).toBe(false)
  })
  it("never rewrites user wallet errors or promises no charge for unknown state", () => {
    const wallet = new BadRequestException("积分余额不足，请充值")
    expect(quotaFailure(wallet, "not_charged")).toBe(wallet)
    expect(isUpstreamQuotaError(wallet)).toBe(false)
    expect(
      quotaTaskMessage(new BadRequestException("账户余额不足"), "not_charged", "账户余额不足")
    ).toBe("账户余额不足")
    expect((quotaFailure(new UpstreamQuotaError("test"), "unknown") as Error).message).toBe(
      "数据未获取"
    )
    expect(quotaTaskMessage({ code: "insufficient_quota" }, "charged", "failed")).toBe("数据未获取")
    expect(quotaTaskMessage({ status: 402 }, "not_charged", "failed", "partial")).toBe(
      "部分数据未获取"
    )
  })
  it("rejects before any successful-result charge and preserves SSE partial output", async () => {
    const charge = jest.fn()
    await expect(
      (async () => {
        await beforeQuotaCharge(Promise.reject(new UpstreamQuotaError("test")))
        charge()
      })()
    ).rejects.toThrow("数据未获取，未扣除积分")
    expect(charge).not.toHaveBeenCalled()
    async function* provider() {
      yield "partial"
      throw new UpstreamQuotaError("test")
    }
    const output: string[] = []
    await expect(
      (async () => {
        for await (const event of streamBeforeQuotaCharge(provider(), "step")) output.push(event)
      })()
    ).rejects.toThrow("该步骤数据未获取，未扣除积分")
    expect(output).toEqual(["partial"])
  })
  it.each(["http", "toolbox"])("%s 出口保持原包络和 HTTP 状态", mode => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: "POST", url: "/api/test" }),
      }),
    } as unknown as ArgumentsHost
    const error = quotaFailure(new UpstreamQuotaError("test", 429), "not_charged")
    if (mode === "http")
      new AllExceptionsFilter({
        warn: jest.fn(),
        error: jest.fn(),
      } as unknown as WinstonLogger).catch(error, host)
    else new ToolboxErrorFilter().catch(error, host)
    expect(response.status).toHaveBeenCalledWith(429)
    expect(response.json).toHaveBeenCalledWith(
      mode === "http"
        ? expect.objectContaining({
            statusCode: 429,
            message: "数据未获取，未扣除积分",
            timestamp: expect.any(String),
          })
        : { error: "数据未获取，未扣除积分" }
    )
  })
})
