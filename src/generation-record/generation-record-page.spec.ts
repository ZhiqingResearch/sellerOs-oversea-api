/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
// 按真实来源关系构造内存数据，核对批量与单实体的事件及积分，不访问数据库。
import { Prisma } from "@prisma/client"
import { memoryClient } from "../../test/generation-record-memory"
import {
  GENERATION_SOURCES,
  GenerationSource,
  projectGenerationSource,
  projectGenerationSourcePage,
} from "./generation-record-sync"

const date = new Date("2026-11-03T00:00:00Z")
const user = { id: 7, username: "运营", phone: "1", orgs: [], roles: [] }

function fixture(source: GenerationSource, count = 2) {
  const data: Record<string, any[]> = { [source]: [], usageLog: [] }
  const add = (model: string, value: any) => (data[model] ??= []).push(value)
  for (let i = 1; i <= count; i++) {
    const row: any = {
      id: i,
      userId: 7,
      user,
      source: "platform",
      project: { source: "platform" },
      status: "SUCCESS",
      prompt: `任务${i}`,
      model: "model-1",
      createdAt: date,
      deletedAt: null,
      resultUrl: `https://example.com/${i}`,
      title: `报告${i}`,
      clientRequestId: `request-${i}`,
    }
    const log: any = {
      id: i,
      userId: 7,
      createdAt: date,
      credits: new Prisma.Decimal("1.25"),
      meta: { model: "model-1" },
    }
    switch (source) {
      case "generationTask":
        Object.assign(row, {
          generationMode: "STANDARD",
          groupId: null,
          sourceJobId: null,
          generatedImages: [{ url: row.resultUrl, status: "SUCCESS", adopted: false }],
        })
        add("generatedImage", {
          id: i,
          taskId: i,
          source: "platform",
          status: "SUCCESS",
          deletedAt: null,
          url: row.resultUrl,
        })
        Object.assign(log, { source: "aicreative.image_generate", meta: { taskId: i } })
        break
      case "imageGenJob":
        Object.assign(row, {
          id: `job-${i}`,
          status: "COMPLETED",
          kind: "TEXT_TO_IMAGE",
          taskId: null,
          businessType: "LEGACY",
          items: [{ url: row.resultUrl, status: "SUCCEEDED" }],
        })
        Object.assign(log, { source: "aicreative.image_generate", meta: { jobId: row.id } })
        break
      case "videoTask":
        log.source = "video-project.generate"
        log.meta.taskId = i
        break
      case "storyboardVideo":
        delete row.userId
        Object.assign(row, {
          url: row.resultUrl,
          generationParams: { model: "model-1", prompt: row.prompt },
          storyboard: { production: { project: { customer: { user } } } },
        })
        Object.assign(log, {
          source: "video-project.generate",
          meta: { taskId: i, taskType: "storyboard-video" },
        })
        break
      case "beautyTask":
        log.source = "beauty-workflow.generate"
        log.meta.taskId = i
        break
      case "rpaCreationTask":
        Object.assign(row, { mediaType: "IMAGE", completedAt: date })
        add("rpaCreationOutput", {
          id: i,
          taskId: i,
          status: "SUCCESS",
          url: row.resultUrl,
          order: i,
        })
        Object.assign(log, {
          source: "rpa-creation.generate",
          meta: { taskId: i, successfulOutputIds: [i] },
        })
        break
      case "inspirationSubscription":
        Object.assign(row, {
          name: `订阅${i}`,
          lastRefreshedAt: date,
          keywords: [],
          platforms: [],
          items: [],
          _count: { items: 2 },
        })
        add("creditTransaction", {
          id: i,
          userId: 7,
          type: "CONSUME",
          source: "inspiration_radar.refresh",
          createdAt: date,
          amount: log.credits,
          meta: { subscriptionId: i, refreshedAt: date.toISOString() },
        })
        break
      case "asinEvidenceRecord":
        Object.assign(row, { id: `evidence-${i}`, asin: `B00000000${i}`, productTitle: row.title })
        log.source = "asin.audit.evidence"
        log.meta.recordId = row.id
        break
      case "asinAuditRecord":
        Object.assign(row, { id: `audit-${i}`, asin: `B00000000${i}`, productTitle: row.title })
        add("asinAuditScoreSnapshot", {
          recordId: row.id,
          scoreResult: { score: i },
          createdAt: date,
          record: { userId: 7 },
        })
        Object.assign(log, {
          source: "asin.audit",
          meta: { stage: "score", recordId: row.id, model: "model-1" },
        })
        break
      case "history":
        Object.assign(row, {
          type: "LISTING_GENERATION",
          data: { result: { title: row.title } },
          version: 1,
        })
        add("historyRevision", { id: i, historyId: i, version: 1, data: row.data, createdAt: date })
        log.source = "listing.generate"
        log.meta.listingHistoryId = i
        break
      case "businessAiRun":
        Object.assign(row, {
          module: i % 2 ? "listing-score" : "competitor-analysis",
          status: "COMPLETED",
          operation: "score",
          outputText: "正文",
          runId: `run-${i}`,
          requestId: `billing-${i}`,
          usageLogId: i,
        })
        Object.assign(log, {
          source: i % 2 ? "listing.score" : "competitor.research",
          requestId: row.requestId,
        })
        break
      case "chetaidouTask":
        Object.assign(row, {
          id: `ct-${i}`,
          rootTaskId: `ct-${i}`,
          ownerId: 7,
          type: "COMPOSE",
          status: "SUCCEEDED",
          finishedAt: date,
        })
        add("chetaidouCall", {
          id: `call-${i}`,
          taskId: row.id,
          rootTaskId: row.id,
          ownerId: 7,
          kind: "TEXT",
          model: "model-1",
          billingStatus: "SETTLED",
          chargedCredits: log.credits,
          createdAt: date,
        })
        Object.assign(log, {
          source: "chetaidou.compose",
          requestId: `chetaidou:charge:call-${i}`,
          meta: { taskId: row.id },
        })
        break
      default: {
        row.id = source === "categoryAnalysisRecord" ? i : `${source}-${i}`
        const config = {
          competitorAnalysisRecord: ["competitor.research", "recordId"],
          categoryAnalysisRecord: ["category.analysis", "analysisId"],
          selectionAnalysisRecord: ["flow.workbench", "analysisId"],
          smartPricingRecord: ["pricing.quote", "recordId"],
          promotionPlanRecord: ["launch.plan", "recordId"],
          videoAnalysisRecord: ["video.analysis", "requestId"],
        }[source]
        log.source = config[0]
        if (source === "selectionAnalysisRecord")
          Object.assign(row, { entry: "PRODUCT", primaryCategoryName: row.title })
        if (source === "smartPricingRecord" || source === "promotionPlanRecord") {
          row.productName = row.title
          add("businessAiRun", {
            id: i,
            userId: 7,
            module: source === "smartPricingRecord" ? "smart-pricing" : "promotion-plan",
            status: "COMPLETED",
            runId: row.clientRequestId,
            operation: "generate",
            model: "model-1",
            billing: null,
          })
        }
        if (source === "videoAnalysisRecord") {
          row.chargeRequestId = `analysis-${i}`
          log.requestId = `charge:${row.chargeRequestId}`
        } else log.meta[config[1]] = row.id
      }
    }
    data[source].push(row)
    if (source !== "inspirationSubscription") data.usageLog.push(log)
  }
  return data
}

