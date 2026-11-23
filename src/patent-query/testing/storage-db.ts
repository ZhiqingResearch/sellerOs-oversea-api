import type {
  PatentQueryCache,
  PatentQueryResult,
  PatentQueryTextMark,
  Prisma,
} from "@prisma/client"

// 内存适配器用于验证读写路径；外部请求在服务测试中全部 mock。
export function storageDb() {
  const state = {
    results: [] as PatentQueryResult[],
    caches: [] as PatentQueryCache[],
    marks: [] as PatentQueryTextMark[],
  }
  const cacheKey = (where: {
    checkId_targetId_kind: { checkId: number; targetId: string; kind: string }
  }) =>
    state.caches.find(c =>
      Object.entries(where.checkId_targetId_kind).every(([k, v]) => c[k as keyof typeof c] === v)
    )
  return {
    state,
    patentQueryResult: {
      findMany: jest.fn(({ where }: { where: { checkId: number | { in: number[] } } }) =>
        Promise.resolve(
          structuredClone(
            state.results.filter(r =>
              typeof where.checkId === "number"
                ? r.checkId === where.checkId
                : where.checkId.in.includes(r.checkId)
            )
          )
        )
      ),
      createMany: jest.fn(({ data }: { data: PatentQueryResult[] }) => {
        state.results.push(
          ...data.map((r, n) => ({ ...structuredClone(r), id: state.results.length + n + 1 }))
        )
        return Promise.resolve({ count: data.length })
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: number }; data: Partial<PatentQueryResult> }) => {
          const row = state.results.find(r => r.id === where.id)!
          Object.assign(row, structuredClone(data))
          return Promise.resolve(structuredClone(row))
        }
      ),
      deleteMany: jest.fn(
        ({ where }: { where: { checkId: number; position: { gte: number } } }) => {
          const before = state.results.length
          state.results = state.results.filter(
            r => r.checkId !== where.checkId || r.position < where.position.gte
          )
          state.marks = state.marks.filter(m => state.results.some(r => r.id === m.resultId))
          return Promise.resolve({ count: before - state.results.length })
        }
      ),
    },
    patentQueryTextMark: {
      findMany: jest.fn(({ where }: { where: { resultId: { in: number[] } } }) =>
        Promise.resolve(
          structuredClone(state.marks.filter(m => where.resultId.in.includes(m.resultId)))
        )
      ),
      createMany: jest.fn(({ data }: { data: PatentQueryTextMark[] }) => {
        const nextId = Math.max(0, ...state.marks.map(m => m.id)) + 1
        state.marks.push(...data.map((m, n) => ({ ...structuredClone(m), id: nextId + n })))
        return Promise.resolve({ count: data.length })
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: number }; data: Partial<PatentQueryTextMark> }) => {
          const row = state.marks.find(m => m.id === where.id)!
          Object.assign(row, structuredClone(data))
          return Promise.resolve(structuredClone(row))
        }
      ),
      deleteMany: jest.fn(
        ({ where }: { where: { resultId: number; position: { gte: number } } }) => {
          const before = state.marks.length
          state.marks = state.marks.filter(
            m => m.resultId !== where.resultId || m.position < where.position.gte
          )
          return Promise.resolve({ count: before - state.marks.length })
        }
      ),
    },
    patentQueryCache: {
      findUnique: jest.fn(({ where }: { where: Parameters<typeof cacheKey>[0] }) =>
        Promise.resolve(structuredClone(cacheKey(where) ?? null))
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: Parameters<typeof cacheKey>[0] }) => {
        const row = cacheKey(where)
        if (!row) throw new Error("missing cache")
        return Promise.resolve(structuredClone(row))
      }),
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: Parameters<typeof cacheKey>[0]
          create: PatentQueryCache
          update: Partial<PatentQueryCache>
        }) => {
          let row = cacheKey(where)
          if (row) Object.assign(row, structuredClone(update))
          else {
            row = { ...structuredClone(create), id: state.caches.length + 1 }
            state.caches.push(row)
          }
          return Promise.resolve(structuredClone(row))
        }
      ),
    },
  }
}
export const asTransaction = (db: unknown) => db as Prisma.TransactionClient
