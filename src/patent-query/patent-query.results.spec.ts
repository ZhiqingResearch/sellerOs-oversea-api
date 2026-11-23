/* eslint-disable @typescript-eslint/require-await -- Promise-based mock adapters perform no I/O. */
import { Prisma } from "@prisma/client"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { ResultPageDto, ResultsQueryDto, RiskPageDto } from "./dto/patent-query.dto"
import { buildReport, imageTarget } from "./patent-query.report"
import {
  cards,
  contextPage,
  decisionTarget,
  detailRow,
  matches,
  readLight,
  readLightBatch,
  resultPage,
  riskPage,
  word,
  wordId,
} from "./patent-query.results"
import { PatentQueryService } from "./patent-query.service"
import { splitResults } from "./patent-query.storage"
import { Bag, input, obj, output, rows, str, Task } from "./patent-query.types"
import { checkFixture, completedUnit, taskFixture } from "./testing/fixtures"

const lightFields = [
  "pn",
  "id",
  "serialNumber",
  "countryCode",
  "score",
  "reasonCode",
  "riskLevel",
  "expired",
  "status",
  "legalStatus",
  "matchType",
  "level",
  "term",
  "title",
  "markText",
  "sourceHost",
]
const project = (data: Bag) =>
  Object.fromEntries(lightFields.map(field => [field, data[field] ?? null]))
