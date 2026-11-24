import { BadGatewayException, BadRequestException } from "@nestjs/common"
import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP } from "node:net"
import { MAX_LISTING_DOCUMENT_BYTES } from "../listing-document.constants"

const blocked = new BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4")
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
blocked.addSubnet("2001::", 23, "ipv6")
blocked.addSubnet("2002::", 16, "ipv6")
blocked.addSubnet("2001:db8::", 32, "ipv6")
blocked.addSubnet("3fff::", 20, "ipv6")

export function isPublicDocumentAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6")
}

export function documentUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new BadRequestException("文档URL格式不正确")
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".localhost")
  )
    throw new BadRequestException("文档URL必须是公开的HTTP/HTTPS文件地址")
  return parsed
}

/** DNS结果校验后绑定实际连接；每次跳转重新解析，签名URL及下载错误不写日志。 */
export async function downloadAutomotiveDocument(value: string, redirects = 0): Promise<Buffer> {
  return downloadPublicFile(
    value,
    {
      maxBytes: MAX_LISTING_DOCUMENT_BYTES,
      timeoutMs: 60_000,
      accept: "application/pdf,application/octet-stream,*/*",
    },
    redirects
  )
}

export async function downloadPublicFile(
  value: string,
  options: { maxBytes: number; timeoutMs: number; accept: string },
  redirects = 0
): Promise<Buffer> {
  const parsed = documentUrl(value)
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => {
        throw new BadGatewayException("文档地址解析失败")
      })
  if (!addresses.length || addresses.some(a => !isPublicDocumentAddress(a.address)))
    throw new BadRequestException("不允许读取内网或保留地址的文档")
  const target = addresses[0]
  const outcome = await new Promise<{ body?: Buffer; redirect?: string }>((resolve, reject) => {
    const req = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(
      parsed,
      {
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [{ address: target.address, family: target.family }])
            : callback(null, target.address, target.family),
        agent: false,
        headers: { Accept: options.accept },
      },
      response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.resume()
          if (!response.headers.location || redirects >= 3)
            return reject(new BadGatewayException("文档跳转过多或缺少目标地址"))
          try {
            return resolve({ redirect: new URL(response.headers.location, parsed).toString() })
          } catch {
            return reject(new BadGatewayException("文档跳转地址无效"))
          }
        }
        if ((response.statusCode ?? 500) >= 400 || (response.statusCode ?? 0) < 200) {
          response.resume()
          return reject(new BadGatewayException("文档下载失败，请检查文件地址是否有效"))
        }
        if (Number(response.headers["content-length"]) > options.maxBytes) {
          response.destroy()
          return reject(new BadRequestException(`文档不能超过${options.maxBytes / 1024 / 1024}MB`))
        }
        let size = 0
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxBytes) {
            response.destroy()
            reject(new BadRequestException(`文档不能超过${options.maxBytes / 1024 / 1024}MB`))
          } else chunks.push(chunk)
        })
        response.on("end", () => resolve({ body: Buffer.concat(chunks) }))
        response.on("error", () => reject(new BadGatewayException("文档下载连接中断")))
      }
    )
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), options.timeoutMs)
    req.on("close", () => clearTimeout(deadline))
    req.on("error", () => reject(new BadGatewayException("文档下载失败或超时")))
    req.end()
  })
  return outcome.redirect
    ? downloadPublicFile(outcome.redirect, options, redirects + 1)
    : outcome.body!
}
