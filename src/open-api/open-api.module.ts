import { Module } from "@nestjs/common"
import { CompetitorEvidenceProvider } from "../competitor-analysis/competitor-evidence.provider"
import { MembershipModule } from "../membership/membership.module"
import { PricingModule } from "../pricing/pricing.module"
import { SkillsKeysModule } from "../skills-keys/skills-keys.module"
import { UsageModule } from "../usage/usage.module"
import { AsinCostService } from "./asin-cost.service"
import { AsinCostAdminController } from "./asin-cost-admin.controller"
import { AsinCostQueryService } from "./asin-cost-query.service"
import { AsinOptimizationController } from "./asin-optimization/asin-optimization.controller"
import { AsinOptimizationRunner } from "./asin-optimization/asin-optimization.runner"
import { AsinOptimizationService } from "./asin-optimization/asin-optimization.service"
import { AutomotiveAuditLockService } from "./automotive-audit/automotive-audit-lock.service"
import { AutomotiveAuditController } from "./automotive-audit/automotive-audit.controller"
import { AutomotiveAuditRunner } from "./automotive-audit/automotive-audit.runner"
import { AutomotiveAuditService } from "./automotive-audit/automotive-audit.service"
import { ComputerAuditController } from "./computer-audit/computer-audit.controller"
import { ComputerAuditRunner } from "./computer-audit/computer-audit.runner"
import { ComputerAuditService } from "./computer-audit/computer-audit.service"
import { KeybCreditController } from "./keyb-credit.controller"
import { KeybCreditService } from "./keyb-credit.service"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenCreditController } from "./open-credit.controller"
import { OpenOperationPlanController } from "./open-operation-plan.controller"
import { OpenOperationPlanService } from "./open-operation-plan.service"
import { OpenOperationQueryController } from "./open-operation-query.controller"
import { OpenProductAnalysisController } from "./open-product-analysis.controller"
import { OpenProductAnalysisService } from "./open-product-analysis.service"

/**
 * 对外开放接口（/api/open/*）：其他项目服务间调用本平台能力（积分扣费等）。
 * 第三方入口使用 AppId + HMAC-SHA256 签名鉴权（OpenApiAuthGuard），
 * 接入方由 scripts/create-open-api-app.ts 创建（OpenApiApp 表）。
 * 后台成本读取单独使用 JWT + company.admin，不能通过第三方凭证访问。
 */
@Module({
  imports: [UsageModule, MembershipModule, SkillsKeysModule, PricingModule],
  controllers: [
    AsinCostAdminController,
    AsinOptimizationController,
    OpenCreditController,
    KeybCreditController,
    OpenOperationPlanController,
    OpenOperationQueryController,
    OpenProductAnalysisController,
    AutomotiveAuditController,
    ComputerAuditController,
  ],
  providers: [
    AsinCostQueryService,
    AsinCostService,
    AsinOptimizationService,
    AsinOptimizationRunner,
    OpenApiAuthGuard,
    KeybCreditService,
    OpenOperationPlanService,
    OpenProductAnalysisService,
    CompetitorEvidenceProvider,
    AutomotiveAuditService,
    ComputerAuditService,
    ComputerAuditRunner,
    AutomotiveAuditRunner,
    AutomotiveAuditLockService,
  ],
})
export class OpenApiModule {}
