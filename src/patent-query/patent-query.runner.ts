import { uiText } from "../common/i18n/request-language"
import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { savedUiLanguage } from "../common/i18n/ai-language"
import { withUiLanguage } from "../common/i18n/request-language"
import { Interval } from "@nestjs/schedule"
import type { PatentQueryCheck } from "@prisma/client"
import { createHash } from "node:crypto"
import { TrohubError, TrohubProvider } from "../common/providers/trohub.provider"
import { PrismaService } from "../prisma/prisma.service"
import { imageTarget, inactive, progress } from "./patent-query.report"
import { PatentQueryService } from "./patent-query.service"
import { hydrateTasks } from "./patent-query.storage"
import {
  Bag,
  Kind,
  TERMINAL,
  Task,
  Unit,
  input,
  obj,
  output,
  rows,
  str,
} from "./patent-query.types"

const unit = (): Unit => ({
  status: "PROCESSING",
  error: null,
  result: {},
  matches: [],
  offset: 0,
  complete: false,
})
const incomplete = () => new TrohubError(502, "INVALID_RESULT", "结果未完整获取")
@Injectable()
export class PatentQueryRunner implements OnModuleInit {
  private readonly logger = new Logger(PatentQueryRunner.name)
  private busy = false
  private cursor = 0
  private readonly retry = new Map<string, { count: number; at: number }>()
  private readonly pollCount = new Map<number, number>()
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: PatentQueryService,
    private readonly provider: TrohubProvider
  ) {}
  onModuleInit() {
    void this.tick()
  }
  @Interval(5000)
  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const tasks = await this.prisma.patentQueryTask.findMany({
        where: {
          id: { gt: this.cursor },
          deletedAt: null,
          status: { in: ["RUNNING", "SETTLING"] },
        },
        include: { checks: true },
        orderBy: { id: "asc" },
        take: 20,
      })
      this.cursor = tasks.length === 20 ? tasks[tasks.length - 1].id : 0
      // 一轮只处理每项的一步，防止一个长任务占满账号额度。
      const hydrated = await hydrateTasks(this.prisma, tasks)
      await Promise.all(
        hydrated.map(task =>
          withUiLanguage(savedUiLanguage(input(task.input).resolved?.responseLanguage), () => this.advance(task)).catch(() =>
            this.logger.warn(`检测任务 ${task.id} 本轮处理失败，将从已存进度恢复`)
          )
        )
      )
    } catch {
      this.logger.warn("专利检测调度暂不可用，将在下一轮恢复")
    } finally {
      this.busy = false
    }
  }
  private ready(key: string) {
    return (this.retry.get(key)?.at ?? 0) <= Date.now()
  }
  private delay(key: string, count: number, ms: number) {
    this.retry.set(key, { count, at: Date.now() + ms })
  }
  async advance(task: Task) {
    if (task.status === "SETTLING") {
      if (!task.error || task.error.startsWith("[SETTLEMENT_RETRYABLE]")) {
        const key = `settle:${task.id}`
        if (this.ready(key)) {
          this.delay(key, 0, 30000)
          await this.service.settle(task.userId, task.id, false)
        }
      }
      return
    }
    if (!this.provider.enabled()) return
    await Promise.all(
      task.checks.filter(c => !TERMINAL.includes(c.status)).map(c => this.check(task, c))
    )
    const latest = await this.service.getTask(task.userId, task.id)
    if (latest.checks.some(c => !TERMINAL.includes(c.status))) return
    const p = progress(latest)
    await this.prisma.patentQueryTask.updateMany({
      where: { id: task.id, status: "RUNNING" },
      data: {
        status: p.completed ? "SETTLING" : "FAILED",
        finishedAt: new Date(),
        error: p.completed ? null : uiText("全部检测失败，未扣积分", "All checks failed. No credits were charged."),
      },
    })
    for (const c of task.checks) {
      this.pollCount.delete(c.id)
      for (const key of this.retry.keys()) if (key.startsWith(`${c.id}:`)) this.retry.delete(key)
    }
    if (p.completed) await this.service.settle(task.userId, task.id, false)
  }
  private async fail(check: PatentQueryCheck, message: string, imageId?: string) {
    await this.service.mutateCheck(
      check.id,
      out => {
        if (imageId) out.units[imageId] ??= unit()
        for (const [id, u] of Object.entries(out.units))
          if ((!imageId || id === imageId) && !TERMINAL.includes(u.status)) {
            u.status = "FAILED"
            u.error = message
            u.complete = false
          }
      },
      imageId
        ? {}
        : {
            status: Object.values(output(check.output).units).some(u => u.status === "COMPLETED")
              ? "PARTIAL"
              : "FAILED",
            error: message,
          }
    )
  }
  private async finalFailure(
    check: PatentQueryCheck,
    key: string,
    error: unknown,
    imageId?: string
  ) {
    if (error instanceof TrohubError && (error.rateLimited || error.unavailable)) {
      await this.service.mutateCheck(check.id, () => undefined, { error: error.message })
      this.delay(key, this.retry.get(key)?.count ?? 0, 60000)
      return
    }
    const count = (this.retry.get(key)?.count ?? 0) + 1
    if (count >= 5 || (error instanceof TrohubError && (error.invalidInput || error.notFound))) {
      await this.fail(
        check,
        error instanceof TrohubError
          ? uiText(`${error.message}；结果未完整获取，不能据此排除风险`, `${error.message}. Results are incomplete; risk cannot be ruled out.`)
          : "结果未完整获取，不能据此排除风险",
        imageId
      )
      this.retry.delete(key)
    } else this.delay(key, count, [3000, 6000, 10000, 15000][count - 1])
  }
  async check(task: Task, check: PatentQueryCheck) {
    const kind = check.kind as Kind,
      key = `${check.id}:poll`
    if (!this.ready(key) || !this.ready(`${check.id}:detail`)) return
    let detail: Bag | undefined
    if (!check.upstreamTaskId) {
      let recovering = check.status !== "PENDING"
      try {
        if (check.status !== "PENDING") {
          try {
            detail = await this.provider.detail(kind, `pq-${task.id}-${kind}`)
          } catch (e) {
            if (!(e instanceof TrohubError) || !e.notFound || e.status !== 404) throw e
          }
        }
        if (!detail) {
          recovering = false
          const body = await this.service.submitBody(task, kind)
          check = await this.service.mutateCheck(
            check.id,
            out => {
              if (kind !== "tm")
                for (const image of input(task.input).images) out.units[image.id] ??= unit()
            },
            { status: "PROCESSING", error: null }
          )
          detail = await this.provider.submit(kind, body)
        }
        const taskID = str(detail.taskID)
        if (!taskID) throw incomplete()
        check = await this.service.mutateCheck(check.id, () => undefined, {
          upstreamTaskId: taskID,
          status: "PROCESSING",
          error: null,
        })
      } catch (e) {
        if (e instanceof TrohubError && (e.retryable || (recovering && e.unavailable))) {
          await this.service.mutateCheck(check.id, () => undefined, { error: e.message })
          this.delay(key, 0, e.unavailable ? 60000 : 15000)
        } else
          await this.fail(
            check,
            e instanceof TrohubError || e instanceof BadRequestException
              ? e.message
              : uiText("检测输入读取失败，请重新上传图片", "Upload the image again to retry screening")
          )
        return
      }
    }
    const saved = output(check.output),
      imageIds = input(task.input).images.map(i => i.id)
    const needDetail =
      kind === "tm" ||
      imageIds.some(
        id => !saved.units[id]?.resultReady && !TERMINAL.includes(saved.units[id]?.status ?? "")
      )
    if (needDetail) {
      try {
        detail ??= await this.provider.detail(kind, check.upstreamTaskId!)
      } catch (e) {
        if (saved.upstreamCompleted) await this.finalFailure(check, `${check.id}:detail`, e)
        else if (e instanceof TrohubError && (e.notFound || e.invalidInput))
          await this.fail(check, e.notFound ? uiText("上游结果已不可获取", "The supplier result is no longer available") : e.message)
        else {
          if (e instanceof TrohubError)
            await this.service.mutateCheck(check.id, () => undefined, { error: e.message })
          this.delay(key, 0, 60000)
        }
        return
      }
      if (check.error)
        check = await this.service.mutateCheck(check.id, () => undefined, { error: null })
      const status = str(detail.status).toLowerCase()
      if (status === "completed" && !saved.upstreamCompleted)
        check = await this.service.mutateCheck(check.id, out => {
          out.upstreamCompleted = true
        })
      if (detail.isStale === true || status === "failed") {
        await this.fail(check, uiText("检测失败，请重新检测", "Screening failed. Run the check again."))
        return
      }
      if (kind === "tm") {
        if (status === "completed") {
          const detailKey = `${check.id}:detail`
          if (!this.ready(detailKey)) return
          try {
            if (
              !Array.isArray(detail.words) ||
              Number(detail.pendingCount ?? 0) > 0 ||
              rows(detail.words).some(w => !str(w.term) || !Array.isArray(w.marks))
            )
              throw incomplete()
            if (detail.truncated === true) throw new TrohubError(410, "TRUNCATED", "结果截断")
            const text: Bag = {
              words: detail.words,
              imageOCR: rows(detail.imageOCR),
              warnings: Array.isArray(detail.warnings) ? detail.warnings : [],
            }
            await this.service.mutateCheck(
              check.id,
              out => {
                out.text = text
              },
              { status: "COMPLETED", error: null }
            )
            this.retry.delete(detailKey)
          } catch (e) {
            await this.finalFailure(check, detailKey, e)
          }
        } else this.waitForUpstream(check, key)
        return
      }
      for (const id of imageIds) {
        const existing = saved.units[id]
        if (existing?.resultReady || TERMINAL.includes(existing?.status ?? "")) continue
        const image = rows(detail.images).find(i => i.id === id),
          imageKey = `${check.id}:${id}`
        if (!this.ready(imageKey)) continue
        if (
          image?.isStale === true ||
          str(image?.status).toLowerCase() === "failed" ||
          image?.error
        ) {
          await this.service.mutateCheck(check.id, out => {
            out.units[id] ??= unit()
            out.units[id].status = "FAILED"
            out.units[id].error = uiText("该图片检测失败", "Screening failed for this image")
          })
          continue
        }
        if (str(image?.status).toLowerCase() !== "completed") {
          if (status === "completed") await this.finalFailure(check, imageKey, incomplete(), id)
          continue
        }
        try {
          if (!image?.result || typeof image.result !== "object" || Array.isArray(image.result))
            throw incomplete()
          const result: Bag = { ...obj(image.result), image: image.image }
          if (result.truncated === true || obj(result.matches).truncated === true)
            throw new TrohubError(410, "TRUNCATED", "结果截断")
          const first = result.matches
          delete result.matches
          check = await this.service.mutateCheck(check.id, out => {
            out.units[id] ??= unit()
            Object.assign(out.units[id], { result, resultReady: true })
          })
          // 首屏也必须遵循 total/hasNextPage 校验；下一页从已落库 offset 继续。
          await this.savePage(check, kind, id, first)
          this.retry.delete(imageKey)
        } catch (e) {
          await this.finalFailure(check, imageKey, e, id)
        }
      }
      if (status !== "completed") this.waitForUpstream(check, key)
    } else {
      for (const id of imageIds) {
        const u = output(check.output).units[id],
          pageKey = `${check.id}:${id}`
        if (!u?.resultReady || TERMINAL.includes(u.status) || !this.ready(pageKey)) continue
        try {
          await this.savePage(
            check,
            kind,
            id,
            await this.provider.matches(kind, check.upstreamTaskId!, id, u.offset)
          )
          if (check.error)
            check = await this.service.mutateCheck(check.id, () => undefined, { error: null })
          this.retry.delete(pageKey)
        } catch (e) {
          await this.finalFailure(check, pageKey, e, id)
        }
      }
    }
    // 从最新 JSON 汇总，避免并发的 URL/缓存更新丢失。
    const latest = await this.prisma.patentQueryCheck.findUniqueOrThrow({ where: { id: check.id } })
    const all = imageIds.map(id => output(latest.output).units[id])
    if (all.every(u => u && TERMINAL.includes(u.status))) {
      const count = all.filter(u => u.status === "COMPLETED").length
      await this.prisma.patentQueryCheck.update({
        where: { id: check.id },
        data: {
          status: count === all.length ? "COMPLETED" : count ? "PARTIAL" : "FAILED",
          error: count === all.length ? null : uiText("部分或全部图片检测失败", "Some or all image checks failed"),
        },
      })
    }
  }
  private waitForUpstream(check: PatentQueryCheck, key: string) {
    const n = (this.pollCount.get(check.id) ?? 0) + 1
    this.pollCount.set(check.id, n)
    this.delay(key, 0, n > 20 ? 60000 : 15000)
  }
  async savePage(check: PatentQueryCheck, kind: Kind, imageId: string, value: unknown) {
    const page = obj(value)
    if (page.truncated === true) throw new TrohubError(410, "TRUNCATED", "结果截断")
    if (
      !Array.isArray(page.items) ||
      typeof page.hasNextPage !== "boolean" ||
      !Number.isInteger(page.total) ||
      Number(page.total) < 0
    )
      throw incomplete()
    const items = rows(page.items)
    if (items.some(m => !Object.keys(m).length)) throw incomplete()
    const filterSimilarity = kind === "design" || kind === "gtm"
    const targets = items.map(m => imageTarget(kind, m))
    // 被过滤的 ID 不再存结果行；页指纹用于重启后识别上游重复整页，不保存全部 ID。
    // ponytail: 不识别被丢弃 ID 重新组合的旧页；上游出现这种异常时再增加逐 ID 校验。
    const fingerprint =
      filterSimilarity && targets.length && targets.every(Boolean)
        ? createHash("sha256")
            .update(JSON.stringify([...new Set(targets)].sort()))
            .digest("hex")
        : undefined
    await this.service.mutateCheck(check.id, out => {
      const u = (out.units[imageId] ??= unit())
      const seen = new Set(u.matches.map(m => imageTarget(kind, m)).filter(Boolean))
      const added = items.filter(m => {
        const id = imageTarget(kind, m)
        if (!id) return true
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      const offset = u.offset + items.length,
        total = Number(page.total)
      if (
        (fingerprint && u.pageFingerprints?.includes(fingerprint)) ||
        (items.length > 0 && u.offset > 0 && !added.length) ||
        (page.hasNextPage && (!items.length || !added.length || offset >= total)) ||
        (!page.hasNextPage && offset !== total)
      )
        throw incomplete()
      u.matches.push(
        ...added.filter(
          m =>
            !filterSimilarity ||
            inactive(m) ||
            typeof m.score !== "number" ||
            !Number.isFinite(m.score) ||
            m.score < 0 ||
            m.score > 1 ||
            m.score > 0.6
        )
      )
      u.offset = offset
      u.complete = !page.hasNextPage
      if (u.complete) delete u.pageFingerprints
      else if (fingerprint) (u.pageFingerprints ??= []).push(fingerprint)
      u.status = u.complete ? "COMPLETED" : "PROCESSING"
      u.error = null
    })
  }
}
