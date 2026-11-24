import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import sharp from "sharp"
import { ReceiptPdfService } from "../billing/receipt-pdf.service"
import { withUiLanguage } from "../common/i18n/request-language"
import { downloadPublicFile } from "../listing/automotive/automotive-document-download"
import { PrismaService } from "../prisma/prisma.service"
import { ExportConflict, exportVersion } from "./patent-query-export.contract"
import { patentReportHtml } from "./patent-query-pdf.template"
import { executableKinds } from "./patent-query.constants"
import { progress } from "./patent-query.report"
import { assertPaid } from "./patent-query.results"
import { PatentQueryService } from "./patent-query.service"
import { hydrateTasks } from "./patent-query.storage"
import { input, output } from "./patent-query.types"

@Injectable()
export class PatentQueryPdfService {
  private readonly logger = new Logger(PatentQueryPdfService.name)
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: PatentQueryService,
    private readonly pdf: ReceiptPdfService
  ) {}

  async export(userId: number, id: number, expectedVersion?: string): Promise<Buffer> {
    const start = Date.now()
    const task = await this.prisma.$transaction(
      async tx => {
        const row = await tx.patentQueryTask.findFirst({
          where: { id, userId, deletedAt: null },
          include: { checks: true },
        })
        if (!row) throw new NotFoundException("Screening record not found")
        withUiLanguage("en-US", () => assertPaid(row))
        if (expectedVersion && expectedVersion !== exportVersion(row.reportRevision))
          throw new ExportConflict("EXPORT_OUTDATED")
        const saved = input(row.input)
        if (!progress(row).completed) throw new ExportConflict("REPORT_DATA_INCOMPLETE")
        for (const kind of executableKinds(saved)) {
          const check = row.checks.find(c => c.kind === kind)
          if (!check || !["FAILED", "PARTIAL", "COMPLETED"].includes(check.status))
            throw new ExportConflict("REPORT_DATA_INCOMPLETE")
          if (check.status === "FAILED") continue
          const out = output(check.output)
          if (
            kind === "tm"
              ? !out.text
              : saved.images.some(image => {
                  const u = out.units[image.id]
                  return (
                    !u ||
                    (u.status === "COMPLETED"
                      ? !u.complete
                      : check.status !== "PARTIAL" || u.status !== "FAILED")
                  )
                })
          )
            throw new ExportConflict("REPORT_DATA_INCOMPLETE")
        }
        try {
          return (await hydrateTasks(tx, [row], true))[0]
        } catch (error) {
          if (error instanceof ConflictException && !(error instanceof ExportConflict))
            throw new ExportConflict("LEGACY_REPORT_UNSUPPORTED")
          throw error
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }
    )
    const loaded = Date.now()
    const saved = input(task.input)
    const listingImages = new Set(saved.tm?.images?.map(p => p.url))
    const uploads = new Map(saved.images.map(p => [`upload:${p.id}`, p.key]))
    const urls = new Map<string, number>()
    const html = patentReportHtml(
      task,
      id => `upload:${id}`,
      url => {
        const index = urls.get(url) ?? urls.size
        urls.set(url, index)
        return `<img data-asset="${index}">`
      }
    )

    // 获取公开图片后再交给离线 HTML 模板；同一图样在多个来源中出现时只下载一次。
    const assets: string[] = []
    const entries = [...urls.keys()]
    let missing = 0
    for (let i = 0; i < entries.length; i += 8) {
      assets.push(
        ...(await Promise.all(
          entries.slice(i, i + 8).map(async url => {
            try {
              const key = uploads.get(url)
              let bytes: Buffer
              if (key) bytes = await this.queries.imageBytes(key)
              else if (listingImages.has(url)) bytes = await this.queries.listingImageBytes(url)
              else
                bytes = await downloadPublicFile(url, {
                  maxBytes: 10 * 1024 * 1024,
                  timeoutMs: 10_000,
                  accept: "image/*",
                })
              const jpeg = await sharp(bytes, { limitInputPixels: 40_000_000 })
                .rotate()
                .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
                .flatten({ background: "white" })
                .jpeg({ quality: 82 })
                .toBuffer()
              return `<img src="data:image/jpeg;base64,${jpeg.toString("base64")}">`
            } catch {
              missing++
              return "<em>Image unavailable</em>"
            }
          })
        ))
      )
    }
    const prepared = Date.now()
    const result = await this.pdf.renderPdf(
      html.replace(/<img data-asset="(\d+)">/g, (_, n: string) => assets[Number(n)])
    )
    this.logger.log(
      `Patent PDF task=${id} dataMs=${loaded - start} prepareMs=${prepared - loaded} renderMs=${Date.now() - prepared} images=${entries.length} missing=${missing} bytes=${result.length}`
    )
    return result
  }
}
