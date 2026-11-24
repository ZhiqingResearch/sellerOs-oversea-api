import { BadRequestException } from "@nestjs/common"
import type { PatentQueryCheck, Prisma } from "@prisma/client"
import { TrohubError, TrohubProvider } from "../common/providers/trohub.provider"
import { PrismaService } from "../prisma/prisma.service"
import { PatentQueryRunner } from "./patent-query.runner"
import { PatentQueryService } from "./patent-query.service"
import { splitResults } from "./patent-query.storage"
import { Output, json, output } from "./patent-query.types"
import { checkFixture, taskFixture } from "./testing/fixtures"
import { asTransaction, storageDb } from "./testing/storage-db"
function setup(kind = "design") {
  let check = checkFixture(kind)
  const task = () => taskFixture([check])
  const prisma = {
    patentQueryCheck: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(check)),
      update: jest.fn(({ data }: { data: Partial<PatentQueryCheck> }) => {
        check = { ...check, ...data }
        return Promise.resolve(check)
      }),
    },
    patentQueryTask: { updateMany: jest.fn() },
  }
  const service = {
    mutateCheck: jest.fn(
      (_id: number, fn: (o: Output) => void, patch: Partial<PatentQueryCheck> = {}) => {
        const out = output(structuredClone(check.output))
        fn(out)
        check = { ...check, ...patch, output: json(out) as Prisma.JsonObject }
        return Promise.resolve(check)
      }
    ),
    submitBody: jest.fn().mockResolvedValue({}),
    getTask: jest.fn(() => Promise.resolve(task())),
    settle: jest.fn(),
  }
  const provider = { enabled: () => true, submit: jest.fn(), detail: jest.fn(), matches: jest.fn() }
  const runner = () =>
    new PatentQueryRunner(
      prisma as unknown as PrismaService,
      service as unknown as PatentQueryService,
      provider as unknown as TrohubProvider
    )
  return {
    runner,
    task,
    check: () => check,
    set: (v: Partial<typeof check>) => {
      check = { ...check, ...v }
    },
    prisma,
    service,
    provider,
  }
}
describe("专利异步恢复", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(Date.parse("2026-10-23T00:00:00Z"))
  })
  afterEach(() => jest.useRealTimers())
  it("调度恢复拆表后的命中数组，后续分页沿用原进度", async () => {
    const s = setup()
    const original = {
      units: {
        "img-1": {
          status: "PROCESSING",
          error: null,
          result: {},
          complete: false,
          resultReady: true,
          offset: 1,
          matches: [{ pn: "D1", score: 0.8 }],
        },
      },
    }
    const split = splitResults(original)
    s.set({ output: json(split.data) as Prisma.JsonObject })
    Object.assign(s.prisma.patentQueryTask, { findMany: jest.fn().mockResolvedValue([s.task()]) })
    Object.assign(s.prisma, {
      patentQueryResult: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            split.results.map((r, index) => ({ ...r, id: index + 1, checkId: 1 }))
          ),
      },
    })
    const runner = s.runner()
    const advance = jest.spyOn(runner, "advance").mockResolvedValue(undefined)
    await runner.tick()
    expect(output(advance.mock.calls[0][0].checks[0].output).units["img-1"]).toMatchObject({
      offset: 1,
      matches: [{ pn: "D1", score: 0.8 }],
    })
    expect(s.provider.submit).not.toHaveBeenCalled()
    expect(s.prisma.patentQueryTask.findMany).toHaveBeenCalledTimes(1)
    expect(s.prisma.patentQueryTask.findMany).toHaveBeenCalledWith({
      where: { id: { gt: 0 }, deletedAt: null, status: { in: ["RUNNING", "SETTLING"] } },
      include: { checks: true },
      orderBy: { id: "asc" },
      take: 20,
    })
  })
  it("不同环境的同号分项各用独立 UUID，重启补交沿用首次提交的 UUID", async () => {
    const ids = []
    for (const s of [setup(), setup()]) {
      s.set({ upstreamTaskId: null, status: "PENDING" })
      s.provider.submit.mockRejectedValueOnce(new TrohubError(0, "NETWORK_ERROR"))
      await s.runner().check(s.task(), s.check())
      const id = s.provider.submit.mock.calls[0][1].clientRequestId
      expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i)
      expect(s.check().output).toMatchObject({ clientRequestId: id })
      ids.push(id)

      s.provider.detail.mockRejectedValueOnce(new TrohubError(404, "NOT_FOUND"))
      s.provider.submit.mockResolvedValueOnce({ taskID: "recovered", status: "queued" })
      await s.runner().check(s.task(), s.check())
      expect(s.provider.detail).toHaveBeenCalledWith("design", id)
      expect(s.provider.submit).toHaveBeenNthCalledWith(2, "design", { clientRequestId: id })
    }
    expect(ids[0]).not.toBe(ids[1])
  })
  it("旧任务提交丢回包后用原 clientRequestId 恢复，不再 POST", async () => {
    const s = setup("tm")
    s.set({ upstreamTaskId: null, status: "PROCESSING" })
    s.provider.detail.mockResolvedValue({
      taskID: "recovered",
      status: "completed",
      words: [],
      imageOCR: [],
    })
    await s.runner().check(s.task(), s.check())
    expect(s.provider.detail).toHaveBeenCalledWith("tm", "pq-1-tm")
    expect(s.provider.submit).not.toHaveBeenCalled()
    expect(s.check()).toMatchObject({ status: "COMPLETED", upstreamTaskId: "recovered" })
  })
  it("商品图下载失败保留受控中文原因且不提交上游，未知错误仍隐藏", async () => {
    for (const error of [new BadRequestException("商品图读取失败，请重试"), new Error("secret")]) {
      const s = setup("tm")
      s.set({ upstreamTaskId: null, status: "PENDING" })
      s.service.submitBody.mockRejectedValue(error)
      await s.runner().check(s.task(), s.check())
      expect(s.provider.submit).not.toHaveBeenCalled()
      expect(s.check()).toMatchObject({
        status: "FAILED",
        error:
          error instanceof BadRequestException ? error.message : "检测输入读取失败，请重新上传图片",
      })
    }
  })
  it("只有恢复查询明确 404 才同键补交；429 保留处理中", async () => {
    const s = setup()
    s.set({ upstreamTaskId: null })
    s.provider.detail.mockRejectedValueOnce(new TrohubError(429, "RATE_LIMIT", "繁忙"))
    const r = s.runner()
    await r.check(s.task(), s.check())
    expect(s.provider.submit).not.toHaveBeenCalled()
    jest.advanceTimersByTime(60000)
    s.provider.detail.mockRejectedValueOnce(new TrohubError(404, "NOT_FOUND", "不存在"))
    s.provider.submit.mockResolvedValue({ taskID: "new", status: "queued" })
    await r.check(s.task(), s.check())
    expect(s.provider.submit).toHaveBeenCalledWith("design", { clientRequestId: "pq-1-design" })
  })
  it.each([
    "BUSINESS_INSUFFICIENT_QUOTA",
    "UNAUTHORIZED_AUTH_REQUIRED",
    "BUSINESS_SUBSCRIPTION_REQUIRED",
    "BUSINESS_NEW_RESTRICTION",
  ])("提交明确拒绝 %s 则失败；恢复查询遇到同码保留任务且不补交", async code => {
    const s = setup()
    s.set({ upstreamTaskId: null, status: "PENDING" })
    s.provider.submit.mockRejectedValue(new TrohubError(200, code))
    await s.runner().check(s.task(), s.check())
    expect(s.check().status).toBe("FAILED")
    expect(s.check().error).toBe(new TrohubError(200, code).message)
    expect(s.provider.submit).toHaveBeenCalledTimes(1)
    s.set({ upstreamTaskId: null, status: "PROCESSING" })
    s.provider.submit.mockClear()
    s.provider.detail.mockRejectedValue(new TrohubError(200, code))
    await s.runner().check(s.task(), s.check())
    expect(s.check().status).toBe("PROCESSING")
    expect(s.check().error).toBe(new TrohubError(200, code).message)
    expect(s.provider.submit).not.toHaveBeenCalled()
  })
  it("已受理任务的订阅错误展示原因，恢复成功后清理提示且不重新提交", async () => {
    const s = setup("tm"),
      r = s.runner()
    s.provider.detail.mockRejectedValueOnce(new TrohubError(400, "BUSINESS_SUBSCRIPTION_REQUIRED"))
    await r.check(s.task(), s.check())
    expect(s.check()).toMatchObject({
      status: "PROCESSING",
      error: "检测服务订阅未生效或已到期，请联系管理员",
    })
    jest.advanceTimersByTime(60000)
    s.provider.detail.mockResolvedValue({ status: "queued" })
    await r.check(s.task(), s.check())
    expect(s.check().error).toBeNull()
    expect(s.provider.submit).not.toHaveBeenCalled()
  })
  it("最终补拉失败保留具体校验原因", async () => {
    const s = setup("tm")
    s.set({ output: { upstreamCompleted: true, units: {} } })
    s.provider.detail.mockRejectedValue(
      new TrohubError(400, "VALIDATION_VISUAL_SEARCH_IMAGE_TOO_SMALL")
    )
    await s.runner().check(s.task(), s.check())
    expect(s.check().error).toContain("最长边需至少 200 像素")
    expect(s.check().error).toContain("结果未完整获取")
    expect(s.check().status).toBe("FAILED")
  })
  it("HTTP 200 参数错误立即结束轮询", async () => {
    const s = setup()
    s.provider.detail.mockRejectedValue(new TrohubError(200, "VALIDATION_INVALID_PARAM"))
    await s.runner().check(s.task(), s.check())
    expect(s.check().status).toBe("FAILED")
    expect(s.provider.detail).toHaveBeenCalledTimes(1)
  })
  it("限流器不可用属于临时故障，最终补拉仍有次数上限", async () => {
    const s = setup("tm"),
      r = s.runner()
    s.set({ output: { upstreamCompleted: true, units: {} } })
    s.provider.detail.mockRejectedValue(new TrohubError(200, "RATE_LIMITER_UNAVAILABLE"))
    for (let n = 0; n < 5; n++) {
      await r.check(s.task(), s.check())
      jest.advanceTimersByTime(60000)
    }
    expect(s.check().status).toBe("FAILED")
    expect(s.provider.detail).toHaveBeenCalledTimes(5)
    expect(s.provider.submit).not.toHaveBeenCalled()
  })
  it("恢复查询 410 不补交，避免为已删除结果重建付费任务", async () => {
    const s = setup()
    s.set({ upstreamTaskId: null, status: "PROCESSING" })
    s.provider.detail.mockRejectedValue(new TrohubError(410, "GONE"))
    await s.runner().check(s.task(), s.check())
    expect(s.check().status).toBe("FAILED")
    expect(s.provider.submit).not.toHaveBeenCalled()
  })
  it("152 条分页重启后从 100 继续，全部保存才成功", async () => {
    const s = setup(),
      first = Array.from({ length: 100 }, (_, n) => ({ pn: `D${n}`, score: 0.8 }))
    s.provider.detail.mockResolvedValue({
      status: "completed",
      images: [
        {
          id: "img-1",
          status: "completed",
          result: { riskLevel: "medium", matches: { items: first, total: 152, hasNextPage: true } },
        },
      ],
    })
    await s.runner().check(s.task(), s.check())
    expect(output(s.check().output).units["img-1"]).toMatchObject({ offset: 100, complete: false })
    expect(s.check().status).toBe("PROCESSING")
    s.provider.matches.mockResolvedValue({
      items: Array.from({ length: 52 }, (_, n) => ({ pn: `D${n + 100}`, score: 0.8 })),
      total: 152,
      hasNextPage: false,
    })
    await s.runner().check(s.task(), s.check())
    expect(s.provider.matches).toHaveBeenCalledWith("design", "upstream-1", "img-1", 100)
    expect(output(s.check().output).units["img-1"].matches).toHaveLength(152)
    expect(s.check().status).toBe("COMPLETED")
  })
  it.each(["design", "gtm"])("%s只保存相似度>60%%，过期/失效及无有效分数保留", async kind => {
    const s = setup(kind)
    const items = [
      { pn: "boundary", score: 0.6 },
      { pn: "below", score: 0.59 },
      { pn: "zero", score: 0 },
      { pn: "above", score: 0.600001 },
      { pn: "high", score: 0.95 },
      { pn: "expired", score: 0.1, expired: true },
      { pn: "dead", score: 0.2, status: "DEAD" },
      { pn: "cancelled", score: 0.2, legalStatus: "CANCELLED" },
      { pn: "uncompared-low", score: 0.4, reasonCode: "NOT_COMPARED" },
      { pn: "uncompared-high", score: 0.8, reasonCode: "NOT_COMPARED" },
      { pn: "missing" },
      { pn: "null", score: null },
      { pn: "string", score: "0.4" },
      { pn: "negative", score: -1 },
      { pn: "out-of-range", score: 61 },
    ].map(item => ({ ...item, serialNumber: item.pn }))
    await s.runner().savePage(s.check(), kind as "design" | "gtm", "img-1", {
      items,
      total: items.length,
      hasNextPage: false,
    })
    const unit = output(s.check().output).units["img-1"]
    expect(unit.matches.map(m => m.pn)).toEqual([
      "above",
      "high",
      "expired",
      "dead",
      "cancelled",
      "uncompared-high",
      "missing",
      "null",
      "string",
      "negative",
      "out-of-range",
    ])
    expect(unit).toMatchObject({ offset: items.length, complete: true, status: "COMPLETED" })
    expect(unit).not.toHaveProperty("pageFingerprints")
  })
  it("版权低分仍保存，文字商标不经过图片分页过滤", async () => {
    const s = setup("copy")
    await s.runner().savePage(s.check(), "copy", "img-1", {
      items: [{ id: "C1", score: 0.1, confidence: 0.1, matchType: "verified" }],
      total: 1,
      hasNextPage: false,
    })
    expect(output(s.check().output).units["img-1"].matches).toHaveLength(1)
    const text = setup("tm")
    text.provider.detail.mockResolvedValue({
      taskID: "text",
      status: "completed",
      words: [{ term: "cup", marks: [{ serialNumber: "T1", score: 0.1, level: "low" }] }],
    })
    await text.runner().check(text.task(), text.check())
    expect(output(text.check().output).text?.words).toEqual([
      { term: "cup", marks: [{ serialNumber: "T1", score: 0.1, level: "low" }] },
    ])
    expect(text.check().status).toBe("COMPLETED")
  })
  it("连续整页过滤后仍按原始条数取下一页，全部过滤的结果也算完成", async () => {
    const s = setup()
    s.provider.detail.mockResolvedValue({
      status: "completed",
      images: [
        {
          id: "img-1",
          status: "completed",
          result: {
            matches: { items: [{ pn: "D1", score: 0.6 }], total: 2, hasNextPage: true },
          },
        },
      ],
    })
    await s.runner().check(s.task(), s.check())
    expect(output(s.check().output).units["img-1"]).toMatchObject({
      offset: 1,
      matches: [],
      complete: false,
    })
    s.provider.matches.mockResolvedValue({
      items: [{ pn: "D2", score: 0.3 }],
      total: 2,
      hasNextPage: false,
    })
    await s.runner().check(s.task(), s.check())
    expect(s.provider.matches).toHaveBeenCalledWith("design", "upstream-1", "img-1", 1)
    expect(output(s.check().output).units["img-1"]).toMatchObject({
      offset: 2,
      matches: [],
      complete: true,
    })
    expect(s.check().status).toBe("COMPLETED")
  })
  it("过滤页的指纹在重启后识别非相邻重复页，拒绝推进offset", async () => {
    const s = setup()
    for (const pn of ["D1", "D2"])
      await s.runner().savePage(s.check(), "design", "img-1", {
        items: [{ pn, score: 0.2 }],
        total: 3,
        hasNextPage: true,
      })
    const before = structuredClone(s.check().output)
    await expect(
      s.runner().savePage(s.check(), "design", "img-1", {
        items: [{ pn: "D1", score: 0.2 }],
        total: 3,
        hasNextPage: false,
      })
    ).rejects.toThrow("结果未完整获取")
    expect(s.check().output).toEqual(before)
  })
  it("无稳定ID的低分页不误判为重复页，原total校验仍生效", async () => {
    const s = setup()
    for (const hasNextPage of [true, false])
      await s.runner().savePage(s.check(), "design", "img-1", {
        items: [{ title: "no-id", score: 0.2 }],
        total: 2,
        hasNextPage,
      })
    expect(output(s.check().output).units["img-1"]).toMatchObject({
      offset: 2,
      matches: [],
      complete: true,
    })
    const invalid = setup()
    await expect(
      invalid.runner().savePage(invalid.check(), "design", "img-1", {
        items: [{ pn: "D1", score: 0.2 }],
        total: 2,
        hasNextPage: false,
      })
    ).rejects.toThrow("结果未完整获取")
  })
  it("实际保存只写保留行，拆表重启恢复保留原始offset且不改已有行ID", async () => {
    const db = storageDb()
    let check = checkFixture("design", { output: { units: {} } })
    const tx = {
      ...db,
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
      patentQueryCheck: {
        findUniqueOrThrow: jest.fn(() => Promise.resolve(structuredClone(check))),
        update: jest.fn(({ data }: { data: Partial<PatentQueryCheck> }) => {
          check = { ...check, ...structuredClone(data) }
          return Promise.resolve(structuredClone(check))
        }),
      },
    }
    const prisma = {
      ...tx,
      $transaction: (fn: (client: Prisma.TransactionClient) => unknown) => fn(asTransaction(tx)),
    }
    const service = new PatentQueryService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )
    const runner = () => new PatentQueryRunner(prisma as never, service, {} as never)
    await runner().savePage(check, "design", "img-1", {
      items: [
        { pn: "low", score: 0.6 },
        { pn: "high", score: 0.8 },
        { pn: "expired", score: 0.1, expired: true },
      ],
      total: 4,
      hasNextPage: true,
    })
    expect(db.state.results.map(r => (r.data as Prisma.JsonObject).pn)).toEqual(["high", "expired"])
    const ids = db.state.results.map(r => r.id)
    expect(output(check.output).units["img-1"]).toMatchObject({ offset: 3, complete: false })
    expect(output(check.output).units["img-1"]).not.toHaveProperty("matches")
    await runner().savePage(check, "design", "img-1", {
      items: [{ pn: "next", score: 0.7 }],
      total: 4,
      hasNextPage: false,
    })
    expect(db.state.results.map(r => (r.data as Prisma.JsonObject).pn)).toEqual([
      "high",
      "expired",
      "next",
    ])
    expect(db.state.results.slice(0, 2).map(r => r.id)).toEqual(ids)
    expect(output(check.output).units["img-1"]).toMatchObject({ offset: 4, complete: true })
    expect(output(check.output).units["img-1"]).not.toHaveProperty("pageFingerprints")
  })
  it("空页仍有下一页：首次加四次失败结束，不重新检测", async () => {
    const s = setup(),
      r = s.runner()
    s.set({
      output: {
        units: {
          "img-1": {
            resultReady: true,
            status: "PROCESSING",
            matches: [],
            result: {},
            offset: 0,
            complete: false,
            error: null,
          },
        },
      },
    })
    s.provider.matches.mockResolvedValue({ items: [], total: 5, hasNextPage: true })
    for (let n = 0; n < 5; n++) {
      await r.check(s.task(), s.check())
      jest.advanceTimersByTime(60000)
    }
    expect(s.provider.matches).toHaveBeenCalledTimes(5)
    expect(s.check().status).toBe("FAILED")
    expect(s.provider.submit).not.toHaveBeenCalled()
  })
  it("HTTP 200 的业务限流也不消耗结果重试预算；截断立即结束", async () => {
    const s = setup(),
      r = s.runner()
    s.set({
      output: {
        units: {
          "img-1": {
            resultReady: true,
            status: "PROCESSING",
            matches: [],
            result: {},
            offset: 0,
            complete: false,
            error: null,
          },
        },
      },
    })
    s.provider.matches.mockRejectedValue(new TrohubError(200, "BUSINESS_RATE_LIMIT_EXCEEDED"))
    for (let n = 0; n < 6; n++) {
      await r.check(s.task(), s.check())
      jest.advanceTimersByTime(60000)
    }
    expect(s.check().status).toBe("PROCESSING")
    s.provider.matches.mockResolvedValue({ truncated: true })
    await r.check(s.task(), s.check())
    expect(s.check().status).toBe("FAILED")
  })
  it("全部失败免费、任一成功才进入结算；人工等待不自动扣费", async () => {
    const s = setup()
    s.set({ status: "FAILED" })
    await s.runner().advance(s.task())
    expect(s.prisma.patentQueryTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) as unknown })
    )
    expect(s.service.settle).not.toHaveBeenCalled()
    s.set({ kind: "tm", status: "COMPLETED" })
    await s.runner().advance(s.task())
    expect(s.service.settle).toHaveBeenCalledWith(1, 1, false)
    s.service.settle.mockClear()
    await s.runner().advance({ ...s.task(), status: "SETTLING", error: "[PAYMENT_REQUIRED] 不足" })
    await s
      .runner()
      .advance({ ...s.task(), status: "SETTLING", error: "[SETTLEMENT_FAILED] 配置错误" })
    expect(s.service.settle).not.toHaveBeenCalled()
  })
  it("已确认文字任务完成后，即使重启遇到网络错误也有限补拉", async () => {
    const s = setup("tm")
    s.provider.detail.mockResolvedValueOnce({ status: "completed", words: null })
    await s.runner().check(s.task(), s.check())
    expect(output(s.check().output).upstreamCompleted).toBe(true)
    const resumed = s.runner()
    s.provider.detail.mockRejectedValue(new TrohubError(0, "NETWORK_ERROR", "连接失败"))
    for (let n = 0; n < 5; n++) {
      await resumed.check(s.task(), s.check())
      jest.advanceTimersByTime(60000)
    }
    expect(s.check().status).toBe("FAILED")
    expect(s.provider.submit).not.toHaveBeenCalled()
  })
  it("末页全是重复命中也不能当成完整成功", async () => {
    const s = setup(),
      r = s.runner()
    s.set({
      output: {
        units: {
          "img-1": {
            resultReady: true,
            status: "PROCESSING",
            matches: [{ pn: "D1" }],
            result: {},
            offset: 1,
            complete: false,
            error: null,
          },
        },
      },
    })
    await expect(
      r.savePage(s.check(), "design", "img-1", {
        items: [{ pn: "D1" }],
        total: 2,
        hasNextPage: false,
      })
    ).rejects.toThrow("结果未完整获取")
  })
  it("同项一图成功一图 isStale 为 PARTIAL，失败图不当作零命中", async () => {
    const s = setup(),
      t = s.task()
    const i = JSON.parse(JSON.stringify(t.input)) as ReturnType<
      typeof import("./testing/fixtures").fixtureInput
    >
    i.images.push({ id: "img-2", key: "patent-query/1/second.jpg", name: "second.jpg" })
    t.input = json(i) as Prisma.JsonObject
    s.provider.detail.mockResolvedValue({
      status: "completed",
      images: [
        {
          id: "img-1",
          status: "completed",
          result: { matches: { items: [], total: 0, hasNextPage: false } },
        },
        { id: "img-2", status: "completed", isStale: true },
      ],
    })
    await s.runner().check(t, s.check())
    expect(s.check().status).toBe("PARTIAL")
    expect(output(s.check().output).units["img-2"]).toMatchObject({
      status: "FAILED",
      complete: false,
    })
  })
})
