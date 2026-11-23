// Run after npm run build. Uses real DTOs/guard/controllers/runner and an in-memory DB double.
import 'reflect-metadata';
import test from 'node:test';
import axios from 'axios';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolveUnknownCrawl } from './resolve-automotive-crawl.mjs';
import { createAuditInput, normalizeReference, calculateAudit, buildModelRequest, hashValue, validateModelResponse, toPublicResult, RULE_VERSION } from '../src/open-api/automotive-audit/kernel/index.mjs';
const require = createRequire(import.meta.url);
const crawlerHttp = require('axios').default;
const denyNetwork = async () => { throw new Error('测试禁止真实网络访问'); };
crawlerHttp.post = denyNetwork;
const { AutomotiveAuditService } = require('../dist/open-api/automotive-audit/automotive-audit.service.js');
const { AutomotiveAuditLockService, MissingCrawlerReceipt } = require('../dist/open-api/automotive-audit/automotive-audit-lock.service.js');
const { AutomotiveAuditRunner } = require('../dist/open-api/automotive-audit/automotive-audit.runner.js');
const { AutomotiveAuditController } = require('../dist/open-api/automotive-audit/automotive-audit.controller.js');
const { CreateAutomotiveAuditDto } = require('../dist/open-api/automotive-audit/automotive-audit.dto.js');
const { OpenApiAuthGuard } = require('../dist/open-api/open-api-auth.guard.js');
const { ConfigService } = require('@nestjs/config');
const { ValidationPipe } = require('@nestjs/common');

const config = new ConfigService({ AI_GATEWAY_API_KEY: 'test-key', AI_GATEWAY_BASE_URL: 'https://example.invalid/v1' });
const caller = { appId: 'test-app', appSecret: 'test-secret', status: 'ACTIVE', isAutomotiveAuditEnabled: true };
const input = { asin: 'B000000001', sku: 'test-sku', referenceData: { material: 'Plastic', mainOeNumbers: ['00123-45'], oeNumbers: ['00123-45'], fitmentText: '2020-2022 Honda Civic', productInfo: 'Plastic thermostat for 2020-2022 Honda Civic' } };
const product = { productId: input.asin, url: `https://www.amazon.com/dp/${input.asin}`, title: 'DAFOLOGIA 00123-45 Plastic Thermostat for Honda Civic 2020-2022 1 Pack', bullets: ['Compatible with Honda Civic 2020-2022', 'OE number 00123-45', 'Plastic housing', 'Controls coolant flow', 'Easy installation'], product_information: [['ASIN', input.asin], ['Brand', 'DAFOLOGIA'], ['Material', 'Plastic'], ['OEM Part Number', '00123-45'], ['Product Dimensions', '10 x 8 x 6 cm'], ['Item Weight', '1 kg']], aplus: [], otherImagesUrl: [], extra: { variations: 1 } };
const body = { code: 200, data: product };
const snapshot = { snapshotId: 'crawl_test', responseHash: hashValue(body), fetchedAt: '2026-10-21T00:00:00.000Z' };
const auditInput = () => createAuditInput(input, body, snapshot);
const semanticAnswer = JSON.stringify({ findings: [], bulletCoverage: { material: [], function: [], usage: [] } });
const assertLock = async () => {};
globalThis.fetch = async () => { throw new Error('测试禁止真实网络访问'); };

test('DTO只接受单ASIN和结构化资料，缺失/非法嵌套字段拒绝，保留空ST语义', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const validate = value => pipe.transform(value, { type: 'body', metatype: CreateAutomotiveAuditDto });
  const result = await validate({ ...input, asin: ' b000000001 ', country: 'UK', clientRequestId: 'unused', listingSupplement: { searchTerms: '' } });
  assert.equal(result.asin, input.asin);
  assert.equal(result.country, undefined);
  assert.equal(result.clientRequestId, undefined);
  assert.equal(result.listingSupplement.searchTerms, '');
  for (const invalid of [{ ...input, asin: 'bad' }, { ...input, sku: ' ' }, { ...input, referenceData: null }, { ...input, referenceData: [] }, { ...input, referenceData: { dimensions: { length: 1, width: 2, unit: 'CM' } } }, { ...input, referenceData: { weight: { value: -1, unit: 'KG' } } }]) await assert.rejects(validate(invalid));
});

