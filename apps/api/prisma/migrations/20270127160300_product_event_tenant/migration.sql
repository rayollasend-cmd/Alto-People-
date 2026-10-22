-- Brief 2-1: ProductEventDaily carries a tenantId like the other platform telemetry
-- rollups (RouteUsageDaily, WebVitalDaily): nullable, no default, indexed.
ALTER TABLE "ProductEventDaily" ADD COLUMN "tenantId" UUID;
CREATE INDEX "ProductEventDaily_tenantId_idx" ON "ProductEventDaily"("tenantId");
