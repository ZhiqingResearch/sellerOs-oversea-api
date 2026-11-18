/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import {
  ProductPublishOutcome,
  ProductPublishRpaLogSource,
  ProductPublishRpaLogStatus,
  ProductPublishRpaOperation,
  ProductPublishRpaRunStatus,
  ProductPublishTaskStatus,
  ProductPublishTemplateStatus,
} from "@prisma/client"
import {
  YingdaoProvider,
  YingdaoRequestError,
  YingdaoStartTaskResult,
} from "../common/providers/yingdao.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ProductPublishEventsService } from "./product-publish-events.service"
import { ProductPublishRpaRequest } from "./product-publish-rpa.contract"
import { ProductPublishRpaService } from "./product-publish-rpa.service"
import { ProductPublishService } from "./product-publish.service"

interface StoreFixture {
  id: number
  externalStoreId: string
  name: string
  disabled: boolean
  platform: string
}

interface TaskFixture {
  id: number
  taskId: string
  userId: number
  status: ProductPublishTaskStatus
  publishStoreId: number | null
  classification: string | null
  submitRequestId: string | null
  resultRequestId: string | null
  submittedFileUrl: string | null
  spreadsheetUrl: string | null
  skus: string[] | null
  uploadId: string | null
  rpaTaskUuid: string | null
  publishOutcome: ProductPublishOutcome | null
  nextPollAt: Date | null
  pollAttempts: number
  publishStore: StoreFixture | null
}

interface TemplateFixture {
  id: number
  storeId: number
  classification: string
  classificationName: string
  sortOrder: number
  templateUrl: string | null
  templateStatus: ProductPublishTemplateStatus
  templateRequestId: string | null
  updatedAt: Date
  lastSyncError?: string | null
  store: StoreFixture
}

interface CallbackEnvelope {
  contract_version: "1.0"
  request_id?: string
  ok: boolean
  data: Record<string, unknown>
  error?: Record<string, unknown>
}

type CallbackCapableService = ProductPublishRpaService & {
  handleCallback(apiKey: string | undefined, dto: CallbackEnvelope): Promise<unknown>
}

type WriteArgs = {
  where?: Record<string, unknown>
  data: Record<string, unknown>
}

