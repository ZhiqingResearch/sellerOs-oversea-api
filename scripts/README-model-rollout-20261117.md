# 本会话模型上线脚本（2026-11-17）

入口：`scripts/rollout-session-models-20261117.mjs`。价格清单在同目录的 `.config.json`。

共 10 个模型、25 条类别配置、28 条视频成本。不包含 Gemini Omni 1.1，也不修改目标库已有的 Gemini 1.1 配置。

## 图片一口价

单位：积分/张。两个普通类别为 `IMAGE_GENERATION`、`PORTRAIT`；AI 拆图为 `AI_SPLIT`，包含分析费。图片倍率统一为 1。

| publicId | 普通生图/人像 | AI 拆图 |
|---|---:|---:|
| `gpt-image-2.6-flare` | 15 | 30 |
| `gpt-image-2.6-sunburst` | 15 | 30 |
| `byteplus-seedream-5-0-flash` | 5 | 15 |
| `byteplus-seedream-5-0-pro` | 10 | 20 |
| `byteplus-seedream-5-0-lite` | 5 | 15 |

Dola Pro 的 AI 拆图按最后确认的价格清单接入并启用，最多参考图数量以目标网关最新能力为准。

## 视频倍率与成本

5 个视频模型均接入 `NORMAL`、`REFERENCE`，**倍率全部为 1.5**。视频成本保存原始元/秒数值，不预乘倍率；`creditsPerSec=NULL`、`costPerRequest=false`，实际按网关账单 × 1.5 结算。

`gemini-omni-1.2-flash`：

| 分辨率 | NORMAL 通配 | REFERENCE 通配 | REFERENCE / video_to_video |
|---|---:|---:|---:|
| 360p | 0.1780 | 0.3285 | 0.2305 |
| 720p | 0.4983 | 0.6389 | 0.5519 |
| 1080p | 0.7422 | 0.8852 | 0.7971 |
| 4k | 1.4900 | 1.1612 | 1.5243 |

以下成本在 NORMAL、REFERENCE 两类相同，`mode=''` 为通配：

| publicId | 480p | 720p |
|---|---:|---:|
| `byteplus-seedance-2-0-mini` | 0.288 | 0.576 |
| `byteplus-seedance-2-0-fast` | 0.432 | 0.864 |
| `byteplus-seedance-2-5` | 0.7416 | 1.6632 |
| `byteplus-seedance-2-0` | 0.504 | 1.08 |

## 执行

在项目根目录运行，使用线上环境配置或线上进程已注入的环境变量。不要把本地 UAT `.env` 当成生产配置。

环境变量：`DATABASE_URL`、`AI_GATEWAY_BASE_URL`、`AI_GATEWAY_API_KEY`。依赖项目已安装的 Prisma Client 和 AI Gateway SDK；部署需先完成现有 schema 的同步及 Client 生成，本脚本不变更表结构。

先预览，检查输出的目标数据库、网关、价格及启用状态：

```bash
node --env-file=/path/to/production.env scripts/rollout-session-models-20261117.mjs --dry-run
```

正式执行：

```bash
node --env-file=/path/to/production.env scripts/rollout-session-models-20261117.mjs --apply
```

线上环境变量已注入时，省略 `--env-file` 即可。没有 `--apply` 时只预览。

脚本先从目标网关读取全部模型的 detail、requestSchema 和 pricing，任一模型缺失、模态或定价不符时不写库。正式写入使用一个事务，并在事务内及提交后回读验证。

写入事务上限为 5 分钟，逐条 upsert 只返回 ID，避免反复传输较大的模型能力 JSON。若提交前发生事务超时或其他写入/验证错误，整个写入事务回滚，可修正后重复执行。提交后回读失败则需先核对库中状态，不能据此判断已回滚。

按复合唯一键 upsert，可重复执行，不产生重复记录。已有行保留排序，新增行使用清单排序。明确同步清单内的价格、启用状态、倍率及最新网关能力，不修改清单外模型/类别、局部重绘、车泰斗、AI 拆图分析模型或用户数据；不调用真实生成接口。清单外的视频成本档不删除。

验证：

```bash
node --test scripts/rollout-session-models-20261117.test.mjs
```
