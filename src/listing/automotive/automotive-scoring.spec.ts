import { ConflictException } from "@nestjs/common"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ListingGenerationService } from "../listing-generation.service"
import { parseListingScoreSource } from "../listing-score-evidence"
import { buildAutomotiveScoreRequest } from "./automotive-scoring"
import { finalizeAutomotive, normalizeAutomotiveData } from "./automotive.rules"
import { AutomotiveService } from "./automotive.service"

const data = normalizeAutomotiveData({
  brand: "A-Premium",
  product: "Front Brake Pads",
  fitments: [{ make: "Hyundai", model: "Tucson", years: [2016, 2017] }],
  oeNumbers: ["58101-D3A10"],
  packageContents: [{ name: "Brake Pads", quantity: 4 }],
})
const body = () => ({
  title: "A-Premium Front Brake Pads Fit for Hyundai Tucson 2016-2017",
  itemHighlights: ["Hyundai Tucson", "2016-2017", "OE 58101-D3A10", "Brake Pads x 4"],
  bullets: [
    "FITMENT: Hyundai Tucson 2016-2017",
    "OE: 58101-D3A10",
    "PACKAGE: Brake Pads x 4",
    "NOTE: Verify original part number",
    "NOTE: Verify vehicle fitment",
  ],
  searchTerms: ["brake", "pads", "58101-D3A10", "58101D3A10", "2016", "2017"],
  description: "<b>VEHICLE FITMENT</b><br>Hyundai Tucson",
})
const bill = {
  requestId: "main-bill",
  costCny: "1",
  currency: "CNY",
  model: "ZQ-Think-Flash",
  requestIds: ["main-bill"],
}

function ready() {
  const task: any = {
    id: 1,
    listingRunId: 2,
    mainStepId: 3,
    planIndex: 0,
    attemptId: "attempt",
    status: "READY",
    isModelComplete: true,
    billing: { billing: bill },
    input: {
      generationBillingId: "attempt",
      main: { model: "ZQ-Think-Flash" },
      context: {
        workflow: "automotive",
        rulesVersion: "automotive-v1",
        automotiveData: data,
        params: { market: "amazon_us" },
      },
    },
    listingRun: { id: 2, runId: "run", historyId: 4 },
  }
  const run: any = {
    id: 2,
    runId: "run",
    historyId: 4,
    history: { userId: 7 },
    attempts: { "0": { attemptId: "attempt", status: "RUNNING" } },
  }
  const steps = new Map<number, any>([[3, { id: 3, outputText: JSON.stringify(body()) }]])
  let stepId = 8
  const prisma: any = {
    listingAiStep: {
      create: jest.fn().mockImplementation(({ data: value }) => {
        const step = { ...value, id: ++stepId }
        steps.set(step.id, step)
        return step
      }),
      findUniqueOrThrow: jest.fn().mockImplementation(({ where }) => steps.get(where.id)),
      findUnique: jest.fn().mockImplementation(({ where }) => steps.get(where.id)),
      update: jest
        .fn()
        .mockImplementation(({ where, data: value }) => Object.assign(steps.get(where.id), value)),
    },
    listingRun: { findUniqueOrThrow: jest.fn().mockResolvedValue(run) },
    listingGenerationTask: {
      findFirst: jest.fn().mockImplementation(() => task),
      updateMany: jest.fn().mockImplementation(({ where, data: value }) => {
        if (task.status !== where.status) return { count: 0 }
        Object.assign(task, value)
        return { count: 1 }
      }),
      update: jest.fn().mockImplementation(({ data: value }) => Object.assign(task, value)),
    },
    usageLog: { findUnique: jest.fn().mockResolvedValue({ credits: 25 }) },
  }
  const ai: any = {
    chargeSavedOutput: jest.fn().mockResolvedValue(77),
    assertAffordable: jest.fn(),
  }
  const runs: any = { update: jest.fn(async (_u, _r, _dto, cb) => cb(prisma)) }
  const gateway: any = { streamChat: jest.fn() }
  return {
    service: new ListingGenerationService(prisma, gateway, ai, runs),
    task,
    run,
    prisma,
    ai,
    runs,
    gateway,
    steps,
  }
}

