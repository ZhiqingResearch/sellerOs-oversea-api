# Listing 历史一键优化实际联调

这组测试使用功能分支的 Next HTTP 路由、Nest 控制器（JWT/权限/DTO 校验）、后台任务与现有计费服务，以及真正的 MySQL 事务。未启动完整业务应用和无关定时任务。文档分析与独立评分控制器的未调用依赖以空对象占位；优化、自动评分、History、UsageService、CreditService 均执行真实代码。

- `controlled.cjs`：仅替换 AI 网关响应，定向注入降分、断流、扣费写入后事务失败。核对余额、UsageLog、CreditTransaction、正文、任务数和模型调用次数。
- `live.cjs`：调用已配置的真实 AI 网关，先真实评原文，再通过 Next 优化并评分。成功时核对真实新分不低于旧分、实扣 5 积分（包含自动评分）；失败时核对原文保留且 0 扣费。不会强行要求模型提升，更不会修改模型评分。
- 本地测试钱包由脚本创建并发放 1000 测试积分；不会向业务环境创建用户或发积分。AI 上游真实调用仍会消耗网关额度。

准备一套仅监听 `127.0.0.1` 的空 MySQL，库名必须是 `listing_optimization_test` 或以该名称加下划线后缀。按仓库约定将**现有** schema 同步到此测试库（不要使用业务库）。然后构建后端，在另一个终端启动前端分支：

```powershell
$env:DATABASE_URL = 'mysql://root:TEST_PASSWORD@127.0.0.1:13316/listing_optimization_test'
npx prisma db push --skip-generate
npm run build

# 在前端功能 worktree 中执行
$env:API_BASE_URL = 'http://127.0.0.1:18015'
npx next dev --webpack --hostname 127.0.0.1 --port 14387
```

回到后端 worktree 执行（两个测试入口顺序运行，后端端口固定 18015）：

```powershell
$env:LISTING_TEST_DATABASE_URL = 'mysql://root:TEST_PASSWORD@127.0.0.1:13316/listing_optimization_test'
$env:LISTING_TEST_WEB_ROOT = 'D:\path\to\frontend-feature-worktree'
$env:LISTING_TEST_WEB_URL = 'http://127.0.0.1:14387'
node test/listing-optimization/controlled.cjs

# 真实 AI 测试只读取以下文件中的 AI_GATEWAY_API_KEY / AI_GATEWAY_BASE_URL
$env:LISTING_TEST_GATEWAY_ENV_FILE = 'D:\path\to\configured-backend\.env'
node test/listing-optimization/live.cjs
$env:LISTING_TEST_SAMPLE = 'low'
node test/listing-optimization/live.cjs
```

每次创建独立测试用户与记录，输出保存在 `.tmp/listing-optimization-integration/`。脚本不清理已有数据库。测试完成后关闭专用 MySQL 和前端进程；测试产物保留原始 AI 响应与对账证据，但不写入 API Key 或 JWT。
