import { INestApplication, UnauthorizedException, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { AsinCostAdminController } from "./asin-cost-admin.controller"
import { AsinCostQueryService } from "./asin-cost-query.service"

describe("后台审计成本HTTP鉴权与参数", () => {
  let app: INestApplication
  const list = jest
    .fn()
    .mockResolvedValue({ page: 1, pageSize: 10, total: 0, creditsDeducted: false, items: [] })
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AsinCostAdminController],
      providers: [
        { provide: AsinCostQueryService, useValue: { list } },
        {
          provide: PermissionCacheService,
          useValue: {
            getForUser: async (id: number) => new Set(id === 1 ? ["company.admin"] : []),
            getLabelMap: async () => new Map(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: context => {
          const req = context.switchToHttp().getRequest()
          if (!req.headers["x-test-user"]) throw new UnauthorizedException()
          req.user = { id: Number(req.headers["x-test-user"]) }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
    await app.init()
  })
  afterAll(async () => app?.close())
  it("未登录401、普通用户403；两者不能读取成本", async () => {
    await request(app.getHttpServer()).get("/api/admin/asin-audit-costs").expect(401)
    await request(app.getHttpServer())
      .get("/api/admin/asin-audit-costs")
      .set("x-test-user", "2")
      .expect(403)
    expect(list).not.toHaveBeenCalled()
  })
  it("管理员200，带账号过滤；非法分页400；没有任何写入口", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/admin/asin-audit-costs?phone=19980889056&page=1&pageSize=10")
      .set("x-test-user", "1")
      .expect(200)
    expect(response.body.creditsDeducted).toBe(false)
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "19980889056", page: 1, pageSize: 10 })
    )
    await request(app.getHttpServer())
      .get("/api/admin/asin-audit-costs?pageSize=999")
      .set("x-test-user", "1")
      .expect(400)
    await request(app.getHttpServer())
      .post("/api/admin/asin-audit-costs")
      .set("x-test-user", "1")
      .expect(404)
  })
})
