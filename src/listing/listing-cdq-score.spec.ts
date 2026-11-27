import { readFileSync } from "node:fs"
import { join } from "node:path"
import { withUiLanguage } from "../common/i18n/request-language"
import { CDQ_SCORE_VERSION, normalizeCdqScoreReport } from "./listing-cdq-score"
import { buildScoreCorrectionPlan, buildScoreCorrectionRequest, mergeScoreCorrection } from "./listing-score-correction"
import { prepareListingScoreDelivery } from "./listing-score-delivery"
import { buildListingScoreSystemPrompt } from "./listing-score-prompt"
import { extractScoreRecoveryCore, validateScoreReport } from "./listing-score-recovery"

function createReport() {
  return {
    scoreVersion: CDQ_SCORE_VERSION,
    mode: "standard",
    total: 100,
    potential: "S级",
    suggestions: ["建议保持已核验项"],
    dimensions: [
      [30, 25, 20, 15, 5, 5],
      [7, 7, 5, 4, 2],
      [10, 6, 4],
      [7, 5, 3],
    ].map((limits, index) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO 关系覆盖", "Alexa 语义质量"][index],
      maxScore: [40, 25, 20, 15][index],
      weight: [40, 25, 20, 15][index],
      score: [40, 25, 20, 15][index] as number | null,
      criteria: limits.map((maxScore, criterionIndex) => ({
        name:
          index === 0
            ? ["结构化属性", "标题质量", "变体质量", "图片质量", "A+ 内容", "五点描述"][
                criterionIndex
              ]
            : `评分项${criterionIndex}`,
        maxScore,
        score: maxScore as number | null,
        status: "VERIFIED",
        description: "已完整取证，当前字段满足规则",
        deductions: [] as { points: number; reason: string }[],
      })),
    })),
  }
}

interface ParsedScore {
  total: number | null
  dimensions: Array<
    ReturnType<typeof createReport>["dimensions"][number] & {
      subtitle: string
      cdq: {
        applicableMax: number
        effectiveMax: number
        earnedScore: number
        normalizedScore: number | null
        evidenceCoverage: number
      }
    }
  >
}

