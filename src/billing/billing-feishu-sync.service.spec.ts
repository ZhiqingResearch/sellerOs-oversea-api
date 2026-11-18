import { Logger } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { FeishuProvider } from "../common/providers/feishu.provider"
import { PrismaService } from "../prisma/prisma.service"
import { BillingFeishuSyncService } from "./billing-feishu-sync.service"

describe("BillingFeishuSyncService", () => {
  const order = {
    orderNo: "SR20261102001",
    userId: 7,
    user: { username: "张三", phone: "13800138000", email: null },
    type: "PACK",
    status: "SETTLED",
    channel: "WECHAT",
    paymentProvider: "STRIPE",
    amountCny: new Decimal("100.12"),
    amountUsdCents: 1389,
    paidAt: new Date("2026-11-02T01:00:00Z"),
  }
  let prisma: { billingOrder: { findUnique: jest.Mock } }
  let feishu: jest.Mocked<Pick<FeishuProvider, "isBillingConfigured" | "syncBillingOrder">>
  let service: BillingFeishuSyncService
  let errorLog: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    prisma = { billingOrder: { findUnique: jest.fn().mockResolvedValue(order) } }
    feishu = {
      isBillingConfigured: jest.fn().mockReturnValue(true),
      syncBillingOrder: jest.fn().mockResolvedValue("rec_order"),
    }
    service = new BillingFeishuSyncService(
      prisma as unknown as PrismaService,
      feishu as unknown as FeishuProvider
    )
    errorLog = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it("新组织配置留空时跳过，不访问数据库或飞书", async () => {
    feishu.isBillingConfigured.mockReturnValue(false)
    await service.syncOrder(order.orderNo)
    expect(prisma.billingOrder.findUnique).not.toHaveBeenCalled()
    expect(feishu.syncBillingOrder).not.toHaveBeenCalled()
  })

  it("适配目标表的数字手机号，空邮箱留空，支付时间传原始毫秒值", async () => {
    await service.syncOrder(order.orderNo)
    expect(feishu.syncBillingOrder).toHaveBeenCalledWith(order.orderNo, {
      订单号: order.orderNo,
      用户ID: 7,
      用户名: "张三",
      手机号: 13800138000,
      订单类型: "PACK",
      支付渠道: "WECHAT",
      订单金额_人民币元: 100.12,
      实收金额_美元: 13.89,
      订单状态: "SETTLED",
      支付时间: order.paidAt.getTime(),
    })
  })

  it("Email 字段直接写入邮箱字符串", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...order,
      user: { ...order.user, email: "test@example.com" },
    })
    await service.syncOrder(order.orderNo)
    expect(feishu.syncBillingOrder.mock.calls[0][1].邮箱).toBe("test@example.com")
  })

  it("通联订单不写美元实收，即使遗留数据有美元金额", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({ ...order, paymentProvider: "ALLINPAY" })
    await service.syncOrder(order.orderNo)
    const fields = feishu.syncBillingOrder.mock.calls[0][1]
    expect(fields).not.toHaveProperty("实收金额_美元")
  })

  it.each([
    null,
    { ...order, status: "PAID" },
    { ...order, amountCny: new Decimal(0) },
    { ...order, paidAt: null },
  ])("不写未结算、零元、缺少支付时间或不存在的订单", async value => {
    prisma.billingOrder.findUnique.mockResolvedValue(value)
    await service.syncOrder(order.orderNo)
    expect(feishu.syncBillingOrder).not.toHaveBeenCalled()
  })

  it("失败按 1/5/30 秒重试三次，字段冻结且最终失败只记录日志", async () => {
    feishu.syncBillingOrder.mockRejectedValue(new Error("请求超时"))
    const done = service.syncOrder(order.orderNo)
    await jest.advanceTimersByTimeAsync(0)
    expect(feishu.syncBillingOrder).toHaveBeenCalledTimes(1)
    for (const [delay, count] of [
      [1000, 2],
      [5000, 3],
      [30_000, 4],
    ]) {
      await jest.advanceTimersByTimeAsync(delay - 1)
      expect(feishu.syncBillingOrder).toHaveBeenCalledTimes(count - 1)
      await jest.advanceTimersByTimeAsync(1)
      expect(feishu.syncBillingOrder).toHaveBeenCalledTimes(count)
    }
    await expect(done).resolves.toBeUndefined()
    expect(prisma.billingOrder.findUnique).toHaveBeenCalledTimes(1)
    const firstFields: unknown = feishu.syncBillingOrder.mock.calls[0][1]
    for (const call of feishu.syncBillingOrder.mock.calls) expect(call[1]).toBe(firstFields)
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(order.orderNo))
    expect(jest.getTimerCount()).toBe(0)
  })

  it("重试成功后立即停止，不继续等待后续重试", async () => {
    feishu.syncBillingOrder.mockRejectedValueOnce(new Error("网络故障"))
    const done = service.syncOrder(order.orderNo)
    await jest.advanceTimersByTimeAsync(1000)
    await done
    expect(feishu.syncBillingOrder).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("同订单并发调用共用一次同步，不同订单按顺序写入", async () => {
    let finish!: (value: string) => void
    feishu.syncBillingOrder.mockReturnValueOnce(
      new Promise<string>(resolve => {
        finish = resolve
      })
    )
    const first = service.syncOrder(order.orderNo)
    expect(service.syncOrder(order.orderNo)).toBe(first)
    const second = service.syncOrder("SR20261102002")
    await jest.advanceTimersByTimeAsync(0)
    expect(prisma.billingOrder.findUnique).toHaveBeenCalledTimes(1)
    finish("rec_order")
    await Promise.all([first, second])
    expect(prisma.billingOrder.findUnique).toHaveBeenCalledTimes(2)
    expect(feishu.syncBillingOrder).toHaveBeenCalledTimes(2)
  })
})
