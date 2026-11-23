# 成功生成记录快照

海外版在业务成功后向 `GenerationRecord` 写入快照，并在 `UsageLog(source, createdAt)` 增加回填索引。列表、汇总和模型筛选默认沿用旧读取路径。完成历史回填和对账后，将 `GENERATION_RECORD_READ_MODE` 设为 `unified` 并重启应用即可切换。

## 最终业务口径

依据用户最后两次确认：**只记录成功业务操作；成功后快照不再改变。再次成功优化并产生新消费是新事件、新记录。** 原方案中的“ASIN 两阶段累计覆盖”“雷达只保留最新刷新”“删除时同步汇总”均已取消。

- 不记录进行中、失败、取消、孤立 BILLED 扣费。真实费用未知为 `null`，明确免费为 `0`，已知积分保留 Decimal(18,4)，不从人民币反推费用。
- 同一业务成功事件的回调、重放或回填通过 `(sourceType, sourceId, operation)` 去重，已经存在时不更新任何快照字段。业务编辑、删除、部分产物移除、退款、目录改名都不更新已保存快照，也没有相应同步钩子。
- 本文的“重试”指同一成功事件重放；RPA 重试失败输出后**新产生成功结果和新扣费**，按新的成功输出批次记录。
- 正文继续留在业务表；不承诺源正文被删除后可以恢复。已有详情权限和删除判断保持原样；列表保留成功时的元数据和预览快照。详情仍仅支持文本，不加 14 天限制。
- 用户名称、手机、组织、角色实时读取。模型 publicId 和真实目录展示名在写入时拍快照；不把 `fixed-module` 或任意 code 当展示名。目录缺失保留 null，RPA 仅使用其已注册的静态模型目录作为可信补充。

覆盖原有 14 功能：IMAGE、VIDEO、INSPIRATION_RADAR、ASIN_EVIDENCE、ASIN_AUDIT、COMPETITOR_ANALYSIS、LISTING_GENERATION、LISTING_SCORING、CATEGORY_ANALYSIS、PRODUCT_SELECTION（仅 PRODUCT 入口）、SMART_PRICING、PROMOTION_PLAN、VIDEO_ANALYSIS、CHETAIDOU_TEXT。vidflowos 与 platform 隔离；CROP 不计入；车泰斗 GENERATE 仅属于 IMAGE。

## 事件身份和正文

| 来源 | 事件身份/说明 |
|---|---|
| 普通图片、视频、分镜、美妆 | 原任务 ID；业务终态成功且结果已保存时写入 |
| 拆图 | groupId（历史空组退化 task:id）；按方向席位合并，不按图片制造行 |
| ImageGenJob | jobId；归档时若已有成功 IMAGEGEN 快照则保持，归档任务不再复制一份费用。历史仅归档任务可恢复时使用 IMAGE 身份 |
| ASIN 证据 | `TEXT:ASIN_EVIDENCE:{reportId}`，证据和本次费用一行 |
| ASIN 打分 | `TEXT:ASIN_AUDIT:{reportId}:score`，固定评分快照 |
| ASIN 每次优化 | `TEXT:ASIN_AUDIT:{reportId}:revision:{revisionId}:optimize`，正文精确指向该 revision；相同正文再次独立收费保留同一 revision，额外事件 key 为 `...:revision:{revisionId}:event:{usageLogId}:optimize`，费用逐笔分开；费用优先明确 revisionId，再匹配结果 hash，旧数据仅全用户同阶段窗口双向唯一才用时间邻近，绝不均摊报告累计费用 |
| Listing 每次成功任务 | `TEXT:LISTING_GENERATION:{historyId}:task:{taskId}`，正文读取该任务已保存的结果和自动评分；采纳优化独立扣费、独立记录。A/B 同一计费标识证明已经扣过的任务可明确为 0，不能重复分摊原费用 |
| 旧 Listing 无任务 | `TEXT:{TYPE}:{historyId}:revision:{historyRevisionId}`，指向固定 HistoryRevision，不随 History.data 编辑改变 |
| RPA 成功输出批次 | `RPA_IMAGE/VIDEO:{taskId}:event:{usageLogId}`，按明确 successfulOutputIds 取本批成功结果和该笔 UsageLog；全失败不记录 |
| 雷达每次成功刷新 | `INSPIRATION_RADAR:{subscriptionId}:refresh:{lastRefreshedAt毫秒}`，每次独立成功刷新一行。原始 API id 仍为订阅数字 ID |
| 竞品运行/归档 | 已有成功 TEXT_RUN 快照时保留；后续归档不再复制费用 |
| 车泰斗文本 | BREAKDOWN/IDEATION/REFRESH_GROUP/DIVERGE/COMPOSE；根任务成功时合并其重试调用费用，重试任务不重复列出；PARTIAL 文本不作为全部成功。图片 PARTIAL 按已有可交付成功图片口径归 IMAGE |

