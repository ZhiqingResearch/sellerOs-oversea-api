import { Logger } from "@nestjs/common"
import { Prisma, PrismaClient } from "@prisma/client"
import { memoryClient } from "../../test/generation-record-memory"
import { FIXED_CREDITS_MODEL } from "../asin-audit/asin-audit.types"
import { recordGenerationSuccess } from "./generation-record-success"

describe("successful generation boundary", () => {
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  it("captures ASIN fixed model and stage credits without fingerprint matching or changing its body", async () => {
    const createdAt = new Date("2026-11-11T01:52:30Z")
    const score = { recordId: "report", scoreResult: { total: 80 }, createdAt }
    const revision = {
      id: 1,
      recordId: "report",
      revision: 1,
      optimizationResult: { title: "第一轮优化" },
      createdAt,
    }
    const { tx, data } = memoryClient({
      aiGatewayModel: [{ publicId: FIXED_CREDITS_MODEL, displayName: "Gemini 3.8 Flash" }],
      asinAuditRecord: [
        {
          id: "report",
          userId: 7,
          asin: "B000000001",
          productTitle: "产品",
          clientRequestId: "save-request",
          status: "OPTIMIZED",
          createdAt,
        },
      ],
      asinAuditScoreSnapshot: [score],
      asinAuditOptimizationRevision: [],
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "asin.audit",
          credits: new Prisma.Decimal(999),
          createdAt,
          meta: {
            stage: "score",
            clientRequestId: "generation-request",
            resultHash: "different",
            model: "wrong-model",
          },
        },
      ],
    })
    await recordGenerationSuccess(tx as unknown as PrismaClient, "asinAuditRecord", "report")
    expect(tx.usageLog.findMany).not.toHaveBeenCalled()
    data.asinAuditOptimizationRevision.push(revision)
    data.asinAuditOptimizationRevision.push({
      ...revision,
      id: 2,
      revision: 2,
      optimizationResult: { title: "第二轮优化" },
    })
    await recordGenerationSuccess(tx as unknown as PrismaClient, "asinAuditRecord", "report")
    await recordGenerationSuccess(tx as unknown as PrismaClient, "asinAuditRecord", "report")

    expect(
      data.generationRecord.map(row => [row.sourceId, row.operation, row.credits.toString()])
    ).toEqual([
      ["ASIN_AUDIT:report", "score", "20"],
      ["ASIN_AUDIT:report:revision:1", "optimize", "15"],
      ["ASIN_AUDIT:report:revision:2", "optimize", "15"],
    ])
    expect(
      data.generationRecord.every(
        row =>
          row.modelPublicId === FIXED_CREDITS_MODEL && row.modelDisplayName === "Gemini 3.8 Flash"
      )
    ).toBe(true)
    expect(tx.usageLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 7,
          source: "asin.audit",
          AND: [
            { meta: { path: "$.recordId", equals: "report" } },
            { OR: [1, 2].map(id => ({ meta: { path: "$.revisionId", equals: id } })) },
          ],
        },
      })
    )
    expect(tx.usageLog.updateMany).not.toHaveBeenCalled()
    expect(data.asinAuditScoreSnapshot).toEqual([score])
    expect(data.asinAuditOptimizationRevision[0]).toEqual(revision)
    data.usageLog.push({
      id: 2,
      userId: 7,
      source: "asin.audit",
      credits: new Prisma.Decimal(999),
      createdAt: new Date(createdAt.getTime() + 1000),
      meta: { stage: "optimize", recordId: "report", revisionId: 1 },
    })
    await recordGenerationSuccess(tx as unknown as PrismaClient, "asinAuditRecord", "report")
    await recordGenerationSuccess(tx as unknown as PrismaClient, "asinAuditRecord", "report")
    expect(data.generationRecord).toHaveLength(4)
    expect(data.generationRecord[3]).toMatchObject({
      sourceId: "ASIN_AUDIT:report:revision:1:event:2",
      modelPublicId: FIXED_CREDITS_MODEL,
      credits: new Prisma.Decimal(15),
    })
  })
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

  it("logs a failed snapshot in its own transaction without throwing or retrying", async () => {
    const error = new Error("snapshot storage failed")
    const tx = { $queryRaw: jest.fn().mockRejectedValue(error) }
    const client = {
      $transaction: jest.fn((work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
    }
    const log = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    try {
      await expect(
        recordGenerationSuccess(client as unknown as PrismaClient, "categoryAnalysisRecord", 42)
      ).resolves.toBeUndefined()
      expect(log).toHaveBeenCalledWith(
        "成功快照保存失败 source=categoryAnalysisRecord id=42",
        error.stack
      )
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
      expect(client.$transaction).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })

  it.each([
    ["P2021", "GenerationRecord 表不存在"],
    ["P2028", "生成记录事务超时"],
    ["P2034", "生成记录事务死锁"],
  ])("contains database failure %s without retrying the business", async (code, message) => {
    const error = new Prisma.PrismaClientKnownRequestError(message, {
      code,
      clientVersion: "test",
    })
    const client = { $transaction: jest.fn().mockRejectedValue(error) }
    const log = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    try {
      await expect(
        recordGenerationSuccess(client as unknown as PrismaClient, "asinAuditRecord", "report-id")
      ).resolves.toBeUndefined()
      expect(log).toHaveBeenCalledWith(
        "成功快照保存失败 source=asinAuditRecord id=report-id",
        error.stack
      )
      expect(client.$transaction).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })
})
