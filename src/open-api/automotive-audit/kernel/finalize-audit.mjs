// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import assert from 'node:assert/strict';
import { summarizeScores } from './audit-engine.mjs';

export const SCORE_BASIS = {
  id: 'evaluable-weighted-v5',
  description: '已确认且有明确分值的扣分必须参与计分；同项其他数据缺失不能抵消已确认问题。部分可核查项只纳入已确认扣分对应的预算（去重并按原项满分封顶），该部分得分为0，剩余预算继续从分子分母剔除，不默认通过或计零分。总分=CDQ已核查得分÷CDQ可评价满分×60＋OE已核查得分÷OE可评价满分×40－已确认ST外扣，最低0；确认否决立即0/D。按未四舍五入总分的90/80/70/60阈值评级，展示保留两位小数。缺口和未核查细项独立保留；任一模块无可评价预算且未命中否决时停止计分。',
};

export function finalizeAudit(result) {
  for (const rule of result.rules) {
    // Re-finalizing a result must preserve its partial scope, not turn it into
    // a full-rule zero or deduct the same issue for a second time.
    const wasPartial = rule.scoreTreatment === 'partial_confirmed_deduction';
    if (wasPartial) rule.status = 'unverified';
    assert(['pass', 'fail', 'unknown', 'not_applicable', 'unverified'].includes(rule.status), `无效规则状态：${rule.ruleId}`);
    if (rule.kind === 'scored' && ['pass', 'fail'].includes(rule.status)) {
      assert(Number.isFinite(rule.earnedPoints) && rule.earnedPoints >= 0 && rule.earnedPoints <= rule.maxPoints, `分数越界：${rule.ruleId}`);
      assert.equal(rule.status === 'pass', rule.earnedPoints === rule.maxPoints, `状态与分数矛盾：${rule.ruleId}`);
    }
    if (rule.kind === 'external_penalty' && ['pass', 'fail'].includes(rule.status)) assert(Number.isFinite(rule.deductionPoints) && rule.deductionPoints >= 0, 'ST扣分必须有明确数值');
    rule.hasEvidenceLimits = ['unknown', 'not_applicable', 'unverified'].includes(rule.status);
    if (rule.hasEvidenceLimits) {
      rule.status = 'unverified'; rule.earnedPoints = null;
      rule.pendingType = null;
      rule.reason = rule.reason.replace(/整项暂不结算|整项未结算|暂不结算|尚未结算|未赋分|未定分|不贡献得分/g, '从评分分子与分母剔除');
      rule.scoreTreatment = 'excluded_from_denominator';
    } else rule.scoreTreatment = rule.status === 'fail' ? 'confirmed_deduction' : 'verified';
    let partialDeduction = 0;
    if (rule.status === 'unverified' && rule.kind === 'scored') {
      const seen = new Set();
      for (const issue of rule.confirmedIssues ?? []) {
        assert(Number.isFinite(issue.deductionPoints) && issue.deductionPoints >= 0 && issue.evidence?.length, '子项扣分必须有明确分值和证据');
        const key = issue.key ?? issue.message;
        if (!seen.has(key)) partialDeduction += issue.deductionPoints;
        seen.add(key);
      }
      partialDeduction = Math.min(rule.maxPoints, partialDeduction);
    }
    rule.deductionPoints = rule.kind === 'scored' && rule.status === 'fail' ? rule.maxPoints - rule.earnedPoints : rule.kind === 'external_penalty' && rule.status === 'fail' ? rule.deductionPoints : partialDeduction;
    rule.evaluatedPoints = rule.kind === 'scored' && !rule.hasEvidenceLimits ? rule.maxPoints : 0;
    if (rule.status === 'unverified' && partialDeduction > 0) {
      rule.status = 'fail';
      rule.earnedPoints = 0;
      rule.evaluatedPoints = partialDeduction;
      rule.scoreTreatment = 'partial_confirmed_deduction';
      rule.scoringNote = `已确认扣${partialDeduction}分，纳入可评价预算${partialDeduction}分、得分0；其余${rule.maxPoints - partialDeduction}分缺证据剔除。其他字段缺失不抵消已确认扣分。`;
    }
    rule.excludedPoints = rule.kind === 'scored' ? rule.maxPoints - rule.evaluatedPoints : 0;
  }
  const modules = ['M1', 'M2'].map(moduleId => {
    const rules = result.rules.filter(rule => rule.kind === 'scored' && rule.ruleId.startsWith(moduleId));
    const summary = summarizeScores(rules);
    const deductionPoints = rules.reduce((sum, rule) => sum + rule.deductionPoints, 0);
    const scorePercent = summary.evaluatedPoints > 0 ? summary.earnedPoints / summary.evaluatedPoints * 100 : null;
    const weightPoints = moduleId === 'M1' ? 60 : 40;
    const weightedScore = summary.evaluatedPoints > 0 ? summary.earnedPoints / summary.evaluatedPoints * weightPoints : null;
    return { moduleId, ...summary, deductionPoints, weightPoints, excludedPoints: summary.pendingPoints, weightedScore, score: weightedScore === null ? null : Number(weightedScore.toFixed(2)), scorePercent };
  });
  const vetoRuleIds = result.rules.filter(rule => rule.kind === 'veto' && rule.status === 'fail').map(rule => rule.ruleId);
  const limitedRules = result.rules.filter(rule => rule.hasEvidenceLimits);
  const externalPenalty = result.rules.filter(rule => rule.kind === 'external_penalty').reduce((sum, rule) => sum + rule.deductionPoints, 0);
  const confirmedDeductions = modules.reduce((sum, module) => sum + module.deductionPoints, 0) + externalPenalty;
  const verifiedEarnedPoints = modules.reduce((sum, module) => sum + module.earnedPoints, 0);
  assert(vetoRuleIds.length || modules.every(module => module.evaluatedPoints > 0), '模块可评价满分为0，无法按60/40权重计分；不将缺证据当作零分或满分');
  const unroundedScore = vetoRuleIds.length ? 0 : Math.max(0, modules.reduce((sum, module) => sum + module.weightedScore, 0) - externalPenalty);
  const finalScore = Number(unroundedScore.toFixed(2));
  const isGradeEligible = true;
  const summary = summarizeScores(result.rules);
  result.totals = {
    ...result.totals, modules, summary, evaluatedPoints: summary.evaluatedPoints,
    finalScore, unroundedScore, grade: unroundedScore >= 90 ? 'S' : unroundedScore >= 80 ? 'A' : unroundedScore >= 70 ? 'B' : unroundedScore >= 60 ? 'C' : 'D',
    isGradeEligible, verifiedEarnedPoints,
    scoreUpperBound: null,
    scoreLabel: vetoRuleIds.length ? '确认否决得分' : '可评价部分加权得分',
    hasConfirmedVeto: vetoRuleIds.length > 0, vetoRuleIds, pendingVetoCount: 0, hasPendingRules: false,
    hasEvidenceLimits: limitedRules.length > 0, evidenceLimitedRuleCount: limitedRules.length,
    evidenceLimitedVetoCount: limitedRules.filter(rule => rule.kind === 'veto').length,
    confirmedDeductions, externalPenalty, scoreBasis: SCORE_BASIS.id,
  };
  result.auditConclusion = { status: 'completed', scoreBasis: SCORE_BASIS, isAllEvidenceVerified: limitedRules.length === 0, completedChecks: result.rules.length, verifiedRuleCount: result.rules.length - limitedRules.length };
  result.diagnostics.dataGaps = limitedRules.map(rule => ({ ruleId: rule.ruleId, name: rule.name, maxPoints: rule.maxPoints, excludedPoints: rule.excludedPoints, kind: rule.kind, reason: rule.reason, checks: rule.checks, evidenceDetails: rule.evidenceDetails }));
  result.diagnostics.confirmedIssues = result.rules.flatMap(rule => (rule.confirmedIssues ?? []).map(issue => ({ ruleId: rule.ruleId, ...issue })));
  return result;
}
