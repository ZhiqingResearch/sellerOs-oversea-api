import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import "reflect-metadata"
const require = createRequire(import.meta.url)
const { Prisma } = require("@prisma/client")
const {
  AsinOptimizationService,
} = require("../dist/open-api/asin-optimization/asin-optimization.service.js")
const {
  AsinOptimizationRunner,
} = require("../dist/open-api/asin-optimization/asin-optimization.runner.js")
const {
  readOptimization,
  optimizationModules,
  buildOptimizationRequest,
} = require("../dist/open-api/asin-optimization/asin-optimization.kernel.js")
const app = {
  appId: "fixture",
  status: "ACTIVE",
  isComputerAuditEnabled: true,
  isAutomotiveAuditEnabled: true,
}
const draft = {
  listing: {
    title: "Part",
    longTitle: "Replacement Part",
    itemHighlights: ["Plastic"],
    bullets: ["Plastic housing"],
    description: "Replacement housing",
    searchTerms: ["housing"],
    qaCandidates: [{ q: "Material?", a: "Plastic" }],
  },
  imageSellingPoints: [{ type: "detail", name: "Material", description: "Show housing" }],
  aplusModules: [
    {
      name: "Material",
      nameEn: "Material",
      description: "Show dimensions only after confirmation",
    },
  ],
  differentiationUSPs: [{ title: "Material", analysis: "Use verified plastic" }],
  fieldRewrites: [
    { field: "title", original: "Old", rewritten: "Part", reason: "纠正材质（扣2分）" },
  ],
  keywordTiers: [{ tier: "longtail", label: "推荐", keywords: ["plastic housing"] }],
  reviewStrategies: [{ painPoint: "需补证", response: "核对评论", improvement: "如实记录" }],
  launchPhases: [{ name: "检查", timeline: "上线前", goal: "核实", tactics: ["补证"] }],
  improvementPriorities: [
    { level: "P3", title: "补充", impact: "说明完整", effort: "少量", action: "更新材质（扣2分）" },
  ],
}
function setup({
  historical = false,
  status = null,
  response = JSON.stringify(draft),
  fails = false,
} = {}) {
  const task = {
    id: 42,
    taskId: "audit_fixture",
    appId: app.appId,
    auditType: historical ? "COMPUTER" : "AUTOMOTIVE",
    asin: "B0H6K3K54T",
    sku: "SKU",
    marketplace: "US",
    status: "COMPLETED",
    completedAt: new Date(),
    payload: {
      input: { referenceData: { material: "Plastic" } },
      config: { model: "fixture-model" },
      normalizedInput: { product: { title: "Old", bullets: ["Plastic housing"] } },
      result: { rules: [] },
      phases: historical ? { optimize: { state: "COMPLETED", result: draft } } : {},
    },
  }
  let job = status
    ? {
        id: 1,
        optimizationId: "opt_fixture",
        taskId: 42,
        status,
        model: "fixture-model",
        payload: {
          context: { auditType: "AUTOMOTIVE", marketplace: "US" },
          request: { system: "x", user: "x" },
          rawResponse: response,
        },
        task,
      }
    : null
  let modelCalls = 0
  let created = 0
  const db = {
    $queryRaw: async () => [
      { phase: task.payload.phases.optimize ?? {}, score: task.payload.phases.score?.result ?? {} },
    ],
    asinAuditTaskPayload: { findUnique: async () => task.payload },
    asinAuditTask: {
      findFirst: async ({ where }) =>
        where.appId === app.appId && where.taskId === task.taskId
          ? { ...task, optimization: job }
          : null,
    },
    openApiApp: { findUnique: async () => app },
    asinAuditOptimization: {
      findFirst: async () =>
        job && ["QUEUED", "RUNNING", "RECEIVED"].includes(job.status) ? job : null,
      create: async ({ data }) => {
        if (job)
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6",
          })
        created++
        job = { ...data, id: 1, status: "QUEUED", task, payload: data.payload.create }
        return job
      },
      updateMany: async ({ where, data }) => {
        if (!job || job.status !== where.status) return { count: 0 }
        Object.assign(job, data)
        return { count: 1 }
      },
      update: async ({ data }) => {
        const { payload, ...fields } = data
        Object.assign(job, fields)
        if (payload) Object.assign(job.payload, payload.update)
        return job
      },
    },
  }
  const service = new AsinOptimizationService(db, { get: () => "fixture-key" })
  const gateway = {
    async *streamChat() {
      modelCalls++
      yield { type: "text", content: response }
      if (fails) throw new Error("timeout")
    },
  }
  const runner = new AsinOptimizationRunner(db, gateway, {
    hasCapacity: true,
    activeIds: () => [],
    runJob: async (kind, id, work) => work(async () => {}),
  })
  return {
    db,
    service,
    runner,
    task,
    get job() {
      return job
    },
    get calls() {
      return modelCalls
    },
    get created() {
      return created
    },
  }
}

