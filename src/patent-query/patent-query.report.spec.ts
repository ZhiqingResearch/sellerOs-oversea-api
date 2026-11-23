import { withUiLanguage } from "../common/i18n/request-language"
import type { Prisma } from "@prisma/client"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { QuotePatentQueryDto } from "./dto/patent-query.dto"
import { niceCodes, normalizeInput, quote, sameInput } from "./patent-query.constants"
import { annotations, buildReport, dateValue, textWords } from "./patent-query.report"
import { json, rows } from "./patent-query.types"
import { checkFixture, completedUnit, fixtureInput, taskFixture } from "./testing/fixtures"
describe("专利输入和报告", () => {
  it("keeps US-only coverage explicit in English without changing the quote", () => {
    const input = normalizeInput({ ...fixtureInput(), sites: ["DE"] }, 1)
    const english = withUiLanguage("en-US", () => quote(input))
    expect(english.warnings.join(" ")).toContain("Only US patent and trademark databases")
    expect(english.quotedCredits).toBe(quote(input).quotedCredits)
    expect(sameInput(input, { ...input, resolved: { ...input.resolved, responseLanguage: "en-US" } }, true)).toBe(true)
  })
  it("三位类别、真实执行项和计价", () => {
    expect(niceCodes([21, "021", "32"])).toEqual(["021", "032"])
    expect(() => niceCodes([0])).toThrow()
    expect(quote(fixtureInput()).quotedCredits).toBe(40)
    const value = normalizeInput({ ...fixtureInput(), sites: ["DE"] }, 1)
    expect(quote(value)).toMatchObject({
      quotedCredits: 30,
      executableKinds: ["copy", "gtm", "tm"],
      skipped: ["design"],
    })
    expect(() => normalizeInput(fixtureInput(), 2)).toThrow("图片路径不合法")
    expect(() => normalizeInput({ ...fixtureInput(), images: [] }, 1)).toThrow("请上传产品图")
  })
  it("按明确选择校验多个尼斯类别，留空时即使有洛迦诺和文件名也不限类别", () => {
    const dto = { ...fixtureInput(), design: { productName: "保温杯", locs: ["07-01"] } }
    expect(normalizeInput(dto, 1).resolved.classCodes).toEqual([])
    expect(
      normalizeInput({ ...dto, tm: { ...dto.tm, classCodes: [] } }, 1).resolved.classCodes
    ).toEqual([])
    expect(
      normalizeInput({ ...dto, tm: { ...dto.tm, classCodes: ["045", "21", "021"] } }, 1).resolved
        .classCodes
    ).toEqual(["021", "045"])
    expect(() =>
      normalizeInput({ ...dto, tm: { ...dto.tm, classCodes: ["021", "046"] } }, 1)
    ).toThrow("尼斯类别必须为 1–45")
    expect(() => niceCodes(["bad"])).toThrow()
  })
  it("空 copy 对象通过 DTO；无效类型不能蒙混通过", async () => {
    const v = plainToInstance(QuotePatentQueryDto, { sites: ["US"], copy: {} })
    expect(await validate(v, { whitelist: true })).toHaveLength(0)
    expect(
      await validate(plainToInstance(QuotePatentQueryDto, { sites: ["US"], copy: "bad" }), {
        whitelist: true,
      })
    ).not.toHaveLength(0)
  })
  it("未比对的低分不可隐藏；过期不计有效风险；版权按图重算", () => {
    const task = taskFixture([
      checkFixture("design", {
        status: "COMPLETED",
        output: {
          units: {
            "img-1": completedUnit([
              { pn: "D1", score: 0.1, reasonCode: "NOT_COMPARED" },
              { pn: "D2", score: 0.99, expired: true },
              { pn: "D3", score: 0.8 },
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
              Array.from({ length: 11 }, (_, n) => ({ id: `C${n}`, matchType: "identical" }))
            ),
          },
        },
      }),
    ])
    const r = buildReport(task)
    expect(r.summary).toMatchObject({ high: 1, mid: 1, unknown: 1, expired: 1, hidden: 0 })
    expect(rows(r.design["img-1"].matches)[0]).toMatchObject({ level: "UNKNOWN", hidden: false })
    expect(r.copy["img-1"].riskLevel).toBe("high")
    expect(r.gaps.some(g => g.message.includes("未定档"))).toBe(true)
  })
  it("外观待办展示专利信息、上游说明并保留已处理状态", () => {
    const r = buildReport(
      taskFixture(
        [
          checkFixture("design", {
            output: {
              units: {
                "img-1": completedUnit([
                  {
                    pn: "USD1",
                    title: "汽车侧踏板",
                    score: 0.95,
                    reason: "踏板轮廓接近。",
                    categoryMismatchReason: "支架结构不同。",
                  },
                ]),
              },
            },
          }),
        ],
        { annotations: { todoDone: { "design:US:USD1:prd": true } } }
      )
    )
    expect(r.todos).toEqual([
      {
        id: "design:US:USD1:prd",
        kind: "design",
        title: "图 1 改款避开外观专利 USD1：汽车侧踏板",
        action: { label: "看比对", section: "matches" },
        patentNumber: "USD1",
        patentName: "汽车侧踏板",
        description: "踏板轮廓接近。\n支架结构不同。",
        done: true,
        targets: [{ imageId: "img-1", targetId: "design:US:USD1" }],
      },
    ])
    expect(r.summary.todoDone).toBe(1)
  })
  it.each([
    ["NOT_COMPARED", true, undefined, "未做 AI 对比"],
    [undefined, false, undefined, "未做 AI 对比"],
    [undefined, true, "unscored", "未做 AI 对比"],
    ["NO_VERDICT", true, undefined, "AI 对比未给出明确结论"],
  ])("外观 %p/%p/%p 只保留缺口提示（%p），不生成待办", (reasonCode, rerank, riskLevel) => {
    const initial = fixtureInput()
    const task = taskFixture(
      [
        checkFixture("design", {
          output: {
            units: {
              "img-1": completedUnit(
                [{ pn: "D1", score: 0.8, ...(reasonCode ? { reasonCode } : {}) }],
                riskLevel ? { riskLevel } : {}
              ),
            },
          },
        }),
      ],
      { input: json({ ...initial, design: { ...initial.design, rerank } }) }
    )
    const r = buildReport(task)
    expect(r.todos).toEqual([])
    expect(r.summary).toMatchObject({ unknown: 1, todoTotal: 0 })
    expect(r.gaps.some(g => g.message.includes("未定档"))).toBe(true)
  })
  it("同一专利跨图合并高风险待办，未对比命中只保留提示", () => {
    const initial = fixtureInput()
    const r = buildReport(
      taskFixture(
        [
          checkFixture("design", {
            output: {
              units: {
                "img-1": completedUnit([
                  { pn: "D1", title: "侧踏板", score: 0.95, reason: "轮廓接近。" },
                ]),
                "img-2": completedUnit([
                  { pn: "D1", title: "侧踏板", score: 0.1, reasonCode: "NOT_COMPARED" },
                ]),
                "img-3": completedUnit([
                  { pn: "D1", title: "侧踏板", score: 0.95, reason: "轮廓接近。" },
                ]),
              },
            },
          }),
        ],
        {
          input: json({
            ...initial,
            images: [
              initial.images[0],
              { ...initial.images[0], id: "img-2" },
              { ...initial.images[0], id: "img-3" },
            ],
          }),
        }
      )
    )
    expect(r.todos).toHaveLength(1)
    expect(r.todos[0].id).toBe("design:US:D1:prd")
    expect(r.todos[0].targets.map(t => t.imageId)).toEqual(["img-1", "img-3"])
    expect(r.todos[0].description).toBe("轮廓接近。")
    expect(r.gaps).toContainEqual({
      kind: "design",
      imageId: "img-2",
      message: "部分命中未定档，请人工核对",
    })
  })
  it("PRD 待办只收外观高风险、图形及文字高/中风险，flag 不扩大范围", () => {
    const r = buildReport(
      taskFixture(
        [
          checkFixture("design", {
            output: {
              units: {
                "img-1": completedUnit([
                  { pn: "high", score: 0.9 },
                  { pn: "mid", score: 0.8 },
                  { pn: "low", score: 0.3 },
                  { pn: "unknown", score: 0.99, reasonCode: "NOT_COMPARED" },
                  { pn: "expired", score: 0.99, expired: true },
                  { pn: "dismissed", score: 0.99 },
                ]),
              },
            },
          }),
          checkFixture("gtm", {
            output: {
              units: {
                "img-1": completedUnit([
                  { serialNumber: "high", score: 0.9 },
                  { serialNumber: "mid", score: 0.7 },
                  { serialNumber: "low", score: 0.69 },
                  { serialNumber: "unknown", score: 0.99, reasonCode: "NO_VERDICT" },
                  { serialNumber: "dead", score: 0.99, legalStatus: "DEAD" },
                ]),
              },
            },
          }),
          checkFixture("tm", {
            output: {
              units: {},
              text: {
                words: ["high", "mid", "low", "UNKNOWN"].map(level => ({
                  term: level,
                  marks: [{ serialNumber: "1", level }],
                })),
              },
            },
          }),
        ],
        {
          input: json({ ...fixtureInput(), tm: { title: "high mid low UNKNOWN" } }),
          annotations: {
            decisions: {
              "design:img-1:US:mid": { value: "flag" },
              "design:img-1:US:unknown": { value: "flag" },
              "design:img-1:US:dismissed": { value: "dismiss" },
              "gtm:img-1:US:low": { value: "flag" },
              "gtm:img-1:US:unknown": { value: "flag" },
              "tm:unknown:US:1": { value: "flag" },
              "tm:low:US:1": { value: "flag" },
            },
            todoDone: { "design:US:unknown": true },
          },
        }
      )
    )
    expect(r.todos.map(t => t.id)).toEqual([
      "design:US:high:prd",
      "design:US:dismissed:prd",
      "gtm:img-1:prd",
      "tm:high:prd",
      "tm:mid:prd",
    ])
    expect(r.summary).toMatchObject({ todoTotal: 5, todoDone: 0 })
    expect(r.gaps.some(g => g.message.includes("未定档"))).toBe(true)
    expect(r.todos[0].description).toBe("上游未提供具体对比说明，请查看专利图样人工核对。")
  })
  it("版权按 PRD 互斥生成同图/同商品待办，保留品牌及真实案件，未知类型只提示", () => {
    const initial = fixtureInput()
    const check = checkFixture("copy", {
      output: {
        units: {
          "img-1": completedUnit(
            [
              { id: "same", matchType: "identical" },
              { id: "verified", matchType: "verified" },
              { id: "derivative", matchType: "derivative" },
              { id: "unknown-type", matchType: "future-type" },
              { id: "similar", matchType: "similar" },
            ],
            { knownIpMatch: { isMatch: true }, troCases: [{ caseNumber: "26-cv-001" }, {}] }
          ),
          "img-2": completedUnit([{ id: "other", matchType: "verified" }], {
            troCases: [{ caseNo: "26-cv-001" }],
          }),
        },
      },
    })
    const task = taskFixture([check], {
      input: json({
        ...initial,
        images: [initial.images[0], { ...initial.images[0], id: "img-2" }],
      }),
      annotations: {
        decisions: {
          "copy:img-1:derivative": { value: "flag" },
        },
      },
    })
    const r = buildReport(task)
    expect(r.todos.map(t => t.id)).toEqual([
      "copy:img-1:identical:prd",
      "copy:img-1:knownIp",
      "copy:prd:tro:26-cv-001",
      "copy:img-2:verified:prd",
    ])
    expect(r.todos.filter(t => t.action.section === "troCases")).toHaveLength(1)
    expect(r.summary.troCases).toBe(1)
    expect(r.gaps.some(g => g.message.includes("未定档"))).toBe(true)
    const dismissed = buildReport({
      ...task,
      annotations: json({
        decisions: {
          "copy:img-1:same": { value: "dismiss" },
        },
      }),
    })
    expect(dismissed.todos.map(t => t.id)).not.toContain("copy:img-1:verified:prd")
    expect(dismissed.todos.map(t => t.id)).toContain("copy:img-1:identical:prd")
  })
  it("疑似改造版本按图计需留意，不新增待办或未定档缺口，保留原始类型", () => {
    const task = taskFixture([
      checkFixture("copy", {
        status: "COMPLETED",
        output: {
          units: {
            "img-1": completedUnit([
              { id: "D1", matchType: "derivative", reason: "元素被重新绘制" },
              { id: "D2", matchType: "derivative" },
            ]),
          },
        },
      }),
    ])
    const report = buildReport(task)
    expect(rows(report.copy["img-1"].matches).map(m => [m.matchType, m.level])).toEqual([
      ["derivative", "mid"],
      ["derivative", "mid"],
    ])
    expect(report.copy["img-1"].riskLevel).toBe("mid")
    expect(report.summary).toMatchObject({ high: 0, mid: 1, unknown: 0, todoTotal: 0 })
    expect(report.summary.conclusion).toBe("发现需留意线索")
    expect(report.gaps.filter(g => g.kind === "copy")).toEqual([])
    expect(report.todos).toEqual([])
    const dismissed = buildReport({
      ...task,
      annotations: {
        decisions: { "copy:img-1:D1": { value: "dismiss" }, "copy:img-1:D2": { value: "dismiss" } },
      },
    })
    expect(dismissed.summary.mid).toBe(1)
  })
  it("改造版本不盖过完全一致和品牌高风险，失效仍优先排除", () => {
    for (const brand of [false, true]) {
      const r = buildReport(
        taskFixture([
          checkFixture("copy", {
            output: {
              units: {
                "img-1": completedUnit(
                  [
                    { id: "D1", matchType: "derivative" },
                    { id: "D2", matchType: "derivative", expired: true },
                    ...(brand ? [] : [{ id: "I1", matchType: "identical" }]),
                  ],
                  brand ? { knownIpMatch: { isMatch: true } } : {}
                ),
              },
            },
          }),
        ])
      )
      expect(r.summary).toMatchObject({ high: 1, mid: 0, unknown: 0, todoTotal: 1 })
      expect(rows(r.copy["img-1"].matches)[1].level).toBe("expired")
    }
  })
  it("文字按词+库国家+申请号合并，跨词互不影响并保留各来源", () => {
    const raw = {
      words: [
        {
          term: " COCA-COLA ",
          marks: [
            {
              id: "a",
              serialNumber: " 00123 ",
              level: "high",
              bucket: "title",
              where: ["标题"],
              owners: [{ country: "CA" }],
            },
            { id: "b", serialNumber: "00123", level: "mid", bucket: "desc", where: ["描述"] },
            { id: "c", serialNumber: "00123", countryCode: "GB", level: "low" },
            { id: "missing", level: "high" },
          ],
        },
        { term: "Cola", marks: [{ serialNumber: "00123", level: "high" }] },
      ],
    }
    const words = textWords(raw, annotations({})),
      marks = rows(words[0].marks)
    expect(marks).toHaveLength(3)
    expect(marks[0]).toMatchObject({
      targetId: "tm:coca-cola:US:00123",
      where: ["标题", "描述"],
      level: "high",
    })
    expect(rows(marks[0].sources)).toHaveLength(2)
    expect(marks[2].targetId).toBeNull()
    const updated = textWords(
      raw,
      annotations({ decisions: { "tm:coca-cola:US:00123": { value: "dismiss" } } })
    )
    expect(rows(updated[0].marks)[0].dismissed).toBe(true)
    expect(rows(updated[1].marks)[0].dismissed).toBe(false)
  })
  it("OCR 无 warnings 也报告缺口，空 words 是有效结果", () => {
    const r = buildReport(
      taskFixture([
        checkFixture("tm", {
          status: "COMPLETED",
          output: {
            units: {},
            text: { words: [], imageOCR: [{ imageID: "img-1", error: "failed" }] },
          },
        }),
      ])
    )
    expect(r.gaps).toContainEqual({
      kind: "tm",
      imageId: "img-1",
      message: "图片文字识别失败，未覆盖图片中的文字",
    })
    expect(r.summary.conclusion).toBe("存在补查缺口")
  })
  it.each([
    ["0", null],
    ["1", null],
    ["2026-02-30T01:00:00Z", null],
    [0, null],
    ["20260230", null],
    ["2026/10/23", "2026-10-23"],
    ["20261023", "2026-10-23"],
    ["2026-10-22T20:00:00Z", "2026-10-23"],
  ])("日期 %s -> %s", (v, expected) => expect(dateValue(v)).toBe(expected))
  it("TRO 最近案号跨词去重，聚合数字不冒充案件数", () => {
    const r = buildReport(
      taskFixture([
        checkFixture("tm", {
          status: "COMPLETED",
          output: {
            units: {},
            text: {
              words: [
                {
                  term: "Alpha",
                  marks: [],
                  tro: { ownerCases: 9, markCases: 2, latestCaseNumber: "26-cv-001" },
                },
                { term: "Beta", marks: [], tro: { ownerCases: 5, latestCaseNumber: "26-cv-001" } },
                { term: "Gamma", marks: [], tro: { ownerCases: 99 } },
              ],
            },
          },
        }),
      ])
    )
    expect(r.summary.troCases).toBe(1)
    expect(r.gaps.some(g => g.message.includes("TRO 关联信号"))).toBe(true)
  })
})

describe("商品图输入与报告", () => {
  const image = {
    id: "listing-1",
    url: "https://m.media-amazon.com/images/I/1.jpg",
    name: "商品图",
  }
  it("嵌套 DTO 保留商品图；URL 去重、跨组 ID 校验和旧幂等兼容", async () => {
    const old = normalizeInput({ sites: ["US"], tm: { brand: "品牌" } }, 1)
    const dto = plainToInstance(QuotePatentQueryDto, {
      sites: ["US"],
      tm: { brand: "品牌", images: [image] },
    })
    expect(await validate(dto, { whitelist: true })).toHaveLength(0)
    expect(dto.tm?.images).toEqual([image])
    expect(sameInput(old, normalizeInput({ ...old, tm: { ...old.tm, images: [] } }, 1))).toBe(true)
    const i = normalizeInput(
      { ...old, tm: { brand: "品牌", images: [image, { ...image, id: "listing-2" }] } },
      1
    )
    expect(i.tm?.images).toHaveLength(1)
    expect(quote(i).quotedCredits).toBe(5)
    expect(sameInput(old, i)).toBe(false)
    expect(() =>
      normalizeInput(
        { ...fixtureInput(), tm: { brand: "品牌", images: [{ ...image, id: "img-1" }] } },
        1
      )
    ).toThrow("图片 ID")
    expect(() =>
      normalizeInput({ ...old, tm: { brand: "品牌", images: [{ ...image, id: "__proto__" }] } }, 1)
    ).toThrow("图片 ID")
    expect(() =>
      normalizeInput(
        { ...old, tm: { brand: "品牌", images: [{ ...image, url: "https://evil.test/a" }] } },
        1
      )
    ).toThrow("商品图仅支持")
    expect(() =>
      normalizeInput({ sites: ["US"], copy: {}, tm: { brand: "品牌", images: [image] } }, 1)
    ).toThrow("请上传产品图")
  })
  it("缺失商品图 OCR 以原 ID 报缺口，关闭 OCR 不报图片缺口", () => {
    const i = normalizeInput({ sites: ["US"], tm: { brand: "品牌", images: [image] } }, 1)
    const checks = [
      checkFixture("tm", {
        status: "COMPLETED",
        output: { units: {}, text: { words: [], imageOCR: [] } },
      }),
    ]
    const task = taskFixture(checks, { status: "COMPLETED", input: json(i) as Prisma.JsonObject })
    expect(buildReport(task).gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ imageId: image.id })])
    )
    i.tm!.includeImageText = false
    expect(
      buildReport({ ...task, input: json(i) as Prisma.JsonObject }).gaps.some(
        g => g.imageId === image.id
      )
    ).toBe(false)
  })
})
