/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
// 测试内存委托模拟异构 Prisma 表；生产逻辑由实际同步函数执行。
import { Prisma } from "@prisma/client"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  backfillGenerationRecords,
  normalizeGenerationSourceId,
  parseGenerationBackfillArgs,
} from "../../scripts/backfill-unified-generation-records"
import { generationBackfillIdQuery } from "../../scripts/generation-record-backfill-query"
import { memoryClient as sourceMemoryClient } from "../../test/generation-record-memory"
import { GENERATION_SOURCES } from "./generation-record-sync"

const now = new Date("2026-11-05T00:00:00Z")

// 只模拟查询构造器选出的近期 ID；锁 SQL 保持原内存客户端行为，不连接真实数据库。
function memoryClient(initial: Record<string, any[]> = {}) {
  const result = sourceMemoryClient(initial)
  const { tx, data } = result
  tx.$queryRaw.mockImplementation((query: Prisma.Sql) => {
    if (query.sql.includes("INFORMATION_SCHEMA.STATISTICS"))
      return Promise.resolve([{ name: "existing_source_time_index" }])
    const match = /generation-backfill\s+(\w+)/.exec(query.sql)
    if (!match) return Promise.resolve([])
    const source = match[1]
    const dates = query.values.filter((value): value is Date => value instanceof Date)
    const [from, to] = dates
    const after = query.sql.includes(" > ?") ? query.values.at(-2) : undefined
    const limit = query.values.at(-1) as number
    const recent = (date: Date | undefined) => date != null && date >= from && date <= to
    const ids: Array<string | number> = []
    for (const root of data[source] ?? []) {
      const field = source === "inspirationSubscription" ? "lastRefreshedAt" : "createdAt"
      if (source !== "asinAuditRecord" && recent(root[field])) ids.push(root.id)
      if (source === "rpaCreationTask" && recent(root.completedAt)) ids.push(root.id)
      if (source === "chetaidouTask" && recent(root.finishedAt)) ids.push(root.id)
    }
    if (source === "asinAuditRecord") {
      for (const model of ["asinAuditScoreSnapshot", "asinAuditOptimizationRevision"])
        for (const row of data[model] ?? []) if (recent(row.createdAt)) ids.push(row.recordId)
      for (const log of data.usageLog ?? []) {
        if (log.source !== "asin.audit" || !recent(log.createdAt)) continue
        if (typeof log.meta?.recordId === "string") ids.push(log.meta.recordId)
        if (typeof log.meta?.revisionId === "number") {
          const revision = data.asinAuditOptimizationRevision?.find(
            row => row.id === log.meta.revisionId
          )
          if (revision) ids.push(revision.recordId)
        }
      }
    }
    if (source === "history") {
      for (const model of ["listingGenerationTask", "listingAiStep"])
        for (const row of data[model] ?? []) {
          const run = data.listingRun.find(run => run.id === row.listingRunId)
          if (run && row.status === "COMPLETED" && recent(row.updatedAt)) ids.push(run.historyId)
        }
    }
    return Promise.resolve(
      [...new Set(ids)]
        .filter(id => after == null || id > after)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, limit)
        .map(id => ({ id }))
    )
  })
  return result
}

function expectNoLocks(tx: any) {
  expect(
    tx.$queryRaw.mock.calls.every(([query]: [Prisma.Sql]) => !query.sql.includes("FOR UPDATE"))
  ).toBe(true)
}

function writeTransactions(tx: any) {
  return tx.$transaction.mock.calls.filter(
    ([, options]: [unknown, { isolationLevel?: string }]) =>
      options?.isolationLevel !== "RepeatableRead"
  )
}

