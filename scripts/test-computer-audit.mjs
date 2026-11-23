// npm run build && node --test scripts/test-computer-audit.mjs (no network/model/database)
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { ValidationPipe } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { CreateComputerAuditDto } = require('../dist/open-api/computer-audit/computer-audit.dto');
const { ComputerAuditService } = require('../dist/open-api/computer-audit/computer-audit.service');
const { AutomotiveAuditLockService } = require('../dist/open-api/automotive-audit/automotive-audit-lock.service');
const { ComputerAuditRunner } = require('../dist/open-api/computer-audit/computer-audit.runner');
const { ComputerMcpClient } = require('../dist/open-api/computer-audit/computer-mcp.client');
const { AutomotiveAuditService } = require('../dist/open-api/automotive-audit/automotive-audit.service');
const kernel = require('../dist/open-api/computer-audit/computer-audit.kernel');
const { AUDIT_BOARD_CONTRACT } = require('../dist/asin-audit/rules/board-contract');
const axios = require('axios').default;
globalThis.fetch = async () => { throw new Error('禁止联网'); };
axios.request = async () => { throw new Error('禁止联网'); };
const config = new ConfigService({ AI_GATEWAY_API_KEY: 'test', SIF_API_KEY: 'test' });
const input = { asin: 'B0BZJWSLDW', referenceData: { configurations: [{ ramGb: 32, storageGb: 1024 }] } };
const evidence = { asin: input.asin, country: 'US', market: 'amazon_us', A: { filled: true, title: 'HP Laptop 32GB RAM 1TB SSD', bullets: ['16GB RAM'], description: '' }, B: { filled: false }, P: { filled: false }, C: { filled: false }, D: { filled: false }, E: { filled: false }, meta: { fetchedAt: '2026-10-21T00:00:00Z', sources: {} } };
const consistency = { hasContradiction: false, summary: 'fixture', contradictions: [], checkedSources: [], missingSources: [] };
const fullScore = () => kernel.finalizeComputerScore({ boards: AUDIT_BOARD_CONTRACT.map(board => ({ ...board, items: board.items.map(item => ({ ...item, status: 'verified', score: item.maxScore, deductions: [] })) })) }, evidence);
const resultFor = (score, review, opt = {}) => kernel.buildComputerResult(evidence, score, opt, consistency, review, [], 'fixture');

test('未决请求只复用显式关联同一请求的人工回执，缺失或损坏时不发起爬取', async () => {
  const taskId = 1363;
  const request = { url: 'https://example.invalid/audit', method: 'POST', body: { url: 'fixture' } };
  const requestKey = kernel.hashComputerValue({ provider: 'CRAWLER', request });
  const original = { id: 10, requestKey, state: 'SUBMITTING' };
  const runner = Object.create(ComputerAuditRunner.prototype);
  let replacement;
  runner.prisma = { asinAuditCrawlSnapshot: { findFirst: async ({ where }) => {
    assert.equal(where.taskId, taskId);
    if (where.requestKey === requestKey) return original;
    assert.equal(where.state, 'RECEIVED');
    assert.equal(where.AND[0].request.equals, original.id);
    return replacement;
  } } };
  const read = () => runner._http(taskId, async () => assert.fail('尝试发起爬取'), 'CRAWLER',
    request.url, request.method, request.body, {}, true);
  await assert.rejects(read(), { code: 'CRAWLER_OUTCOME_UNKNOWN' });
  const snapshotId = 'manual-receipt';
  replacement = { snapshotId, state: 'RECEIVED', httpStatus: 200, rawResponse: 'saved',
    responseHash: createHash('sha256').update('saved').digest('hex'),
    requestKey: kernel.hashComputerValue({ originalKey: requestKey, attempt: snapshotId }), request };
  assert.equal((await read()).snapshotId, snapshotId);
  replacement.request = { ...request, body: { url: 'wrong' } };
  await assert.rejects(read(), { code: 'AUDIT_CACHE_MISMATCH' });
  replacement.request = request;
  replacement.rawResponse = 'damaged';
  await assert.rejects(read(), { code: 'AUDIT_CACHE_MISMATCH' });
});

