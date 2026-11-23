import { Body, Controller, Get, HttpCode, Param, Post, Request, UseGuards, UseInterceptors } from "@nestjs/common"
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { OpenApiApp } from "@prisma/client"
import { AuditRequestInterceptor } from "../asin-audit-request-queue"
import { OpenApiAuthGuard } from "../open-api-auth.guard"
import { AsinOptimizationService } from "./asin-optimization.service"

/** No new evidence or model parameters: the original task is the immutable generation input. */
export class CreateAsinOptimizationDto {}

@ApiTags("开放接口-ASIN优化")
@ApiHeader({ name: "x-app-id", required: true })
@ApiHeader({ name: "x-timestamp", required: true })
@ApiHeader({ name: "x-nonce", required: true })
@ApiHeader({ name: "x-sign", required: true, description: "沿用牛牛HMAC-SHA256" })
@UseGuards(OpenApiAuthGuard)
@UseInterceptors(AuditRequestInterceptor)
@Controller("open/asin-audit/tasks/:taskId/optimization")
export class AsinOptimizationController {
  constructor(private readonly service: AsinOptimizationService) {}

  @Get()
  @ApiOperation({ summary: "读取电脑/汽配完整优化稿或执行状态，仅查库" })
  get(@Request() req: { openApiApp: OpenApiApp }, @Param("taskId") taskId: string) {
    return this.service.get(req.openApiApp, taskId)
  }

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: "复用已有优化稿；无稿才生成，按原taskId幂等" })
  create(
    @Request() req: { openApiApp: OpenApiApp },
    @Param("taskId") taskId: string,
    @Body() _dto: CreateAsinOptimizationDto
  ) {
    void _dto
    return this.service.create(req.openApiApp, taskId)
  }
}
