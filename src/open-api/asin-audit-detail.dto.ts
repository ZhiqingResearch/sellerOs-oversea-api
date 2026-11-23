import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsIn, IsInt, IsOptional } from "class-validator"

export class AuditDetailQueryDto {
  @ApiPropertyOptional({
    description: "仅筛选缓存日级趋势；不重算已完成审计分数",
    enum: [7, 14, 30],
    default: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([7, 14, 30])
  windowDays?: number
}
