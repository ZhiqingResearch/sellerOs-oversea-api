import { BadRequestException } from "@nestjs/common"
import type { PatentQueryCheck, Prisma } from "@prisma/client"
import axios from "axios"
import sharp from "sharp"
import { CrawlerError, CrawlerProvider } from "../common/providers/crawler.provider"
import { TrohubProvider } from "../common/providers/trohub.provider"
import { OssService } from "../oss/oss.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { normalizeInput } from "./patent-query.constants"
import { PatentQueryService } from "./patent-query.service"
import { splitResults } from "./patent-query.storage"
import { Task, json, obj, output, rows } from "./patent-query.types"
import { checkFixture, completedUnit, fixtureInput, taskFixture } from "./testing/fixtures"
import { storageDb } from "./testing/storage-db"
function setup(
  initial: Task = taskFixture(
    [checkFixture("tm", { status: "COMPLETED", output: { units: {}, text: { words: [] } } })],
    { status: "SETTLING", finishedAt: new Date("2026-10-23T00:01:00Z") }
  )
) {
  let task = initial,
    chain: Promise<unknown> = Promise.resolve()
  const find = jest.fn(({ where }: { where: Partial<Task> }) =>
    Promise.resolve(
      (where.userId !== undefined && where.userId !== task.userId) || task.deletedAt
        ? null
        : structuredClone(task)
    )
  )
  const update = jest.fn(({ data }: { data: Partial<Task> }) => {
    Object.assign(task, data)
    return Promise.resolve(structuredClone(task))
  })
  const updateMany = jest.fn(({ where, data }: { where: Partial<Task>; data: Partial<Task> }) => {
    if (
      (where.status && where.status !== task.status) ||
      ("error" in where && where.error !== task.error)
    )
      return Promise.resolve({ count: 0 })
    Object.assign(task, data)
    return Promise.resolve({ count: 1 })
  })
  const raw = jest.fn((query: Prisma.Sql | TemplateStringsArray) => {
    const sql = "sql" in query ? query.sql : query.join("?")
    const values = "sql" in query ? query.values : []
    if (sql.includes("SELECT id,userId,requestId"))
      return Promise.resolve(
        values.at(-1) !== task.userId || task.deletedAt ? [] : [structuredClone(task)]
      )
    if (sql.includes("AS inline") && sql.includes("JSON_KEYS"))
      return Promise.resolve(
        task.checks.flatMap(c =>
          Object.entries(output(c.output).units).map(([imageId, data]) => ({
            checkId: c.id,
            imageId,
            data,
            inline: 0,
          }))
        )
      )
    if (sql.includes("AS inline"))
      return Promise.resolve(
        task.checks.map(c => ({ checkId: c.id, data: output(c.output).text ?? {}, inline: 0 }))
      )
    if (sql.includes("'_inline'")) return Promise.resolve(structuredClone(storage.state.results))
    if (sql.includes("SELECT m.id,m.resultId"))
      return Promise.resolve(structuredClone(storage.state.marks))
    if (sql.includes("SELECT JSON_OBJECT('serialNumber'"))
      return Promise.resolve(
        storage.state.marks
          .filter(
            m =>
              values.slice(0, -1).includes(m.resultId) && obj(m.data).serialNumber === values.at(-1)
          )
          .map(m => ({ data: m.data }))
      )
    if (sql.includes("SELECT r.id,JSON_OBJECT('term'"))
      return Promise.resolve(
        storage.state.results.filter(r => r.imageId === null).map(r => ({ id: r.id, data: r.data }))
      )
    if (
      sql.includes("SELECT JSON_OBJECT(") &&
      sql.includes("FROM PatentQueryResult") &&
      values.length > 1
    )
      return Promise.resolve(
        storage.state.results
          .filter(
            r =>
              task.checks.some(c => c.kind === values[1] && c.id === r.checkId) &&
              r.imageId === values[2]
          )
          .map(r => ({ data: r.data }))
      )
    if (sql.includes("SELECT JSON_OBJECT('pn'")) {
      const inline = task.checks
        .filter(c => c.kind === "design")
        .flatMap(c => Object.values(output(c.output).units).flatMap(u => u.matches ?? []))
      const split = storage.state.results
        .filter(r => task.checks.some(c => c.kind === "design" && c.id === r.checkId))
        .map(r => obj(r.data))
      return Promise.resolve(
        [...inline, ...split].map(data => ({
          data: { pn: data.pn, countryCode: data.countryCode },
        }))
      )
    }
    if (sql.includes("JSON_KEYS(c.output,'$.cache')")) return Promise.resolve([])
    return Promise.resolve([{ id: 1, deletedAt: null }])
  })
  const checkFind = jest.fn(() => Promise.resolve(structuredClone(task.checks[0])))
  const checkUpdate = jest.fn(({ data }: { data: Partial<PatentQueryCheck> }) => {
    Object.assign(task.checks[0], data)
    return Promise.resolve(structuredClone(task.checks[0]))
  })
  const storage = storageDb()
  for (const check of task.checks) {
    const split = splitResults(check.output)
    check.output = json(split.data)
    for (const row of split.results) {
      const id = storage.state.results.length + 1
      storage.state.results.push({
        id,
        checkId: check.id,
        imageId: row.imageId,
        position: row.position,
        data: row.data,
      })
      for (const [position, data] of (row.marks ?? []).entries())
        storage.state.marks.push({
          id: storage.state.marks.length + 1,
          resultId: id,
          position,
          data,
        })
    }
  }

  const db = {
    patentQueryResult: storage.patentQueryResult,
    patentQueryTextMark: storage.patentQueryTextMark,
    patentQueryCache: storage.patentQueryCache,
    patentQueryTask: {
      findFirst: find,
      findFirstOrThrow: find,
      findMany: jest.fn(() => Promise.resolve([structuredClone(task)])),
      update,
      updateMany,
    },
    patentQueryCheck: {
      findMany: jest.fn(() => Promise.resolve(structuredClone(task.checks))),
      findUniqueOrThrow: checkFind,
      findFirst: checkFind,
      update: checkUpdate,
    },
    $queryRaw: raw,
  }
  const prisma = {
    ...db,
    usageLog: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((fn: (tx: typeof db) => Promise<unknown>) => {
      const run = async () => {
        const snapshot = structuredClone(task)
        const storedSnapshot = structuredClone(storage.state)
        try {
          return await fn(db)
        } catch (e) {
          task = snapshot
          Object.assign(storage.state, storedSnapshot)
          throw e
        }
      }
      const result = chain.then(run, run)
      chain = result.catch(() => undefined)
      return result
    }),
  }
  const usage = { chargeModelInTransaction: jest.fn(), assertExactCreditsAffordable: jest.fn() }
  const provider = {
    assertConfigured: jest.fn(),
    patentDetail: jest.fn(),
    citations: jest.fn(),
    detail: jest.fn(),
    matches: jest.fn(),
    triage: jest.fn(),
  }
  const oss = { signedReadUrl: jest.fn((key: string) => `https://example.test/${key}`) }
  const crawler = { fetchPdp: jest.fn() }
  const service = new PatentQueryService(
    prisma as unknown as PrismaService,
    usage as unknown as UsageService,
    provider as unknown as TrohubProvider,
    oss as unknown as OssService,
    crawler as unknown as CrawlerProvider
  )
  return {
    service,
    crawler,
    storage,
    prisma,
    usage,
    provider,
    task: () => task,
    set: (data: Partial<Task>) => Object.assign(task, data),
  }
}
describe("专利结果授权、收费和写回", () => {
  it("按需原始输入完整返回，包含重测长字段；本人/软删隔离且不加载结果", async () => {
    const s = setup()
    const i = normalizeInput(
      {
        ...fixtureInput(),
        tm: { brand: "brand", title: "title", bullets: "要点", description: "描述" },
      },
      1
    )
    s.set({ input: json(i) })
    expect(await s.service.taskInput(1, 1)).toEqual({ taskId: 1, input: i })
    expect(s.prisma.patentQueryTask.findFirst).toHaveBeenLastCalledWith({
      where: { id: 1, userId: 1, deletedAt: null },
      select: { input: true },
    })
    expect(s.storage.patentQueryResult.findMany).not.toHaveBeenCalled()
    await expect(s.service.taskInput(2, 1)).rejects.toMatchObject({ status: 404 })
    s.set({ deletedAt: new Date() })
    await expect(s.service.taskInput(1, 1)).rejects.toMatchObject({ status: 404 })
  })
  it("最新详情、历史、待办和标记返回轻结构，失败事务同时回滚明细和进度", async () => {
    const s = setup(
      taskFixture(
        [
          checkFixture("gtm", {
            status: "COMPLETED",
            output: {
              units: {
                "img-1": completedUnit([
                  { serialNumber: "01", score: 0.95, markText: "First" },
                  { serialNumber: "02", score: 0.8, markText: "Second" },
                ]),
              },
            },
          }),
        ],
        { status: "COMPLETED" }
      )
    )
    const original = await s.service.detail(1, 1)
    expect(original).not.toHaveProperty("report")
    expect(original).not.toHaveProperty("annotations")
    await s.service.mutateCheck(1, () => undefined)
    expect(await s.service.detail(1, 1)).toEqual(original)
    s.prisma.$queryRaw.mockResolvedValueOnce([{ id: 1n }]).mockResolvedValueOnce([{ total: 1n }])
    expect(
      (await s.service.list(1, { scope: "history", page: 1, pageSize: 10 })).items[0].summary
    ).toEqual(original.reportSummary)
    const todo = (await s.service.todos(1, 1, { page: 1, pageSize: 20 })).items[0]
    expect((await s.service.todo(1, 1, todo.id, true)).done).toBe(true)
    const changed = await s.service.decision(1, 1, {
      kind: "gtm",
      imageId: "img-1",
      targetId: "gtm:US:01",
      value: "dismiss",
    })
    expect((await s.service.detail(1, 1)).reportSummary).toMatchObject({
      high: 1,
      mid: 0,
      todoTotal: 1,
    })
    const before = structuredClone(s.storage.state.results)
    s.prisma.patentQueryCheck.update.mockRejectedValueOnce(new Error("write failed"))
    await expect(
      s.service.mutateCheck(1, out => {
        out.units["img-1"].matches.push({ serialNumber: "03", score: 0.9 })
      })
    ).rejects.toThrow("write failed")
    expect(s.storage.state.results).toEqual(before)
    expect(changed).not.toHaveProperty("report")
    expect(s.provider.matches).not.toHaveBeenCalled()
  })

  it("运行中的服务订阅错误通过进度返回，不冒充用户积分不足或任务失败", async () => {
    const s = setup(
      taskFixture([
        checkFixture("design", {
          error: "检测服务订阅未生效或已到期，请联系管理员",
          output: { units: { "img-1": { status: "PROCESSING", error: null } } },
        }),
      ])
    )
    const snapshot = await s.service.detail(1, 1)
    expect(snapshot.status).toBe("RUNNING")
    expect(snapshot.billing.state).toBe("PENDING")
    expect(snapshot.progress.units[0]).toMatchObject({
      kind: "design",
      status: "PROCESSING",
      error: "检测服务订阅未生效或已到期，请联系管理员",
    })
  })
  it.each(["history", "active"] as const)(
    "%s 列表将原生 SQL 的 bigint ID 转为 Prisma Int",
    async scope => {
      const s = setup()
      s.prisma.$queryRaw.mockResolvedValueOnce([{ id: 1n }]).mockResolvedValueOnce([{ total: 1n }])
      const result = await s.service.list(1, { scope, page: 1, pageSize: 10 })
      expect(s.prisma.patentQueryTask.findMany).not.toHaveBeenCalled()
      expect(s.prisma.patentQueryCheck.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { taskId: { in: [1] } } })
      )
      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 10, totalPages: 1 })
      expect(() => JSON.stringify(result)).not.toThrow()
    }
  )
  it("同键重放将原生 SQL 的 bigint ID 转为 Prisma Int，不重复创建检测", async () => {
    const s = setup()
    s.prisma.$queryRaw.mockResolvedValueOnce([{ id: 1n, deletedAt: null }])
    const result = await s.service.create(1, { ...fixtureInput(), requestId: s.task().requestId })
    expect(s.prisma.patentQueryTask.findFirst).toHaveBeenCalledWith({
      where: { id: 1, userId: 1, deletedAt: null },
      select: { input: true },
    })
    expect(result.created).toBe(false)
    expect(s.provider.assertConfigured).not.toHaveBeenCalled()
    expect(s.usage.assertExactCreditsAffordable).not.toHaveBeenCalled()
  })
  it("并发/重复结算只扣一次，扣原报价，检测结束时间不变", async () => {
    const s = setup(),
      finished = s.task().finishedAt
    await Promise.all([s.service.settle(1, 1), s.service.settle(1, 1)])
    expect(s.usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
    expect(s.usage.chargeModelInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      1,
      4,
      expect.objectContaining({
        source: "patent.query",
        exactCredits: 40,
        requestId: "patent-query:1",
      })
    )
    expect(s.task()).toMatchObject({ status: "COMPLETED", error: null, finishedAt: finished })
  })
  it("余额不足保留结果但不开放；补钱后后台不能扣，手动成功才开放", async () => {
    const s = setup()
    s.usage.chargeModelInTransaction.mockRejectedValueOnce(new BadRequestException("积分余额不足"))
    const unpaid = await s.service.settle(1, 1)
    expect(unpaid).not.toHaveProperty("reportSummary")
    expect(unpaid.billing.state).toBe("PAYMENT_REQUIRED")
    expect(s.storage.state.results).toEqual([])
    await expect(
      s.service.results(1, 1, { kind: "tm", page: 1, pageSize: 20 })
    ).rejects.toMatchObject({ status: 402 })
    await s.service.settle(1, 1, false)
    expect(s.usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
    await s.service.settle(1, 1, true)
    expect(s.task().status).toBe("COMPLETED")
  })
  it.each([
    ["P2034", "SETTLEMENT_RETRYABLE"],
    ["UNKNOWN", "SETTLEMENT_FAILED"],
  ])("结算错误 %s 分流为 %s", async (code, prefix) => {
    const s = setup()
    s.usage.chargeModelInTransaction.mockRejectedValueOnce({ code })
    await s.service.settle(1, 1)
    expect(s.task().error).toContain(`[${prefix}]`)
    expect(await s.service.detail(1, 1)).not.toHaveProperty("reportSummary")
  })
  it("P2002 先回滚；异常既有扣费记录进入核对，不补扣", async () => {
    const s = setup()
    s.usage.chargeModelInTransaction.mockRejectedValueOnce({ code: "P2002" })
    s.prisma.usageLog.findUnique.mockResolvedValue({ id: 9 })
    await s.service.settle(1, 1)
    expect(s.task().status).toBe("SETTLING")
    expect(s.task().error).toContain("待核对")
    await s.service.settle(1, 1, false)
    expect(s.usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
  })
  it("合并待办仍可保存完成状态，旧逐条 ID 拒绝操作且不调用上游", async () => {
    const s = setup(
      taskFixture(
        [
          checkFixture("copy", {
            status: "COMPLETED",
            output: {
              units: {
                "img-1": completedUnit([
                  { id: "C1", matchType: "verified" },
                  { id: "C2", matchType: "verified" },
                ]),
              },
            },
          }),
        ],
        { status: "COMPLETED" }
      )
    )
    await s.service.todo(1, 1, "copy:img-1:verified:prd", true)
    expect(
      (await s.service.todos(1, 1, { page: 1, pageSize: 20 })).items.map(t => [
        String(t.id),
        t.done === true,
      ])
    ).toEqual([["copy:img-1:verified:prd", true]])
    expect((await s.service.detail(1, 1)).reportSummary).toMatchObject({
      todoTotal: 1,
      todoDone: 1,
    })
    await expect(s.service.todo(1, 1, "copy:img-1:verified", true)).rejects.toMatchObject({
      status: 400,
    })
    expect((await s.service.todo(1, 1, "copy:img-1:verified:prd", false)).done).toBe(false)
    expect(s.provider.detail).not.toHaveBeenCalled()
    expect(s.provider.matches).not.toHaveBeenCalled()
    expect(s.provider.triage).not.toHaveBeenCalled()
  })
  it("所有报告入口先校验本人和结算，不调用上游", async () => {
    const s = setup()
    s.set({ error: "[PAYMENT_REQUIRED] 不足" })
    for (const fn of [
      () => s.service.patent(1, 1, "design:US:D1"),
      () => s.service.refreshImages(1, 1, { kind: "tm" }),
      () => s.service.decision(1, 1, { kind: "tm", targetId: "tm:a:US:01", value: "flag" }),
      () => s.service.todo(1, 1, "tm:a", true),
    ])
      await expect(fn()).rejects.toMatchObject({ status: 402 })
    await expect(s.service.detail(2, 1)).rejects.toMatchObject({ status: 404 })
    expect(s.provider.patentDetail).not.toHaveBeenCalled()
    expect(s.provider.detail).not.toHaveBeenCalled()
  })
  it("同 UUID 同输入先返回既有结果；改输入/删除后重放均 409", async () => {
    const s = setup(),
      dto = { ...fixtureInput(), requestId: s.task().requestId }
    expect((await s.service.create(1, dto)).created).toBe(false)
    expect(s.provider.assertConfigured).not.toHaveBeenCalled()
    expect(s.usage.assertExactCreditsAffordable).not.toHaveBeenCalled()
    await expect(s.service.create(1, { ...dto, sites: ["DE"] })).rejects.toMatchObject({
      status: 409,
    })
    s.prisma.$queryRaw.mockResolvedValue([{ id: 1, deletedAt: new Date() }])
    await expect(s.service.create(1, dto)).rejects.toMatchObject({ status: 409 })
  })
  it("旧请求未传类别时同 UUID 仍返回首次冻结的类别", async () => {
    const s = setup(),
      original = fixtureInput()
    s.set({
      input: json({
        ...original,
        resolved: { ...original.resolved, classCodes: ["032"] },
      }) as Prisma.JsonObject,
    })
    const replay = await s.service.create(1, { ...original, requestId: s.task().requestId })
    expect(replay.created).toBe(false)
    expect(obj(obj(replay.data.input).resolved).classCodes).toEqual(["032"])
  })
  it("同 UUID 按归一化后的显式类别比较，修改或清空需换 UUID", async () => {
    const s = setup(),
      original = fixtureInput(),
      dto = { ...original, requestId: s.task().requestId }
    expect(
      (await s.service.create(1, { ...dto, tm: { ...dto.tm, classCodes: ["21", "021"] } })).created
    ).toBe(false)
    for (const classCodes of [["032"], []])
      await expect(
        s.service.create(1, { ...dto, tm: { ...dto.tm, classCodes } })
      ).rejects.toMatchObject({ status: 409 })
    expect(s.provider.assertConfigured).not.toHaveBeenCalled()
  })
  it("文字商标只上送明确选择的多类，空选时省略上游分类码", async () => {
    const s = setup()
    const dto = { sites: ["US"], tm: { title: "保温杯", classCodes: ["032", "21", "021"] } }
    const send = (classCodes: string[]) =>
      s.service.submitBody(
        taskFixture([], {
          input: json(
            normalizeInput({ ...dto, tm: { ...dto.tm, classCodes } }, 1)
          ) as Prisma.JsonObject,
        }),
        "tm"
      )
    expect(await send(dto.tm.classCodes)).toMatchObject({ classCodes: ["021", "032"] })
    expect(await send([])).not.toHaveProperty("classCodes")
  })
  it.each([undefined, "", "   ", " 汽车侧踏板 "])(
    "外观品名 %p 只传用户填写的非空值，不用文件名兜底",
    async productName => {
      const task = taskFixture([], {
        input: json(
          normalizeInput({ ...fixtureInput(), design: { productName } }, 1)
        ) as Prisma.JsonObject,
      })
      const s = setup(task),
        before = JSON.stringify(task.input),
        body = await s.service.submitBody(task, "design"),
        images = body.images as Record<string, unknown>[]
      expect(images[0]).toMatchObject({
        imageID: "img-1",
        image: "https://example.test/patent-query/1/cup.jpg",
        countries: ["US"],
        removeBg: true,
        rerank: true,
      })
      if (productName?.trim()) expect(images[0].productName).toBe(productName.trim())
      else expect(images[0]).not.toHaveProperty("productName")
      expect(JSON.stringify(task.input)).toBe(before)
    }
  )
  it("文字 base64 临时组装，类别三位，固定过滤选项，不存编码正文", async () => {
    const s = setup(),
      before = JSON.stringify(s.task().input)
    jest.spyOn(s.service, "imageBytes").mockResolvedValue(Buffer.from("test-image"))
    const body = await s.service.submitBody(s.task(), "tm")
    expect(body).toMatchObject({
      classCodes: ["021"],
      markTypes: ["text"],
      skipNumbers: true,
      skipStopWords: true,
      images: [{ imageID: "img-1", base64: Buffer.from("test-image").toString("base64") }],
    })
    expect(JSON.stringify(s.task().input)).toBe(before)
  })
  it("并发写分项的独立节点不互相覆盖", async () => {
    const s = setup()
    await Promise.all([
      s.service.mutateCheck(1, out => {
        out.text = { ...out.text, words: [{ term: "word", marks: [] }] }
      }),
      s.service.mutateCheck(1, out => {
        out.text = { ...out.text, warnings: ["OCR"] }
      }),
    ])
    const out = output(s.task().checks[0].output)
    expect(out.text).not.toHaveProperty("words")
    expect(s.storage.state.results[0].data).toEqual({ term: "word" })
    expect(out.text?.warnings).toEqual(["OCR"])
  })
  it("并发标记保留两个决策，并返回 local_only", async () => {
    const s = setup(
      taskFixture(
        [
          checkFixture("gtm", {
            status: "COMPLETED",
            output: {
              units: {
                "img-1": completedUnit([
                  { serialNumber: "01", score: 0.95 },
                  { serialNumber: "02", score: 0.8 },
                ]),
              },
            },
          }),
        ],
        { status: "COMPLETED" }
      )
    )
    const results = await Promise.all([
      s.service.decision(1, 1, {
        kind: "gtm",
        imageId: "img-1",
        targetId: "gtm:US:01",
        value: "dismiss",
      }),
      s.service.decision(1, 1, {
        kind: "gtm",
        imageId: "img-1",
        targetId: "gtm:US:02",
        value: "flag",
      }),
    ])
    expect(Object.keys(obj(obj(s.task().annotations).decisions))).toHaveLength(2)
    expect(results[1].syncStatus).toBe("local_only")
    expect(s.provider.triage).not.toHaveBeenCalled()
  })
  it("图片刷新只改 URL，保留风险、标记与完成状态", async () => {
    const s = setup(
      taskFixture(
        [
          checkFixture("gtm", {
            status: "COMPLETED",
            output: {
              units: {
                "img-1": completedUnit([{ serialNumber: "01", score: 0.95, image: "old" }]),
              },
            },
          }),
        ],
        {
          status: "COMPLETED",
          annotations: { decisions: { "gtm:img-1:US:01": { value: "flag" } } },
        }
      )
    )
    s.provider.detail.mockResolvedValue({ images: [{ id: "img-1", image: "new-product" }] })
    s.provider.matches.mockResolvedValue({
      items: [{ serialNumber: "01", score: 0.1, image: "new" }],
      total: 1,
      hasNextPage: false,
    })
    await s.service.refreshImages(1, 1, { kind: "gtm", imageId: "img-1" })
    const restored = await s.service.getTask(1, 1)
    const m = output(restored.checks[0].output).units["img-1"].matches[0]
    expect(output(s.task().checks[0].output).units["img-1"]).not.toHaveProperty("matches")
    expect(m).toMatchObject({ score: 0.95, image: "new" })
    expect(s.task().checks[0].status).toBe("COMPLETED")
    expect(obj(obj(s.task().annotations).decisions)).toHaveProperty("gtm:img-1:US:01")
  })
  it("专利抽屉缓存复用；过期只补 URL，不改变著录判断", async () => {
    const s = setup(
      taskFixture(
        [
          checkFixture("design", {
            status: "COMPLETED",
            output: { units: { "img-1": completedUnit([{ pn: "D1", score: 0.95 }]) } },
          }),
        ],
        { status: "COMPLETED" }
      )
    )
    s.provider.patentDetail.mockResolvedValueOnce({
      patents: [{ pn: "USD1", title: "original", imageUrls: ["old"] }],
      notFound: [],
    })
    await s.service.patent(1, 1, "design:US:D1")
    await s.service.patent(1, 1, "design:US:D1")
    expect(s.provider.patentDetail).toHaveBeenCalledTimes(1)
    s.provider.citations.mockResolvedValue({ patents: [], truncated: false })
    for (const direction of ["cited", "citedBy"] as const) {
      await s.service.patent(1, 1, "design:US:D1", direction)
      await s.service.patent(1, 1, "design:US:D1", direction)
    }
    expect(s.provider.citations).toHaveBeenCalledTimes(2)
    const cacheReads = s.storage.patentQueryCache.findUnique.mock.calls.length
    await s.service.detail(1, 1)
    expect(s.storage.patentQueryCache.findUnique).toHaveBeenCalledTimes(cacheReads)
    await expect(s.service.patent(1, 1, "design:US:D2")).rejects.toMatchObject({ status: 404 })
    expect(output(s.task().checks[0].output).cache).toBeUndefined()
    expect(s.storage.state.caches).toHaveLength(3)
    s.storage.state.caches[0].fetchedAt = new Date("2000-01-01T00:00:00Z")
    s.provider.patentDetail.mockResolvedValueOnce({
      patents: [{ pn: "USD1", title: "changed", imageUrls: ["fresh"] }],
      notFound: [],
    })
    const refreshed = await s.service.patent(1, 1, "design:US:D1")
    expect(obj(refreshed).patents).toEqual([
      { pn: "USD1", title: "original", imageUrls: ["fresh"] },
    ])
  })
})

describe("专利查询 Listing 爬虫导入", () => {
  it("商品 URL 转成标准爬虫链接，站点优先于入参，返回文本字段", async () => {
    const { service, crawler } = setup()
    crawler.fetchPdp.mockResolvedValue({
      title: "Owala FreeSip",
      second_title: "Owala FreeSip Stainless Steel Bottle",
      brand: "Owala",
      bullets: ["Leak proof", "Stainless steel"],
      description: ["First paragraph", "Second paragraph"],
    })
    expect(
      await service.importListing({
        input: "https://www.amazon.com/Owala-FreeSip-Stainless-Steel-Bottle/dp/B0H6977TPZ?ref=test",
        marketplace: "DE",
      })
    ).toEqual({
      asin: "B0H6977TPZ",
      marketplace: "US",
      brand: "Owala",
      title: "Owala FreeSip Stainless Steel Bottle",
      bullets: "Leak proof\nStainless steel",
      description: "First paragraph\nSecond paragraph",
      images: [],
      warnings: [],
    })
    expect(crawler.fetchPdp).toHaveBeenCalledTimes(1)
    expect(crawler.fetchPdp).toHaveBeenCalledWith("https://www.amazon.com/dp/B0H6977TPZ")
  })
  it.each([
    ["US", "amazon.com"],
    ["GB", "amazon.co.uk"],
    ["DE", "amazon.de"],
    ["FR", "amazon.fr"],
    ["IT", "amazon.it"],
    ["ES", "amazon.es"],
    ["JP", "amazon.co.jp"],
  ] as const)("裸 ASIN 按 %s 站点抓取", async (marketplace, domain) => {
    const { service, crawler } = setup()
    crawler.fetchPdp.mockResolvedValue({ title: "Title", second_title: "Highlights" })
    const result = await service.importListing({ input: " b0h6977tpz ", marketplace })
    expect(crawler.fetchPdp).toHaveBeenCalledWith(`https://www.${domain}/dp/B0H6977TPZ`)
    expect(result).toMatchObject({
      title: "Title Highlights",
      bullets: "",
      description: "",
      warnings: ["未获取完整商品描述，可手动补充"],
    })
  })
  it("默认 US，兼容字符串描述，缺副标题不丢标题", async () => {
    const { service, crawler } = setup()
    crawler.fetchPdp.mockResolvedValue({
      title: "Title",
      description: "Description",
      bullets: "Bullet",
    })
    expect(await service.importListing({ input: "B0H6977TPZ" })).toMatchObject({
      marketplace: "US",
      title: "Title",
      description: "Description",
      bullets: "Bullet",
      warnings: [],
    })
  })
  it.each([
    "https://evil.com/dp/B0H6977TPZ",
    "https://www.amazon.com.evil.com/dp/B0H6977TPZ",
    "https://user:pass@amazon.com/dp/B0H6977TPZ",
    "https://www.amazon.com/s?k=bottle",
  ])("非法链接不调用爬虫：%s", async input => {
    const { service, crawler } = setup()
    await expect(service.importListing({ input })).rejects.toMatchObject({ status: 400 })
    expect(crawler.fetchPdp).not.toHaveBeenCalled()
  })
  it("空内容返回 404；抓取失败返回安全提示，不调用检测或扣费", async () => {
    const { service, crawler, provider, usage } = setup()
    crawler.fetchPdp
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new CrawlerError("UPSTREAM_5XX", "private upstream message"))
    await expect(service.importListing({ input: "B0H6977TPZ" })).rejects.toMatchObject({
      status: 404,
    })
    await expect(service.importListing({ input: "B0H6977TPZ" })).rejects.toMatchObject({
      status: 503,
      message: "商品信息导入失败，请稍后重试或手动填写",
    })
    expect(provider.detail).not.toHaveBeenCalled()
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })
})

