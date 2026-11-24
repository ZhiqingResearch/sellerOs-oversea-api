import { localizeErrorMessage, uiLanguage, uiText } from "../common/i18n/request-language"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import axios from "axios"
import { createHash } from "node:crypto"
import sharp from "sharp"
import { CrawlerProvider } from "../common/providers/crawler.provider"
import { TrohubError, TrohubProvider } from "../common/providers/trohub.provider"
import { beijingDayEnd, beijingDayStart } from "../common/utils/datetime"
import { OssService } from "../oss/oss.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import {
  ContextQueryDto,
  CreatePatentQueryDto,
  DecisionDto,
  ImportListingDto,
  QueryPatentQueryDto,
  QuotePatentQueryDto,
  RefreshImagesDto,
  ResultPageDto,
  ResultsQueryDto,
  RiskPageDto,
} from "./dto/patent-query.dto"
import {
  executableKinds,
  listingImageUrl,
  normalizeInput,
  quote,
  reportTitle,
  sameInput,
} from "./patent-query.constants"
import { annotations, buildReport, dateValue, imageTarget, progress } from "./patent-query.report"
import {
  assertPaid,
  cards,
  contextPage,
  decisionTarget,
  detailRow,
  LightReport,
  matches,
  page,
  readLight,
  readLightBatch,
  resultPage,
  riskPage,
  word,
  wordId,
} from "./patent-query.results"
import { cacheIdentity, hydrateChecks, hydrateTasks, saveResults } from "./patent-query.storage"
import {
  Bag,
  Input,
  input,
  json,
  Kind,
  KINDS,
  obj,
  Output,
  output,
  PAID,
  rows,
  str,
  Task,
  TERMINAL,
} from "./patent-query.types"

type CompactDecisionResponse = {
  taskId: number
  changed: DecisionDto & { decisionKey: string; dismissed: boolean; flagged: boolean }
  refresh: string[]
  syncStatus: string
  message: string
}
type CompactTodoResponse = { taskId: number; todoId: string; done: boolean; refresh: string[] }