describe("page generation projection", () => {
  it.each(Object.keys(GENERATION_SOURCES) as GenerationSource[])(
    "%s preserves single-entity events and exact credits",
    async source => {
      const initial = fixture(source)
      const single = memoryClient(initial)
      const batch = memoryClient(initial)
      const expected = await Promise.all(
        initial[source].map(row => projectGenerationSource(single.tx, source, row))
      )
      const actual = await projectGenerationSourcePage(batch.tx, source, initial[source])
      for (const [index, root] of initial[source].entries()) {
        expect(expected[index]).toHaveLength(1)
        expect(actual.get(root.id)).toEqual(expected[index])
        expect(actual.get(root.id)?.[0].credits).toBe("1.25")
      }
      expect(batch.tx.generationRecord.findMany).not.toHaveBeenCalled()
      expect(batch.tx.generationRecord.upsert).not.toHaveBeenCalled()
    }
  )

  it("loads a page of 50 images with a constant number of source and ledger queries", async () => {
    const initial = fixture("generationTask", 50)
    initial.usageLog.push({
      id: 501,
      userId: 99,
      source: "aicreative.image_generate",
      meta: { taskId: 1 },
      credits: new Prisma.Decimal(999),
    })
    const single = memoryClient(initial)
    const expected = await Promise.all(
      initial.generationTask.map(root => projectGenerationSource(single.tx, "generationTask", root))
    )
    const { tx } = memoryClient(initial)
    const page = await projectGenerationSourcePage(tx, "generationTask", initial.generationTask)
    expect(page.size).toBe(50)
    expect([...page.values()]).toEqual(expected)
    expect(single.tx.usageLog.findMany).toHaveBeenCalledTimes(50)
    expect([...page.values()].every(rows => rows[0].credits === "1.25")).toBe(true)
    expect(tx.generationTask.findMany).toHaveBeenCalledTimes(2)
    expect(tx.generationTask.count).not.toHaveBeenCalled()
    expect(tx.generatedImage.groupBy).toHaveBeenCalledTimes(1)
    expect(tx.generatedImage.count).not.toHaveBeenCalled()
    expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
    expect(tx.aiGatewayModel.findMany).toHaveBeenCalledTimes(1)
  })

  it("does not confuse video and storyboard charges when task IDs collide", async () => {
    const videos = fixture("videoTask"),
      stories = fixture("storyboardVideo")
    const { tx } = memoryClient({
      videoTask: videos.videoTask,
      storyboardVideo: stories.storyboardVideo,
      usageLog: [
        ...videos.usageLog,
        ...stories.usageLog.map(row => ({
          ...row,
          id: row.id + 10,
          credits: new Prisma.Decimal("2.5"),
        })),
      ],
    })
    const videoPage = await projectGenerationSourcePage(tx, "videoTask", videos.videoTask)
    const storyPage = await projectGenerationSourcePage(
      tx,
      "storyboardVideo",
      stories.storyboardVideo
    )
    expect([...videoPage.values()].map(rows => rows[0].credits)).toEqual(["1.25", "1.25"])
    expect([...storyPage.values()].map(rows => rows[0].credits)).toEqual(["2.5", "2.5"])
  })

  it("keeps split groups with the same ID owned by different users separate", async () => {
    const initial = fixture("generationTask")
    const roots = initial.generationTask.map((row, index) => ({
      ...row,
      userId: 7 + index,
      user: { ...user, id: 7 + index },
      generationMode: "AI_SPLIT",
      groupId: "shared-name",
      directionIndex: 0,
      generatedImages: row.generatedImages.map((image: any) => ({ ...image, order: 0 })),
    }))
    initial.generationTask = roots
    initial.usageLog = roots.map((root, index) => ({
      id: index + 1,
      userId: root.userId,
      source: "aicreative.ai_split",
      meta: { groupId: "shared-name" },
      credits: new Prisma.Decimal(index + 1),
    }))
    const { tx } = memoryClient(initial)
    const page = await projectGenerationSourcePage(tx, "generationTask", roots)
    expect(page.get(1)?.[0]).toMatchObject({ userId: 7, credits: "1" })
    expect(page.get(2)?.[0]).toMatchObject({ userId: 8, credits: "2" })
  })

  it("checks ASIN weak-match uniqueness against reports outside the page", async () => {
    const initial = fixture("asinAuditRecord", 1)
    initial.usageLog[0].meta = { stage: "score" }
    initial.asinAuditScoreSnapshot.push({
      recordId: "outside-page",
      createdAt: date,
      record: { userId: 7 },
      scoreResult: { score: 90 },
    })
    const { tx } = memoryClient(initial)
    const page = await projectGenerationSourcePage(tx, "asinAuditRecord", initial.asinAuditRecord)
    expect(page.get("audit-1")?.[0].credits).toBeNull()
    expect(tx.asinAuditScoreSnapshot.findMany).toHaveBeenCalledTimes(2)
    expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
  })

  it("keeps each ASIN revision and separately paid repeat attached to its own fee", async () => {
    const initial = fixture("asinAuditRecord")
    initial.asinAuditOptimizationRevision = [
      {
        id: 11,
        recordId: "audit-1",
        revision: 1,
        createdAt: date,
        optimizationResult: { title: "第一轮" },
      },
      {
        id: 12,
        recordId: "audit-1",
        revision: 2,
        createdAt: date,
        optimizationResult: { title: "第二轮" },
      },
      {
        id: 21,
        recordId: "audit-2",
        revision: 1,
        createdAt: date,
        optimizationResult: { title: "第一轮" },
      },
    ]
    for (const [id, recordId, revisionId, amount] of [
      [11, "audit-1", 11, "2"],
      [12, "audit-1", 12, "3"],
      [13, "audit-1", 12, "4"],
      [21, "audit-2", 21, "5"],
    ] as const) {
      initial.usageLog.push({
        id,
        userId: 7,
        source: "asin.audit",
        createdAt: date,
        credits: new Prisma.Decimal(amount),
        meta: { recordId, revisionId, stage: "optimize" },
      })
    }
    initial.usageLog.push({
      id: 99,
      userId: 8,
      source: "asin.audit",
      createdAt: date,
      credits: new Prisma.Decimal(999),
      meta: { recordId: "audit-1", revisionId: 11, stage: "optimize" },
    })
    const { tx } = memoryClient(initial)
    const page = await projectGenerationSourcePage(tx, "asinAuditRecord", initial.asinAuditRecord)
    expect(page.get("audit-1")?.map(row => [row.key, row.credits])).toEqual([
      ["TEXT:ASIN_AUDIT:audit-1:score", "1.25"],
      ["TEXT:ASIN_AUDIT:audit-1:revision:11:optimize", "2"],
      ["TEXT:ASIN_AUDIT:audit-1:revision:12:optimize", "3"],
      ["TEXT:ASIN_AUDIT:audit-1:revision:12:event:13:optimize", "4"],
    ])
    expect(page.get("audit-2")?.map(row => row.credits)).toEqual(["1.25", "5"])
    expect(tx.asinAuditOptimizationRevision.findMany).toHaveBeenCalledTimes(1)
    expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
  })

  it("does not use another image task's settlement evidence to turn unknown credits into zero", async () => {
    const initial = fixture("generationTask")
    for (const row of initial.generationTask) row.executionSpec = { provider: "gateway" }
    initial.generatedImage[0].providerJobId = "gateway-1"
    initial.generatedImage[0].deliveryMeta = { generationRecordCredits: null }
    initial.generatedImage[1].deliveryMeta = { generationRecordCredits: "0" }
    initial.usageLog = [
      {
        id: 1,
        userId: 7,
        source: "aicreative.image_generate",
        credits: new Prisma.Decimal(7),
        meta: { taskId: 2, gatewayTaskId: "gateway-1" },
      },
    ]
    const { tx } = memoryClient(initial)
    const page = await projectGenerationSourcePage(tx, "generationTask", initial.generationTask)
    expect(page.get(1)?.[0].credits).toBeNull()
    expect(page.get(2)?.[0].credits).toBe("7")
    expect(tx.generatedImage.findMany).toHaveBeenCalledTimes(1)
    expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
  })

  it("shares media logs without mixing plain image, split workflow and unrelated source fees", async () => {
    const initial = fixture("generationTask")
    const split = initial.generationTask[1]
    Object.assign(split, { generationMode: "AI_SPLIT", groupId: "group-2", directionIndex: 0 })
    split.generatedImages = split.generatedImages.map((image: any) => ({ ...image, order: 0 }))
    initial.usageLog = [
      {
        id: 1,
        userId: 7,
        source: "aicreative.image_generate",
        createdAt: new Date("2020-01-01"),
        credits: new Prisma.Decimal("1.25"),
        meta: { taskId: 1 },
      },
      {
        id: 2,
        userId: 7,
        source: "aicreative.ai_split",
        credits: new Prisma.Decimal("3.5"),
        meta: { taskId: 2, groupId: "group-2" },
      },
      {
        id: 3,
        userId: 7,
        source: "aicreative.image_generate.ai_split",
        credits: new Prisma.Decimal("5.75"),
        meta: { taskId: 2, groupId: "group-2" },
      },
      {
        id: 4,
        userId: 7,
        source: "chetaidou.image",
        credits: new Prisma.Decimal(999),
        meta: { taskId: 1 },
      },
      {
        id: 5,
        userId: 7,
        source: "aicreative.ai_split",
        credits: new Prisma.Decimal(999),
        meta: { taskId: 1 },
      },
    ]
    const { tx } = memoryClient(initial)
    const page = await projectGenerationSourcePage(tx, "generationTask", initial.generationTask)
    expect(page.get(1)?.[0].credits).toBe("1.25")
    expect(page.get(2)?.[0].credits).toBe("9.25")
    expect(tx.usageLog.findMany).toHaveBeenCalledTimes(1)
    expect(tx.usageLog.findMany.mock.calls[0][0].where.userId).toEqual({ in: [7] })
  })
})
