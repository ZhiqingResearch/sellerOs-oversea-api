import { Injectable, Logger } from "@nestjs/common"
import { createHash } from "node:crypto"
import sharp from "sharp"
import { ApifyMediaItem, ApifyProvider } from "../common/providers/apify.provider"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"

const COVER_PREFIX = "inspiration-radar/tiktok-covers/"
const COVER_BATCH_SIZE = 8

@Injectable()
export class TikTokCoverService {
  private readonly logger = new Logger(TikTokCoverService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly apify: ApifyProvider,
    private readonly spaces: SpacesService
  ) {}

  async storeForRefresh(items: ApifyMediaItem[]): Promise<void> {
    const tiktokItems = items.filter(item => item.platform === "TIKTOK")
    for (let offset = 0; offset < tiktokItems.length; offset += COVER_BATCH_SIZE) {
      await Promise.all(
        tiktokItems.slice(offset, offset + COVER_BATCH_SIZE).map(async item => {
          const original = item.thumbnailUrl
          if (!original) return
          try {
            const stored = await this.store(original)
            item.thumbnailUrl = stored
            if (item.mediaUrl === original) item.mediaUrl = stored
          } catch {
            item.thumbnailUrl = undefined
            this.logger.warn("[InspirationRadar] TikTok 封面转存失败")
          }
        })
      )
    }
  }

  async repair(itemId: number): Promise<"updated" | "already-stored" | "changed"> {
    const item = await this.prisma.inspirationItem.findFirst({
      where: { id: itemId, platform: "TIKTOK", subscription: { deletedAt: null } },
      select: { sourceUrl: true, mediaUrl: true, thumbnailUrl: true },
    })
    if (!item) throw new Error(`未找到 TikTok 素材 ${itemId}`)
    if (item.thumbnailUrl?.startsWith(this.spaces.getPublicUrl(COVER_PREFIX))) {
      return "already-stored"
    }

    const coverUrl = await this.apify.fetchTikTokCover(item.sourceUrl ?? item.mediaUrl)
    if (!coverUrl) throw new Error(`未能从 TikTok 素材 ${itemId} 的原帖取得封面`)

    const thumbnailUrl = await this.store(coverUrl)
    const { count } = await this.prisma.inspirationItem.updateMany({
      where: {
        id: itemId,
        thumbnailUrl: item.thumbnailUrl,
        subscription: { deletedAt: null },
      },
      data: { thumbnailUrl },
    })
    return count ? "updated" : "changed"
  }

  private async store(coverUrl: string): Promise<string> {
    const original = await this.apify.downloadTikTokCover(coverUrl)
    const image = sharp(original, { limitInputPixels: 16_000_000 })
    const { format } = await image.metadata()
    if (!format || !["jpeg", "png", "webp", "gif", "heif"].includes(format)) {
      throw new Error("TikTok 封面不是受支持的图片")
    }

    const cover = await image.autoOrient().webp().toBuffer()
    const hash = createHash("sha256").update(cover).digest("hex")
    return this.spaces.uploadBuffer(cover, `${COVER_PREFIX}${hash}.webp`, "image/webp")
  }
}