test('恢复竞品回执复用原工具名，不联网发现工具；请求指纹不一致时停止', async () => {
  const url = 'https://mcp.example.invalid';
  const request = { name: 'asin_competitor_v2', arguments: { marketplace: 'US', asin: input.asin, size: 10 }, url };
  const row = { request, requestKey: kernel.hashComputerValue({ provider: 'MCP', request }) };
  const runner = Object.create(ComputerAuditRunner.prototype);
  runner.prisma = { asinAuditCrawlSnapshot: { findFirst: async ({ where }) => {
    assert.deepEqual(where, { taskId: 1362, provider: 'MCP' });
    return row;
  } } };
  const toolName = await runner._getRecordedCompetitorTool(1362, input.asin, url);
  const mcp = new ComputerMcpClient(config, async (lookup) => {
    assert.deepEqual({ ...lookup, url }, request);
    return { content: [{ type: 'text', text: JSON.stringify({ data: [{ asin: input.asin }] }) }] };
  }, toolName);
  mcp._getClient = () => assert.fail('命中回执仍连接 MCP');
  assert.deepEqual((await mcp.callAsinCompetitor(input.asin, 'US')).items, [{ asin: input.asin }]);
  row.requestKey = 'invalid';
  await assert.rejects(runner._getRecordedCompetitorTool(1362, input.asin, url), { code: 'AUDIT_CACHE_MISMATCH' });
});

test('新生成优化保留release的标题亮点及站点语言校验，不放宽到历史回执口径', () => {
  const score = fullScore();
  const listing = { title: 'HP Laptop', longTitle: 'HP Laptop with 32GB RAM and 1TB SSD', itemHighlights: ['32GB RAM'], bullets: ['1TB SSD'], description: 'Laptop', searchTerms: [], qaCandidates: [] };
  assert.throws(() => kernel.finalizeComputerOptimization(JSON.stringify({ listing: { ...listing, longTitle: undefined } }), evidence, score), /缺少短标题/);
  assert.throws(() => kernel.finalizeComputerOptimization(JSON.stringify({ listing: { ...listing, itemHighlights: ['中文亮点'] } }), evidence, score), /站点语言/);
  const result = kernel.finalizeComputerOptimization(JSON.stringify({ listing, improvementPriorities: [{ title: '补充信息', action: '完善说明（扣2分）' }] }), evidence, score);
  assert.equal(result.listing.longTitle, listing.longTitle);
  assert(!/扣2分/.test(JSON.stringify(result)));
});

test('DTO仅要求ASIN与合法内存/硬盘组合，非法嵌套/空数组/字符串数字拒绝', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const check = value => pipe.transform(value, { type: 'body', metatype: CreateComputerAuditDto });
  const valid = await check({ ...input, asin: ' b0bzjwsldw ', country: 'UK', clientRequestId: 'unused' });
  assert.equal(valid.asin, input.asin); assert.equal(valid.country, undefined);
  for (const ref of [null, [], {}, { configurations: [] }, { configurations: [null] }, { configurations: [{ ramGb: '32', storageGb: 1024 }] }, { configurations: [{ ramGb: 32, storageGb: 0 }] }, { configurations: [{ ramGb: 32 }] }]) await assert.rejects(check({ ...input, referenceData: ref }));
});

