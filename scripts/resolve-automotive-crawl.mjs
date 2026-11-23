import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';

// Administrative acknowledgement only: does not fetch, audit, or retry the failed task.
export async function resolveUnknownCrawl(prisma, snapshotId, isConfirmedStopped) {
  if (!/^crawl_[a-z0-9-]{1,58}$/i.test(snapshotId ?? '') || !isConfirmedStopped) throw new Error('需提供快照号，并在核实爬虫请求已结束后传入 --confirmed-stopped');
  const row = await prisma.asinAuditCrawlSnapshot.findUnique({ where: { snapshotId } });
  if (!row) throw new Error('爬虫快照不存在');
  if (row.state === 'FAILED' && row.error?.code === 'MANUALLY_CONFIRMED_STOPPED') return { snapshotId, status: 'already_confirmed' };
  if (row.state !== 'UNKNOWN') throw new Error('只能确认UNKNOWN状态的爬虫快照');
  const updated = await prisma.asinAuditCrawlSnapshot.updateMany({
    where: { id: row.id, state: 'UNKNOWN', updatedAt: row.updatedAt },
    data: { state: 'FAILED', error: { code: 'MANUALLY_CONFIRMED_STOPPED', confirmedAt: new Date().toISOString(), previousError: row.error } },
  });
  if (!updated.count) throw new Error('快照状态已变化，请重新核对');
  return { snapshotId, status: 'confirmed_stopped', message: '保留原失败任务；其它排队任务可继续，不会重新审计该任务' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--snapshot' || args[2] !== '--confirmed-stopped') {
    console.error('用法：node --env-file=.env scripts/resolve-automotive-crawl.mjs --snapshot <crawl_快照号> --confirmed-stopped');
    process.exitCode = 1;
  } else {
    const prisma = new PrismaClient();
    try { console.log(JSON.stringify(await resolveUnknownCrawl(prisma, args[1], true))); }
    catch (error) { console.error(error instanceof Error && !('code' in error) ? error.message : '数据库操作失败，请核对管理环境'); process.exitCode = 1; }
    finally { await prisma.$disconnect(); }
  }
}
