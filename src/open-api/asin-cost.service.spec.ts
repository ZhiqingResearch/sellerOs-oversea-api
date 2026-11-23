import { Prisma } from "@prisma/client"
import { CreditService } from "../membership/credit.service"
import { PricingService } from "../pricing/pricing.service"
import { PrismaService } from "../prisma/prisma.service"
import {
  actualGatewayCost,
  AuditEvidenceReceipt,
  costEndpoint,
  evidenceCallUsage,
  modelCostUsage,
} from "./asin-cost.kernel"
import { AsinCostService } from "./asin-cost.service"

const billing = {
  requestId: "upstream-1",
  requestIds: ["upstream-1"],
  model: "actual-model",
  currency: "CNY",
  costCny: "0.274185",
}

function fixture() {
  const now = new Date("2026-11-13T03:00:00.000Z")
  const task = {
    id: 1,
    taskId: "audit-fixture",
    costUserId: 628,
    appId: "caller",
    auditType: "COMPUTER",
    asin: "B0CWJS6Q5C",
    updatedAt: now,
    createdAt: now,
  }
  const phases: Record<string, unknown>[] = [
    {
      phase: "score",
      state: "FAILED",
      billing,
      tokenUsage: { prompt_tokens: 12, completion_tokens: 4 },
      model: "configured-model",
    },
  ]
  const snapshots: (AuditEvidenceReceipt & { snapshotId: string; createdAt: Date })[] = [
    {
      snapshotId: "crawl-1",
      provider: "SIF",
      state: "RECEIVED",
      httpStatus: 200,
      businessCode: -25,
      consumedQuota: 0,
      createdAt: now,
    },
  ]
  const records = new Map<string, Record<string, unknown>>()
  const logs = new Map<string, Record<string, unknown>>()
  let optimization: Record<string, unknown> | null = null
  const database = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 628, isActive: true }) },
    asinAuditTask: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(task)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    asinAuditOptimization: { findUnique: jest.fn(() => Promise.resolve(optimization)) },
    asinAuditCostRecord: {
      findUnique: jest.fn(({ where }: { where: { recordKey: string } }) =>
        Promise.resolve(records.get(where.recordKey) ?? null)
      ),
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { recordKey: string }
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          const row = records.has(where.recordKey)
            ? { ...records.get(where.recordKey), ...update }
            : create
          records.set(where.recordKey, row)
          return Promise.resolve(row)
        }
      ),
    },
    usageLog: {
      findUnique: jest.fn(({ where }: { where: { requestId: string } }) =>
        Promise.resolve(logs.get(where.requestId) ?? null)
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> & { requestId: string } }) => {
        logs.set(data.requestId, data)
        return Promise.resolve(data)
      }),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray): Promise<unknown> => {
      const query = strings.join("")
      if (query.includes("UTC_TIMESTAMP")) return Promise.resolve([{ now }])
      if (query.includes("JSON_TABLE")) return Promise.resolve(phases)
      if (query.includes("ORDER BY id")) return Promise.resolve(snapshots)
      return Promise.resolve([{ id: 1 }])
    }),
    $transaction: jest.fn(),
  }
  database.$transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
    callback(database)
  )
  const credit = {
    consumableBalance: jest.fn().mockResolvedValue(new Prisma.Decimal(42)),
    consume: jest.fn(() => {
      throw new Error("Must not deduct")
    }),
  }
  const pricing = { listAll: jest.fn().mockResolvedValue([]) }
  const service = new AsinCostService(
    database as unknown as PrismaService,
    credit as unknown as CreditService,
    pricing as unknown as PricingService
  )
  return {
    service,
    database,
    credit,
    task,
    phases,
    snapshots,
    records,
    logs,
    pricing,
    setOptimization: (value: Record<string, unknown>) => {
      optimization = value
    },
  }
}

