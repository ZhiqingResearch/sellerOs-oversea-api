import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PatentQueryExportService } from "./patent-query-export.service"
import { PatentQueryPdfService } from "./patent-query-pdf.service"
import { PatentQueryController } from "./patent-query.controller"
import { PatentQueryNiceClassService } from "./patent-query.nice-class.service"
import { PatentQueryService } from "./patent-query.service"
import { obj, rows } from "./patent-query.types"
describe("专利 HTTP 契约", () => {
  let app: INestApplication
  const service = {
    quote: jest.fn().mockReturnValue({ quotedCredits: 5 }),
    create: jest.fn(),
    list: jest.fn().mockReturnValue({ items: [], total: 0 }),
    taskInput: jest.fn().mockReturnValue({ taskId: 1, input: { tm: { description: "完整描述" } } }),
    overview: jest.fn().mockReturnValue({ id: 1, reportSummary: { high: 1 } }),
    results: jest.fn().mockReturnValue({ items: [], total: 0 }),
    marks: jest.fn().mockReturnValue({ items: [], total: 0 }),
    rowDetail: jest.fn().mockReturnValue({ rowId: "r-1" }),
    todos: jest.fn().mockReturnValue({ items: [], total: 0 }),
    context: jest.fn().mockReturnValue({ items: [], total: 0 }),
    decision: jest.fn().mockReturnValue({ changed: { value: "dismiss" }, refresh: [] }),
    todo: jest.fn().mockReturnValue({ done: true, refresh: ["overview", "todos"] }),
    refreshImages: jest.fn().mockReturnValue({ refresh: ["results"] }),
  }
  const exports = { create: jest.fn(), status: jest.fn(), download: jest.fn() }
  const pdf = { export: jest.fn().mockResolvedValue(Buffer.from("%PDF-sample")) }
  const permission = {
    getForUser: jest.fn().mockResolvedValue(new Set(["tool.patent_query"])),
    getLabelMap: jest.fn().mockResolvedValue(new Map([["tool.patent_query", "产品专利查询"]])),
  }
  const gateway = {
    generateJson: jest.fn<
      Promise<{ data: { classCodes: unknown[] } }>,
      [string, string, unknown]
    >(),
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PatentQueryController],
      providers: [
        { provide: PatentQueryService, useValue: service },
        { provide: PatentQueryExportService, useValue: exports },
        { provide: PatentQueryPdfService, useValue: pdf },
        PatentQueryNiceClassService,
        { provide: AiGatewayProvider, useValue: gateway },
        PermissionsGuard,
        { provide: PermissionCacheService, useValue: permission },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(ctx: ExecutionContext) {
          const req = ctx
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: { id: number } }>()
          if (req.headers.authorization !== "Bearer test-token")
            throw new UnauthorizedException("未登录")
          req.user = { id: 1 }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
    await app.listen(0, "127.0.0.1")
  })
  afterAll(async () => {
    await app.close()
  })
  it("下载本人报告作为 PDF 附件，未授权请求不能启动导出", async () => {
    const path = "/api/patent-query/tasks/3/report.pdf"
    await request(app.getHttpServer()).get(path).expect(401)
    permission.getForUser.mockResolvedValueOnce(new Set())
    await request(app.getHttpServer())
      .get(path)
      .set("Authorization", "Bearer test-token")
      .expect(403)
    expect(pdf.export).not.toHaveBeenCalled()
    const res = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", "Bearer test-token")
      .expect(200)
      .expect("Content-Type", "application/pdf")
      .expect("Content-Disposition", 'attachment; filename="patent-report-3.pdf"')
    expect(res.body).toEqual(Buffer.from("%PDF-sample"))
    expect(pdf.export).toHaveBeenCalledWith(1, 3)
  })
  it("创建和复用异步导出，共享同一状态协议，下载签名不缓存", async () => {
    const path = "/api/patent-query/tasks/3/exports",
      token = "Bearer test-token"
    const queued = { exportId: "fixture", reportVersion: "opaque", status: "QUEUED" }
    const ready = { ...queued, status: "READY" }
    exports.create.mockResolvedValueOnce(queued).mockResolvedValueOnce(ready)
    await request(app.getHttpServer()).post(path).expect(401)
    await request(app.getHttpServer()).post(path).set("Authorization", token).expect(202, queued)
    await request(app.getHttpServer()).post(path).set("Authorization", token).expect(200, ready)
    exports.status.mockResolvedValue(ready)
    await request(app.getHttpServer())
      .get(path + "/fixture")
      .set("Authorization", token)
      .expect(200, ready)
    const signed = {
      downloadUrl: "https://example.invalid/file",
      expiresAt: "2026-11-24T10:00:00Z",
      filename: "中文.pdf",
    }
    exports.download.mockResolvedValue(signed)
    await request(app.getHttpServer())
      .get(path + "/fixture/download")
      .set("Authorization", token)
      .expect(200, signed)
      .expect("Cache-Control", /no-store/)
    expect(exports.create).toHaveBeenCalledWith(1, 3)
    expect(exports.status).toHaveBeenCalledWith(1, 3, "fixture")
    expect(exports.download).toHaveBeenCalledWith(1, 3, "fixture")
  })

  it("JWT 和功能权限先于服务调用", async () => {
    await request(app.getHttpServer())
      .post("/api/patent-query/quote")
      .send({ sites: ["US"], tm: { brand: "brand" } })
      .expect(401)
    permission.getForUser.mockResolvedValueOnce(new Set())
    await request(app.getHttpServer())
      .post("/api/patent-query/quote")
      .set("Authorization", "Bearer test-token")
      .send({ sites: ["US"], tm: { brand: "brand" } })
      .expect(403)
    expect(service.quote).not.toHaveBeenCalled()
  })
  it("裸响应/无 v1；嵌套字段过滤且 copy={} 可选中", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/patent-query/quote")
      .set("Authorization", "Bearer test-token")
      .send({
        sites: ["US"],
        copy: {},
        tm: { brand: "brand", classCodes: ["021", "032"], malicious: true },
        quotedCredits: 0,
        resolved: { classCodes: ["099"] },
      })
      .expect(200)
    expect(res.body).toEqual({ quotedCredits: 5 })
    const dto = obj((service.quote.mock.calls[0] as unknown[])[1])
    expect(dto.quotedCredits).toBeUndefined()
    expect(dto.resolved).toBeUndefined()
    expect(obj(dto.tm).classCodes).toEqual(["021", "032"])
    expect(obj(dto.tm).malicious).toBeUndefined()
    await request(app.getHttpServer())
      .post("/api/patent-query/quote")
      .set("Authorization", "Bearer test-token")
      .send({ sites: ["US"], tm: [] })
      .expect(400)
  })
  it("尼斯类别目录返回完整 45 类供手动选择，无需模型调用", async () => {
    gateway.generateJson.mockClear()
    const path = "/api/patent-query/nice-classes"
    await request(app.getHttpServer()).get(path).expect(401)
    const res = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", "Bearer test-token")
      .expect(200)
    const classes = rows(obj(res.body).classes)
    expect(classes.map(item => item.code)).toEqual(
      Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(3, "0"))
    )
    expect(classes.every(item => typeof item.name === "string" && item.name.trim())).toBe(true)
    expect(gateway.generateJson).not.toHaveBeenCalled()
  })
  it("尼斯类别识别限制为标准 45 类，保持模型排序且最多返回五项", async () => {
    gateway.generateJson.mockResolvedValueOnce({
      data: {
        classCodes: ["032", "021", "032", "046", "constructor", 21, "009", "041", "045", "025"],
      },
    })
    const res = await request(app.getHttpServer())
      .post("/api/patent-query/nice-classes/recommend")
      .set("Authorization", "Bearer test-token")
      .send({ title: " Sparkling Water ", bullets: "无糖卖点", images: ["不参与识别"] })
      .expect(200)
    const recommendations = rows(obj(res.body).recommendations)
    expect(recommendations.map(item => item.code)).toEqual(["032", "021", "009", "041", "045"])
    expect(recommendations[0].name).toContain("无酒精饮料")
    const [prompt, input, options] = gateway.generateJson.mock.lastCall!
    expect(prompt.match(/^\d{3} /gm)).toHaveLength(45)
    expect(JSON.parse(input) as unknown).toEqual({
      brand: "",
      title: "Sparkling Water",
      bullets: "无糖卖点",
      description: "",
    })
    expect(options).toMatchObject({ maxAttempts: 1 })
  })
  it("尼斯类别识别拒绝空白输入，品牌不足以判断时返回空候选", async () => {
    gateway.generateJson.mockClear()
    const path = "/api/patent-query/nice-classes/recommend"
    await request(app.getHttpServer()).post(path).send({ title: "Water" }).expect(401)
    await request(app.getHttpServer())
      .post(path)
      .set("Authorization", "Bearer test-token")
      .send({ title: "  " })
      .expect(400)
    await request(app.getHttpServer())
      .post(path)
      .set("Authorization", "Bearer test-token")
      .send({ brand: "FrostCup" })
      .expect(200, { recommendations: [] })
    expect(gateway.generateJson).not.toHaveBeenCalled()
  })
  it("创建 201、幂等重放 200、分页 query 转数字", async () => {
    service.create
      .mockResolvedValueOnce({ created: true, data: { id: 1, status: "RUNNING" } })
      .mockResolvedValueOnce({ created: false, data: { id: 1, status: "RUNNING" } })
    const body = {
      sites: ["US"],
      tm: { brand: "brand" },
      requestId: "da6b476d-520a-4c1b-bfaa-ae3a71f3c099",
    }
    for (const status of [201, 200])
      await request(app.getHttpServer())
        .post("/api/patent-query/tasks")
        .set("Authorization", "Bearer test-token")
        .send(body)
        .expect(status, { id: 1, status: "RUNNING" })
    await request(app.getHttpServer())
      .get("/api/patent-query/tasks?scope=active&page=2&pageSize=5")
      .set("Authorization", "Bearer test-token")
      .expect(200)
    expect(service.list).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ scope: "active", page: 2, pageSize: 5 })
    )
  })
  it("默认唯一轻响应；旧full拒绝，query枚举/边界由HTTP校验", async () => {
    const get = (url: string) =>
      request(app.getHttpServer()).get(url).set("Authorization", "Bearer test-token")
    await get("/api/patent-query/tasks/1?view=full").expect(400)
    await get("/api/patent-query/tasks?view=full").expect(400)
    await get("/api/patent-query/tasks/1").expect(200, {
      id: 1,
      reportSummary: { high: 1 },
    })
    expect(service.overview).toHaveBeenCalledWith(1, 1)
    await get("/api/patent-query/tasks/1/input").expect(200, {
      taskId: 1,
      input: { tm: { description: "完整描述" } },
    })
    expect(service.taskInput).toHaveBeenCalledWith(1, 1)
    await get("/api/patent-query/tasks").expect(200)
    expect(service.list).toHaveBeenLastCalledWith(1, expect.objectContaining({ view: "summary" }))
    await get("/api/patent-query/tasks/1/results?kind=design&risk=mid&page=2&pageSize=20").expect(
      200
    )
    expect(service.results).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ kind: "design", risk: "mid", page: 2, pageSize: 20, fold: "hide" })
    )
    await get("/api/patent-query/tasks/1/words/w-1/marks").expect(200)
    expect(service.marks).toHaveBeenCalledWith(
      1,
      1,
      "w-1",
      expect.objectContaining({ page: 1, pageSize: 20, risk: "all" })
    )
    for (const suffix of [
      "results/r-1/detail",
      "results/m-1/sources?pageSize=1",
      "todos",
      "todos/test/targets",
      "context?section=ocr",
    ])
      await get(`/api/patent-query/tasks/1/${suffix}`).expect(200)
    for (const suffix of [
      "results?kind=design&risk=dismissed",
      "results?kind=design&page=0",
      "results?kind=design&pageSize=101",
      "results?kind=design&pageSize=1.1",
      "results?kind=design&fold=other",
      "results",
      "context?section=other",
      "words/w-1/marks?risk=dismissed",
      "results?kind=design&fold=other",
    ])
      await get(`/api/patent-query/tasks/1/${suffix}`).expect(400)
    await request(app.getHttpServer())
      .patch("/api/patent-query/tasks/1/decision")
      .set("Authorization", "Bearer test-token")
      .send({ kind: "design", imageId: "img-1", targetId: "design:US:D1", value: "dismiss" })
      .expect(200, { changed: { value: "dismiss" }, refresh: [] })
    expect(service.decision).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ value: "dismiss" })
    )
    for (const response of ["full", "other"])
      await request(app.getHttpServer())
        .patch(`/api/patent-query/tasks/1/decision?response=${response}`)
        .set("Authorization", "Bearer test-token")
        .send({ kind: "tm", targetId: "tm:a:US:1", value: "none" })
        .expect(400)
  })
})