旧文本 key 详情仍可用。新增 key 是不透明标识，前端应完整传给原详情接口，不截取 UUID 或自己拼接阶段；新 key 列表里的 id/recordId 继续提供原业务父 ID。

## 写入和费用完整性

成功钩子显式位于原业务成功保存/结算方法末尾，必须在原业务事务提交之后调用：`recordGenerationSuccess` 仅接受根 PrismaClient，使用独立短事务，任何投影/写入/超时异常只记录具体 source/id，不向业务抛出，不回滚已完成的业务或扣费。调用方等待本次写入尝试结束，仍会有额外查询耗时。只读取一个明确实体或拆图组，费用匹配复用原有严格业务标识；媒体 SQL 额外带 taskId/jobId/groupId，绝不扫描用户全历史后 JS 猜匹配。没有全局 Prisma 中间件、事件总线、队列表、请求时补跑全量回填。

竞品的服务端自动归档先只保存正文，待真实结算完成才首次建快照；无运行号或非 UUID 运行号也用明确 reportId + 真实扣费返回值捕获，禁止先冻结 null 再丢失后续实扣。车泰斗复用现有 ChetaidouCall 的 SETTLED/chargedCredits 或 FREE 作为真实结算证据，尚未完成的调用不会被当作零元或部分合计。

ASIN 审计在线成功保存直接使用固定模型 `ZQ-Multimodal-Gemini-3.8-Flash` 和阶段一口价（评分 20、每个优化版本 15），不再依赖归档正文的 hash 或请求号关联扣费流水；正文仍读取原评分快照/优化版本。Listing 独立打分在结算提交后直接传入账单实际模型和对应 UsageLog 的实扣积分（含明确 0）。历史回填、已有成功快照的不覆盖规则、详情接口和前端入参保持原样。

网关、固定模块、RPA、ASIN 等在原业务保存/真实扣费事务提交后创建快照，不更改扣费路由、金额、幂等或退款行为。多产物生图原本先保存结果再独立扣费，不能在第一笔扣费到达时冻结部分费用。因此仅复用原 JSON 存内部证据：`ImageGenItem.gatewayImage.generationRecordCredits`、`GeneratedImage.deliveryMeta.generationRecordCredits`。证据写入失败也只记日志，不把成功图片改成失败。

- 缺字段：尚未确认或历史无证据，不能据此冻结部分费用。
- 明确 null：结算尝试已结束但费用未知/扣费失败；成功结果的积分快照可保留 null。
- 数字字符串（含 `"0"`）：真实扣费返回值或已确认免费。重复扣费幂等返回的真实 credits 仍是有效证据。
- 原有精确 gatewayTaskId 台账也可证明该成功图已完成结算。全部成功图具有证据后才首次入表；后续 aggregate 重放不会覆盖记录。
- 这些字段为内部结算证据，公开图片元数据响应会剔除。任务级 token 批量扣费的证据仅表示该批已结算，最终总额仍读一次真实 UsageLog，不重复累加每个图片证据。