function fixture() {
  return taskFixture(
    [
      checkFixture("design", {
        status: "COMPLETED",
        output: {
          units: {
            "img-1": completedUnit([
              { pn: "high", score: 0.95, title: "高风险", reason: "长原因".repeat(2000) },
              { pn: "mid", score: 0.8 },
              { pn: "hidden", score: 0.2 },
              { pn: "low", score: 0.6 },
              { pn: "expired", score: 0.99, expired: true },
              { pn: "string", score: "0.99" },
              { pn: "uncompared", score: 0.99, reasonCode: "NOT_COMPARED" },
              { score: 0.99 },
            ]),
          },
        },
      }),
      checkFixture("copy", {
        id: 2,
        status: "COMPLETED",
        output: {
          units: {
            "img-1": completedUnit(
              [
                { id: "same", matchType: "identical" },
                { id: "derivative", matchType: "derivative" },
              ],
              {
                knownIpMatch: { isMatch: true, note: "长说明".repeat(1000) },
                troCases: [{ caseNumber: "C1", text: "案件正文".repeat(1000) }],
              }
            ),
          },
        },
      }),
      checkFixture("gtm", {
        id: 3,
        status: "COMPLETED",
        output: { units: { "img-1": completedUnit([{ serialNumber: "g", score: 0.71 }]) } },
      }),
      checkFixture("tm", {
        id: 4,
        status: "COMPLETED",
        output: {
          units: {},
          text: {
            words: [
              {
                term: " Coca-Cola ",
                genericity: { kind: "brand", kindLabel: "品牌词" },
                where: ["brand"],
                tro: { cases: [{ caseNumber: "C1" }], total: 1 },
                marks: [
                  {
                    serialNumber: "001",
                    level: "mid",
                    classes: [{ code: "021", description: "长类别".repeat(2000) }],
                  },
                  { level: "low" },
                ],
              },
              {
                term: "coca-cola",
                marks: [
                  { serialNumber: "001", countryCode: "US", level: "high" },
                  { serialNumber: "001", countryCode: "GB", level: "mid" },
                  { level: "high" },
                ],
              },
              { term: "dead", marks: [{ serialNumber: "02", status: "DEAD", level: "high" }] },
              { term: "empty", marks: [] },
              {
                term: "",
                marks: [
                  { serialNumber: "01", level: "low" },
                  { serialNumber: "01", level: "mid" },
                ],
              },
            ],
            imageOCR: [{ imageID: "img-1", text: "OCR正文".repeat(2000) }],
          },
        },
      }),
    ],
    {
      status: "COMPLETED",
      annotations: {
        decisions: {
          "design:img-1:US:hidden": { value: "flag" },
          "design:img-1:US:high": { value: "dismiss" },
          "tm:coca-cola:US:001": { value: "dismiss" },
        },
      },
    }
  )
}
function database(task = fixture()) {
  const results: {
      id: number
      checkId: number
      imageId: string | null
      position: number
      data: Bag
    }[] = [],
    marks: { id: number; resultId: number; position: number; data: Bag }[] = []
  const checks = task.checks.map(c => {
    const split = splitResults(c.output)
    for (const r of split.results) {
      const id = results.length + 1
      results.push({
        id,
        checkId: c.id,
        imageId: r.imageId,
        position: r.position,
        data: obj(r.data),
      })
      for (const [position, data] of (r.marks ?? []).entries())
        marks.push({ id: marks.length + 1, resultId: id, position, data: obj(data) })
    }
    return { ...c, output: split.data }
  })
  const raw = jest.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
    const sql = "sql" in query ? query.sql : query.join("?")
    const values = "sql" in query ? query.values : []
    if (sql.includes("FOR UPDATE")) return [{ id: task.id }]
    if (sql.includes("FROM PatentQueryTask WHERE"))
      return task.deletedAt || values[0] !== task.id || values[1] !== task.userId
        ? []
        : [structuredClone({ ...task, checks: undefined })]
    if (sql.includes("AS inline") && sql.includes("JSON_KEYS"))
      return checks.flatMap(c =>
        Object.entries(output(c.output).units).map(([imageId, unit]) => ({
          checkId: c.id,
          imageId,
          inline: 0,
          data: {
            status: unit.status,
            error: unit.error,
            complete: unit.complete,
            result: {
              riskLevel: unit.result.riskLevel ?? null,
              knownIpMatch: obj(unit.result.knownIpMatch),
              troCases: rows(unit.result.troCases).map(c => ({
                caseNumber: c.caseNumber ?? null,
                caseNo: c.caseNo ?? null,
              })),
              riskDrivers: unit.result.riskDrivers ?? null,
            },
          },
        }))
      )
    if (sql.includes("AS inline"))
      return checks.map(c => ({
        checkId: c.id,
        inline: 0,
        data: {
          warnings: output(c.output).text?.warnings ?? null,
          imageOCR: rows(output(c.output).text?.imageOCR).map(o => ({
            imageID: o.imageID,
            error: o.error ?? null,
          })),
        },
      }))
    if (sql.includes("'_inline'"))
      return results.map(r => ({
        ...r,
        data: {
          ...project(r.data),
          genericity: r.data.genericity ?? null,
          where: r.data.where ?? null,
          tro: r.data.tro ?? null,
          _inline: 0,
        },
      }))
    if (sql.includes("'reason',LEFT")) {
      const selected = values.slice(1).map(Number)
      return (sql.includes("FROM PatentQueryTextMark") ? marks : results)
        .filter(r => selected.includes(r.id))
        .map(r => ({
          id: r.id,
          data: {
            ...project(r.data),
            reason: str(r.data.reason).slice(0, 240),
            classCodes: rows(r.data.classes).map(c => c.code),
          },
        }))
    }
    if (sql.includes("SELECT m.id,m.resultId"))
      return marks.map(m => ({ ...m, data: project(m.data) }))
    if (sql.includes("SELECT r.id,JSON_OBJECT('term'"))
      return results
        .filter(r => r.imageId === null)
        .map(r => ({ id: r.id, data: { term: r.data.term } }))
    if (sql.includes("SELECT JSON_OBJECT('serialNumber'"))
      return marks
        .filter(
          m =>
            values.slice(0, -1).includes(m.resultId) &&
            str(m.data.serialNumber).trim() === values.at(-1)
        )
        .map(m => ({ data: project(m.data) }))
    if (sql.includes("SELECT JSON_OBJECT('pn'"))
      return results
        .filter(
          r =>
            checks.find(c => c.id === r.checkId)?.kind === values[1] &&
            r.imageId === values[2] &&
            imageTarget(values[1] as "design", r.data)?.endsWith(
              encodeURIComponent(String(values[3]))
            )
        )
        .map(r => ({ data: project(r.data) }))
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  const db = {
    $queryRaw: raw,
    patentQueryCheck: {
      findMany: jest.fn(async () =>
        structuredClone(
          checks.map(({ output: ignored, ...check }) => {
            void ignored
            return check
          })
        )
      ),
    },
    patentQueryTask: {
      findFirst: jest.fn(async ({ where }: { where: { id: number; userId: number } }) =>
        task.id === where.id && task.userId === where.userId && !task.deletedAt
          ? structuredClone(task)
          : null
      ),
      update: jest.fn(async ({ data }: { data: Partial<Task> }) =>
        Object.assign(task, structuredClone(data))
      ),
    },
    patentQueryResult: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
        results.filter(r => where.id.in.includes(r.id))
      ),
    },
    patentQueryTextMark: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
        marks.filter(r => where.id.in.includes(r.id))
      ),
    },
  }
  let chain: Promise<unknown> = Promise.resolve()
  const prisma = {
    ...db,
    $transaction: jest.fn((fn: (tx: Prisma.TransactionClient) => unknown) => {
      const work = chain.then(() => fn(db as unknown as Prisma.TransactionClient))
      chain = work.catch(() => undefined)
      return work
    }),
  }
  const provider = { detail: jest.fn(), matches: jest.fn(), triage: jest.fn() }
  const service = new PatentQueryService(
    prisma as never,
    {} as never,
    provider as never,
    { signedReadUrl: (key: string) => `https://test/${key}` } as never,
    {} as never
  )
  return {
    db: db as unknown as Prisma.TransactionClient,
    prisma,
    raw,
    service,
    provider,
    results,
    marks,
    task,
  }
}

