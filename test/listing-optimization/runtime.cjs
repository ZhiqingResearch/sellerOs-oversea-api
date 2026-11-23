require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const { Reflector } = require('@nestjs/core');
const projectRoot = path.resolve(__dirname, '../..');
const load = (file, name) => require(path.join(projectRoot, 'dist', file))[name];
const PrismaService = load('prisma/prisma.service', 'PrismaService');
const AiGatewayProvider = load('common/providers/ai-gateway.provider', 'AiGatewayProvider');
const CreditService = load('membership/credit.service', 'CreditService');
const UsageService = load('usage/usage.service', 'UsageService');
const ListingRunService = load('listing/listing-run.service', 'ListingRunService');
const ListingAiService = load('listing/listing-ai.service', 'ListingAiService');
const ListingGenerationService = load('listing/listing-generation.service', 'ListingGenerationService');
const HistoryService = load('history/history.service', 'HistoryService');
const FeatureRegistryService = load('usage/feature-registry.service', 'FeatureRegistryService');
const TeamPoolService = load('team/team-pool.service', 'TeamPoolService');
const TeamQuotaService = load('team/team-quota.service', 'TeamQuotaService');
const TeamModelConfigService = load('team/team-model-config.service', 'TeamModelConfigService');
const PricingService = load('pricing/pricing.service', 'PricingService');
const JwtStrategy = load('auth/strategies/jwt.strategy', 'JwtStrategy');
const PermissionCacheService = load('auth/services/permission-cache.service', 'PermissionCacheService');
const ListingController = load('listing/listing.controller', 'ListingController');
const HistoryController = load('history/history.controller', 'HistoryController');
const ListingDocumentService = load('listing/listing-document.service', 'ListingDocumentService');
const ListingScoreService = load('listing/listing-score.service', 'ListingScoreService');
const { prepareListingScoreDelivery } = require('../../dist/listing/listing-score-delivery');
const { parseListingScoreSource } = require('../../dist/listing/listing-score-evidence');
const { buildListingScoreSystemPrompt } = require('../../dist/listing/listing-score-prompt');
const frontendRoot = path.resolve(process.env.LISTING_TEST_WEB_ROOT || '');
if (!process.env.LISTING_TEST_WEB_ROOT) throw new Error('Set LISTING_TEST_WEB_ROOT to the frontend feature worktree');
const frontendBundle = path.join(frontendRoot, '.tmp', 'listing-optimization-integration.cjs');
fs.mkdirSync(path.dirname(frontendBundle), { recursive: true });
require(require.resolve('esbuild', { paths: [frontendRoot] })).buildSync({
  absWorkingDir: frontendRoot,
  stdin: { contents: 'export { buildHistoryOptimization } from "./src/server/listing-history-optimization"; export { finalizeSavedListingGeneration } from "./src/server/agents/listing-service"; export { buildGeneratedListingScoreRequest } from "./src/agents/score-agent";', resolveDir: frontendRoot, loader: 'ts' },
  outfile: frontendBundle, bundle: true, platform: 'node', packages: 'external', format: 'cjs', loader: { '.md': 'text' },
});
const frontend = require(frontendBundle);
const webUrl = process.env.LISTING_TEST_WEB_URL || 'http://127.0.0.1:14387';
if (new URL(webUrl).hostname !== '127.0.0.1') throw new Error('Frontend tests must use loopback');
const artifactsDir = path.join(projectRoot, '.tmp', 'listing-optimization-integration');
fs.mkdirSync(artifactsDir, { recursive: true });