describe("ProductPublishRpaService 异步调度与回调", () => {
  let service: CallbackCapableService
  let lastRequest: ProductPublishRpaRequest | null
  let callbackLog: Record<string, unknown> | null
  let prisma: {
    $transaction: jest.Mock
    productPublishStore: {
      findUnique: jest.Mock
      findFirst: jest.Mock
    }
    productPublishTask: {
      findFirst: jest.Mock
      findMany: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    productPublishStoreClassification: {
      findFirst: jest.Mock
      findMany: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    productPublishRpaLog: {
      create: jest.Mock
      findFirst: jest.Mock
      findMany: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    productPublishRpaRun: {
      create: jest.Mock
      update: jest.Mock
    }
  }
  let yingdao: {
    uploadFile: jest.Mock
    startTask: jest.Mock
  }
  let productPublishService: { findTask: jest.Mock }
  let eventsService: { publishRefreshCompleted: jest.Mock }

  const callbackApiKey = "product-publish-callback-key-20260803"
  const submittedSkus = ["SKU-1", "SKU-2"]
  const store: StoreFixture = {
    id: 9,
    externalStoreId: "27826971599669",
    name: "Amazon US",
    disabled: false,
    platform: "AMAZON",
  }
  const baseTask: TaskFixture = {
    id: 1,
    taskId: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    status: ProductPublishTaskStatus.COMPLETED,
    publishStoreId: store.id,
    classification: "HEADPHONES",
    submitRequestId: null,
    resultRequestId: null,
    submittedFileUrl: null,
    spreadsheetUrl: "https://files.example.com/input.xlsx",
    skus: null,
    uploadId: null,
    rpaTaskUuid: null,
    publishOutcome: null,
    nextPollAt: null,
    pollAttempts: 0,
    publishStore: store,
  }
  const template: TemplateFixture = {
    id: 31,
    storeId: store.id,
    classification: "HEADPHONES",
    classificationName: "Headphones",
    sortOrder: 10,
    templateUrl: "https://templates.example.com/old-headphones.xlsm",
    templateStatus: ProductPublishTemplateStatus.SUCCESS,
    templateRequestId: null,
    updatedAt: new Date("2026-08-03T00:00:00Z"),
    store,
  }
  const configValues: Record<string, string> = {
    YINGDAO_ACCESS_KEY_ID: "access-key",
    YINGDAO_ACCESS_KEY_SECRET: "access-secret",
    YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "schedule-uuid",
    YINGDAO_PRODUCT_PUBLISH_APP_ID: "robot-uuid",
    YINGDAO_PRODUCT_PUBLISH_PROFILE: "uat",
    YINGDAO_PRODUCT_PUBLISH_PARAM_NAME: "paramsFile",
    YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS: "3600",
    YINGDAO_PRODUCT_PUBLISH_MAX_POLL_ATTEMPTS: "288",
    YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY: callbackApiKey,
    YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS: "4200",
  }

  beforeEach(() => {
    lastRequest = null
    callbackLog = null
    prisma = {
      $transaction: jest.fn(),
      productPublishStore: {
        findUnique: jest.fn().mockResolvedValue(store),
        findFirst: jest.fn().mockResolvedValue(store),
      },
      productPublishTask: {
        findFirst: jest.fn().mockResolvedValue(baseTask),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(baseTask),
        update: jest.fn().mockResolvedValue(baseTask),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productPublishStoreClassification: {
        findFirst: jest.fn().mockResolvedValue(template),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(template),
        update: jest.fn().mockResolvedValue(template),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productPublishRpaLog: {
        create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          callbackLog = {
            id: 101,
            createdAt: new Date(),
            ...args.data,
          }
          return Promise.resolve({ id: 101, status: "DISPATCHING" })
        }),
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(callbackLog)),
        findMany: jest
          .fn()
          .mockImplementation(() => Promise.resolve(callbackLog ? [callbackLog] : [])),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(callbackLog)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productPublishRpaRun: {
        create: jest.fn().mockResolvedValue({ id: 201 }),
        update: jest.fn().mockResolvedValue({}),
      },
    }
    prisma.$transaction.mockImplementation((input: unknown) => {
      if (typeof input === "function") {
        return (input as (tx: typeof prisma) => Promise<unknown>)(prisma)
      }
      return Promise.all(input as Promise<unknown>[])
    })

    yingdao = {
      uploadFile: jest.fn().mockImplementation((content: Buffer) => {
        lastRequest = JSON.parse(content.toString("utf8")) as ProductPublishRpaRequest
        return Promise.resolve({ fileKey: "file-key" })
      }),
      startTask: jest.fn().mockResolvedValue(dispatchResult()),
    }
    productPublishService = {
      findTask: jest.fn().mockResolvedValue(baseTask),
    }
    eventsService = {
      publishRefreshCompleted: jest.fn(),
    }

    const config = {
      get: jest.fn((name: string, fallback = "") => configValues[name] ?? fallback),
    }
    service = new ProductPublishRpaService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      yingdao as unknown as YingdaoProvider,
      productPublishService as unknown as ProductPublishService,
      eventsService as unknown as ProductPublishEventsService
    ) as CallbackCapableService
  })

  it("提交上架仅调度 startTask，并将审计日志置为 WAITING_CALLBACK", async () => {
    const fileUrl = "https://files.example.com/input.xlsx?signature=secret"

    const result = await service.submitPublish(
      baseTask.taskId,
      fileUrl,
      submittedSkus,
      baseTask.userId
    )

    expect(result).toMatchObject({ success: true, requestId: expect.any(String) })
    expect(result).not.toHaveProperty("uploadId")
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(currentTaskInfo()).toEqual({
      task_type: "upload_listing",
      task_id: "",
      rpa_storage: "",
      task_param: { file_url: fileUrl },
    })
    expect(yingdao.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleUuid: "schedule-uuid",
        idempotentUuid: result.requestId,
        scheduleRelaParams: [
          {
            robotUuid: "robot-uuid",
            runTimeout: 3600,
            params: [
              { name: "paramsFile", value: "file-key", type: "file" },
              { name: "profile", value: "uat", type: "string" },
            ],
          },
        ],
      })
    )

    expect(taskWrites()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          submitRequestId: result.requestId,
          submittedFileUrl: fileUrl,
          skus: submittedSkus,
        }),
      })
    )
    expect(taskWrites().some(write => typeof write.data.uploadId === "string")).toBe(false)
    expect(prisma.productPublishRpaLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DISPATCHING",
          expiresAt: expect.any(Date),
          success: false,
        }),
      })
    )
    expect(waitingCallbackWrite()).toMatchObject({
      data: {
        status: "WAITING_CALLBACK",
        rpaTaskUuid: "rpa-task-uuid",
        rpaJobUuidList: ["rpa-job-uuid"],
        dispatchResponsePayload: dispatchResult(),
        dispatchedAt: expect.any(Date),
      },
    })
    expect(logWrites().some(write => write.data.success === true)).toBe(false)
  })

  it("调度失败时永久保留 submitRequestId，后续不允许重新上架", async () => {
    yingdao.startTask.mockRejectedValueOnce(new Error("影刀调度失败"))

    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/input.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).rejects.toBeInstanceOf(BadGatewayException)

    const claim = taskWrites().find(write => typeof write.data.submitRequestId === "string")
    expect(claim).toBeDefined()
    const submitRequestId = claim!.data.submitRequestId as string
    expect(taskWrites().some(write => write.data.submitRequestId === null)).toBe(false)
    expect(taskWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: baseTask.id, submitRequestId }),
        data: expect.objectContaining({
          status: ProductPublishTaskStatus.COMPLETED,
          publishOutcome: ProductPublishOutcome.FAILED,
          publishErrorMessage: expect.stringContaining("影刀调度失败"),
        }),
      })
    )

    prisma.productPublishTask.findFirst.mockResolvedValue({
      ...baseTask,
      submitRequestId,
      publishOutcome: ProductPublishOutcome.FAILED,
    })
    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/input.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).rejects.toBeInstanceOf(ConflictException)
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
  })

  it("拒绝提交不属于当前任务的表格 URL", async () => {
    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/another-task.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).rejects.toBeInstanceOf(BadRequestException)

    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
    expect(yingdao.startTask).not.toHaveBeenCalled()
  })

  it("脚本已调起后附加调度标识保存失败不终结业务请求", async () => {
    prisma.productPublishTask.updateMany.mockImplementation((args: WriteArgs) => {
      if (args.data.rpaTaskUuid) return Promise.reject(new Error("保存调度标识失败"))
      return Promise.resolve({ count: 1 })
    })

    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/input.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).resolves.toMatchObject({ accepted: true })

    expect(
      taskWrites().some(write => write.data.publishOutcome === ProductPublishOutcome.FAILED)
    ).toBe(false)
    expect(waitingCallbackWrite()).toBeDefined()
  })

  it("极快回调已改变日志状态时仅补写调度字段，不覆盖回调终态信息", async () => {
    prisma.productPublishRpaLog.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 })

    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/input.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).resolves.toMatchObject({ accepted: true })

    const fallbackWrite = logWrites().find(
      write => write.data.rpaTaskUuid === "rpa-task-uuid" && write.data.status === undefined
    )
    expect(fallbackWrite).toMatchObject({
      data: expect.objectContaining({
        rpaTaskUuid: "rpa-task-uuid",
        dispatchResponsePayload: dispatchResult(),
      }),
    })
    expect(fallbackWrite!.data).not.toHaveProperty("status")
    expect(fallbackWrite!.data).not.toHaveProperty("success")
    expect(fallbackWrite!.data).not.toHaveProperty("errorMessage")
    expect(fallbackWrite!.data).not.toHaveProperty("durationMs")
  })

  it("startTask 网络超时时保留待回调状态，不把未知结果误判为失败", async () => {
    yingdao.startTask.mockRejectedValueOnce(new Error("启动影刀任务失败：timeout of 30000ms"))

    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/input.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).resolves.toMatchObject({ accepted: true })

    expect(waitingCallbackWrite()).toMatchObject({
      data: expect.objectContaining({
        status: "WAITING_CALLBACK",
        errorMessage: expect.stringContaining("结果未知"),
      }),
    })
    expect(
      taskWrites().some(write => write.data.publishOutcome === ProductPublishOutcome.FAILED)
    ).toBe(false)
  })

  it("startTask 返回 503 时按调度结果未知处理，不提前终结业务请求", async () => {
    yingdao.startTask.mockRejectedValueOnce(
      new YingdaoRequestError("启动影刀任务失败：Service Unavailable", "启动影刀任务", 503)
    )

    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/input.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).resolves.toMatchObject({
      accepted: true,
      message: expect.stringContaining("启动结果未知"),
    })

    expect(waitingCallbackWrite()).toMatchObject({
      data: expect.objectContaining({ status: "WAITING_CALLBACK" }),
    })
    expect(
      taskWrites().some(write => write.data.publishOutcome === ProductPublishOutcome.FAILED)
    ).toBe(false)
  })

  it("启动前的影刀鉴权超时按确定性失败处理", async () => {
    yingdao.startTask.mockRejectedValueOnce(
      new YingdaoRequestError("影刀鉴权失败：timeout", "影刀鉴权", undefined, "ETIMEDOUT")
    )

    await expect(
      service.submitPublish(
        baseTask.taskId,
        "https://files.example.com/input.xlsx",
        submittedSkus,
        baseTask.userId
      )
    ).rejects.toBeInstanceOf(BadGatewayException)

    expect(taskWrites()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          publishOutcome: ProductPublishOutcome.FAILED,
          publishErrorMessage: expect.stringContaining("影刀鉴权失败"),
        }),
      })
    )
  })

  it("手动刷新只调度查询，并用 resultRequestId 锁住待回调请求", async () => {
    const publishingTask = publishingTaskFixture()
    prisma.productPublishTask.findFirst.mockResolvedValue(publishingTask)
    prisma.productPublishTask.findUnique.mockResolvedValue(publishingTask)

    const result = await service.refreshPublishResult(publishingTask.taskId, publishingTask.userId)

    expect(result).toMatchObject({ success: true, requestId: expect.any(String) })
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(currentTaskInfo()).toEqual({
      task_type: "check_feed_status",
      task_id: "",
      rpa_storage: "",
      task_param: { upload_id: "amazon-upload-1", skus: submittedSkus },
    })
    expect(taskWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: publishingTask.id,
          status: ProductPublishTaskStatus.PUBLISHING,
          resultRequestId: null,
        }),
        data: expect.objectContaining({
          resultRequestId: result.requestId,
          pollAttempts: { increment: 1 },
        }),
      })
    )
    expect(
      taskWrites().some(
        write => write.data.successCount !== undefined || write.data.publishOutcome !== undefined
      )
    ).toBe(false)
    expect(waitingCallbackWrite()).toBeDefined()
  })

  it("已有 resultRequestId 的任务拒绝再次查询，不重复调用 RPA", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue(
      publishingTaskFixture({ resultRequestId: "query-already-waiting" })
    )

    await expect(
      service.refreshPublishResult(baseTask.taskId, baseTask.userId)
    ).rejects.toBeInstanceOf(ConflictException)
    expect(yingdao.startTask).not.toHaveBeenCalled()
  })

  it("缺少提交 SKU 列表的历史任务拒绝发起结果查询", async () => {
    prisma.productPublishTask.findFirst.mockResolvedValue(publishingTaskFixture({ skus: null }))

    await expect(
      service.refreshPublishResult(baseTask.taskId, baseTask.userId)
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
    expect(yingdao.startTask).not.toHaveBeenCalled()
  })

  it("每五分钟 Cron 只调度到期任务，不把影刀启动响应当业务结果", async () => {
    const publishingTask = publishingTaskFixture()
    prisma.productPublishTask.findMany.mockResolvedValue([publishingTask])

    await expect(service.pollPublishingTasks()).resolves.toEqual({
      runId: 201,
      status: ProductPublishRpaRunStatus.SUCCESS,
      total: 1,
      success: 1,
      failed: 0,
      skipped: 0,
    })

    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(currentTaskInfo()).toMatchObject({
      task_type: "check_feed_status",
      task_id: "",
      rpa_storage: "",
      task_param: { upload_id: "amazon-upload-1", skus: submittedSkus },
    })
    expect(prisma.productPublishRpaLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: 201,
          operation: ProductPublishRpaOperation.QUERY_RESULT,
          source: ProductPublishRpaLogSource.CRON,
          status: "DISPATCHING",
        }),
      })
    )
    expect(waitingCallbackWrite()).toBeDefined()
    expect(
      taskWrites().some(
        write => write.data.successCount !== undefined || write.data.publishOutcome !== undefined
      )
    ).toBe(false)
  })

  it("API 与 Cron 使用 resultRequestId CAS 互斥，同一任务只调度一次查询", async () => {
    const publishingTask = publishingTaskFixture({ nextPollAt: new Date(Date.now() - 1_000) })
    prisma.productPublishTask.findFirst.mockResolvedValue(publishingTask)
    prisma.productPublishTask.findMany.mockResolvedValue([publishingTask])
    let claimed = false
    prisma.productPublishTask.updateMany.mockImplementation((args: WriteArgs) => {
      if (typeof args.data.resultRequestId === "string") {
        if (claimed) return Promise.resolve({ count: 0 })
        claimed = true
      }
      return Promise.resolve({ count: 1 })
    })

    await Promise.allSettled([
      service.refreshPublishResult(publishingTask.taskId, publishingTask.userId),
      service.pollPublishingTasks(),
    ])

    expect(
      taskWrites().filter(write => typeof write.data.resultRequestId === "string")
    ).toHaveLength(2)
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(prisma.productPublishRpaLog.create).toHaveBeenCalledTimes(1)
  })

  it.each(["FAILED", "TIMEOUT"])("%s 模板自动补发下载并记录重试次数，保留旧模板", async status => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({ status, attempt: 1 })
    await service.retryFailedTemplates()
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(currentTaskInfo().task_type).toBe("download_listing")
    expect(prisma.productPublishRpaLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempt: 2, source: "CRON" }),
      })
    )
    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: template.id,
          templateStatus: "FAILED",
          updatedAt: template.updatedAt,
        }),
        data: expect.objectContaining({ templateStatus: "PENDING" }),
      })
    )
    expect(templateWrites().some(write => write.data.templateUrl !== undefined)).toBe(false)
    expect(prisma.productPublishStoreClassification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          templateStatus: "FAILED",
          templateRequestId: null,
          updatedAt: { lte: expect.any(Date) },
          store: { disabled: false, platform: "AMAZON" },
        }),
      })
    )
  })

  it.each([
    ["模板状态", "RPA_ERROR: 未查询到店铺：123456"],
    ["模板状态", "RPA_ERROR: 传入密码为空，网页中自动填充密码也为空，请检查。"],
    ["最近日志", "RPA_ERROR: 未查询到店铺：123456"],
    ["最近日志", "RPA_ERROR: 传入密码为空，网页中自动填充密码也为空，请检查。"],
  ])("%s 中存在不可恢复配置错误时不补发，保留旧文件和错误：%s", async (source, message) => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([
      { ...template, lastSyncError: source === "模板状态" ? message : null },
    ])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({
      status: "FAILED",
      attempt: 1,
      errorMessage: source === "最近日志" ? message : null,
    })
    await expect(service.retryFailedTemplates()).resolves.toMatchObject({
      total: 1,
      success: 0,
      failed: 0,
      skipped: 1,
    })
    expect(yingdao.uploadFile).not.toHaveBeenCalled()
    expect(yingdao.startTask).not.toHaveBeenCalled()
    expect(prisma.productPublishRpaLog.create).not.toHaveBeenCalled()
    expect(prisma.productPublishStoreClassification.updateMany).not.toHaveBeenCalled()
  })

  it.each(["亚马逊后台登录失败", "下载模板网络超时", "未查询到类目", "页面加载失败"])(
    "其它错误仍可自动重试：%s",
    async message => {
      prisma.productPublishStoreClassification.findMany.mockResolvedValue([
        { ...template, lastSyncError: message },
      ])
      prisma.productPublishRpaLog.findFirst.mockResolvedValue({
        status: "FAILED",
        attempt: 1,
        errorMessage: message,
      })
      await service.retryFailedTemplates()
      expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    }
  )

  it.each(["daily", "manual"])("%s 刷新仍可在修复配置后重新获取模板", async mode => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([
      { ...template, lastSyncError: "未查询到店铺：123456" },
    ])
    if (mode === "daily") await service.refreshTemplates()
    else await service.refreshAllTemplatesOnce()
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
  })

  it.each(["daily", "retry", "manual"])(
    "%s 不再派发已取消店铺 27859233726983 的下载任务",
    async mode => {
      const excludedTemplate = {
        ...template,
        store: { ...store, externalStoreId: "27859233726983" },
      }
      prisma.productPublishStoreClassification.findMany.mockResolvedValue([excludedTemplate])
      const result =
        mode === "daily"
          ? await service.refreshTemplates()
          : mode === "retry"
            ? await service.retryFailedTemplates()
            : await service.refreshAllTemplatesOnce()
      expect(result).toMatchObject({ total: 1, skipped: 1, success: 0 })
      expect(yingdao.uploadFile).not.toHaveBeenCalled()
      expect(yingdao.startTask).not.toHaveBeenCalled()
      expect(prisma.productPublishRpaLog.create).not.toHaveBeenCalled()
      expect(prisma.productPublishStoreClassification.updateMany).not.toHaveBeenCalled()
    }
  )

  it.each([
    { status: "FAILED", attempt: 4 },
    { status: "WAITING_CALLBACK", attempt: 1 },
    { status: "SUCCESS", attempt: 1 },
  ])("不补发达到上限或仍在等待、已成功的任务 %j", async previous => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue(previous)
    await service.retryFailedTemplates()
    expect(yingdao.startTask).not.toHaveBeenCalled()
  })

  it("最后一次允许的自动重试持久化 attempt=4，重启服务不重置次数", async () => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({ status: "FAILED", attempt: 3 })
    await service.retryFailedTemplates()
    expect(prisma.productPublishRpaLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempt: 4 }),
      })
    )
  })

  it("次日正常刷新开启新一轮，不受上一轮重试上限影响", async () => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({ status: "FAILED", attempt: 4 })
    await service.refreshTemplates()
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(prisma.productPublishRpaLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempt: 1 }),
      })
    )
  })

  it("两个重试扫描竞争同一模板时只发送一次下载", async () => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({ status: "FAILED", attempt: 1 })
    let isClaimed = false
    prisma.productPublishStoreClassification.updateMany.mockImplementation((args: WriteArgs) => {
      if (args.where?.templateStatus === "FAILED") {
        if (isClaimed) return Promise.resolve({ count: 0 })
        isClaimed = true
      }
      return Promise.resolve({ count: 1 })
    })
    await Promise.all([service.retryFailedTemplates(), service.retryFailedTemplates()])
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
  })

  it("扫描后模板版本变化则放弃旧快照重试，不覆盖新结果", async () => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({ status: "FAILED", attempt: 1 })
    prisma.productPublishStoreClassification.updateMany.mockResolvedValue({ count: 0 })
    await service.retryFailedTemplates()
    expect(yingdao.startTask).not.toHaveBeenCalled()
  })

  it("补发下载失败继续记录错误，不清空上次成功文件", async () => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({ status: "FAILED", attempt: 1 })
    yingdao.uploadFile.mockRejectedValue(new Error("上传请求失败"))
    await service.retryFailedTemplates()
    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ templateStatus: "FAILED", templateRequestId: null }),
      })
    )
    expect(templateWrites().some(write => write.data.templateUrl !== undefined)).toBe(false)
  })

  it("模板 Cron 只调度 download_listing，回调前不覆盖永久模板 URL", async () => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])

    await expect(service.refreshTemplates()).resolves.toEqual({
      runId: 201,
      status: ProductPublishRpaRunStatus.SUCCESS,
      total: 1,
      success: 1,
      failed: 0,
      skipped: 0,
    })

    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(currentTaskInfo()).toEqual({
      task_type: "download_listing",
      task_id: "",
      rpa_storage: "",
      task_param: { category: "HEADPHONES" },
    })
    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: template.id, templateRequestId: null }),
        data: expect.objectContaining({
          templateRequestId: expect.any(String),
          templateStatus: ProductPublishTemplateStatus.PENDING,
        }),
      })
    )
    expect(templateWrites().some(write => write.data.templateUrl !== undefined)).toBe(false)
    expect(waitingCallbackWrite()).toBeDefined()
  })

  it("全量手动模板同步忽略最近同步时间并使用 API 来源记录日志", async () => {
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])

    const result = await service.refreshAllTemplatesOnce()

    expect(result).toEqual({
      runId: 201,
      status: ProductPublishRpaRunStatus.SUCCESS,
      total: 1,
      success: 1,
      failed: 0,
      skipped: 0,
    })
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(currentTaskInfo()).toEqual({
      task_type: "download_listing",
      task_id: "",
      rpa_storage: "",
      task_param: { category: template.classification },
    })
    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        where: { id: template.id, templateRequestId: null },
        data: expect.objectContaining({
          templateRequestId: expect.any(String),
          templateStatus: ProductPublishTemplateStatus.PENDING,
        }),
      })
    )
    expect(prisma.productPublishRpaLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operation: ProductPublishRpaOperation.FETCH_TEMPLATE,
          source: ProductPublishRpaLogSource.API,
          requestId: expect.any(String),
          storeId: store.id,
          classification: template.classification,
        }),
      })
    )
    expect(waitingCallbackWrite()).toBeDefined()
  })

  it("全量模板同步终止旧等待请求并重新调度，允许失败后直接重跑", async () => {
    const pendingTemplate: TemplateFixture = {
      ...template,
      id: 32,
      classification: "CAMERA",
      classificationName: "Camera",
      templateRequestId: "existing-request-id",
    }
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([pendingTemplate, template])
    prisma.productPublishStoreClassification.findUnique.mockImplementation(
      (args: { where: { id: number } }) =>
        Promise.resolve(args.where.id === pendingTemplate.id ? pendingTemplate : template)
    )
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.FETCH_TEMPLATE,
      requestId: "existing-request-id",
      taskId: null,
      storeId: pendingTemplate.storeId,
      classification: pendingTemplate.classification,
    })

    await expect(service.refreshAllTemplatesOnce()).resolves.toEqual({
      runId: 201,
      status: ProductPublishRpaRunStatus.SUCCESS,
      total: 2,
      success: 2,
      failed: 0,
      skipped: 0,
    })

    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(lastRequest?.[0].tasks_info.map(item => item.task_param)).toEqual([
      { category: pendingTemplate.classification },
      { category: template.classification },
    ])
    expect(logWrites()).toContainEqual(
      expect.objectContaining({
        where: { id: 101, status: ProductPublishRpaLogStatus.WAITING_CALLBACK },
        data: expect.objectContaining({
          status: ProductPublishRpaLogStatus.TIMEOUT,
          errorMessage: expect.stringContaining("重新运行"),
        }),
      })
    )
    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        where: { id: pendingTemplate.id, templateRequestId: "existing-request-id" },
        data: expect.objectContaining({ templateRequestId: null }),
      })
    )
  })

  it("回调缺失或使用错误 X-API-Key 时拒绝处理", async () => {
    const payload = uploadCallback()

    await expect(service.handleCallback(undefined, payload)).rejects.toBeInstanceOf(
      UnauthorizedException
    )
    await expect(service.handleCallback("wrong-key", payload)).rejects.toBeInstanceOf(
      UnauthorizedException
    )
    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
    expect(prisma.productPublishStoreClassification.updateMany).not.toHaveBeenCalled()
  })

  it("upload_listing 回调允许省略 request_id，并通过店铺与 file_url 保存 Amazon upload_id", async () => {
    const pendingTask = publishingTaskFixture({
      submitRequestId: "submit-request-1",
      submittedFileUrl: "https://files.example.com/input.xlsx",
      uploadId: null,
    })
    const payload = uploadCallback()
    prisma.productPublishTask.findFirst.mockResolvedValue(pendingTask)
    prisma.productPublishTask.findMany.mockResolvedValue([pendingTask])
    prisma.productPublishTask.findUnique.mockResolvedValue(pendingTask)
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.SUBMIT_PUBLISH,
      requestId: "submit-request-1",
      taskId: pendingTask.id,
    })

    await expect(service.handleCallback(callbackApiKey, payload)).resolves.toMatchObject({
      success: true,
    })

    expect(payload).not.toHaveProperty("request_id")
    expect(prisma.productPublishTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          submitCorrelationKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          publishStore: { externalStoreId: store.externalStoreId },
        },
      })
    )
    expect(processingCallbackWrite()).toMatchObject({
      where: expect.objectContaining({
        id: 101,
        status: { in: ["DISPATCHING", "WAITING_CALLBACK"] },
      }),
      data: expect.objectContaining({
        status: "PROCESSING_CALLBACK",
        callbackReceivedAt: expect.any(Date),
      }),
    })
    expect(taskWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: pendingTask.id,
          uploadId: null,
        }),
        data: expect.objectContaining({
          uploadId: "amazon-upload-1",
          nextPollAt: expect.any(Date),
          publishErrorMessage: null,
        }),
      })
    )
    expect(successfulCallbackWrite()).toMatchObject({
      data: {
        status: "SUCCESS",
        success: true,
        responsePayload: payload,
        callbackReceivedAt: expect.any(Date),
      },
    })
  })

  it("download_listing 回调按 business_id + category 更新模板", async () => {
    const pendingTemplate = { ...template, templateRequestId: "template-request-1" }
    const payload: CallbackEnvelope = {
      contract_version: "1.0",
      ok: true,
      data: {
        task_type: "download_listing",
        business_id: store.externalStoreId,
        category: template.classification,
        template_url: "https://templates.example.com/new-headphones.xlsm",
      },
    }
    prisma.productPublishStoreClassification.findFirst.mockResolvedValue(pendingTemplate)
    prisma.productPublishStoreClassification.findUnique.mockResolvedValue(pendingTemplate)
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.FETCH_TEMPLATE,
      requestId: "template-request-1",
      storeId: store.id,
      classification: template.classification,
    })

    await expect(service.handleCallback(callbackApiKey, payload)).resolves.toMatchObject({
      success: true,
    })

    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: template.id }),
        data: expect.objectContaining({
          templateUrl: "https://templates.example.com/new-headphones.xlsm",
          templateStatus: ProductPublishTemplateStatus.SUCCESS,
          templateSyncedAt: expect.any(Date),
          templateRequestId: null,
          lastSyncError: null,
        }),
      })
    )
    expect(successfulCallbackWrite()).toBeDefined()
  })

  it("下载失败回调保留旧模板 URL 和成功同步时间", async () => {
    prisma.productPublishStoreClassification.findFirst.mockResolvedValue({
      ...template,
      templateRequestId: "retry-2",
    })
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.FETCH_TEMPLATE,
      requestId: "retry-2",
    })
    await service.handleCallback(callbackApiKey, {
      contract_version: "1.0",
      request_id: "retry-2",
      ok: false,
      data: {
        task_type: "download_listing",
        business_id: store.externalStoreId,
        category: template.classification,
      },
      error: { code: "RPA_ERROR", message: "密码为空" },
    })
    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ templateStatus: "FAILED", templateRequestId: null }),
      })
    )
    expect(
      templateWrites().some(
        write => write.data.templateUrl !== undefined || write.data.templateSyncedAt !== undefined
      )
    ).toBe(false)
  })

  it("超时释放模板请求后可由重试扫描补发，旧文件保持不变", async () => {
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.FETCH_TEMPLATE,
      requestId: "expired-download",
      expiresAt: new Date(Date.now() - 1000),
    })
    prisma.productPublishStoreClassification.findMany.mockResolvedValue([template])
    prisma.productPublishRpaLog.findFirst.mockResolvedValue({ status: "TIMEOUT", attempt: 1 })
    await service.retryFailedTemplates()
    expect(logWrites()).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "TIMEOUT" }) })
    )
    expect(templateWrites()).toContainEqual(
      expect.objectContaining({
        where: { templateRequestId: "expired-download" },
        data: expect.objectContaining({ templateStatus: "FAILED", templateRequestId: null }),
      })
    )
    expect(yingdao.startTask).toHaveBeenCalledTimes(1)
    expect(templateWrites().some(write => write.data.templateUrl !== undefined)).toBe(false)
  })

  it("携带旧 request_id 的迟到成功回调不能覆盖当前重试", async () => {
    prisma.productPublishStoreClassification.findFirst.mockResolvedValue({
      ...template,
      templateRequestId: "retry-2",
    })
    await expect(
      service.handleCallback(callbackApiKey, {
        contract_version: "1.0",
        request_id: "expired-download",
        ok: true,
        data: {
          task_type: "download_listing",
          business_id: store.externalStoreId,
          category: template.classification,
          template_url: "https://templates.example.com/stale.xlsm",
        },
      })
    ).rejects.toThrow("request_id")
    expect(prisma.productPublishStoreClassification.updateMany).not.toHaveBeenCalled()
  })

  it("处理中断超过五分钟的回调可由同一业务结果重试接管", async () => {
    const pendingTask = publishingTaskFixture({
      submitRequestId: "submit-request-1",
      submittedFileUrl: "https://files.example.com/input.xlsx",
      uploadId: null,
    })
    prisma.productPublishTask.findMany.mockResolvedValue([pendingTask])
    callbackLog = waitingLog({
      status: "PROCESSING_CALLBACK",
      callbackReceivedAt: new Date(Date.now() - 6 * 60 * 1_000),
    })

    await expect(service.handleCallback(callbackApiKey, uploadCallback())).resolves.toMatchObject({
      success: true,
      duplicate: false,
    })

    expect(logWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "PROCESSING_CALLBACK",
          callbackReceivedAt: expect.any(Date),
        }),
        data: expect.objectContaining({
          errorMessage: expect.stringContaining("重试接管"),
        }),
      })
    )
  })

  it("check_feed_status 终态回调按 business_id + upload_id 完成任务", async () => {
    const pendingTask = publishingTaskFixture({ resultRequestId: "query-request-1" })
    const payload = queryCallback()
    prisma.productPublishTask.findFirst.mockResolvedValue(pendingTask)
    prisma.productPublishTask.findMany.mockResolvedValue([pendingTask])
    prisma.productPublishTask.findUnique.mockResolvedValue(pendingTask)
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.QUERY_RESULT,
      requestId: "query-request-1",
      taskId: pendingTask.id,
      uploadId: pendingTask.uploadId,
    })

    await expect(service.handleCallback(callbackApiKey, payload)).resolves.toMatchObject({
      success: true,
    })

    expect(taskWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: pendingTask.id }),
        data: expect.objectContaining({
          status: ProductPublishTaskStatus.COMPLETED,
          publishOutcome: ProductPublishOutcome.PARTIAL_SUCCESS,
          successCount: 1,
          failedCount: 1,
          resultFileUrl: "https://files.example.com/result.xlsx",
          skuAsinMapping: [
            { sku: "SKU-1", asin: "B000000001", status: "SUCCESS" },
            {
              sku: "SKU-2",
              asin: null,
              status: "FAILED",
              error_code: "INVALID_ATTRIBUTE",
              error_message: "属性错误",
            },
          ],
          resultRequestId: null,
          publishCompletedAt: expect.any(Date),
          nextPollAt: null,
        }),
      })
    )
    expect(successfulCallbackWrite()).toMatchObject({
      data: expect.objectContaining({
        responsePayload: expect.objectContaining({
          data: expect.objectContaining({
            sku_asin_mapping: {
              count: 2,
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          }),
        }),
      }),
    })
    expect(eventsService.publishRefreshCompleted).toHaveBeenCalledWith(pendingTask.userId, {
      taskId: pendingTask.taskId,
      requestId: "query-request-1",
      callbackOk: true,
      amazonStatus: "PARTIAL_SUCCESS",
      taskStatus: ProductPublishTaskStatus.COMPLETED,
      publishOutcome: ProductPublishOutcome.PARTIAL_SUCCESS,
      receivedAt: expect.any(String),
    })
  })

  it("check_feed_status 回调拒绝返回未请求或重复的 SKU", async () => {
    const pendingTask = publishingTaskFixture({
      resultRequestId: "query-request-1",
      skus: ["SKU-1"],
    })
    prisma.productPublishTask.findFirst.mockResolvedValue(pendingTask)
    prisma.productPublishTask.findMany.mockResolvedValue([pendingTask])

    await expect(service.handleCallback(callbackApiKey, queryCallback())).rejects.toThrow(
      "包含未请求的 SKU"
    )

    const duplicatePayload = queryCallback()
    duplicatePayload.data.sku_asin_mapping = [
      { sku: "SKU-1", asin: "B000000001", status: "SUCCESS" },
      { sku: "SKU-1", asin: "B000000001", status: "SUCCESS" },
    ]
    await expect(service.handleCallback(callbackApiKey, duplicatePayload)).rejects.toThrow(
      "SKU 重复"
    )
    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
  })

  it("check_feed_status 失败回调落库后也通知前端结束本次刷新 loading", async () => {
    const pendingTask = publishingTaskFixture({ resultRequestId: "query-request-failed" })
    const payload: CallbackEnvelope = {
      contract_version: "1.0",
      request_id: "query-request-failed",
      ok: false,
      data: {
        task_type: "check_feed_status",
        business_id: store.externalStoreId,
        upload_id: pendingTask.uploadId,
      },
      error: { code: "AMAZON_QUERY_FAILED", message: "查询 Amazon 结果失败" },
    }
    prisma.productPublishTask.findFirst.mockResolvedValue(pendingTask)
    prisma.productPublishTask.findMany.mockResolvedValue([pendingTask])
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.QUERY_RESULT,
      requestId: "query-request-failed",
      taskId: pendingTask.id,
      uploadId: pendingTask.uploadId,
    })

    await expect(service.handleCallback(callbackApiKey, payload)).resolves.toMatchObject({
      success: true,
    })

    expect(eventsService.publishRefreshCompleted).toHaveBeenCalledWith(pendingTask.userId, {
      taskId: pendingTask.taskId,
      requestId: "query-request-failed",
      callbackOk: false,
      amazonStatus: null,
      taskStatus: ProductPublishTaskStatus.PUBLISHING,
      publishOutcome: null,
      receivedAt: expect.any(String),
    })
  })

  it("失败回调通过 request_id 关联调度，并保留提交锁禁止重提", async () => {
    const pendingTask = publishingTaskFixture({
      submitRequestId: "submit-request-1",
      submittedFileUrl: "https://files.example.com/input.xlsx",
      uploadId: null,
    })
    const payload: CallbackEnvelope = {
      contract_version: "1.0",
      request_id: "submit-request-1",
      ok: false,
      data: {
        task_type: "upload_listing",
        business_id: store.externalStoreId,
        file_url: "https://files.example.com/input.xlsx",
      },
      error: { code: "AMAZON_REJECTED", message: "Amazon 拒绝文件" },
    }
    prisma.productPublishTask.findFirst.mockResolvedValue(pendingTask)
    prisma.productPublishTask.findMany.mockResolvedValue([pendingTask])
    prisma.productPublishTask.findUnique.mockResolvedValue(pendingTask)
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.SUBMIT_PUBLISH,
      requestId: "submit-request-1",
      taskId: pendingTask.id,
    })

    await expect(service.handleCallback(callbackApiKey, payload)).resolves.toMatchObject({
      success: true,
    })

    expect(taskWrites()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: pendingTask.id }),
        data: expect.objectContaining({
          status: ProductPublishTaskStatus.COMPLETED,
          publishOutcome: ProductPublishOutcome.FAILED,
          publishErrorMessage: expect.stringContaining("AMAZON_REJECTED"),
        }),
      })
    )
    expect(taskWrites().some(write => write.data.submitRequestId === null)).toBe(false)
    expect(failedCallbackWrite()).toMatchObject({
      data: expect.objectContaining({
        status: "FAILED",
        success: false,
        responsePayload: payload,
      }),
    })
  })

  it("相同 request_id 的成功回调重复到达时幂等返回，不重复更新业务表", async () => {
    const payload = uploadCallback({ request_id: "submit-request-1" })
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.SUBMIT_PUBLISH,
      requestId: "submit-request-1",
      taskId: baseTask.id,
      status: "SUCCESS",
      responsePayload: payload,
    })
    prisma.productPublishTask.findMany.mockResolvedValue([publishingTaskFixture()])

    await expect(service.handleCallback(callbackApiKey, payload)).resolves.toMatchObject({
      success: true,
    })

    expect(prisma.productPublishTask.update).not.toHaveBeenCalled()
    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
    expect(prisma.productPublishStoreClassification.update).not.toHaveBeenCalled()
    expect(prisma.productPublishStoreClassification.updateMany).not.toHaveBeenCalled()
  })

  it("即使提供 request_id，成功 data 仍必须携带动作对应的业务定位字段", async () => {
    const payload: CallbackEnvelope = {
      contract_version: "1.0",
      request_id: "submit-request-1",
      ok: true,
      data: {
        task_type: "upload_listing",
        business_id: store.externalStoreId,
        upload_id: "amazon-upload-1",
      },
    }
    callbackLog = waitingLog({
      operation: ProductPublishRpaOperation.SUBMIT_PUBLISH,
      requestId: "submit-request-1",
      taskId: baseTask.id,
    })

    await expect(service.handleCallback(callbackApiKey, payload)).rejects.toBeInstanceOf(
      BadRequestException
    )
    expect(prisma.productPublishTask.updateMany).not.toHaveBeenCalled()
    expect(prisma.productPublishStoreClassification.updateMany).not.toHaveBeenCalled()
  })

  describe("模板批量下发与逐项回调", () => {
    let templates: Array<TemplateFixture & { templateSyncedAt: Date }>
    let logs: Array<Record<string, unknown>>
    beforeEach(() => {
      templates = [
        { ...template, templateSyncedAt: new Date("2026-01-01") },
        {
          ...template,
          id: 32,
          classification: "NOTEBOOK COMPUTER",
          templateSyncedAt: new Date("2026-01-01"),
        },
        {
          ...template,
          id: 33,
          storeId: 10,
          store: { ...store, id: 10, externalStoreId: "27537578181301" },
          templateSyncedAt: new Date("2026-01-01"),
        },
      ]
      logs = []
      prisma.productPublishStoreClassification.findMany.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(templates.filter(item => matches(item, where)).map(item => ({ ...item })))
      )
      prisma.productPublishStoreClassification.findUnique.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(templates.find(item => matches(item, where)))
      )
      prisma.productPublishStoreClassification.findFirst.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(templates.find(item => matches(item, where)))
      )
      prisma.productPublishStoreClassification.updateMany.mockImplementation(
        ({ where, data }: WriteArgs) => {
          const found = templates.filter(item => matches(item, where))
          for (const item of found) Object.assign(item, data, { updatedAt: new Date() })
          return Promise.resolve({ count: found.length })
        }
      )
      prisma.productPublishRpaLog.create.mockImplementation(({ data }: WriteArgs) => {
        const log = { ...data, id: 101 + logs.length, createdAt: new Date() }
        logs.push(log)
        return Promise.resolve(log)
      })
      prisma.productPublishRpaLog.findUnique.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(logs.find(item => matches(item, where)) ?? null)
      )
      prisma.productPublishRpaLog.findFirst.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve([...logs].reverse().find(item => matches(item, where)) ?? null)
      )
      prisma.productPublishRpaLog.findMany.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(logs.filter(item => matches(item, where)))
      )
      prisma.productPublishRpaLog.updateMany.mockImplementation(({ where, data }: WriteArgs) => {
        const found = logs.filter(item => matches(item, where))
        for (const item of found) Object.assign(item, data)
        return Promise.resolve({ count: found.length })
      })
    })

    it("同店铺聚合、不同店铺放外层，一次上传启动，逐类目保留独立日志和请求锁", async () => {
      const result = await service.refreshTemplates()
      expect(result).toMatchObject({ total: 3, success: 3, failed: 0 })
      expect(yingdao.uploadFile).toHaveBeenCalledTimes(1)
      expect(yingdao.startTask).toHaveBeenCalledTimes(1)
      expect(lastRequest).toEqual([
        {
          business_type: "Amazon",
          business_id: store.externalStoreId,
          tasks_info: [
            {
              task_type: "download_listing",
              task_id: "",
              rpa_storage: "",
              task_param: { category: "HEADPHONES" },
            },
            {
              task_type: "download_listing",
              task_id: "",
              rpa_storage: "",
              task_param: { category: "NOTEBOOK COMPUTER" },
            },
          ],
        },
        {
          business_type: "Amazon",
          business_id: "27537578181301",
          tasks_info: [
            {
              task_type: "download_listing",
              task_id: "",
              rpa_storage: "",
              task_param: { category: "HEADPHONES" },
            },
          ],
        },
      ])
      expect(new Set(logs.map(item => item.requestId)).size).toBe(3)
      expect(new Set(logs.map(item => item.idempotentUuid)).size).toBe(1)
      expect(logs.every(item => item.status === "WAITING_CALLBACK")).toBe(true)
      expect(
        templates.every(item => item.templateStatus === "PENDING" && item.templateRequestId)
      ).toBe(true)
      expect(yingdao.startTask).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleRelaParams: [expect.objectContaining({ runTimeout: 10800 })],
        })
      )
      for (const log of logs)
        expect(
          (log.expiresAt as Date).getTime() - (log.createdAt as Date).getTime()
        ).toBeGreaterThan(11390_000)
    })

    it("逐条成功/失败回调分别落库，仅失败项重试，未回调项保持等待，旧模板仍保留", async () => {
      await service.refreshTemplates()
      await service.handleCallback(callbackApiKey, templateCallback(0, true))
      await service.handleCallback(callbackApiKey, templateCallback(1, false))
      expect(templates.map(item => item.templateStatus)).toEqual(["SUCCESS", "FAILED", "PENDING"])
      expect(templates[0].templateUrl).toBe("https://templates.example.com/new.xlsm")
      expect(templates[1].templateUrl).toBe(template.templateUrl)
      expect(logs.map(item => item.status)).toEqual(["SUCCESS", "FAILED", "WAITING_CALLBACK"])
      templates[1].updatedAt = new Date(Date.now() - 6 * 60_000)
      await service.retryFailedTemplates()
      expect(yingdao.startTask).toHaveBeenCalledTimes(2)
      expect(lastRequest).toEqual([
        {
          business_type: "Amazon",
          business_id: store.externalStoreId,
          tasks_info: [
            {
              task_type: "download_listing",
              task_id: "",
              rpa_storage: "",
              task_param: { category: "NOTEBOOK COMPUTER" },
            },
          ],
        },
      ])
      expect(logs[3]).toMatchObject({ attempt: 2, classification: "NOTEBOOK COMPUTER" })
      expect(templates[0].templateStatus).toBe("SUCCESS")
      expect(templates[2].templateRequestId).toBe(logs[2].requestId)
    })

    it.each(["upload", "start", "log"])("批量 %s 确定性失败释放所有锁，保留旧文件", async phase => {
      if (phase === "upload") yingdao.uploadFile.mockRejectedValue(new Error("文件上传失败"))
      if (phase === "start") yingdao.startTask.mockRejectedValue(new Error("应用不存在"))
      if (phase === "log")
        prisma.productPublishRpaLog.create
          .mockImplementationOnce(({ data }: WriteArgs) => {
            const log = { ...data, id: 101, createdAt: new Date() }
            logs.push(log)
            return Promise.resolve(log)
          })
          .mockRejectedValueOnce(new Error("日志写入失败"))
      const result = await service.refreshTemplates()
      expect(result).toMatchObject({ failed: 3, success: 0 })
      expect(
        templates.every(
          item =>
            item.templateRequestId === null &&
            item.templateStatus === "FAILED" &&
            item.templateUrl === template.templateUrl
        )
      ).toBe(true)
      expect(logs.every(item => item.status === "FAILED")).toBe(true)
      if (phase === "log") expect(yingdao.uploadFile).not.toHaveBeenCalled()
    })

    it("批量启动超时保留全部锁，不立即重复启动", async () => {
      yingdao.startTask.mockRejectedValue(new Error("network timeout"))
      await service.refreshTemplates()
      await service.retryFailedTemplates()
      expect(yingdao.startTask).toHaveBeenCalledTimes(1)
      expect(logs.every(item => item.status === "WAITING_CALLBACK")).toBe(true)
      expect(
        templates.every(item => item.templateRequestId && item.templateStatus === "PENDING")
      ).toBe(true)
    })

    it("快速回调先于启动返回时，不把成功日志退回等待，也不覆盖新模板", async () => {
      yingdao.startTask.mockImplementationOnce(async () => {
        await service.handleCallback(callbackApiKey, templateCallback(0, true))
        return dispatchResult()
      })
      await service.refreshTemplates()
      expect(logs.map(item => item.status)).toEqual([
        "SUCCESS",
        "WAITING_CALLBACK",
        "WAITING_CALLBACK",
      ])
      expect(templates[0].templateRequestId).toBeNull()
      expect(templates[0].templateUrl).toBe("https://templates.example.com/new.xlsm")
    })

    it("准备中断释放尚未下发的请求，不遗留无日志的锁", async () => {
      prisma.productPublishStoreClassification.findUnique
        .mockResolvedValueOnce(templates[0])
        .mockRejectedValueOnce(new Error("读取类目失败"))
      await expect(service.refreshTemplates()).rejects.toThrow("读取类目失败")
      expect(yingdao.startTask).not.toHaveBeenCalled()
      expect(templates.every(item => item.templateRequestId === null)).toBe(true)
    })

    it("不同店铺失败项再次聚合为一个批次，成功类目不补发", async () => {
      await service.refreshTemplates()
      await service.handleCallback(callbackApiKey, templateCallback(0, false))
      await service.handleCallback(callbackApiKey, templateCallback(1, true))
      await service.handleCallback(callbackApiKey, templateCallback(2, false))
      for (const item of templates) item.updatedAt = new Date(Date.now() - 6 * 60_000)
      await service.retryFailedTemplates()
      expect(yingdao.startTask).toHaveBeenCalledTimes(2)
      expect(lastRequest?.map(item => [item.business_id, item.tasks_info.length])).toEqual([
        [store.externalStoreId, 1],
        ["27537578181301", 1],
      ])
      expect(logs.slice(3).map(item => item.attempt)).toEqual([2, 2])
      expect(templates[1].templateStatus).toBe("SUCCESS")
    })

    it("根据各日志截止时间处理超时，只补发过期项，批次其它项不提前超时", async () => {
      await service.refreshTemplates()
      logs[0].expiresAt = new Date(Date.now() - 1000)
      await service.retryFailedTemplates()
      expect(logs.map(item => item.status)).toEqual([
        "TIMEOUT",
        "WAITING_CALLBACK",
        "WAITING_CALLBACK",
      ])
      expect(templates[0].templateStatus).toBe("FAILED")
      expect(templates[0].templateUrl).toBe(template.templateUrl)
      expect(yingdao.startTask).toHaveBeenCalledTimes(1)
      templates[0].updatedAt = new Date(Date.now() - 6 * 60_000)
      await service.retryFailedTemplates()
      expect(yingdao.startTask).toHaveBeenCalledTimes(2)
      expect(lastRequest?.[0].tasks_info).toHaveLength(1)
      expect(logs[3]).toMatchObject({ attempt: 2, classification: "HEADPHONES" })
      expect(logs[1].status).toBe("WAITING_CALLBACK")
    })

    it("非法分类不占锁且不阻止其它有效分类批量下发", async () => {
      templates[0].classification = "INVALID_CATEGORY"
      const result = await service.refreshTemplates()
      expect(result).toMatchObject({ total: 3, success: 2, failed: 1 })
      expect(templates[0].templateRequestId).toBeNull()
      expect(yingdao.startTask).toHaveBeenCalledTimes(1)
      expect(logs).toHaveLength(2)
    })

    it("同批混合失败仅重发可恢复项，缺店铺和空密码仍保留旧模板", async () => {
      await service.refreshTemplates()
      for (const [index, message] of [
        "未查询到店铺：123456",
        "传入密码为空，网页中自动填充密码也为空，请检查。",
        "下载模板网络超时",
      ].entries()) {
        const payload = templateCallback(index, false)
        payload.error = { code: "RPA_ERROR", message }
        await service.handleCallback(callbackApiKey, payload)
        templates[index].updatedAt = new Date(Date.now() - 6 * 60_000)
      }
      await expect(service.retryFailedTemplates()).resolves.toMatchObject({
        total: 3,
        success: 1,
        skipped: 2,
      })
      expect(yingdao.startTask).toHaveBeenCalledTimes(2)
      expect(lastRequest).toEqual([
        {
          business_type: "Amazon",
          business_id: "27537578181301",
          tasks_info: [
            {
              task_type: "download_listing",
              task_id: "",
              rpa_storage: "",
              task_param: { category: "HEADPHONES" },
            },
          ],
        },
      ])
      expect(templates.slice(0, 2).map(item => item.templateStatus)).toEqual(["FAILED", "FAILED"])
      expect(
        templates
          .slice(0, 2)
          .every(
            item => item.templateRequestId === null && item.templateUrl === template.templateUrl
          )
      ).toBe(true)
      expect(logs).toHaveLength(4)
    })

    it("混合店铺批次排除已取消店铺，不影响其他店铺且保留其旧模板", async () => {
      templates[2].store.externalStoreId = "27859233726983"
      const before = { ...templates[2] }
      await expect(service.refreshAllTemplatesOnce()).resolves.toMatchObject({
        total: 3,
        success: 2,
        skipped: 1,
      })
      expect(yingdao.startTask).toHaveBeenCalledTimes(1)
      expect(lastRequest?.map(item => item.business_id)).toEqual([store.externalStoreId])
      expect(lastRequest?.[0].tasks_info).toHaveLength(2)
      expect(templates[2]).toEqual(before)
      expect(logs).toHaveLength(2)
    })

    function templateCallback(index: number, ok: boolean): CallbackEnvelope {
      const item = templates[index]
      return {
        contract_version: "1.0",
        ok,
        data: {
          task_type: "download_listing",
          business_id: item.store.externalStoreId,
          category: item.classification,
          ...(ok ? { template_url: "https://templates.example.com/new.xlsm" } : {}),
        },
        ...(ok ? {} : { error: { code: "RPA_ERROR", message: "下载失败" } }),
      }
    }

    function matches(value: unknown, condition: unknown): boolean {
      if (condition instanceof Date)
        return value instanceof Date && value.getTime() === condition.getTime()
      if (condition === null || typeof condition !== "object") return value === condition
      const fields = condition as Record<string, unknown>
      if ("in" in fields) return (fields.in as unknown[]).includes(value)
      if ("lte" in fields) return value instanceof Date && value <= (fields.lte as Date)
      if ("OR" in fields && !(fields.OR as unknown[]).some(item => matches(value, item)))
        return false
      return Object.entries(fields)
        .filter(([key]) => key !== "OR")
        .every(([key, expected]) =>
          matches((value as Record<string, unknown> | null)?.[key], expected)
        )
    }
  })

  function publishingTaskFixture(overrides: Partial<TaskFixture> = {}): TaskFixture {
    return {
      ...baseTask,
      status: ProductPublishTaskStatus.PUBLISHING,
      submitRequestId: "submit-request-1",
      resultRequestId: null,
      submittedFileUrl: "https://files.example.com/input.xlsx",
      skus: submittedSkus,
      uploadId: "amazon-upload-1",
      nextPollAt: null,
      ...overrides,
    }
  }

  function uploadCallback(overrides: Partial<CallbackEnvelope> = {}): CallbackEnvelope {
    return {
      contract_version: "1.0",
      ok: true,
      data: {
        task_type: "upload_listing",
        business_id: store.externalStoreId,
        file_url: "https://files.example.com/input.xlsx",
        upload_id: "amazon-upload-1",
      },
      ...overrides,
    }
  }

  function queryCallback(): CallbackEnvelope {
    return {
      contract_version: "1.0",
      ok: true,
      data: {
        task_type: "check_feed_status",
        business_id: store.externalStoreId,
        upload_id: "amazon-upload-1",
        status: "PARTIAL_SUCCESS",
        total_count: 2,
        success_count: 1,
        failed_count: 1,
        result_file_url: "https://files.example.com/result.xlsx",
        sku_asin_mapping: [
          { sku: "SKU-1", asin: "B000000001", status: "SUCCESS" },
          {
            sku: "SKU-2",
            asin: null,
            status: "FAILED",
            error_code: "INVALID_ATTRIBUTE",
            error_message: "属性错误",
          },
        ],
      },
    }
  }

  function waitingLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 101,
      operation: ProductPublishRpaOperation.SUBMIT_PUBLISH,
      source: ProductPublishRpaLogSource.API,
      status: "WAITING_CALLBACK",
      requestId: "submit-request-1",
      taskId: baseTask.id,
      storeId: store.id,
      classification: baseTask.classification,
      uploadId: null,
      requestPayload: null,
      responsePayload: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
      createdAt: new Date(Date.now() - 5_000),
      task: baseTask,
      store,
      ...overrides,
    }
  }

  function dispatchResult(): YingdaoStartTaskResult {
    return {
      taskUuid: "rpa-task-uuid",
      jobUuidList: ["rpa-job-uuid"],
      idempotentFlag: false,
    }
  }

  function currentTaskInfo() {
    const info = lastRequest?.[0]?.tasks_info[0]
    if (!info) throw new Error("RPA 请求缺少 tasks_info")
    return info
  }

  function taskWrites(): WriteArgs[] {
    return modelWrites(prisma.productPublishTask)
  }

  function templateWrites(): WriteArgs[] {
    return modelWrites(prisma.productPublishStoreClassification)
  }

  function logWrites(): WriteArgs[] {
    return modelWrites(prisma.productPublishRpaLog)
  }

  function waitingCallbackWrite(): WriteArgs | undefined {
    return logWrites().find(write => write.data.status === "WAITING_CALLBACK")
  }

  function successfulCallbackWrite(): WriteArgs | undefined {
    return logWrites().find(write => write.data.status === "SUCCESS")
  }

  function processingCallbackWrite(): WriteArgs | undefined {
    return logWrites().find(write => write.data.status === "PROCESSING_CALLBACK")
  }

  function failedCallbackWrite(): WriteArgs | undefined {
    return logWrites().find(write => write.data.status === "FAILED")
  }

  function modelWrites(model: { update: jest.Mock; updateMany: jest.Mock }): WriteArgs[] {
    return [...model.update.mock.calls, ...model.updateMany.mock.calls].map(
      ([args]) => args as WriteArgs
    )
  }
})
