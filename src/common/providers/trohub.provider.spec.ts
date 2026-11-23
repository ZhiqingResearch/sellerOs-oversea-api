import { Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { TrohubError, TrohubProvider } from "./trohub.provider"
jest.mock("axios")
const success = (headers: Record<string, string> = {}) => ({
  status: 200,
  data: { ok: true, data: { taskID: "id" } },
  headers,
})
describe("Trohub 分组限流与请求边界", () => {
  // axios.request 在此已被 Jest 替换为无 this 的 mock。
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const request = jest.mocked(axios.request)
  const provider = () =>
    new TrohubProvider({ get: () => "test-only-key" } as unknown as ConfigService)
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    jest.useFakeTimers()
    jest.setSystemTime(1792713600000)
    request.mockReset()
    request.mockResolvedValue(success())
  })
  afterEach(() => {
    warn.mockRestore()
    jest.useRealTimers()
  })
  it("同组的提交/详情/命中共享额度，其他分组独立执行", async () => {
    const times: number[] = []
    request.mockImplementation(() => {
      times.push(Date.now())
      return Promise.resolve(success())
    })
    const p = provider()
    const all = Promise.all([
      p.submit("design", {}),
      p.detail("design", "new-task"),
      p.matches("design", "another-task", "img", 0),
      p.detail("copy", "id"),
    ])
    await jest.runAllTimersAsync()
    await all
    expect(times.map(t => t - times[0])).toEqual([0, 0, 6100, 12200])
    expect(request.mock.calls[0][0]).toMatchObject({
      method: "POST",
      url: "https://api.trohub.com/v2/ip/patent/design",
      maxRedirects: 0,
    })
  })
  it("文字提交/文字轮询/图形商标各有 30 次额度", async () => {
    const times: number[] = []
    request.mockImplementation(() => {
      times.push(Date.now())
      return Promise.resolve(success())
    })
    const p = provider()
    const all = Promise.all([
      p.submit("tm", {}),
      p.detail("tm", "a"),
      p.detail("gtm", "a"),
      p.submit("tm", {}),
      p.detail("tm", "b"),
      p.matches("gtm", "b", "img", 0),
    ])
    await jest.runAllTimersAsync()
    await all
    expect(times.map(t => t - times[0])).toEqual([0, 0, 0, 2100, 2100, 2100])
  })
  it("账号最多三个在途，同组慢请求不并发，等待额度不占槽位", async () => {
    const finish: Array<() => void> = []
    request.mockImplementation(() => new Promise(resolve => finish.push(() => resolve(success()))))
    const p = provider()
    const all = Promise.all([
      p.detail("design", "a"),
      p.detail("design", "b"),
      p.detail("copy", "a"),
      p.detail("gtm", "a"),
      p.detail("tm", "a"),
    ])
    expect(request).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(10000)
    expect(request).toHaveBeenCalledTimes(3)
    finish[1]()
    await jest.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(4)
    expect(request.mock.calls[3][0].url).toContain("/trademark/text/")
    finish[0]()
    finish[2]()
    finish[3]()
    await jest.advanceTimersByTimeAsync(6100)
    expect(request).toHaveBeenCalledTimes(5)
    finish[4]()
    await all
  })
  it("响应头学习分组和限额，新任务与已排队请求沿用模板映射", async () => {
    const times: number[] = []
    request.mockImplementation(() => {
      times.push(Date.now())
      return Promise.resolve(success({ "x-ratelimit-route": "shared", "x-ratelimit-limit": "2" }))
    })
    const p = provider()
    // 首次各端点学习同一实际分组，后续不得再各计一份额度。
    await p.detail("copy", "a")
    await p.detail("design", "a")
    const all = Promise.all([p.detail("copy", "b"), p.detail("design", "c"), p.detail("copy", "d")])
    await jest.runAllTimersAsync()
    await all
    expect(times.map(t => t - times[0])).toEqual([0, 0, 30100, 60200, 90300])
  })
  it.each(["90", new Date(1792713600000 + 90000).toUTCString()])(
    "业务限流兼容顶层 code，Retry-After=%s 与 Reset 取较晚时间，仅阻挡本组",
    async retryAfter => {
      const times: number[] = []
      request
        .mockImplementationOnce(() => {
          times.push(Date.now())
          return Promise.resolve({
            status: 200,
            data: { code: "BUSINESS_RATE_LIMIT_EXCEEDED", message: "secret" },
            headers: {
              "retry-after": retryAfter,
              "x-ratelimit-reset": String(Date.now() / 1000 + 60),
            },
          })
        })
        .mockImplementation(() => {
          times.push(Date.now())
          return Promise.resolve(success())
        })
      const p = provider()
      const first = p.detail("copy", "a").catch((e: unknown) => e)
      const rest = Promise.all([p.detail("copy", "b"), p.detail("gtm", "a")])
      await jest.runAllTimersAsync()
      expect(await first).toMatchObject({
        category: "rate_limit",
        message: "检测服务繁忙，请稍后重试",
      })
      await rest
      expect(times.map(t => t - times[0])).toEqual([0, 0, 90000])
    }
  )
  it("成功响应 Remaining=0 也等 Reset；有剩余额度时按剩余窗口调节", async () => {
    const times: number[] = []
    request
      .mockImplementationOnce(() => {
        times.push(Date.now())
        return Promise.resolve(
          success({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Date.now() / 1000 + 60),
          })
        )
      })
      .mockImplementationOnce(() => {
        times.push(Date.now())
        return Promise.resolve(
          success({
            "x-ratelimit-remaining": "2",
            "x-ratelimit-reset": String(Date.now() / 1000 + 60),
          })
        )
      })
      .mockImplementation(() => {
        times.push(Date.now())
        return Promise.resolve(success())
      })
    const p = provider()
    const all = Promise.all([p.detail("gtm", "a"), p.detail("gtm", "b"), p.detail("gtm", "c")])
    await jest.runAllTimersAsync()
    await all
    expect(times.map(t => t - times[0])).toEqual([0, 60000, 90100])
  })
  it("未知路由共用保守额度，无效头忽略，限流无有效重置时间等一分钟", async () => {
    const times: number[] = []
    request
      .mockImplementationOnce(() => {
        times.push(Date.now())
        return Promise.resolve({
          status: 429,
          data: {},
          headers: {
            "x-ratelimit-limit": "0",
            "x-ratelimit-reset": "bad",
            "retry-after": "bad",
          },
        })
      })
      .mockImplementation(() => {
        times.push(Date.now())
        return Promise.resolve(success())
      })
    const p = provider()
    const first = p.request("GET", "/unknown/a").catch((e: unknown) => e)
    const rest = Promise.all([p.request("GET", "/unknown/b"), p.request("GET", "/unknown/c")])
    await jest.runAllTimersAsync()
    expect(await first).toBeInstanceOf(TrohubError)
    await rest
    expect(times.map(t => t - times[0])).toEqual([0, 60000, 66100])
  })
  it.each([
    [400, "BUSINESS_SUBSCRIPTION_REQUIRED", "subscription", false],
    [400, "BUSINESS_NEW_RESTRICTION", "business", false],
    [200, "BUSINESS_INSUFFICIENT_QUOTA", "quota", false],
    [429, "UNAUTHORIZED_AUTH_REQUIRED", "auth", false],
    [503, "VALIDATION_VISUAL_SEARCH_IMAGE_TOO_SMALL", "validation", false],
    [200, "BUSINESS_RATE_LIMIT_EXCEEDED", "rate_limit", true],
    [200, "RATE_LIMITER_UNAVAILABLE", "temporary", true],
    [200, "INTERNAL_ERROR_UNKNOWN", "temporary", true],
    [200, "UNKNOWN_CODE", "unknown", false],
    [429, "", "rate_limit", true],
    [503, "", "temporary", true],
    [403, "", "permission", false],
  ])("错误码优先于 HTTP：%s %s", async (status, code, category, retryable) => {
    request.mockResolvedValue({
      status,
      data: { ok: false, error: { code, message: "secret upstream", details: "secret" } },
      headers: {},
    })
    const error: unknown = await provider()
      .detail("tm", "a")
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ category, retryable })
    expect((error as Error).message).not.toContain("secret")
  })
  it.each([
    ["UNAUTHORIZED_AUTH_REQUIRED", "服务凭证可能无效或已停用"],
    ["BUSINESS_INSUFFICIENT_QUOTA", "检测服务额度不足"],
    ["BUSINESS_SUBSCRIPTION_REQUIRED", "检测服务订阅未生效或已到期"],
    ["BUSINESS_RATE_LIMIT_EXCEEDED", "检测服务繁忙"],
    ["VALIDATION_VISUAL_SEARCH_IMAGE_TOO_SMALL", "最长边需至少 200 像素"],
    ["RATE_LIMITER_UNAVAILABLE", "限流组件暂不可用"],
    ["INTERNAL_ERROR_UNKNOWN", "检测服务内部异常"],
    ["VALIDATION_NEW_RULE", "错误码：VALIDATION_NEW_RULE"],
    ["BUSINESS_NEW_RESTRICTION", "错误码：BUSINESS_NEW_RESTRICTION"],
  ])("错误 %s 显示具体原因", (code, message) => {
    expect(new TrohubError(400, code).message).toContain(message)
  })
  it("实测订阅错误按业务码解释，日志保留排查标识但不记录原始载荷", async () => {
    request.mockResolvedValue({
      status: 400,
      data: {
        ok: false,
        message: "no active subscription",
        error: { code: "BUSINESS_SUBSCRIPTION_REQUIRED", details: "secret-upstream-data" },
      },
      headers: { "x-request-id": "571be85bdb06469ee7c982c270e1139e" },
    })
    const error: unknown = await provider()
      .submit("design", {
        clientRequestId: "pq-7-design",
        images: [{ base64: "private-image", image: "https://private.test/?Signature=secret" }],
      })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({
      category: "subscription",
      unavailable: true,
      invalidInput: false,
      retryable: false,
      message: "检测服务订阅未生效或已到期，请联系管理员",
    })
    expect(warn).toHaveBeenCalledWith({
      message: "检测服务订阅未生效或已到期，请联系管理员",
      endpoint: "POST /ip/patent/design",
      status: 400,
      code: "BUSINESS_SUBSCRIPTION_REQUIRED",
      requestId: "571be85bdb06469ee7c982c270e1139e",
      clientRequestId: "pq-7-design",
    })
    const logged = JSON.stringify(warn.mock.calls)
    for (const secret of ["test-only-key", "secret-upstream-data", "private-image", "Signature"])
      expect(logged).not.toContain(secret)
  })
  it.each(["constructor", "__proto__", "VALIDATION_<script>secret</script>"])(
    "未知或非法错误码 %s 不污染提示或分类",
    code => {
      const error = new TrohubError(400, code)
      expect(error.message).toBe("检测参数未被服务接受，请检查输入")
      expect(error.invalidInput).toBe(true)
    }
  )
  it("未配置密钥不发 HTTP", () => {
    const p = new TrohubProvider({ get: () => undefined } as unknown as ConfigService)
    expect(() => p.detail("tm", "id")).toThrow("检测服务暂不可用")
    expect(request).not.toHaveBeenCalled()
  })
})
