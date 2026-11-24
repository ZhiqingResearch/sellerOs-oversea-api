import { Module } from "@nestjs/common"
import { ReceiptPdfService } from "../billing/receipt-pdf.service"
import { UsageModule } from "../usage/usage.module"
import { PatentQueryExportService } from "./patent-query-export.service"
import { PatentQueryPdfService } from "./patent-query-pdf.service"
import { PatentQueryController } from "./patent-query.controller"
import { PatentQueryNiceClassService } from "./patent-query.nice-class.service"
import { PatentQueryRunner } from "./patent-query.runner"
import { PatentQueryService } from "./patent-query.service"
@Module({
  imports: [UsageModule],
  controllers: [PatentQueryController],
  providers: [
    PatentQueryExportService,
    PatentQueryPdfService,
    ReceiptPdfService,
    PatentQueryService,
    PatentQueryRunner,
    PatentQueryNiceClassService,
  ],
})
export class PatentQueryModule {}