test('沿用niuniu原始请求体签名；篡改body、过期签名和停用接入方拒绝', async () => {
  const guard = new OpenApiAuthGuard({ openApiApp: { findUnique: async () => caller } });
  const rawBody = Buffer.from(JSON.stringify(input));
  const timestamp = String(Date.now());
  const nonce = 'test-nonce';
  const sign = createHmac('sha256', caller.appSecret).update([caller.appId, timestamp, nonce, createHash('sha256').update(rawBody).digest('hex')].join('\n')).digest('hex');
  const req = { headers: { 'x-app-id': caller.appId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-sign': sign }, rawBody };
  const ctx = request => ({ switchToHttp: () => ({ getRequest: () => request }), getHandler: () => AutomotiveAuditController.prototype.create, getClass: () => AutomotiveAuditController });
  assert.equal(await guard.canActivate(ctx(req)), true);
  await assert.rejects(guard.canActivate(ctx({ ...req, rawBody: Buffer.from('{}') })));
  await assert.rejects(guard.canActivate(ctx({ ...req, headers: { ...req.headers, 'x-timestamp': '1' } })));
  const disabled = new OpenApiAuthGuard({ openApiApp: { findUnique: async () => ({ ...caller, status: 'DISABLED' }) } });
  await assert.rejects(disabled.canActivate(ctx(req)));
});

test('POST持久化任务后返回，GET按appId隔离且不会调用模型；权限独立', async () => {
  let created;
  const db = { asinAuditTask: { create: async query => { created = query.data; return { taskId: query.data.taskId, status: 'QUEUED' }; }, findFirst: async query => query.where.appId === caller.appId ? { taskId: created.taskId, status: 'COMPLETED', payload: { result: { summary: { score: 87 } } } } : null } };
  const service = new AutomotiveAuditService(db, config, { resolveOwner: async () => null });
  const result = await service.create(caller, input);
  assert.match(result.taskId, /^audit_/);
  assert.equal(created.appId, caller.appId);
  assert.equal(created.payload.create.input.sku, input.sku);
  assert.equal((await service.get(caller, result.taskId)).result.score, 87);
  await assert.rejects(service.get({ ...caller, appId: 'other-app' }, result.taskId), /不存在/);
  await assert.rejects(service.create({ ...caller, isAutomotiveAuditEnabled: false, isNiuniuOperationPlanEnabled: true }, input), /未开通/);
});

test('单商品及非首位变体定位；冲突ASIN、重复目标、错误信封拒绝', () => {
  assert.equal(auditInput().productPointer, '/data');
  const other = { ...product, productId: 'B000000002', url: 'https://www.amazon.com/dp/B000000002', product_information: [['ASIN', 'B000000002']] };
  const selected = createAuditInput(input, { code: 200, data: { variant_product_info: [other, product] } }, snapshot);
  assert.equal(selected.productPointer, '/data/variant_product_info/1');
  assert.equal(selected.family.length, 2);
  assert.throws(() => createAuditInput(input, { code: 200, data: { ...product, url: other.url } }, snapshot), /MISMATCH/);
  assert.throws(() => createAuditInput(input, { code: 200, data: { variant_product_info: [product, product] } }, snapshot), /MISMATCH/);
  assert.throws(() => createAuditInput(input, { code: 500, data: product }, snapshot), /INVALID/);
});

test('BSR按原始最后品类判断；标题/属性矛盾直接0分D级', () => {
  const bsr = category => [['Best Sellers Rank', `#10 in Automotive\n#2 in ${category}`]];
  const left = { ...product, extra: { variations: 2 }, product_information: [...product.product_information, ...bsr('Engine Parts')] };
  const right = { ...product, productId: 'B000000002', url: 'https://www.amazon.com/dp/B000000002', product_information: [['ASIN','B000000002'], ...bsr('Transmission Parts')] };
  let result = calculateAudit(createAuditInput(input, { code: 200, data: { variant_product_info: [left, right] } }, snapshot), {});
  assert.equal(result.totals.grade, 'D');
  assert.equal(result.rules.find(rule => rule.ruleId === 'M1-1.2').status, 'fail');
  result = calculateAudit(createAuditInput(input, { code: 200, data: { ...product, title: 'Aluminum Thermostat 00123-45' } }, snapshot), {});
  assert.equal(result.totals.finalScore, 0);
  assert.equal(result.rules.find(rule => rule.ruleId === 'M1-1.1').status, 'fail');
});

test('单位转换、OE前导零、未知ST和明确空ST分别处理；评分缺口不算零分', () => {
  const normalized = normalizeReference({ ...input.referenceData, dimensions: { length: 1, width: 2, height: 3, unit: 'INCH' }, weight: { value: 1, unit: 'LB' } });
  assert.equal(normalized['产品尺寸（CM）'], '2.54 x 5.08 x 7.62 cm');
  assert.equal(normalized['产品重量（KG）'], '0.45359237 kg');
  assert.equal(normalized['主OE'], '00123-45');
  const without = calculateAudit(auditInput(), {});
  const empty = calculateAudit({ ...auditInput(), searchTerms: '' }, {});
  assert.equal(without.rules.find(rule => rule.ruleId === 'M2-2.3.3').status, 'unverified');
  assert.equal(empty.rules.find(rule => rule.ruleId === 'M2-2.3.3').earnedPoints, 0);
  assert.equal(empty.totals.externalPenalty, 0);
  const output = toPublicResult(without, snapshot.snapshotId);
  assert(output.rules.filter(rule => rule.status === 'UNVERIFIED').every(rule => rule.deductedPoints === null && rule.earnedPoints === null));
  assert(output.deductions.every(item => item.points > 0));
  assert.deepEqual(output.vetoItems, []);
});

test('非空ST并入已有语义请求，不新增模型调用，引用必须来自实际ST', () => {
  const task = { ...auditInput(), searchTerms: '00123-45 honda civic thermostat daflogia' };
  assert.match(buildModelRequest(task, 'semantic').content, /submitted:ST/);
  assert.throws(() => validateModelResponse(task, 'semantic', semanticAnswer), /ST/);
  const review = validateModelResponse(task, 'semantic', JSON.stringify({ ...JSON.parse(semanticAnswer), searchTermsStructure: { outcome: 'incomplete', reason: '品牌词不匹配', evidence: [{ ref: 'submitted:ST', quote: task.searchTerms }, { ref: 'listing:/product_information/1/1', quote: 'DAFOLOGIA' }] } }));
  assert.equal(review.searchTermsStructure.outcome, 'incomplete');
});

test('爬虫500完整响应存库；成功快照复用，不重新请求；中断请求不重发', async () => {
  let stored = null, calls = 0;
  const db = { asinAuditCrawlSnapshot: { findFirst: async () => stored, create: async query => (stored = { id: 1, state: 'SUBMITTING', ...query.data }), update: async query => (stored = { ...stored, ...query.data }) } };
  const runner = new AutomotiveAuditRunner(db, config, {});
  crawlerHttp.post = async () => { calls++; return { data: '<html>upstream failure</html>', status: 500 }; };
  try {
    await assert.rejects(runner._crawl({ id: 1, asin: input.asin }, { crawlerBaseUrl: 'http://example.invalid' }, assertLock), /500/);
    assert.equal(stored.rawResponse, '<html>upstream failure</html>');
    assert.equal(stored.httpStatus, 500);
    assert.equal(JSON.stringify(stored.request).includes('Authorization'), false);
    stored = { ...stored, state: 'RECEIVED', httpStatus: 200, rawResponse: JSON.stringify(body) };
    await runner._crawl({ id: 1 }, {}, assertLock);
    assert.equal(calls, 1);
    stored.state = 'SUBMITTING';
    await assert.rejects(runner._crawl({ id: 1 }, {}, assertLock), /禁止自动/);
    assert.equal(stored.state, 'SUBMITTING');
    assert.equal(calls, 1);
  } finally { crawlerHttp.post = denyNetwork; }
});

test('模型原文先存库再校验；成功阶段复用；SUBMITTING不重发；完整响应账单失败可恢复', async () => {
  const history = [];
  let calls = 0;
  const gateway = { async *streamChat() { calls++; yield { type: 'text', content: semanticAnswer }; yield { type: 'usage', usage: { promptTokens: 12, completionTokens: 8 } }; } };
  const runner = new AutomotiveAuditRunner({ asinAuditTaskPayload: { update: async query => history.push(structuredClone(query.data.phases)) } }, config, gateway);
  const phases = {};
  const settings = { model: 'test-model', gatewayBaseUrl: 'https://example.invalid/v1', ruleVersion: 'test' };
  const result = await runner._review(1, auditInput(), 'semantic', [], phases, settings, assertLock);
  assert.equal(result.status, 'success');
  assert(history.some(item => item.semantic.state === 'SUBMITTING'));
  assert(history.some(item => item.semantic.state === 'RECEIVED' && item.semantic.content === semanticAnswer));
  await runner._review(1, auditInput(), 'semantic', [], phases, settings, assertLock);
  assert.equal(calls, 1);
  phases.semantic.state = 'SUBMITTING';
  await assert.rejects(runner._review(1, auditInput(), 'semantic', [], phases, settings, assertLock), /不自动/);
  assert.equal(calls, 1);
  gateway.streamChat = async function* () { calls++; yield { type: 'text', content: semanticAnswer }; throw new Error('billing unavailable'); };
  assert.equal((await runner._review(2, auditInput(), 'semantic', [], {}, settings, assertLock)).status, 'success');
  assert.equal(calls, 2);
});

test('跨实例锁未获得时不启动，异常释放仍断开专用连接，同实例不会重入', async () => {
  let workCalls = 0, disconnected = 0;
  const lock = new AutomotiveAuditLockService(config);
  let isAcquired = false, shouldFailRelease = false;
  lock._createClient = () => ({ $queryRaw: async strings => { const sql = strings.join('?'); if (sql.includes('GET_LOCK')) return [{ acquired: isAcquired ? 1 : 0 }]; if (sql.includes('RELEASE_LOCK') && shouldFailRelease) throw new Error('release failed'); return [{ owned: 1 }]; }, $disconnect: async () => { disconnected++; } });
  await lock.runExclusive(async () => { workCalls++; });
  assert.equal(workCalls, 0);
  assert.equal(disconnected, 1);
  isAcquired = true;
  await lock.runExclusive(async check => { await check(); workCalls++; });
  assert.equal(workCalls, 1);
  assert.equal(disconnected, 2);
  shouldFailRelease = true;
  await assert.rejects(lock.runExclusive(async () => {}), /release failed/);
  assert.equal(disconnected, 3);

});

test('完整任务从爬虫到终态落库，查询返回完整40规则、得分、评级和完成日期', async () => {
  const task = { id: 7, taskId: 'audit_pipeline', appId: caller.appId, asin: input.asin, sku: input.sku, stage: 'WAITING', status: 'QUEUED', payload: { input, phases: {}, config: { model: 'test-model', ruleVersion: RULE_VERSION, registeredBrand: 'DAFOLOGIA', gatewayBaseUrl: 'https://example.invalid/v1', crawlerBaseUrl: 'http://example.invalid' } } };
  let storedSnapshot;
  let modelCalls = 0;
  const db = {
    openApiApp: { findUnique: async () => caller },
    asinAuditTask: { update: async query => Object.assign(task, query.data) },
    asinAuditTaskPayload: { update: async query => { assert.deepEqual(query.select, { id: true }); Object.assign(task.payload, structuredClone(query.data)); return { id: task.id }; } },
    asinAuditCrawlSnapshot: {
      findFirst: async () => storedSnapshot,
      create: async query => (storedSnapshot = { id: 1, ...query.data }),
      update: async query => (storedSnapshot = { ...storedSnapshot, ...query.data }),
    },
    $transaction: async operations => Promise.all(operations),
  };
  const gateway = { async *streamChat(prompt) {
    modelCalls++;
    let answer;
    if (prompt.includes('逐项判定器')) answer = { rules: ['M1-2.5','M1-3.3','M1-3.5','M2-2.2.1'].map(ruleId => ({ ruleId, outcome: 'unknown', reason: '缺少核查基准', evidence: [] })) };
    else if (prompt.includes('titleAttributes')) answer = { images: [], main: { background: 'unknown', productBox: null, hasOverlay: null, reason: '没有图片资源' }, titleAttributes: { outcome: 'unknown', reason: '未取得完整属性', claims: [{ claim: '标题适配车型', status: 'unverified', evidence: [{ ref: 'listing:title', quote: product.title }] }] }, familyNaming: { baseline: '', exceptions: [], reason: '单商品' }, aplusComparison: { outcome: 'unknown', reason: '缺少图片', imageIds: [] } };
    else answer = JSON.parse(semanticAnswer);
    yield { type: 'text', content: JSON.stringify(answer) };
    yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 10 } };
  } };
  const runner = new AutomotiveAuditRunner(db, config, gateway, new AutomotiveAuditLockService(config));
  crawlerHttp.post = async () => ({ data: JSON.stringify(body), status: 200 });
  try {
    await runner._run(task, assertLock);
    assert.equal(task.status, 'COMPLETED', JSON.stringify(task.error));
    assert.equal(task.stage, 'FINISHED');
    assert(task.completedAt instanceof Date);
    assert.equal(task.payload.result.rules.length, 40);
    assert(Number.isFinite(task.score));
    assert(['S','A','B','C','D'].includes(task.grade));
    assert.equal(task.payload.result.summary.score, task.score);
    assert.equal(storedSnapshot.productPointer, '/data');
    assert.equal(storedSnapshot.rawResponse, JSON.stringify(body));
    assert.equal(modelCalls, 3); // No A+ images: no paid A+ review call.
  } finally { crawlerHttp.post = denyNetwork; }
});

