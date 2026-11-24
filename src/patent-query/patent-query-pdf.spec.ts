import { withUiLanguage } from "../common/i18n/request-language"
import { PatentQueryPdfService } from "./patent-query-pdf.service"
import { patentReportHtml } from "./patent-query-pdf.template"
import { checkFixture, taskFixture } from "./testing/fixtures"

describe("专利报告 PDF", () => {
  it.each([
    { todoDone: { "missing:prd": true } },
    { decisions: { "missing:key": { value: "flag" } } },
  ])("拒绝导出已标记但找不到对应证据的报告", saved => {
    const task = taskFixture([], { annotations: JSON.parse(JSON.stringify(saved)) })
    expect(() =>
      patentReportHtml(
        task,
        id => id,
        () => ""
      )
    ).toThrow("incomplete")
  })
  it.each([
    [null, 404],
    [taskFixture([], { status: "SETTLING", error: "[PAYMENT_REQUIRED]" }), 402],
    [taskFixture([], { status: "RUNNING" }), 409],
  ] as const)("仅接受本人已结算且未删除的报告 %#", async (row, statusCode) => {
    const tx = { patentQueryTask: { findFirst: jest.fn().mockResolvedValue(row) } }
    const prisma = { $transaction: (fn: (db: typeof tx) => unknown) => fn(tx) }
    const render = jest.fn()
    const service = new PatentQueryPdfService(
      prisma as never,
      {} as never,
      { renderPdf: render } as never
    )
    await expect(service.export(9, 3)).rejects.toMatchObject({ status: statusCode })
    expect(tx.patentQueryTask.findFirst).toHaveBeenCalledWith({
      where: { id: 3, userId: 9, deletedAt: null },
      include: { checks: true },
    })
    expect(render).not.toHaveBeenCalled()
  })

  it("renders historical application errors in English and preserves source evidence", () => {
    const error =
      "检测参数未被服务接受，请检查输入（错误码：VALIDATION_VISUAL_SEARCH_MAX_IMAGES_EXCEEDED）"
    const task = taskFixture([
      checkFixture("copy", { status: "FAILED", error }),
      checkFixture("design", {
        status: "FAILED",
        error: "结果未完整获取. Results are incomplete; risk cannot be ruled out.",
      }),
      checkFixture("tm", {
        output: { units: {}, text: { words: [], imageOCR: [{ lines: [{ text: "原始文字" }] }] } },
      }),
    ])
    const html = withUiLanguage("zh-CN", () =>
      patentReportHtml(
        task,
        id => id,
        () => ""
      )
    )
    expect(html).toContain("The screening service rejected the input.")
    expect(html).toContain("VALIDATION_VISUAL_SEARCH_MAX_IMAGES_EXCEEDED")
    expect(html).toContain("Results are incomplete. Risk cannot be ruled out.")
    expect(html).toContain("原始文字")
    expect(html).not.toMatch(/检测参数未被服务接受|结果未完整获取/)
    expect(task.checks[0].error).toBe(error)
  })

  it("保留合并商标的所有来源、标记和证据，输入文字仅作为文本", () => {
    const task = taskFixture(
      [
        checkFixture("tm", {
          status: "COMPLETED",
          output: {
            units: {},
            text: {
              words: [
                {
                  term: "<script>cup</script>",
                  tro: { cases: [{ caseNumber: "CASE-01" }] },
                  marks: [
                    { serialNumber: "123", markText: "First source", level: "high" },
                    { serialNumber: "123", markText: "Second source", level: "mid" },
                  ],
                },
              ],
              imageOCR: [{ imageID: "img-1", lines: [{ text: "OCR evidence text" }] }],
            },
          },
        }),
      ],
      {
        annotations: {
          decisions: { "tm:%3Cscript%3Ecup%3C%2Fscript%3E:US:123": { value: "flag" } },
        },
      }
    )
    const html = withUiLanguage("en-US", () =>
      patentReportHtml(
        task,
        id => id,
        () => "<img>"
      )
    )
    for (const item of [
      "Original source 2",
      "Second source",
      "Flagged",
      "CASE-01",
      "OCR evidence text",
      "&lt;script&gt;",
    ])
      expect(html).toContain(item)
    expect(html).not.toContain("<script>")
  })
})
