import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common"
import { Interval } from "@nestjs/schedule"
import { PatentQueryExport, Prisma } from "@prisma/client"
import { withUiLanguage } from "../common/i18n/request-language"
import { OssService } from "../oss/oss.service"
import { PrismaService } from "../prisma/prisma.service"
import {
  ExportConflict,
  ExportErrorCode,
  exportFailure,
  exportVersion,
} from "./patent-query-export.contract"
import { PatentQueryPdfService } from "./patent-query-pdf.service"
import { reportTitle } from "./patent-query.constants"
import { input, PAID } from "./patent-query.types"

const taskHeader = { reportRevision: true, status: true, userId: true } as const
const notFound = () => new NotFoundException("Screening record not found")
const keyFor = (job: PatentQueryExport) => `patent-query-exports/${job.taskId}/${job.id}.pdf`
function state(job: PatentQueryExport) {
  return {
    exportId: job.id,
    reportVersion: job.reportVersion,
    status: job.status,
    ...(job.status === "FAILED" && { error: exportFailure(job.errorCode as ExportErrorCode) }),
  }
}
function eligible(status: string) {
  if (!PAID.includes(status)) throw new ExportConflict("REPORT_NOT_SETTLED")
}

@Injectable()
export class PatentQueryExportService {
  private readonly logger = new Logger(PatentQueryExportService.name)
  private busy = false
  constructor(
    private readonly db: PrismaService,
    private readonly pdf: PatentQueryPdfService,
    private readonly oss: OssService
  ) {}

