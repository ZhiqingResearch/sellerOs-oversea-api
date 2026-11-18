import { parentPort, workerData } from "worker_threads"
import { savedUiLanguage } from "../common/i18n/ai-language"
import { exportText } from "../common/i18n/export-text"
import { withUiLanguage } from "../common/i18n/request-language"
import { AdCleaningProcessor } from "./ad-cleaning.processor"
import type { AdCleaningWorkerInput, AdCleaningWorkerMessage } from "./ad-cleaning.types"

const port = parentPort
if (!port) throw new Error("广告清洗 Worker 必须由主线程启动")

const input = workerData as AdCleaningWorkerInput

const post = (message: AdCleaningWorkerMessage): void => port.postMessage(message)

withUiLanguage(savedUiLanguage(input.responseLanguage), () => {
try {
  const result = AdCleaningProcessor.process(
    input.inputPath,
    input.outputPath,
    input.originalFilename,
    (progress, stage) => post({ type: "progress", progress, stage: exportText(stage) })
  )
  post({ type: "success", stats: result.stats })
} catch (error) {
  post({
    type: "error",
    message: error instanceof Error ? error.message : "广告数据清洗失败",
  })
}

})