不在资金事务内从 UsageLog 创建反向锁业务来源，避免钱包锁与来源锁顺序反转。生成/扣费没有因本次需求新增自动重试。写入失败或提交后进程退出可能缺少生成记录，应按日志 source/id 或现有回填脚本补建；没有自动保证最终写入。不得重新调用 AI 或重复扣费来“修复生成记录”。手工回填的 `--apply` 仍显式报错并中止，不吞掉脚本错误。

## 部署顺序（用户执行）

先同步结构、启用成功写入并回填，再切新读。保留原始业务表和台账，不跑 migrate。

回填命令在已安装开发依赖（ts-node/TypeScript）的源码目录运行，并核对目标 `.env` / `DATABASE_URL`。只有 dist 或只安装生产依赖的运行镜像不一定包含脚本和 ts-node，不能直接假定任意生产容器都可执行。

### 回填索引精简方案

仅按需补 **1 项** `UsageLog(source, createdAt)`，见 [精简后的查询索引 SQL](../../scripts/sql/generation-record-backfill-indexes.sql)。脚本启动时按前导列检查；已有 `(source, createdAt)`、`(source, createdAt, id)` 等等价索引会直接复用，不要求固定索引名称，也不重复创建。完全缺少时才需手工执行 SQL。上一版 27 项全覆盖方案已取消；本文件不生成任何 DROP 语句，也不删除数据库已有索引。

这一项索引支持按日期查询 ASIN 流水入口：相同正文再次优化可能不产生新 revision，必须从近期明确报告/版本 ID 的流水反查旧报告，不能只依赖子表创建时间，否则会漏掉新消费事件。没有 source 领先索引时，这一步需要扫描全局账本，因此保留。建索引本身会一次性读取已有数据，由部署人员执行，本次开发不运行 DDL。

- 业务表不再新增时间索引，也不统一强制索引：普通来源直接按主键断点分页，不额外包一层全量去重排序；ImageGenJob、车泰斗创建时间入口加成功状态条件，复用已有 `(status, createdAt)` 索引，具体选择由优化器决定。
- ASIN、Listing 保留子表反查旧报告，复用 `recordId`、`listingRunId`、主键和已有外键索引。每个候选分支先加断点、按父 ID 去重和限量，再合并分页，避免重复父 ID 把后续事件挤出分页而漏记。
- 精确历史积分关联复用 `UsageLog(userId, createdAt)` 的用户前缀、主键和 requestId 唯一索引；雷达复用 CreditTransaction 用户/关联用户索引，不加新的资金表字段或索引。
- 拆图组锁显式带上 `userId + generationMode + groupId`，复用已有 `GenerationTask(userId, generationMode, groupId)`，不新增组索引。
- 积分关联不硬截断到 7 天：旧的明确关联流水仍可查询，不因延迟保存漏费；回填只写入发生在指定日期范围内的成功事件。ASIN 保持明确 revisionId/结果 hash 优先，旧流水时间邻近仍须同用户同阶段双向唯一；不猜金额、不均摊费用、不放宽规则。
- 小表及现有索引不能直接覆盖时间条件的查询仍可能扫描更多候选行；JSON 历史关联可能检查该用户较多流水。此次优先减少长期索引维护成本，不承诺所有业务表均无全表扫描；新增其他索引应以目标库规模和 EXPLAIN 为依据。

```bash
# 1. 在目标环境核对 DATABASE_URL 后执行；本项目唯一的 schema 同步方式
npm run db:push
npx prisma generate

# 2. 部署本版，暂设 GENERATION_RECORD_READ_MODE=legacy，重启应用
#    此阶段仍旧读，成功业务已同时写入新表。

# 3. 为每个历史分段设置实际起止时间（完整 ISO 时间），预览记录数和费用。
npm run backfill:generation-records -- --dry-run --from "${FROM:?设置本段起点}" --to "${TO:?设置本段终点}"

# 4. 使用相同的起止时间写入该段，再处理下一段，直至覆盖海外原有历史。
npm run backfill:generation-records -- --apply --from "$FROM" --to "$TO"

# 5. 核对各功能/事件数、未知费用和成功快照费用后
#    设 GENERATION_RECORD_READ_MODE=unified，重启切新读。
```

