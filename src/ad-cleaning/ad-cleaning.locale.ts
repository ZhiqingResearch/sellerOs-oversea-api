import * as XLSX from "xlsx"
import { exportText } from "../common/i18n/export-text"
import { uiLanguage } from "../common/i18n/request-language"

/** Translate generated cells only: campaign names, search terms and source filenames are user data. */
export function localizeCleaningWorkbook(workbook: XLSX.WorkBook): void {
  if (uiLanguage() !== "en-US") return
  for (const name of [...workbook.SheetNames]) {
    const sheet = workbook.Sheets[name]
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1")
    const headers = Array.from({ length: range.e.c + 1 }, (_, column) =>
      String(
        (sheet[XLSX.utils.encode_cell({ r: 0, c: column })] as XLSX.CellObject | undefined)?.v ?? ""
      )
    )
    for (let row = 0; row <= range.e.r; row++) {
      for (let column = 0; column <= range.e.c; column++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
          | XLSX.CellObject
          | undefined
        if (!cell || typeof cell.v !== "string") continue
        if (row === 0 || (name === "清洗摘要" && column === 0) || headers[column] === "判断") {
          cell.v = exportText(cell.v)
          delete cell.w
        }
      }
    }
    const translated = exportText(name)
    if (translated !== name) {
      workbook.Sheets[translated] = sheet
      delete workbook.Sheets[name]
    }
    workbook.SheetNames[workbook.SheetNames.indexOf(name)] = translated
  }
}
