import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common"
import type { Request, RequestHandler, Response } from "express"
import { defer, finalize, of } from "rxjs"

// Keys are the actual Express request objects. No state comes from client headers.
interface AuditRequest {
  receivedAt: number
  disconnected: boolean
  operations: number
  releaseWhenDone: () => void
}
const activeRequests = new WeakMap<object, AuditRequest>()

export function auditSignatureTime(req: object) {
  return activeRequests.get(req)?.receivedAt ?? Date.now()
}

export async function authenticateAuditRequest(req: object, verify: () => Promise<boolean>) {
  const ticket = activeRequests.get(req)
  if (!ticket) return verify()
  ticket.operations++
  try {
    return (await verify()) && !ticket.disconnected
  } finally {
    ticket.operations--
    ticket.releaseWhenDone()
  }
}

export class AuditRequestInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<object>()
    const ticket = activeRequests.get(req)
    if (!ticket) return next.handle()
    if (ticket.disconnected) return of(undefined)
    ticket.operations++
    return defer(() => next.handle()).pipe(
      finalize(() => {
        ticket.operations--
        ticket.releaseWhenDone()
      })
    )
  }
}

class AuditHttpQueue {
  private active = 0
  private readonly waiting = new Set<() => void>()

  constructor(private readonly concurrency: number) {}

  enter(req: Request, res: Response, next: () => void) {
    const receivedAt = Date.now()
    const start = () => {
      res.off("close", cancel)
      this.active++
      let released = false
      const ticket: AuditRequest = {
        receivedAt,
        disconnected: false,
        operations: 0,
        releaseWhenDone: () => {
          if (released || ticket.operations || !ticket.disconnected) return
          released = true
          res.off("finish", finish)
          res.off("close", finish)
          this.active--
          const first = this.waiting.values().next().value
          if (first) {
            this.waiting.delete(first)
            first()
          }
        },
      }
      const finish = () => {
        ticket.disconnected = true
        ticket.releaseWhenDone()
      }
      activeRequests.set(req, ticket)
      res.once("finish", finish)
      res.once("close", finish)
      next()
    }
    const cancel = () => this.waiting.delete(start)
    if (this.active < this.concurrency) start()
    else {
      this.waiting.add(start)
      res.once("close", cancel)
    }
  }
}

// Short ingress waits occur before JSON parsing and database access. The long-running
// audit backlog remains in MySQL; these slots are released as soon as HTTP work ends.
export function createAuditRequestQueue(): RequestHandler {
  const writes = new AuditHttpQueue(3)
  const polls = new AuditHttpQueue(3)
  const details = new AuditHttpQueue(1)
  return (req, res, next) => {
    if (req.method === "POST") return writes.enter(req, res, next)
    if (req.method === "GET" && /^\/tasks\/[^/]+\/?$/i.test(req.path))
      return polls.enter(req, res, next)
    return details.enter(req, res, next)
  }
}
