import { uiText } from "../common/i18n/request-language"
import { BadRequestException } from "@nestjs/common"
import { isDeepStrictEqual } from "node:util"
import { validateListingImageUrl } from "../listing/listing-score-images"
import type { QuotePatentQueryDto } from "./dto/patent-query.dto"
import { Input, KINDS, Kind, obj } from "./patent-query.types"
export function sameInput(a: unknown, b: unknown, compareClassCodes = false) {
  const left = obj(JSON.parse(JSON.stringify(a))),
    right = obj(JSON.parse(JSON.stringify(b)))
  if (
    compareClassCodes &&
    !isDeepStrictEqual(obj(left.resolved).classCodes, obj(right.resolved).classCodes)
  )
    return false
  // 旧请求未声明类别，重放时沿用首次保存的类别快照。
  delete left.resolved
  delete right.resolved
  return isDeepStrictEqual(left, right)
}
export const PRICES: Record<Kind, number> = { design: 10, copy: 15, gtm: 10, tm: 5 }
export function niceCodes(values: (number | string)[]): string[] {
  return [
    ...new Set(
      values.map(v => {
        const s = String(v).trim()
        if (!/^\d{1,3}$/.test(s) || +s < 1 || +s > 45)
          throw new BadRequestException("尼斯类别必须为 1–45")
        return String(+s).padStart(3, "0")
      })
    ),
  ].sort()
}
export function normalizeInput(dto: QuotePatentQueryDto, userId: number): Input {
  if (!KINDS.some(k => dto[k] != null)) throw new BadRequestException("请至少选择一项检测")
  const images = (dto.images ?? []).map(i => ({ id: i.id, key: i.key, name: i.name.trim() }))
  if (images.length > 3 || new Set(images.map(i => i.id)).size !== images.length)
    throw new BadRequestException("最多上传 3 张图片，图片 ID 不能重复")
  for (const i of images) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(i.id) ||
      ["__proto__", "constructor", "prototype"].includes(i.id) ||
      !i.key.startsWith(`patent-query/${userId}/`) ||
      /(?:\.\.|[%?#\\])/.test(i.key) ||
      [...i.key].some(c => c.charCodeAt(0) < 32) ||
      i.key.endsWith("/")
    )
      throw new BadRequestException("图片路径不合法")
  }
  const sites = [...new Set(dto.sites)].sort()
  if (!sites.length || sites.some(s => !["US", "DE", "FR", "IT", "ES", "GB", "JP"].includes(s)))
    throw new BadRequestException("请选择有效销售站点")
  const result: Input = {
    images,
    sites,
    resolved: { designCountries: sites.includes("US") ? ["US"] : [], classCodes: [], skipped: [] },
  }
  if (dto.design)
    result.design = {
      productName: dto.design.productName?.trim() || "",
      locs: [...new Set(dto.design.locs ?? [])].sort(),
      removeBg: dto.design.removeBg ?? true,
      rerank: dto.design.rerank ?? true,
    }
  if (dto.copy) result.copy = {}
  if (dto.gtm) result.gtm = { removeBg: dto.gtm.removeBg ?? true }
  if (dto.tm) {
    result.resolved.classCodes = niceCodes(dto.tm.classCodes ?? [])
    result.tm = {
      brand: dto.tm.brand?.trim() || "",
      title: dto.tm.title?.trim() || "",
      bullets: dto.tm.bullets?.trim() || "",
      description: dto.tm.description?.trim() || "",
      includeImageText: dto.tm.includeImageText ?? true,
    }
    const ids = new Set(images.map(image => image.id))
    const urls = new Set<string>()
    const listingImages = (dto.tm.images ?? []).flatMap(image => {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(image.id) ||
        ["__proto__", "constructor", "prototype"].includes(image.id) ||
        ids.has(image.id)
      )
        throw new BadRequestException("图片 ID 不合法或重复")
      ids.add(image.id)
      const url = listingImageUrl(image.url)
      if (urls.has(url)) return []
      urls.add(url)
      return [{ id: image.id, url, name: image.name.trim() }]
    })
    if (listingImages.length) result.tm.images = listingImages
    if (!result.tm.brand && !result.tm.title) throw new BadRequestException("请填写品牌名或标题")
  }
  if (result.design && !sites.includes("US")) result.resolved.skipped.push("design")
  const kinds = executableKinds(result)
  if (!kinds.length) throw new BadRequestException("所选站点没有可执行的检测项")
  if (kinds.some(k => k !== "tm") && !images.length) throw new BadRequestException("请上传产品图")
  return result
}
export function executableKinds(i: Input): Kind[] {
  return KINDS.filter(k => i[k] && !i.resolved.skipped.includes(k))
}
export function quote(i: Input) {
  const kinds = executableKinds(i)
  const breakdown = kinds.map(kind => ({
    kind,
    units: kind === "tm" ? 1 : i.images.length,
    unitCredits: PRICES[kind],
    credits: PRICES[kind] * (kind === "tm" ? 1 : i.images.length),
  }))
  const warnings: string[] = []
  if (i.tm && !i.resolved.classCodes.length)
    warnings.push(uiText("未限定类别，结果可能包含不同类商品的商标", "No classes were selected. Results may include marks for unrelated goods."))
  if (i.sites.some(s => s !== "US"))
    warnings.push(uiText("当前仅接入美国专利/商标库，所选其他站点的本国权利未查", "Only US patent and trademark databases were searched. Domestic rights in the other selected markets were not checked."))
  return {
    quotedCredits: breakdown.reduce((s, b) => s + b.credits, 0),
    breakdown,
    executableKinds: kinds,
    skipped: i.resolved.skipped,
    classCodes: i.resolved.classCodes,
    warnings,
  }
}
export function reportTitle(i: Input) {
  return (
    i.design?.productName?.trim() ||
    [i.tm?.brand, i.tm?.title].filter(Boolean).join(" ").trim() ||
    i.images[0]?.name.trim() ||
    uiText("产品专利查询", "Product IP Screening")
  ).slice(0, 500)
}

export function listingImageUrl(value: string): string {
  try {
    return validateListingImageUrl(value)
  } catch {
    throw new BadRequestException("商品图仅支持有效的 Amazon 图片 CDN HTTPS 地址")
  }
}
