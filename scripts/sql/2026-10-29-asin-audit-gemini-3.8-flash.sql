-- 先部署 Gemini 3.8 Flash 固定积分识别代码，再执行本脚本。
-- 取证5 / 打分20 / 优化15由 AsinAuditBilling 按阶段扣费，fixedCredits应为NULL。
-- 复用当前库已核实的 CHETAIDOU_MULTIMODAL 模型配置；仅修改 ASIN_AUDIT 目录。
-- 如果源模型配置不存在/不可用且目标未启用，不会停用其他审计模型。

START TRANSACTION;

INSERT INTO AiGatewayModel (
  publicId, category, displayName, modality, execMode,
  gatewayConfig, quoteConfig, priceMultiplier, fixedCredits,
  gatewayActive, syncedAt, enabled, sortOrder, createdAt, updatedAt
)
SELECT
  publicId, 'ASIN_AUDIT', displayName, modality, execMode,
  gatewayConfig, quoteConfig, 1, NULL,
  gatewayActive, syncedAt, 1, 0, NOW(3), NOW(3)
FROM AiGatewayModel
WHERE publicId = 'ZQ-Multimodal-Gemini-3.8-Flash'
  AND category = 'CHETAIDOU_MULTIMODAL'
  AND modality = 'TEXT' AND execMode = 'SYNC'
  AND enabled = 1 AND gatewayActive = 1
ON DUPLICATE KEY UPDATE
  displayName = VALUES(displayName),
  modality = VALUES(modality),
  execMode = VALUES(execMode),
  gatewayConfig = VALUES(gatewayConfig),
  quoteConfig = VALUES(quoteConfig),
  fixedCredits = NULL,
  gatewayActive = VALUES(gatewayActive),
  syncedAt = VALUES(syncedAt),
  enabled = 1,
  sortOrder = 0,
  updatedAt = NOW(3);

-- 只有目标模型已启用且可用，才停用 ASIN_AUDIT 中其余模型。
UPDATE AiGatewayModel AS previous
JOIN AiGatewayModel AS target
  ON target.category = 'ASIN_AUDIT'
  AND target.publicId = 'ZQ-Multimodal-Gemini-3.8-Flash'
  AND target.modality = 'TEXT' AND target.execMode = 'SYNC'
  AND target.enabled = 1 AND target.gatewayActive = 1
SET previous.enabled = 0, previous.updatedAt = NOW(3)
WHERE previous.category = 'ASIN_AUDIT'
  AND previous.publicId <> target.publicId
  AND previous.enabled = 1;

COMMIT;

-- 预期仅 Gemini 3.8 Flash 的 enabled=1；刷新前端模型目录后选用新publicId。
SELECT publicId, displayName, category, enabled, gatewayActive, fixedCredits
FROM AiGatewayModel
WHERE category = 'ASIN_AUDIT'
ORDER BY sortOrder, id;
