# Stripe 与 PayPal 支付方式及二维码方案调研

> 调研日期：2026-08-18
>
> 适用范围：产品方案评估、支付收款页设计及后端支付接口设计。实际可用能力以商户账号后台、商户注册国家/地区和交易参数为准。

## 1. 核心结论

Stripe 和 PayPal 都可以提供二维码收款，但“二维码”通常只是付款入口，不是唯一付款方式。

| 对比项 | Stripe | PayPal |
| --- | --- | --- |
| 是否可以生成二维码 | 可以将 Payment Link 生成为二维码 | 可以将 Payment Link、账单或商家收款码生成为二维码 |
| 扫码后的典型流程 | 打开 Stripe 托管结账页，再选择银行卡、数字钱包或本地支付方式 | 打开 PayPal 托管结账页，或进入 PayPal App 完成付款 |
| 付款人是否必须有平台账号 | 不需要 Stripe 账号；Stripe 不是面向消费者的通用付款钱包 | 选择 PayPal 钱包或 PayPal 原生收款码时通常需要 PayPal 账号；使用页面提供的银行卡访客支付时不需要 |
| 是否存在原生扫码支付 | 有，取决于用户选择的本地支付方式，例如微信支付、PayNow、PromptPay、Pix | 有，PayPal 商家二维码可以由用户使用 PayPal App 扫码支付 |

因此，不能简单理解为“给用户一个 Stripe 二维码，用户登录 Stripe 账号扫码付款”。Stripe 没有面向普通消费者的对应扫码钱包。用户扫描 Stripe Payment Link 二维码后，实际使用的是银行卡、Apple Pay、Google Pay、支付宝、微信支付或当地银行 App 等付款工具。

PayPal 则同时存在两种二维码场景：

1. **PayPal 原生商家收款码**：用户通常通过 PayPal App 和 PayPal 账号付款。
2. **PayPal Payment Link 二维码**：二维码打开 PayPal 托管付款页，付款页可能继续提供 PayPal、银行卡、Apple Pay、Venmo、Pay Later 等选项。

支付宝和微信支付需要单独区分：

| 能力 | Stripe | PayPal |
| --- | --- | --- |
| 支付宝 | 符合商户地区、币种和产品条件时，可在 Checkout、Payment Links 或 Elements 中启用 | PayPal Orders API 提供需要申请的 Beta 能力；Braintree 也属于有限开放，不是普通 PayPal Checkout 默认方式 |
| 微信支付 | 符合条件时，可在 Checkout、Payment Links、Elements、Invoicing 等产品中启用 | 主要通过 Braintree Local Payment Methods 有限开放，需要联系 PayPal 申请，不是普通 PayPal Checkout 默认方式 |
| 普通平台二维码能否直接作为支付宝/微信原生收款码 | 不能；它只是打开 Stripe 付款页的网址二维码 | 不能；普通 PayPal 商家码是 PayPal 钱包收款码 |

## 2. Stripe 支持的付款方式

Stripe 将付款方式划分为银行卡、银行扣款、银行跳转、银行转账、先买后付、实时支付、现金凭证和数字钱包等类别。

### 2.1 信用卡和借记卡

常见支持卡组织包括：

- Visa
- Mastercard
- American Express
- Discover
- Diners Club
- JCB
- China UnionPay（银联）
- Cartes Bancaires
- eftpos
- Interac（仅部分线下场景）
- 部分地区本地银行卡

具体卡组织是否可用取决于 Stripe 商户账号注册地区和交易地区。

### 2.2 数字钱包

Stripe 官方列出的数字钱包和快捷支付方式包括：

- Apple Pay
- Google Pay
- Link
- Cash App Pay
- Alipay（支付宝）
- WeChat Pay（微信支付）
- GrabPay
- MobilePay
- Revolut Pay
- MB WAY
- PayPay
- Kakao Pay
- Naver Pay
- Samsung Pay
- PayCo
- Satispay
- 部分地区的 PayPal
- 符合资格账号的稳定币和加密货币支付

注意：Stripe 将 PayPal 列为部分欧洲地区可用的钱包付款方式，但其商户地区、币种和产品支持有限，不能直接视为全球范围内对 PayPal 独立接入的替代。

### 2.3 银行扣款

- ACH Direct Debit：美国
- Instant Bank Payments：美国/加拿大的部分场景
- SEPA Direct Debit：欧元区
- Bacs Direct Debit：英国
- AU BECS Direct Debit：澳大利亚
- NZ BECS Direct Debit：新西兰
- Canadian PADs：加拿大