function existingScoreFixture(f: ReturnType<typeof ready>) {
  // 沿用原评分回归样本验证交付/结算，评分规则本身继续由原评分测试覆盖。
  const sample = JSON.parse(
    readFileSync(
      join(__dirname, "../fixtures/listing-score-negative-description-20261014.json"),
      "utf8"
    )
  )
  f.task.input.autoScore.userPrompt = `<listing-scoring-source>${JSON.stringify(sample.sourceFacts)}</listing-scoring-source>`
  return sample.primary as string
}

describe("汽配复用原评分链路", () => {
  it("自检通过只认领一次评分，不调用AI或提前扣费", async () => {
    const f = ready()
    await f.service.finalizeAutomotiveTask(f.task)
    expect(f.task.status).toBe("SCORE_QUEUED")
    expect(f.task.input.result.mode).toBe("automotive")
    expect(f.task.input.autoScore).toMatchObject({ operation: "score", model: "ZQ-Think-Flash" })
    expect(f.runs.update.mock.calls[0][2]).toMatchObject({ status: "RUNNING", stage: "auto_score" })
    await f.service.finalizeAutomotiveTask(f.task)
    expect(f.prisma.listingAiStep.create).toHaveBeenCalledTimes(1)
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })

  it.each(["断流", "自检失败"])("%s保留部分正文，不评分也不扣费", async kind => {
    const f = ready()
    if (kind === "断流") f.task.isModelComplete = false
    else f.steps.get(3).outputText = JSON.stringify({ ...body(), bullets: ["incomplete"] })
    await f.service.finalizeAutomotiveTask(f.task)
    expect(f.task.status).toBe("PARTIAL")
    expect(f.prisma.listingAiStep.create).not.toHaveBeenCalled()
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })

  it("原评分执行器保存报告，原收尾按生成操作一次结算并绑定当前attempt", async () => {
    const f = ready()
    await f.service.finalizeAutomotiveTask(f.task)
    const scoreText = existingScoreFixture(f)
    f.task.status = "SCORING"
    f.gateway.streamChat.mockImplementation(async function* () {
      yield { type: "text", content: scoreText }
      yield {
        type: "done",
        billing: { ...bill, requestId: "score-bill" },
        usage: { promptTokens: 10, completionTokens: 5, thinkingTokens: 0 },
      }
    })
    await f.service.executeScore(f.task)
    expect(f.task.status).toBe("SCORE_READY")
    expect(f.gateway.streamChat).toHaveBeenCalledTimes(1)
    await f.service.finalizeScore(f.task)
    expect(f.task.status).toBe("COMPLETED")
    expect(f.task.input.scoreResult.total).toBe(95.5)
    expect(f.task.input.scoreError).toBeNull()
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.ai.chargeSavedOutput.mock.calls[0]).toEqual([
      7,
      "generation",
      bill,
      undefined,
      f.prisma,
      4,
      3,
      "run",
      "attempt",
    ])
    expect(f.steps.get(3).usageLogId).toBe(77)
    expect(f.steps.get(f.task.input.autoScoreStepId).usageLogId).toBeNull()
    const stale = { ...f.task, status: "SCORE_READY" }
    await expect(f.service.finalizeScore(stale)).rejects.toThrow(ConflictException)
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("评分断流保留正文且不收费，同一重试请求只新建一个评分步骤", async () => {
    const f = ready()
    await f.service.finalizeAutomotiveTask(f.task)
    f.task.status = "SCORE_READY"
    f.task.billing.isScoreComplete = false
    await f.service.finalizeScore(f.task)
    expect(f.task.status).toBe("PARTIAL")
    expect(f.task.input.result.title).toBe(body().title)
    expect(f.task.input.scoreError).toBeTruthy()
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    const result = await f.service.retryOptimizationScore(7, "attempt", "retry-1")
    expect(result.status).toBe("SCORE_QUEUED")
    await f.service.retryOptimizationScore(7, "attempt", "retry-1")
    expect(f.prisma.listingAiStep.create).toHaveBeenCalledTimes(2)
    expect(f.ai.assertAffordable).toHaveBeenCalledWith(7, "generation", "attempt")
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
    expect(f.task.input.scoreError).toBeNull()
  })

  it("失败评分重试成功后才结算25积分对应的生成操作，正文不重新调用", async () => {
    const f = ready()
    await f.service.finalizeAutomotiveTask(f.task)
    f.task.status = "SCORE_READY"
    await f.service.finalizeScore(f.task)
    await f.service.retryOptimizationScore(7, "attempt", "retry-1")
    const scoreText = existingScoreFixture(f)
    f.steps.get(f.task.input.autoScoreStepId).outputText = scoreText
    f.task.status = "SCORE_READY"
    f.task.billing = {
      billing: bill,
      isScoreComplete: true,
      score: { billing: { ...bill, requestId: "retry-score-bill" } },
    }
    await f.service.finalizeScore(f.task)
    expect(f.task.status).toBe("COMPLETED")
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })

  it("评分保存事务失败不会重发模型，下一次只重新保存与结算", async () => {
    const f = ready()
    await f.service.finalizeAutomotiveTask(f.task)
    f.steps.get(f.task.input.autoScoreStepId).outputText = existingScoreFixture(f)
    f.task.status = "SCORE_READY"
    f.task.billing = { billing: bill, isScoreComplete: true, score: { billing: bill } }
    f.ai.chargeSavedOutput.mockRejectedValueOnce(new Error("transaction failed"))
    const pending = structuredClone(f.task)
    await expect(f.service.finalizeScore(f.task)).rejects.toThrow("transaction failed")
    // 模拟真实数据库事务回滚，恢复尚未结算的SCORE_READY快照。
    Object.assign(f.task, pending)
    await f.service.finalizeScore(f.task)
    expect(f.task.status).toBe("COMPLETED")
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })

  it("已有新一轮生成时，不允许重试旧轮评分", async () => {
    const f = ready()
    await f.service.finalizeAutomotiveTask(f.task)
    f.task.status = "SCORE_READY"
    await f.service.finalizeScore(f.task)
    f.run.attempts["0"].attemptId = "new-attempt"
    await expect(f.service.retryOptimizationScore(7, "attempt", "retry-1")).rejects.toThrow(
      "不能重试旧任务评分"
    )
    expect(f.prisma.listingAiStep.create).toHaveBeenCalledTimes(1)
  })

  it("旧已完成汽配记录不自动补评分或再次结算", async () => {
    const f = ready()
    f.task.status = "COMPLETED"
    await f.service.finalizeAutomotiveTask(f.task)
    await f.service.retryOptimizationScore(7, "attempt", "retry-1")
    expect(f.prisma.listingAiStep.create).not.toHaveBeenCalled()
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })

  it("按attempt读取评分快照，旧任务不误取最新历史的评分", async () => {
    const f = ready()
    await f.service.finalizeAutomotiveTask(f.task)
    f.task.status = "PARTIAL"
    f.task.input.scoreError = "评分断流"
    f.prisma.history = {
      findFirst: jest
        .fn()
        .mockResolvedValue({
          data: { plans: [{ scoreResult: { total: 99 } }] },
          listingRun: f.run,
        }),
    }
    const api = new AutomotiveService(f.prisma, f.runs, {} as any, f.gateway, f.service, {} as any)
    const state = await api.read(7, "run", "attempt")
    expect(state.generation).toMatchObject({
      scoreResult: null,
      scoreError: "评分断流",
      canRetryScore: true,
    })
    f.run.attempts["0"].attemptId = "new-attempt"
    expect((await api.read(7, "run", "attempt")).generation?.canRetryScore).toBe(false)
  })
})

it("汽配评分沿用标准评分原文和字段证据契约，安全保留完整HTML，不混入其他来源", () => {
  const result = finalizeAutomotive(JSON.stringify(body()), data, "amazon_de")
  const request = buildAutomotiveScoreRequest(result, data, "amazon_de")
  const source = parseListingScoreSource(request.userPrompt)
  expect(source).toMatchObject({
    mode: "standard",
    title: result.title,
    description: result.description,
    structuredAttributes: result.structuredAttributes,
  })
  expect(request.systemPrompt).toContain("已加载 references/score-cdq-standard.md")
  expect(request.userPrompt).toContain("未提供本次图片")
  expect(request.userPrompt).not.toContain("<b>")
  expect(request.images).toBeUndefined()
  expect(request.operation).toBe("score")
})
