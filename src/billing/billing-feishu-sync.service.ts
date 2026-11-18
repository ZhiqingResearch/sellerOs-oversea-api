import { Injectable, Logger } from "@nestjs/common"
import { FeishuProvider } from "../common/providers/feishu.provider"
import { PrismaService } from "../prisma/prisma.service"

const RETRY_DELAYS_MS = [1000, 5000, 30_000]

@Injectable()
export class BillingFeishuSyncService {
  private readonly logger = new Logger(BillingFeishuSyncService.name)
  private queue: Promise<void> = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly feishu: FeishuProvider
  ) {}

  syncOrder(orderNo: string): Promise<void> {
    if (!this.feishu.isBillingConfigured()) return Promise.resolve()
    const pending = this.inFlight.get(orderNo)
    if (pending) return pending

    // 同一张表串行写入；ponytail: 仅进程内重试，重启或重试耗尽需人工按订单号补写。
    const task = this.queue
      .then(() => this.syncWithRetries(orderNo))
      .catch((error: unknown) => {
        this.logger.error(
          `飞书订单同步失败 orderNo=${orderNo}：${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => this.inFlight.delete(orderNo))
    this.inFlight.set(orderNo, task)
    this.queue = task
    return task
  }

  private async syncWithRetries(orderNo: string) {
    const order = await this.prisma.billingOrder.findUnique({
      where: { orderNo },
      include: { user: { select: { username: true, phone: true, email: true } } },
    })
    if (!order || order.status !== "SETTLED" || order.amountCny.lte(0) || !order.paidAt) return

    // 读取一次后冻结字段，防止重试期间用户资料变化导致同一幂等键的请求内容不一致。
    const fields = {
      订单号: order.orderNo,
      用户ID: order.userId,
      用户名: order.user.username,
      手机号: Number(order.user.phone),
      ...(order.user.email ? { 邮箱: order.user.email } : {}),
      订单类型: order.type,
      支付渠道: order.channel ?? "",
      订单金额_人民币元: order.amountCny.toNumber(),
      ...(order.paymentProvider !== "ALLINPAY" && order.amountUsdCents != null
        ? { 实收金额_美元: order.amountUsdCents / 100 }
        : {}),
      订单状态: order.status,
      支付时间: order.paidAt.getTime(),
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const recordId = await this.feishu.syncBillingOrder(orderNo, fields)
        this.logger.log(`飞书订单同步成功 orderNo=${orderNo} recordId=${recordId}`)
        return
      } catch (error: unknown) {
        if (attempt === RETRY_DELAYS_MS.length) throw error
        this.logger.warn(`飞书订单同步待重试 orderNo=${orderNo} retry=${attempt + 1}`)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
      }
    }
  }
}