银行扣款可能不是即时确认，需要等待银行处理结果。

### 2.4 银行跳转和实时银行支付

- iDEAL：荷兰
- Bancontact：比利时
- BLIK、Przelewy24：波兰
- EPS：奥地利
- FPX：马来西亚
- TWINT：瑞士
- UPI：印度的部分商户场景
- PayNow：新加坡
- PromptPay：泰国
- Pix：巴西
- PayTo：澳大利亚
- Swish：瑞典，部分能力需要申请

其中 PayNow、PromptPay、Pix 等会在付款过程中展示动态二维码。用户不是用 Stripe 账号扫码，而是使用当地银行 App 或支持该支付网络的钱包 App 扫码并授权。

### 2.5 银行转账

Stripe 支持部分地区的银行转账收款，包括：

- USD Bank Transfer
- SEPA Bank Transfer
- UK Bank Transfer
- Japan Bank Transfer（Furikomi）
- Mexico Bank Transfer

银行转账通常更适合大额支付或企业支付，到账时间和自动对账能力需要结合具体产品确认。

### 2.6 先买后付和分期付款

- Klarna
- Afterpay / Clearpay
- Affirm
- Zip
- Meses sin intereses（墨西哥分期）
- 其他受地区和账号邀请资格限制的分期产品

### 2.7 现金凭证和线下完成付款

- OXXO：墨西哥
- Boleto：巴西
- Konbini：日本便利店
- Multibanco：葡萄牙

用户在结账页生成凭证后，可能需要到线下网点完成付款。此类订单不能在创建凭证后立即视为支付成功。

## 3. Stripe 二维码支付方式

### 3.1 Payment Link 二维码

商户可以在 Stripe Dashboard 创建 Payment Link，然后下载对应二维码 PNG。二维码本身不会过期；如果底层 Payment Link 被停用，扫码后会进入失效页面。

典型流程：

```text
商户创建 Payment Link
  → 将链接生成二维码
  → 用户用手机相机扫码
  → 打开 Stripe Checkout
  → 用户选择银行卡、钱包或本地支付方式
  → Stripe 通过 Webhook 通知商户支付结果
```

这种二维码本质上是网页链接二维码，不要求用户安装 Stripe App，也不要求注册 Stripe 账号。

### 3.2 本地付款方式动态二维码

当用户在 Stripe Checkout 或 Payment Element 中选择微信支付、PayNow、PromptPay、Pix、Cash App Pay 等方式时，Stripe 可以按具体支付方式为当前交易展示动态二维码或跳转到对应钱包。支付宝用户则可以通过支付宝账号或支付宝 App 完成授权，具体表现取决于设备和 Stripe 当前的结账流程。

这种二维码一般与当前 PaymentIntent、金额和有效期绑定，不应作为长期静态收款码重复使用。应由后端通过 Webhook 判断最终付款结果。

### 3.3 Stripe 的支付宝和微信支付

Stripe 可以处理支付宝和微信支付，但前提是商户账号所在国家或地区、交易币种、支付产品及业务类别全部符合要求，并且已经在 Stripe Dashboard 的 Payment Methods 中启用对应方式。

支付宝主要面向中国消费者、海外华人和中国游客。Stripe 当前支持符合条件的欧盟、澳大利亚、加拿大、香港、日本、新西兰、新加坡、美国等地区商户接入，支持币种随商户所在地变化。

微信支付同样面向中国消费者、海外华人和中国游客。Stripe 当前支持符合条件的美国、英国、香港、新加坡、日本、加拿大、澳大利亚及部分欧洲国家商户接入，并支持 Checkout、Payment Links、Elements、Invoicing 和部分 Terminal 场景。

实际付款可能包含两层二维码：

```text
第一层：平台或 Stripe Payment Link 二维码
  → 用户扫码打开 Stripe Checkout
  → 用户选择支付宝或微信支付
第二层：Stripe 为当前订单提供钱包授权流程
  → 桌面端可能展示钱包动态二维码
  → 移动端通常跳转或唤起对应钱包 App
```

第一层二维码只是一个 HTTPS 付款链接，不是支付宝或微信原生收款码。不能仅因为支付宝或微信能够识别并打开该网址，就把它视为对应钱包的原生支付二维码。

## 4. PayPal 支持的付款方式

### 4.1 PayPal 钱包

用户登录 PayPal 后，可以使用 PayPal 余额以及绑定在 PayPal 账号中的银行卡或银行账户付款。

选择 PayPal 钱包付款时，需要用户拥有并登录 PayPal 账号。

### 4.2 信用卡和借记卡

