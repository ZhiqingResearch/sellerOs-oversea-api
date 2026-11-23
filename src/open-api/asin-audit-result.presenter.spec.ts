import { withUiLanguage } from "../common/i18n/request-language"
import {
  buildAuditResultView,
  type AutomotiveAuditResultView,
  type ComputerAuditResultView,
} from "./asin-audit-result.presenter"

describe("第三方审计业务详情", () => {
  it("English summaries localize rule names and preserve evidence quotations", () => {
    const stored = {
      deductions: [
        { ruleId: "M1-2.2", name: "属性值准确性", points: 2, reason: "Source: 原始属性" },
      ],
    }
    const result = withUiLanguage("en-US", () =>
      buildAuditResultView("AUTOMOTIVE", stored)
    ) as AutomotiveAuditResultView
    expect(result.optimizationSummary).toContain(
      "Attribute accuracy (deduct 2 points): Source: 原始属性"
    )
    expect(stored.deductions[0].name).toBe("属性值准确性")
  })

  it("排队和失败没有结果时保留null", () => {
    expect(buildAuditResultView("AUTOMOTIVE", null)).toBeNull()
    expect(buildAuditResultView("COMPUTER", undefined)).toBeNull()
  })

  it("汽配对齐表格列：零否决留空、只汇总实际扣分、未知SKU不伪造有效", () => {
    const stored = {
      summary: { score: 83.94, grade: "A", coverageRate: 0.52 },
      validation: {
        asin: { status: "VALID" },
        sku: { status: "UNVERIFIED", reason: "没有商品主数据" },
      },
      vetoItems: [],
      deductions: [
        { ruleId: "M1-2.2", name: "属性值准确性", points: 2, reason: "材质冲突" },
        { ruleId: "ZERO", points: 0 },
      ],
      dataGaps: [
        {
          ruleId: "M1-2.2",
          name: "属性值准确性",
          confirmedDeductedPoints: 2,
          missingData: [{ data: "安装位置基准" }],
        },
      ],
      rules: [{ internal: true }],
      model: "internal-model",
      crawlerSnapshotId: "internal-id",
    }
    const original = JSON.stringify(stored)
    const result = buildAuditResultView("AUTOMOTIVE", stored) as AutomotiveAuditResultView
    expect(result).toMatchObject({
      score: 83.94,
      grade: "A",
      coverageRate: 0.52,
      isAsinValid: true,
      isSkuValid: null,
      vetoSummary: null,
    })
    expect(result.optimizationSummary).toContain("扣2分")
    expect(result.optimizationSummary).not.toContain("ZERO")
    expect(result.remarks).toContain("安装位置基准")
    expect(result.remarks).toContain("已确认扣2分")
    expect(result.remarks).toContain("没有商品主数据")
    expect(Object.keys(result).sort()).toEqual(
      [
        "score",
        "grade",
        "isAsinValid",
        "isSkuValid",
        "vetoSummary",
        "optimizationSummary",
        "coverageRate",
        "remarks",
      ].sort()
    )
    expect(JSON.stringify(stored)).toBe(original)
  })

  it("已命中否决不能被空值逻辑抹掉", () => {
    const result = buildAuditResultView("AUTOMOTIVE", {
      summary: { score: 0, grade: "D", coverageRate: 0.5 },
      vetoItems: [{ ruleId: "M1-1.1", name: "标题属性冲突", reason: "材质明确矛盾" }],
    }) as AutomotiveAuditResultView
    expect(result.score).toBe(0)
    expect(result.vetoSummary).toContain("材质明确矛盾")
    expect(result.optimizationSummary).toContain("最终0分/D")
  })

  it("电脑按三个部分返回，扣分按维度汇总，建议无分值，缺口单列", () => {
    const stored = {
      isSoldOut: false,
      listing: {
        status: "COMPLETED",
        score: 86.3,
        diagnosis: "内容诊断",
        scoring: { coverageRate: 0.78125 },
        boards: [{ id: "F", name: "事实一致性" }],
        deductions: [
          { boardId: "F", ruleId: "F1", name: "核心属性", points: 2, reason: "RAM冲突" },
          { boardId: "F", ruleId: "F3", name: "辅助属性", points: 1, reason: "型号错误" },
        ],
        optimization: { actions: [{ title: "修正RAM", action: "改为16GB（扣2分）" }] },
        consistencyCheck: {
          summary: "存在矛盾",
          contradictions: [
            { titleQuote: "16GB", field: "五点", contentQuote: "8GB", explanation: "内存冲突" },
          ],
        },
      },
      keywordTraffic: {
        status: "COMPLETED",
        score: 79.69,
        scoring: { coverageRate: 16 / 36 },
        dataGaps: [{ ruleId: "G1", name: "首页观测", reason: "词池为空" }],
        optimization: {
          suggestions: [{ ruleId: "G1", level: "pending", summary: "证据不足：词池为空" }],
        },
      },
      configurationReview: {
        status: "MISMATCH",
        summary: "错误配置16GB+8TB；正确配置32GB+1TB",
        dataGaps: [],
      },
    }
    const original = JSON.stringify(stored)
    const result = buildAuditResultView("COMPUTER", stored) as ComputerAuditResultView
    expect(result.listing.deductionSummary).toContain("F 事实一致性（合计扣3分）")
    expect(result.listing.optimizationSuggestions).toBe("修正RAM：改为16GB")
    expect(result.listing.consistencyConclusion).toContain("标题「16GB」与五点「8GB」")
    expect(result.keywordTraffic.coverageRate).toBe(16 / 36)
    expect(result.keywordTraffic.remarks).toContain("G1 首页观测：词池为空")
    expect(result.keywordTraffic.optimizationSuggestions).toContain("证据不足")
    expect(result.configurationReview.conclusion).toContain("正确配置32GB+1TB")
    expect(result.listing).not.toHaveProperty("boards")
    expect(result.keywordTraffic).not.toHaveProperty("scoring")
    expect(JSON.stringify(stored)).toBe(original)
  })

  it("缺货跳过与无证据不能显示零分或正常", () => {
    const result = buildAuditResultView("COMPUTER", {
      isSoldOut: true,
      listing: { status: "SKIPPED", reason: "缺货跳过" },
      keywordTraffic: {
        status: "INSUFFICIENT_EVIDENCE",
        score: null,
        scoring: { coverageRate: 0 },
        dataGaps: [{ name: "全部", reason: "缺数据" }],
      },
      configurationReview: {
        status: "UNVERIFIED",
        summary: "没有亮点",
        dataGaps: ["缺内存"],
        ambiguities: ["存储表述歧义"],
      },
    }) as ComputerAuditResultView
    expect(result.listing).toMatchObject({
      status: "SKIPPED",
      score: null,
      coverageRate: null,
      remarks: "缺货跳过",
      optimizationSuggestions: null,
    })
    expect(result.keywordTraffic).toMatchObject({
      score: null,
      coverageRate: 0,
      deductionSummary: null,
    })
    expect(result.configurationReview.remarks).toBe("缺内存\n存储表述歧义")
  })
})
