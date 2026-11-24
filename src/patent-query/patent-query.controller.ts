import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import {
  CitationDto,
  ContextQueryDto,
  CreatePatentQueryDto,
  DecisionDto,
  ImportListingDto,
  ListingTextDto,
  QueryPatentQueryDto,
  QuotePatentQueryDto,
  RefreshImagesDto,
  ResponseModeDto,
  ResultPageDto,
  ResultsQueryDto,
  RiskPageDto,
  TaskViewDto,
  TodoDto,
} from "./dto/patent-query.dto"
import { PatentQueryExportService } from "./patent-query-export.service"
import { PatentQueryPdfService } from "./patent-query-pdf.service"
import { PatentQueryNiceClassService } from "./patent-query.nice-class.service"
import { PatentQueryService } from "./patent-query.service"
type UserRequest = { user: { id: number } }
@ApiTags("产品专利查询")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("tool.patent_query")
@Controller("patent-query")
export class PatentQueryController {
  constructor(
    private readonly service: PatentQueryService,
    private readonly niceClasses: PatentQueryNiceClassService,
    private readonly pdf: PatentQueryPdfService,
    private readonly exports: PatentQueryExportService
  ) {}
  @Post("quote")
  @HttpCode(200)
  @ApiOperation({ summary: "本地报价及检测覆盖范围" })
  quote(@Request() req: UserRequest, @Body() dto: QuotePatentQueryDto) {
    return this.service.quote(req.user.id, dto)
  }
  @Post("import-listing")
  @HttpCode(200)
  @ApiOperation({ summary: "从 ASIN 或亚马逊链接导入 Listing" })
  importListing(@Body() dto: ImportListingDto) {
    return this.service.importListing(dto)
  }
  @Get("nice-classes")
  @ApiOperation({ summary: "获取供文字商标检测选择的全部 45 个尼斯类别" })
  @ApiOkResponse({
    schema: {
      type: "object",
      required: ["classes"],
      properties: {
        classes: {
          type: "array",
          items: {
            type: "object",
            required: ["code", "name"],
            properties: {
              code: { type: "string", example: "021" },
              name: { type: "string", example: "家用及厨房器具、杯具和餐具" },
            },
          },
        },
      },
    },
  })
  listNiceClasses() {
    return this.niceClasses.list()
  }
  @Post("nice-classes/recommend")
  @HttpCode(200)
  @ApiOperation({ summary: "根据 Listing 文本推荐文字商标检测的尼斯类别" })
  @ApiOkResponse({
    schema: { example: { recommendations: [{ code: "021", name: "家用及厨房器具、杯具和餐具" }] } },
  })
  recommendNiceClasses(@Body() dto: ListingTextDto) {
    return this.niceClasses.recommend(dto)
  }
  @Post("tasks")
  @ApiOperation({ summary: "创建异步检测；同请求 ID 幂等" })
  async create(
    @Request() req: UserRequest,
    @Body() dto: CreatePatentQueryDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const r = await this.service.create(req.user.id, dto)
    res.status(r.created ? 201 : 200)
    return r.data
  }
  @Get("tasks")
  @ApiOperation({ summary: "历史报告或运行中/待结算任务" })
  list(@Request() req: UserRequest, @Query() dto: QueryPatentQueryDto) {
    return this.service.list(req.user.id, dto)
  }
  @Get("tasks/:id")
  @ApiOperation({ summary: "本地任务进度、输入及已结算报告" })
  detail(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Query() query: TaskViewDto
  ) {
    void query
    return this.service.overview(req.user.id, id)
  }
  @Post("tasks/:id/exports")
  @ApiOperation({ summary: "Create or reuse a PDF export for the current report version" })
  async createExport(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response
  ) {
    const job = await this.exports.create(req.user.id, id)
    res.status(job.status === "QUEUED" || job.status === "PROCESSING" ? 202 : 200)
    return job
  }
  @Get("tasks/:id/exports/:exportId")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Read PDF export status" })
  exportStatus(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("exportId") exportId: string
  ) {
    return this.exports.status(req.user.id, id, exportId)
  }
  @Get("tasks/:id/exports/:exportId/download")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Get a fresh 10-minute private PDF download link" })
  exportDownload(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("exportId") exportId: string
  ) {
    return this.exports.download(req.user.id, id, exportId)
  }
  @Get("tasks/:id/report.pdf")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "下载已结算任务的完整 PDF 报告" })
  @ApiOkResponse({
    content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
  })
  async downloadPdf(@Request() req: UserRequest, @Param("id", ParseIntPipe) id: number) {
    const bytes = await this.pdf.export(req.user.id, id)
    return new StreamableFile(bytes, {
      type: "application/pdf",
      disposition: `attachment; filename="patent-report-${id}.pdf"`,
      length: bytes.length,
    })
  }
  @Get("tasks/:id/input")
  @ApiOperation({ summary: "按需获取完整原始输入用于编辑或重测" })
  taskInput(@Request() req: UserRequest, @Param("id", ParseIntPipe) id: number) {
    return this.service.taskInput(req.user.id, id)
  }
  @Get("tasks/:id/results")
  @ApiOperation({ summary: "风险单选及本地结果分页" })
  results(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Query() dto: ResultsQueryDto
  ) {
    return this.service.results(req.user.id, id, dto)
  }
  @Get("tasks/:id/words/:wordId/marks")
  @ApiOperation({ summary: "归一词内商标去重后分页" })
  marks(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("wordId") wordId: string,
    @Query() dto: RiskPageDto
  ) {
    return this.service.marks(req.user.id, id, wordId, dto)
  }
  @Get("tasks/:id/results/:rowId/detail")
  @ApiOperation({ summary: "单命中本地详情（不包含全部来源）" })
  rowDetail(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("rowId") rowId: string
  ) {
    return this.service.rowDetail(req.user.id, id, rowId)
  }
  @Get("tasks/:id/results/:rowId/sources")
  @ApiOperation({ summary: "合并文字商标的来源分页" })
  sources(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("rowId") rowId: string,
    @Query() dto: ResultPageDto
  ) {
    return this.service.rowDetail(req.user.id, id, rowId, dto)
  }
  @Get("tasks/:id/todos")
  @ApiOperation({ summary: "轻待办分页" })
  todos(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Query() dto: ResultPageDto
  ) {
    return this.service.todos(req.user.id, id, dto)
  }
  @Get("tasks/:id/todos/:todoId/targets")
  @ApiOperation({ summary: "待办定位目标分页" })
  targets(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("todoId") todoId: string,
    @Query() dto: ResultPageDto
  ) {
    return this.service.todos(req.user.id, id, dto, todoId)
  }
  @Get("tasks/:id/context")
  @ApiOperation({ summary: "按需读取覆盖缺口、OCR、案件和知名IP" })
  context(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Query() dto: ContextQueryDto
  ) {
    return this.service.context(req.user.id, id, dto)
  }
  @Post("tasks/:id/settle")
  @HttpCode(200)
  @ApiOperation({ summary: "仅重试结算，不重新检测" })
  settle(@Request() req: UserRequest, @Param("id", ParseIntPipe) id: number) {
    return this.service.settle(req.user.id, id)
  }
  @Patch("tasks/:id/decision")
  @ApiOperation({ summary: "记录命中处理状态（不影响风险）" })
  decision(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: DecisionDto,
    @Query() query: ResponseModeDto
  ) {
    void query
    return this.service.decision(req.user.id, id, dto)
  }
  @Patch("tasks/:id/todo")
  @ApiOperation({ summary: "更新待办完成状态" })
  todo(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: TodoDto,
    @Query() query: ResponseModeDto
  ) {
    void query
    return this.service.todo(req.user.id, id, dto.todoId, dto.done)
  }
  @Get("tasks/:id/patents/:targetId/detail")
  @ApiOperation({ summary: "本报告命中专利详情（缓存）" })
  patent(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("targetId") target: string
  ) {
    return this.service.patent(req.user.id, id, target)
  }
  @Get("tasks/:id/patents/:targetId/citations")
  @ApiOperation({ summary: "本报告命中专利的引用/被引用（缓存）" })
  citations(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("targetId") target: string,
    @Query() dto: CitationDto
  ) {
    return this.service.patent(req.user.id, id, target, dto.direction)
  }
  @Post("tasks/:id/refresh-images")
  @HttpCode(200)
  @ApiOperation({ summary: "只刷新已有报告图样链接，不重新检测" })
  refresh(
    @Request() req: UserRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RefreshImagesDto,
    @Query() query: ResponseModeDto
  ) {
    void query
    return this.service.refreshImages(req.user.id, id, dto)
  }
  @Delete("tasks/:id")
  @ApiOperation({ summary: "软删除已完成报告" })
  remove(@Request() req: UserRequest, @Param("id", ParseIntPipe) id: number) {
    return this.service.remove(req.user.id, id)
  }
}