describe("Listing 商品图 OCR", () => {
  const listing = (index: number) => ({
    id: `listing-${index}`,
    url: `https://m.media-amazon.com/images/I/${index}.jpg`,
    name: `商品附图${index}`,
  })
  afterEach(() => jest.restoreAllMocks())
  it("导入保留主附图顺序、稳定 ID、去重并提示无效图", async () => {
    const { service, crawler } = setup()
    crawler.fetchPdp.mockResolvedValue({
      title: "商品",
      description: "描述",
      imageUrl: listing(0).url,
      otherImagesUrl: [listing(0).url, "", listing(1).url, "https://127.0.0.1/a.jpg"],
    })
    const first = await service.importListing({ input: "B0H6977TPZ" })
    expect(first.images.map(i => i.url)).toEqual([listing(0).url, listing(1).url])
    expect(first.images[0].name).toBe("商品主图")
    expect(first.warnings).toContain("部分商品图地址无效，已忽略，请手动核对")
    expect((await service.importListing({ input: "B0H6977TPZ" })).images).toEqual(first.images)
  })
  it("1 张 OSS 加 6 张商品图只进入文字 OCR，报价和其他三项不变", async () => {
    const { service } = setup()
    const i = normalizeInput(
      {
        ...fixtureInput(),
        tm: { brand: "品牌", images: Array.from({ length: 6 }, (_, n) => listing(n)) },
      },
      1
    )
    const task = taskFixture([], { input: json(i) as Prisma.JsonObject })
    jest.spyOn(service, "imageBytes").mockResolvedValue(Buffer.from("oss"))
    const download = jest
      .spyOn(service, "listingImageBytes")
      .mockResolvedValue(Buffer.from("listing"))
    expect(service.quote(1, i).quotedCredits).toBe(40)
    expect(await service.submitBody(task, "tm")).toMatchObject({
      images: [
        { imageID: "img-1", base64: Buffer.from("oss").toString("base64") },
        ...i.tm!.images!.map(image => ({
          imageID: image.id,
          base64: Buffer.from("listing").toString("base64"),
        })),
      ],
    })
    expect(download).toHaveBeenCalledTimes(6)
    download.mockClear()
    for (const kind of ["design", "copy", "gtm"] as const)
      expect((await service.submitBody(task, kind)).images).toHaveLength(1)
    i.tm!.includeImageText = false
    expect(
      (await service.submitBody({ ...task, input: json(i) as Prisma.JsonObject }, "tm")).images
    ).toBeUndefined()
    expect(download).not.toHaveBeenCalled()
  })
  it("商品图下载校验安全参数与真实图片，不静默丢弃失败图片", async () => {
    const { service } = setup()
    const bytes = await sharp({
      create: { width: 200, height: 200, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    const get = jest.spyOn(axios, "get").mockResolvedValue({ data: bytes })
    expect(await service.listingImageBytes(listing(0).url)).toEqual(bytes)
    expect(get).toHaveBeenCalledWith(
      listing(0).url,
      expect.objectContaining({
        maxRedirects: 0,
        proxy: false,
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024,
      })
    )
    get.mockClear()
    await expect(service.listingImageBytes("https://localhost/a.jpg")).rejects.toThrow(
      "商品图仅支持"
    )
    expect(get).not.toHaveBeenCalled()
    for (const data of [
      Buffer.from("not image"),
      Buffer.alloc(10 * 1024 * 1024 + 1),
      Buffer.alloc(0),
    ]) {
      get.mockResolvedValueOnce({ data })
      await expect(service.listingImageBytes(listing(0).url)).rejects.toThrow("商品图读取失败")
    }
    for (const message of ["timeout", "redirect"]) {
      get.mockRejectedValueOnce(new Error(message))
      await expect(service.listingImageBytes(listing(0).url)).rejects.toThrow("商品图读取失败")
    }
    get.mockRejectedValueOnce(new Error("timeout"))
    const i = normalizeInput({ sites: ["US"], tm: { brand: "品牌", images: [listing(0)] } }, 1)
    await expect(
      service.submitBody(taskFixture([], { input: json(i) as Prisma.JsonObject }), "tm")
    ).rejects.toThrow("商品图读取失败")
  })
})

describe("四类标记只保存在本地", () => {
  it.each(["design", "copy", "gtm", "tm"] as const)(
    "%s 的 flag/dismiss/none 不读第二份结果、不调用上游",
    async kind => {
      const raw = {
        pn: "D1",
        patentID: "upstream-D1",
        id: "C1",
        serialNumber: "01",
        score: 0.95,
        level: "high",
        matchType: "identical",
      }
      const targetId =
        kind === "tm"
          ? "tm:word:US:01"
          : kind === "copy"
            ? "copy:C1"
            : `${kind}:US:${kind === "design" ? "D1" : "01"}`
      const key = kind === "tm" ? targetId : `${kind}:img-1:${targetId.slice(kind.length + 1)}`
      const check = checkFixture(kind, {
        status: "COMPLETED",
        upstreamTaskId: "upstream",
        output:
          kind === "tm"
            ? { units: {}, text: { words: [{ term: "word", marks: [raw] }] } }
            : { units: { "img-1": completedUnit([raw]) } },
      })
      const s = setup(
        taskFixture([check], {
          status: "COMPLETED",
          annotations: { decisions: { [key]: { value: "flag", synced: false } } },
        })
      )
      await s.service.mutateCheck(check.id, () => undefined)
      for (const value of ["flag", "dismiss", "none"] as const) {
        s.storage.patentQueryResult.findMany.mockClear()
        const response = await s.service.decision(1, 1, {
          kind,
          targetId,
          imageId: kind === "tm" ? undefined : "img-1",
          value,
        })
        expect(response).toMatchObject({
          syncStatus: "local_only",
          message: "标记已保存，仅用于本报告",
        })
        expect(obj(obj(s.task().annotations).decisions)[key]).toEqual({ value })
        expect(s.storage.patentQueryResult.findMany).not.toHaveBeenCalled()
        expect(s.provider.triage).not.toHaveBeenCalled()
      }
    }
  )
})

describe("文字商标存储事务", () => {
  it("output 写入失败同时回滚父词更新、子行更新及追加", async () => {
    const s = setup(
      taskFixture(
        [
          checkFixture("tm", {
            status: "COMPLETED",
            output: {
              units: {},
              text: {
                words: [{ term: "word", marks: [{ serialNumber: "01", imageUrl: "old" }] }],
                warnings: ["old"],
              },
            },
          }),
        ],
        { status: "COMPLETED" }
      )
    )
    await s.service.mutateCheck(1, () => undefined)
    const before = structuredClone({ state: s.storage.state, output: s.task().checks[0].output })
    s.prisma.patentQueryCheck.update.mockRejectedValueOnce(new Error("output failed"))
    await expect(
      s.service.mutateCheck(1, out => {
        rows(out.text!.words)[0].term = "changed"
        rows(out.text!.words)[0].marks = [
          { serialNumber: "01", imageUrl: "new" },
          { serialNumber: "02" },
        ]
        out.text!.warnings = ["new"]
      })
    ).rejects.toThrow("output failed")
    expect(s.storage.patentQueryTextMark.update).toHaveBeenCalled()
    expect(s.storage.patentQueryTextMark.createMany).toHaveBeenCalledTimes(1)
    expect(s.storage.state).toEqual(before.state)
    expect(s.task().checks[0].output).toEqual(before.output)
  })
})