PayPal Checkout 或 Expanded Checkout 可根据商户资格提供银行卡付款，主要包括：

- Visa
- Mastercard
- American Express
- Discover
- 其他符合商户地区和收单资格的信用卡或借记卡

如果商户和当前交易支持 Guest Checkout，用户可以直接填写银行卡资料，不必注册 PayPal 账号。是否展示访客银行卡入口由地区、商户账号配置、交易风险和 PayPal 的动态判断共同决定，不能假设每一笔交易都会显示。

### 4.3 数字钱包及分期

- Apple Pay
- Google Pay
- Venmo：主要限美国商户和美国用户
- PayPal Pay Later
- PayPal Credit：主要限美国和英国

### 4.4 本地替代支付方式

PayPal 官方当前列出的本地支付方式包括：

- Bancontact：比利时
- BLIK、Przelewy24：波兰
- EPS：奥地利
- iDEAL：荷兰
- Multibanco：葡萄牙
- MyBank：意大利
- Trustly：欧洲多个国家
- Pay upon Invoice：德国
- 部分产品或地区的 Pay by Bank / ACH
- 需要申请的 Alipay Beta 能力
- Braintree 有限开放的 WeChat Pay
- 部分地区或精选商户的 GrabPay、Satispay、OXXO、Boleto 等

部分替代支付方式仅对精选合作伙伴开放，且需要匹配买家国家、商户国家和交易币种。

## 5. PayPal 二维码支付方式

### 5.1 PayPal 原生商家收款码

商户可以在 PayPal Business 账号中生成商家二维码并展示给客户。用户扫描后输入或确认金额，通过 PayPal 完成付款，资金进入商户 PayPal 账号。

这种模式最接近常见的“钱包收款码”：用户一般使用 PayPal App/账号付款。功能是否可用取决于商户所在国家或地区。

### 5.2 Payment Link 或账单二维码

PayPal Payment Links and Buttons 可以生成指向 PayPal 托管付款页的二维码。官方列出的付款页能力包括：

- PayPal
- PayPal Pay Later
- Venmo
- Apple Pay
- 主要信用卡和借记卡

PayPal 账单也可以提供打开账单付款页的二维码，部分账单产品还可提供 Pay by Bank / ACH。

这种二维码和 Stripe Payment Link 类似，本质上是支付页面入口。若页面展示银行卡访客支付，付款人不需要 PayPal 账号；若选择 PayPal 钱包，则需要登录 PayPal。

### 5.3 PayPal 的支付宝和微信支付限制

普通 PayPal 商家二维码只能进入 PayPal 收款流程；标准 PayPal Payment Links 官方默认列出的方式主要是 PayPal、Pay Later、Venmo、Apple Pay 和主要信用卡/借记卡，不会自动把二维码变成支付宝或微信支付收款码。

PayPal 平台并非完全不能处理这两个钱包，但需要使用独立且受限的产品能力：

- **支付宝**：PayPal Orders API 当前提供 Beta 接入。商户需要申请开通，创建订单时显式设置 `payment_source.alipay`，然后把响应中的 `payer-action` 地址交给用户，由 PayPal 将用户转到支付宝授权。它不是普通 PayPal Payment Link 自动附带的能力。
- **微信支付**：PayPal 旗下 Braintree 的 WeChat Pay 当前属于 limited release，仅面向中国买家，并且商户国家主要限英国和部分欧洲国家。商户需要联系 PayPal Customer Success Manager 申请，不能假设普通 PayPal Business 账号可以直接启用。

因此，如果产品需要稳定地面向中国用户展示支付宝和微信支付，应优先核实 Stripe 商户账号能否同时启用这两种钱包；PayPal 更适合作为 PayPal 钱包、银行卡及其本地优势方式的独立通道。只有在 PayPal 明确批准 Alipay Beta 或 Braintree WeChat Pay 后，才应把对应入口加入生产环境。

## 6. 平台推荐方案：一个二维码同时支持 Stripe 和 PayPal

如果产品目标是“每个订单只展示一个二维码，同时让用户选择 Stripe 或 PayPal”，推荐让二维码指向平台自己的订单付款页，而不是直接使用某一个支付服务商的静态二维码。

示例：

```text
https://example.com/pay/orders/ORDER_NO
```

推荐流程：

