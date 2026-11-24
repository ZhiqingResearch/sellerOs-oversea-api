// Earlier tasks stored display messages instead of structured error codes.
const savedMessages = new Map(
  Object.entries({
    "检测参数未被服务接受，请检查输入":
      "The screening service rejected the input. Check the submitted parameters.",
    结果未完整获取: "The complete screening results could not be retrieved.",
    结果截断: "The screening results were truncated.",
    检测结果格式不完整: "The screening service returned incomplete result data.",
    "检测结果格式不完整，请稍后重试":
      "The screening service returned incomplete result data. Try again later.",
    检测服务连接异常: "The connection to the screening service failed.",
    "检测服务连接异常，请稍后重试":
      "The connection to the screening service failed. Try again later.",
    "检测服务内部异常，请稍后重试":
      "The screening service encountered an internal error. Try again later.",
    "检测服务限流组件暂不可用，请稍后重试":
      "The screening service's rate limiter is unavailable. Try again later.",
    "检测服务繁忙，请稍后重试": "The screening service is busy. Try again later.",
    "检测服务认证失败，请联系管理员":
      "Screening service authentication failed. Contact an administrator.",
    "检测服务认证失败，服务凭证可能无效或已停用，请联系管理员":
      "Screening service authentication failed. The credentials may be invalid or disabled. Contact an administrator.",
    "检测服务额度不足，请联系管理员":
      "The screening service quota is exhausted. Contact an administrator.",
    "检测服务订阅未生效或已到期，请联系管理员":
      "The screening service subscription is inactive or expired. Contact an administrator.",
    "检测服务拒绝访问，请联系管理员检查服务权限":
      "The screening service denied access. Ask an administrator to check permissions.",
    "检测服务未受理本次请求，请联系管理员核查服务状态":
      "The screening service declined the request. Ask an administrator to check the service status.",
    检测结果暂未找到: "The screening result could not be found.",
    "检测服务暂不可用，请稍后重试": "The screening service is unavailable. Try again later.",
    检测服务请求失败: "The screening service request failed.",
    "图片尺寸过小，最长边需至少 200 像素，请更换图片":
      "The image is too small. Use an image with a longest side of at least 200 pixels.",
    "图片须为 JPG/PNG/WebP，最长边至少 200 像素":
      "Use a JPG, PNG or WebP image with a longest side of at least 200 pixels.",
    "图片读取失败，请重新上传": "The image could not be read. Upload it again.",
    "商品图读取失败，请确认图片为 10MB 以内的 JPG/PNG/WebP，最长边至少 200 像素后重试":
      "The product image could not be read. Use a JPG, PNG or WebP under 10 MB with a longest side of at least 200 pixels.",
    "商品图仅支持有效的 Amazon 图片 CDN HTTPS 地址":
      "Use a valid HTTPS image URL from the Amazon image CDN.",
    上游结果已不可获取: "The supplier result is no longer available.",
    "检测失败，请重新检测": "Screening failed. Run the check again.",
    该图片检测失败: "Screening failed for this image.",
    部分或全部图片检测失败: "Some or all image checks failed.",
    "检测输入读取失败，请重新上传图片":
      "The screening input could not be read. Upload the image again.",
  })
)
const incomplete = "Results are incomplete. Risk cannot be ruled out."

export function englishScreeningMessage(message: string): string {
  if (message === "结果未完整获取，不能据此排除风险") return incomplete
  const suffix =
    /(?:；结果未完整获取，不能据此排除风险|\. Results are incomplete; risk cannot be ruled out\.)$/
  if (suffix.test(message)) {
    const reason = message.replace(suffix, "")
    return reason === "结果未完整获取"
      ? incomplete
      : `${englishScreeningMessage(reason)} ${incomplete}`
  }
  const code = message.match(/（错误码：([A-Z][A-Z0-9_]{0,99})）$/)
  const reason = code ? message.slice(0, code.index) : message
  const translated = savedMessages.get(reason)
  if (!translated) return message
  return translated + (code ? ` (error code: ${code[1]})` : "")
}
