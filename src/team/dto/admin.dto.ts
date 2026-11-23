import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import type { AdminAdjustableCreditBucket } from "../../membership/membership.constants"
import { ADMIN_ADJUSTABLE_CREDIT_BUCKETS } from "../../membership/membership.constants"

/** 平台定制企业开通（不走订单、不开发收据；合同金额仅留痕） */
export class CreateCustomTeamDto {
  @ApiPropertyOptional({ example: "星辰科技", description: "企业名称（可后补）" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string

  @ApiProperty({ example: 10, description: "席位数" })
  @IsInt()
  @Min(1)
  seats: number

  @ApiProperty({ example: "2026-12-31T23:59:59.999Z", description: "到期时间（ISO）" })
  @IsDateString()
  expiresAt: string

  @ApiPropertyOptional({ example: 50000, description: "套餐积分池（30 天过期）", default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  poolPackageCredits?: number

  @ApiPropertyOptional({ example: 20000, description: "额外充值积分（永不过期）", default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  poolRechargeCredits?: number

  @ApiPropertyOptional({
    example: 0.7,
    description: "积分折扣（0.7=7 折，覆盖成员个人折扣）",
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(1)
  discount?: number

  @ApiPropertyOptional({
    example: 12000,
    description: "合同金额（人民币元，线下收款留痕，仅供财务对账；最多两位小数）",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  contractAmountCny?: number

  @ApiPropertyOptional({ example: "年框合同 2026-HT-018", description: "合同备注" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  contractNote?: string

  @ApiProperty({ example: 1001, description: "企业管理员用户 ID（必须指定，占一个席位）" })
  @IsInt()
  adminUserId: number

  @ApiPropertyOptional({ example: [1002, 1003], description: "初始成员用户 ID 列表（不含管理员）" })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  memberIds?: number[]
}

/** 企业管理列表筛选（状态胶囊：EXPIRING=生效中且剩 ≤7 天） */
export class QueryTeamsDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ["ALL", "ACTIVE", "EXPIRING", "GRACE", "ARCHIVED", "DISABLED"],
    description: "状态胶囊",
    default: "ALL",
  })
  @IsOptional()
  @IsIn(["ALL", "ACTIVE", "EXPIRING", "GRACE", "ARCHIVED", "DISABLED"])
  status: "ALL" | "ACTIVE" | "EXPIRING" | "GRACE" | "ARCHIVED" | "DISABLED" = "ALL"

  @ApiPropertyOptional({ enum: ["CUSTOM", "SELF"], description: "开通方式：平台定制 / 自助购买" })
  @IsOptional()
  @IsIn(["CUSTOM", "SELF"])
  source?: "CUSTOM" | "SELF"

  @ApiPropertyOptional({
    example: "星辰",
    description: "企业名 / 管理员姓名 / 管理员手机号 关键词",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string

  @ApiPropertyOptional({ example: "2026-09-01T00:00:00.000Z", description: "到期日区间-起（ISO）" })
  @IsOptional()
  @IsDateString()
  expiresStart?: string

  @ApiPropertyOptional({ example: "2026-09-30T23:59:59.999Z", description: "到期日区间-止（ISO）" })
  @IsOptional()
  @IsDateString()
  expiresEnd?: string
}

/** 编辑企业（平台定制；至少传一项） */
export class UpdateTeamDto {
  @ApiPropertyOptional({ example: "星辰科技", description: "企业名称" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string

  @ApiPropertyOptional({ example: 20, description: "席位数（不得低于当前在用席位）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number

  @ApiPropertyOptional({ example: "2027-06-30T23:59:59.999Z", description: "到期时间（ISO）" })
  @IsOptional()
  @IsDateString()
  expiresAt?: string

  @ApiPropertyOptional({ example: 0.7, description: "积分折扣（自助购买企业固定 1，不可改）" })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(1)
  discount?: number

  @ApiPropertyOptional({ example: 12000, description: "合同金额（人民币元，最多两位小数）" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  contractAmountCny?: number

  @ApiPropertyOptional({ example: "补充协议 2026-HT-018-1", description: "合同备注" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  contractNote?: string
}

/** 平台调整企业积分：可精确增减 RECHARGE/PACKAGE/GIFT；支持单独延长有效期 */
export class AdjustTeamDto {
  @ApiPropertyOptional({
    enum: ADMIN_ADJUSTABLE_CREDIT_BUCKETS,
    description: "积分类型：充值积分/套餐积分/赠送积分；传 creditsDelta 时必填",
  })
  @IsOptional()
  @IsIn(ADMIN_ADJUSTABLE_CREDIT_BUCKETS)
  creditType?: AdminAdjustableCreditBucket

  @ApiPropertyOptional({
    example: -500,
    description: "积分变动（正=增加 / 负=扣减）；扣减时不得传 extendDays",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  creditsDelta?: number

  /** @deprecated 旧版仅调整 RECHARGE 的字段；新调用请使用 creditType + creditsDelta */
  @ApiPropertyOptional({
    example: 5000,
    description: "【兼容旧版】池充值积分增减（等价 creditType=RECHARGE）",
    deprecated: true,
  })
  @IsOptional()
  @IsInt()
  rechargeCreditsDelta?: number

  @ApiPropertyOptional({ example: 30, description: "延长有效期（天）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  extendDays?: number

  @ApiPropertyOptional({ example: "客户投诉补偿", description: "调整备注（写入流水与团队审计）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string
}

/** 恢复团队（GRACE/ARCHIVED → ACTIVE，按天数重算有效期） */
export class RestoreTeamDto {
  @ApiProperty({ example: 30, description: "恢复后的有效天数（expiresAt=now+periodDays）" })
  @IsInt()
  @Min(1)
  periodDays: number
}

/** 平台侧拉入已存在成员 */
export class AdminAddMemberDto {
  @ApiProperty({ example: 1002, description: "用户 ID" })
  @Type(() => Number)
  @IsInt()
  userId: number
}
