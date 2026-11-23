import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeAudit } from '../src/open-api/automotive-audit/kernel/finalize-audit.mjs';
import { toPublicResult } from '../src/open-api/automotive-audit/kernel/index.mjs';

globalThis.fetch = () => { throw new Error('计分测试禁止网络'); };
const evidence = [{ source: 'development', value: 'Plastic' }, { source: 'listing', value: 'Aluminum' }];
const issue = (key = 'attribute:材质', points = 2) => ({ key, message: key, deductionPoints: points, evidence });
const fixture = issues => ({
  diagnostics: {}, rules: [
    { ruleId: 'M1-2.2', name: '属性值准确性', kind: 'scored', dimension: '属性', maxPoints: 4, status: 'unknown', earnedPoints: null, reason: '材质冲突，尺寸/重量缺依据', confirmedIssues: issues, checks: [{ name: '材质', status: 'fail' }, { name: '尺寸', status: 'unknown' }], evidenceDetails: { missingData: [{ data: '尺寸/重量基准' }] } },
    { ruleId: 'M1-3.1', name: '其他CDQ', kind: 'scored', dimension: '标题', maxPoints: 56, earnedPoints: 56, status: 'pass', reason: '有证据' },
    { ruleId: 'M2-2.1.1', name: 'OE', kind: 'scored', dimension: 'OE', maxPoints: 40, earnedPoints: 40, status: 'pass', reason: '有证据' },
  ],
});

test('已确认扣分纳入预算，剩余未知预算剔除；接口、维度、缺口、建议一致', () => {
  const result = finalizeAudit(fixture([issue()]));
  const output = toPublicResult(result, 'cached');
  const rule = output.rules[0];
  assert.equal(rule.status, 'FAIL');
  assert.equal(rule.maxPoints, 4);
  assert.equal(rule.evaluatedPoints, 2);
  assert.equal(rule.excludedPoints, 2);
  assert.equal(rule.earnedPoints, 0);
  assert.equal(rule.deductedPoints, 2);
  assert.equal(rule.hasEvidenceLimits, true);
  assert.equal(rule.isIncludedInScore, true);
  assert.equal(output.summary.score, Number((56 / 58 * 60 + 40).toFixed(2)));
  assert.equal(output.summary.coverageRate, 0.98);
  assert.equal(output.deductions[0].points, 2);
  assert.equal(output.dataGaps[0].excludedPoints, 2);
  assert.equal(output.dimensions[0].evaluatedPoints, 2);
  assert.match(output.optimizationSummary, /attribute:材质/);
  assert.match(output.remarks, /其余2分缺证据剔除/);
});

test('同项相同问题不重复扣分，独立问题按原项满分封顶', () => {
  assert.equal(finalizeAudit(fixture([issue(), issue()])).rules[0].deductionPoints, 2);
  const result = finalizeAudit(fixture([issue(), issue('尺寸'), issue('重量')]));
  assert.equal(result.rules[0].deductionPoints, 4);
  assert.equal(result.rules[0].evaluatedPoints, 4);
  assert.equal(result.rules[0].excludedPoints, 0);
  assert.equal(result.rules[0].hasEvidenceLimits, true);
});

test('没有确认扣分的缺证据项继续剔除，不能变成零分或满分', () => {
  const output = toPublicResult(finalizeAudit(fixture([])), 'cached');
  assert.equal(output.rules[0].status, 'UNVERIFIED');
  assert.equal(output.rules[0].earnedPoints, null);
  assert.equal(output.rules[0].deductedPoints, null);
  assert.equal(output.rules[0].evaluatedPoints, 0);
  assert.equal(output.rules[0].excludedPoints, 4);
  assert.equal(output.deductions.length, 0);
});

test('补齐证据后按全项正常结算，已确认扣分只计算一次', () => {
  const result = fixture([issue()]);
  Object.assign(result.rules[0], { status: 'fail', earnedPoints: 2, reason: '全部核查，材质一处错误' });
  const output = toPublicResult(finalizeAudit(result), 'cached');
  assert.equal(output.rules[0].evaluatedPoints, 4);
  assert.equal(output.rules[0].deductedPoints, 2);
  assert.equal(output.rules[0].hasEvidenceLimits, false);
  assert.equal(output.dataGaps.length, 0);
});

test('重复汇总不二次扣分、不把部分判定变为全项0分', () => {
  const result = finalizeAudit(fixture([issue()]));
  const first = structuredClone(result);
  finalizeAudit(result);
  assert.deepEqual(result, first);
});

test('扣分必须有证据和明确非负分值，一票否决继续优先', () => {
  assert.throws(() => finalizeAudit(fixture([{ ...issue(), evidence: [] }])), /明确分值和证据/);
  assert.throws(() => finalizeAudit(fixture([issue('bad', -1)])), /明确分值和证据/);
  const result = fixture([issue()]);
  result.rules.push({ ruleId: 'M1-1.1', name: '否决', kind: 'veto', status: 'fail', reason: '标题和属性冲突', earnedPoints: null });
  const output = toPublicResult(finalizeAudit(result), 'cached');
  assert.equal(output.summary.score, 0);
  assert.equal(output.summary.grade, 'D');
  assert.equal(output.deductions[0].affectsFinalScore, false);
});
