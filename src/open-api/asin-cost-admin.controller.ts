import { Controller, Get, Query, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { AsinCostQueryService } from "./asin-cost-query.service"
import { QueryAsinCostDto } from "./dto/query-asin-cost.dto"

@ApiTags("后台审计成本与用量")
@ApiBearerAuth()
@Controller("admin/asin-audit-costs")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("company.admin")
export class AsinCostAdminController {
  constructor(private readonly costs: AsinCostQueryService) {}

  @Get()
  @ApiOperation({ summary: "分页查看审计实际成本、MCP估算和SIF实际配额；不触发审计或扣费" })
  list(@Query() query: QueryAsinCostDto) {
    return this.costs.list(query)
  }
}