describe("ASIN实际成本归集（不扣积分）", () => {
  it("MCP按成功回执估算，单价冻结，补录不重复、不污染实际账单或积分", async () => {
    const f = fixture()
    f.snapshots.push({
      ...f.snapshots[0],
      snapshotId: "mcp-price",
      provider: "MCP",
      hasResponse: true,
      mcpIsError: false,
      mcpContent: [{ type: "text", text: '{"code":"OK"}' }],
    })
    await f.service.syncTask(1)
    const price = {
      key: "MCP_CALL",
      markupPriceCny: "0.12375",
      active: true,
      unit: "call",
      updatedAt: f.task.createdAt,
    }
    f.pricing.listAll.mockResolvedValue([price])
    await f.service.syncTask(1)
    const findMcp = () => [...f.records.values()].find(row => row.provider === "MCP")!
    expect(findMcp()).toMatchObject({
      costCny: null,
      costStatus: "UNKNOWN",
      userId: 628,
      usage: {
        estimateStatus: "ESTIMATED",
        estimatedCostCny: "0.12375",
        estimateUnitPriceCny: "0.12375",
      },
    })
    const frozen = JSON.stringify(findMcp())
    f.pricing.listAll.mockResolvedValue([{ ...price, markupPriceCny: "9.99" }])
    await f.service.syncTask(1)
    expect(JSON.stringify(findMcp())).toBe(frozen)
    expect(f.logs.size).toBe(1)
    expect(f.credit.consume).not.toHaveBeenCalled()
  })
  it("定时归集将MySQL原生查询的BigInt任务ID转换为Prisma Int", async () => {
    const f = fixture()
    f.database.$queryRaw.mockResolvedValueOnce([{ id: BigInt(1) }])
    const sync = jest.spyOn(f.service, "syncTask").mockResolvedValue(undefined)
    await f.service.tick()
    expect(sync).toHaveBeenCalledWith(1)
  })

  it.each([
    undefined,
    {},
    { ...billing, costCny: null },
    { ...billing, costCny: "" },
    { ...billing, costCny: "NaN" },
    { ...billing, costCny: -1 },
    { ...billing, currency: "USD" },
    { ...billing, estimated: true },
    { ...billing, requestId: "" },
  ])("无有效账单保持未知，不估价: %j", value => {
    expect(actualGatewayCost(value)).toBeNull()
  })

  it("真实零账单与金额未知区分；失败后的已发生费用仍保留", () => {
    expect(modelCostUsage({ ...billing, costCny: "0" }, {}, "FAILED").costStatus).toBe("KNOWN")
    expect(modelCostUsage(null, { promptTokenCount: 10 }, "FAILED")).toMatchObject({
      costCny: null,
      costStatus: "UNKNOWN",
      usage: { promptTokens: 10 },
    })
  })

  it("按原账单记成本并幂等，不乘倍率、不扣余额；SIF配额不换算人民币", async () => {
    const f = fixture()
    await f.service.syncTask(1)
    await f.service.syncTask(1)
    expect(f.logs.size).toBe(1)
    expect(f.database.usageLog.create).toHaveBeenCalledTimes(1)
    const [log] = f.logs.values()
    expect(log).toMatchObject({
      userId: 628,
      credits: 0,
      source: "asin.audit",
      promptTokens: 12,
      completionTokens: 4,
    })
    expect(String(log.cost)).toBe("0.274185")
    expect(String(log.balanceAfter)).toBe("42")
    expect(f.credit.consume).not.toHaveBeenCalled()
    const sif = [...f.records.values()].find(row => row.provider === "SIF")
    expect(sif).toMatchObject({
      costCny: null,
      costStatus: "UNKNOWN",
      usage: { businessCode: -25, consumedQuota: 0 },
    })
    expect(f.database.asinAuditTask.updateMany).toHaveBeenCalledWith({
      where: { id: 1, updatedAt: f.task.updatedAt, costUserId: 628 },
      data: { costSyncedAt: f.task.updatedAt, updatedAt: f.task.updatedAt },
    })
  })

  it("账单晚到时补录一次，已有未知用量不会当作0元或重复记录", async () => {
    const f = fixture()
    f.phases[0].billing = null
    await f.service.syncTask(1)
    expect(f.logs.size).toBe(0)
    expect([...f.records.values()][0].costCny).toBeNull()
    f.phases[0].billing = billing
    await f.service.syncTask(1)
    expect(f.logs.size).toBe(1)
    expect([...f.records.values()][0].costStatus).toBe("KNOWN")
  })

  it("优化使用原审计成本账号，UNKNOWN且已有实际账单也记录开销", async () => {
    const f = fixture()
    f.setOptimization({
      optimizationId: "opt-fixture",
      model: "configured-model",
      status: "UNKNOWN",
      startedAt: f.task.createdAt,
      createdAt: f.task.createdAt,
      payload: {
        usage: {
          billing: { ...billing, requestId: "upstream-2", costCny: "0.5" },
          tokens: { input_tokens: 10, output_tokens: 2 },
        },
      },
    })
    await f.service.syncTask(1)
    expect(f.logs.size).toBe(2)
    expect([...f.logs.values()].every(log => log.userId === 628 && log.credits === 0)).toBe(true)
    expect([...f.records.values()].find(row => row.sourceId === "opt-fixture")).toMatchObject({
      state: "UNKNOWN",
      costStatus: "KNOWN",
    })
  })

  it("同一上游账单出现在两个阶段时，费用只归集一次", async () => {
    const f = fixture()
    f.phases.push({ ...f.phases[0], phase: "optimize" })
    await f.service.syncTask(1)
    await f.service.syncTask(1)
    expect(f.logs.size).toBe(1)
    expect([...f.records.values()].filter(row => row.costStatus === "KNOWN")).toHaveLength(1)
    expect([...f.records.values()].filter(row => row.costStatus === "DUPLICATE")).toHaveLength(1)
  })

  it("只接受服务端接入方配置，并在受理前核对账号可用性", async () => {
    const f = fixture()
    expect(await f.service.resolveOwner({})).toBeNull()
    expect(await f.service.resolveOwner({ asinAuditCostUserId: 628 })).toBe(628)
    f.database.user.findUnique.mockResolvedValueOnce(null)
    await expect(f.service.resolveOwner({ asinAuditCostUserId: 628 })).rejects.toThrow(
      "审计成本归属账号不存在或已停用"
    )
  })

  it("没有指定账号的旧调用不自动归到牛牛，也不产生用量记录", async () => {
    const f = fixture()
    Object.assign(f.task, { costUserId: null })
    await f.service.syncTask(1)
    expect(f.records.size).toBe(0)
    expect(f.logs.size).toBe(0)
  })

  it("SIF成功、MCP成功及爬虫分别计次，同一缓存重复归集不重记、不按售价估费", async () => {
    const f = fixture()
    f.snapshots[0].businessCode = 1
    f.snapshots.push({
      ...f.snapshots[0],
      snapshotId: "mcp-1",
      provider: "MCP",
      hasResponse: true,
      httpStatus: null,
      businessCode: null,
      mcpContent: [{ type: "text", text: '{"code":"OK","data":[]}' }],
    })
    f.snapshots.push({
      ...f.snapshots[0],
      snapshotId: "crawler-1",
      provider: "CRAWLER",
      businessCode: 200,
    })
    await f.service.syncTask(1)
    await f.service.syncTask(1)
    expect(f.records.size).toBe(4)
    const calls = [...f.records.values()].filter(row => row.provider !== "AI_GATEWAY")
    for (const call of calls)
      expect(call).toMatchObject({
        userId: 628,
        costCny: null,
        costStatus: "UNKNOWN",
        usage: { callUsageVersion: 2, requestCount: 1, successfulCalls: 1, failedCalls: 0 },
      })
    expect(calls.find(row => row.provider === "MCP")).toMatchObject({
      usage: { businessCode: "OK", upstreamCostCny: null },
    })
    expect(calls.find(row => row.provider === "SIF")).toMatchObject({ usage: { consumedQuota: 0 } })
    // Only the real model invoice becomes a monetary UsageLog; no fabricated zero-price log.
    expect(f.logs.size).toBe(1)
    expect(f.credit.consume).not.toHaveBeenCalled()
  })

  it("旧版未知明细可补充次数，原模型账单不重复；未知请求收到回执后更新原行", async () => {
    const f = fixture()
    f.snapshots[0].state = "UNKNOWN"
    await f.service.syncTask(1)
    const call = [...f.records.values()].find(row => row.provider === "SIF")!
    expect(call).toMatchObject({
      usage: { requestCount: null, successfulCalls: null, failedCalls: null },
    })
    call.usage = { consumedQuota: null }
    f.snapshots[0].state = "RECEIVED"
    f.snapshots[0].businessCode = 1
    await f.service.syncTask(1)
    expect(f.records.size).toBe(2)
    expect(f.logs.size).toBe(1)
    expect([...f.records.values()].find(row => row.provider === "SIF")).toMatchObject({
      usage: { callUsageVersion: 2, requestCount: 1, successfulCalls: 1 },
    })
  })
})