test('人工核对旧快照不会重新审计任务', async () => {
  let row = { id: 1, snapshotId: 'crawl_test', state: 'UNKNOWN', updatedAt: new Date(), error: { code: 'timeout' } };
  const store = { asinAuditCrawlSnapshot: { findUnique: async () => row, updateMany: async query => { assert.equal(query.where.state, 'UNKNOWN'); row = { ...row, ...query.data }; return { count: 1 }; } } };
  await assert.rejects(resolveUnknownCrawl(store, 'crawl_test', false), /核实/);
  assert.equal((await resolveUnknownCrawl(store, 'crawl_test', true)).status, 'confirmed_stopped');
  assert.equal(row.error.previousError.code, 'timeout');
  assert.equal((await resolveUnknownCrawl(store, 'crawl_test', true)).status, 'already_confirmed');
});

test('旧单结果不明不会占用爬虫通道；后续任务读缓存或按顺序发送', async () => {
  const lock = new AutomotiveAuditLockService(config);
  const events = [];
  const original = lock.reuseOrRunCrawler(assertLock, async isCacheOnly => {
    if (isCacheOnly) throw new MissingCrawlerReceipt();
    events.push('first');
    throw new Error('断线');
  });
  const next = lock.reuseOrRunCrawler(assertLock, async isCacheOnly => {
    if (isCacheOnly) throw new MissingCrawlerReceipt();
    events.push('next');
    return 'new receipt';
  });
  await assert.rejects(original, /断线/);
  assert.equal(await next, 'new receipt');
  assert.deepEqual(events, ['first', 'next']);
  assert.equal(await lock.reuseOrRunCrawler(assertLock, async isCacheOnly => {
    assert.equal(isCacheOnly, true);
    return 'saved receipt';
  }), 'saved receipt');
});

