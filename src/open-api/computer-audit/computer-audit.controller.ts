import { Body, Controller, HttpCode, Post, Request, UseGuards, UseInterceptors } from "@nestjs/common"
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { OpenApiApp } from "@prisma/client"
import { AuditRequestInterceptor } from "../asin-audit-request-queue"
import { OpenApiAuthGuard } from "../open-api-auth.guard"
import { CreateComputerAuditDto } from "./computer-audit.dto"
import { ComputerAuditService } from "./computer-audit.service"

@ApiTags("开放接口-ASIN电脑审计")
@ApiHeader({ name: "x-app-id", required: true })
@ApiHeader({ name: "x-timestamp", required: true })
@ApiHeader({ name: "x-nonce", required: true })
@ApiHeader({ name: "x-sign", required: true, description: "沿用niuniu原始请求体HMAC签名" })
@UseGuards(OpenApiAuthGuard)
@UseInterceptors(AuditRequestInterceptor)
@Controller("open/asin-audit")
export class ComputerAuditController {
  constructor(private readonly service: ComputerAuditService) {}

  @Post("computer")
  @HttpCode(202)
  @ApiOperation({ summary: "提交电脑ASIN审计；通过通用tasks接口查询" })
  create(@Request() req: { openApiApp: OpenApiApp }, @Body() input: CreateComputerAuditDto) {
    return this.service.create(req.openApiApp, input)
  }
}