test('配置按完整组合比较；TB换算；显存/升级上限不误认当前内存', () => {
  assert.equal(kernel.getConfigurationReview(input, '32GB RAM 1TB SSD', '').status, 'MATCH');
  const mismatch = kernel.getConfigurationReview(input, '64GB RAM 8TB SSD', '');
  assert.equal(mismatch.status, 'MISMATCH'); assert.equal(mismatch.differences.length, 2);
  const multiple = { ...input, referenceData: { configurations: [{ ramGb: 32, storageGb: 1024 }, { ramGb: 64, storageGb: 2048 }] } };
  assert.equal(kernel.getConfigurationReview(multiple, '32GB RAM 2TB SSD', '').hasPairMismatch, true);
  const partial = kernel.getConfigurationReview(input, '64GB RAM', '');
  assert.equal(partial.status, 'MISMATCH'); assert.equal(partial.dataGaps.length, 1);
  assert.equal(kernel.getConfigurationReview(input, '8GB GDDR6 VRAM', '').status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(kernel.getConfigurationReview(input, '32GB RAM (upgradeable up to 64GB) 1TB SSD', '').status, 'MATCH');
});

test('矛盾引用必须来自对应标题及正文，不接受编造或拼接', () => {
  const value = { hasContradiction: true, reason: '内存冲突', contradictions: [{ field: 'bullets', titleQuote: '32GB RAM', contentQuote: '16GB RAM', explanation: '容量不一致' }] };
  assert.equal(kernel.validateComputerConsistency(value, evidence).contradictions.length, 1);
  assert.throws(() => kernel.validateComputerConsistency({ ...value, contradictions: [{ ...value.contradictions[0], contentQuote: '8GB RAM' }] }, evidence));
  assert.throws(() => kernel.validateComputerConsistency({ ...value, hasContradiction: false }, evidence));
});

test('F2未取得不同于空值；已确认配置冲突在F1部分证据缺失时仍扣分', () => {
  const score = fullScore();
  assert.equal(score.boards[5].items[1].status, 'pending');
  const f1 = score.boards[5].items[0]; f1.status = 'pending'; f1.score = null; f1.pendingReason = '缺部分核心事实';
  const result = resultFor(score, kernel.getConfigurationReview(input, '64GB RAM 8TB SSD', ''));
  const evaluated = result.listing.boards[5].items[0];
  assert.equal(evaluated.evaluatedMaxScore, 4); assert.equal(evaluated.evaluatedEarnedScore, 0);
  assert.equal(result.listing.deductions.reduce((s,d) => s + d.points, 0), 4);
  assert.equal(result.listing.dataGaps.find(g => g.ruleId === 'F1').excludedPoints, 8);
  assert.equal(result.listing.score, Math.round(result.listing.scoring.earnedScore / result.listing.scoring.evidenceMax * 10000) / 100);
});

test('优化建议移除分值字段和得扣分标注，保留容量、行动与业务指标', () => {
  const result = resultFor(fullScore(), kernel.getConfigurationReview(input, '32GB RAM 1TB SSD', ''), { improvementPriorities: [{ score: 2, reason: '补充端口（扣2分）', action: '添加32GB RAM（建议得分 2/5）' }], keywordTiers: [] });
  const json = JSON.stringify([result.listing.optimization, result.keywordTraffic.optimization]);
  assert(!/扣\s*\d|得分|"deducted"|"maxScore"|"score"/.test(json), json);
  assert(json.includes('32GB RAM'));
});

test('正确配置匹配标题仍可发现属性冲突；RAM确认矛盾按F1扣2而非1，不影响升级上限', () => {
  const e = structuredClone(evidence);
  e.P = { filled: true, groups: [{ name: 'Memory', fields: [{ k: 'RAM Size', v: '8 GB' }, { k: 'Ram Memory Maximum Size', v: '64 GB' }] }] };
  const score = fullScore(); const f1 = score.boards[5].items[0];
  f1.score = 9; f1.deductions = [{ reason: 'RAM属性冲突', points: 1 }, { reason: 'CPU属性冲突', points: 2 }];
  const review = kernel.getConfigurationReview(input, '32GB RAM 1TB SSD', '');
  assert.equal(review.status, 'MATCH');
  const result = kernel.buildComputerResult(e, score, {}, consistency, review, [], 'fixture');
  const row = result.listing.boards[5].items[0];
  assert.equal(row.score, 8); assert.deepEqual(row.deductions.map(d => d.points), [2, 2]);
  assert.equal(result.configurationReview.status, 'MATCH');
});

test('两类权限独立，查询使用任务所属类型，跨接入方404', async () => {
  const app = { appId: 'computer', status: 'ACTIVE', isComputerAuditEnabled: true, isAutomotiveAuditEnabled: false };
  let created;
  const computer = new ComputerAuditService({ asinAuditTask: { create: async args => (created = args.data) } }, config, { resolveOwner: async () => null });
  await computer.create(app, input); assert.equal(created.auditType, 'COMPUTER'); assert.deepEqual(created.payload.create.input, input);
  await assert.rejects(computer.create({ ...app, isComputerAuditEnabled: false, isAutomotiveAuditEnabled: true }, input), /电脑/);
  let type = 'COMPUTER';
  const shared = new AutomotiveAuditService({ asinAuditTask: { findFirst: async ({ where }) => where.appId === 'computer' ? { auditType: type, sku: '', payload: { result: { ok: true } } } : null } }, config, { resolveOwner: async () => null });
  assert.equal((await shared.get(app, 'task')).sku, undefined);
  await assert.rejects(shared.get({ ...app, appId: 'other' }, 'task'), /不存在/);
  type = 'AUTOMOTIVE'; await assert.rejects(shared.get(app, 'task'), /汽配/);
});

test('爬虫原始回执持久化后再解析；重复取证仅用缓存；不记录凭证', async () => {
  const rows = []; let calls = 0;
  const db = { asinAuditCrawlSnapshot: {
    findFirst: async ({ where }) => rows.find(r => r.taskId === where.taskId && r.requestKey === where.requestKey),
    create: async ({ data }) => { const row = { ...data, id: 1, state: 'SUBMITTING' }; rows.push(row); return row; },
    update: async ({ data }) => Object.assign(rows[0], data),
  } };
  axios.request = async () => { calls++; return { status: 500, data: 'full error response\n' }; };
  const runner = new ComputerAuditRunner(db, config, {}, {});
  const args = [1, async () => {}, 'CRAWLER', 'http://example.invalid/audit', 'POST', { url: 'product' }, { Authorization: 'secret' }];
  assert.equal((await runner._http(...args)).status, 500);
  await runner._http(...args); assert.equal(calls, 1);
  assert.equal(rows[0].responseHash, createHash('sha256').update(rows[0].rawResponse).digest('hex'));
  assert(!JSON.stringify(rows).includes('secret'));
  rows[0].state = 'UNKNOWN'; await assert.rejects(runner._http(...args), /不自动重发/);
  assert.equal(calls, 1);
});

test('已完成模型阶段可重放且不调用模型；未知阶段禁止自动重发', async () => {
  let calls = 0;
  const request = { system: 'sys', user: 'user' }; const model = 'fixture';
  const phase = { state: 'COMPLETED', inputHash: kernel.hashComputerValue({ model, request, version: kernel.COMPUTER_RULE_VERSION }), content: '{"ok":true}' };
  const runner = new ComputerAuditRunner({}, config, { streamChat() { calls++; throw new Error(); } }, {});
  assert.deepEqual(await runner._phase({ id: 1 }, { score: phase }, 'score', model, request, JSON.parse, async () => {}), { ok: true });
  phase.state = 'SUBMITTING'; await assert.rejects(runner._phase({ id: 1 }, { score: phase }, 'score', model, request, JSON.parse, async () => {}), /不自动重新调用/);
  assert.equal(calls, 0);
});

test('Token为空仍沿用项目Authorization传输；明确缺货不调用模型或流量接口', async () => {
  const rows = []; const taskUpdates = []; let calls = 0;
  const db = {
    openApiApp: { findUnique: async () => ({ status: 'ACTIVE', isComputerAuditEnabled: true }) },
    asinAuditTask: { update: async ({data}) => { taskUpdates.push(data); return {}; } },
    asinAuditTaskPayload: { update: async () => ({}) },
    asinAuditCrawlSnapshot: {
      findFirst: async () => null,
      create: async ({data}) => { const row = { ...data,id:1 }; rows.push(row); return row; },
      update: async ({data}) => Object.assign(rows[0],data),
    },
    $transaction: async promises => Promise.all(promises),
  };
  axios.request = async options => {
    calls++; assert.equal(options.headers.Authorization, 'Bearer ');
    return {status:200,data:JSON.stringify({code:200,data:{productId:input.asin,title:'HP 32GB RAM 1TB SSD',sold_out:true}})};
  };
  const runner = new ComputerAuditRunner(db, new ConfigService({}), { streamChat(){ throw new Error('不得调用模型'); } }, new AutomotiveAuditLockService(config));
  await runner._run({id:1,taskId:'fixture',asin:input.asin,appId:'test',stage:'QUEUED',createdAt:new Date(),payload:{input,config:{ruleVersion:kernel.COMPUTER_RULE_VERSION,gatewayBaseUrl:'https://ai-gateway-api-dev.zhilingtech.com/v1',crawlerBaseUrl:'http://example.invalid'}}},async()=>{});
  assert.equal(calls,1); assert.equal(taskUpdates.at(-1).status,'COMPLETED');
  assert.equal(taskUpdates.at(-1).listingScore,null);
});

test('空词池不能被模型标成零分或满分，保留独立的BSR证据', () => {
  const { adaptKeywordTrafficD } = require('../dist/asin-audit/evidence/adapters');
  const { formatTrafficPrecompute, buildAuditEvidenceCards } = require('../dist/asin-audit/prompts/asin-audit-prompt-format');
  const e = structuredClone(evidence);
  e.D = adaptKeywordTrafficD({ list: [], total: 0 }, []);
  assert.equal(e.D.filled, false);
  assert.match(e.D.missingReason, /未返回/);
  e.D.trafficPrecompute.bsrTrend = { available: true, tier: { score: 4.75, max: 8, label: '缓存BSR保持率59.4%' }, windowDays: 14, validDays: 14, prev7AvgBsr: 18542.14, last7AvgBsr: 31215.29, retainedPct: 59.4, declinedDays: 3 };
  const raw = { boards: AUDIT_BOARD_CONTRACT.map(board => ({ ...board, items: board.items.map(item => ({ ...item, status: 'verified', score: item.maxScore, deductions: [] })) })) };
  const g1 = raw.boards.flatMap(b => b.items).find(i => i.id === 'G1');
  g1.score = 0; g1.deductions = [{ reason: '0词上首页', points: 8 }];
  const score = kernel.finalizeComputerScore(raw, e);
  for (const id of ['G1','G3','J2']) {
    const item = score.boards.flatMap(b => b.items).find(i => i.id === id);
    assert.equal(item.status, 'pending'); assert.equal(item.score, null); assert.deepEqual(item.deductions, []);
  }
  const formatted = formatTrafficPrecompute(e.D);
  assert.match(formatted, /59.4%/); assert(!formatted.includes('建议得分 3/3'));
  assert.match(buildAuditEvidenceCards(e), /59.4%/);
});

test('流量建议按最终评分状态生成，缺证据不正常、J2不固定待核、建议无分值', () => {
  const { buildTrafficSuggestionsFromScore, buildTrafficSuggestionsFromPrecompute } = require('../dist/asin-audit/rules/traffic-suggestions');
  const { adaptKeywordTrafficD } = require('../dist/asin-audit/evidence/adapters');
  const pc = adaptKeywordTrafficD({ list: [], total: 0 }, []).trafficPrecompute;
  const pending = { id: 'G3', name: '机会词', status: 'pending', score: null, maxScore: 6, pendingReason: '缺需求权重', deductions: [] };
  const j2 = { id: 'J2', name: '韧性', status: 'verified', score: 4, maxScore: 6, deductions: [{ reason: '词族曝光集中（扣2分）', points: 2 }] };
  const suggestions = buildTrafficSuggestionsFromScore([pending,j2], pc);
  assert.equal(suggestions[0].level, 'pending'); assert.match(suggestions[0].summary, /缺需求权重/);
  assert.equal(suggestions[1].level, 'important'); assert.match(suggestions[1].summary, /词族曝光集中/);
  const verified = buildTrafficSuggestionsFromScore([{...j2,score:6,deductions:[]}], pc)[0];
  assert.equal(verified.level,'ok');
  const na = buildTrafficSuggestionsFromScore([{...j2,status:'na',score:null,naReason:'本项不适用'}],pc)[0];
  assert.equal(na.level,'pending'); assert.match(na.summary,/不适用/);
  for (const id of ['G1','G3']) assert.equal(buildTrafficSuggestionsFromPrecompute(pc).find(i=>i.ruleId===id).level,'pending');
  const score = fullScore();
  const result = resultFor(score, kernel.getConfigurationReview(input,'32GB RAM 1TB SSD',''));
  for (const suggestion of result.keywordTraffic.optimization.suggestions) {
    const item = result.keywordTraffic.boards.flatMap(b=>b.items).find(i=>i.id===suggestion.ruleId);
    if (item.status==='pending') assert.equal(suggestion.level,'pending');
  }
  assert(!/扣\s*\d|得分|"deducted"|"maxScore"|"score"/.test(JSON.stringify(result.keywordTraffic.optimization)));
});
test('缓存评分保留完整JSON成员，截断评分项与重复的boards字段均拒绝', () => {
  const { boards } = fullScore();
  const prefix = JSON.stringify({ boards, aiVerdict: '含逗号, 方括号 ] 和引号 " 的原文' }).slice(0,-1);
  for (const tail of [',"suggestions":["未完', ',"suggestions"', ',"suggestions":']) {
    const result = kernel.readComputerScore(prefix + tail, evidence);
    assert.deepEqual(result.missingScoreFields, ['diagnosis','aiSecondary','actionItems','suggestions','severeDefects']);
    assert.equal(result.aiVerdict, '含逗号, 方括号 ] 和引号 " 的原文');
  }
  assert.throws(() => kernel.readComputerScore(prefix + ',"boards":[', evidence));
  assert.throws(() => kernel.readComputerScore(JSON.stringify({ boards: boards.slice(0,-1) }).slice(0,-1), evidence));
  assert.throws(() => kernel.readComputerScore('{"diagnosis":{"boards":' + JSON.stringify(boards), evidence));
  assert.deepEqual(kernel.readComputerScore(JSON.stringify({ boards }), evidence), kernel.finalizeComputerScore({ boards }, evidence));
});

test('精简格式只作用于新请求，保留旧评分提示词', () => {
  const review = kernel.getConfigurationReview(input,'32GB RAM 1TB SSD','');
  const original = kernel.computerScorePrompt(evidence, consistency, review);
  assert.deepEqual(original,kernel.computerScorePrompt(evidence,consistency,review,false));
  const compact = kernel.computerScorePrompt(evidence,consistency,review,true);
  assert.equal(compact.system,original.system);
  assert(compact.user.startsWith(original.user));
  assert.match(compact.user.slice(original.user.length),/24 个计分项/);
});
