-- AuditLog timeline: replace the (entityType, entityId) index with a
-- composite that also covers ORDER BY createdAt DESC. Strict superset of
-- the old index — prefix queries (entityType, entityId) still hit it.
DROP INDEX "AuditLog_entityType_entityId_idx";
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx"
  ON "AuditLog"("entityType", "entityId", "createdAt" DESC);

-- Notification feed: same (recipientUserId, createdAt) columns, but flip
-- to DESC so recent-first queries do an in-order index scan instead of
-- reverse-scanning. Index name unchanged (same column tuple).
DROP INDEX "Notification_recipientUserId_createdAt_idx";
CREATE INDEX "Notification_recipientUserId_createdAt_idx"
  ON "Notification"("recipientUserId", "createdAt" DESC);
