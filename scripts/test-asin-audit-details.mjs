// Offline contract tests: build first. No model, crawler or database connection.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHmac, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
const require = createRequire(import.meta.url);
const { buildAuditDetailView } = require('../dist/open-api/asin-audit-detail.presenter');
const { buildAuditResultView } = require('../dist/open-api/asin-audit-result.presenter');
const { AuditDetailQueryDto } = require('../dist/open-api/asin-audit-detail.dto');
const { AutomotiveAuditService } = require('../dist/open-api/automotive-audit/automotive-audit.service');
const { OpenApiAuthGuard } = require('../dist/open-api/open-api-auth.guard');
const { ValidationPipe } = require('@nestjs/common');
globalThis.fetch = async () => { throw Error('禁止调用上游'); };
require('axios').default.request = async () => { throw Error('禁止调用上游'); };
const asin = 'B0BZJWSLDW';
const app = { appId: 'niuniu', status: 'ACTIVE', isComputerAuditEnabled: true, isAutomotiveAuditEnabled: true };
const snapshot = (endpoint, data, provider = 'SIF', body) => ({
  snapshotId: endpoint, provider, state: 'RECEIVED', httpStatus: 200, fetchedAt: '2026-10-23T01:00:00.000Z',
  request: { url: `https://test.invalid/${endpoint}?asin=${asin}&endDate=2026-10-23`, body },
  rawResponse: JSON.stringify({ code: provider === 'SIF' ? 1 : 200, data }),
});
const result = () => ({ ruleVersion: 'test-v1', listing: {
  score: 80, status: 'COMPLETED', scoring: { coverageRate: .5 },
  boards: [{ id: 'F', name: '一致性', items: [{ id: 'F1', name: '配置', status: 'pending', score: null,
    maxScore: 12, evaluatedMaxScore: 4, evaluatedEarnedScore: 2, confirmedDeductedPoints: 2,
    hasEvidenceLimits: true, pendingReason: '材质等未取得，内存已确认冲突', deductions: [{ points: 2, reason: '内存不匹配' }] }] }],
  deductions: [{ boardId: 'F', ruleId: 'F1', name: '配置', points: 2, reason: '内存不匹配' }],
  dataGaps: [{ ruleId: 'F1', reason: '其他参数缺失', excludedPoints: 8, confirmedDeductedPoints: 2 }],
  consistencyCheck: { hasContradiction: false }, optimization: { actions: [{ title: '修正配置（扣2分）', action: '更新为32GB RAM（扣2分）', level: 'P2', apiKey: 'secret' }] },
}, keywordTraffic: { status: 'INSUFFICIENT_EVIDENCE', boards: [{ id: 'G', items: [{ id: 'G1', status: 'pending', score: null, maxScore: 8 }] }], dataGaps: [{ ruleId: 'G1', reason: '没有真实词池' }] },
configurationReview: { status: 'MISMATCH', summary: '32GB与64GB冲突', expectedConfigurations: [{ ramGb: 32, storageGb: 1024 }],
  differences: [{ field: 'ramGb', actualValues: [64], expectedValues: [32], reason: '内存冲突' }], dataGaps: [] },
});
const view = (data = result(), snapshots = [], days = 30, type = 'COMPUTER') => buildAuditDetailView('task-1', type, asin, data, snapshots, days);

