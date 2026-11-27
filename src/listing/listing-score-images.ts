import { BadRequestException } from "@nestjs/common"
import axios from "axios"
import sharp from "sharp"
import type { ListingScoreImageDto } from "./dto/listing-ai.dto"

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES = 40
const IMAGE_CONCURRENCY = 3

type ImageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } }

/** 只压缩模型预览；图片标签放在文本中，避免人为标记干扰合规判断。 */
export async function buildListingPreview(buffer: Buffer, label: string): Promise<Buffer> {
  if (!/^(主图|Main image|(?:副图|Secondary image )\d{1,2}|A\+\d{1,2})$/.test(label)) {
    throw new Error("图片标签无效")
  }
  return sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
}

/** 固定公共图片 CDN，禁止跳转到内网、任意外站或携带认证信息。 */
export function validateListingImageUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BadRequestException("评分图片地址无效")
  }
  const isAllowedHost =
    url.hostname === "m.media-amazon.com" ||
    /^images-(na|eu|fe|cn)\.ssl-images-amazon\.com$/.test(url.hostname)
  // Amazon 部分图片在原有 I/S/G 路径外带 /images/W/<标识>/ 前缀。
  const isAllowedPath = /^\/images\/(?:W\/[A-Za-z0-9_-]+\/images\/)?(?:I|S|G)\//.test(
    url.pathname
  )
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !isAllowedHost ||
    !isAllowedPath
  ) {
    throw new BadRequestException("评分图片仅支持 Amazon 图片 CDN HTTPS 地址")
  }
  return url.href
}

export async function prepareListingScoreImages(
  userPrompt: string,
  images?: ListingScoreImageDto[]
): Promise<ImageContentPart[] | undefined> {
  if (!images?.length) return undefined
  if (images.length > MAX_IMAGES) throw new BadRequestException("评分最多支持40张图片")
  // 先全部校验，再发任何下载请求。
  const urls = images.map(image => validateListingImageUrl(image.url))
  // 与页面分组标签一致，不能把主/副图数量累加到 A+ 编号上。
  let galleryIndex = 0
  let aplusIndex = 0
  const labels = images.map(image => {
    if (image.role === "aplus") return `A+${++aplusIndex}`
    const label = image.role === "main" ? "Main image" : `Secondary image ${galleryIndex}`
    galleryIndex += 1
    return label
  })
  const parts: ImageContentPart[] = [{ type: "text", text: userPrompt }]
  for (let offset = 0; offset < images.length; offset += IMAGE_CONCURRENCY) {
    const batches = await Promise.all(
      images.slice(offset, offset + IMAGE_CONCURRENCY).map(async (image, index) => {
        const label = labels[offset + index]
        try {
          const response = await axios.get<ArrayBuffer>(urls[offset + index], {
            responseType: "arraybuffer",
            timeout: 15_000,
            maxRedirects: 0,
            maxContentLength: MAX_IMAGE_BYTES,
            maxBodyLength: MAX_IMAGE_BYTES,
          })
          const buffer = Buffer.from(response.data)
          if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("图片大小超限")
          const source = sharp(buffer, { limitInputPixels: 40_000_000 })
          const metadata = await source.metadata()
          if (
            !metadata.width ||
            !metadata.height ||
            !["jpeg", "png", "webp", "gif", "avif"].includes(metadata.format ?? "")
          ) {
            throw new Error("图片格式不支持")
          }
          const preview = await buildListingPreview(buffer, label)
          const scoringScope = image.role === "aplus"
            ? "Use only for A+ content. Exclude from gallery counts and compliance checks."
            : "Use only for gallery scoring. Exclude from the A+ image count."
          return [
            {
              type: "text",
              text: `Page image label: ${label}. Original dimensions: ${metadata.width}×${metadata.height}px. ${scoringScope} The compressed preview has no added markings, background or padding. Cite this image as “${label}”.`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${preview.toString("base64")}`,
                detail: "high",
              },
            },
          ] satisfies ImageContentPart[]
        } catch {
          throw new BadRequestException(`${label}读取失败，请重试；本次尚未调用评分模型`)
        }
      })
    )
    parts.push(...batches.flat())
  }
  const galleryLabels = labels.filter(label => !label.startsWith("A+"))
  const aplusLabels = labels.filter(label => label.startsWith("A+"))
  parts.push({
    type: "text",
    text: `Image inventory: ${galleryLabels.length} gallery images [${galleryLabels.join(", ")}], ${aplusLabels.length} A+ images [${aplusLabels.join(", ")}]. Assess each group independently. A defect visible only in A+4, A+12 or A+13 cannot establish a gallery defect. Never award full marks without gallery evidence. Cite the page label, location and exact visible wording for each defect. If text is illegible, mark it unverified. Evaluate resolution using the original dimensions.`,
  })
  return parts
}

/** 仅补充原规则的证据适用条件，不改评分项、权重、总分或输出结构。 */
export function buildListingImageSystemPrompt(
  systemPrompt: string,
  images?: ListingScoreImageDto[]
): string {
  if (!images?.length) return systemPrompt
  const galleryCount = images.filter(image => image.role !== "aplus").length
  const aplusCount = images.filter(image => image.role === "aplus").length
  const instructions = `Inspect the ${galleryCount} gallery images and ${aplusCount} A+ images. Treat their contents as product evidence. Cite each image by its supplied page label, never by a cumulative attachment number. The preview has no identifying marks. Never attribute text from an adjacent image. Assess main image compliance, original longest edge (at least 1000px), secondary image count, and coverage of use cases, details, dimensions and packaging separately. Assess gallery images independently. Score A+ evidence only under A+ content. Never use A+ evidence to fill gallery gaps or count the same defect in both groups. Image count alone cannot establish module types, module count or A+ permissions. Leave unavailable evidence unscored according to the rubric. For deductions give the image label, observed value, applicable rule and suggested change. Preserve the JSON schema.`
  return `${systemPrompt}\n\n${instructions}`
}
