import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import * as XLSX from "xlsx"
import { RequirePermissions } from "../../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../../auth/guards/permissions.guard"
import { uiText } from "../../common/i18n/request-language"
import { ListingModelSelectionGuard } from "../guards/listing-model-selection.guard"
import { GenerateAutomotiveDto, MatchCategoryDto, PrepareAutomotiveDto } from "./automotive.dto"
import { AutomotiveService } from "./automotive.service"

type Authed = { user: { id: number } }

// 在全局whitelist删除未知字段之前检查，防止完整商品对象被静默当成分类输入。
export class CategoryInputGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const body = context.switchToHttp().getRequest<{ body?: unknown }>().body
    const allowed = new Set(["runId", "market", "keyword", "productTitle", "documentUrl", "model"])
    if (body && Object.keys(body).some(k => !allowed.has(k)))
      throw new BadRequestException(
        "类目识别只接收keyword、productTitle、documentUrl及站点/模型/runId，不接收完整商品信息"
      )
    return true
  }
}

@ApiTags("Listing 类目识别")
@ApiBearerAuth()
@Controller("match-category")
@UseGuards(JwtAuthGuard, PermissionsGuard, ListingModelSelectionGuard, new CategoryInputGuard())
@RequirePermissions("tool.listing_generate")
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class ListingCategoryController {
  constructor(private readonly service: AutomotiveService) {}

  @Post()
  @ApiOperation({ summary: "文字全文、商品标题和文档URL分类；不接收完整商品data" })
  async match(
    @Request() req: Authed,
    @Body() dto: MatchCategoryDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.service.match(req.user.id, dto)
    response.status(result.matchStatus === "RUNNING" ? 202 : 200)
    return result
  }
}

@ApiTags("Listing 汽配生成")
@ApiBearerAuth()
@Controller("listing/automotive")
@UseGuards(JwtAuthGuard, PermissionsGuard, ListingModelSelectionGuard)
@RequirePermissions("tool.listing_generate")
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class AutomotiveController {
  constructor(private readonly service: AutomotiveService) {}

  @Post("prepare")
  @ApiOperation({ summary: "复用分类文字和文档正文，结合完整商品数据提取汽配资料" })
  async prepare(
    @Request() req: Authed,
    @Body() dto: PrepareAutomotiveDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.service.prepare(req.user.id, dto)
    response.status(result.preparationStatus === "RUNNING" ? 202 : 200)
    return result
  }

  @Post("generations")
  @ApiOperation({ summary: "提交汽配单方案后台任务，自检后自动评分，完整交付后整单结算" })
  async generate(
    @Request() req: Authed,
    @Body() dto: GenerateAutomotiveDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.service.generate(req.user.id, dto)
    response.status(202)
    return result
  }

  @Get("runs/:runId")
  @ApiOperation({ summary: "查询本人分类、资料、生成及评分结果；不触发抓取或模型调用" })
  @ApiQuery({ name: "attemptId", required: false, description: "指定生成尝试UUID" })
  read(
    @Request() req: Authed,
    @Param("runId", new ParseUUIDPipe()) runId: string,
    @Query("attemptId", new ParseUUIDPipe({ optional: true })) attemptId?: string
  ) {
    return this.service.read(req.user.id, runId, attemptId)
  }

  @Get("runs/:runId/export")
  @ApiOperation({ summary: "导出已保存的汽配Listing为Excel，不重新调用模型" })
  @ApiQuery({ name: "attemptId", required: false })
  async export(
    @Request() req: Authed,
    @Param("runId", new ParseUUIDPipe()) runId: string,
    @Query("attemptId", new ParseUUIDPipe({ optional: true })) attemptId: string | undefined,
    @Res() response: Response
  ) {
    const state = await this.service.read(req.user.id, runId, attemptId)
    const result = state.generation?.result
    if (!result)
      throw new BadRequestException(
        uiText("本次生成暂无可导出结果", "No generated result is available to export")
      )
    const workbook = XLSX.utils.book_new()
    const rows = [
      [uiText("字段", "Field"), uiText("内容", "Content")],
      ["Title", result.title],
      ...result.itemHighlights.map((v: string, i: number) => [`Item Highlight ${i + 1}`, v]),
      ...result.bullets.map((v: string, i: number) => [`Bullet ${i + 1}`, v]),
      ["Search Terms", result.searchTerms.join(" ")],
      ["Description HTML", result.description],
      ...result.structuredAttributes.map((a: { name: string; value: string }) => [a.name, a.value]),
    ]
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Listing")
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(result.checks),
      uiText("规则自检", "Rule checks")
    )
    response.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="automotive-listing-${runId}.xlsx"`
    )
    response.send(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))
  }
}
