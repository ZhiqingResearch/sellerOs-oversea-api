import { Prisma } from "@prisma/client"
import type { GenerationRecord } from "../usage/generation-record.service"
import type { RecordClient } from "./generation-record-sync"

type RpaRoot = Prisma.RpaCreationTaskGetPayload<Record<string, never>>
type RpaContext = {
  outputs: Prisma.RpaCreationOutputGetPayload<Record<string, never>>[]
  logs: Array<
    Pick<Prisma.UsageLogGetPayload<Record<string, never>>, "id" | "credits" | "meta" | "createdAt">
  >
  user: {
    id: number
    username: string
    phone: string
    orgs: { org: { name: string } }[]
    roles: { role: { name: string; color: string | null } }[]
  } | null
}

export async function projectRpaGenerationPage(tx: RecordClient, roots: RpaRoot[]) {
  const [outputs, logs, users] = await Promise.all([
    tx.rpaCreationOutput.findMany({
      where: { taskId: { in: roots.map(root => root.id) }, status: "SUCCESS", url: { not: null } },
      orderBy: { order: "asc" },
    }),
    tx.usageLog.findMany({
      where: {
        userId: { in: [...new Set(roots.map(root => root.userId))] },
        source: "rpa-creation.generate",
        OR: roots.map(root => ({
          userId: root.userId,
          meta: { path: "$.taskId", equals: root.id },
        })),
      },
      select: { id: true, userId: true, credits: true, meta: true, createdAt: true },
      orderBy: { id: "asc" },
    }),
    tx.user.findMany({
      where: { id: { in: [...new Set(roots.map(root => root.userId))] } },
      select: {
        id: true,
        username: true,
        phone: true,
        orgs: { select: { org: { select: { name: true } } } },
        roles: { select: { role: { select: { name: true, color: true } } } },
      },
    }),
  ])
  return new Map(
    await Promise.all(
      roots.map(
        async root =>
          [
            root.id,
            await projectRpaGenerationEvents(tx, root, {
              outputs: outputs.filter(output => output.taskId === root.id),
              logs: logs.filter(
                log =>
                  log.userId === root.userId &&
                  (log.meta as { taskId?: unknown } | null)?.taskId === root.id
              ),
              user: users.find(user => user.id === root.userId) ?? null,
            }),
          ] as const
      )
    )
  )
}

/** 同一任务的失败重试可以再次成功；明确输出批次绑定真实扣费，不覆盖先前成功批次。 */
export async function projectRpaGenerationEvents(
  tx: RecordClient,
  root: RpaRoot,
  context?: RpaContext
): Promise<GenerationRecord[]> {
  if (root.mediaType !== "IMAGE" && root.mediaType !== "VIDEO") return []
  const [outputs, logs, user] = context
    ? ([context.outputs, context.logs, context.user] as const)
    : await Promise.all([
        tx.rpaCreationOutput.findMany({
          where: { taskId: root.id, status: "SUCCESS", url: { not: null } },
          orderBy: { order: "asc" },
        }),
        tx.usageLog.findMany({
          where: {
            userId: root.userId,
            source: "rpa-creation.generate",
            meta: { path: "$.taskId", equals: root.id },
          },
          select: { id: true, credits: true, meta: true, createdAt: true },
          orderBy: { id: "asc" },
        }),
        tx.user.findUnique({
          where: { id: root.userId },
          select: {
            id: true,
            username: true,
            phone: true,
            orgs: { select: { org: { select: { name: true } } } },
            roles: { select: { role: { select: { name: true, color: true } } } },
          },
        }),
      ])
  if (!outputs.length || !user) return []
  const events: GenerationRecord[] = []
  for (const log of logs) {
    const meta = log.meta as { successfulOutputIds?: unknown } | null
    if (!Array.isArray(meta?.successfulOutputIds) || !meta.successfulOutputIds.length) continue
    const ids = meta.successfulOutputIds.filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id)
    )
    const delivered = outputs.filter(output => ids.includes(output.id))
    if (!delivered.length) continue
    events.push({
      key: `RPA_${root.mediaType}:${root.id}:event:${log.id}`,
      id: root.id,
      function: root.mediaType,
      userId: user.id,
      username: user.username,
      phone: user.phone,
      orgs: user.orgs.map(row => row.org.name),
      roles: user.roles.map(row => row.role),
      prompt: root.prompt,
      model: root.model,
      modelLabel: root.model,
      credits: log.credits?.toString() ?? null,
      status: "SUCCESS",
      resultCount: delivered.length,
      resultUrl: delivered[0].url,
      createdAt: log.createdAt,
      deleted: false,
      expired: false,
    })
  }
  if (!events.length && root.status === "SUCCESS")
    events.push({
      key: `RPA_${root.mediaType}:${root.id}`,
      id: root.id,
      function: root.mediaType,
      userId: user.id,
      username: user.username,
      phone: user.phone,
      orgs: user.orgs.map(row => row.org.name),
      roles: user.roles.map(row => row.role),
      prompt: root.prompt,
      model: root.model,
      modelLabel: root.model,
      credits: logs.length === 1 ? (logs[0].credits?.toString() ?? null) : null,
      status: "SUCCESS",
      resultCount: outputs.length,
      resultUrl: outputs[0].url,
      createdAt: root.completedAt ?? root.createdAt,
      deleted: false,
      expired: false,
    })
  return events
}