// Actual Node HTTP transport on the upstream's fetch-blocked port; no external network.
test('真实HTTP传输可访问6666端口并完整保存500原文', async () => {
  const raw = '  {"message":"本地端口回归"}\n';
  let received;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    received = { method: req.method, body: JSON.parse(body) };
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(raw);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(6666, '127.0.0.1', resolve); });
  let stored;
  const db = { asinAuditCrawlSnapshot: { findFirst: async () => null, create: async q => (stored = { id: 1, ...q.data }), update: async q => (stored = { ...stored, ...q.data }) } };
  crawlerHttp.post = axios.create({ proxy: false }).post;
  try {
    await assert.rejects(new AutomotiveAuditRunner(db, config, {})._crawl({ id: 1, asin: input.asin }, { crawlerBaseUrl: 'http://127.0.0.1:6666' }, assertLock), /500/);
    assert.equal(stored.rawResponse, raw);
    assert.equal(stored.state, 'RECEIVED');
    assert.equal(stored.responseHash, createHash('sha256').update(raw).digest('hex'));
    assert.deepEqual(received, { method: 'POST', body: { url: `https://www.amazon.com/dp/${input.asin}` } });
  } finally { crawlerHttp.post = denyNetwork; await new Promise(resolve => server.close(resolve)); }
});