test("历史完整对象白名单读取，缺长标题不挡整份，P3保留且建议无扣分", () => {
  const input = structuredClone(draft)
  delete input.listing.longTitle
  delete input.listing.itemHighlights
  input.internalPrompt = "secret"
  const result = readOptimization(input)
  assert.equal(result.listing.title, "Part")
  assert.equal(result.improvementPriorities[0].level, "P3")
  assert.equal(optimizationModules(result).filter(m => m.status === "MISSING").length, 2)
  assert(!JSON.stringify(result).includes("扣2分"))
  assert(!JSON.stringify(result).includes("secret"))
})

test("优化真实HTTP路由复用HMAC：GET200、POST202、签名401、权限403、跨接入方404", async () => {
  const { Test } = require("@nestjs/testing")
  const { ConfigService } = require("@nestjs/config")
  const { ValidationPipe } = require("@nestjs/common")
  const { PrismaService } = require("../dist/prisma/prisma.service")
  const { OpenApiAuthGuard } = require("../dist/open-api/open-api-auth.guard")
  const {
    AsinOptimizationController,
  } = require("../dist/open-api/asin-optimization/asin-optimization.controller")
  const { AllExceptionsFilter } = require("../dist/common/filters/http-exception.filter")
  const { createHmac, createHash, randomUUID } = require("node:crypto")
  const { request } = require("node:http")
  const fixture = setup({ historical: true })
  const caller = { ...app, appSecret: "fixture-secret" }
  fixture.db.openApiApp.findUnique = async ({ where }) => ({ ...caller, appId: where.appId })
  const module = await Test.createTestingModule({
    controllers: [AsinOptimizationController],
    providers: [
      AsinOptimizationService,
      OpenApiAuthGuard,
      { provide: PrismaService, useValue: fixture.db },
      { provide: ConfigService, useValue: { get: () => "fixture" } },
    ],
  }).compile()
  const server = module.createNestApplication({ logger: false, rawBody: true })
  server.setGlobalPrefix("api")
  server.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  server.useGlobalFilters(new AllExceptionsFilter({ warn() {}, error() {} }))
  await server.listen(0, "127.0.0.1")
  const port = server.getHttpServer().address().port
  const call = (method, appId = app.appId, valid = true) =>
    new Promise((resolve, reject) => {
      const body = method === "POST" ? "{}" : "",
        timestamp = String(Date.now()),
        nonce = randomUUID()
      const sign = createHmac("sha256", caller.appSecret)
        .update(
          [appId, timestamp, nonce, createHash("sha256").update(body).digest("hex")].join("\n")
        )
        .digest("hex")
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: `/api/open/asin-audit/tasks/${fixture.task.taskId}/optimization`,
          headers: {
            "content-type": "application/json",
            "x-app-id": appId,
            "x-timestamp": timestamp,
            "x-nonce": nonce,
            "x-sign": valid ? sign : "bad",
          },
        },
        res => {
          let text = ""
          res.on("data", chunk => {
            text += chunk
          })
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
        }
      )
      req.on("error", reject)
      req.end(body)
    })
  try {
    assert.equal((await call("GET")).status, 200)
    const post = await call("POST")
    assert.equal(post.status, 202)
    assert.equal(post.body.status, "COMPLETED")
    assert.equal((await call("POST", app.appId, false)).status, 401)
    assert.equal((await call("GET", "other")).status, 404)
    caller.isComputerAuditEnabled = false
    assert.equal((await call("GET")).status, 403)
    assert.equal(fixture.calls, 0)
    assert.equal(fixture.created, 0)
  } finally {
    await server.close()
  }
})
test("已有稿GET和POST都直接复用，不创建执行、不调用模型", async () => {
  const s = setup({ historical: true })
  const get = await s.service.get(app, s.task.taskId)
  const post = await s.service.create(app, s.task.taskId)
  assert.equal(get.source, "AUDIT_OPTIMIZE_PHASE")
  assert.equal(get.contentStatus, "COMPLETE")
  assert.equal(get.generatedAt, null)
  assert.deepEqual(get, post)
  assert.equal(s.created, 0)
  assert.equal(s.calls, 0)
})
test("同一taskId并发提交只建一条执行，完整生成后读回，重复POST不生成", async () => {
  const s = setup()
  const replies = await Promise.all([
    s.service.create(app, s.task.taskId),
    s.service.create(app, s.task.taskId),
  ])
  assert.equal(s.created, 1)
  assert.equal(replies[0].optimizationId, replies[1].optimizationId)
  await s.runner.tick()
  await s.runner.tick()
  const result = await s.service.create(app, s.task.taskId)
  assert.equal(result.status, "COMPLETED")
  assert.equal(result.contentStatus, "COMPLETE")
  assert(result.generatedAt)
  assert.equal(s.calls, 1)
  assert.equal(s.task.payload.result.rules.length, 0)
})
test("超时即UNKNOWN，即使收到可解析JSON也不冒充完成，不再次调用", async () => {
  const s = setup({ fails: true })
  await s.service.create(app, s.task.taskId)
  await s.runner.tick()
  assert.equal((await s.service.create(app, s.task.taskId)).status, "UNKNOWN")
  await s.runner.tick()
  assert.equal(s.calls, 1)
  assert(s.job.payload.rawResponse)
  assert.equal(s.job.payload.result, undefined)
})
test("进程中断RUNNING恢复为UNKNOWN；已落库RECEIVED只解析不请求", async () => {
  const interrupted = setup({ status: "RUNNING" })
  await interrupted.runner.tick()
  assert.equal(interrupted.job.status, "UNKNOWN")
  assert.equal(interrupted.calls, 0)
  const received = setup({ status: "RECEIVED" })
  await received.runner.tick()
  assert.equal(received.job.status, "COMPLETED")
  assert.equal(received.calls, 0)
})
test("无效生成明确FAILED，重复提交和轮询不触发格式纠错调用", async () => {
  const s = setup({ response: "{}" })
  await s.service.create(app, s.task.taskId)
  await s.runner.tick()
  const response = await s.service.create(app, s.task.taskId)
  assert.equal(response.status, "FAILED")
  assert.equal(response.error.code, "OPTIMIZATION_RESPONSE_INVALID")
  await s.runner.tick()
  assert.equal(s.calls, 1)
})
test("接入方隔离、类目授权与原审计执行中保护", async () => {
  const s = setup()
  await assert.rejects(
    s.service.get({ ...app, appId: "other" }, s.task.taskId),
    e => e.status === 404
  )
  await assert.rejects(
    s.service.get({ ...app, isAutomotiveAuditEnabled: false }, s.task.taskId),
    e => e.status === 403
  )
  s.task.status = "RUNNING"
  await assert.rejects(s.service.create(app, s.task.taskId), e => e.status === 409)
  assert.equal(s.created, 0)
})
test("缺已存证据不能生成；汽配prompt包含已确认规则及真实配置", () => {
  assert.throws(
    () => buildOptimizationRequest({ auditType: "COMPUTER", normalizedInput: {}, score: {} }),
    /原任务缺少/
  )
  const request = buildOptimizationRequest({
    auditType: "AUTOMOTIVE",
    normalizedInput: { product: { title: "Part" } },
    auditResult: { rules: [] },
    input: { referenceData: { material: "Plastic" } },
  })
  assert(request.system.includes("适配→OE→产品卖点"))
  assert(request.system.includes("标题允许"))
  assert(request.user.includes("Plastic"))
})
