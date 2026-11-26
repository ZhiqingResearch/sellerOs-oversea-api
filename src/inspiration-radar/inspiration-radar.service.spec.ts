import { ConfigService } from "@nestjs/config"
import type { Prisma } from "@prisma/client"
import axios from "axios"
import sharp from "sharp"
import { withUiLanguage } from "../common/i18n/request-language"
import { ApifyProvider } from "../common/providers/apify.provider"
import type { PrismaService } from "../prisma/prisma.service"
import type { SpacesService } from "../spaces/spaces.service"
import type { UsageService } from "../usage/usage.service"
import { InspirationRadarService } from "./inspiration-radar.service"
import { TikTokCoverService } from "./tiktok-cover.service"

jest.mock("axios")
jest.mock("../generation-record/generation-record-success")

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
      {} as UsageService,
      {} as TikTokCoverService
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

describe("InspirationRadarService.refresh", () => {
  const http = jest.mocked(axios)
  beforeEach(() => jest.resetAllMocks())

  function setup(token = "test") {
    const sub = {
      id: 71,
      name: "Garden",
      keywords: ["garden", "planter"],
      selectedVariants: {},
      platforms: ["PINTEREST"],
      countPerPlatform: { PINTEREST: 20 },
      lastRefreshedAt: null as Date | null,
    }
    const tx = {
      $queryRaw: jest.fn(),
      inspirationSubscription: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(sub),
        update: ({ data }: { data: { lastRefreshedAt: Date } }) => Object.assign(sub, data),
      },
      inspirationItem: {
        deleteMany: jest.fn(),
        createMany: jest.fn<void, [{ data: Prisma.InspirationItemCreateManyInput[] }]>(),
      },
    }
    const prisma = {
      inspirationSubscription: { findFirst: jest.fn().mockResolvedValue(sub) },
      inspirationItem: {
        findMany: () => tx.inspirationItem.createMany.mock.lastCall?.[0].data ?? [],
      },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    }
    const usage = { deductCustom: jest.fn().mockResolvedValue({ creditsCharged: 1 }) }
    const db = prisma as unknown as PrismaService
    const apify = new ApifyProvider(
      new ConfigService({ APIFY_API_TOKEN: token, APIFY_MAX_RETRIES: 0 })
    )
    const spaces = {
      uploadBuffer: jest.fn(async (_buffer: Buffer, key: string) => `https://files.example/${key}`),
    }
    const covers = new TikTokCoverService(db, apify, spaces as unknown as SpacesService)
    const service = new InspirationRadarService(db, apify, usage as unknown as UsageService, covers)
    return { service, usage, prisma, sub, spaces }
  }

  it("returns the newly fetched Pinterest items on both the first and next refresh", async () => {
    const { service, usage, sub } = setup()
    for (const id of ["first", "second"]) {
      http.post.mockResolvedValueOnce({
        data: [{ id, media: { images: { original: { url: "https://example.com/pin.jpg" } } } }],
      })
      await expect(service.refresh(71, 81)).resolves.toMatchObject([
        { externalId: id, platform: "PINTEREST" },
      ])
      expect(http.post.mock.lastCall).toMatchObject([
        expect.stringContaining("pinterest-scraper-search"),
        { queries: ["garden", "planter"], type: "all-pins", limit: 10 },
        { params: { maxTotalChargeUsd: 1 } },
      ])
      expect(sub.lastRefreshedAt).toBeInstanceOf(Date)
    }
    expect(usage.deductCustom).toHaveBeenCalledTimes(2)
  })

  it("stores a TikTok cover before returning refresh results and keeps the original video URL", async () => {
    const { service, sub, spaces } = setup()
    sub.platforms = ["TIKTOK"]
    const post = "https://www.tiktok.com/@creator/video/7629388754888740110"
    const cover = "https://p16-common-sign.tiktokcdn-us.com/cover?x-signature=temporary"
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer()
    http.post.mockResolvedValueOnce({
      data: [{ webVideoUrl: post, videoMeta: { coverUrl: cover } }],
    })
    http.get.mockResolvedValueOnce({ data: image })

    await expect(service.refresh(71, 81)).resolves.toMatchObject([
      {
        sourceUrl: post,
        mediaUrl: post,
        thumbnailUrl: expect.stringMatching(
          /^https:\/\/files\.example\/inspiration-radar\/tiktok-covers\/.+\.webp$/
        ),
      },
    ])
    expect(http.get).toHaveBeenCalledWith(cover, expect.objectContaining({ maxRedirects: 0 }))
    expect(spaces.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      "image/webp"
    )
  })

  it("retains a TikTok item with no thumbnail when the cover download fails", async () => {
    const { service, sub, spaces } = setup()
    sub.platforms = ["TIKTOK"]
    const post = "https://www.tiktok.com/@creator/video/7629388754888740110"
    http.post.mockResolvedValueOnce({
      data: [{ webVideoUrl: post, videoMeta: { coverUrl: "https://p16.tiktokcdn-us.com/expired" } }],
    })
    http.get.mockRejectedValueOnce(new Error("403"))

    await expect(service.refresh(71, 81)).resolves.toMatchObject([
      { mediaUrl: post, thumbnailUrl: undefined },
    ])
    expect(spaces.uploadBuffer).not.toHaveBeenCalled()
  })

  it.each([
    [
      "test",
      400,
      "max-total-charge-usd-below-minimum",
      "en-US",
      502,
      /Pinterest.*budget.*contact support/i,
    ],
    ["test", 403, "invalid-token", "en-US", 502, /Pinterest.*access.*contact support/i],
    ["test", 503, "unavailable", "zh-CN", 502, /Pinterest.*稍后重试/],
    ["", 0, "", "en-US", 503, /Pinterest.*configured.*contact support/i],
  ] as const)(
    "reports the failed source before replacing results or charging (%s, %s, %s)",
    async (token, status, type, language, expectedStatus, message) => {
      const { service, usage, prisma } = setup(token)
      http.isAxiosError.mockReturnValue(true)
      http.post.mockRejectedValue({
        response: { status, data: { error: { type } } },
        message: "upstream error",
      })
      const result = withUiLanguage(language, () => service.refresh(71, 81))
      await expect(result).rejects.toMatchObject({ status: expectedStatus })
      await expect(result).rejects.toThrow(message)
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(usage.deductCustom).not.toHaveBeenCalled()
      expect(http.post.mock.calls).toHaveLength(token ? 1 : 0)
    }
  )
})
