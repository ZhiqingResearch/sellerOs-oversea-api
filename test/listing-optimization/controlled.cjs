const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { start, webUrl, artifactsDir } = require('./runtime.cjs');
const baselineResult = { platform: 'amazon', title: 'TrailCup Water Bottle', description: '750 ml stainless steel water bottle for hiking.', bullets: ['750 ml capacity', 'Stainless steel', 'Hand wash only'], searchTerms: [], itemHighlights: [] };
const candidate = { ...baselineResult, title: 'TrailCup Water Bottle 750 ml for Hiking' };
const score = total => ({ total, dimensions: [{ name: '关键词覆盖', weight: 100, maxScore: 100, score: total, criteria: [{ name: '标题语义', maxScore: 100, score: total, description: 'Controlled transport fixture for transaction verification', deductions: [{ points: 100 - total, reason: 'Injected score fixture' }] }] }], suggestions: ['改进标题表达'], potential: '' });
let active;
const gateway = { async *streamChat(_system, _prompt, options) {
  const isScore = options.operationName === 'Listing score';
  active.calls.push(isScore ? 'score' : 'optimization');
  if (active.beforeResponse) await active.beforeResponse(isScore);
  const output = isScore ? active.scores.shift() : active.results.shift();
  if (output instanceof Error) throw output;
  if (output === undefined) throw new Error('Unexpected extra model call');
  yield { type: 'text', content: JSON.stringify(output) };
  const requestId = 'fixture-' + randomUUID();
  yield { type: 'billing', content: '', billing: { costCny: '0.01', currency: 'CNY', model: 'ZQ-Think-Flash', requestId, requestIds: [requestId] } };
} };