describe("新版 CDQ 取证与折算", () => {
  it("英文报告可通过校验，翻译标题和覆盖率说明，保留计算结果和引用", () => {
    const report = createReport()
    report.dimensions[0].criteria[2].status = "UNAVAILABLE"
    report.dimensions[0].criteria[2].score = null
    Object.assign(report.dimensions[0].criteria[1], {
      score: 24, status: "MISSING", deductions: [{ points: 1, reason: "Repeated term", evidence: "供应商原文" }],
    })
    const chinese = normalizeCdqScoreReport(report) as unknown as ParsedScore
    const english = withUiLanguage("en-US", () => {
      const delivered = prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!
      return JSON.parse(validateScoreReport(delivered, "amazon_us")) as ParsedScore
    })
    expect(english.total).toBe(chinese.total)
    expect(english.dimensions[0].cdq).toEqual(chinese.dimensions[0].cdq)
    expect(english.dimensions[0]).toMatchObject({
      name: "CDQ completeness", subtitle: "Normalized score · Evidence coverage 80% · Excellent",
    })
    expect(english.dimensions[0].criteria[0]).toMatchObject({ name: "Structured attributes", score: 30 })
    expect(english.dimensions[0].criteria[1].deductions).toEqual([
      { points: 1, reason: "Repeated term", evidence: "供应商原文" },
    ])
    expect(english.dimensions[1].name).toBe("Keyword coverage")
    expect(withUiLanguage("en-US", () => buildListingScoreSystemPrompt(undefined, "")))
      .toContain("Use English for all scoring labels, descriptions, deduction reasons")
  })

  it("英文交付只替换固定来源、CDQ说明和Alexa公式，保留同句引文与分值", () => {
    const report = createReport()
    const formula = "5 ×合格条数 / N"
    const quoted = `产品包装标记 ${formula}`
    const reason = `Scored as ${formula}. Label reads “${quoted}”.`
    const note = "说明：CDQ权重为内部整理口径，不是Amazon官方评分算法。"
    report.suggestions.push(note, `Keep the original label “${quoted}”.`)
    Object.assign(report.dimensions[0].criteria[0], { source: "官方" })
    Object.assign(report.dimensions[1].criteria[0], { source: "操作建议" })
    Object.assign(report.dimensions[3].criteria[1], {
      source: "行业研究", score: 4, description: `Score = ${formula}; custom: min(5, 5×合格条数/6)`,
      deductions: [{ ruleId: "alexa.bulletData", reason, points: 1, evidence: quoted }],
      assessment: { quote: quoted },
    })
    report.dimensions[3].score = 14
    report.total = 99
    const deliver = (language: "en-US" | "zh-CN") =>
      JSON.parse(withUiLanguage(language, () => prepareListingScoreDelivery(JSON.stringify(report), "amazon_us"))!)
    const english = deliver("en-US")
    const chinese = deliver("zh-CN")

    expect(english.total).toBe(chinese.total)
    expect(english.total).toBe(99)
    expect(english.dimensions[3].score).toBe(14)
    expect(english.dimensions[0].criteria[0].source).toBe("Official")
    expect(english.dimensions[1].criteria[0].source).toBe("Practical guidance")
    expect(english.dimensions[3].criteria[1]).toMatchObject({
      score: 4, source: "Industry research",
      description: "Score = 5 × qualifying bullets / N; custom: min(5, 5 × qualifying bullets / 6)",
      deductions: [{
        ruleId: "alexa.bulletData", reason: `Scored as 5 × qualifying bullets / N. Label reads “${quoted}”.`,
        points: 1, evidence: quoted,
      }],
      assessment: { quote: quoted },
    })
    expect(english.suggestions.slice(1)).toEqual([
      "CDQ weights follow an internal scoring methodology independent of Amazon's official scoring.",
      `Keep the original label “${quoted}”.`,
    ])
    expect(chinese.dimensions[3].criteria[1].deductions[0].reason).toBe(reason)
    expect(chinese.suggestions[1]).toBe(note)
  })

  it("英文评分规则和未通过一致性校验的报告均使用英文搜索词缺失提示", () => {
    const report = createReport()
    Object.assign(report.dimensions[1].criteria[3], {
      status: "UNAVAILABLE", description: "Search terms unavailable",
    })
    Object.assign(report.dimensions[3].criteria[2], {
      score: 0, deductions: [{ ruleId: "alexa.description", points: 3, reason: "Missing specifications" }],
    })
    for (const language of ["en-US", "zh-CN"] as const) {
      withUiLanguage(language, () => {
        const label = language === "en-US" ? "Search terms unavailable" : "SEARCH TERMS未获取"
        const prompt = buildListingScoreSystemPrompt(undefined, "")
        expect(prompt).toContain('description="Search terms unavailable"')
        expect(prompt).not.toMatch(/\p{Script=Han}/u)
        expect(prompt).toContain(language === "en-US" ? "Use English" : "Use Simplified Chinese")
        const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
        expect(delivered.validationStatus).toBe("BEST_EFFORT")
        expect(delivered.dimensions[1].criteria[3]).toMatchObject({
          description: label, status: "UNAVAILABLE", score: 4, deductions: [],
        })
      })
    }
  })

  it("两种界面共用英文评分示例，各自指定返回语言并保留商品取证原文", () => {
    const rubric = readFileSync(join(__dirname, "prompts/amazon-score-standard.legacy-zh.md"), "utf8")
    const userPrompt = '<listing-scoring-source>{"title":"墨水","itemHighlights":"","bullets":["每瓶 17000 页"],"description":"材料","searchTerms":""}</listing-scoring-source>'
    const english = withUiLanguage("en-US", () => buildListingScoreSystemPrompt(rubric, userPrompt))
    const chinese = withUiLanguage("zh-CN", () => buildListingScoreSystemPrompt(rubric, userPrompt))
    expect(english.replaceAll("17000 页", "")).not.toMatch(/\p{Script=Han}/u)
    expect(english).toContain("Reviewed 25 attributes visible on the product page")
    expect(english).toContain("Specify whether the yield is per bottle or for the entire set.")
    for (const value of ["15.5/30", "53,500", "ET-2850"]) {
      expect(chinese).toContain(value)
      expect(english).toContain(value)
    }
    expect(chinese.replaceAll("17000 页", "")).not.toMatch(/\p{Script=Han}/u)
    expect(chinese).toContain("Reviewed 25 attributes visible on the product page")
    expect(chinese).toContain("Use Simplified Chinese")
    expect(english).toContain("Bullet 2 gives no measurable specification")
    expect(english).not.toContain("SEARCH TERMS未获取")
    expect(english).toContain('"quote":"17000 页"')
  })

  it.each(["zh-CN", "en-US"] as const)("%s 重试沿用英文评分模板并保留调用方追加的原文", locale => {
    const rubric = readFileSync(join(__dirname, "prompts/amazon-score-standard.legacy-zh.md"), "utf8")
    const reference = rubric.slice(rubric.indexOf("# Listing 质量评分模型")) + "\n调用方原文"
    const { userPrompt, systemPrompt } = withUiLanguage(locale, () => buildScoreCorrectionRequest(
      reference, "Original product text", {
        report: { total: 0, dimensions: [], suggestions: [], potential: "" },
        criteria: [], shouldCorrectSuggestions: false, pendingTailFields: ["suggestions"],
      },
    ))
    expect(systemPrompt).toContain(locale === "en-US" ? "Use English" : "Use Simplified Chinese")
    expect(systemPrompt).not.toMatch(/\p{Script=Han}/u)
    expect(JSON.parse(userPrompt).scoringReference).toContain("Example seller-facing report")
    expect(userPrompt).toContain("调用方原文")
    expect(userPrompt.replace("调用方原文", "")).not.toMatch(/\p{Script=Han}/u)
  })

  it("实跑负分只复核异常项，图片扣分保留并统一已取证状态", () => {
    const text = readFileSync(join(__dirname, "fixtures/listing-score-cdq-20260916.json"), "utf8")
    const plan = buildScoreCorrectionPlan(text, "amazon_us")!
    expect(plan.criteria).toEqual([{ dimensionIndex: 3, criterionIndex: 2 }])
    expect(plan.shouldCorrectSuggestions).toBe(false)
    const result = JSON.parse(
      mergeScoreCorrection(
        JSON.stringify({
          corrections: [
            {
              dimensionIndex: 3,
              criterionIndex: 2,
              score: 1,
              description: "已核验描述缺少结构化规格及具体场景",
              deductions: [
                { points: 2, reason: "描述缺少结构化规格及具体场景，建议按现有参数补齐" },
              ],
            },
          ],
        }),
        plan,
        "amazon_us"
      )
    ) as ParsedScore
    expect(result.dimensions[0].criteria[3]).toMatchObject({ score: 10.5, status: "MISSING" })
    expect(result.dimensions[0].cdq).toMatchObject({
      effectiveMax: 50,
      earnedScore: 45.5,
      normalizedScore: 91,
      evidenceCoverage: 0.5,
    })
    expect(result.total).toBe(88.5666) // 后台搜索词未获取，不再扣4分。
  })

  it("完整六维100分折算40分；其他三维保持60分", () => {
    const report = JSON.parse(
      validateScoreReport(JSON.stringify(createReport()), "amazon_us")
    ) as ParsedScore
    expect(report.total).toBe(100)
    expect(report.dimensions[0]).toMatchObject({
      score: 40,
      cdq: {
        applicableMax: 100,
        effectiveMax: 100,
        earnedScore: 100,
        normalizedScore: 100,
        evidenceCoverage: 1,
      },
    })
  })

  it("未获取属性保留适用权重，无变体N/A剔除，已核验标题扣分按有效满分折算", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { status: "UNAVAILABLE", score: null })
    Object.assign(report.dimensions[0].criteria[2], {
      status: "NOT_APPLICABLE",
      score: null,
      description: "确认单SKU且类目不支持变体",
    })
    Object.assign(report.dimensions[0].criteria[1], {
      status: "MISSING",
      score: 20,
      deductions: [{ points: 5, reason: "标题当前201字符，超过200，建议缩短至200以内" }],
    })
    const result = JSON.parse(
      validateScoreReport(JSON.stringify(report), "amazon_us")
    ) as ParsedScore
    expect(result.dimensions[0]).toMatchObject({
      score: 36,
      cdq: {
        applicableMax: 80,
        effectiveMax: 50,
        earnedScore: 45,
        normalizedScore: 90,
        evidenceCoverage: 0.625,
      },
    })
    expect(result.dimensions[0].subtitle).toContain("证据覆盖率 62.5%")
    expect(result.total).toBe(96)
    expect(result.dimensions[0].criteria[0].score).toBeNull()
  })

  it("所有字段未获取时不出CDQ分或综合分", () => {
    const report = createReport()
    report.dimensions[0].criteria.forEach(criterion =>
      Object.assign(criterion, { status: "UNAVAILABLE", score: null })
    )
    const result = JSON.parse(
      validateScoreReport(JSON.stringify(report), "amazon_us")
    ) as ParsedScore
    expect(result.total).toBeNull()
    expect(result.dimensions[0].score).toBeNull()
    expect(result.dimensions[0].cdq.normalizedScore).toBeNull()
    expect(result.dimensions[0].cdq.evidenceCoverage).toBe(0)
  })

  it("标题违禁仅标题25分归零，保留其他三维分数", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[1], {
      status: "MISSING",
      score: 0,
      deductions: [{ points: 25, reason: "标题含Free Shipping，建议删除促销词" }],
    })
    const result = JSON.parse(
      validateScoreReport(JSON.stringify(report), "amazon_us")
    ) as ParsedScore
    expect(result.dimensions[0].score).toBe(30)
    expect(result.total).toBe(90)
  })

  it("1–2条五点可计半分，不触发旧条数纠错；截断尾部可恢复", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[5], {
      status: "MISSING",
      score: 2.5,
      description: "五点当前2条，至少3条满分",
      deductions: [{ points: 2.5, reason: "五点当前2条，建议补足3条" }],
    })
    expect(buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us")).toBeNull()
    const core = {
      scoreVersion: report.scoreVersion,
      mode: report.mode,
      total: report.total,
      dimensions: report.dimensions,
    }
    expect(
      extractScoreRecoveryCore(
        JSON.stringify(core).slice(0, -1) + ',"suggestions":["未完成',
        "amazon_us"
      )
    ).toEqual(core)
    expect(normalizeCdqScoreReport(report).total).toBe(99)
  })

  it.each([0, 30])("未获取项禁止填%d分", score => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { status: "UNAVAILABLE", score })
    expect(() => validateScoreReport(JSON.stringify(report), "amazon_us")).toThrow()
  })

  it("拒绝未知状态、错误权重、无理由扣分和非法N/A", () => {
    for (const patch of [
      { status: "UNKNOWN" },
      { maxScore: 12 },
      { score: 29 },
      { status: "NOT_APPLICABLE", score: null },
    ]) {
      const report = createReport()
      Object.assign(report.dimensions[0].criteria[0], patch)
      expect(() => normalizeCdqScoreReport(report)).toThrow()
    }
  })
})
