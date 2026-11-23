import type { Prisma } from "@prisma/client"

// 未上线测试数据不迁移；避免历史脚本使用新版严格读取后产生破坏性写入。
export async function migratePatentCheck(
  db: Prisma.TransactionClient,
  checkId: number,
  apply: boolean
): Promise<never> {
  void db
  void checkId
  void apply
  await Promise.resolve()
  throw new Error("旧版专利数据迁移已停用，请另行清理测试记录")
}
