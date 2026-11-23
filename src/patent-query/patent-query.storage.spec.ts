import type { PatentQueryCheck, Prisma } from "@prisma/client"
import { migratePatentCheck } from "./patent-query.migration"
import { buildReport } from "./patent-query.report"
import { hydrateOutput, hydrateTasks, saveResults, splitResults } from "./patent-query.storage"
import { json, obj, output, rows } from "./patent-query.types"
import { checkFixture, completedUnit, taskFixture } from "./testing/fixtures"
import { asTransaction, storageDb } from "./testing/storage-db"

function fixture() {
  const check = checkFixture("design", {
    status: "COMPLETED",
    output: {
      units: {
        "img-1": completedUnit([
          { pn: "D1", score: 0.95, reason: "对比原因" },
          { pn: "D2", score: 0.8, expired: true },
          { pn: "D3", score: 0.1, reasonCode: "NOT_COMPARED" },
        ]),
        "img-2": completedUnit([{ pn: "D1", score: 0.9 }, { score: 0.8 }]),
      },
    },
  })
  const task = taskFixture([check], {
    status: "COMPLETED",
    annotations: {
      decisions: { "design:img-1:US:D1": { value: "flag" } },
      todoDone: { "design:img-1:US:D1": true },
    },
  })
  const db = storageDb()
  const tx = {
    ...db,
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    patentQueryCheck: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(structuredClone(check))),
      update: jest.fn(({ data }: { data: Partial<PatentQueryCheck> }) => {
        Object.assign(check, structuredClone(data))
        return Promise.resolve(structuredClone(check))
      }),
    },
    patentQueryTask: { findUniqueOrThrow: jest.fn(() => Promise.resolve(structuredClone(task))) },
  }
  return { tx, db, check, task }
}

describe("专利结果拆表与迁移", () => {
  it("两张图、无稳定 ID、过期/未定档及已处理标记，拆分还原后的报告完全一致", async () => {
    const s = fixture(),
      before = buildReport(s.task)
    const compact = await saveResults(asTransaction(s.tx), 1, output(s.check.output))
    expect(compact.units["img-1"]).not.toHaveProperty("matches")
    expect(s.db.state.results).toHaveLength(5)
    s.check.output = json(compact) as Prisma.JsonObject
    const [restored] = await hydrateTasks(asTransaction(s.tx), [s.task])
    expect(buildReport(restored)).toEqual(before)
    expect(output(restored.checks[0].output).units["img-2"].matches).toHaveLength(2)
  })

  it("文字按原始词行保留全部来源、OCR、警告，空结果也可还原", () => {
    const text = {
      words: [
        { term: " Cup ", marks: [{ serialNumber: "01", where: ["title"], level: "high" }] },
        { term: "cup", marks: [{ serialNumber: "01", where: ["brand"], level: "mid" }] },
        { term: "none", marks: [] },
      ],
      imageOCR: [{ imageID: "img-1", lines: [{ text: "cup" }] }],
      warnings: ["warning"],
    }
    for (const words of [text.words, []]) {
      const original = { units: {}, text: { ...text, words } }
      const { data, results } = splitResults(original)
      expect(data.text).not.toHaveProperty("words")
      expect(results.every(r => r.imageId === null)).toBe(true)
      expect(hydrateOutput(data, results)).toEqual(original)
    }
  })

  it("多分项明细无数据库排序，乱序返回仍按各自 position 还原", async () => {
    const s = fixture()
    const text = checkFixture("tm", {
      id: 2,
      output: {
        units: {},
        text: {
          words: [
            { term: "first", marks: [] },
            { term: "second", marks: [] },
          ],
        },
      },
    })
    s.task.checks.push(text)
    const expected = s.task.checks.map(c => structuredClone(c.output))
    for (const check of s.task.checks)
      check.output = json(
        await saveResults(asTransaction(s.tx), check.id, output(check.output))
      ) as Prisma.JsonObject
    s.db.state.results.reverse()
    s.db.patentQueryResult.findMany.mockClear()
    const [restored] = await hydrateTasks(asTransaction(s.tx), [s.task])
    expect(restored.checks.map(c => c.output)).toEqual(expected)
    expect(s.db.patentQueryResult.findMany).toHaveBeenCalledTimes(1)
    expect(s.db.patentQueryResult.findMany).toHaveBeenCalledWith({
      where: { checkId: { in: [1, 2] } },
    })
  })

  it("重复写入不重复建行；追加及刷新只改变对应内容，缩短会清理尾行", async () => {
    const s = fixture(),
      full = output(s.check.output)
    const compact = await saveResults(asTransaction(s.tx), 1, full)
    await saveResults(asTransaction(s.tx), 1, hydrateOutput(compact, s.db.state.results))
    expect(s.db.patentQueryResult.createMany).toHaveBeenCalledTimes(1)
    expect(s.db.patentQueryResult.update).not.toHaveBeenCalled()
    full.units["img-1"].matches[0].image = "new-url"
    await saveResults(asTransaction(s.tx), 1, full)
    expect(s.db.patentQueryResult.update).toHaveBeenCalledTimes(1)
    delete full.units["img-2"]
    await saveResults(asTransaction(s.tx), 1, full)
    expect(s.db.state.results).toHaveLength(3)
  })
})

