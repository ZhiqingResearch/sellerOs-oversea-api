-- 精简版：仅补这一项索引，不新增字段、不回填、不扣费。
-- 用途：按功能和时间读取近 7 天 ASIN 流水，识别旧报告再次优化的成功事件。
-- 精确历史积分关联继续复用已有 UsageLog(userId, createdAt) / 主键 / requestId 唯一索引。
-- 仅在没有 source, createdAt 领先的等价索引时执行；已有 (source, createdAt, id) 也可直接复用，不要重复创建。
-- 本文件不删除任何已有索引。建索引会一次性读取历史数据，由部署人员执行。
CREATE INDEX `UsageLog_source_createdAt_idx` ON `UsageLog` (`source`, `createdAt`);
