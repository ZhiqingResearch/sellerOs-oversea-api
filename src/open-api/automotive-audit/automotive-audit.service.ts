import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { OpenApiApp } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { uiLanguage, uiText } from "../../common/i18n/request-language"
import { PrismaService } from "../../prisma/prisma.service"
import { buildAuditDetailView } from "../asin-audit-detail.presenter"
import { buildAuditResultView } from "../asin-audit-result.presenter"
import { AsinCostService } from "../asin-cost.service"
import type { CreateAutomotiveAuditDto } from "./automotive-audit.dto"
import { asJson } from "./automotive-audit.types"

@Injectable()
export class AutomotiveAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly costs: AsinCostService
  ) {}

  async create(app: OpenApiApp, input: CreateAutomotiveAuditDto) {
    this._authorize(app)
    const model = this.config
      .get<string>("AI_GATEWAY_AUTOMOTIVE_AUDIT_MODEL", "ZQ-Multimodal-Gemini-3.8-Flash")
      .trim()
    if (!model || !this.config.get<string>("AI_GATEWAY_API_KEY")?.trim()) {
      throw new ServiceUnavailableException({
        code: "AUDIT_MODEL_NOT_CONFIGURED",
        message: uiText("审计模型尚未配置", "The audit model is not configured."),
      })
    }
    const { RULE_VERSION } = await import("./kernel/index.mjs")
    const task = await this.prisma.asinAuditTask.create({
      data: {
        costUserId: await this.costs.resolveOwner(app),
        taskId: `audit_${randomUUID()}`,
        appId: app.appId,
        asin: input.asin,
        sku: input.sku,
        payload: {
          create: {
            input: asJson(input),
            config: {
              responseLanguage: uiLanguage(),
              model,
              ruleVersion: RULE_VERSION,
              gatewayBaseUrl: this.config.get<string>(
                "AI_GATEWAY_BASE_URL",
                "https://ai-gateway-api-dev.zhilingtech.com/v1"
              ),
              crawlerBaseUrl: this.config.get<string>(
                "CRAWLER_API_BASE_URL",
                "http://47.108.114.243:6666"
              ),
              registeredBrand: this.config.get<string>(
                "AUTOMOTIVE_AUDIT_REGISTERED_BRAND",
                "DAFOLOGIA"
              ),
            },
          },
        },
      },
      select: {
        taskId: true,
        auditType: true,
        asin: true,
        sku: true,
        status: true,
        stage: true,
        createdAt: true,
      },
    })
    return task
  }

  async get(app: OpenApiApp, taskId: string) {
    const task = await this.prisma.asinAuditTask.findFirst({
      where: { taskId, appId: app.appId },
      select: {
        taskId: true,
        auditType: true,
        asin: true,
        sku: true,
        marketplace: true,
        status: true,
        stage: true,
        createdAt: true,
        completedAt: true,
        error: true,
        payload: { select: { result: true } },
      },
    })
    if (!task)
      throw new NotFoundException({
        code: "AUDIT_TASK_NOT_FOUND",
        message: uiText("审计任务不存在", "Audit task not found."),
      })
    if (task.auditType === "COMPUTER") {
      if (app.status !== "ACTIVE" || !app.isComputerAuditEnabled)
        throw new ForbiddenException({
          code: "COMPUTER_AUDIT_FORBIDDEN",
          message: uiText(
            "当前接入方未开通电脑审计接口",
            "Computer audits are not enabled for this application."
          ),
        })
    } else this._authorize(app)
    const { payload, ...summary } = task
    const result = buildAuditResultView(task.auditType, payload?.result)
    if (task.auditType === "COMPUTER") {
      const { sku: _unusedSku, ...computer } = summary
      void _unusedSku
      return { ...computer, result }
    }
    return { ...summary, result }
  }

  async getDetails(app: OpenApiApp, taskId: string, windowDays = 30) {
    // Reuse the exact existing task ownership and per-category authorization checks before loading evidence.
    const summary = await this.get(app, taskId)
    if (summary.status !== "COMPLETED") return { ...summary, details: null }
    const task = await this.prisma.asinAuditTask.findFirst({
      where: { taskId, appId: app.appId },
      select: {
        payload: { select: { result: true } },
        snapshots: {
          where: { provider: { in: ["CRAWLER", "SIF"] } },
          orderBy: { id: "asc" },
          select: {
            snapshotId: true,
            provider: true,
            state: true,
            httpStatus: true,
            request: true,
            rawResponse: true,
            fetchedAt: true,
            productPointer: true,
          },
        },
      },
    })
    if (!task)
      throw new NotFoundException({
        code: "AUDIT_TASK_NOT_FOUND",
        message: uiText("审计任务不存在", "Audit task not found."),
      })
    return {
      ...summary,
      details: task.payload?.result
        ? buildAuditDetailView(
            taskId,
            summary.auditType,
            summary.asin,
            task.payload.result,
            task.snapshots,
            windowDays
          )
        : null,
    }
  }

  private _authorize(app: OpenApiApp) {
    if (app.status !== "ACTIVE" || !app.isAutomotiveAuditEnabled)
      throw new ForbiddenException({
        code: "AUTOMOTIVE_AUDIT_FORBIDDEN",
        message: uiText(
          "当前接入方未开通汽配审计接口",
          "Automotive audits are not enabled for this application."
        ),
      })
  }
}