describe("文字商标子行", () => {
  it("198 条原始来源独立保存，批量乱序还原、单行更新和追加删除均保留父 ID", async () => {
    const db = storageDb(),
      tx = asTransaction(db)
    const full = output({
      units: {},
      text: {
        words: [
          {
            term: "HYDRO",
            marks: Array.from({ length: 198 }, (_, i) => ({
              serialNumber: `${i % 2}`,
              where: [i],
              imageUrl: `url-${i}`,
            })),
          },
          { term: "empty", marks: [] },
        ],
        imageOCR: [{ text: "HYDRO" }],
        warnings: ["warning"],
      },
    })
    const compact = await saveResults(tx, 1, full)
    const ids = db.state.results.map(r => r.id)
    expect(db.state.marks).toHaveLength(198)
    expect(db.state.results.every(r => !("marks" in obj(r.data)))).toBe(true)
    db.state.results.reverse()
    db.state.marks.reverse()
    const check = checkFixture("tm", { output: json(compact) as Prisma.JsonObject })
    const [task] = await hydrateTasks(tx, [taskFixture([check])])
    expect(task.checks[0].output).toEqual(full)
    expect(db.patentQueryTextMark.findMany).toHaveBeenLastCalledWith({
      where: { resultId: { in: [...ids].reverse() } },
    })
    await saveResults(tx, 1, full)
    expect(db.patentQueryTextMark.createMany).toHaveBeenCalledTimes(1)
    rows(full.text!.words)[0].marks = [...(rows(full.text!.words)[0].marks as unknown[])]
    const marks = rows(full.text!.words)[0].marks as Record<string, unknown>[]
    marks[3].imageUrl = "changed"
    marks.push({ serialNumber: "new" })
    await saveResults(tx, 1, full)
    expect(db.patentQueryTextMark.update).toHaveBeenCalledTimes(1)
    expect(db.state.marks).toHaveLength(199)
    rows(full.text!.words)[0].marks = []
    await saveResults(tx, 1, full)
    expect(db.state.marks).toHaveLength(0)
    expect(db.state.results.map(r => r.id).sort()).toEqual(ids)
    full.text!.words = []
    await saveResults(tx, 1, full)
    expect(db.state.results).toHaveLength(0)
  })

  it("内联 marks 拒绝读取；畸形上游 marks 拒绝拆分", async () => {
    const db = storageDb()
    db.state.results.push({
      id: 1,
      checkId: 1,
      imageId: null,
      position: 0,
      data: { term: "word", marks: [] },
    })
    db.state.marks.push({ id: 1, resultId: 1, position: 0, data: { stale: true } })
    const check = checkFixture("tm", { output: { units: {}, text: {} } })
    await expect(hydrateTasks(asTransaction(db), [taskFixture([check])])).rejects.toThrow(
      "不支持旧版报告数据"
    )
    expect(() =>
      splitResults({ units: {}, text: { words: [{ term: "bad", marks: {} }] } })
    ).toThrow("marks 不是数组")
  })
})

describe("旧布局不受支持", () => {
  it("旧内联命中/词/缓存拒绝读取，避免静默变成低风险", () => {
    for (const old of [
      { units: { "img-1": completedUnit([{ pn: "old" }]) } },
      { units: {}, text: { words: [{ term: "old" }] } },
      { units: {}, cache: { old: { patents: [] } } },
    ])
      expect(() => hydrateOutput(old, [])).toThrow("不支持旧版报告数据")
  })
  it("历史迁移入口明确停用且不触及数据库", async () => {
    const db = storageDb()
    await expect(migratePatentCheck(asTransaction(db), 1, false)).rejects.toThrow("已停用")
    expect(db.patentQueryResult.findMany).not.toHaveBeenCalled()
  })
})