async function start(gatewayOverride) {
  const databaseUrl = process.env.LISTING_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Set LISTING_TEST_DATABASE_URL to an isolated local test database');
  const database = new URL(databaseUrl);
  if (database.hostname !== '127.0.0.1' || !/^\/listing_optimization_test(?:_[a-z0-9]+)?$/.test(database.pathname)) throw new Error('Only an isolated loopback listing_optimization_test database is allowed');
  process.env.DATABASE_URL = databaseUrl;
  const env = gatewayOverride ? {} : process.env.LISTING_TEST_GATEWAY_ENV_FILE ? require('dotenv').parse(fs.readFileSync(process.env.LISTING_TEST_GATEWAY_ENV_FILE)) : process.env;
  const config = new ConfigService({ AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY, AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL, AI_GATEWAY_DEBUG_LOGGING: 'false', JWT_SECRET: randomUUID() });
  const prisma = new PrismaService();
  const gateway = new AiGatewayProvider(config);
  const credit = new CreditService(prisma);
  const features = new FeatureRegistryService(prisma);
  await features.onModuleInit();
  const usage = new UsageService(prisma, new PricingService(prisma), credit, new TeamQuotaService(prisma, credit, new TeamPoolService(prisma, credit)), features, new TeamModelConfigService(prisma));
  const runs = new ListingRunService(prisma);
  const ai = new ListingAiService(gatewayOverride ?? gateway, usage, runs);
  const service = new ListingGenerationService(prisma, gatewayOverride ?? gateway, ai, runs);
  const module = await Test.createTestingModule({ controllers: [ListingController, HistoryController], providers: [
    { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
    { provide: ListingRunService, useValue: runs }, { provide: ListingAiService, useValue: ai },
    { provide: ListingGenerationService, useValue: service },
    { provide: HistoryService, useValue: new HistoryService(prisma) },
    { provide: ListingDocumentService, useValue: {} }, { provide: ListingScoreService, useValue: {} },
    PermissionCacheService, JwtStrategy, Reflector,
  ] }).compile();
  const app = module.createNestApplication({ logger: ['error', 'warn'] });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(18015, '127.0.0.1');
  const user = await prisma.user.create({ data: { username: 'Listing optimization isolated test', phone: 'test-' + randomUUID(), password: 'disabled-test-password' } });
  const permission = await prisma.permission.upsert({ where: { key: 'tool.listing_generate' }, create: { key: 'tool.listing_generate', label: '测试Listing', groupCode: 'tool' }, update: {} });
  const role = await prisma.roleModel.create({ data: { name: 'Listing local test', code: randomUUID(), permissions: { create: { permissionId: permission.id } }, users: { create: { userId: user.id } } } });
  await credit.grant(user.id, 'RECHARGE', 1000, { type: 'MANUAL_ADJUST', source: 'isolated-test' });
  const token = new JwtService({ secret: config.get('JWT_SECRET') }).sign({ sub: user.id, phone: user.phone, roleCode: role.code });
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  async function request(url, body) {
    const response = await fetch(url, { headers, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const output = await response.json();
    if (!response.ok) throw new Error(response.status + ': ' + JSON.stringify(output));
    return output;
  }
  async function score(result) {
    const dto = frontend.buildGeneratedListingScoreRequest({ ...result, market: 'amazon_us', category: 'Home & Kitchen', responseLanguage: 'zh-CN' }, 'ZQ-Think-Flash');
    let text = ''; let billing;
    for await (const event of gateway.streamChat(buildListingScoreSystemPrompt(dto.systemPrompt, dto.userPrompt), dto.userPrompt, { model: dto.model, temperature: 0, resolveBilling: true, operationName: 'Listing optimization real integration baseline' })) {
      if (event.type === 'text') text += event.content;
      if (event.billing) billing = event.billing;
    }
    const report = prepareListingScoreDelivery(text, 'amazon_us', { sourceFacts: parseListingScoreSource(dto.userPrompt) });
    if (!report || !billing) throw new Error('Real baseline scoring incomplete');
    return { report: JSON.parse(report), raw: text, billing };
  }
  async function seed(result, report, title = 'Local integration sample') {
    return prisma.history.create({ data: { userId: user.id, type: 'LISTING_GENERATION', title, score: report.total, data: { params: { market: 'amazon_us', keyword: 'insulated water bottle', category: 'Home & Kitchen', model: 'ZQ-Think-Flash' }, plans: [{ planIndex: 0, result, score: report.total, scoreResult: report }] } } });
  }
  async function balance() { return Number((await credit.getWallet(user.id)).total); }
  async function wait(attemptId, timeout = 580000) {
    const deadline = Date.now() + timeout;
    let previous;
    while (Date.now() < deadline) {
      const task = await prisma.listingGenerationTask.findUnique({ where: { attemptId } });
      if (task?.status !== previous) console.log('TASK', attemptId, task?.status);
      previous = task?.status;
      if (task && ['COMPLETED', 'FAILED', 'PARTIAL'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Task timeout');
  }
  return { prisma, app, user, service, ai, gateway, credit, usage, request, seed, score, balance, wait, frontend };
}
module.exports = { start, frontend, webUrl, artifactsDir };
