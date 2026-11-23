import { Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { PrismaClient } from "@prisma/client"

type AssertLock = () => Promise<void>
type Work = (assertLock: AssertLock) => Promise<void>
type JobKind = "audit" | "optimization"
type AuditKind = "COMPUTER" | "AUTOMOTIVE"
export class MissingCrawlerReceipt extends Error {}
const MAX_ACTIVE_JOBS = 4
const WORKER_LOCK = "seller:automotive-audit:serial:v1"

@Injectable()
export class AutomotiveAuditLockService {
  constructor(private readonly config: ConfigService) {}

  // One elected process shares its legacy MySQL lock between admitted jobs. Older
  // releases must still see it as held until *all* these jobs have finished.
  private owner?: AssertLock
  private electing = false
  private stopping = false
  private readonly active = new Map<string, Promise<void>>()
  private crawlerTail: Promise<void> = Promise.resolve()
  private election?: Promise<void>

  get hasCapacity() {
    return !this.stopping && this.active.size < MAX_ACTIVE_JOBS
  }

  activeIds(kind: JobKind) {
    const prefix = kind + ":"
    return [...this.active.keys()]
      .filter(key => key.startsWith(prefix))
      .map(key => Number(key.slice(prefix.length)))
  }

  async findNextAudit(db: PrismaClient, auditType: AuditKind) {
    return db.asinAuditTask.findFirst({
      where: {
        auditType,
        status: { in: ["QUEUED", "RUNNING"] },
        id: { notIn: this.activeIds("audit") },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    })
  }

  async reuseOrRunCrawler<T>(
    assertLock: AssertLock,
    work: (isCacheOnly: boolean) => Promise<T>
  ) {
    try {
      return await work(true)
    } catch (error) {
      if (!(error instanceof MissingCrawlerReceipt)) throw error
    }
    return this.runCrawler(assertLock, () => work(false))
  }

  async runJob(kind: JobKind, id: number, work: Work) {
    const key = kind + ":" + id
    if (!this.hasCapacity || this.active.has(key)) return
    if (this.owner) return this._admit(key, this.owner, work)
    if (this.electing) return
    this.electing = true
    try {
      this.election = this.runExclusive(async assertLock => {
        if (this.stopping) return
        this.owner = assertLock
        try {
          await this._admit(key, assertLock, work)
        } finally {
          while (this.active.size) await Promise.race(this.active.values())
          this.owner = undefined
        }
      })
      await this.election
    } finally {
      this.election = undefined
      this.electing = false
    }
  }

  private async _admit(key: string, assertLock: AssertLock, work: Work) {
    // Publish the reservation synchronously, before checking the connection or
    // reading the payload. Concurrent scheduler ticks can then skip this ID.
    const running = Promise.resolve()
      .then(async () => {
        await assertLock()
        await work(assertLock)
      })
      .finally(() => this.active.delete(key))
    this.active.set(
      key,
      running.catch(() => {})
    )
    await running
  }

  async runCrawler<T>(
    assertLock: AssertLock,
    work: () => Promise<T>
  ): Promise<T> {
    const previous = this.crawlerTail
    let release!: () => void
    this.crawlerTail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      await assertLock()
      // The election and promise chain serialize live calls. Historical outcomes belong to their task.
      return await work()
    } finally {
      release()
    }
  }

  async onModuleDestroy() {
    this.stopping = true
    await this.election
  }

  async runExclusive(work: (assertLock: () => Promise<void>) => Promise<void>) {
    // MySQL advisory locks survive transaction rollback. A dedicated one-connection
    // client guarantees release by disconnecting even if RELEASE_LOCK itself fails.
    // Never return a connection holding a named lock to the application's shared pool.
    const client = this._createClient()
    let hasLock = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: Promise<void> | undefined
    let isClosing = false
    let lockFailure: Error | undefined
    const assertLock = async () => {
      if (lockFailure) throw lockFailure
      try {
        const rows = await client.$queryRaw<
          { owned: number | bigint | null }[]
        >`SELECT IS_USED_LOCK(${WORKER_LOCK}) = CONNECTION_ID() AS owned`
        if (Number(rows[0]?.owned) !== 1) throw new Error("AUDIT_LOCK_LOST")
      } catch {
        lockFailure = new Error("AUDIT_LOCK_LOST")
        throw lockFailure
      }
    }
    const scheduleHeartbeat = () => {
      if (isClosing || lockFailure) return
      timer = setTimeout(() => {
        // Keep the dedicated connection alive while awaiting long external calls.
        // A lost connection invalidates this worker; never silently reacquire.
        heartbeat = assertLock()
          .catch(() => {})
          .finally(scheduleHeartbeat)
      }, 15_000)
      timer.unref()
    }
    try {
      const rows = await client.$queryRaw<
        { acquired: number | bigint | null }[]
      >`SELECT GET_LOCK(${WORKER_LOCK}, 0) AS acquired`
      hasLock = Number(rows[0]?.acquired) === 1
      if (!hasLock) return
      scheduleHeartbeat()
      await work(assertLock)
    } finally {
      isClosing = true
      clearTimeout(timer)
      await heartbeat
      try {
        if (hasLock) await client.$queryRaw`SELECT RELEASE_LOCK(${WORKER_LOCK}) AS released`
      } finally {
        await client.$disconnect()
      }
    }
  }

  private _createClient() {
    const url = new URL(this.config.getOrThrow<string>("DATABASE_URL"))
    url.searchParams.set("connection_limit", "1")
    url.searchParams.set("max_connection_lifetime", "0")
    url.searchParams.set("max_idle_connection_lifetime", "0")
    return new PrismaClient({ datasources: { db: { url: url.toString() } } })
  }
}
