import { ConfigService } from "@nestjs/config"
import axios from "axios"
import sharp from "sharp"
import { ApifyProvider } from "../common/providers/apify.provider"
import type { PrismaService } from "../prisma/prisma.service"
import type { SpacesService } from "../spaces/spaces.service"
import { TikTokCoverService } from "./tiktok-cover.service"

jest.mock("axios")
const http = jest.mocked(axios)
const postId = "7629388754888740110"
const postUrl = `https://www.tiktok.com/@creator/video/${postId}`
const oldCover = "https://p16.tiktokcdn-us.com/expired"
const providerCover = "https://api.apify.com/v2/key-value-stores/storeId/records/cover.jpg"

function setup(cover = oldCover) {
  const items = {
    findFirst: jest.fn().mockResolvedValue({
      sourceUrl: postUrl,
      mediaUrl: postUrl,
      thumbnailUrl: cover,
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  const spaces = {
    getPublicUrl: (key: string) => `https://files.example/${key}`,
    uploadBuffer: jest.fn(async (_buffer: Buffer, key: string) => `https://files.example/${key}`),
  }
  const apify = new ApifyProvider(new ConfigService({ APIFY_API_TOKEN: "test-token" }))
  const service = new TikTokCoverService(
    { inspirationItem: items } as unknown as PrismaService,
    apify,
    spaces as unknown as SpacesService
  )
  return { service, items, spaces }
}

describe("TikTokCoverService.repair", () => {
  beforeEach(() => jest.resetAllMocks())

  it("stabilizes the original post cover and only updates the existing thumbnail", async () => {
    const { service, items } = setup()
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer()
    http.post.mockResolvedValueOnce({
      data: [
        { id: "123", videoMeta: { coverUrl: oldCover } },
        { id: postId, videoMeta: { coverUrl: providerCover } },
      ],
    })
    http.get.mockResolvedValueOnce({ data: image })

    await expect(service.repair(6959)).resolves.toBe("updated")
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining("clockworks~tiktok-scraper"),
      { postURLs: [postUrl], shouldDownloadCovers: true },
      expect.objectContaining({ params: expect.objectContaining({ maxTotalChargeUsd: 1 }) })
    )
    expect(http.get).toHaveBeenCalledWith(
      providerCover,
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" }, maxRedirects: 0 })
    )
    expect(items.updateMany).toHaveBeenCalledWith({
      where: { id: 6959, thumbnailUrl: oldCover, subscription: { deletedAt: null } },
      data: {
        thumbnailUrl: expect.stringContaining(
          "https://files.example/inspiration-radar/tiktok-covers/"
        ),
      },
    })
  })

  it("leaves the record intact if the actor returns a cover from an untrusted host", async () => {
    const { service, items, spaces } = setup()
    http.post.mockResolvedValueOnce({
      data: [{ id: postId, videoMeta: { coverUrl: "https://p16.tiktokcdn-us.com.example/cover" } }],
    })

    await expect(service.repair(6959)).rejects.toThrow("不支持的 TikTok 封面地址")
    expect(http.get).not.toHaveBeenCalled()
    expect(spaces.uploadBuffer).not.toHaveBeenCalled()
    expect(items.updateMany).not.toHaveBeenCalled()
  })

  it("skips a previously repaired cover before calling the actor", async () => {
    const { service, items } = setup(
      "https://files.example/inspiration-radar/tiktok-covers/cover.webp"
    )

    await expect(service.repair(6959)).resolves.toBe("already-stored")
    expect(http.post).not.toHaveBeenCalled()
    expect(items.updateMany).not.toHaveBeenCalled()
  })
})