```text
后端创建待支付订单
  → 返回平台付款页 URL
  → 前端将 URL 渲染为二维码
  → 用户扫码进入平台付款页
  → 用户选择具体付款方式
  ├─ 支付宝：创建 Stripe Checkout Session，指定或动态展示 Alipay
  ├─ 微信支付：创建 Stripe Checkout Session，指定或动态展示 WeChat Pay
  ├─ 银行卡/Apple Pay：进入 Stripe Checkout
  └─ PayPal：创建 PayPal Order 并进入 PayPal Checkout
  → 支付服务商回调平台 Webhook
  → 后端幂等更新订单状态
```

这个方案的优点：

- 一个二维码即可容纳多个支付服务商。
- 可以根据国家、币种、设备动态展示支付方式。
- 平台可以统一订单号、支付状态、超时和退款逻辑。
- 后续增加其他支付服务商时不需要更换已经发布的二维码规则。
- 可以避免用户误以为必须注册 Stripe 或 PayPal 账号。

不建议直接把两个服务商的信息编码到同一个“原生支付二维码”中。一个标准二维码通常只有一个目标地址，不能同时作为 Stripe 原生交易二维码和 PayPal 原生交易二维码。

## 7. 后端实现注意事项

### 7.1 支付状态必须由服务端确认

不能因为用户浏览器跳转到 `success_url` 或前端显示“支付完成”就把订单标记为已支付。

- Stripe：验证 Stripe Webhook 签名，以成功的 PaymentIntent/Checkout Session 事件为准。
- PayPal：验证 PayPal Webhook，并通过订单捕获结果确认到账。
- 银行扣款、现金凭证等延迟付款方式需要保留处理中状态。

### 7.2 金额和币种由后端控制

后端应根据本地订单生成 Stripe Checkout Session 或 PayPal Order。前端只能提交订单标识和支付渠道，不能直接决定最终金额、币种、商品描述或收款账号。

### 7.3 Webhook 需要幂等

建议至少保存以下字段：

- 平台订单号
- 支付服务商
- 服务商订单号或 PaymentIntent ID
- 金额和币种
- 支付状态
- Webhook Event ID
- 支付时间、过期时间和退款状态
- 原始回调摘要或审计日志

同一个 Webhook Event ID 或同一个服务商交易号重复到达时，不得重复记账或重复发放商品。

### 7.4 建议的统一状态

```text
PENDING     待支付
PROCESSING  支付处理中
PAID        已支付
FAILED      支付失败
EXPIRED     已过期
CANCELLED   已取消
REFUNDING   退款处理中
REFUNDED    已退款
```

## 8. 地区和账号限制

支付方式不是接入 Stripe 或 PayPal 后全部自动可用。最终展示结果至少受以下条件影响：

- 商户主体注册国家或地区
- 商户账号是否完成审核，以及是否取得特定能力资格
- 消费者所在国家或地区
- 支付币种和订单金额
- 一次性支付、订阅、账单或线下支付等产品类型
- 浏览器、设备和已安装的钱包
- 风控结果
- 具体 API 或托管结账产品是否支持该方式

正式开发前，应先确定目标商户主体、主要买家国家、结算币种、是否需要订阅，以及是否需要中国大陆用户常用的支付宝/微信支付，再到两个商户后台核对实际可启用的方法。

## 9. 官方资料

### Stripe

- [支持的付款方式](https://docs.stripe.com/payments/payment-methods/overview)
- [付款方式产品及地区支持矩阵](https://docs.stripe.com/payments/payment-methods/payment-method-support)
- [创建 Payment Link 及二维码](https://docs.stripe.com/no-code/payment-links)
- [Payment Element 的二维码付款方式说明](https://docs.stripe.com/payments/accept-a-payment)
- [支付宝](https://docs.stripe.com/payments/alipay)
- [微信支付](https://docs.stripe.com/payments/wechat-pay)
- [PayNow](https://docs.stripe.com/payments/paynow)
- [PromptPay](https://docs.stripe.com/payments/promptpay)
- [Pix](https://docs.stripe.com/payments/pix)

### PayPal

- [付款方式总表](https://developer.paypal.com/payment-methods)
- [Payment Links、Buttons 和二维码](https://developer.paypal.com/payment-links-buttons/overview/)
- [PayPal 支付产品概览](https://developer.paypal.com/payments)
- [支持的本地替代支付方式](https://developer.paypal.com/docs/multiparty/checkout/apm/supported-apms/)
- [PayPal 商家二维码](https://www.paypal.com/us/business/accept-payments/qr-code)
- [保存付款方式](https://developer.paypal.com/docs/checkout/save-payment-methods/)
- [PayPal Orders API 支付宝 Beta](https://developer.paypal.com/alipay)
- [Braintree 微信支付有限开放](https://developer.paypal.com/braintree/docs/guides/local-payment-methods/wechat-pay/)
