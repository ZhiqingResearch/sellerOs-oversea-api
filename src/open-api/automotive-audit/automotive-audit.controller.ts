import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UseGuards, UseInterceptors,
} from "@nestjs/common"
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { OpenApiApp } from "@prisma/client"
import { AuditDetailQueryDto } from "../asin-audit-detail.dto"
import { AuditRequestInterceptor } from "../asin-audit-request-queue"
import { OpenApiAuthGuard } from "../open-api-auth.guard"
import { CreateAutomotiveAuditDto } from "./automotive-audit.dto"
import { AutomotiveAuditService } from "./automotive-audit.service"

@ApiTags("开放接口-ASIN汽配审计")
@ApiHeader({ name: "x-app-id", required: true })
@ApiHeader({ name: "x-timestamp", required: true, description: "毫秒时间戳，±5分钟" })
@ApiHeader({ name: "x-nonce", required: true })
@ApiHeader({ name: "x-sign", required: true, description: "沿用niuniu的HMAC-SHA256原始请求体签名" })
@UseGuards(OpenApiAuthGuard)
@UseInterceptors(AuditRequestInterceptor)
@Controller("open/asin-audit")
export class AutomotiveAuditController {
  constructor(private readonly service: AutomotiveAuditService) {}

  @Post("automotive")
  @HttpCode(202)
  @ApiOperation({ summary: "提交汽配ASIN审计，美国站，返回任务号" })
  create(@Request() req: { openApiApp: OpenApiApp }, @Body() dto: CreateAutomotiveAuditDto) {
    return this.service.create(req.openApiApp, dto)
  }

  @Get("tasks/:taskId")
  @ApiOperation({ summary: "查询当前接入方的审计任务和完整结果，不重新审计" })
  get(@Request() req: { openApiApp: OpenApiApp }, @Param("taskId") taskId: string) {
    return this.service.get(req.openApiApp, taskId)
  }

  @Get("tasks/:taskId/details")
  @ApiOperation({ summary: "查询审计结构化详情和已有证据，仅查库，不重新审计或取证" })
  getDetails(
    @Request() req: { openApiApp: OpenApiApp },
    @Param("taskId") taskId: string,
    @Query() query: AuditDetailQueryDto
  ) {
    return this.service.getDetails(req.openApiApp, taskId, query.windowDays)
  }
}