describe("generation record backfill", () => {
  it("normalizes every numeric source without changing string IDs or silently losing precision", () => {
    for (const source of [
      "generationTask",
      "videoTask",
      "storyboardVideo",
      "beautyTask",
      "rpaCreationTask",
      "inspirationSubscription",
      "history",
      "businessAiRun",
      "categoryAnalysisRecord",
    ] as const) {
      expect(normalizeGenerationSourceId(source, 27n)).toBe(27)
      expect(normalizeGenerationSourceId(source, "27")).toBe(27)
      expect(() => normalizeGenerationSourceId(source, 9_007_199_254_740_993n)).toThrow()
    }
    expect(normalizeGenerationSourceId("businessAiRun", 4_294_967_295n)).toBe(4_294_967_295)
    expect(() => normalizeGenerationSourceId("businessAiRun", 4_294_967_296n)).toThrow("Int 范围")
    expect(() => normalizeGenerationSourceId("history", 2_147_483_648n)).toThrow("Int 范围")
    expect(() => normalizeGenerationSourceId("history", "27.5")).toThrow()
    expect(() => normalizeGenerationSourceId("history", 0n)).toThrow()
    expect(() => normalizeGenerationSourceId("history", true)).toThrow()
    expect(normalizeGenerationSourceId("imageGenJob", "00027")).toBe("00027")
    expect(normalizeGenerationSourceId("asinAuditRecord", "report-uuid")).toBe("report-uuid")
    expect(() => normalizeGenerationSourceId("imageGenJob", 27n)).toThrow()
  })
  it("defaults to read-only dry-run and validates explicit modes/parameters", () => {
    const options = parseGenerationBackfillArgs([], now)
    expect(options.apply).toBe(false)
    expect(options.concurrency).toBe(4)
    expect(options.from).toEqual(new Date("2026-10-29T00:00:00Z"))
    expect(
      parseGenerationBackfillArgs(["--from", "2020-01-01", "--to", "2030-01-01"], now)
    ).toMatchObject({ from: new Date("2020-01-01"), to: now })
    expect(() => parseGenerationBackfillArgs(["--to", "2020-01-01"], now)).toThrow("开始时间不得晚于结束时间")
    expect(() => parseGenerationBackfillArgs(["--apply", "--dry-run"], now)).toThrow()
    expect(() => parseGenerationBackfillArgs(["--function", "toString"], now)).toThrow()
    expect(() =>
      parseGenerationBackfillArgs(["--cursor", "history:9007199254740993"], now)
    ).toThrow()
    expect(() => parseGenerationBackfillArgs(["--cursor", "history:-1"], now)).toThrow()
    expect(() => parseGenerationBackfillArgs(["--from", "bad"], now)).toThrow()
    expect(() => parseGenerationBackfillArgs(["--batch-size", "0"], now)).toThrow()
    for (const value of ["0", "9", "1.5", "bad"]) {
      expect(() => parseGenerationBackfillArgs(["--concurrency", value], now)).toThrow()
    }
    expect(parseGenerationBackfillArgs(["--concurrency", "1"], now).concurrency).toBe(1)
    expect(
      parseGenerationBackfillArgs(
        ["--apply", "--function", "ASIN_AUDIT", "--cursor", "asinAuditRecord:uuid"],
        now
      ).apply
    ).toBe(true)
  })

  it("keeps recent child events without hard-coded index names", () => {
    const options = parseGenerationBackfillArgs([], now)
    const audit = generationBackfillIdQuery("asinAuditRecord", options)
    expect(audit.sql).toContain("FROM `AsinAuditOptimizationRevision`")
    expect(audit.sql).toContain("FROM `AsinAuditScoreSnapshot`")
    expect(audit.sql).not.toContain("FORCE INDEX")
    const listing = generationBackfillIdQuery("history", options)
    expect(listing.sql).toContain("`ListingGenerationTask` AS t")
    expect(listing.sql).toContain("`ListingAiStep` AS t")
    expect(listing.sql).toContain("JOIN ListingRun AS r ON r.id = t.listingRunId")
    expect(listing.sql).not.toContain("FORCE INDEX")
    expect(listing.sql).not.toContain("EXISTS")
    const image = generationBackfillIdQuery("generationTask", options, 100)
    expect(image.sql).not.toContain("FORCE INDEX")
    expect(image.sql).not.toContain("FROM (")
    expect(image.sql).toContain("AND `id` > ?")
    expect(image.values.slice(-2)).toEqual([100, 100])
    expect(image.values.slice(0, 2)).toEqual([options.from, options.to])
  })

  it("only adds one ledger index and keeps all cursor values parameterized", () => {
    const ddl = readFileSync(
      resolve(__dirname, "../../scripts/sql/generation-record-backfill-indexes.sql"),
      "utf8"
    )
    const options = parseGenerationBackfillArgs([], now)
    expect(ddl.match(/^CREATE INDEX/gm)).toHaveLength(1)
    expect(ddl).toContain("ON `UsageLog` (`source`, `createdAt`)")
    for (const source of Object.keys(GENERATION_SOURCES) as Array<
      keyof typeof GENERATION_SOURCES
    >) {
      const query = generationBackfillIdQuery(source, options, "uuid' OR 1=1 --")
      const hints = [...query.sql.matchAll(/FORCE INDEX \(`?(\w+)`?\)/g)]
      expect(hints.length).toBe(0)
      expect(query.sql.match(/>= \?/g)!.length).toBeGreaterThan(0)
      expect(query.sql.match(/<= \?/g)!.length).toBeGreaterThan(0)
      expect(query.sql).not.toContain("uuid' OR 1=1 --")
      expect(query.values).toContain("uuid' OR 1=1 --")
    }
  })

  it("does not mix named-parameter tokens in SQL comments with positional placeholders", () => {
    const options = parseGenerationBackfillArgs([], now)
    for (const source of Object.keys(GENERATION_SOURCES) as Array<
      keyof typeof GENERATION_SOURCES
    >) {
      for (const after of [undefined, 42, "uuid:with:colon"]) {
        const query = generationBackfillIdQuery(source, options, after)
        expect(query.sql).not.toMatch(/:[A-Za-z_][A-Za-z0-9_]*/)
        expect(query.sql).toContain("?")
        if (after === "uuid:with:colon") expect(query.values).toContain(after)
      }
    }
  })

  it("deduplicates each candidate branch before limiting so pagination cannot skip other events", () => {
    const options = parseGenerationBackfillArgs([], now)
    const query = generationBackfillIdQuery("asinAuditRecord", { ...options, batchSize: 2 }, "a")
    expect(query.sql.match(/SELECT DISTINCT/g)).toHaveLength(5)
    expect(query.sql.match(/ORDER BY id ASC LIMIT/g)).toHaveLength(5)
    expect(query.sql.match(/ > \?/g)).toHaveLength(5)
    expect(query.values.at(-1)).toBe(2)
  })

  it("dry-run reads source batches but never writes or takes row locks", async () => {
    const { tx, data } = memoryClient({
      generationTask: [
        {
          id: 1,
          userId: 7,
          user: { id: 7, username: "运营", phone: "1", orgs: [], roles: [] },
          source: "platform",
          project: { source: "platform" },
          generationMode: "STANDARD",
          groupId: null,
          model: "model-1",
          prompt: "产品",
          status: "SUCCESS",
          createdAt: new Date("2026-11-03T00:00:00Z"),
          deletedAt: null,
          sourceJobId: null,
          generatedImages: [
            { status: "SUCCESS", url: "https://example.com/image", adopted: false },
          ],
        },
      ],
    })
    const options = parseGenerationBackfillArgs(
      ["--dry-run", "--function", "IMAGE", "--batch-size", "2"],
      now
    )
    const stats = await backfillGenerationRecords(tx, options, jest.fn())
    expect(stats.scanned).toBe(1)
    expect(data.generationRecord).toEqual([])
    expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
    expect(tx.generationRecord.updateMany).not.toHaveBeenCalled()
    expect(tx.generationRecord.findMany).not.toHaveBeenCalled()
    expectNoLocks(tx)
  })

  it("accepts an existing equivalent ledger index without requiring a specific index name", async () => {
    const { tx } = memoryClient()
    tx.$queryRaw.mockResolvedValueOnce([{ name: "UsageLog_source_createdAt_id_idx" }])
    await expect(
      backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(["--dry-run", "--function", "ASIN_AUDIT"], now),
        jest.fn()
      )
    ).resolves.toMatchObject({ scanned: 0 })
    const query = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
    expect(query.sql).toContain("INFORMATION_SCHEMA.STATISTICS")
    expect(query.sql).toContain("SEQ_IN_INDEX = 1")
    expect(query.sql).not.toContain("INDEX_NAME =")
  })

  it("reports the missing ledger index without falling back to a full ledger scan", async () => {
    const { tx } = memoryClient()
    tx.$queryRaw.mockResolvedValueOnce([])
    await expect(
      backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(["--apply", "--function", "ASIN_AUDIT"], now),
        jest.fn()
      )
    ).rejects.toThrow("generation-record-backfill-indexes.sql")
    expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
    expect(tx.generationTask.findMany).not.toHaveBeenCalled()
  })

  it("converts raw unsigned BigInt IDs before Prisma Int lookup and keeps pagination numeric", async () => {
    const { tx } = memoryClient({
      businessAiRun: [27, 28].map(id => ({
        id,
        userId: 7,
        module: "listing-score",
        operation: "score",
        runId: `run-${id}`,
        status: "COMPLETED",
        model: "model-1",
        outputText: '{"total":80}',
        requestId: null,
        usageLogId: null,
        createdAt: new Date("2026-11-03"),
      })),
    })
    const readIds = tx.$queryRaw.getMockImplementation()
    tx.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      const result = await readIds(query)
      return query.sql.includes("generation-backfill businessAiRun")
        ? result.map(row => ({ id: BigInt(row.id) }))
        : result
    })
    const readRows = tx.businessAiRun.findMany.getMockImplementation()
    tx.businessAiRun.findMany.mockImplementation((args: any) => {
      if (args.where?.id?.in?.some((id: unknown) => typeof id === "bigint")) {
        throw new Error("Expected Int, provided BigInt")
      }
      return readRows(args)
    })
    const reports = jest.fn()
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(
        ["--dry-run", "--function", "LISTING_SCORING", "--batch-size", "1"],
        now
      ),
      reports
    )
    expect(stats.scanned).toBe(2)
    expect(stats.successful).toBe(2)
    expect(tx.businessAiRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [27] }, module: { in: ["listing-score"] } },
      })
    )
    expect(
      tx.$queryRaw.mock.calls.every(([query]: [Prisma.Sql]) =>
        query.values.every(value => typeof value !== "bigint")
      )
    ).toBe(true)
    expect(reports.mock.calls.at(-1)[0]).toMatchObject({ complete: true, distinctResults: 2 })
  })

  it("finds a recent ASIN revision on an old report and excludes older event fees", async () => {
    const old = new Date("2020-01-01"),
      recent = new Date("2026-11-03")
    const { tx, data } = memoryClient({
      asinAuditRecord: [
        {
          id: "old-report",
          userId: 7,
          asin: "B000000001",
          productTitle: "产品",
          clientRequestId: "request",
          createdAt: old,
        },
      ],
      asinAuditScoreSnapshot: [
        { recordId: "old-report", createdAt: old, scoreResult: { score: 80 } },
      ],
      asinAuditOptimizationRevision: [
        {
          id: 1,
          recordId: "old-report",
          revision: 1,
          createdAt: old,
          optimizationResult: { title: "旧正文" },
        },
        {
          id: 2,
          recordId: "old-report",
          revision: 2,
          createdAt: recent,
          optimizationResult: { title: "新正文" },
        },
      ],
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "asin.audit",
          createdAt: old,
          meta: { recordId: "old-report", stage: "score" },
          credits: new Prisma.Decimal(100),
        },
        {
          id: 2,
          userId: 7,
          source: "asin.audit",
          createdAt: old,
          meta: { recordId: "old-report", stage: "optimize", revisionId: 1 },
          credits: new Prisma.Decimal(200),
        },
        {
          id: 3,
          userId: 7,
          source: "asin.audit",
          createdAt: recent,
          meta: { recordId: "old-report", stage: "optimize", revisionId: 2 },
          credits: new Prisma.Decimal("0.1234"),
        },
      ],
    })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--apply", "--function", "ASIN_AUDIT"], now),
      jest.fn()
    )
    expect(stats.knownCredits).toBe("0.1234")
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0]).toMatchObject({
      sourceId: "ASIN_AUDIT:old-report:revision:2",
      occurredAt: recent,
    })
    expect(tx.asinAuditRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["old-report"] } } })
    )
  })

  it("finds a recent paid legacy Listing optimization through its child step on an old history", async () => {
    const old = new Date("2020-01-01"),
      recent = new Date("2026-11-03")
    const step = {
      id: 11,
      listingRunId: 5,
      operation: "optimization",
      status: "COMPLETED",
      usageLogId: 101,
      outputText: '{"title":"新正文"}',
      model: "model-1",
      updatedAt: recent,
    }
    const { tx, data } = memoryClient({
      history: [
        {
          id: 9,
          userId: 7,
          type: "LISTING_GENERATION",
          title: "商品",
          data: { result: { title: "旧正文" } },
          createdAt: old,
        },
      ],
      historyRevision: [
        { id: 40, historyId: 9, data: { result: { title: "旧正文" } }, createdAt: old },
      ],
      listingRun: [{ id: 5, historyId: 9, runId: "run", steps: [step], generations: [] }],
      listingAiStep: [step],
      usageLog: [
        {
          id: 101,
          userId: 7,
          source: "listing.generate",
          credits: new Prisma.Decimal(5),
          meta: { operation: "optimization" },
        },
      ],
    })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--apply", "--function", "LISTING_GENERATION"], now),
      jest.fn()
    )
    expect(stats.knownCredits).toBe("5")
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0]).toMatchObject({
      sourceId: "LISTING_GENERATION:9:step:11",
      occurredAt: recent,
    })
  })

  it("keeps an exact older charge for a recent ASIN event instead of truncating the ledger", async () => {
    const createdAt = new Date("2026-11-03")
    const { tx, data } = memoryClient({
      asinAuditRecord: [
        {
          id: "report",
          userId: 7,
          asin: "B000000001",
          productTitle: "产品",
          clientRequestId: "request",
          createdAt,
        },
      ],
      asinAuditScoreSnapshot: [{ recordId: "report", createdAt, scoreResult: { score: 80 } }],
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "asin.audit",
          createdAt: new Date("2020-01-01"),
          meta: { recordId: "report", stage: "score" },
          credits: new Prisma.Decimal("1.2345"),
        },
        {
          id: 2,
          userId: 7,
          source: "asin.audit",
          createdAt,
          meta: { recordId: "another-report", stage: "score" },
          credits: new Prisma.Decimal(999),
        },
      ],
    })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--apply", "--function", "ASIN_AUDIT"], now),
      jest.fn()
    )
    expect(stats.knownCredits).toBe("1.2345")
    expect(data.generationRecord).toHaveLength(1)
  })

  it.each(["recordId", "revisionId"])(
    "finds a new paid event with the same old body through its explicit %s",
    async reference => {
      const old = new Date("2020-01-01"),
        recent = new Date("2026-11-03")
      const { tx, data } = memoryClient({
        asinAuditRecord: [
          {
            id: "report",
            userId: 7,
            asin: "B000000001",
            productTitle: "产品",
            clientRequestId: "request",
            createdAt: old,
          },
        ],
        asinAuditOptimizationRevision: [
          {
            id: 1,
            recordId: "report",
            revision: 1,
            createdAt: old,
            optimizationResult: { title: "相同正文" },
          },
        ],
        usageLog: [
          {
            id: 5,
            userId: 7,
            source: "asin.audit",
            createdAt: recent,
            meta: { [reference]: reference === "recordId" ? "report" : 1, stage: "optimize" },
            credits: new Prisma.Decimal(3),
          },
        ],
      })
      tx.$transaction = jest.fn((work: any) => work(tx))
      const stats = await backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(["--apply", "--function", "ASIN_AUDIT"], now),
        jest.fn()
      )
      expect(stats.knownCredits).toBe("3")
      expect(data.generationRecord).toHaveLength(1)
      expect(data.generationRecord[0]).toMatchObject({
        sourceId: "ASIN_AUDIT:report:revision:1:event:5",
        occurredAt: recent,
      })
    }
  )
  it("apply is idempotent and reports actual frozen credits rather than later ledger changes", async () => {
    const createdAt = new Date("2026-11-03T00:00:00Z")
    const { tx, data } = memoryClient({
      generationTask: [
        {
          id: 1,
          userId: 7,
          user: { id: 7, username: "运营", phone: "1", orgs: [], roles: [] },
          source: "platform",
          project: { source: "platform" },
          generationMode: "STANDARD",
          groupId: null,
          model: "model-1",
          prompt: "产品",
          status: "SUCCESS",
          createdAt,
          deletedAt: null,
          sourceJobId: null,
          generatedImages: [{ status: "SUCCESS", url: "u", adopted: false }],
        },
      ],
      generationRecord: [
        {
          id: 1n,
          sourceType: "IMAGE",
          sourceId: "1",
          operation: "",
          userId: 7,
          function: "IMAGE",
          credits: new Prisma.Decimal(20),
          occurredAt: createdAt,
        },
      ],
    })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const options = parseGenerationBackfillArgs(["--apply", "--function", "IMAGE"], now)
    const first = await backfillGenerationRecords(tx, options, jest.fn())
    const second = await backfillGenerationRecords(tx, options, jest.fn())
    expect(first.knownCredits).toBe("20")
    expect(second.knownCredits).toBe("20")
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0].credits.toString()).toBe("20")
    expect(writeTransactions(tx)).toHaveLength(0)
    expectNoLocks(tx)
    expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
    expect(tx.generatedImage.count).not.toHaveBeenCalled()
  })

  function videoSource(id: number, status = "SUCCESS") {
    return {
      id,
      userId: 7,
      status,
      source: "platform",
      project: { source: "platform" },
      prompt: `视频${id}`,
      model: "model-1",
      modelName: "实际模型一",
      resultUrl: `https://example.com/${id}.mp4`,
      createdAt: new Date("2026-11-03T00:00:00Z"),
      deletedAt: null,
      user: { id: 7, username: "运营", phone: "1", orgs: [], roles: [] },
    }
  }

  it("only selects the last seven days, including the boundary and excluding older or future tasks", async () => {
    const from = new Date(now.getTime() - 7 * 86400000)
    const { tx } = memoryClient({
      videoTask: [
        { ...videoSource(1), createdAt: from },
        { ...videoSource(2), createdAt: new Date(from.getTime() - 1) },
        { ...videoSource(3), createdAt: new Date(now.getTime() + 1) },
        videoSource(4),
      ],
    })
    const reports = jest.fn()
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--dry-run", "--function", "VIDEO"], now),
      reports
    )
    expect(stats).toMatchObject({ scanned: 2, successful: 2, written: 0 })
    expect(tx.videoTask.findMany.mock.calls[0][0].where.id.in).toEqual([1, 4])
    expect(reports.mock.calls.at(-1)[0]).toMatchObject({ complete: true, distinctResults: 2 })
    expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
  })

  it.each(["indexes", "candidates", "rows", "projection", "snapshots"])(
    "recovers from P1017 in %s reads without counting a record twice",
    async stage => {
      const { tx, data } = memoryClient({ videoTask: [videoSource(1)] })
      tx.$transaction = jest.fn((work: any) => work(tx))
      const target =
        stage === "indexes" || stage === "candidates"
          ? tx.$queryRaw
          : stage === "snapshots"
            ? tx.generationRecord.findMany
            : tx.videoTask.findMany
      const read = target.getMockImplementation()
      let failures = 0
      target.mockImplementation((args: any) => {
        const matches =
          stage === "indexes"
            ? args.sql.includes("INFORMATION_SCHEMA.STATISTICS")
            : stage === "candidates"
              ? args.sql.includes("generation-backfill videoTask")
              : stage === "rows"
                ? !!args.where?.id
                : stage === "projection"
                  ? !!args.where?.AND
                  : true
        if (matches && failures++ < 2)
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError("Server has closed the connection.", {
              code: "P1017",
              clientVersion: "6.19.3",
            })
          )
        return read(args)
      })
      const reports = jest.fn()
      const stats = await backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(
          stage === "indexes"
            ? ["--dry-run"]
            : [stage === "snapshots" ? "--apply" : "--dry-run", "--function", "VIDEO"],
          now
        ),
        reports
      )
      expect(stats).toMatchObject({ scanned: 1, successful: 1 })
      const retries = reports.mock.calls.map(([report]) => report).filter(r => r.event)
      expect(retries).toMatchObject([
        { event: "read-retry", code: "P1017", retry: 1, waitMs: 500 },
        { event: "read-retry", code: "P1017", retry: 2, waitMs: 1000 },
      ])
      expect(reports.mock.calls.at(-1)[0]).toMatchObject({ complete: true, distinctResults: 1 })
      expect(data.generationRecord).toHaveLength(stage === "snapshots" ? 1 : 0)
      if (stage !== "snapshots") {
        expect(tx.generationRecord.findMany).not.toHaveBeenCalled()
        expectNoLocks(tx)
      }
    }
  )

  it.each(["request", "initialization"])(
    "recovers from a P1001 %s error in a page read",
    async kind => {
      const { tx } = memoryClient({ videoTask: [videoSource(1)] })
      const error =
        kind === "request"
          ? new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
              code: "P1001",
              clientVersion: "6.19.3",
            })
          : new Prisma.PrismaClientInitializationError(
              "Can't reach database server",
              "6.19.3",
              "P1001"
            )
      tx.aiGatewayModel.findMany.mockRejectedValueOnce(error)
      const reports = jest.fn()
      const stats = await backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(["--dry-run", "--function", "VIDEO"], now),
        reports
      )
      expect(stats).toMatchObject({ scanned: 1, successful: 1, written: 0 })
      expect(tx.videoTask.count).not.toHaveBeenCalled()
      expect(reports).toHaveBeenCalledWith({
        event: "read-retry",
        context: "videoTask:page",
        code: "P1001",
        retry: 1,
        waitMs: 500,
      })
      expect(reports.mock.calls.at(-1)[0]).toMatchObject({ complete: true, distinctResults: 1 })
      expect(tx.generationRecord.findMany).not.toHaveBeenCalled()
      expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
      expectNoLocks(tx)
    }
  )

  it.each(["P1017", "P1001", "P2028", "P2022"])(
    "stops on persistent %s without advancing the failed record cursor",
    async code => {
      const { tx } = memoryClient({ videoTask: [videoSource(1), videoSource(2)] })
      const read = tx.videoTask.findMany.getMockImplementation()
      let failures = 0
      tx.videoTask.findMany.mockImplementation((args: any) => {
        if (args.where?.AND?.some((where: any) => where.OR?.some((child: any) => child.id === 2))) {
          failures++
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError("read failed", {
              code,
              clientVersion: "6.19.3",
            })
          )
        }
        return read(args)
      })
      const reports = jest.fn()
      await expect(
        backfillGenerationRecords(
          tx,
          parseGenerationBackfillArgs(
            ["--function", "VIDEO", "--concurrency", "1", "--batch-size", "1"],
            now
          ),
          reports
        )
      ).rejects.toThrow("source=videoTask firstId=2")
      expect(failures).toBe(code === "P2022" ? 1 : 3)
      const progress = reports.mock.calls.map(([report]) => report).filter(r => r.cursor)
      expect(progress).toHaveLength(1)
      expect(progress[0]).toMatchObject({ cursor: "videoTask:1", scanned: 1 })
      expect(reports.mock.calls.some(([report]) => report.complete)).toBe(false)
      expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
    }
  )

  it.each(["P1017", "P1001", "P2028", "P2022"])(
    "limits %s write retries and never advances a failed record",
    async code => {
      const { tx } = memoryClient({ videoTask: [videoSource(1)] })
      tx.$transaction = jest.fn((work: any, options: any) => {
        if (options.isolationLevel === "RepeatableRead") return work(tx)
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError("Server has closed the connection.", {
            code,
            clientVersion: "6.19.3",
          })
        )
      })
      const reports = jest.fn()
      await expect(
        backfillGenerationRecords(
          tx,
          parseGenerationBackfillArgs(["--apply", "--function", "VIDEO"], now),
          reports
        )
      ).rejects.toThrow("source=videoTask id=1")
      const retryable = code === "P1017" || code === "P1001"
      expect(writeTransactions(tx)).toHaveLength(retryable ? 3 : 1)
      expect(reports.mock.calls.map(([report]) => report)).toEqual(
        retryable
          ? [
              { event: "write-retry", context: "videoTask:1", code, retry: 1, waitMs: 500 },
              { event: "write-retry", context: "videoTask:1", code, retry: 2, waitMs: 1000 },
            ]
          : []
      )
      expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
    }
  )

  it.each(["P1017", "P1001"])(
    "recovers from %s before writing without re-reading billing",
    async code => {
      const { tx, data } = memoryClient({
        videoTask: [videoSource(1)],
        usageLog: [
          {
            id: 1,
            userId: 7,
            source: "video-project.generate",
            credits: new Prisma.Decimal("1.25"),
            meta: { taskId: 1 },
          },
        ],
      })
      let attempts = 0
      tx.$transaction = jest.fn((work: any, options: any) => {
        if (options.isolationLevel !== "RepeatableRead" && ++attempts === 1)
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError("connection lost", {
              code,
              clientVersion: "6.19.3",
            })
          )
        return work(tx)
      })
      const reports = jest.fn()
      const stats = await backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(["--apply", "--function", "VIDEO"], now),
        reports
      )
      expect(stats).toMatchObject({ scanned: 1, successful: 1, written: 1, knownCredits: "1.25" })
      expect(data.generationRecord).toHaveLength(1)
      expect(writeTransactions(tx)).toHaveLength(2)
      expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
      expect(tx.usageLog.create).not.toHaveBeenCalled()
      expect(tx.creditTransaction.create).not.toHaveBeenCalled()
      expect(reports.mock.calls.at(-1)[0]).toMatchObject({ complete: true, distinctResults: 1 })
    }
  )

  it("replays an uncertain commit without duplicating or overwriting the winning snapshot", async () => {
    const { tx, data } = memoryClient({
      videoTask: [videoSource(1)],
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "video-project.generate",
          credits: new Prisma.Decimal("1.25"),
          meta: { taskId: 1 },
        },
      ],
    })
    let attempts = 0
    tx.$transaction = jest.fn(async (work: any, options: any) => {
      if (options.isolationLevel === "RepeatableRead") return work(tx)
      if (++attempts === 1) {
        // 页面读取后，在线写入先保存；随后模拟回填提交已成功但响应丢失。
        data.generationRecord.push({
          id: 1n,
          sourceType: "VIDEO",
          sourceId: "1",
          operation: "",
          credits: new Prisma.Decimal("9.25"),
          prompt: "首次正文",
          modelDisplayName: "首次模型",
        })
        await work(tx)
        data.usageLog[0].credits = new Prisma.Decimal(99)
        throw new Prisma.PrismaClientKnownRequestError("commit response lost", {
          code: "P1017",
          clientVersion: "6.19.3",
        })
      }
      return work(tx)
    })
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--apply", "--function", "VIDEO"], now),
      jest.fn()
    )
    expect(stats).toMatchObject({ scanned: 1, successful: 1, written: 1, knownCredits: "9.25" })
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0]).toMatchObject({
      prompt: "首次正文",
      modelDisplayName: "首次模型",
    })
    expect(data.generationRecord[0].credits.toString()).toBe("9.25")
    expect(tx.generationRecord.upsert).toHaveBeenCalledTimes(2)
    expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
  })

  it("rolls back a failed multi-event write and retries the whole source transaction", async () => {
    const createdAt = new Date("2026-11-03T00:00:00Z")
    const { tx, data } = memoryClient({
      asinAuditRecord: [
        {
          id: "report",
          userId: 7,
          asin: "B000000001",
          productTitle: "产品",
          clientRequestId: "request",
          createdAt,
        },
      ],
      asinAuditScoreSnapshot: [{ recordId: "report", scoreResult: { score: 80 }, createdAt }],
      asinAuditOptimizationRevision: [
        {
          id: 1,
          recordId: "report",
          revision: 1,
          optimizationResult: { title: "优化" },
          createdAt,
        },
      ],
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "asin.audit",
          credits: new Prisma.Decimal(1),
          createdAt,
          meta: { recordId: "report", stage: "score" },
        },
        {
          id: 2,
          userId: 7,
          source: "asin.audit",
          credits: new Prisma.Decimal(2),
          createdAt,
          meta: { recordId: "report", stage: "optimize", revisionId: 1 },
        },
      ],
    })
    const upsert = tx.generationRecord.upsert.getMockImplementation()
    let writes = 0
    tx.generationRecord.upsert.mockImplementation((args: any) => {
      if (++writes === 2)
        throw new Prisma.PrismaClientKnownRequestError("connection lost", {
          code: "P1017",
          clientVersion: "6.19.3",
        })
      return upsert(args)
    })
    tx.$transaction = jest.fn(async (work: any, options: any) => {
      if (options.isolationLevel === "RepeatableRead") return work(tx)
      const before = [...data.generationRecord]
      try {
        return await work(tx)
      } catch (error) {
        data.generationRecord.splice(0, data.generationRecord.length, ...before)
        throw error
      }
    })
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--apply", "--function", "ASIN_AUDIT"], now),
      jest.fn()
    )
    expect(stats).toMatchObject({ successful: 2, written: 2, knownCredits: "3" })
    expect(data.generationRecord).toHaveLength(2)
    expect(data.generationRecord.map(row => row.credits.toString())).toEqual(["1", "2"])
    expect(writeTransactions(tx)).toHaveLength(2)
    expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
  })

  it("apply projects each new media source only once and does not transact failed sources", async () => {
    const { tx, data } = memoryClient({ videoTask: [videoSource(1), videoSource(2, "FAILED")] })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const options = parseGenerationBackfillArgs(["--apply", "--function", "VIDEO"], now)
    const stats = await backfillGenerationRecords(tx, options, jest.fn())
    expect(stats.scanned).toBe(2)
    expect(stats.successful).toBe(1)
    expect(writeTransactions(tx)).toHaveLength(1)
    // 页内不执行列表 count，也不在写入事务里重新投影。
    expect(tx.videoTask.count).not.toHaveBeenCalled()
    expect(tx.videoTask.findUnique).not.toHaveBeenCalled()
    expect(data.generationRecord).toHaveLength(1)
  })

  it("shrinks an invalid read page and restarts at the same cursor without losing fees or writing the failed page", async () => {
    const { tx, data } = memoryClient({
      videoTask: Array.from({ length: 5 }, (_, i) => videoSource(i + 1)),
      usageLog: Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        userId: 7,
        source: "video-project.generate",
        credits: new Prisma.Decimal("1.25"),
        meta: { taskId: i + 1 },
      })),
    })
    const read = tx.usageLog.findMany.getMockImplementation()
    const sizes: number[] = []
    tx.usageLog.findMany.mockImplementation((args: any) => {
      const size = args.where.AND[1].OR.length as number
      sizes.push(size)
      if (size > 2) {
        expect(writeTransactions(tx)).toHaveLength(0)
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError("Transaction not found", {
            code: "P2028",
            clientVersion: "6.19.3",
          })
        )
      }
      return read(args)
    })
    const reports = jest.fn()
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--apply", "--function", "VIDEO", "--batch-size", "4"], now),
      reports
    )
    expect(sizes).toEqual([4, 2, 2, 1])
    expect(stats).toMatchObject({
      scanned: 5,
      successful: 5,
      written: 5,
      knownCredits: "6.25",
      unknownCredits: 0,
    })
    expect(new Set(data.generationRecord.map(row => row.sourceId))).toEqual(
      new Set(["1", "2", "3", "4", "5"])
    )
    expect(writeTransactions(tx)).toHaveLength(5)
    expect(reports).toHaveBeenCalledWith({
      event: "page-resize",
      source: "videoTask",
      firstId: 1,
      code: "P2028",
      previousBatchSize: 4,
      batchSize: 2,
    })
    expect(reports.mock.calls.map(([r]) => r.cursor).filter(Boolean)).toEqual([
      "videoTask:2",
      "videoTask:4",
      "videoTask:5",
    ])
    expect(reports.mock.calls.at(-1)[0]).toMatchObject({ complete: true, distinctResults: 5 })
  })

  it("processes over 6000 candidates in bounded read pages without writing during preview", async () => {
    const rows = Array.from({ length: 6001 }, (_, i) => videoSource(i + 1))
    const { tx } = memoryClient({ videoTask: rows })
    // 用主键 Map 模拟数据库索引，避免规模测试自身反复遍历整个内存表。
    const index = new Map(rows.map(row => [row.id, row]))
    tx.videoTask.findMany.mockImplementation((args: any) => {
      const ids: number[] = args.where.id?.in ?? args.where.AND.at(-1).OR.map((row: any) => row.id)
      return Promise.resolve(ids.map(id => index.get(id)))
    })
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--dry-run", "--function", "VIDEO", "--batch-size", "50"], now),
      jest.fn()
    )
    const batches = tx.videoTask.findMany.mock.calls
      .filter(([args]: any) => args.where.id)
      .map(([args]: any) => args.where.id.in.length as number)
    expect(batches).toHaveLength(121)
    expect(Math.max(...batches)).toBe(50)
    expect(stats).toMatchObject({
      scanned: 6001,
      successful: 6001,
      written: 0,
      unknownCredits: 6001,
    })
    expect(writeTransactions(tx)).toHaveLength(0)
    expect(tx.generationRecord.findMany).not.toHaveBeenCalled()
    expect(tx.generationRecord.upsert).not.toHaveBeenCalled()
  })

  it("reads source and credits from one page snapshot and only upserts in later write transactions", async () => {
    const original = {
      videoTask: [videoSource(1)],
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "video-project.generate",
          credits: new Prisma.Decimal("1.25"),
          meta: { taskId: 1 },
        },
      ],
    }
    const live = memoryClient(original)
    const snapshot = memoryClient({
      videoTask: original.videoTask.map(row => ({ ...row })),
      usageLog: original.usageLog.map(row => ({ ...row })),
    })
    const read = snapshot.tx.usageLog.findMany.getMockImplementation()
    snapshot.tx.usageLog.findMany.mockImplementation((args: any) => {
      live.data.videoTask[0].model = "later-model"
      live.data.usageLog[0].credits = new Prisma.Decimal(99)
      return read(args)
    })
    live.tx.$transaction = jest.fn((work: any, options: any) =>
      work(options.isolationLevel === "RepeatableRead" ? snapshot.tx : live.tx)
    )
    const stats = await backfillGenerationRecords(
      live.tx,
      parseGenerationBackfillArgs(["--apply", "--function", "VIDEO"], now),
      jest.fn()
    )
    expect(stats.knownCredits).toBe("1.25")
    expect(live.data.generationRecord[0].credits.toString()).toBe("1.25")
    expect(live.data.generationRecord[0].modelPublicId).toBe("model-1")
    expect(snapshot.tx.generationRecord.upsert).not.toHaveBeenCalled()
    expect(live.tx.videoTask.findMany).not.toHaveBeenCalled()
    expect(live.tx.usageLog.findMany).not.toHaveBeenCalled()
    expect(writeTransactions(live.tx)).toHaveLength(1)
    expectNoLocks(snapshot.tx)
  })

  it("uses bounded concurrency, keeps cursor ordering and matches serial results", async () => {
    const initial = { videoTask: Array.from({ length: 5 }, (_, index) => videoSource(index + 1)) }
    async function run(concurrency: number) {
      const { tx, data } = memoryClient(initial)
      let active = 0,
        peak = 0
      tx.$transaction = jest.fn(async (work: any, options: any) => {
        if (options.isolationLevel === "RepeatableRead") return work(tx)
        active++
        peak = Math.max(peak, active)
        try {
          await new Promise(resolve => setTimeout(resolve, 5))
          return await work(tx)
        } finally {
          active--
        }
      })
      const reports = jest.fn()
      const stats = await backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(
          [
            "--apply",
            "--function",
            "VIDEO",
            "--concurrency",
            String(concurrency),
            "--batch-size",
            "3",
          ],
          now
        ),
        reports
      )
      return { stats, peak, data, reports }
    }
    const serial = await run(1)
    const parallel = await run(2)
    expect(serial.peak).toBe(1)
    expect(parallel.peak).toBe(2)
    expect(parallel.stats).toEqual(serial.stats)
    expect(parallel.data.generationRecord).toEqual(serial.data.generationRecord)
    expect(parallel.reports.mock.calls.map(([report]) => report.cursor).filter(Boolean)).toEqual([
      "videoTask:2",
      "videoTask:3",
      "videoTask:5",
    ])
  })

  it("waits for other workers after a failure and never advances past an unfinished chunk", async () => {
    const { tx, data } = memoryClient({ videoTask: [videoSource(1), videoSource(2)] })
    let attempts = 0,
      completed = false
    tx.$transaction = jest.fn(async (work: any, options: any) => {
      if (options.isolationLevel === "RepeatableRead") return work(tx)
      if (++attempts === 1) throw new Error("database unavailable")
      await new Promise(resolve => setTimeout(resolve, 5))
      const result = await work(tx)
      completed = true
      return result
    })
    const reports = jest.fn()
    await expect(
      backfillGenerationRecords(
        tx,
        parseGenerationBackfillArgs(["--apply", "--function", "VIDEO", "--concurrency", "2"], now),
        reports
      )
    ).rejects.toThrow("source=videoTask id=1")
    expect(completed).toBe(true)
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0].sourceId).toBe("2")
    expect(reports).not.toHaveBeenCalled()
  })

  it("does not skip a new ASIN optimization when its parent already has a frozen score", async () => {
    const createdAt = new Date("2026-11-03T00:00:00Z")
    const { tx, data } = memoryClient({
      asinAuditRecord: [
        {
          id: "report",
          userId: 7,
          asin: "B000000001",
          productTitle: "产品",
          clientRequestId: "request",
          createdAt,
        },
      ],
      asinAuditScoreSnapshot: [{ recordId: "report", createdAt, scoreResult: { score: 80 } }],
      asinAuditOptimizationRevision: [
        {
          id: 1,
          recordId: "report",
          revision: 1,
          createdAt,
          optimizationResult: { title: "新优化" },
        },
      ],
      generationRecord: [
        {
          id: 1n,
          sourceType: "TEXT",
          sourceId: "ASIN_AUDIT:report",
          operation: "score",
          credits: new Prisma.Decimal(2),
        },
      ],
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "asin.audit",
          createdAt,
          meta: { recordId: "report", stage: "score" },
          credits: new Prisma.Decimal(99),
        },
        {
          id: 2,
          userId: 7,
          source: "asin.audit",
          createdAt,
          meta: { recordId: "report", stage: "optimize", revisionId: 1 },
          credits: new Prisma.Decimal("0.5"),
        },
      ],
    })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(["--apply", "--function", "ASIN_AUDIT"], now),
      jest.fn()
    )
    expect(data.generationRecord).toHaveLength(2)
    expect(stats.knownCredits).toBe("2.5")
    expect(data.generationRecord[0].credits.toString()).toBe("2")
    expect(data.generationRecord[1]).toMatchObject({
      sourceId: "ASIN_AUDIT:report:revision:1",
      operation: "optimize",
    })
  })

  it("projects a split group once across pages and does not double-count its fee", async () => {
    const createdAt = new Date("2026-11-03T00:00:00Z")
    const { tx, data } = memoryClient({
      generationTask: [1, 2, 3].map(id => ({
        id,
        userId: 7,
        user: { id: 7, username: "运营", phone: "1", orgs: [], roles: [] },
        source: "platform",
        project: { source: "platform" },
        generationMode: "AI_SPLIT",
        groupId: "group",
        directionIndex: id,
        model: "model-1",
        prompt: "拆图",
        status: "SUCCESS",
        createdAt,
        deletedAt: null,
        sourceJobId: null,
        generatedImages: [
          { url: "https://example.com/image", status: "SUCCESS", adopted: false, order: 0 },
        ],
      })),
      usageLog: [
        {
          id: 1,
          userId: 7,
          source: "aicreative.ai_split",
          meta: { groupId: "group" },
          credits: new Prisma.Decimal(9),
        },
      ],
    })
    tx.$transaction = jest.fn((work: any) => work(tx))
    const reports = jest.fn()
    const stats = await backfillGenerationRecords(
      tx,
      parseGenerationBackfillArgs(
        ["--apply", "--function", "IMAGE", "--batch-size", "2", "--concurrency", "2"],
        now
      ),
      reports
    )
    expect(writeTransactions(tx)).toHaveLength(1)
    expect(data.generationRecord).toHaveLength(1)
    expect(stats.scanned).toBe(3)
    expect(stats.successful).toBe(3)
    expect(stats.knownCredits).toBe("9")
    expect(reports.mock.calls.at(-1)[0]).toMatchObject({ distinctResults: 1, unknownCredits: 0 })
  })
})
