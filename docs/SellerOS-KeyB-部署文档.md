# SellerOS KeyB 接入部署文档

更新：2026-09-08。适用于本仓库新增的 KeyB 管理与服务扣费入口。本文说明应如何部署。2026-09-08 起 dev 环境（api-dev2）已按本文执行存量授权数据归一化、`--grant-keyb` 授权及真实签发/扣费联调（见 4.2、8.3、9.1 节）；**生产环境仍未执行任何部署动作**。

## 1. 先弄清楚需要哪些值

需要向 **Skills API 负责人领取三项**：API 服务地址、SellerOS 接入项目 ID、该项目的 KeyA。再在 **SellerOS 侧准备 KeyB 加密主密钥**，组成四项环境配置。调用服务的 appId/appSecret 与项目扣费授权统一由 SellerOS 的 OpenApiApp 数据表管理，不再配置环境白名单。

```text
SellerOS -- 项目 KeyA --> Skills API：为当前用户签发 KeyB
SellerOS -- 加密主密钥 --> 本地数据库：加密保存 KeyB
Skills API -- KeyB + appId/appSecret 服务签名 --> SellerOS：扣费
```

| 名称 | 从哪里取得 | 配置给谁 | 用途 |
| --- | --- | --- | --- |
| API origin、项目 ID、KeyA | Skills API 创建 SellerOS 接入项目时提供 | SellerOS 后端 | 确定签发服务和接入项目，申请/重置用户 KeyB |
| appId、appSecret | SellerOS 的 `scripts/create-open-api-app.ts` 创建，或复用现有接入方 | appId + appSecret 配给 Skills API 后端；项目授权写入该 OpenApiApp 行 | API 向 SellerOS 上报费用时进行服务签名及项目授权核验 |
| 加密主密钥 | 部署人员在受控环境生成 | SellerOS 后端各实例及独立 Secret 备份 | 加密/解密本地保存的 KeyB |
| 用户 KeyB | 用户在 SellerOS 页面主动生成，后端调用 API 获得 | SellerOS 加密保存；用户主动复制到其业务客户端 | 识别消费用户；不是部署环境变量 |

**KeyA、appSecret、加密主密钥是三种不同的密钥，不能互相代填。** `SKILLS_KEYS_PROJECT_ID` 是 Skills API 的项目标识；OpenApiApp.appId 是 SellerOS 登记的调用服务身份。`keybProjectCodes` 保存这个服务获准扣费的本地项目代码，本期为 `["selleros"]`，不是外部项目 ID 或服务 appId。

本次只开放一个接入项目代码 `selleros`，无项目管理后台。无需给每位用户创建 OpenApiApp；它对应调用服务，不对应用户。KeyB 由用户按需生成，无批量初始化 KeyB 脚本。

## 2. 四个环境变量怎么填

复制下面模板到 SellerOS 后端的 `.env` 或部署平台环境变量/Secret 配置中。以下空值不是可直接启用的配置：

```dotenv
# SellerOS -> Skills API KeyB 接入（全部留空=禁用；启用需四项完整配置）
# 只允许 HTTPS origin，无路径/查询；签发固定 POST /api/v1/projects/keys
SKILLS_KEYS_API_ORIGIN=""
SKILLS_KEYS_PROJECT_ID=""          # 与当前 KeyA 对应的 API 项目 ID；切换项目后用户主动重置 KeyB
SKILLS_KEYS_PROJECT_KEY_A=""       # 项目 KeyA，仅后端 Secret 注入，禁止交给浏览器/MCP
SKILLS_KEYS_ENCRYPTION_KEY=""      # 32 字节随机主密钥的标准 base64，独立于数据库保管
```

四项全部为空或未设置时，功能关闭，相关新接口返回 503 `SKILLS_KEYS_DISABLED`，其他既有功能不因此被禁用。只配置部分字段或字段格式非法会导致应用启动失败，不能只填 KeyA 就上线。这四项基础配置启动时读取，更改后需重启/重新部署应用；同一环境的各实例必须使用一致的配置。

**新增或撤销扣费服务权限只修改数据库，无需改环境变量或重启。** 后端每次 KeyB 扣费鉴权重新读取 OpenApiApp 的状态和 `keybProjectCodes`，没有授权缓存。首次升级本版代码及 schema 仍需要正常发布；具体步骤见第 3、4 节。

### 2.1 SKILLS_KEYS_API_ORIGIN：Skills API 的服务根地址

- **来源**：Skills API 负责人提供本环境后端地址，不是 SellerOS 自己的域名，也不是前端页面地址。
- **格式**：规范形式的 HTTPS origin，可带非默认端口或末尾 `/`；域名使用小写，默认 HTTPS 的 `:443` 应省略。配置值须与 URL 规范化后的 origin 一致，不允许业务路径、用户名/密码、查询参数或片段。
- **正确结构示例**：`https://skills-api.example.com`。这是示例域名，需替换为真实环境地址。
- **错误填法**：`http://...`、`https://.../api`、`https://.../api/v1/projects/keys`、`https://...?token=...`。
- 后端自动拼接为 `https://实际域名/api/v1/projects/keys`，用 POST 签发；地址不能依赖 301/302 重定向，代码禁止跟随重定向。
- 出站访问需能解析该域名、验证 HTTPS 证书并连接到 API；不要通过关闭 TLS 校验处理证书问题。