test('部分证据不足仍保留确认扣分；配置问题只出一个F1，未知项不生成问题', () => {
  const detail = view();
  assert.equal(detail.issues.length, 1);
  assert.equal(detail.issues[0].ruleCode, 'F1');
  assert.equal(detail.issues[0].priority, 'P0');
  assert.equal(detail.issues[0].deductedPoints, 2);
  assert(detail.issues[0].explanation.includes('内存不匹配'));
  assert.equal(detail.checks[0].status, 'PARTIAL');
  assert.equal(detail.checks[1].status, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(detail.configuration.differences[0].actualValues, [64]);
  assert.deepEqual(detail.configuration.differences[0].expectedValues, [32]);
});

test('问题身份稳定且与报告隔离；无分数重算，无输入修改', () => {
  const stored = result(); const before = structuredClone(stored);
  const simple = buildAuditResultView('COMPUTER', stored);
  const a = view(stored, [], 7); const b = view(stored, [], 30);
  assert.deepEqual(a.issues, b.issues);
  assert.equal(a.scoreScope.isRecalculated, false);
  assert.deepEqual(stored, before);
  assert.deepEqual(buildAuditResultView('COMPUTER', stored), simple);
  assert.notEqual(a.issues[0].issueId, buildAuditDetailView('task-2', 'COMPUTER', asin, stored, []).issues[0].issueId);
});

test('优先级来自规则政策，不从分数或建议level猜测；建议不含扣分', () => {
  const data = result(); data.configurationReview.status = 'MATCH';
  const detail = view(data);
  assert.equal(detail.issues[0].priority, 'P1');
  assert(!JSON.stringify(detail.recommendations).includes('扣2分'));
  assert(!JSON.stringify(detail).includes('secret'));
  assert(detail.recommendations[0].action.includes('32GB'));
});

test('汽配已确认否决才P0，待核否决不冒充命中；缺口和实际扣分分开', () => {
  const data = { rules: [
    { ruleId: 'M1-1.1', kind: 'VETO', status: 'UNVERIFIED', hasEvidenceLimits: true },
    { ruleId: 'M1-1.2', kind: 'VETO', status: 'FAIL', name: '变体违规' },
    { ruleId: 'M1-2.2', kind: 'SCORED', status: 'FAIL', deductedPoints: 2, hasEvidenceLimits: true },
  ], vetoItems: [{ ruleId: 'M1-1.2' }], deductions: [{ ruleId: 'M1-2.2', points: 2 }], dataGaps: [{ ruleId: 'M1-2.2' }] };
  const detail = view(data, [], 30, 'AUTOMOTIVE');
  assert.equal(detail.issues.length, 2);
  assert.equal(detail.issues[0].ruleCode, 'M1-1.2');
  assert.equal(detail.issues[1].missingEvidence[0].domain, 'cdq');
});

test('只有目标ASIN的成功快照可以取证；原始密钥/模型阶段不外泄', () => {
  const good = snapshot('audit', { productId: asin, title: 'target', bullets: ['one', 'two'], priceValue: '969.99', rating: '5.0', reviewCount: '8', otherImagesUrl: [],
    imageUrl: 'https://m.media-amazon.com/images/I/test.jpg?token=secret', extra: { variations: '2' }, apiKey: 'secret' }, 'CRAWLER');
  good.request.headers = { Authorization: 'secret' };
  const wrong = snapshot('audit', { productId: 'B000000000', title: 'wrong' }, 'CRAWLER');
  const detail = view(result(), [wrong, good]);
  assert.equal(detail.listingFacts.data.title.value, 'target');
  assert.equal(detail.listingFacts.data.bulletCount.value, 2);
  assert.equal(detail.listingFacts.data.price.value, 969.99);
  assert.equal(detail.listingFacts.data.rating.value, 5);
  assert.equal(detail.listingFacts.data.reviewCount.value, 8);
  assert.equal(detail.listingFacts.data.variationCount.value, 2);
  assert(!JSON.stringify(detail).includes('secret'));
  assert.equal(view(result(), [wrong]).listingFacts.status, 'INSUFFICIENT_EVIDENCE');
  const failed = { ...good, state: 'FAILED' };
  assert.equal(view(result(), [failed]).listingFacts.status, 'INSUFFICIENT_EVIDENCE');
});

const dates = Array.from({ length: 14 }, (_, index) => `2026-10-${String(index + 10).padStart(2, '0')}`);
test('大小类BSR来自日期对齐序列；完整两期才算环比，缺失与真实0分开', () => {
  const trend = snapshot('asinOpTrafficTrend', { asin, dates, bsr: dates.map((_, i) => i < 7 ? 100 : 50),
    subBsr: { sub: dates.map(() => 10) }, catId: 'main', catIdName: { main: 'Computers', sub: 'Laptops' },
    spScore: dates.map(() => 0), nfScore: dates.map(() => null) });
  const detail = view(result(), [trend], 7);
  const bsr = detail.trends.series.find(s => s.key === 'bsr');
  assert.equal(bsr.comparison.changeRate, -.5); assert.equal(bsr.isComparable, true);
  assert.equal(detail.trends.series.find(s => s.key === 'subBsr:sub').name, 'Laptops');
  assert.equal(detail.trends.series.find(s => s.key === 'spScore').validDays, 7);
  assert.equal(detail.trends.series.find(s => s.key === 'nfScore').validDays, 0);
  const thirty = view(result(), [trend], 30).trends.series[0];
  assert.equal(thirty.isComparable, false); assert.equal(thirty.comparison.changeRate, null);
  assert.equal(thirty.coverageRate, 14 / 30);
});

test('重复日期、数组长度错位和失效排名不能当成有效天数', () => {
  const trend = snapshot('asinOpTrafficTrend', { asin, dates: ['2026-10-23', '2026-10-23', '2026-10-22'], bsr: [1, 2, -1], spScore: [2] });
  const detail = view(result(), [trend], 7);
  assert.equal(detail.trends.series[0].validDays, 0);
  assert.equal(detail.trends.series.find(s => s.key === 'spScore').validDays, 0);
});

test('流量结构只按渠道和总得分共同有效日期计算，不伪造缺失占比', () => {
  const data = { asin, dates, totalScore: dates.map(() => 10) };
  for (const key of ['nfScore', 'spScore', 'recSpScore', 'sbScore', 'sbvScore']) data[key] = dates.map(() => 2);
  const detail = view(result(), [snapshot('asinOpTrafficTrend', data)], 7);
  assert.equal(detail.trends.composition.status, 'AVAILABLE');
  assert.equal(detail.trends.composition.channels[0].share, .2);
  data.totalScore = dates.map(() => 1);
  const inconsistent = view(result(), [snapshot('asinOpTrafficTrend', data)], 7);
  assert.equal(inconsistent.trends.composition.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(inconsistent.trends.composition.channels[0].share, null);
  data.nfScore = dates.map(() => null);
  const missing = view(result(), [snapshot('asinOpTrafficTrend', data)], 7);
  assert.equal(missing.trends.composition.totalScore, null);
  assert.equal(missing.trends.composition.channels[0].share, null);
});

test('空词池不被推荐词补成有证据；不混入竞品词，不伪造经营指标', () => {
  const data = result(); data.keywordTraffic.optimization = { keywordTiers: [{ label: '功能词', keywords: ['laptop'] }] };
  const empty = snapshot('asinKeywordsSimpleGroupByMonthly', { list: [] });
  assert.equal(view(data, [empty]).keywords.status, 'INSUFFICIENT_EVIDENCE');
  const words = snapshot('asinKeywordsSimpleGroupByMonthly', { list: [{ asin: 'OTHER', keyword: 'wrong' }, { asin, keyword: 'laptop', saleNum: 123, clickShared: 2 }] });
  const keywords = view(data, [words]).keywords;
  assert.equal(keywords.observed.length, 1);
  assert.equal(keywords.observed[0].orders, null);
  assert.equal(keywords.recommendations[0].sourceType, 'AUDIT_RECOMMENDATION');
});

test('详情沿用接入方隔离与类目权限；运行中任务不加载原始快照', async () => {
  let reads = 0;
  const task = { taskId: 'task-1', auditType: 'COMPUTER', asin, status: 'COMPLETED', payload: { result: result() }, snapshots: [] };
  const prisma = { asinAuditTask: { findFirst: async ({ where }) => { reads++; return where.appId === app.appId ? task : null; } } };
  const service = new AutomotiveAuditService(prisma, {});
  await assert.rejects(service.getDetails({ ...app, appId: 'other' }, 'task-1'), /不存在/);
  await assert.rejects(service.getDetails({ ...app, isComputerAuditEnabled: false }, 'task-1'), /电脑/);
  const response = await service.getDetails(app, 'task-1');
  assert.equal(response.details.issues[0].priority, 'P0');
  assert.equal(response.result.listing.score, 80);
  task.status = 'RUNNING'; reads = 0;
  assert.equal((await service.getDetails(app, 'task-1')).details, null); assert.equal(reads, 1);
});

test('windowDays仅允许7/14/30，默认不要求新入参', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const parse = value => pipe.transform(value, { type: 'query', metatype: AuditDetailQueryDto });
  assert.equal((await parse({ windowDays: '7' })).windowDays, 7);
  assert.equal((await parse({})).windowDays, undefined);
  for (const value of ['0', '-7', '31', '7.5', '', ['7', '14']]) await assert.rejects(parse({ windowDays: value }));
});

test('详情查询沿用牛牛GET空请求体签名，非法签名拒绝', async () => {
  const credential = { ...app, appSecret: 'fixture-secret' };
  const guard = new OpenApiAuthGuard({ openApiApp: { findUnique: async () => credential } });
  const timestamp = String(Date.now()); const nonce = 'fixture-nonce';
  const sign = createHmac('sha256', credential.appSecret).update(`${app.appId}\n${timestamp}\n${nonce}\n${createHash('sha256').update('').digest('hex')}`).digest('hex');
  const request = { method: 'GET', originalUrl: '/api/open/asin-audit/tasks/task-1/details?windowDays=7', headers: { 'x-app-id': app.appId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-sign': sign } };
  const context = { getHandler: () => function handler(){}, getClass: () => class Handler{}, switchToHttp: () => ({ getRequest: () => request }) };
  assert.equal(await guard.canActivate(context), true);
  request.headers['x-sign'] = 'wrong';
  await assert.rejects(guard.canActivate(context), /签名校验失败/);
});

test('本地Nest真实路由验证：详情200、旧结果不变、签名401、权限403、隔离404、参数400', async () => {
  const { Test } = require('@nestjs/testing');
  const { ConfigService } = require('@nestjs/config');
  const { AsinCostService } = require('../dist/open-api/asin-cost.service');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { AutomotiveAuditController } = require('../dist/open-api/automotive-audit/automotive-audit.controller');
  const { AllExceptionsFilter } = require('../dist/common/filters/http-exception.filter');
  const credential = { ...app, appSecret: 'local-fixture-secret' };
  const task = { taskId: 'task-1', auditType: 'COMPUTER', asin, status: 'COMPLETED', payload: { result: result() }, snapshots: [] };
  const prisma = {
    openApiApp: { findUnique: async ({ where }) => ({ ...credential, appId: where.appId }) },
    asinAuditTask: { findFirst: async ({ where }) => where.appId === app.appId && where.taskId === task.taskId ? task : null },
  };
  const module = await Test.createTestingModule({ controllers: [AutomotiveAuditController], providers: [AutomotiveAuditService, OpenApiAuthGuard,
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: {} }, { provide: AsinCostService, useValue: { resolveOwner: async () => null } }] }).compile();
  const application = module.createNestApplication({ logger: false, rawBody: true });
  application.setGlobalPrefix('api');
  application.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  application.useGlobalFilters(new AllExceptionsFilter({ warn() {}, error() {} }));
  await application.listen(0, '127.0.0.1');
  const port = application.getHttpServer().address().port;
  const get = (suffix, appId = app.appId, hasSignature = true) => new Promise((resolve, reject) => {
    const timestamp = String(Date.now()); const nonce = 'local-nonce';
    const sign = createHmac('sha256', credential.appSecret).update(`${appId}\n${timestamp}\n${nonce}\n${createHash('sha256').update('').digest('hex')}`).digest('hex');
    const request = httpRequest({ hostname: '127.0.0.1', port, method: 'GET', path: `/api/open/asin-audit/tasks/task-1${suffix}`,
      headers: hasSignature ? { 'x-app-id': appId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-sign': sign } : {} }, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', part => { raw += part; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
    }); request.on('error', reject); request.end();
  });
  try {
    const before = await get(''); const details = await get('/details?windowDays=7'); const after = await get('');
    assert.equal(details.status, 200); assert.equal(details.body.details.trends.windowDays, 7);
    assert.deepEqual(before, after); assert.deepEqual(details.body.result, before.body.result);
    assert.equal((await get('/details', app.appId, false)).status, 401);
    assert.equal((await get('/details', 'another-app')).status, 404);
    assert.equal((await get('/details?windowDays=8')).status, 400);
    credential.isComputerAuditEnabled = false;
    assert.equal((await get('/details')).status, 403);
  } finally { await application.close(); }
});
