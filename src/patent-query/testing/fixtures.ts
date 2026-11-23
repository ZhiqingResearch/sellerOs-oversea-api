import type { PatentQueryCheck, Prisma } from "@prisma/client"
import { normalizeInput } from "../patent-query.constants"
import { Task, json } from "../patent-query.types"
export const fixtureInput = () =>
  normalizeInput(
    {
      sites: ["US"],
      images: [{ id: "img-1", key: "patent-query/1/cup.jpg", name: "cup.jpg" }],
      design: {},
      copy: {},
      gtm: {},
      tm: { brand: "Coca-Cola", title: "Original taste", classCodes: ["021"] },
    },
    1
  )
export function checkFixture(
  kind = "design",
  patch: Partial<PatentQueryCheck> = {}
): PatentQueryCheck {
  return {
    id: 1,
    taskId: 1,
    kind,
    status: "PROCESSING",
    upstreamTaskId: "upstream-1",
    output: { units: {} },
    error: null,
    ...patch,
  }
}
export function taskFixture(checks: PatentQueryCheck[] = [], patch: Partial<Task> = {}): Task {
  return {
    id: 1,
    userId: 1,
    requestId: "da6b476d-520a-4c1b-bfaa-ae3a71f3c099",
    input: json(fixtureInput()) as Prisma.JsonObject,
    status: "RUNNING",
    quotedCredits: 40,
    annotations: {},
    error: null,
    finishedAt: null,
    createdAt: new Date("2026-10-23T00:00:00Z"),
    deletedAt: null,
    checks,
    ...patch,
  }
}
export const completedUnit = (
  matches: Prisma.JsonObject[] = [],
  result: Prisma.JsonObject = {}
) => ({
  status: "COMPLETED",
  error: null,
  result,
  matches,
  offset: matches.length,
  complete: true,
  resultReady: true,
})
