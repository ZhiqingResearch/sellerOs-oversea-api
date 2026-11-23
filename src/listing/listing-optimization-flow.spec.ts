jest.mock("../generation-record/generation-record-success", () => ({ recordGenerationSuccess: jest.fn().mockResolvedValue(undefined) }))
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"
import { ListingAiService } from "./listing-ai.service"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { getFixedModuleCredits } from "../usage/fixed-module-credits"

jest.mock("./listing-score-delivery", () => ({ prepareListingScoreDelivery: (text: string) => text }))

function fixture(total = 91) {
  const baseline = { planIndex: 1, result: { platform: "amazon", title: "Original", description: "Facts", bullets: ["Fact"] }, score: 90, scoreResult: { total: 90, suggestions: ["Improve clarity"] } }
  const candidate = { ...baseline.result, title: "Clearer title" }
  let report: any = { params: { market: "amazon_us" }, competitors: ["keep"], plans: [{ planIndex: 0, result: { title: "A" }, score: 95 }, baseline] }
  const billing = (id: string) => ({ costCny: "0.1", model: "ZQ-Think-Flash", currency: "CNY", requestId: id, requestIds: [id] })
  const task: any = { id: 1, attemptId: "attempt", listingRunId: 2, planIndex: 1, mainStepId: 3, status: "SCORE_READY", isModelComplete: true,
    input: { runId: "run", main: { operation: "optimization", userPrompt: "baseline and suggestions" }, context: { params: { market: "amazon_us" }, optimizationBaseline: baseline }, result: candidate, autoScore: { operation: "score", userPrompt: "score candidate" }, autoScoreStepId: 4 },
    billing: { billing: billing("optimize"), score: { billing: billing("score") }, isScoreComplete: true },
    listingRun: { id: 2, runId: "run", historyId: 7, history: { userId: 5 } },
  }
  const prisma: any = {
    listingGenerationTask: { findFirst: jest.fn().mockResolvedValue(task), findUnique: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
    listingAiStep: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 4, outputText: JSON.stringify({ total, dimensions: [], suggestions: ["Suggestion"] }) }), create: jest.fn().mockResolvedValue({ id: 10 }), update: jest.fn().mockResolvedValue({}) },
    listingRun: { findUniqueOrThrow: jest.fn().mockResolvedValue(task.listingRun) },
    history: { findUniqueOrThrow: jest.fn(async () => ({ data: report })) },
  }
  const ai = { assertOptimizationAffordable: jest.fn(), chargeSavedOutput: jest.fn(async (_user, operation) => getFixedModuleCredits(operation === "score" ? "listing.score" : "listing.generate", operation)) }
  const runs = { update: jest.fn(async (_user, _run, dto, persist, resolveReport) => {
    const incoming = resolveReport?.(report) ?? dto.data
    await persist(prisma)
    if (incoming) report = { ...report, plans: report.plans.map((plan: any, index: number) => index === dto.planIndex ? incoming.plans[0] : plan) }
  }) }
  const gateway = { streamChat: jest.fn() }
  const service = new ListingGenerationService(prisma as PrismaService, gateway as unknown as AiGatewayProvider, ai as unknown as ListingAiService, runs as unknown as ListingRunService)
  return { baseline, candidate, task, prisma, ai, runs, gateway, service, getReport: () => report }
}