### 2.2 SKILLS_KEYS_PROJECT_ID：API 侧 SellerOS 项目 ID

- **来源**：Skills API 侧创建 SellerOS 接入项目后返回的项目 ID，必须和 KeyA 属于同一个项目、同一个环境。
- **格式**：1～128 个字符，首字符为字母/数字，后续允许字母、数字、`_`、`.`、`:`、`-`。若外部 ID 是数字，在环境变量中按字符串填写。
- **用途**：保存在 SellerOS 的凭证关联中，并参与密文归属绑定及扣费归属核对。API 当前签发请求体只有手机号，远端项目由 KeyA 决定，配置 ID 与 KeyA 的对应关系需要部署人员核对。
- **不可填**：客户工作台 Project ID、用户 ID、OpenApiApp.appId，或未经 API 确认就填固定字符串 `selleros`。
- **切换项目（2026-09-14）：**把 API origin、项目 ID、KeyA 配成同一目标环境/项目，重新部署全部实例。用户点击「重置」，后端就用当前配置签发新 KeyB，并自动更新数据库关联，**不需要手改数据库或运行迁移脚本**。状态返回 `SYNC_UNKNOWN` + `SKILLS_PROJECT_CHANGED` 时，前端允许明确重置；旧 KeyB 不能继续在 SellerOS 查看、复制或通过新扣费鉴权。
- 例如从项目 `4` 切换到 `2`：配置目标地址、`SKILLS_KEYS_PROJECT_ID=2` 及项目 `2` 的 KeyA → 重新部署 → 用户确认重置（新 operationId）→ 复制新 KeyB 并更新客户端。普通 KeyA 轮换或同一服务换域名不要求改数据库关联；加密主密钥仍需保持不变。
- 重置只按需处理该用户，不批量重签全部用户。切换不同 API 环境不会替旧环境撤销凭证；如需撤销旧环境的 Key，由旧 API 侧处理。实际签发超时/保存失败产生的 `SYNC_UNKNOWN` 仍按第 9 节核查，不因配置变更自动重签。

### 2.3 SKILLS_KEYS_PROJECT_KEY_A：API 侧签发项目凭证

- **来源**：Skills API 为上述项目签发的 KeyA；SellerOS 本仓库没有创建 API 项目或生成 KeyA 的脚本。
- **用途**：SellerOS 后端向 API 签发接口发送 `X-Project-Key: <KeyA>`，JSON 请求体为当前数据库用户的 `{phone}`。
- **格式**：1～512 位非空白可打印 ASCII，完整填写 API 给的原值。环境变量里不加 `Bearer ` 或 `X-Project-Key:` 前缀。
- **保存位置**：SellerOS 后端 Secret；不能放进 `VITE_*`、`NEXT_PUBLIC_*` 等前端可见变量，不能给用户 Agent 或 MCP。
- KeyA 的轮换方式及其对已有 KeyB 的影响由 API 负责人确认，本期不提供自动轮换/对账。收到错误或超时后，不要用同一手机号反复手工调用签发接口验证 KeyA：签发会使旧 KeyB 失效。

### 2.4 SKILLS_KEYS_ENCRYPTION_KEY：SellerOS 保存 KeyB 的主密钥