describe("SIF/MCP实际调用次数", () => {
  const receipt: AuditEvidenceReceipt = {
    provider: "SIF",
    state: "RECEIVED",
    httpStatus: 200,
    businessCode: 1,
    consumedQuota: null,
  }
  it.each([-20, -22, -25, null, "1"])("SIF业务失败%s仍是一次请求，不能冒充成功", businessCode => {
    expect(evidenceCallUsage({ ...receipt, businessCode })).toMatchObject({
      costCny: null,
      costStatus: "UNKNOWN",
      usage: { requestCount: 1, successfulCalls: 0, failedCalls: 1 },
    })
  })
  it("配额不能充当次数，HTTP失败也保留调用，未知结果不伪造0次", () => {
    expect(evidenceCallUsage({ ...receipt, consumedQuota: 100 }).usage).toMatchObject({
      requestCount: 1,
      consumedQuota: 100,
    })
    expect(evidenceCallUsage({ ...receipt, httpStatus: 500 }).usage).toMatchObject({
      requestCount: 1,
      successfulCalls: 0,
    })
    expect(evidenceCallUsage({ ...receipt, state: "UNKNOWN" }).usage).toMatchObject({
      requestCount: null,
      responseCount: 0,
      successfulCalls: null,
    })
  })
  it.each([
    { mcpIsError: true },
    { mcpContent: [{ type: "text", text: '{"code":"LIMIT_EXCEEDED"}' }] },
  ])("MCP工具或业务失败要计请求次数但不算成功 %j", patch => {
    expect(
      evidenceCallUsage({ ...receipt, provider: "MCP", hasResponse: true, ...patch }).usage
    ).toMatchObject({ requestCount: 1, successfulCalls: 0, failedCalls: 1 })
  })
  it("MCP无可用响应不能判为成功", () => {
    expect(
      evidenceCallUsage({ ...receipt, provider: "MCP", hasResponse: false }).usage.successfulCalls
    ).toBeNull()
  })
  it("只保留端点，不复制鉴权头、主机凭证和查询串", () => {
    expect(costEndpoint("https://user:secret@example.com/api/query?key=secret")).toBe("/api/query")
    expect(costEndpoint("asin_competitor")).toBe("asin_competitor")
    expect(costEndpoint(null)).toBeNull()
  })
})