CLI 支持 `--function`（14 个功能之一）、`--from`/`--to`（建议完整 ISO 时间）、`--batch-size 1..1000`、`--concurrency 1..8`（默认 4）、`--cursor source:id`。省略起点时预览最近 7 天；显式传入起点可回填更早历史。结束时间最高为当前时间。支持按日期分段和游标续跑。

回填按页批量读取关联数据，默认每页 100 个候选根任务：媒体和一般文本功能每页调用一次原映射流程（BusinessAiRun 按两个功能分组），不执行列表 count；图片成功数量按 taskId 分组统计。ASIN 的评分/版本/积分、Listing 的运行/任务/版本/积分、RPA 的输出批次/积分/用户也分别按页读取。模型目录在页内复用。拆图同组跨页复用结果；极少数跨用户 groupId 重名时按用户分开映射，避免旧聚合逻辑混组。

图片与 ImageGenJob 的普通生图费用、拆图阶段费用及结算证据复用一份页面流水。查询显式限定用户及 taskId/jobId/groupId 引用，继续读取准确关联所需的历史流水。复用时分别保留每个费用分支的来源条件，不把拆图规划费、车泰斗费用混入普通生图；无法识别的额外条件仍执行原精确查询，不忽略筛选条件。图片结算校验不再重复读取同一页台账。

`--dry-run` 和 `--apply` 使用相同的页投影。每页的根记录、结果、台账和模型目录在同一个 RepeatableRead 只读事务快照内读取，避免刚好有新结算时混读前后两套数据；候选 ID 查询仍在事务外按原断点分页。只读事务不执行业务行锁或写语句，等待/执行超时均为 30 秒。正式执行在读取事务完成后，通过独立短事务逐事件 upsert，不再在每个写事务里重查业务来源、结果和台账，也不逐任务锁源业务表；已完成业务与扣费不被修改。upsert 的 update 为空，统计使用返回的真实冻结积分，即使在线成功钩子并发抢先保存，也不会覆盖或拿新的投影金额冒充旧快照。非成功或无有效事件的来源不进入写事务。

每页仍先批量查询普通图片、ImageGenJob、视频、分镜、美妆已保存的固定快照，命中后直接使用冻结积分，不再查询台账或写入。归档图片和竞品运行的跨来源去重也按页读取。ASIN、Listing、RPA、雷达、车泰斗等多版本/多批次来源不按父 ID 跳过，避免遗漏新事件。每组默认最多并发 4 个写入事务，`--concurrency 1` 可降低写入并发；页内关联读取按数据依赖进行少量并行查询，`--batch-size` 控制候选及关联批量大小。数据库/网络较弱时可先使用下列较小分页预览：

```bash
npm run backfill:generation-records -- --dry-run --batch-size 50 --concurrency 1
```

积分始终按同用户、同功能及明确 taskId/jobId/groupId/运行号/版本号/扣费 ID 关联，批量获取不会改成按用户或时间均摊。ASIN 的旧时间近邻仍核对全用户同阶段的 10 秒窗口，包含当前页之外的报告；无法证明唯一时保留 null。只保留窗口内的成功事件，但精确关联的历史流水和旧报告版本不硬截断到 7 天。

```bash
npm run backfill:generation-records -- --dry-run --from 2026-11-04T00:00:00+08:00 --to 2026-11-05T00:00:00+08:00
npm run backfill:generation-records -- --apply --function ASIN_AUDIT --cursor asinAuditRecord:报告UUID
```

页内关联数据全部读取成功后，每组处理完成即输出 `cursor`，无需等待整页写入结束。页面读取失败会标明来源和本页 firstId，且整页不会进入后续写入或推进断点；写入失败会等本组其他操作结束后报错，不推进失败组断点。断点从该源最后成功 ID 之后继续，并继续后续来源。重跑不会覆盖已经冻结的记录。ASIN 查询包含老根报告的近期 revision；Listing 包含老 History 的近期成功任务；RPA/车泰斗也涵盖近期成功完成的旧任务。

