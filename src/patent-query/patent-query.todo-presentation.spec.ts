import { buildReport } from "./patent-query.report"
import { json, rows } from "./patent-query.types"
import { checkFixture, completedUnit, fixtureInput, taskFixture } from "./testing/fixtures"

const textTask = (words: object[], brand = "Alpha", title = "Northpeak HydroGlide cup") =>
  taskFixture([checkFixture("tm", { output: json({ units: {}, text: { words } }) })], {
    input: json({ ...fixtureInput(), tm: { brand, title } }),
  })

describe("PRD 合并待办展示", () => {
  it("8 个版权来源合成一行并保留全部入口，不继承旧逐条完成状态", () => {
    const task = taskFixture(
      [
        checkFixture("copy", {
          output: {
            units: {
              "img-1": completedUnit(
                Array.from({ length: 8 }, (_, n) => ({
                  id: `C${n}`,
                  matchType: "verified",
                  sourceHost: `shop${n}.com`,
                  reason: `匹配说明 ${n}`,
                }))
              ),
            },
          },
        }),
      ],
      { annotations: { todoDone: { "copy:img-1:verified": true, "copy:img-1:match:C0": true } } }
    )
    const before = JSON.stringify(task)
    const r = buildReport(task)
    expect(r.todos).toHaveLength(1)
    expect(r.todos[0]).toMatchObject({
      id: "copy:img-1:verified:prd",
      title: "图 1 核实图片来源",
      done: false,
      action: { label: "看来源", section: "matches" },
    })
    expect(r.todos[0].targets).toHaveLength(8)
    expect(r.todos[0].description).toContain("8 条同商品图片来源")
    expect(rows(r.copy["img-1"].matches)[7].reason).toBe("匹配说明 7")
    expect(r.summary).toMatchObject({ todoTotal: 1, todoDone: 0 })
    expect(JSON.stringify(task)).toBe(before)
  })
  it.each([
    ["verified", "核实图片来源"],
    ["identical", "换成自己拍的图"],
  ])("单条版权 %s 保留原始条目标题和来源", (matchType, label) => {
    const r = buildReport(
      taskFixture([
        checkFixture("copy", {
          output: {
            units: {
              "img-1": completedUnit([
                { id: "C1", matchType, sourceHost: "amazon.com", title: " Body Pillow " },
              ]),
            },
          },
        }),
      ])
    )
    expect(r.todos[0].title).toBe(`图 1 ${label}（amazon.com）：Body Pillow`)
    expect(r.todos[0].description).toContain("Body Pillow")
  })
  it("原图、品牌识别及真实案件保留各自入口，不虚构案件事实", () => {
    const r = buildReport(
      taskFixture([
        checkFixture("copy", {
          output: {
            units: {
              "img-1": completedUnit([{ id: "C1", matchType: "identical" }], {
                knownIpMatch: {
                  isMatch: true,
                  matchedName: "Northpeak",
                  note: "图案中识别到该品牌。",
                },
                troCases: [{ caseNo: "26-cv-001" }],
              }),
            },
          },
        }),
      ])
    )
    expect(r.todos.map(t => t.action)).toEqual([
      { label: "看原图", section: "matches" },
      { label: "看识别结果", section: "knownIpMatch" },
      { label: "看案件", section: "troCases", caseNumber: "26-cv-001" },
    ])
    expect(r.todos[1].description).toBe("图案中识别到该品牌。")
    expect(r.todos[2].description).toContain("其他案件详情未提供")
  })
  it("同图图形高/中风险合并，其他图片独立，低风险不混入入口", () => {
    const i = fixtureInput()
    const r = buildReport(
      taskFixture(
        [
          checkFixture("gtm", {
            output: {
              units: {
                "img-1": completedUnit([
                  { serialNumber: "001", markText: "A", score: 0.95 },
                  { serialNumber: "002", markText: "B", score: 0.8 },
                  { serialNumber: "003", markText: "C", score: 0.5 },
                ]),
                "img-2": completedUnit([
                  {
                    serialNumber: "002",
                    markText: "B",
                    score: 0.8,
                    classes: [{ code: "021", description: "杯子" }],
                    reason: "图案接近",
                  },
                ]),
              },
            },
          }),
        ],
        { input: json({ ...i, images: [i.images[0], { ...i.images[0], id: "img-2" }] }) }
      )
    )
    expect(r.todos).toHaveLength(2)
    expect(r.todos[0].title).toBe("图 1 更换 Logo / 图案")
    expect(r.todos[0].targets.map(t => t.targetId)).toEqual(["gtm:US:001", "gtm:US:002"])
    expect(r.todos[1].description).toContain("021 · 杯子")
    expect(r.todos[1].description).toContain("相似度 80%")
    expect(r.todos[1].description).toContain("图案接近")
  })
  it.each([
    ["Alpha", "high", "品牌名「Alpha」建议换一个"],
    ["Northpeak", "high", "标题里删掉「Northpeak」"],
    ["HydroGlide", "mid", "核对标题用词「HydroGlide」"],
  ])("品牌/标题词 %s 按等级生成标题，不因还有五点来源改变", (term, level, title) => {
    const r = buildReport(
      textTask([
        {
          term,
          marks: [
            {
              serialNumber: "001",
              markText: term,
              level,
              bucket: "shortDesc",
              reason: "商标文字相似",
            },
          ],
        },
      ])
    )
    expect(r.todos[0].title).toBe(title)
    expect(r.todos[0].description).toContain("商标文字相似")
    expect(r.todos[0].action).toEqual({ label: "看商标", section: "words", term })
  })
  it("五点/描述/OCR 独有词及子串不进待办，但风险统计与原始明细保留", () => {
    const words = ["RISE", "RESOLVE", "MAX", "RE"].map((term, index) => ({
      term,
      marks: [
        {
          serialNumber: String(index),
          level: "high",
          bucket: ["shortDesc", "desc", "image", "title"][index],
        },
      ],
    }))
    const r = buildReport(textTask(words, "Neretva", "Bread maker"))
    expect(r.todos).toEqual([])
    expect(r.summary.high).toBe(4)
    expect(rows(r.tm.words)).toHaveLength(4)
  })
  it("同词多个商标合一条，重复词归一化，旧完成状态不继承，标记仍按商标", () => {
    const task = textTask([
      { term: " Alpha ", marks: [{ serialNumber: "001", level: "high" }] },
      {
        term: "ALPHA",
        marks: [
          { serialNumber: "001", level: "high" },
          { serialNumber: "002", level: "mid" },
        ],
      },
    ])
    task.annotations = { todoDone: { "tm:alpha": true, "tm:alpha:US:001": true } }
    const r = buildReport(task)
    expect(r.todos).toHaveLength(1)
    expect(r.todos[0]).toMatchObject({ id: "tm:alpha:prd", done: false })
    expect(r.todos[0].targets.map(t => t.targetId)).toEqual(["tm:alpha:US:001", "tm:alpha:US:002"])
    expect(r.todos[0].description).toContain("2 件需核对商标")
    const updated = buildReport({
      ...task,
      annotations: {
        decisions: { "tm:alpha:US:001": { value: "dismiss" } },
        todoDone: { "tm:alpha:prd": true },
      },
    })
    expect(updated.todos[0]).toMatchObject({
      done: true,
      targets: [{ targetId: "tm:alpha:US:001" }, { targetId: "tm:alpha:US:002" }],
    })
    expect(updated.summary).toMatchObject({ high: 1, mid: 0, todoTotal: 1, todoDone: 1 })
  })
  it.each(["有效来源", undefined])("单商标说明不用失效来源，即使有效原因 %p 为空", reason => {
    const r = buildReport(
      textTask([
        {
          term: "Alpha",
          marks: [
            { serialNumber: "001", level: "high", legalStatus: "DEAD", reason: "失效来源" },
            { serialNumber: "001", level: "high", legalStatus: "LIVE", reason },
          ],
        },
      ])
    )
    if (reason) expect(r.todos[0].description).toContain(reason)
    else expect(r.todos[0].description).toContain("未提供")
    expect(r.todos[0].description).not.toContain("失效来源")
  })
  it("缺稳定标识也能合并且逐条定位，不伪造 targetId", () => {
    const task = textTask([{ term: "Alpha", marks: [{ level: "mid" }, { level: "high" }] }])
    task.checks.unshift(
      checkFixture("copy", {
        output: {
          units: {
            "img-1": completedUnit([{ matchType: "verified" }, { matchType: "verified" }]),
          },
        },
      })
    )
    const r = buildReport(task)
    expect(r.todos).toHaveLength(2)
    for (const todo of r.todos) {
      expect(todo.targets.map(t => t.targetId)).toEqual([null, null])
      expect(todo.targets.map(t => t.matchIndex)).toEqual([0, 1])
    }
    expect(rows(r.tm.words)[0].marks).toHaveLength(2)
  })
})
