import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Subject } from 'rxjs'

const require = createRequire(import.meta.url)
const { createAuditRequestQueue, auditSignatureTime, authenticateAuditRequest, AuditRequestInterceptor } =
  require('../dist/open-api/asin-audit-request-queue')

function submit(queue, path, method, onStart) {
  const req = { path, method }
  const res = new EventEmitter()
  queue(req, res, () => onStart(req))
  return res
}

test('150笔提交按到达顺序受理，轮询和详情各有独立容量', () => {
  const queue = createAuditRequestQueue()
  const started = []
  const sends = Array.from({ length: 150 }, (_, i) =>
    submit(queue, '/computer', 'POST', () => started.push(i)))
  assert.equal(started.length, 3)
  const polls = [], details = []
  const reads = Array.from({ length: 4 }, (_, i) =>
    submit(queue, '/tasks/example', 'GET', () => polls.push(i)))
  const heavy = Array.from({ length: 2 }, (_, i) =>
    submit(queue, '/tasks/example/details', 'GET', () => details.push(i)))
  assert.deepEqual(polls, [0, 1, 2])
  assert.deepEqual(details, [0])
  reads[0].emit('finish')
  heavy[0].emit('finish')
  assert.equal(polls.length, 4)
  assert.equal(details.length, 2)
  for (const [i, res] of sends.entries()) {
    assert.equal(started.length, Math.min(i + 3, sends.length))
    res.emit('finish')
    res.emit('close')
  }
  assert.deepEqual(started, Array.from({ length: 150 }, (_, i) => i))
})

test('签名时窗使用到达时间，服务端等待超过五分钟仍保留原校验基准', t => {
  const queue = createAuditRequestQueue()
  const time = t.mock.method(Date, 'now', () => 1000000)
  const first = submit(queue, '/tasks/t/details', 'GET', () => {})
  let checkedAt
  submit(queue, '/tasks/t/details', 'GET', req => { checkedAt = auditSignatureTime(req) })
  time.mock.mockImplementation(() => 1600000)
  first.emit('finish')
  assert.equal(checkedAt, 1000000)
  assert.equal(auditSignatureTime({}), 1600000)
})

test('断线取消未受理请求，运行中的鉴权完成后才释放容量', async () => {
  const queue = createAuditRequestQueue()
  let finishAuth, checked, started = 0
  const active = submit(queue, '/tasks/t/details', 'GET', req => {
    checked = authenticateAuditRequest(req, () => new Promise(resolve => { finishAuth = resolve }))
  })
  const abandoned = submit(queue, '/tasks/t/details', 'GET', () => assert.fail('已断开'))
  submit(queue, '/tasks/t/details', 'GET', () => started++)
  abandoned.emit('close')
  active.emit('close')
  assert.equal(started, 0)
  finishAuth(true)
  assert.equal(await checked, false)
  assert.equal(started, 1)
})

test('断线期间尚未结束的业务查询仍占用原执行槽', () => {
  const queue = createAuditRequestQueue()
  const work = new Subject()
  const interceptor = new AuditRequestInterceptor()
  const active = submit(queue, '/tasks/t/details', 'GET', req => {
    interceptor.intercept({ switchToHttp: () => ({ getRequest: () => req }) },
      { handle: () => work }).subscribe()
  })
  let started = false
  submit(queue, '/tasks/t/details', 'GET', () => { started = true })
  active.emit('close')
  assert.equal(started, false)
  work.complete()
  assert.equal(started, true)
})