- **来源**：部署人员为本环境生成的 32 字节密码学随机值，编码为标准 Base64；不是随手填写 32 个字符，也不是十六进制字符串。
- **用途**：AES-256-GCM 加密/解密 KeyB，配合用户及项目归属校验。此值不发给 Skills API、浏览器或 MCP。
- **生成命令**：在受控终端运行一次，将输出直接保存到 Secret 管理器；不要在共享 CI 日志、聊天或工单中保留输出。本文没有执行该命令。

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64') + '\n')"
```

正常结果为 44 个字符、包含末尾 `=` 的标准 Base64。完整复制，不能删掉 `=`、换成 URL-safe Base64，或粘入额外引号/换行。`.env` 中的包围双引号由 dotenv 解析；部署平台纯值输入框通常只填原值。

**每个环境生成一次，同一环境所有实例共用，后续发布保持稳定。** 不要每次启动或 CI 构建都重新生成；旧密文无法用新主密钥读取。本期没有主密钥轮换或批量重加密脚本。主密钥丢失后不能只靠数据库恢复 KeyB，应独立备份主密钥，数据库备份恢复时也要恢复匹配的 Secret。测试与生产不要共用。

## 3. 部署顺序和数据库结构

以下命令都从 SellerOS 仓库根目录执行。部署机需要 Node.js 22、npm 和全量项目依赖；现有生产镜像省略 devDependencies，且没有复制 `scripts/`，不要假定能直接在运行容器中执行 ts-node 管理脚本。

执行涉及目标数据库的命令前，确认 `.env` / 部署平台注入的 `DATABASE_URL` 指向正确环境、schema 差异已审核、目标库已备份，并获得本次写库授权。已导出的同名环境变量可能覆盖 `.env` 值；不要靠文件名猜连接目标，也不要打印完整含密码的连接串到日志。

### 第一步：安装依赖、生成 Prisma Client、校验及构建

```bash
npm ci
npx prisma generate
npx prisma validate
npm run build
```

私有 SDK 安装需要既有 `PACKAGES_TOKEN`；按仓库 `.npmrc`/CI Secret 配置提供，不把 token 写进文档、Git 或 Docker build-arg。构建不需要执行真实签发/扣费。`generate` 只更新 Prisma Client，`validate` 只校验 schema，它们不等于数据库表已创建。

### 第二步：经确认后同步数据库

```bash
npm run db:push
```

这是本项目唯一 schema 同步方式，不执行 `migrate`、`db:migrate`、`db:deploy`，不使用 `--accept-data-loss`。`db:push` 对齐的是**当前整个 schema**，不只新增本功能的表；如提示删除或损失数据，应先核对其他差异，不能为安装 KeyB 功能直接接受。

本功能实际新增：

| 对象 | 说明 |
| --- | --- |
| `SkillsKeyCredential` | 用户与外部接入项目的凭证关联，含手机号快照、密文、查找哈希、脱敏值、操作 UUID 历史、状态、条件更新版本与时间 |
| `SkillsKeyStatus` | `ROTATING`、`ACTIVE`、`SYNC_UNKNOWN` |
| `User.skillsKeyCredentials` | Prisma 关系字段，不新增用户余额列 |
| 唯一约束 | 用户 + projectCode；外部项目 ID + 签发手机号；keyHash |
| `OpenApiApp.keybProjectCodes` | 新增 JSON 列，默认 `[]`；保存该服务获准 KeyB 扣费的本地项目代码，例如 `["selleros"]`。空数组代表未授权，不影响旧开放接口的授权规则 |

不新增消费账单表、不改 UsageLog 精度或唯一键；审计信息写入既有 UsageLog.meta。无需迁移 KeyB 密文或补充值/会员/团队余额，也不用跑旧会员迁移或返利修复脚本。**旧 OpenApiApp 行不会因 `db push` 自动获得权限，必须逐个确认后显式补项目授权**；注意 `@default("[]")` 是 Prisma 客户端层默认值，存量行加列后实际为 NULL（2026-09-08 dev 已实测），管理脚本对 NULL 报「接入方项目权限数据格式异常」并拒绝执行——先按第 4.2 节把存量 NULL 行归一化为 `[]` 再补授权。不会把所有已有服务自动授权给 SellerOS。

### 第三步：准备服务身份、项目授权、必要的 source、四项配置

在 schema 同步完成后，按第 4 节查看并授权既有 OpenApiApp；没有可用身份时才创建。按第 5 节检查 source。领取 API 的地址、项目 ID 和 KeyA，生成并保存主密钥，完整填好四项配置。只有在 API 后端已安全收到 appId/appSecret，且具备自动扣费衔接后，才能验收完整链路。

**从旧环境白名单版升级的顺序：**审核并执行 `db:push` → 使用本版 Prisma Client 和管理脚本 `--list` 找到既有服务 → 对原本获准的每个服务显式 `--grant-keyb` → 移除旧 `SKILLS_KEYS_ALLOWED_APP_IDS` 配置 → 发布/启动本版应用。新代码不读取旧变量，也没有旧配置兜底；只保留旧变量不会授予任何服务权限。禁止全量默认授权，也不要重建服务或重置用户 KeyB 来完成升级。保持原 appId、appSecret、项目 ID 和加密主密钥；这样待扣任务的幂等身份不变。

**必须先同步新列，再让新版 Prisma Client/应用访问目标库。** 可以提前生成 Client 和构建，但不能先切换线上进程：旧手机号开放接口的鉴权也会读取整行 OpenApiApp，新 Client 会查询 `keybProjectCodes`，目标库缺少此列会连旧开放接口一起失败。管理脚本的 `--list`、授权等操作同样在 schema 同步后执行。

### 第四步：启动应用

普通进程部署，在环境变量已加载的前提下执行：

```bash
npm run start:prod
```

此命令启动既有 Nest 应用，可能执行已有定时任务的启动补偿；不要把连接真实数据库的应用启动当作纯静态检查。容器部署需按第 6 节覆盖默认 CMD，先同步 schema 再启动。

## 4. OpenApiApp 管理脚本：何时需要跑、怎么跑

脚本：`scripts/create-open-api-app.ts`。下面用 Node 显式加载根目录 `.env`，再使用已安装的 ts-node 执行。部署环境若已通过 Secret 注入全部变量，可去掉 `--env-file=.env`，不要创建第二套互相冲突的连接配置。

### 4.1 先查看现有接入方（只读）

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts --list
```

输出 appId、名称、状态、单笔上限、`keybProjectCodes` 和创建时间，不显示 appSecret。项目权限列以逗号分隔显示项目代码，无权限显示「无」。若已有专供 Skills API 使用且持有对应 Secret 的有效身份，直接按下一节补授权，不必每次发布都新建。