describe("历史优化：有限修正与成功采纳后结算", () => {
  it("采纳真实高分结果，在同一事务结算5积分（包含评分），仅更新B方案", async () => {
    const f = fixture()
    await f.service.finalizeScore(f.task)
    expect(f.ai.chargeSavedOutput.mock.calls.map(call => call[1])).toEqual(["optimization"])
    expect(await Promise.all(f.ai.chargeSavedOutput.mock.results.map(result => result.value))).toEqual([5])
    expect(f.getReport()).toMatchObject({ competitors: ["keep"], plans: [{ score: 95, result: { title: "A" } }, { result: f.candidate, score: 91, optimization: { status: "ACCEPTED" } }] })
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("结算失败不能发布候选正文或新评分", async () => {
    const f = fixture()
    f.ai.chargeSavedOutput.mockRejectedValueOnce(new Error("transaction failed"))
    await expect(f.service.finalizeScore(f.task)).rejects.toThrow("transaction failed")
    expect(f.getReport().plans[1]).toBe(f.baseline)
  })
  it("首轮下降只排一次针对性修正，尚不扣费", async () => {
    const f = fixture(80)
    await f.service.finalizeScore(f.task)
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.getReport().plans[1]).toBe(f.baseline)
    const next = f.prisma.listingGenerationTask.update.mock.calls[0][0].data
    expect(next).toMatchObject({ mainStepId: 10, input: { optimizationCorrectionCount: 1, main: { temperature: 0.2 } } })
    expect(next.input.main.userPrompt).toContain("<candidate-score>")
    expect(next.input.main.userPrompt).toContain("baseline and suggestions")
    expect(next.input.autoScore).toBeUndefined()
    // Simulate the second round finishing lower. The budget must not reset.
    await f.service.finalizeScore({ ...f.task, input: { ...f.task.input, optimizationCorrectionCount: 1 } })
    expect(f.prisma.listingAiStep.create).toHaveBeenCalledTimes(1)
    expect(f.getReport().plans[1]).toMatchObject({ result: f.baseline.result, score: 90, optimization: { status: "REJECTED", candidateScore: 80 } })
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("无有效改动、执行期间被编辑或未完成评分都不扣费", async () => {
    for (const mode of ["unchanged", "stale", "incomplete"]) {
      const f = fixture()
      if (mode === "unchanged") f.task.input.result = f.baseline.result
      if (mode === "stale") f.getReport().plans[1] = { ...f.baseline, result: { title: "New user edit" } }
      if (mode === "incomplete") f.task.billing.isScoreComplete = false
      await f.service.finalizeScore(f.task)
      expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
      expect(f.getReport().plans[1].optimization.status).toBe({ unchanged: "UNCHANGED", stale: "STALE", incomplete: "SCORE_FAILED" }[mode])
    }
  })
  it("同一终态重放，CAS未认领就不再扣费", async () => {
    const f = fixture()
    f.prisma.listingGenerationTask.updateMany.mockResolvedValue({ count: 0 })
    await expect(f.service.finalizeScore(f.task)).rejects.toThrow("已保存")
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("重试评分复用候选，幂等重放不调用AI，不重新生成", async () => {
    const f = fixture()
    f.task.status = "PARTIAL"
    f.task.input.optimizationCorrectionCount = 1
    f.getReport().plans[1] = { ...f.baseline, optimization: { attemptId: "attempt", status: "SCORE_FAILED" } }
    await f.service.retryOptimizationScore(5, "attempt", "retry-id")
    expect(f.ai.assertOptimizationAffordable).toHaveBeenCalledWith(5)
    const input = f.prisma.listingGenerationTask.update.mock.calls[0][0].data.input
    expect(input).toMatchObject({ result: f.candidate, optimizationCorrectionCount: 1, scoreRetryRequestId: "retry-id", autoScoreStepId: 10 })
    f.task.input = input
    await f.service.retryOptimizationScore(5, "attempt", "retry-id")
    expect(f.prisma.listingAiStep.create).toHaveBeenCalledTimes(1)
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })
  it("任务属于其他用户或记录时禁止提交重放", async () => {
    const f = fixture()
    f.prisma.listingGenerationTask.findUnique.mockResolvedValue(f.task)
    await expect(f.service.submitOptimization(99, 7, { attemptId: "attempt", planIndex: 1 } as any)).rejects.toThrow("不存在")
    await expect(f.service.submitOptimization(5, 99, { attemptId: "attempt", planIndex: 1 } as any)).rejects.toThrow("不存在")
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })
  it("同一提交成功后的重放不再校验过期版本、不再预检余额", async () => {
    const f = fixture()
    f.prisma.listingGenerationTask.findUnique.mockResolvedValue(f.task)
    await expect(f.service.submitOptimization(5, 7, { attemptId: "attempt", planIndex: 1 } as any)).resolves.toEqual({ attemptId: "attempt", runId: "run" })
    expect(f.ai.assertOptimizationAffordable).not.toHaveBeenCalled()
  })
  it("旧记录补建关联与初始版本，基准评分从数据库读取而非客户端", async () => {
    const f = fixture()
    const legacy = { id: 7, userId: 5, type: "LISTING_GENERATION", version: 1, listingRun: null, data: { params: { market: "amazon_us" }, plans: [f.baseline] } }
    f.prisma.$transaction = jest.fn(callback => callback(f.prisma))
    f.prisma.$queryRaw = jest.fn()
    f.prisma.history.findFirst = jest.fn().mockResolvedValue(legacy)
    f.prisma.historyRevision = { count: jest.fn().mockResolvedValue(0), create: jest.fn() }
    f.prisma.listingRun.create = jest.fn().mockResolvedValue({ runId: "new-run" })
    const submit = jest.spyOn(f.service, "submit").mockResolvedValue({ runId: "new-run", attemptId: "attempt" })
    await f.service.submitOptimization(5, 7, { attemptId: "attempt", planIndex: 1, expectedVersion: 1, main: { operation: "optimization", userPrompt: "prompt" }, context: { params: { market: "amazon_us" }, optimizationBaseline: { score: 1 } } })
    expect(f.prisma.historyRevision.create).toHaveBeenCalledWith({ data: { historyId: 7, version: 1, data: legacy.data } })
    expect(submit.mock.calls[0][1].context.optimizationBaseline).toEqual(f.baseline)
    expect(f.ai.assertOptimizationAffordable).toHaveBeenCalledWith(5)
    expect(f.prisma.listingRun.create).toHaveBeenCalledTimes(1)
  })
})
