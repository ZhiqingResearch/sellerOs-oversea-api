import { buildOptimizationPlan, getOptimizationPlan, hasComparableScore } from "./listing-optimization"

const baseline = { planIndex: 1, result: { title: "Original", description: "Facts", bullets: ["Fact"] }, score: 90.5, scoreResult: { total: 90.5, suggestions: ["Improve clarity"] } }
const candidate = { ...baseline.result, title: "Clearer title" }

describe("历史优化采纳条件", () => {
  it.each([90.5, 91, 100])("真实评分 %s 不低于原分才可采纳", total => {
    const plan = buildOptimizationPlan(baseline, baseline, "attempt", candidate, { total })
    expect(plan).toMatchObject({ result: candidate, score: total, scoreResult: { total }, optimization: { status: "ACCEPTED" } })
    expect(baseline.result.title).toBe("Original")
  })
  it("使用精确分数，不能把90.49四舍五入成91冒充达标", () => {
    const plan = buildOptimizationPlan(baseline, baseline, "attempt", candidate, { total: 90.49 })
    expect(plan).toMatchObject({ result: baseline.result, score: 90.5, optimization: { status: "REJECTED", candidateScore: 90.49, candidateResult: candidate } })
  })
  it.each([null, undefined, NaN, Infinity, -1, 101, "99"])("非法或未完成评分 %s 不能覆盖原文", total => {
    const plan = buildOptimizationPlan(baseline, baseline, "attempt", candidate, { total })
    expect(plan.result).toBe(baseline.result)
    expect(plan.optimization.status).toBe("SCORE_FAILED")
    expect(hasComparableScore(total)).toBe(false)
  })
  it("原分为0仍有效，不因falsy跳过", () => {
    const zero = { ...baseline, score: 0, scoreResult: { total: 0 } }
    expect(buildOptimizationPlan(zero, zero, "attempt", candidate, { total: 1 }).optimization.status).toBe("ACCEPTED")
  })
  it("仅评分波动但正文未改变不能作为有效优化", () => {
    expect(buildOptimizationPlan(baseline, baseline, "attempt", baseline.result, { total: 99 }).optimization.status).toBe("UNCHANGED")
  })
  it("补空数组或空白格式变化不算有效内容改动", () => {
    const normalized = { ...baseline.result, title: " Original  ", itemHighlights: [], searchTerms: [] }
    expect(buildOptimizationPlan(baseline, baseline, "attempt", normalized, { total: 99 }).optimization.status).toBe("UNCHANGED")
  })
  it("执行期间修改过原文时保留最新版本，不能覆盖", () => {
    const current = { ...baseline, result: { ...baseline.result, title: "Edited elsewhere" } }
    const plan = buildOptimizationPlan(current, baseline, "attempt", candidate, { total: 99 })
    expect(plan.result).toBe(current.result)
    expect(plan.optimization.status).toBe("STALE")
  })
  it("仅增加失败回执不影响评分重试的原文一致性", () => {
    const current = { ...baseline, optimization: { status: "SCORE_FAILED" } }
    expect(buildOptimizationPlan(current, baseline, "attempt", candidate, { total: 99 }).optimization.status).toBe("ACCEPTED")
  })
  it("旧记录保存时补齐planIndex不应阻止评分重试", () => {
    const { planIndex: _index, ...legacy } = baseline
    expect(buildOptimizationPlan({ ...legacy, planIndex: 1 }, legacy, "attempt", candidate, { total: 99 }).optimization.status).toBe("ACCEPTED")
  })
  it("单独保存的B方案按planIndex识别，兼容旧单方案结构", () => {
    expect(getOptimizationPlan({ plans: [baseline] }, 1)).toBe(baseline)
    expect(getOptimizationPlan({ plans: [baseline] }, 0)).toBeUndefined()
    expect(getOptimizationPlan({ result: baseline.result, scoreResult: baseline.scoreResult }, 0)?.scoreResult).toBe(baseline.scoreResult)
  })
})