### 4.2 已创建过 Skills API：给现有身份补授权（写 OpenApiApp 表）

**如果已经执行过 `... scripts/create-open-api-app.ts "Skills API"`，只需本节，不要再次创建。** 先按第 3 节同步新增列，再执行 `--list` 找到已建的那条记录，把它的 appId 代入：

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts --grant-keyb '<实际 appId>' selleros
```

这个命令把 `selleros` 加入该行的 `keybProjectCodes`，重复执行不重复添加。**不会重建身份、修改 appId/appSecret、限额或状态，也不会操作用户 KeyB 或账户余额。** 无需把新 Secret 再交给 API；API 继续使用之前保存的那组凭据。授予后后续扣费请求读取数据库即生效，无需重启应用。

**若 `--list` 或授权命令报「接入方项目权限数据格式异常」**：说明存量行的 `keybProjectCodes` 为 NULL（`@default("[]")` 是客户端层默认值，`db push` 不回填存量行；2026-09-08 dev 实测遇到）。先把 NULL 行归一化为 `[]`（与默认语义一致，不放行任何项目），再重试授权：

```bash
node --env-file=.env <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.openApiApp.findMany({ select: { appId: true, keybProjectCodes: true } });
  const bad = rows.filter(r => !Array.isArray(r.keybProjectCodes));
  for (const r of bad) {
    await prisma.openApiApp.update({ where: { appId: r.appId }, data: { keybProjectCodes: [] } });
  }
  console.log('已归一化：', bad.length, '行');
})().finally(() => prisma.$disconnect());
NODE
```

`selleros` 是本地项目代码，不要传外部项目 ID、项目名称或用户 ID。授权不会自动启用 `DISABLED` 的服务；使用 KeyB 扣费仍必须同时满足 `status=ACTIVE`、项目已授权、HMAC 验签及用户 KeyB 有效。仅创建 OpenApiApp 服务身份并不自动获得项目扣费权限。

appId 参与消费幂等空间。不要为完成授权或重试待扣任务随意重建/更换服务身份，否则同一业务编号可能进入另一编号空间。更换身份需先处理原有待扣任务。

### 4.3 尚无身份：创建并同时授权（写 OpenApiApp 表）

只有确认没有可复用的 Skills API 身份时，执行：

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts "Skills API" --keyb-project selleros
```

该创建命令**每次都会新建**，不是幂等 seed；执行一次即可。未传单笔上限时 `perCallMaxCny=null`，即没有该服务级单笔限制。如果业务已确定单笔上限，可传人民币元金额，例如下面的 `100` **只是参数示例，不代表本项目已经批准的收费上限**：

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts "Skills API" 100 --keyb-project selleros
```

两条创建命令选符合已确认限额的一条，不要连续照抄执行。上限须为正数，按现有数据库两位小数金额填写；新扣费入口本身允许六位小数费用并另校验数据库范围。

保留旧调用方式 `... "Skills API" [单笔上限元]`，但**不带 `--keyb-project selleros` 时仅创建服务身份，`keybProjectCodes=[]`，不能调用本项目 KeyB 扣费**。之后可按第 4.2 节补授权。

脚本成功后会输出 `appId` 和 `appSecret`，处理方式如下：

1. 用 `--list` 核对新身份的状态和项目权限；带 `--keyb-project selleros` 已在创建时写入授权，不需要再修改 SellerOS 环境变量。
2. 把同一组 **appId + appSecret** 安全交给 Skills API 后端负责人，配置到 API 后端的服务签名 Secret。API 侧环境变量名由该仓库实现决定，本仓库不约定或生成其配置项。
3. 保存 Secret 到受控凭据系统；不要在日志采集环境里创建后再把终端输出发给前端/AI。

`--list` 不提供 Secret 查询。本脚本输出“只打印一次”是脚本行为，不能理解为数据库只保存哈希：现有 OpenApiApp.appSecret 是可还原存储，用于 HMAC 验签，数据库访问和备份同样需要保护。本次没有改造原服务身份存储方式。

`appSecret` 不属于四个 SellerOS 接入环境变量：SellerOS 已在 OpenApiApp 表内保存它，Skills API 后端在自己的受控 Secret 中保存同一值，用它生成签名。

### 4.4 只撤销本项目的 KeyB 扣费权限（写 OpenApiApp 表）

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts --revoke-keyb '<实际 appId>' selleros
```

从 `keybProjectCodes` 移除 `selleros`，重复执行也安全。后续 KeyB 扣费鉴权返回 403 `SKILLS_PROJECT_FORBIDDEN`，无需重启；需要恢复授权时重新执行 `--grant-keyb`。撤权不改变 appSecret、身份状态、单笔限额、用户 KeyB 或旧开放接口权限，也不撤销已经成功的消费。项目权限校验与扣费事务分开，不能用撤权追溯取消已通过鉴权并进入扣费流程的请求。

### 4.5 紧急停用服务（写库，影响该身份全部开放接口）