test('长外部调用期间保活；锁丢失后不重取锁且停止后续阶段', async context => {
  let callback, isOwned = true, hasDisconnected = false, acquireCalls = 0, checkCalls = 0;
  const timer = { unref() {} };
  context.mock.method(globalThis, 'setTimeout', fn => { callback = fn; return timer; });
  context.mock.method(globalThis, 'clearTimeout', () => {});
  const lock = new AutomotiveAuditLockService(config);
  lock._createClient = () => ({
    $queryRaw: async strings => {
      const sql = strings.join('?');
      if (sql.includes('GET_LOCK')) { acquireCalls++; return [{ acquired: 1 }]; }
      if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
      checkCalls++; return [{ owned: isOwned ? 1 : 0 }];
    },
    $disconnect: async () => { hasDisconnected = true; },
  });
  await lock.runExclusive(async assertLock => {
    callback(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(checkCalls, 1);
    isOwned = false;
    callback(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(assertLock(), /AUDIT_LOCK_LOST/);
    assert.equal(checkCalls, 2); // Sticky failure, never acquire/check another connection.
  });
  assert.equal(acquireCalls, 1);
  assert.equal(hasDisconnected, true);
});
test('电脑和汽配串行爬取、并行评分，共享优化限额；旧实例和重复tick不能执行同一笔', async () => {
  const lock = new AutomotiveAuditLockService(config);
  const other = new AutomotiveAuditLockService(config);
  let owner = null;
  for (const instance of [lock, other]) {
    instance.runExclusive = async work => {
      if (owner) return;
      owner = instance;
      try { await work(async () => assert.equal(owner, instance)); }
      finally { owner = null; }
    };
  }
  const signal = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const crawlStarted = signal(), releaseCrawl = signal(), firstScore = signal();
  const secondScore = signal(), optimization = signal(), finish = signal();
  const events = [];
  const computer = lock.runJob('audit', 1, async check => {
    await lock.runCrawler(check, async () => {
      events.push('computer:crawl'); crawlStarted.resolve(); await releaseCrawl.promise;
    });
    events.push('computer:score'); firstScore.resolve(); await finish.promise;
  });
  await crawlStarted.promise;
  const car = lock.runJob('audit', 2, async check => {
    await lock.runCrawler(check, async () => events.push('auto:crawl'));
    events.push('auto:score'); secondScore.resolve(); await finish.promise;
  });
  const optimize = lock.runJob('optimization', 1, async () => {
    events.push('optimize'); optimization.resolve(); await finish.promise;
  });
  await optimization.promise;
  assert.deepEqual(events, ['computer:crawl', 'optimize']);
  assert.equal(lock.hasCapacity, true);
  const fourthStarted = signal();
  const fourth = lock.runJob('audit', 3, async () => {
    fourthStarted.resolve();
    await finish.promise;
  });
  await fourthStarted.promise;
  assert.equal(lock.hasCapacity, false);
  await lock.runJob('audit', 4, async () => assert.fail('超过并发上限'));
  await other.runJob('audit', 1, async () => assert.fail('其他实例重复执行'));
  releaseCrawl.resolve();
  await Promise.all([firstScore.promise, secondScore.promise]);
  assert(events.includes('auto:crawl')); // 第一笔评分尚未结束
  finish.resolve();
  await Promise.all([computer, car, optimize, fourth]);
  assert.equal(owner, null);
  const entered = signal(), drain = signal();
  const finalJob = lock.runJob('audit', 3, async () => { entered.resolve(); await drain.promise; });
  await entered.promise;
  await lock.runJob('audit', 3, async () => assert.fail('重复认领'));
  const stopping = lock.onModuleDestroy();
  assert.equal(lock.hasCapacity, false);
  assert.equal(owner, lock);
  drain.resolve();
  await Promise.all([finalJob, stopping]);
  assert.equal(owner, null);
});
test('并发tick按原任务ID取队，跳过在跑ID，入锁后重新读取任务状态', async () => {
  const rows = [1, 2, 3, 4, 5].map(id => ({ id, status: id === 1 ? 'RUNNING' : 'QUEUED' }));
  const lock = new AutomotiveAuditLockService(config);
  lock.runExclusive = work => work(assertLock);
  const db = { asinAuditTask: { findFirst: async ({where}) => rows.find(row =>
    where.status.in.includes(row.status) && (typeof where.id === 'number' ? row.id === where.id : !where.id.notIn.includes(row.id))
  ) } };
  const runner = new AutomotiveAuditRunner(db, config, {}, lock);
  const started = [], releases = new Map();
  runner._run = async task => {
    started.push(task.id);
    await new Promise(done => releases.set(task.id, done));
    task.status = 'COMPLETED';
  };
  const turn = () => new Promise(done => setImmediate(done));
  const workers = [runner.tick(), runner.tick()];
  await turn();
  workers.push(runner.tick()); await turn();
  workers.push(runner.tick()); await turn();
  workers.push(runner.tick()); await turn();
  await runner.tick();
  assert.deepEqual(started, [1, 2, 3, 4]);
  releases.get(2)(); await turn();
  workers.push(runner.tick()); await turn();
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  for (const release of releases.values()) release();
  await Promise.all(workers);
  assert(rows.every(row => row.status === 'COMPLETED'));
});
