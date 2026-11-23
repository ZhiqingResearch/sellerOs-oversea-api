import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QueryAsinCostDto extends PaginationDto {
  @ApiPropertyOptional({ description: "成本归属用户ID", example: 628 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number

  @ApiPropertyOptional({ description: "成本归属手机号，精确匹配" })
  @IsOptional()
  @Matches(/^\d{6,20}$/)
  phone?: string

  @ApiPropertyOptional({ description: "原审计taskId，精确匹配" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  taskId?: string

  @ApiPropertyOptional({ enum: ["AI_GATEWAY", "SIF", "MCP", "CRAWLER"] })
  @IsOptional()
  @IsIn(["AI_GATEWAY", "SIF", "MCP", "CRAWLER"])
  provider?: string

  @ApiPropertyOptional({
    description: "发生时间起点，带时区ISO时间，包含",
    example: "2026-11-01T00:00:00+08:00",
  })
  @IsOptional()
  @IsDateString()
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  startDate?: string

  @ApiPropertyOptional({
    description: "发生时间终点，带时区ISO时间，不包含",
    example: "2026-12-01T00:00:00+08:00",
  })
  @IsOptional()
  @IsDateString()
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  endDate?: string
}