describe("轻投影与分页", () => {
  it("批量轻读取隔离任务、保留ID顺序且查询次数固定；summary不生成待办长文", async () => {
    const first = fixture(),
      second = fixture(),
      pending = fixture()
    second.id = 2
    pending.id = 3
    pending.status = "SETTLING"
    for (const task of [second, pending])
      for (const check of task.checks) {
        check.id += task.id * 10
        check.taskId = task.id
      }
    const adapters = [first, second, pending].map(task => database(task))
    const raw = jest.fn(async (query: Prisma.Sql) => {
      if (query.sql.startsWith("SELECT id FROM PatentQueryTask")) return [{ id: 2 }, { id: 1 }]
      if (query.sql.startsWith("SELECT COUNT(*)")) return [{ total: 2n }]
      const selected = query.values.map(Number)
      const header = query.sql.includes("FROM PatentQueryTask WHERE")
      const settled =
        query.sql.includes("FROM PatentQueryResult") ||
        query.sql.includes("FROM PatentQueryTextMark")
      const result = []
      for (const adapter of adapters) {
        if (
          header &&
          (!selected.slice(0, -1).includes(adapter.task.id) ||
            query.values.at(-1) !== adapter.task.userId)
        )
          continue
        if (settled && !selected.includes(adapter.task.id)) continue
        const q = header
          ? { sql: query.sql, values: [adapter.task.id, adapter.task.userId] }
          : query
        const projected = await adapter.raw(q as Prisma.Sql)
        result.push(
          ...projected.map(row => {
            if (!("checkId" in row) && !("resultId" in row)) return row
            const value = { ...row } as Record<string, unknown>
            if (typeof value.id === "number") value.id += adapter.task.id * 100
            if (typeof value.resultId === "number") value.resultId += adapter.task.id * 100
            return value
          })
        )
      }
      return result
    })
    const findMany = jest.fn(async () =>
      (await Promise.all(adapters.map(a => a.db.patentQueryCheck.findMany({})))).flat()
    )
    const db = {
      $queryRaw: raw,
      patentQueryCheck: { findMany },
    } as unknown as Prisma.TransactionClient
    const batch = await readLightBatch(db, 1, [2, 3, 1])
    expect(batch.map(l => l.task.id)).toEqual([2, 3, 1])
    for (const light of batch) {
      const source = [first, second, pending].find(t => t.id === light.task.id)!
      expect(light.task.checks.map(c => c.id)).toEqual(source.checks.map(c => c.id))
      if (light.task.status === "SETTLING") expect(light.results).toEqual([])
      else {
        const summary = buildReport(light.task, { light: true, summaryOnly: true })
        expect(summary.summary).toEqual(buildReport(source).summary)
        expect(summary.todos).toEqual([])
      }
    }
    expect(raw).toHaveBeenCalledTimes(5)
    expect(findMany).toHaveBeenCalledTimes(1)
    const signedReadUrl = jest.fn(() => {
      throw new Error("历史列表不应签名图片")
    })
    const service = new PatentQueryService(
      {
        ...db,
        $transaction: async (fn: (tx: Prisma.TransactionClient) => unknown) => fn(db),
      } as never,
      {} as never,
      {} as never,
      { signedReadUrl } as never,
      {} as never
    )
    raw.mockClear()
    const history = await service.list(1, {
      scope: "history",
      page: 1,
      pageSize: 2,
    })
    expect(history).toMatchObject({ total: 2, page: 1, pageSize: 2, totalPages: 1 })
    expect(history.items.map(item => item.id)).toEqual([2, 1])
    expect(history.items.map(item => item.summary)).toEqual([
      buildReport(second).summary,
      buildReport(first).summary,
    ])
    expect(raw).toHaveBeenCalledTimes(7)
    expect(signedReadUrl).not.toHaveBeenCalled()
    raw.mockClear()
    findMany.mockClear()
    expect(await readLightBatch(db, 1, [])).toEqual([])
    expect(raw).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
    await expect(readLightBatch(db, 99, [1, 2])).rejects.toThrow("检测记录不存在")
  })
  it("投影中的null、严格score、归一及统计/待办与完整报告一致；标记不改风险", async () => {
    const s = database(),
      light = await readLight(s.db, 1, 1),
      full = buildReport(s.task)
    expect(light.report.summary).toEqual(full.summary)
    expect(light.report.gaps).toEqual(full.gaps)
    expect(light.report.todos.map(t => [t.id, t.title, t.targets, t.action])).toEqual(
      full.todos.map(t => [t.id, t.title, t.targets, t.action])
    )
    const clear = buildReport({ ...s.task, annotations: {} })
    expect(full.summary).toEqual(clear.summary)
    expect(full.todos).toEqual(clear.todos)
    for (const kind of ["design", "copy", "gtm"] as const)
      expect(matches(light, kind).map(m => m.level)).toEqual(
        rows(full[kind]["img-1"].matches).map(m => m.level)
      )
    expect(matches(light, "design").find(m => m.pn === "hidden")).toMatchObject({
      flagged: true,
      hidden: true,
      level: "low",
    })
    const sql = s.raw.mock.calls.map(([q]) => (q as Prisma.Sql).sql).join("\n")
    expect(sql).not.toMatch(/SELECT\s+(?:r\.|m\.|c\.)?(?:data|output)\b/)
    expect(sql).not.toContain("'$.reason'")
    expect(sql).not.toContain("'$.classes'")
  })
  it("所有风险页拼接保序且不丢重；折叠独立于facets及标记", async () => {
    const light = await readLight(database().db, 1, 1)
    for (const kind of ["design", "copy", "gtm", "tm"] as const) {
      for (const risk of ["all", "high", "mid", "low", "UNKNOWN", "expired"] as const) {
        const dto = Object.assign(new ResultsQueryDto(), { kind, risk, fold: "show", pageSize: 2 })
        const expected = resultPage(
          light,
          Object.assign(new ResultsQueryDto(), { ...dto, pageSize: 100 })
        ).items
        const actual: Bag[] = []
        for (let p = 1; p <= Math.ceil(expected.length / 2); p++)
          actual.push(...resultPage(light, { ...dto, page: p }).items)
        expect(actual).toEqual(expected)
      }
    }
    const hidden = resultPage(light, Object.assign(new ResultsQueryDto(), { kind: "design" }))
    expect(hidden).toMatchObject({
      facets: { all: 8, high: 2, mid: 1, low: 2, UNKNOWN: 2, expired: 1 },
      matchedTotal: 8,
      total: 7,
      hiddenExcluded: 1,
    })
    expect(
      resultPage(light, Object.assign(new ResultsQueryDto(), { kind: "design", risk: "low" }))
    ).toMatchObject({ total: 2, hiddenExcluded: 0, fold: "show" })
    expect(
      resultPage(light, Object.assign(new ResultsQueryDto(), { kind: "design", page: 100 })).items
    ).toEqual([])
  })
  it("同词跨父行合并，国家隔离，缺申请号独立，来源先去重再分页", async () => {
    const s = database(),
      light = await readLight(s.db, 1, 1),
      w = rows(light.report.tm.words)[0]
    expect(word(light, wordId(w))).toBe(w)
    expect(
      resultPage(light, Object.assign(new ResultsQueryDto(), { kind: "tm" })).items[0]
    ).toMatchObject({ genericity: { kind: "brand", kindLabel: "品牌词" }, where: ["brand"] })
    expect(rows(w.marks)).toHaveLength(4)
    expect(rows(w.marks)[0]).toMatchObject({
      targetId: "tm:coca-cola:US:001",
      level: "high",
      dismissed: true,
    })
    expect(rows(rows(w.marks)[0].sources)).toHaveLength(2)
    const p = riskPage(rows(w.marks), Object.assign(new RiskPageDto(), { pageSize: 1 }))
    const items = await cards(s.db, light, p.items)
    expect(items[0]).toMatchObject({ sourceCount: 2, value: "dismiss", classCodes: ["021"] })
    expect(items[0]).not.toHaveProperty("sources")
    expect(items[0]).not.toHaveProperty("classes")
    const details = await detailRow(s.db, light, str(rows(w.marks)[0]._rowId))
    expect(details).not.toHaveProperty("sources")
    expect(details).toHaveProperty("classes")
    const sources = await detailRow(
      s.db,
      light,
      str(rows(w.marks)[0]._rowId),
      Object.assign(new ResultPageDto(), { pageSize: 1, page: 2 })
    )
    expect(sources).toMatchObject({ total: 2, page: 2, items: [{ level: "high" }] })
    expect(() => word(light, "w-999999")).toThrow("商标词不在本报告中")
    await expect(detailRow(s.db, light, "r-999999")).rejects.toThrow("命中不在本报告中")
  })
  it("overview不带报告/全部标记/待办/正文，页卡片只读当前页", async () => {
    const s = database(),
      overview = await s.service.overview(1, 1)
    const body = JSON.stringify(overview)
    for (const key of ['"annotations"', '"targets"', '"marks"', "OCR正文", "案件正文", "长类别"])
      expect(body).not.toContain(key)
    expect(overview).toMatchObject({ todoTotal: buildReport(s.task).summary.todoTotal })
    const result = await s.service.results(
      1,
      1,
      Object.assign(new ResultsQueryDto(), { kind: "design", pageSize: 1 })
    )
    expect(result.items).toHaveLength(1)
    expect(str(result.items[0].reason)).toHaveLength(240)
    const cardQuery = s.raw.mock.calls
      .map(([q]) => q as Prisma.Sql)
      .find(q => q.sql.includes("'reason',LEFT"))!
    expect(cardQuery.values).toEqual([1, 1])
    expect(s.provider.detail).not.toHaveBeenCalled()
  })
  it.each(["RUNNING", "FAILED", "SETTLING"])("%s结果不开放，overview不暴露摘要", async status => {
    const s = database(taskFixture([], { status }))
    await expect(readLight(s.db, 1, 1)).rejects.toThrow("报告")
    expect(await s.service.overview(1, 1)).not.toHaveProperty("reportSummary")
    if (status === "SETTLING") {
      s.task.error = "[PAYMENT_REQUIRED] 余额不足"
      await expect(readLight(s.db, 1, 1)).rejects.toMatchObject({ status: 402 })
    }
  })
  it("归属/删除先于结果扫描，漏迁移明确409不自动hydrate或迁移", async () => {
    const s = database()
    await expect(readLight(s.db, 2, 1)).rejects.toThrow("检测记录不存在")
    s.task.deletedAt = new Date()
    await expect(readLight(s.db, 1, 1)).rejects.toThrow("检测记录不存在")
    expect(s.raw).toHaveBeenCalledTimes(2)
    const old = database()
    const original = old.raw.getMockImplementation()!
    old.raw.mockImplementation(async query => {
      const value = await original(query)
      return (query as Prisma.Sql).sql.includes("AS inline")
        ? (value as Bag[]).map(v => ({ ...v, inline: 1 }))
        : value
    })
    await expect(readLight(old.db, 1, 1)).rejects.toMatchObject({
      status: 409,
      message: "不支持旧版报告数据，请清理测试记录",
    })
    expect(old.raw).toHaveBeenCalledTimes(3)
  })
  it("context先分页轻引用，页详情一次批量取回；OCR按line而非整图", async () => {
    const s = database(),
      light = await readLight(s.db, 1, 1),
      original = s.raw.getMockImplementation()!
    const seen: Prisma.Sql[] = []
    s.raw.mockImplementation(async q => {
      const query = q as Prisma.Sql
      seen.push(query)
      if (query.sql.includes("SELECT COUNT(*) AS total FROM (")) return [{ total: 45n }]
      if (query.sql.includes("SELECT q.*"))
        return Array.from({ length: 20 }, (_, index) => ({
          parentId: 4,
          kind: "tm",
          imageId: "img-1",
          wordId: null,
          source: "ocr",
          position: 1,
          childPosition: index + 21,
        }))
      if (query.sql.includes("AS refIndex,v.data"))
        return Array.from({ length: 20 }, (_, refIndex) => ({
          refIndex,
          data: {
            imageID: "img-1",
            width: 100,
            height: 100,
            error: null,
            line: { text: `line${refIndex + 21}`, box: [1, 2, 3, 4] },
          },
        }))
      return original(q)
    })
    const result = await contextPage(
      s.db,
      light,
      Object.assign(new ResultPageDto(), { section: "ocr", page: 2 }) as never
    )
    expect(result).toMatchObject({ total: 45, page: 2, pageSize: 20 })
    expect(result.items).toHaveLength(20)
    expect(result.items[0]).toMatchObject({ lineIndex: 20, data: { line: { text: "line21" } } })
    expect(JSON.stringify(result)).not.toContain('"lines"')
    expect(seen).toHaveLength(3)
    expect(seen[1].sql).not.toContain("data JSON")
    expect(seen[1].sql).not.toContain("q.data")
    expect(seen[2].sql).not.toContain("ORDER BY")
    expect(seen[2].sql.match(/UNION ALL/g)).toHaveLength(19)
  })
  it("多来源页只执行一次重详情批量读取", async () => {
    const s = database(),
      light = await readLight(s.db, 1, 1),
      m = rows(rows(light.report.tm.words)[0].marks)[0]
    const result = await detailRow(
      s.db,
      light,
      str(m._rowId),
      Object.assign(new ResultPageDto(), { pageSize: 100 })
    )
    expect(result).toMatchObject({ total: 2 })
    expect(s.prisma.patentQueryTextMark.findMany).toHaveBeenCalledTimes(1)
    expect(s.prisma.patentQueryTextMark.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: [1, 3] }, result: { check: { taskId: 1 } } },
    })
  })
  it.each(["design", "copy", "gtm", "tm"] as const)(
    "%s的全处理状态矩阵不影响风险、待办、折叠或顺序",
    kind => {
      const initial = fixture(),
        check = initial.checks.find(c => c.kind === kind)!,
        raw =
          kind === "tm"
            ? rows(rows(output(check.output).text?.words)[0].marks)[0]
            : output(check.output).units["img-1"].matches[0]
      const target = kind === "tm" ? "tm:coca-cola:US:001" : imageTarget(kind, raw)!,
        key = kind === "tm" ? target : `${kind}:img-1:${target.slice(kind.length + 1)}`
      const baseline = buildReport({ ...initial, annotations: {} })
      for (const value of ["flag", "dismiss", "none"]) {
        const r = buildReport({ ...initial, annotations: { decisions: { [key]: { value } } } })
        expect(r.summary).toEqual(baseline.summary)
        expect(r.todos).toEqual(baseline.todos)
        const list =
          kind === "tm" ? rows(rows(r.tm.words)[0].marks) : rows(r[kind]["img-1"].matches)
        expect(list[0]).toMatchObject({ dismissed: value === "dismiss", flagged: value === "flag" })
      }
    }
  )
  it("空集合、全部失效、未rerank与unscored不漂移", async () => {
    for (const values of [
      [],
      [{ pn: "D", score: 0.99, status: "DEAD" }],
      [{ pn: "D", score: 0.99, riskLevel: "unscored" }],
    ] as Prisma.JsonObject[][]) {
      const initial = taskFixture(
          [
            checkFixture("design", {
              status: "COMPLETED",
              output: { units: { "img-1": completedUnit(values) } },
            }),
          ],
          { status: "COMPLETED" }
        ),
        s = database(initial),
        light = await readLight(s.db, 1, 1)
      expect(light.report.summary).toEqual(buildReport(initial).summary)
      expect(
        resultPage(light, Object.assign(new ResultsQueryDto(), { kind: "design" })).items
      ).toHaveLength(values.length)
    }
    const initial = fixture()
    const i = input(initial.input)
    i.design!.rerank = false
    const light = await readLight(database(initial).db, 1, 1)
    expect(
      matches(light, "design")
        .filter(m => m.level !== "expired")
        .every(m => m.level === "UNKNOWN")
    ).toBe(true)
  })
  it("marks布局检查仅针对文字词行，不把图命中的同名扩展字段判为未迁移", async () => {
    const s = database(),
      original = s.raw.getMockImplementation()!
    s.raw.mockImplementation(async query => {
      const value = await original(query)
      return (query as Prisma.Sql).sql.includes("'_inline'")
        ? (value as { imageId: string | null; data: Bag }[]).map(r => ({
            ...r,
            data: { ...r.data, _inline: r.imageId === null ? 0 : 1 },
          }))
        : value
    })
    await expect(readLight(s.db, 1, 1)).resolves.toHaveProperty("task.id", 1)
    s.raw.mockImplementation(async query => {
      const value = await original(query)
      return (query as Prisma.Sql).sql.includes("'_inline'")
        ? (value as { imageId: string | null; data: Bag }[]).map(r => ({
            ...r,
            data: { ...r.data, _inline: r.imageId === null ? 1 : 0 },
          }))
        : value
    })
    await expect(readLight(s.db, 1, 1)).rejects.toMatchObject({
      status: 409,
      message: "不支持旧版报告数据，请清理测试记录",
    })
  })
  it("默认20，pageSize/枚举验证；tm不接受imageId", async () => {
    expect(new ResultPageDto().pageSize).toBe(20)
    for (const query of [
      { kind: "design", page: 0 },
      { kind: "design", pageSize: 101 },
      { kind: "design", pageSize: "x" },
      { kind: "design", risk: "dismissed" },
      { kind: "design", fold: "invalid" },
      {},
    ])
      expect(await validate(plainToInstance(ResultsQueryDto, query))).not.toHaveLength(0)
    const dto = plainToInstance(ResultsQueryDto, { kind: "design", page: "2", pageSize: "1" })
    expect(await validate(dto)).toHaveLength(0)
    expect(dto.page).toBe(2)
    const light = await readLight(database().db, 1, 1)
    expect(() =>
      resultPage(light, Object.assign(new ResultsQueryDto(), { kind: "tm", imageId: "img-1" }))
    ).toThrow("文字商标不支持图片筛选")
  })
})

