import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common"
import { PrismaService } from "../../prisma/prisma.service"
import { InternalAccountGuard } from "./internal-account.guard"

describe("InternalAccountGuard", () => {
  const findUnique = jest.fn()
  const prisma = { emailAccount: { findUnique } } as unknown as PrismaService
  const guard = new InternalAccountGuard(prisma)
  const context = (user?: object) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext

  beforeEach(() => findUnique.mockReset())

  it("按当前登录用户的绑定邮箱授权，忽略大小写和首尾空格", async () => {
    findUnique.mockResolvedValue({ email: " Tranloan74046@GMAIL.COM " })
    await expect(guard.canActivate(context({ id: 42 }))).resolves.toBe(true)
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: 42 }, select: { email: true } })
  })

  it.each([null, { email: "tranloan74046@gmail.com.example" }])(
    "绑定缺失或不匹配时，旧白名单手机号、管理员角色和请求携带的邮箱均不能放行（%j）",
    async binding => {
      findUnique.mockResolvedValue(binding)
      const user = {
        id: 42,
        phone: "18888888888",
        roleCode: "ADMIN",
        email: "tranloan74046@gmail.com",
      }
      await expect(guard.canActivate(context(user))).rejects.toThrow(ForbiddenException)
    }
  )

  it("未认证时返回 401 并跳过绑定查询", async () => {
    await expect(guard.canActivate(context())).rejects.toThrow(UnauthorizedException)
    expect(findUnique).not.toHaveBeenCalled()
  })
})