```bash
node --env-file=.env -r ts-node/register scripts/create-open-api-app.ts --disable '<实际 appId>'
```

只在已确认需要停用该调用服务时执行，不是正常部署必跑步骤。它将该 OpenApiApp 标记为 `DISABLED`，也会影响使用同一身份的旧手机号开放接口。不会撤销已完成消费或清理用户 KeyB。

当前脚本支持创建（可带 `--keyb-project selleros`）、`--list`、`--grant-keyb`、`--revoke-keyb`、`--disable`、`--help`；`--help` 不连接数据库。未知选项、多余参数和非 `selleros` 项目代码会被拒绝。**没有 `--enable`、`--rotate`、`--update-limit` 或 `--dry-run`**。恢复已停用服务、修改限额或轮换服务身份应另行准备审核过的管理操作。

## 5. FeatureModule 是否需要 seed

KeyB 入口继续使用现有功能注册表。API 上报的 `source` 必须是数据库中已登记且有效的功能 key，例如业务确实使用 Listing 生成时对齐已登记的 `listing.generate`；不要因“通过 KeyB 调用”就新造一套计价 source。

- 目标环境已具备所需 source：**不用跑 seed**。
- 本次确实新增/补登记 source：先由开发核对 `src/usage/feature-module-definitions.ts`，经确认后只执行 features 任务。

```bash
node --env-file=.env -r ts-node/register prisma/seed.ts features
```

此命令写 FeatureModule 表，按现有定义 upsert；不是只读检查。已存在行会更新展示标签/目录等字段，**不会把已有 `active=false` 自动改成 true**。因此执行成功不等于所有 source 已启用；仍需核对实际使用的功能。缓存通常在一分钟内刷新。

本功能不要求执行 `membership`、`billing`、`pricing`、`models` 或其他历史迁移任务。不要无参数运行 seed 代替 features：现有无参数默认任务是 rbac。

## 6. Docker 部署注意及命令

当前 Dockerfile 已包含安装依赖、生成 Prisma Client 和构建步骤。现有默认 CMD 是：

```text
npx prisma db push --accept-data-loss --skip-generate && node dist/main.js
```

**这个默认 CMD 会写数据库并接受数据损失。本次 KeyB 发布应覆盖为只启动应用；数据库同步按第 3 节单独审核执行。** 不要用默认容器启动命令做验收，也不要通过升级旧镜像的方式反向 db:push 删除新表。

已有 Docker CI 可以沿用其构建流程；如需手动构建，令 `PACKAGES_TOKEN` 通过受控环境注入，使用已有 BuildKit Secret：

```bash
docker build --secret id=github_packages_token,env=PACKAGES_TOKEN -t selleros-api:keyb .
```

确认目标 schema 已单独同步后，以下是本机容器的启动结构示例；生产环境沿用原部署平台的端口、卷、网络和 Secret，只覆盖启动命令：

```bash
docker run -d --name selleros-api-keyb \
  --env-file /secure/selleros.env \
  -p 127.0.0.1:8000:8000 \
  selleros-api:keyb node dist/main.js
```

`/secure/selleros.env` 为占位路径，使用实际受控环境文件。Docker 的 `--env-file` 不是 dotenv：不要直接照搬带包围引号和行尾注释的模板；使用每行 `NAME=value` 的实际值，注释另占一行，否则引号/注释可能进入值并导致启动校验失败。应用若设置了不同 PORT，映射须同步调整。

Compose 可为该服务设置 `command: ["node", "dist/main.js"]`；其他部署平台设置同等的应用启动命令。本轮只提供文档，没有修改 Dockerfile、发布镜像或启动容器。

## 7. API 侧需要配合什么

发给 Skills API 后端负责人：

| 内容 | 对接要求 |
| --- | --- |
| SellerOS 扣费地址 | 本环境 SellerOS origin + `/api/open/keyb/credit/deduct` |
| 服务身份 | 已授权的 appId/appSecret，安全交付；对应 OpenApiApp 为 ACTIVE 且 `keybProjectCodes` 包含 `selleros` |
| 请求鉴权 | 用户 KeyB + `x-sign-version: v2` 服务 HMAC；绑定方法、目标路径、KeyB 哈希和原始 JSON，时钟偏差不超过 ±5 分钟 |
| 业务费用 | 真实人民币费用（六位以内十进制字符串）、登记 source、真实 model、稳定 requestId |
| 失败/重试 | 保留任务及原 requestId；扣费成功或确认重复成功后再交付产物，不重跑模型、不自动换用户/Key/服务身份 |

签名算法、Node 调用示例、返回及扣费错误码见 [服务端接口文档](./SellerOS-KeyB积分扣费接入-接口与部署.md)。这些服务签名凭证不交给前端或 MCP，MCP 也不另扣一次。

另需 API 确认签发接口返回形状。当前 SellerOS 支持 HTTP 2xx，JSON `data` 内有匹配的 `phone` 和合法 `key`，外层至少有一项明确成功标志：`code: 0/200/201`、`success: true`、`statusCode: 200/201`；出现多项时必须全部成功。实际 API 包装仍待联调核验，异常形状会进入 `SYNC_UNKNOWN`，不能靠反复签发试错。