(async () => {
  const r = await start(gateway);
  const reports = [];
  const endpoint = id => `${webUrl}/api/history/${id}/optimize`;
  async function check(name, options, expectedStatus, expectedCredits) {
    active = { results: [candidate], scores: [score(91)], calls: [], ...options };
    const history = await r.seed(baselineResult, score(90), name);
    const before = await r.balance();
    const attemptId = randomUUID();
    if (options?.configure) await options.configure(history, attemptId);
    const submit = { planIndex: 0, attemptId };
    await r.request(endpoint(history.id), submit);
    let task = await r.wait(attemptId, 60000);
    if (options?.afterFirst) {
      await options.afterFirst({ history, attemptId, task });
      task = await r.wait(attemptId, 60000);
    }
    const record = await r.prisma.history.findUniqueOrThrow({ where: { id: history.id } });
    const after = await r.balance();
    const plan = record.data.plans[0];
    assert.equal(plan.optimization.status, expectedStatus, name);
    assert.equal(before - after, expectedCredits, name);
    const logs = await r.prisma.usageLog.findMany({ where: { userId: r.user.id, meta: { path: '$.listingHistoryId', equals: history.id } } });
    assert.deepEqual(logs.map(log => Number(log.credits)).sort((a, b) => a - b), expectedCredits ? [5] : [], name);
    const debits = await r.prisma.creditTransaction.findMany({ where: { userId: r.user.id, direction: 'DEBIT', meta: { path: '$.listingHistoryId', equals: history.id } } });
    assert.equal(debits.reduce((sum, row) => sum + Number(row.amount), 0), expectedCredits, name);
    if (expectedStatus !== 'ACCEPTED' && expectedStatus !== 'STALE') assert.deepEqual(plan.result, baselineResult, name);
    const modelCalls = active.calls.length;
    await Promise.all(Array.from({ length: 4 }, () => r.request(endpoint(history.id), submit)));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await r.balance(), after, name + ' replay charge');
    assert.equal(active.calls.length, modelCalls, name + ' replay model calls');
    reports.push({ name, status: expectedStatus, credits: before - after, usageCredits: logs.map(log => Number(log.credits)), ledgerCredits: debits.map(log => Number(log.amount)), calls: [...active.calls] });
    console.log('PASS', JSON.stringify(reports.at(-1)));
    return { history, attemptId, task };
  }
  try {
    await check('accepted_5_and_replay', {}, 'ACCEPTED', 5);
    await check('equal_score_meaningful_change', { scores: [score(90)] }, 'ACCEPTED', 5);
    await check('two_rounds_lower_stop_free', { results: [candidate, candidate], scores: [score(80), score(89)] }, 'REJECTED', 0);
    await check('correction_recovers_only_5', { results: [candidate, candidate], scores: [score(80), score(92)] }, 'ACCEPTED', 5);
    await check('unchanged_free', { results: [baselineResult], scores: [score(95)] }, 'UNCHANGED', 0);
    await check('generation_failure_free', { results: [new Error('Injected generation failure')], scores: [] }, 'FAILED', 0);
    await check('score_failure_manual_retry', { scores: [new Error('Injected score failure'), score(94)], afterFirst: async ({ history, attemptId }) => {
      const partial = await r.prisma.history.findUniqueOrThrow({ where: { id: history.id } });
      assert.equal(partial.data.plans[0].optimization.status, 'SCORE_FAILED');
      const beforeRetry = await r.balance();
      const retry = { planIndex: 0, attemptId, retryScore: true, retryRequestId: randomUUID() };
      await r.request(endpoint(history.id), retry);
      await r.request(endpoint(history.id), retry);
      assert.equal(await r.balance(), beforeRetry);
    } }, 'ACCEPTED', 5);
    await check('concurrent_source_edit_free', { configure: async history => {
      active.beforeResponse = async isScore => {
        if (!isScore) await r.prisma.history.update({ where: { id: history.id }, data: { data: { ...history.data, plans: [{ ...history.data.plans[0], result: { ...baselineResult, title: 'User edit during generation' } }] }, version: { increment: 1 } } });
      };
    } }, 'STALE', 0);

    // Real MySQL rollback: fail after the bundled 5-credit charge has written its ledger.
    active = { results: [candidate], scores: [score(93)], calls: [] };
    const history = await r.seed(baselineResult, score(90), 'atomic_charge_write_failure');
    const attemptId = randomUUID();
    const before = await r.balance();
    const originalCharge = r.ai.chargeSavedOutput.bind(r.ai);
    let hasInjectedFailure = false;
    let shouldFail = true;
    r.ai.chargeSavedOutput = async (...args) => {
      const result = await originalCharge(...args);
      if (shouldFail) { hasInjectedFailure = true; throw new Error('Injected failure after charge writes'); }
      return result;
    };
    await r.request(endpoint(history.id), { planIndex: 0, attemptId });
    for (let i = 0; i < 60 && !hasInjectedFailure; i++) await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(hasInjectedFailure);
    assert.equal(await r.balance(), before);
    assert.equal(await r.prisma.usageLog.count({ where: { userId: r.user.id, meta: { path: '$.listingHistoryId', equals: history.id } } }), 0);
    assert.equal(await r.prisma.creditTransaction.count({ where: { userId: r.user.id, direction: 'DEBIT', meta: { path: '$.listingHistoryId', equals: history.id } } }), 0);
    assert.deepEqual((await r.prisma.history.findUniqueOrThrow({ where: { id: history.id } })).data.plans[0].result, baselineResult);
    shouldFail = false;
    await r.wait(attemptId, 30000);
    assert.equal(before - await r.balance(), 5);
    assert.deepEqual(active.calls, ['optimization', 'score']);
    r.ai.chargeSavedOutput = originalCharge;
    reports.push({ name: 'charge_write_rollback_then_resume_without_AI', credits: 5, calls: active.calls, rollbackBalanceUnchanged: true });
    console.log('PASS', JSON.stringify(reports.at(-1)));

    active = { results: [candidate], scores: [score(93)], calls: [] };
    const concurrent = await r.seed(baselineResult, score(90), 'simultaneous_requests');
    const concurrentBefore = await r.balance();
    const concurrentId = randomUUID();
    const submissions = await Promise.allSettled(Array.from({ length: 4 }, () => r.request(endpoint(concurrent.id), { planIndex: 0, attemptId: concurrentId })));
    assert.ok(submissions.some(result => result.status === 'fulfilled'));
    await r.wait(concurrentId, 60000);
    assert.equal(concurrentBefore - await r.balance(), 5);
    assert.equal(await r.prisma.listingGenerationTask.count({ where: { attemptId: concurrentId } }), 1);
    assert.deepEqual(active.calls, ['optimization', 'score']);
    reports.push({ name: 'four_simultaneous_requests_one_task_one_charge', credits: 5, calls: active.calls });
    console.log('PASS', JSON.stringify(reports.at(-1)));

    active = { results: [candidate], scores: [score(92)], calls: [] };
    const compact = await r.seed(baselineResult, score(90), 'compact_B_plan');
    await r.prisma.history.update({ where: { id: compact.id }, data: { data: { ...compact.data, plans: [{ ...compact.data.plans[0], planIndex: 1 }] } } });
    const compactBefore = await r.balance();
    const compactId = randomUUID();
    await r.request(endpoint(compact.id), { planIndex: 1, attemptId: compactId });
    await r.wait(compactId, 60000);
    const compactRecord = await r.prisma.history.findUniqueOrThrow({ where: { id: compact.id } });
    assert.equal(compactRecord.data.plans[0], null);
    assert.equal(compactRecord.data.plans[1].optimization.status, 'ACCEPTED');
    assert.equal(compactRecord.data.plans[1].planIndex, 1);
    assert.equal(compactBefore - await r.balance(), 5);
    reports.push({ name: 'compact_B_correct_plan_only', credits: 5, calls: active.calls });
    console.log('PASS', JSON.stringify(reports.at(-1)));

    // Insufficient funds must stop before any AI invocation.
    const lots = await r.prisma.creditLot.findMany({ where: { userId: r.user.id } });
    for (const lot of lots) await r.prisma.creditLot.update({ where: { id: lot.id }, data: { remaining: 5 } });
    await check('exactly_5_credits_accepted', {}, 'ACCEPTED', 5);
    assert.equal(await r.balance(), 0);
    for (const lot of lots) await r.prisma.creditLot.update({ where: { id: lot.id }, data: { remaining: 4 } });
    const low = await r.seed(baselineResult, score(90), 'insufficient_4');
    const callsBefore = active.calls.length;
    await assert.rejects(() => r.request(endpoint(low.id), { planIndex: 0, attemptId: randomUUID() }), /余额不足/);
    assert.equal(active.calls.length, callsBefore);
    reports.push({ name: '4_credits_rejected_before_AI', credits: 0, calls: 0 });
    console.log('PASS', JSON.stringify(reports.at(-1)));
    fs.writeFileSync(path.join(artifactsDir, 'controlled-results.json'), JSON.stringify(reports, null, 2));
    console.log('CONTROLLED_COMPLETE', reports.length);
  } finally { await new Promise(resolve => setTimeout(resolve, 6500)); await r.app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