  async create(userId: number, taskId: number) {
    const job = await this.db.$transaction(
      async tx => {
        // Same lock as annotation edits and soft deletion. Duplicate clicks share one version.
        const [task] = await tx.$queryRaw<{ reportRevision: number; status: string }[]>`
        SELECT reportRevision,status FROM PatentQueryTask
        WHERE id=${taskId} AND userId=${userId} AND deletedAt IS NULL FOR UPDATE`
        if (!task) throw notFound()
        eligible(task.status)
        const reportVersion = exportVersion(task.reportRevision)
        const old = await tx.patentQueryExport.findUnique({
          where: { taskId_reportVersion: { taskId, reportVersion } },
        })
        if (old) {
          if (old.status === "FAILED" && exportFailure(old.errorCode as ExportErrorCode).retryable)
            return tx.patentQueryExport.update({
              where: { id: old.id },
              data: { status: "QUEUED", errorCode: null },
            })
          return old
        }
        const legacy = await tx.$queryRaw<{ found: number }[]>`
        SELECT 1 AS found FROM PatentQueryCheck c WHERE c.taskId=${taskId} AND
          (JSON_CONTAINS_PATH(c.output,'one','$.text.words','$.cache') OR
           JSON_EXTRACT(c.output,'$.units.*.matches') IS NOT NULL OR EXISTS (
             SELECT 1 FROM PatentQueryResult r WHERE r.checkId=c.id AND r.imageId IS NULL
               AND JSON_CONTAINS_PATH(r.data,'one','$.marks'))) LIMIT 1`
        if (legacy.length) throw new ExportConflict("LEGACY_REPORT_UNSUPPORTED")
        const row = await tx.patentQueryTask.findUniqueOrThrow({
          where: { id: taskId },
          select: { input: true },
        })
        const title = withUiLanguage("en-US", () => reportTitle(input(row.input)))
        const safeTitle = Array.from(title.replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, "_"))
          .slice(0, 80)
          .join("")
        return tx.patentQueryExport.create({
          data: { taskId, reportVersion, filename: `Patent report-${safeTitle}-${taskId}.pdf` },
        })
      },
      { timeout: 30_000 }
    )
    if (job.status === "READY" && !(await this.exists(job))) {
      await this.db.patentQueryExport.updateMany({
        where: { id: job.id, status: "READY", attempt: job.attempt },
        data: { status: "QUEUED", errorCode: null },
      })
      return this.status(userId, taskId, job.id)
    }
    return state(job)
  }

  private async findVisible(userId: number, taskId: number, id: string) {
    const job = await this.db.patentQueryExport.findFirst({
      where: { id, taskId, task: { userId, deletedAt: null } },
      include: { task: { select: taskHeader } },
    })
    if (!job) throw notFound()
    eligible(job.task.status)
    return job
  }

  async status(userId: number, taskId: number, id: string) {
    return state(await this.findVisible(userId, taskId, id))
  }

  private async exists(job: PatentQueryExport) {
    try {
      return await this.oss.hasPrivatePdf(keyFor(job))
    } catch {
      throw new ServiceUnavailableException(exportFailure("EXPORT_STORAGE_UNAVAILABLE"))
    }
  }

  async download(userId: number, taskId: number, id: string) {
    const job = await this.findVisible(userId, taskId, id)
    if (job.reportVersion !== exportVersion(job.task.reportRevision))
      throw new ExportConflict("EXPORT_OUTDATED")
    if (job.status !== "READY" || !(await this.exists(job)))
      throw new ExportConflict("EXPORT_NOT_READY")
    // OSS HEAD can take time. Recheck access and revision immediately before issuing the URL.
    const current = await this.findVisible(userId, taskId, id)
    if (current.reportVersion !== exportVersion(current.task.reportRevision))
      throw new ExportConflict("EXPORT_OUTDATED")
    if (current.status !== "READY") throw new ExportConflict("EXPORT_NOT_READY")
    return { ...this.oss.signPrivatePdf(keyFor(job)), filename: job.filename }
  }

  @Interval(2000)
  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const available: Prisma.PatentQueryExportWhereInput = {
        OR: [
          { status: "QUEUED" },
          { status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - 120_000) } },
        ],
      }
      const job = await this.db.patentQueryExport.findFirst({
        where: available,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        include: { task: { select: { ...taskHeader, deletedAt: true } } },
      })
      if (!job) return
      const claimed = await this.db.patentQueryExport.updateMany({
        where: { id: job.id, attempt: job.attempt, ...available },
        data: { status: "PROCESSING", attempt: { increment: 1 }, errorCode: null },
      })
      if (!claimed.count) return
      const owner = { id: job.id, status: "PROCESSING" as const, attempt: job.attempt + 1 }
      const heartbeat = setInterval(() => {
        void this.db.patentQueryExport
          .updateMany({ where: owner, data: { updatedAt: new Date() } })
          .catch(() => this.logger.warn(`Could not renew PDF export ${job.id}`))
      }, 30_000)
      try {
        if (job.task.deletedAt || job.reportVersion !== exportVersion(job.task.reportRevision))
          throw new ExportConflict("EXPORT_OUTDATED")
        if (!(await this.exists(job))) {
          const bytes = await this.pdf.export(job.task.userId, job.taskId, job.reportVersion)
          const encoded = encodeURIComponent(job.filename).replace(
            /['()*]/g,
            c => "%" + c.charCodeAt(0).toString(16)
          )
          try {
            await this.oss.putPrivatePdf(
              keyFor(job),
              bytes,
              `attachment; filename="patent-report-${job.taskId}.pdf"; filename*=UTF-8''${encoded}`
            )
          } catch {
            throw new ServiceUnavailableException(exportFailure("EXPORT_STORAGE_UNAVAILABLE"))
          }
        }
        await this.db.patentQueryExport.updateMany({ where: owner, data: { status: "READY" } })
      } catch (error) {
        const code: ExportErrorCode =
          error instanceof ExportConflict
            ? error.code
            : error instanceof NotFoundException
              ? "EXPORT_OUTDATED"
              : error instanceof ServiceUnavailableException &&
                  (error.getResponse() as { code?: string }).code === "EXPORT_STORAGE_UNAVAILABLE"
                ? "EXPORT_STORAGE_UNAVAILABLE"
                : "PDF_RENDER_FAILED"
        await this.db.patentQueryExport.updateMany({
          where: owner,
          data: { status: "FAILED", errorCode: code },
        })
        this.logger.warn(`PDF export ${job.id} failed (${code})`)
      } finally {
        clearInterval(heartbeat)
      }
    } catch {
      this.logger.warn("Patent PDF export scheduler temporarily unavailable")
    } finally {
      this.busy = false
    }
  }
}
