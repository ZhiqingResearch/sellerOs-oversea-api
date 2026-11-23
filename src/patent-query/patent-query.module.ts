import { Module } from "@nestjs/common"
import { UsageModule } from "../usage/usage.module"
import { PatentQueryController } from "./patent-query.controller"
import { PatentQueryNiceClassService } from "./patent-query.nice-class.service"
import { PatentQueryRunner } from "./patent-query.runner"
import { PatentQueryService } from "./patent-query.service"
@Module({
  imports: [UsageModule],
  controllers: [PatentQueryController],
  providers: [PatentQueryService, PatentQueryRunner, PatentQueryNiceClassService],
})
export class PatentQueryModule {}
