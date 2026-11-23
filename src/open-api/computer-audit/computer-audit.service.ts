import { ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { OpenApiApp } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { uiLanguage, uiText } from "../../common/i18n/request-language"
import { PrismaService } from "../../prisma/prisma.service"
import { AsinCostService } from "../asin-cost.service"
import { asJson } from "../automotive-audit/automotive-audit.types"
import { CreateComputerAuditDto } from "./computer-audit.dto"
import { COMPUTER_RULE_VERSION } from "./computer-audit.kernel"

@Injectable()
export class ComputerAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly costs: AsinCostService
  ) {}

  async create(app: OpenApiApp, input: CreateComputerAuditDto) {
    if (app.status !== "ACTIVE" || !app.isComputerAuditEnabled) {
      throw new ForbiddenException({
        code: "COMPUTER_AUDIT_FORBIDDEN",
        message: uiText(
          "当前接入方未开通电脑审计接口",
          "Computer audits are not enabled for this application."
        ),
      })
    }
    const model = this.config
      .get<string>("AI_GATEWAY_COMPUTER_AUDIT_MODEL", "ZQ-Multimodal-Gemini-3.8-Flash")
      .trim()
    if (!model || !this.config.get<string>("AI_GATEWAY_API_KEY")?.trim()) {
      throw new ServiceUnavailableException({
        code: "AUDIT_MODEL_NOT_CONFIGURED",
        message: uiText("审计模型尚未配置", "The audit model is not configured."),
      })
    }
    if (!this.config.get<string>("SIF_API_KEY")?.trim()) {
      throw new ServiceUnavailableException({
        code: "AUDIT_TRAFFIC_NOT_CONFIGURED",
        message: uiText(
          "关键词与流量数据源尚未配置",
          "The keyword and traffic data source is not configured."
        ),
      })
    }
    return this.prisma.asinAuditTask.create({
      data: {
        costUserId: await this.costs.resolveOwner(app),
        taskId: `audit_${randomUUID()}`,
        appId: app.appId,
        auditType: "COMPUTER",
        asin: input.asin,
        sku: "",
        payload: {
          create: {
            input: asJson(input),
            config: {
              responseLanguage: uiLanguage(),
              model,
              ruleVersion: COMPUTER_RULE_VERSION,
              scoreOutputFormat: "compact",
              outputFormatVersion: "2",
              gatewayBaseUrl: this.config.get<string>(
                "AI_GATEWAY_BASE_URL",
                "https://ai-gateway-api-dev.zhilingtech.com/v1"
              ),
              crawlerBaseUrl: this.config.get<string>(
                "CRAWLER_API_BASE_URL",
                "http://47.108.114.243:6666"
              ),
              sifBaseUrl:
                this.config.get<string>("SIF_BASE_URL") ||
                this.config.get<string>("SIF_API_BASE_URL") ||
                "https://www.sif.com",
              mcpUrl: this.config.get<string>(
                "SELLERSPRITE_MCP_URL",
                "https://mcp.sellersprite.com/mcp"
              ),
            },
          },
        },
      },
      select: {
        taskId: true,
        auditType: true,
        asin: true,
        status: true,
        stage: true,
        createdAt: true,
      },
    })
  }
}
