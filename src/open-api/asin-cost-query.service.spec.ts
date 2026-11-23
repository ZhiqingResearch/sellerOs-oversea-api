import { Prisma } from "@prisma/client"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { PrismaService } from "../prisma/prisma.service"
import { AsinCostQueryService, AsinCostSummary } from "./asin-cost-query.service"
import { actualQuota, mcpEstimate } from "./asin-cost.kernel"
import { QueryAsinCostDto } from "./dto/query-asin-cost.dto"

describe("实际账单、估算、配额分开汇总", () => {
  it("8次SIF回执7点且缺1份，不能报完整7点；真实0保留", () => {
    const summary = new AsinCostSummary()
    for (const quota of [null, 1, "2", 1, 0, 2, 0, 1])
      summary.add({
        provider: "SIF",
        costStatus: "UNKNOWN",
        costCny: null,
        usage: { consumedQuota: quota, requestCount: 1, successfulCalls: 1 },
      })
    expect(summary.result()).toMatchObject({
      reportedQuota: "7",
      totalQuota: null,
      quotaResponseCount: 7,
      unknownQuotaCount: 1,
      confirmedRequestCount: 8,
      actualCostCny: null,
    })
    expect(actualQuota("0")).toBe(0)
    for (const value of [null, undefined, "", " ", -1, NaN, false, {}])
      expect(actualQuota(value)).toBeNull()
  })
  it("已知模型账单与MCP估算不相加，重复账单不计费", () => {
    const summary = new AsinCostSummary()
    summary.add({ provider: "AI_GATEWAY", costStatus: "KNOWN", costCny: "0.281951", usage: {} })
    summary.add({ provider: "AI_GATEWAY", costStatus: "DUPLICATE", costCny: null, usage: {} })
    summary.add({
      provider: "MCP",
      costStatus: "UNKNOWN",
      costCny: null,
      usage: { estimateStatus: "ESTIMATED", estimatedCostCny: "0.12375" },
    })
    expect(summary.result()).toMatchObject({
      actualCostCny: "0.281951",
      estimatedCostCny: "0.123750",
      completeActualCostCny: null,
      duplicateCount: 1,
      unknownAmountCount: 1,
    })
  })
  it("失败/未知调用不伪造零费用；合法零单价标估算；配置未启用不估算", () => {
    const price = { markupPriceCny: "0", updatedAt: new Date(), active: true, unit: "call" }
    expect(mcpEstimate({ successfulCalls: 1 }, price, new Date())).toMatchObject({
      estimateStatus: "ESTIMATED",
      estimatedCostCny: "0",
    })
    for (const successfulCalls of [null, 0])
      expect(mcpEstimate({ successfulCalls }, price, new Date()).estimatedCostCny).toBeNull()
    expect(
      mcpEstimate({ successfulCalls: 1 }, { ...price, active: false }, new Date()).estimatedCostCny
    ).toBeNull()
  })
  it("DTO拒绝异常筛选值和无时区日期，数字分页可转换", async () => {
    expect(
      await validate(
        plainToInstance(QueryAsinCostDto, {
          page: "2",
          pageSize: "20",
          startDate: "2026-11-13T00:00:00+08:00",
        })
      )
    ).toHaveLength(0)
    for (const input of [
      { provider: "unknown" },
      { pageSize: 101 },
      { page: 0 },
      { phone: "secret' OR 1" },
      { startDate: "2026-11-13" },
    ])
      expect((await validate(plainToInstance(QueryAsinCostDto, input))).length).toBeGreaterThan(0)
  })
  it("查询只读、明细分页但汇总完整；过滤绑定成本账号并且响应不泄漏原始usage", async () => {
    const task = {
      taskId: "audit-existing",
      asin: "B0HFM8X9XB",
      auditType: "COMPUTER",
      status: "FAILED",
    }
    const rows = [1, 2].map(id => ({
      id,
      userId: 628,
      task,
      provider: "SIF",
      sourceId: `s${id}`,
      model: null,
      state: "RECEIVED",
      costStatus: "UNKNOWN",
      costCny: null,
      occurredAt: new Date(),
      usage: {
        consumedQuota: id,
        endpoint: "https://hidden:secret@host/query?key=secret",
        requestCount: 1,
        authorization: "secret",
      },
    }))
    const tx = {
      asinAuditCostRecord: { findMany: jest.fn().mockResolvedValue(rows) },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 628, username: "牛牛系统", phone: "19980889056" }]),
      },
    }
    const database = { $transaction: jest.fn(callback => callback(tx)) }
    const service = new AsinCostQueryService(database as unknown as PrismaService)
    const result = await service.list({
      phone: "19980889056",
      taskId: task.taskId,
      provider: "SIF",
      page: 2,
      pageSize: 1,
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe(2)
    expect(result.summary).toMatchObject({ reportedQuota: "3", totalQuota: "3", recordCount: 2 })
    expect(result.items[0].endpoint).toBe("/query")
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(tx.asinAuditCostRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ userId: { in: [628] } }], task: { taskId: task.taskId }, provider: "SIF" },
      })
    )
    expect(database.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    )
    await expect(
      service.list({
        page: 1,
        pageSize: 10,
        startDate: "2026-11-14T00:00:00Z",
        endDate: "2026-11-13T00:00:00Z",
      })
    ).rejects.toThrow("开始时间必须早于结束时间")
  })
})