入站代理要保持 `/api` 前缀及签名目标路径，不更改已签名的 JSON 字节。密钥接口禁缓存，APM/网关不采集 Authorization、签发及复制响应正文、KeyA、appSecret 或含凭证的原始异常。

## 8. 验证命令与上线核对

### 8.1 无真实数据库的相关回归

```bash
RUN_KEYB_DB_TESTS=0 node node_modules/jest/bin/jest.js --runInBand --testPathPatterns='skills-keys|open-api|usage/|membership/credit.service.spec|team/team.service.spec|common/filters/http-exception.filter.spec|common/utils/keyb-log-url.spec'
npm run build
```

HTTP 测试使用本机临时端口和 mock 服务，需要运行环境允许本地监听。上述 `open-api` 范围包含 `src/open-api/open-api-app-script.spec.ts` 的管理脚本参数解析及授权更新测试；若仅验证脚本，可运行：

```bash
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/open-api/open-api-app-script.spec.ts
```

脚本测试使用 mock 数据库，不执行真实 grant/revoke。本轮实际验证记录见 [服务端接口文档第 9 节](./SellerOS-KeyB积分扣费接入-接口与部署.md#91-selleros-验证记录)。测试通过不代表生产数据库已同步、旧服务已补授权或真实跨服务联调通过。

### 8.2 可选的专用 MySQL 事务测试（会写测试数据）

先获得测试库操作授权，单独准备本机 `selleros_keyb_test` 或 `selleros_keyb_test_*` 数据库及当前 schema。通过受控方式设置 `TEST_DATABASE_URL`，`DATABASE_URL` 应未设置或与其相同；测试不接受远程主机、其他库名或 URL query/hash。

```bash
RUN_KEYB_DB_TESTS=1 node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/open-api/keyb-credit.integration.spec.ts
```

测试不会为你建库或同步 schema，不读取 `.env`，会创建并清理本次测试用户/积分批次/流水。两个用例验证真实 UsageService/CreditService/MySQL 的同编号并发回滚和跨用户冲突，凭证解析仍是测试替身；不覆盖实际 KeyA 签发、全部团队资金/返利场景或多进程签发 CAS。本次未启用运行。

### 8.3 真实联调核对

在已授权的测试环境与账户下进行，不能使用真实生产余额作为冒烟测试：

1. 服务正常启动；四项全部不配时新功能禁用，完整合法配置时可用。
2. 数据库已有 SkillsKeyCredential、唯一约束和 OpenApiApp.keybProjectCodes；调用服务 ACTIVE 且已授予 `selleros`，所需 source 有效。授权/撤权后后续请求读取新权限，无需重启；无授权服务不能扣费。
3. 用测试用户通过 SellerOS 页面生成、复制、重置；状态接口不返回原 Key；旧 Key 在重置后不能通过新扣费鉴权。
4. API 服务真实自动扣费，同笔 requestId 重试不重复收费；载荷或用户不同返回冲突；错签名、未授权 appId 和停用用户被拒绝。
5. API 和 MCP 两条业务路径都使用 SellerOS 真实回执，未扣费任务不会提前暴露可使用产物。
6. 模拟签发结果未知、扣费响应丢失和 Key 轮换场景，核对失败状态与原任务保留，检查日志、代理和埋点没有凭证明文。

2026-09-08 dev（api-dev2）已部分核对：第 2 项（存量授权数据 NULL→`[]` 归一化 + `--grant-keyb` 生效，未授权服务 403）、第 3 项的生成/复制/重置与状态接口（真实签发落 ACTIVE，状态接口不返回原 Key）、第 4 项的手工模拟服务签名真实扣费（201，1 元扣 10 积分，同 requestId 重放 `duplicate:true` 不重复扣，错签名 401，UsageLog/流水与回执一致）。未核对：旧 Key 重置后不能通过新扣费鉴权、载荷/归属冲突、停用用户拒绝、API/MCP 自动衔接与产物门控（第 5 项）、故障演练（第 6 项）。

分别记录“应用代码部署完成”“数据库同步完成”“专用数据库测试通过”“API/MCP 真实联调通过”，不要互相替代。

## 9. 常见故障、停用和恢复

| 现象 | 检查方向 |
| --- | --- |
| 启动提示 `接入密钥配置无效：变量名` | 四项是否齐全；Docker env-file 是否把引号/行尾注释带入值；origin 是否误带 `/api`；主密钥是否标准 32 字节 Base64 |
| 503 `SKILLS_KEYS_DISABLED` | 四项是否未注入到实际运行进程，改完基础配置是否重启 |
| 503 `SKILLS_KEYS_UNAVAILABLE` | 当前 Prisma Client/schema 是否同步、目标库连接是否正常；不要换 operationId 自动再签发 |
| 403 `SKILLS_PROJECT_FORBIDDEN` | 前端 projectCode 是否 selleros；用 `--list` 检查 API 对应 appId 的 keybProjectCodes 是否包含 selleros。旧行默认未授权；核实后用 `--grant-keyb` 补授权，修改旧环境白名单无效 |
| 管理脚本报「接入方项目权限数据格式异常」 | 存量 OpenApiApp 行 `keybProjectCodes` 为 NULL（`db push` 不回填存量行）；先按第 4.2 节归一化为 `[]` 再执行授权 |
| 401 `OPEN_AUTH_INVALID` | appId/appSecret 对应关系、原始 JSON、KeyB 哈希、目标路径、v2 标记与时间同步 |
| 403 `OPEN_APP_DISABLED` | OpenApiApp 已停用；项目 grant 不会恢复服务状态 |
| 状态 `ROTATING` | 签发尚在处理中；继续查状态。超过 75 秒的遗留操作在读取时标记待恢复，不自动重签 |
| `SYNC_UNKNOWN` / 409 `SKILLS_KEY_SYNC_UNKNOWN` | 远端超时/异常响应或本地保存失败；用户复制和扣费均暂停，需人工核查 |
| `SKILLS_PROJECT_CHANGED` | 当前配置与旧凭证项目不同；目标配置正确时，让用户确认后用新 UUID 调 `/api/skills/keys/reset`，自动签发并更新关联，无需手工迁移数据库 |
| 503 `SKILLS_KEY_CRYPTO_ERROR` | 是否替换/丢失主密钥，实例是否配置不一致，密文或版本是否损坏；先恢复正确配置 |
| 扣费 400 功能来源未登记 | 核对 FeatureModule source 和 active；features seed 不会复活已停用行 |

生成/重置流程因签发异常进入 `SYNC_UNKNOWN` 时，HTTP 业务错误仍为 409 `SKILLS_KEY_SYNC_UNKNOWN`。新版通过 GET 状态的 `lastErrorCode` 提供固定诊断码，供运维按阶段定位，前端继续禁用操作，不按诊断码自动重签。仅「原凭证有效、项目配置变更」返回的 `SYNC_UNKNOWN` + `SKILLS_PROJECT_CHANGED` 允许用户主动确认重置：

| `lastErrorCode` | 排查方向 |
| --- | --- |
| `ISSUE_TLS_ERROR` | Skills API 入口证书链、有效期与域名校验；在 SellerOS 实际 Node.js 环境检查，见下节 |
| `ISSUE_TIMEOUT` / `ISSUE_NETWORK_ERROR` | 出站 DNS、连通性、代理及 15 秒超时；远端可能已执行，不能据此自动重签 |
| `ISSUE_HTTP_ERROR` | API 返回非成功 HTTP 状态；结合服务日志中已校验的 `upstreamStatus`，核对 `/api/v1/projects/keys` 路由、KeyA 配置及 API 服务状态 |
| `ISSUE_RESPONSE_INVALID` | 成功 HTTP 响应未符合约定包装、成功标志、手机号或 Key 格式；由两侧负责人受控核对，不能把完整响应写入日志 |
| `ISSUE_RESULT_UNKNOWN` | 历史记录、无法分类的失败或过期 ROTATING；仅此代码不足以还原原始原因 |
| `KEY_ENCRYPT_FAILED` | 已获得签发结果，但本地加密阶段失败；检查主密钥配置及实例一致性 |
| `KEY_SAVE_FAILED` / `KEY_SAVE_CONFLICT` | 本地保存失败或条件更新未取得预期结果；核对数据库可用性、操作编号和凭证 revision，不覆盖并发结果 |
| `KEY_READBACK_FAILED` / `KEY_READBACK_CONFLICT` / `KEY_DELIVERY_FAILED` | 保存后的读取、归属校验或密钥交付失败；核对当前记录与本次操作，不把失败响应当作“远端未签发” |

SellerOS 的固定日志事件 `skills_key_issue_failed` 只记录 `operationId`、`lastErrorCode`；上游异常可能额外包含已校验的数字 `upstreamStatus` 和白名单 `transportCode`（例如 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。不记录请求 URL、headers、手机号、KeyA、KeyB 或原始异常。按原 operationId 关联同次失败即可，不要求用户提供完整 Authorization 或签发响应。

这些诊断只对新版部署后实际发生的失败生效，**无法还原历史失败当时的原始错误**；已有 `ISSUE_RESULT_UNKNOWN` 不会自动补成某个新码。本轮没有为获取诊断而重放真实签发，也没有修改历史凭证行。

临时关闭本 KeyB 功能，可将四项**全部**置空并重新部署，保留数据库关联和原主密钥的受控备份。只清空一项会导致启动失败。这不会停掉其他旧开放接口；只撤销某服务的本项目权限用第 4.4 节，无需重启；如需停用调用服务本身，使用第 4.5 节并评估该身份的其他调用。

签发异常造成的 `SYNC_UNKNOWN` 不能通过普通重置接口自动恢复（仅配置变更的 `SKILLS_PROJECT_CHANGED` 按上表主动重置）。先阻止新的相关操作并确认各 worker 和远端请求已经结束，核对项目、用户及 API 当前状态；无法找回远端 Key 时，与 API 团队安排一次明确授权的轮换和本地加密凭证修复。不要删除关联行、清空操作历史或直接把旧 Key 标为 ACTIVE。本期没有签发异常恢复脚本/管理入口，具体数据修复须另行审查。

### 9.1 签发路由和 HTTPS 证书链

2026-09-08 的只读排查确认，Skills API 开发环境公开 OpenAPI 声明的签发路由为 **`POST /api/v1/projects/keys`**。SellerOS 已据此修正固定路径；环境变量仍只填 origin，不能在 `SKILLS_KEYS_API_ORIGIN` 后补 `/api/v1`。旧版 SellerOS 使用的无版本路径不符合本次核对的线上声明。

同次排查中，系统 curl 能通过 TLS，但 Node.js HTTPS 访问出现 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；服务端返回的证书链只有站点叶子证书，缺少中间证书。这说明浏览器或系统 curl 可访问，并不能证明 SellerOS 所用 Node.js 能完成证书链验证。应由 **Skills API 的网关/反向代理维护方部署完整 `fullchain`（站点证书及所需中间证书）**，随后从 SellerOS 实际容器/运行环境复核。不要使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、`rejectUnauthorized: false` 或 `curl -k` 绕过验证；SellerOS 代码保持 TLS 校验。

**2026-09-08 该故障已修复**：API 侧换发含中间证书的 DigiCert 全链证书，`openssl s_client` 复核链含叶子+中间证书、`Verify return code: 0 (ok)`，SellerOS 运行环境 Node.js 检查通过；同日 dev 完成真实签发（reset 落 ACTIVE）与扣费联调。后续证书续期/更换仍须保留下发完整链。

以下命令只 GET 公开 OpenAPI 文档，不携带 KeyA，不签发或重置 KeyB，也不输出响应正文。先确认 `.env` 的 origin 指向待排查环境；在已注入环境变量且没有 `.env` 的容器内，去掉 `--env-file=.env`：

```bash
node --env-file=.env <<'NODE'
const https = require('node:https');
const origin = process.env.SKILLS_KEYS_API_ORIGIN;
if (!origin) throw new Error('缺少 SKILLS_KEYS_API_ORIGIN');
const request = https.get(new URL('/docs-json', origin), response => {
  console.log('TLS 验证成功，HTTP 状态：', response.statusCode);
  response.resume();
});
request.setTimeout(10000, () => request.destroy());
request.on('error', error => {
  console.error('TLS/连接检查失败：', error.code || 'REQUEST_FAILED');
  process.exitCode = 1;
});
NODE
```

TLS 成功后仍须检查文档 HTTP 状态和声明的签发路径；文档 GET 的成功不验证 KeyA、手机号校验、真实签发返回或本地保存。**只读 GET 路由/TLS 取证不等于真实签发联调。** 本轮没有执行实际签发、数据库恢复或余额操作。

**发布路径修复、补齐证书链不会自动解除历史 `SYNC_UNKNOWN`。** 历史记录仍按本节人工恢复流程核对，普通生成/重置请求会继续被保护性拒绝，不能用换 operationId、删除关联行或直接改为 ACTIVE 绕过。应在基础故障修复并确认远端状态后，再单独审核恢复方案。2026-09-08 dev：证书修复后受影响凭证已恢复 ACTIVE 并完成真实重新签发（reset），无遗留 `SYNC_UNKNOWN` 行。

回滚应用时保留新表、历史操作、消费日志和匹配的主密钥，不跑旧 schema 的数据损失同步。任何待扣业务继续保留原 requestId 和服务身份，不能通过换编号把不确定结果变成第二次消费。

## 10. 本次必须执行与无需执行的动作

| 动作 | 是否需要 |
| --- | --- |
| 安装依赖、生成客户端、构建 | 发布新后端代码需要；Docker 构建已经执行时不用在运行容器中重复做 |
| `npm run db:push` | 目标环境尚未同步本次新表或 OpenApiApp.keybProjectCodes 新列时需要，经确认单独执行 |
| 创建 OpenApiApp | 没有可用的 Skills API 服务身份时需要一次；后续发布复用 |
| `--grant-keyb '<实际 appId>' selleros` | 已创建过 Skills API 或从旧版升级时，对获准的现有服务逐个执行；不重建身份，不改密钥。新建时带 `--keyb-project selleros` 已写授权，无需重复执行。若报「数据格式异常」，先按 4.2 节归一化存量 NULL 行 |
| 生成加密主密钥 | 每个新环境首次配置一次；后续发布保持原值 |
| features seed | 仅当需要补登记/更新所需 source 时执行 |
| 领取 API 项目 ID/KeyA，配置四项 | 首次启用需要；必须与环境、项目一致，旧版升级保持原值 |
| 用户生成 KeyB | 由用户页面按需执行，不作为批量部署脚本 |
| 全量 seed、会员/团队历史迁移、充值或调账脚本 | 本次不需要 |
| 专用数据库及真实跨服务联调 | 另行授权后完成；未通过前不能声称端到端收费已验收 |
