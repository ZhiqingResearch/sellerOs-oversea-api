import { withUiLanguage } from "../common/i18n/request-language"
import type { ApifyProvider } from "../common/providers/apify.provider"
import type { PrismaService } from "../prisma/prisma.service"
import type { UsageService } from "../usage/usage.service"
import { InspirationRadarService } from "./inspiration-radar.service"

describe("InspirationRadarService.create", () => {
  it.each([
    [
      "en-US",
      "You can create up to 5 subscriptions. Delete an existing subscription before creating another.",
    ],
    ["zh-CN", "订阅数量已达上限（最多 5 个），请先删除一个已有订阅后再新增。"],
  ] as const)("returns the subscription limit and next step in %s", async (language, message) => {
    const prisma = { inspirationSubscription: { count: jest.fn().mockResolvedValue(5) } }
    const service = new InspirationRadarService(
      prisma as unknown as PrismaService,
      {} as ApifyProvider,
      {} as UsageService
    )
    const result = withUiLanguage(language, () =>
      service.create(
        {
          name: "Garden",
          keywords: ["garden"],
          platforms: ["PINTEREST"],
          countPerPlatform: { PINTEREST: 20 },
        },
        81
      )
    )
    await expect(result).rejects.toMatchObject({ status: 400, message })
  })
})