describe("compact标记", () => {
  it.each([
    ["design", "design:US:high"],
    ["copy", "copy:same"],
    ["gtm", "gtm:US:g"],
  ] as const)("%s图片ID按二进制比较，避免JSON_TABLE与列排序规则冲突", async (kind, target) => {
    const s = database()
    await expect(decisionTarget(s.db, 1, kind, target, "img-1")).resolves.toBeTruthy()
    const query = s.raw.mock.calls
      .map(([q]) => q as Prisma.Sql)
      .find(q => q.sql.includes("SELECT JSON_OBJECT('pn'"))!
    expect(query.sql).toContain(
      "im ON im.imageId COLLATE utf8mb4_bin=r.imageId COLLATE utf8mb4_bin"
    )
    expect(query.sql).toContain("AND r.imageId COLLATE utf8mb4_bin=?")
    expect(query.values).toEqual([1, kind, "img-1", target.split(":").at(-1)])
    await expect(decisionTarget(s.db, 1, kind, target, "IMG-1")).rejects.toThrow("未找到可标记")
  })
  it("只验证当前目标，不hydrate/buildReport/调用上游，并在行锁内合并最新标记", async () => {
    const s = database()
    const hydration = jest.spyOn(s.service, "getTask").mockRejectedValue(new Error("禁止hydrate"))
    const requests = [
      {
        kind: "design" as const,
        imageId: "img-1",
        targetId: "design:US:high",
        value: "dismiss" as const,
      },
      { kind: "tm" as const, targetId: "tm:coca-cola:US:001", value: "flag" as const },
    ]
    const saved = await Promise.all(requests.map(dto => s.service.decision(1, 1, dto)))
    for (const response of saved) {
      expect(response).toHaveProperty("refresh", [])
      expect(response).not.toHaveProperty("report")
      expect(response).not.toHaveProperty("annotations")
    }
    expect(obj(obj(s.task.annotations).decisions)).toMatchObject({
      "design:img-1:US:high": { value: "dismiss" },
      "tm:coca-cola:US:001": { value: "flag" },
      "design:img-1:US:hidden": { value: "flag" },
    })
    expect(hydration).not.toHaveBeenCalled()
    for (const fn of Object.values(s.provider)) expect(fn).not.toHaveBeenCalled()
    expect(s.raw.mock.calls.some(([q]) => "sql" in q && q.sql.includes("'_inline'"))).toBe(false)
    await s.service.decision(1, 1, { ...requests[0], value: "none" })
    expect(obj(obj(s.task.annotations).decisions)["design:img-1:US:high"]).toEqual({
      value: "none",
    })
    expect(buildReport(s.task).summary).toEqual(buildReport({ ...s.task, annotations: {} }).summary)
  })
  it("错误目标/归属/未结算/软删拒绝，无写入", async () => {
    const s = database()
    await expect(decisionTarget(s.db, 1, "design", "design:US:missing", "img-1")).rejects.toThrow(
      "未找到可标记"
    )
    await expect(
      s.service.decision(2, 1, { kind: "tm", targetId: "tm:coca-cola:US:001", value: "flag" })
    ).rejects.toThrow("不存在")
    s.task.status = "RUNNING"
    await expect(
      s.service.decision(1, 1, { kind: "tm", targetId: "tm:coca-cola:US:001", value: "flag" })
    ).rejects.toThrow("尚不可用")
    s.task.deletedAt = new Date()
    await expect(
      s.service.decision(1, 1, { kind: "tm", targetId: "tm:coca-cola:US:001", value: "flag" })
    ).rejects.toThrow("不存在")
    expect(s.prisma.patentQueryTask.update).not.toHaveBeenCalled()
  })
  it("compact todo验证现有ID，保存最新todoDone不覆盖decisions", async () => {
    const s = database(),
      todo = buildReport(s.task).todos[0]
    expect(await s.service.todo(1, 1, todo.id, true)).toEqual({
      taskId: 1,
      todoId: todo.id,
      done: true,
      refresh: ["overview", "todos"],
    })
    expect(obj(obj(s.task.annotations).todoDone)[todo.id]).toBe(true)
    expect(obj(obj(s.task.annotations).decisions)["design:img-1:US:high"]).toEqual({
      value: "dismiss",
    })
    await expect(s.service.todo(1, 1, "madeup", true)).rejects.toThrow("待办不存在")
  })
})