@Injectable()
export class PatentQueryService {
  private readonly logger = new Logger(PatentQueryService.name)
  private readonly refreshing = new Map<string, Promise<unknown>>()
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly provider: TrohubProvider,
    private readonly oss: OssService,
    private readonly crawler: CrawlerProvider
  ) {}
  quote(userId: number, dto: QuotePatentQueryDto) {
    const i = normalizeInput(dto, userId)
    const q = quote(i)
    return {
      ...q,
      coverage: i.sites.flatMap(site =>
        KINDS.filter(kind => i[kind]).map(kind => ({
          site,
          kind,
          supported: site === "US" || kind === "copy",
        }))
      ),
    }
  }
  async imageBytes(key: string) {
    try {
      const bytes = await this.oss.readObject(key, 10 * 1024 * 1024)
      const meta = await sharp(bytes).metadata()
      if (
        !meta.width ||
        !meta.height ||
        Math.max(meta.width, meta.height) < 200 ||
        !["jpeg", "png", "webp"].includes(meta.format ?? "")
      )
        throw new BadRequestException("图片须为 JPG/PNG/WebP，最长边至少 200 像素")
      return bytes
    } catch (e) {
      if (e instanceof BadRequestException) throw e
      throw new BadRequestException("图片读取失败，请重新上传")
    }
  }
  async listingImageBytes(url: string) {
    const safeUrl = listingImageUrl(url)
    try {
      const limit = 10 * 1024 * 1024
      const response = await axios.get<ArrayBuffer>(safeUrl, {
        responseType: "arraybuffer",
        timeout: 15_000,
        maxRedirects: 0,
        proxy: false,
        maxContentLength: limit,
        maxBodyLength: limit,
      })
      const bytes = Buffer.from(response.data)
      if (!bytes.length || bytes.length > limit) throw new Error("图片大小超限")
      const meta = await sharp(bytes).metadata()
      if (
        !meta.width ||
        !meta.height ||
        Math.max(meta.width, meta.height) < 200 ||
        !["jpeg", "png", "webp"].includes(meta.format ?? "")
      )
        throw new Error("图片格式不支持")
      return bytes
    } catch {
      throw new BadRequestException(
        "商品图读取失败，请确认图片为 10MB 以内的 JPG/PNG/WebP，最长边至少 200 像素后重试"
      )
    }
  }
  async create(userId: number, dto: CreatePatentQueryDto) {
    const i = normalizeInput(dto, userId)
    i.resolved.responseLanguage = uiLanguage()
    const compareClassCodes = dto.tm?.classCodes != null
    const replay = await this.replay(userId, dto.requestId, i, compareClassCodes)
    if (replay) return { created: false, data: replay }
    this.provider.assertConfigured()
    const q = quote(i)
    await this.usage.assertExactCreditsAffordable(userId, q.quotedCredits)
    for (const image of i.images) await this.imageBytes(image.key)
    try {
      const task = await this.prisma.patentQueryTask.create({
        data: {
          userId,
          requestId: dto.requestId,
          input: json(i),
          quotedCredits: q.quotedCredits,
          checks: { create: q.executableKinds.map(kind => ({ kind })) },
        },
        include: { checks: true },
      })
      return { created: true, data: await this.overview(userId, task.id) }
    } catch (e) {
      if (obj(e).code === "P2002") {
        const existing = await this.replay(userId, dto.requestId, i, compareClassCodes)
        if (existing) return { created: false, data: existing }
      }
      throw e
    }
  }
  private async replay(userId: number, requestId: string, i: Input, compareClassCodes: boolean) {
    // 绕过全局软删读过滤，已删同键也必须冲突，不能再次消费上游。
    const hits = await this.prisma.$queryRaw<
      { id: number | bigint; deletedAt: Date | null }[]
    >`SELECT id, deletedAt FROM PatentQueryTask WHERE userId=${userId} AND requestId=${requestId} LIMIT 1`
    if (!hits.length) return null
    if (hits[0].deletedAt) throw new ConflictException("该请求记录已删除，请使用新的请求 ID")
    const task = await this.taskInput(userId, Number(hits[0].id))
    if (!sameInput(i, task.input, compareClassCodes))
      throw new ConflictException("相同请求 ID 的检测内容不一致")
    return this.overview(userId, Number(hits[0].id))
  }
  async taskInput(userId: number, id: number) {
    const task = await this.prisma.patentQueryTask.findFirst({
      where: { id, userId, deletedAt: null },
      select: { input: true },
    })
    if (!task) throw new NotFoundException("检测记录不存在")
    return { taskId: id, input: task.input }
  }
  async getTask(userId: number, id: number): Promise<Task> {
    const task = await this.prisma.patentQueryTask.findFirst({
      where: { id, userId, deletedAt: null },
      include: { checks: true },
    })
    if (!task) throw new NotFoundException("检测记录不存在")
    return (await hydrateTasks(this.prisma, [task]))[0]
  }
  private lightRead<T>(
    userId: number,
    id: number,
    fn: (light: LightReport, tx: Prisma.TransactionClient) => T | Promise<T>,
    paid = true
  ) {
    return this.prisma.$transaction(async tx => fn(await readLight(tx, userId, id, paid), tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    })
  }
  private presentOverview(light: LightReport) {
    const t = light.task,
      paid = PAID.includes(t.status),
      i = input(t.input)
    const report = paid ? light.report : null
    return {
      id: t.id,
      title: reportTitle(i),
      status: t.status,
      input: t.input,
      images: i.images.map(image => ({ ...image, url: this.oss.signedReadUrl(image.key) })),
      billing: {
        quotedCredits: t.quotedCredits,
        chargedCredits: paid ? t.quotedCredits : 0,
        state: paid
          ? "CHARGED"
          : t.status === "FAILED"
            ? "FREE"
            : t.error?.startsWith("[PAYMENT_REQUIRED]")
              ? "PAYMENT_REQUIRED"
              : "PENDING",
        error: t.error ? localizeErrorMessage(t.error.replace(/^\[[A-Z_]+\]\s*/, "")) : null,
      },
      progress: progress(t),
      createdAt: t.createdAt,
      finishedAt: t.finishedAt,
      ...(report
        ? {
            reportSummary: report.summary,
            coverage: report.coverage,
            gapCount: report.gaps.length,
            todoTotal: report.summary.todoTotal,
            todoDone: report.summary.todoDone,
            modules: KINDS.filter(kind => !!i[kind]).map((kind: Kind) => ({
              kind,
              countUnit: kind === "tm" ? "word" : "match",
              ...(kind === "tm"
                ? { facets: riskPage(rows(report.tm.words), new RiskPageDto()).facets }
                : {
                    images: i.images.map(image => ({
                      imageId: image.id,
                      facets: riskPage(matches(light, kind, image.id), new RiskPageDto()).facets,
                    })),
                  }),
            })),
          }
        : {}),
    }
  }
  overview(userId: number, id: number) {
    return this.lightRead(userId, id, l => this.presentOverview(l), false)
  }
  results(userId: number, id: number, dto: ResultsQueryDto) {
    return this.lightRead(userId, id, async (l, tx) => {
      const p = resultPage(l, dto)
      return { ...p, items: dto.kind === "tm" ? p.items : await cards(tx, l, p.items) }
    })
  }
  marks(userId: number, id: number, wordRef: string, dto: RiskPageDto) {
    return this.lightRead(userId, id, async (l, tx) => {
      const w = word(l, wordRef),
        p = riskPage(rows(w.marks), dto)
      return {
        taskId: id,
        wordId: wordRef,
        term: w.term,
        countUnit: "mark",
        ...p,
        items: await cards(tx, l, p.items),
      }
    })
  }
  rowDetail(userId: number, id: number, rowId: string, dto?: ResultPageDto) {
    return this.lightRead(userId, id, (l, tx) => detailRow(tx, l, rowId, dto))
  }
  todos(userId: number, id: number, dto: ResultPageDto, todoId?: string) {
    return this.lightRead(userId, id, l => {
      if (!todoId)
        return {
          taskId: id,
          ...page(
            l.report.todos.map(({ id, kind, title, done, action, targets }) => ({
              id,
              kind,
              title,
              done,
              action,
              targetCount: targets.length,
            })),
            dto
          ),
        }
      const todo = l.report.todos.find(t => t.id === todoId)
      if (!todo) throw new BadRequestException("待办不存在")
      return {
        taskId: id,
        todoId,
        ...page(
          todo.targets.map(target => {
            const todoWord =
              todo.kind === "tm"
                ? rows(l.report.tm.words).find(
                    w =>
                      `tm:${encodeURIComponent(str(w.term).trim().toLowerCase())}:prd` === todo.id
                  )
                : undefined
            const candidates = todoWord
              ? rows(todoWord.marks)
              : matches(l, todo.kind, target.imageId)
            const m = target.targetId
              ? candidates.find(m => m.targetId === target.targetId)
              : target.matchIndex !== undefined
                ? candidates[target.matchIndex]
                : undefined
            const w =
              todo.kind === "tm"
                ? rows(l.report.tm.words).find(w =>
                    rows(w.marks).some(mark => mark._rowId === m?._rowId)
                  )
                : undefined
            return {
              ...target,
              ...(m ? { rowId: m._rowId, decisionKey: m.decisionKey } : {}),
              ...(w ? { wordId: wordId(w) } : {}),
            }
          }),
          dto
        ),
      }
    })
  }
  context(userId: number, id: number, dto: ContextQueryDto) {
    return this.lightRead(userId, id, (l, tx) => contextPage(tx, l, dto))
  }
  async detail(userId: number, id: number) {
    return this.overview(userId, id)
  }
  async list(userId: number, dto: QueryPatentQueryDto) {
    return this.prisma.$transaction(tx => this.listRows(userId, dto, tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    })
  }
  private async listRows(userId: number, dto: QueryPatentQueryDto, db: Prisma.TransactionClient) {
    const start = dto.startDate ? beijingDayStart(dto.startDate) : null,
      end = dto.endDate ? beijingDayEnd(dto.endDate) : null
    if ((dto.startDate && !start) || (dto.endDate && !end) || (start && end && start > end))
      throw new BadRequestException("日期范围不合法")
    const conditions = [
      Prisma.sql`userId=${userId}`,
      Prisma.sql`deletedAt IS NULL`,
      dto.scope === "active"
        ? Prisma.sql`status IN ('RUNNING','SETTLING')`
        : Prisma.sql`status IN ('COMPLETED','PARTIAL')`,
    ]
    if (start) conditions.push(Prisma.sql`createdAt>=${start}`)
    if (end) conditions.push(Prisma.sql`createdAt<=${end}`)
    if (dto.keyword?.trim()) {
      const title = Prisma.sql`LEFT(COALESCE(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(input,'$.design.productName'))),''),NULLIF(TRIM(CONCAT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input,'$.tm.brand')),''),' ',COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input,'$.tm.title')),''))),''),NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(input,'$.images[0].name'))),''),'产品专利查询'),500)`
      conditions.push(Prisma.sql`LOCATE(${dto.keyword.trim()},${title})>0`)
    }
    const where = Prisma.join(conditions, " AND ")
    const [ids, counts] = await Promise.all([
      db.$queryRaw<{ id: number | bigint }[]>(
        Prisma.sql`SELECT id FROM PatentQueryTask WHERE ${where} ORDER BY createdAt DESC,id DESC LIMIT ${dto.pageSize} OFFSET ${(dto.page - 1) * dto.pageSize}`
      ),
      db.$queryRaw<{ total: bigint }[]>(
        Prisma.sql`SELECT COUNT(*) AS total FROM PatentQueryTask WHERE ${where}`
      ),
    ])
    {
      const items = []
      for (const light of await readLightBatch(
        db,
        userId,
        ids.map(row => Number(row.id))
      )) {
        const t = light.task,
          i = input(t.input),
          paid = PAID.includes(t.status)
        items.push({
          id: t.id,
          title: reportTitle(i),
          status: t.status,
          createdAt: t.createdAt,
          finishedAt: t.finishedAt,
          durationMs: t.finishedAt ? +t.finishedAt - +t.createdAt : null,
          imageCount: i.images.length,
          kinds: executableKinds(i),
          sites: i.sites,
          billing: {
            quotedCredits: t.quotedCredits,
            chargedCredits: paid ? t.quotedCredits : 0,
            state: paid
              ? "CHARGED"
              : t.status === "FAILED"
                ? "FREE"
                : t.error?.startsWith("[PAYMENT_REQUIRED]")
                  ? "PAYMENT_REQUIRED"
                  : "PENDING",
            error: t.error ? localizeErrorMessage(t.error.replace(/^\[[A-Z_]+\]\s*/, "")) : null,
          },
          ...(dto.scope === "history"
            ? {
                summary: paid
                  ? buildReport(t, { light: true, summaryOnly: true }).summary
                  : undefined,
              }
            : {}),
        })
      }
      const total = Number(counts[0].total)
      return {
        items,
        total,
        page: dto.page,
        pageSize: dto.pageSize,
        totalPages: Math.ceil(total / dto.pageSize),
      }
    }
  }

  async remove(userId: number, id: number) {
    return this.prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<
        { status: string; deletedAt: Date | null }[]
      >`SELECT status,deletedAt FROM PatentQueryTask WHERE id=${id} AND userId=${userId} FOR UPDATE`
      if (!locked.length) throw new NotFoundException("检测记录不存在")
      if (locked[0].deletedAt) return { deleted: true }
      if (!PAID.includes(locked[0].status)) throw new ConflictException("仅可删除已完成报告")
      await tx.patentQueryTask.update({ where: { id }, data: { deletedAt: new Date() } })
      return { deleted: true }
    })
  }
  async importListing(dto: ImportListingDto) {
    let asin = dto.input.trim().toUpperCase(),
      marketplace = dto.marketplace ?? "US"
    const domains: Record<string, string> = {
      "amazon.com": "US",
      "amazon.co.uk": "GB",
      "amazon.de": "DE",
      "amazon.fr": "FR",
      "amazon.it": "IT",
      "amazon.es": "ES",
      "amazon.co.jp": "JP",
    }
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      let url: URL
      try {
        url = new URL(dto.input.trim())
      } catch {
        throw new BadRequestException("请输入有效 ASIN 或亚马逊商品链接")
      }
      const domain = Object.keys(domains).find(
        d => url.hostname === d || url.hostname === `www.${d}` || url.hostname === `m.${d}`
      )
      if (!domain || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new BadRequestException("仅支持指定亚马逊站点的商品链接")
      asin = (
        url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Za-z0-9]{10})(?:\/|$)/)?.[1] ?? ""
      ).toUpperCase()
      if (!asin) throw new BadRequestException("链接中未找到 ASIN，请直接填写 ASIN")
      marketplace = domains[domain]
    }
    try {
      const domain = Object.keys(domains).find(d => domains[d] === marketplace)!
      const item = obj(await this.crawler.fetchPdp(`https://www.${domain}/dp/${asin}`))
      const text = (value: unknown) =>
        (Array.isArray(value)
          ? value.filter(v => typeof v === "string").join("\n")
          : str(value)
        ).trim()
      const mainTitle = text(item.title),
        secondTitle = text(item.second_title)
      const title = secondTitle.toLowerCase().startsWith(mainTitle.toLowerCase())
        ? secondTitle
        : [mainTitle, secondTitle].filter(Boolean).join(" ")
      if (!title) throw new NotFoundException("未获取到该商品信息，请手动填写")
      const description = text(item.description)
      const images: { id: string; url: string; name: string }[] = []
      const warnings = description ? [] : [uiText("未获取完整商品描述，可手动补充", "The full description was unavailable. You can add it manually.")]
      const seen = new Set<string>()
      const otherImages: unknown[] = Array.isArray(item.otherImagesUrl) ? item.otherImagesUrl : []
      const candidates = [item.imageUrl, ...otherImages]
      for (const [index, value] of candidates.entries()) {
        if (!str(value).trim()) continue
        try {
          const url = listingImageUrl(str(value).trim())
          if (seen.has(url)) continue
          seen.add(url)
          images.push({
            id: `listing-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`,
            url,
            name: index === 0 ? uiText("商品主图", "Main product image") : uiText(`商品附图${index}`, `Additional product image ${index}`),
          })
        } catch {
          if (!warnings.includes(uiText("部分商品图地址无效，已忽略，请手动核对", "Some invalid image URLs were skipped. Check the product images.")))
            warnings.push(uiText("部分商品图地址无效，已忽略，请手动核对", "Some invalid image URLs were skipped. Check the product images."))
        }
      }
      return {
        asin,
        marketplace,
        brand: text(item.brand),
        title,
        bullets: text(item.bullets),
        description,
        images,
        warnings,
      }
    } catch (e) {
      if (e instanceof NotFoundException) throw e
      const code = str(obj(e).code)
      this.logger.warn(
        `Listing 抓取失败 asin=${asin} marketplace=${marketplace} code=${/^[A-Z0-9_]{1,64}$/i.test(code) ? code : "UPSTREAM_ERROR"}`
      )
      throw new ServiceUnavailableException("商品信息导入失败，请稍后重试或手动填写")
    }
  }
  async mutateCheck(
    id: number,
    fn: (out: Output) => void,
    patch: Prisma.PatentQueryCheckUpdateInput = {}
  ) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM PatentQueryCheck WHERE id=${id} FOR UPDATE`
      const row = await tx.patentQueryCheck.findUniqueOrThrow({ where: { id } })
      const [hydrated] = await hydrateChecks(tx, [row])
      const data = output(hydrated.output)
      fn(data)
      const compact = await saveResults(tx, id, data)
      const updated = await tx.patentQueryCheck.update({
        where: { id },
        data: { ...patch, output: json(compact) },
      })
      return { ...updated, output: json(data) as Prisma.JsonObject }
    })
  }
  async submitBody(task: Task, kind: Kind): Promise<Bag> {
    const i = input(task.input),
      body: Bag = { title: reportTitle(i), lang: "zh" }
    if (kind === "tm") {
      Object.assign(body, {
        productTitle: [i.tm?.brand, i.tm?.title].filter(Boolean).join(" "),
        shortDesc: i.tm?.bullets,
        desc: i.tm?.description,
        markTypes: ["text"],
        skipStopWords: true,
        skipNumbers: true,
      })
      if (i.resolved.classCodes.length) body.classCodes = i.resolved.classCodes
      if (i.tm?.includeImageText && (i.images.length || i.tm.images?.length)) {
        const images: Bag[] = []
        for (const image of i.images)
          images.push({
            imageID: image.id,
            base64: (await this.imageBytes(image.key)).toString("base64"),
          })
        for (const image of i.tm.images ?? [])
          images.push({
            imageID: image.id,
            base64: (await this.listingImageBytes(image.url)).toString("base64"),
          })
        body.images = images
      }
    } else {
      body.images = i.images.map(image => ({
        imageID: image.id,
        image: this.oss.signedReadUrl(image.key),
        ...(kind === "copy"
          ? {}
          : {
              countries: ["US"],
              removeBg: kind === "design" ? i.design?.removeBg : i.gtm?.removeBg,
            }),
        ...(kind === "design"
          ? {
              ...(i.design?.productName ? { productName: i.design.productName } : {}),
              rerank: i.design?.rerank,
              ...(i.design?.locs?.length ? { locs: i.design.locs } : {}),
            }
          : {}),
      }))
    }
    return body
  }
  async settle(userId: number, id: number, manual = true) {
    await this.getTask(userId, id)
    let observedError: string | null | undefined
    try {
      await this.prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM PatentQueryTask WHERE id=${id} AND userId=${userId} FOR UPDATE`
          const task = await tx.patentQueryTask.findFirstOrThrow({
            where: { id, userId, deletedAt: null },
            include: { checks: true },
          })
          if (PAID.includes(task.status)) return
          if (task.status !== "SETTLING") throw new ConflictException("当前任务不可结算")
          if (!manual && task.error && !task.error.startsWith("[SETTLEMENT_RETRYABLE]")) return
          observedError = task.error
          const p = progress(task)
          if (!p.completed || task.checks.some(c => !TERMINAL.includes(c.status)))
            throw new ConflictException("检测尚未完成")
          await this.usage.chargeModelInTransaction(tx, userId, task.quotedCredits / 10, {
            source: "patent.query",
            model: "patent-query",
            requestId: `patent-query:${id}`,
            exactCredits: task.quotedCredits,
            meta: {
              taskId: id,
              pricing: "fixed_order",
              breakdown: quote(input(task.input)).breakdown,
              successfulUnits: p.completed,
              failedUnits: p.failed,
            },
          })
          await tx.patentQueryTask.update({
            where: { id },
            data: { status: p.failed ? "PARTIAL" : "COMPLETED", error: null },
          })
        },
        { timeout: 30000 }
      )
    } catch (e) {
      if (observedError === undefined) throw e
      const code = str(obj(e).code)
      if (code === "P2002") {
        const log = await this.prisma.usageLog.findUnique({
          where: { requestId: `patent-query:${id}` },
        })
        if (log) {
          await this.prisma.patentQueryTask.updateMany({
            where: { id, userId, status: "SETTLING" },
            data: { error: "[SETTLEMENT_FAILED] 扣费记录待核对，请联系管理员" },
          })
          return this.detail(userId, id)
        }
      }
      const message = e instanceof HttpException ? e.message : "结算暂不可用，请稍后重试"
      const payment =
        e instanceof BadRequestException && /积分.*不足|余额不足|使用上限|配额/.test(message)
      const retryable = ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"].includes(code)
      const prefix = payment
        ? "PAYMENT_REQUIRED"
        : retryable
          ? "SETTLEMENT_RETRYABLE"
          : "SETTLEMENT_FAILED"
      await this.prisma.patentQueryTask.updateMany({
        where: { id, userId, status: "SETTLING", error: observedError },
        data: { error: `[${prefix}] ${message}`.slice(0, 500) },
      })
    }
    return this.detail(userId, id)
  }
  async decision(userId: number, id: number, dto: DecisionDto): Promise<CompactDecisionResponse> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM PatentQueryTask WHERE id=${id} AND userId=${userId} FOR UPDATE`
      const latest = await tx.patentQueryTask.findFirst({
        where: { id, userId, deletedAt: null },
        select: { status: true, error: true, annotations: true },
      })
      if (!latest) throw new NotFoundException("检测记录不存在")
      assertPaid(latest)
      const key = await decisionTarget(tx, id, dto.kind, dto.targetId, dto.imageId)
      const a = annotations(latest.annotations)
      a.decisions[key] = { value: dto.value }
      await tx.patentQueryTask.update({ where: { id }, data: { annotations: json(a) } })
      return {
        taskId: id,
        changed: {
          ...dto,
          decisionKey: key,
          dismissed: dto.value === "dismiss",
          flagged: dto.value === "flag",
        },
        refresh: [],
        syncStatus: "local_only",
        message: uiText("标记已保存，仅用于本报告", "Decision saved for this report"),
      }
    })
  }
  async todo(
    userId: number,
    id: number,
    todoId: string,
    done: boolean
  ): Promise<CompactTodoResponse> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM PatentQueryTask WHERE id=${id} AND userId=${userId} FOR UPDATE`
      const light = await readLight(tx, userId, id)
      if (!light.report.todos.some(t => t.id === todoId))
        throw new BadRequestException("待办不存在")
      const a = annotations(light.task.annotations)
      a.todoDone[todoId] = done
      await tx.patentQueryTask.update({ where: { id }, data: { annotations: json(a) } })
      return { taskId: id, todoId, done, refresh: ["overview", "todos"] }
    })
  }
  async patent(userId: number, id: number, targetId: string, direction?: "cited" | "citedBy") {
    const { check, match } = await this.prisma.$transaction(
      async tx => {
        const task = await tx.patentQueryTask.findFirst({
          where: { id, userId, deletedAt: null },
          select: { status: true, error: true },
        })
        if (!task) throw new NotFoundException("检测记录不存在")
        assertPaid(task)
        const check = await tx.patentQueryCheck.findFirst({
          where: { taskId: id, kind: "design" },
          select: { id: true, upstreamTaskId: true },
        })
        const identifiers = await tx.$queryRaw<{ data: Bag }[]>(
          Prisma.sql`SELECT JSON_OBJECT('pn',JSON_EXTRACT(r.data,'$.pn'),'countryCode',JSON_EXTRACT(r.data,'$.countryCode')) AS data FROM PatentQueryResult r JOIN PatentQueryCheck c ON c.id=r.checkId WHERE c.taskId=${id} AND c.kind='design'`
        )
        const raw = identifiers.map(r => r.data).find(m => imageTarget("design", m) === targetId)
        const match = raw
          ? {
              displayPn: str(raw.pn).startsWith(str(raw.countryCode) || "US")
                ? raw.pn
                : `${str(raw.countryCode) || "US"}${str(raw.pn)}`,
            }
          : undefined
        return { check, match }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    )
    if (!check?.upstreamTaskId || !match) throw new NotFoundException("专利不在本报告中")
    const cacheKey = `${targetId}:${direction ?? "detail"}`
    const stored = await this.prisma.patentQueryCache.findUnique({
      where: {
        checkId_targetId_kind: { checkId: check.id, targetId, kind: direction ?? "detail" },
      },
    })
    const cached = stored ? obj(stored.data) : undefined
    const fetchedAt = stored?.fetchedAt.getTime() ?? 0
    if (cached && Date.now() - fetchedAt < 25 * 60000) return cached
    const cacheRequestKey = `patent:${id}:${cacheKey}`
    const running = this.refreshing.get(cacheRequestKey)
    if (running) return running
    const work = this.loadPatent(
      check.id,
      check.upstreamTaskId,
      str(match.displayPn),
      cacheKey,
      cached,
      direction
    )
    this.refreshing.set(cacheRequestKey, work)
    try {
      return await work
    } finally {
      this.refreshing.delete(cacheRequestKey)
    }
  }
  private async loadPatent(
    checkId: number,
    upstreamId: string,
    number: string,
    cacheKey: string,
    cached: Bag | undefined,
    direction?: "cited" | "citedBy"
  ) {
    const pn = number
    const result = await this.external(() =>
      direction
        ? this.provider.citations(pn, direction)
        : this.provider.patentDetail(pn, upstreamId)
    )
    if (cached) {
      // 缓存过期只更新图样引用，历史著录和关联判断保持原值。
      const fresh = rows(result.patents)
      Object.assign(result, cached)
      result.patents = rows(cached.patents).map(p => {
        const next = fresh.find(n => n.pn === p.pn)
        return next ? { ...p, ...("imageUrls" in next ? { imageUrls: next.imageUrls } : {}) } : p
      })
    } else
      result.patents = rows(result.patents).map(p => ({
        ...p,
        ...Object.fromEntries(
          ["filling", "grant", "expiry"].filter(k => k in p).map(k => [k, dateValue(p[k])])
        ),
      }))
    result.generatedAt = new Date().toISOString()
    result.expiresInSeconds = 1800
    if (direction) {
      const groups: Record<string, Bag[]> = {}
      for (const p of rows(result.patents)) {
        const name =
          rows(p.assignees)
            .map(a => str(a.name))
            .filter(Boolean)
            .join("、") || uiText("未知权利人", "Unknown rights holder")
        groups[name] = [...(groups[name] ?? []), p]
      }
      result.groups = Object.entries(groups).map(([owner, patents]) => ({
        owner,
        count: patents.length,
        patents,
      }))
    }
    await this.prisma.$transaction(async tx => {
      // 与分项更新共用行锁，保证缓存写入与结果刷新互斥。
      await tx.$queryRaw`SELECT id FROM PatentQueryCheck WHERE id=${checkId} FOR UPDATE`
      const identity = { checkId, ...cacheIdentity(cacheKey) }
      const data = { data: json(result), fetchedAt: new Date(str(result.generatedAt)) }
      await tx.patentQueryCache.upsert({
        where: { checkId_targetId_kind: identity },
        create: { ...identity, ...data },
        update: data,
      })
    })
    return result
  }
  private async external<T>(fn: () => Promise<T>) {
    try {
      return await fn()
    } catch (e) {
      throw new ServiceUnavailableException(
        e instanceof TrohubError ? e.message : "检测服务暂不可用"
      )
    }
  }
  async refreshImages(userId: number, id: number, dto: RefreshImagesDto) {
    const task = await this.lightRead(userId, id, l => l.task),
      check = task.checks.find(c => c.kind === dto.kind)
    if (!check?.upstreamTaskId) throw new NotFoundException("检测分项不存在")
    if (dto.imageId && !input(task.input).images.some(i => i.id === dto.imageId))
      throw new BadRequestException("图片不属于当前报告")
    const key = `${id}:${dto.kind}:${dto.imageId ?? "all"}`
    let work = this.refreshing.get(key)
    if (!work) {
      work = this.refreshCheck(check.id, check.upstreamTaskId, dto.kind, dto.imageId)
      this.refreshing.set(key, work)
    }
    try {
      await work
      return {
        taskId: id,
        kind: dto.kind,
        imageId: dto.imageId,
        refresh: ["results"],
        generatedAt: new Date(),
        expiresInSeconds: 1800,
      }
    } finally {
      if (this.refreshing.get(key) === work) this.refreshing.delete(key)
    }
  }
  private async refreshCheck(checkId: number, upstreamId: string, kind: Kind, imageId?: string) {
    const detail = await this.external(() => this.provider.detail(kind, upstreamId))
    const replaceUrls = (old: Bag, fresh: Bag) => {
      for (const key of ["image", "imageUrl", "imageUrls"]) if (key in fresh) old[key] = fresh[key]
    }
    if (kind === "tm") {
      await this.mutateCheck(checkId, out => {
        for (const word of rows(out.text?.words)) {
          const next = rows(detail.words).find(
            w => str(w.term).trim().toLowerCase() === str(word.term).trim().toLowerCase()
          )
          if (!next) continue
          for (const mark of rows(word.marks)) {
            const fresh = rows(next.marks).find(
              m =>
                str(m.serialNumber) &&
                str(m.serialNumber).trim() === str(mark.serialNumber).trim() &&
                (str(m.countryCode).trim().toUpperCase() || "US") ===
                  (str(mark.countryCode).trim().toUpperCase() || "US") &&
                m.bucket === mark.bucket &&
                m.imageID === mark.imageID &&
                JSON.stringify(m.where) === JSON.stringify(mark.where)
            )
            if (fresh) replaceUrls(mark, fresh)
          }
        }
      })
      return
    }
    for (const image of rows(detail.images).filter(i => !imageId || i.id === imageId)) {
      const id = str(image.id),
        fresh: Bag[] = []
      let offset = 0,
        more = true
      while (more) {
        const page = await this.external(() => this.provider.matches(kind, upstreamId, id, offset))
        if (
          !Array.isArray(page.items) ||
          typeof page.hasNextPage !== "boolean" ||
          !Number.isInteger(page.total) ||
          page.truncated === true
        )
          throw new ServiceUnavailableException("图片链接刷新结果不完整")
        const items = rows(page.items)
        if (
          page.hasNextPage &&
          (!items.length ||
            items.every(m => {
              const target = imageTarget(kind, m)
              return target && fresh.some(f => imageTarget(kind, f) === target)
            }))
        )
          throw new ServiceUnavailableException("图片链接刷新结果不完整")
        fresh.push(...items)
        offset += items.length
        if (page.hasNextPage ? offset >= Number(page.total) : offset !== Number(page.total))
          throw new ServiceUnavailableException("图片链接刷新结果不完整")
        more = page.hasNextPage
      }
      await this.mutateCheck(checkId, out => {
        const unit = out.units[id]
        if (!unit) return
        for (const m of unit.matches) {
          const target = imageTarget(kind, m)
          const next = target ? fresh.find(f => imageTarget(kind, f) === target) : undefined
          if (next) replaceUrls(m, next)
        }
        if (typeof image.image === "string") unit.result.image = image.image
      })
    }
  }
}
