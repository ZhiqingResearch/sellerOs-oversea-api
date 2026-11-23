const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { start, webUrl, artifactsDir } = require('./runtime.cjs');

const original = {
  platform: 'amazon', mode: 'standard', title: 'TrailCup Bottle 750 ml',
  itemHighlights: ['750 ml capacity', 'Stainless steel', 'Screw lid'],
  bullets: ['750 ml stainless steel water bottle.', 'Double wall vacuum insulation keeps drinks cold for 24 hours and hot for 12 hours.', 'Leak-resistant screw lid with a carry loop.', 'Fits in a backpack side pocket for commuting and hiking.', 'Hand wash only. Includes one bottle and one lid.'],
  description: 'TrailCup is a 750 ml stainless steel water bottle. It has double wall vacuum insulation and a screw lid with a carry loop. Hand wash only.',
  searchTerms: ['water bottle', 'insulated bottle', 'hiking flask'],
  structuredAttributes: [{ name: 'Brand', value: 'TrailCup' }, { name: 'Capacity', value: '750 ml' }, { name: 'Material', value: 'Stainless steel' }, { name: 'Care', value: 'Hand wash only' }],
};

if (process.env.LISTING_TEST_SAMPLE === 'low') { original.title = 'Bottle'; original.bullets = ['A bottle for drinks.']; }

(async () => {
  const runtime = await start();
  try {
    console.log('REAL_BASELINE_SCORING');
    const baseline = await runtime.score(original);
    fs.writeFileSync(path.join(artifactsDir, `real-${process.env.LISTING_TEST_SAMPLE || 'high'}-baseline.json`), JSON.stringify({ original, ...baseline }, null, 2));
    console.log('BASELINE', baseline.report.total, 'suggestions', baseline.report.suggestions.length);
    const history = await runtime.seed(original, baseline.report, 'Real AI quality sample');
    const attemptId = randomUUID();
    const before = await runtime.balance();
    const submitted = await runtime.request(`${webUrl}/api/history/${history.id}/optimize`, { planIndex: 0, attemptId });
    console.log('SUBMITTED', submitted);
    const task = await runtime.wait(attemptId);
    const record = await runtime.prisma.history.findUniqueOrThrow({ where: { id: history.id } });
    const after = await runtime.balance();
    const logs = await runtime.prisma.usageLog.findMany({ where: { userId: runtime.user.id } });
    const steps = await runtime.prisma.listingAiStep.findMany({ where: { listingRunId: task.listingRunId } });
    const plan = record.data.plans[0];
    assert.ok(steps.filter(step => step.operation === 'optimization').length <= 2);
    if (plan.optimization.status === 'ACCEPTED') {
      assert.ok(plan.scoreResult.total >= baseline.report.total);
      assert.equal(before - after, 5);
      assert.deepEqual(logs.map(log => Number(log.credits)).sort((a, b) => a - b), [5]);
    } else {
      assert.deepEqual(plan.result, original);
      assert.equal(before - after, 0);
      assert.equal(logs.length, 0);
    }
    await Promise.all(Array.from({ length: 3 }, () => runtime.request(`${webUrl}/api/history/${history.id}/optimize`, { planIndex: 0, attemptId })));
    assert.equal(await runtime.balance(), after);
    const output = { baseline: baseline.report.total, status: plan.optimization.status, candidate: plan.optimization.candidateScore, charged: before - after, calls: steps.map(step => ({ operation: step.operation, status: step.status, usageLogId: step.usageLogId })), record, logs, steps };
    fs.writeFileSync(path.join(artifactsDir, `real-${process.env.LISTING_TEST_SAMPLE || 'high'}-quality-result.json`), JSON.stringify(output, null, 2));
    console.log('REAL_RESULT', JSON.stringify({ baseline: output.baseline, candidate: output.candidate, status: output.status, charged: output.charged, calls: output.calls }));
  } finally { await new Promise(resolve => setTimeout(resolve, 6500)); await runtime.app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