脚本的只读操作遇到 `P1017`（服务端关闭连接）或 `P1001`（无法连接数据库，包含查询错误和初始化错误）时，分别等待 500ms、1000ms，最多重试两次，并输出 `event: read-retry`、查询位置 `context` 和重试次数。页面读取失败时重试整个只读事务，建立新的读取快照，不在已经断开的事务中继续查询。重试不推进断点、不重复累加统计；持续断线仍报错停止，不跳过记录。其他只读错误不自动重试。可先用 `--concurrency 1` 降低写入并发，从最后一条成功进度的 `cursor` 继续；不要直接使用失败记录 ID，否则会跳过它。恢复运行的统计仅覆盖断点之后的数据。若持续在相同查询断线，需要检查目标数据库/代理日志，重试不能替代服务端原因排查。

如果页面只读事务出现 `P2028`，且候选数大于 1，脚本立即将当前批次减半（例如 50→25→12），输出 `event: page-resize`、`previousBatchSize`、`batchSize`。断点保持在上次成功位置，使用新的较小批次和新事务重读；当前来源后续页沿用该大小，不重复执行已完成页。已经缩到单条时，最多再重试两次，仍失败则报错停止；不会跳过任务或把错误当零积分；写入事务的 P2028 仍报错停止。其他来源重新使用命令指定的批量大小。此处理保留页面读取的一致性，不能据 `P2028` 单独断定目标环境是事务超时还是连接失效。

回填写入事务只保存 `GenerationRecord`，遇到 P1017/P1001 时等待 500ms、1000ms，最多重试两次，每次开启新事务，并输出 `event: write-retry` 及具体 source/id。重复使用同一页已核对的结果，不重新查账、调用 AI 或执行扣费。唯一键 `(sourceType, sourceId, operation)` 加 upsert 的空 update 保留已有快照；即使上次提交成功但响应丢失，重试也复用已保存的记录，统计采用返回的冻结积分，不重复累加失败尝试。多事件来源整体事务重试，持续断线和非连接类写入错误仍报错停止，失败组不推进断点。恢复时使用最后成功输出的 cursor，不要把失败 id 当作断点跳过。

输出 `scanned` 是源实体扫描数，`successful/written` 是成功候选/幂等处理数（包括直接命中已有快照，同组/根可能重复，不是实际新增行数）；`distinctResults`、`knownCredits`、`unknownCredits` 按事件 key 去重并增量统计，避免每输出一次进度就重新遍历累计结果。apply 的金额取真实保存或已有的冻结快照，不能用退款后的新投影金额冒充历史快照。dry-run 展示来源候选，不读取目标记录表、不锁行、不触发任何写语句。

## 历史边界和回滚

- 历史缺正文、实际目录模型或准确台账关联时不伪造。历史孤立扣费不入表，也不声称恢复所有历史生成操作。
- 雷达原表只保留最新刷新结果；本次上线前的更早刷新无法从台账单独证明保存成功，回填仅恢复可证明的最新成功刷新。新刷新会逐次留快照。
- 旧 RPA 缺成功输出批次标识时不制造批次，最多保留可证明的任务级成功结果，金额无法唯一确认则 null。
- 退款/删除/修复历史台账不改变已冻结记录。若确需更正既有快照属于单独审计操作，不由脚本重跑悄悄覆盖。
- 回滚查询：设置 `GENERATION_RECORD_READ_MODE=legacy` 并重启，继续成功写入；不要删表、不要改历史钱包余额。旧读会恢复旧的状态/累计口径，与新成功事件快照不是逐行完全相等。
- API 路径、JWT + company.admin、DTO、原样 JSON 包装保持；列表及模型选项均支持完整历史，同一请求同一 now/where，数据库分页及全筛选集 count/sum。正文源删除后的可用性仍由原业务详情决定。
