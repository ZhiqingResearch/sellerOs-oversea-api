import { ConfigService } from "@nestjs/config"
import { ApifyProvider } from "../src/common/providers/apify.provider"
import { TikTokCoverService } from "../src/inspiration-radar/tiktok-cover.service"
import { PrismaService } from "../src/prisma/prisma.service"
import { SpacesService } from "../src/spaces/spaces.service"

async function main() {
  const [arg, ...extra] = process.argv.slice(2)
  if (arg === "--help" && extra.length === 0) {
    console.log("npm run inspiration-radar:repair-tiktok-cover -- <素材ID>")
    return
  }

  const itemId = Number(arg)
  if (!arg || !/^\d+$/.test(arg) || !Number.isSafeInteger(itemId) || itemId < 1 || extra.length) {
    throw new Error("请传入一个有效的 TikTok 素材 ID")
  }

  const config = new ConfigService()
  const prisma = new PrismaService()
  try {
    const covers = new TikTokCoverService(
      prisma,
      new ApifyProvider(config),
      new SpacesService(config)
    )
    const result = await covers.repair(itemId)
    console.log(`TikTok 素材 ${itemId} 封面修复结果 ${result}`)
    if (result === "changed") process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "封面修复失败")
  process.exitCode = 1
})
