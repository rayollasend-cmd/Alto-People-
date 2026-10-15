-- Brief 2-2 step 2 — labor rule sets: the shipped packs (tenantId NULL,
-- read-only) and each tenant's and site's overrides. Additive; nothing reads
-- it for pay (the engine runs in shadow from step 3, pays from step 4 after
-- the owner signs).

-- CreateTable
CREATE TABLE "LaborRuleSet" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "jurisdiction" VARCHAR(60) NOT NULL,
    "level" VARCHAR(10) NOT NULL,
    "siteId" UUID,
    "effectiveFrom" DATE NOT NULL,
    "version" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "source" VARCHAR(1000) NOT NULL,
    "sourceDate" DATE NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
    "approvedByUserId" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "approvalNote" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LaborRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LaborRuleSet_tenantId_status_idx" ON "LaborRuleSet"("tenantId", "status");

-- CreateIndex
CREATE INDEX "LaborRuleSet_jurisdiction_effectiveFrom_idx" ON "LaborRuleSet"("jurisdiction", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "LaborRuleSet" ADD CONSTRAINT "LaborRuleSet_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborRuleSet" ADD CONSTRAINT "LaborRuleSet_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The shapes the engine relies on.
ALTER TABLE "LaborRuleSet" ADD CONSTRAINT "LaborRuleSet_level_check" CHECK ("level" IN ('FEDERAL', 'STATE', 'CITY', 'TENANT', 'SITE'));
ALTER TABLE "LaborRuleSet" ADD CONSTRAINT "LaborRuleSet_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED'));
-- A pack has no tenant; an override always has one. A site override names its site, nothing else does.
ALTER TABLE "LaborRuleSet" ADD CONSTRAINT "LaborRuleSet_owner_check" CHECK (("level" IN ('TENANT', 'SITE')) = ("tenantId" IS NOT NULL));
ALTER TABLE "LaborRuleSet" ADD CONSTRAINT "LaborRuleSet_site_check" CHECK (("level" = 'SITE') = ("siteId" IS NOT NULL));
-- ACTIVE needs a named approver (owner's decision 10).
ALTER TABLE "LaborRuleSet" ADD CONSTRAINT "LaborRuleSet_approval_check" CHECK ("status" <> 'ACTIVE' OR "approvedAt" IS NOT NULL);

-- One version number per pack and date; one ACTIVE set per pack and date.
CREATE UNIQUE INDEX "LaborRuleSet_pack_version_key" ON "LaborRuleSet"("jurisdiction", "effectiveFrom", "version") WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX "LaborRuleSet_pack_active_key" ON "LaborRuleSet"("jurisdiction", "effectiveFrom") WHERE "tenantId" IS NULL AND "status" = 'ACTIVE';
-- One ACTIVE tenant-wide override per tenant and date; one ACTIVE override per site and date.
CREATE UNIQUE INDEX "LaborRuleSet_tenant_active_key" ON "LaborRuleSet"("tenantId", "effectiveFrom") WHERE "tenantId" IS NOT NULL AND "siteId" IS NULL AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "LaborRuleSet_site_active_key" ON "LaborRuleSet"("tenantId", "siteId", "effectiveFrom") WHERE "siteId" IS NOT NULL AND "status" = 'ACTIVE';

-- The shipped packs (scripts/labor-packs-sql.ts), DRAFT until counsel signs.
INSERT INTO "LaborRuleSet" ("tenantId", "jurisdiction", "level", "effectiveFrom", "version", "params", "source", "sourceDate", "status", "updatedAt") VALUES (NULL, 'FEDERAL', 'FEDERAL', '2009-07-24', 1, '{"overtime":{"weeklyThreshold":40,"weeklyMultiplier":1.5,"dailyThreshold":null,"dailyMultiplier":1.5,"dailyDoubleThreshold":null,"doubleMultiplier":2,"seventhDayRule":false},"meal":{"requiredAfterHours":null,"minMinutes":0,"secondRequiredAfterHours":null,"penaltyHours":0,"waiverAllowed":false},"rest":{"perHours":null,"minMinutes":0,"minimumDayHours":0,"penaltyHours":0},"restBetweenShifts":{"minHours":null,"premiumHours":0,"premiumMultiplierInGap":0},"minors":{"bands":[{"minAge":0,"maxAge":13,"schoolDayMaxHours":0,"schoolWeekMaxHours":0,"nonSchoolDayMaxHours":0,"nonSchoolWeekMaxHours":0,"earliest":null,"latest":null,"summerLatest":null,"schoolNightLatest":null,"mealAfterHours":null},{"minAge":14,"maxAge":15,"schoolDayMaxHours":3,"schoolWeekMaxHours":18,"nonSchoolDayMaxHours":8,"nonSchoolWeekMaxHours":40,"earliest":"07:00","latest":"19:00","summerLatest":"21:00","schoolNightLatest":null,"mealAfterHours":null}],"severity":"block"},"predictive":{"noticeDays":null,"changePremiums":[],"goodFaithEstimate":false},"breaks":{"paidUpToMinutes":20},"minimumWage":{"rateCents":725},"severity":{"overtime":"warn","restBetweenShifts":"warn","predictive":"warn"}}'::jsonb, '29 U.S.C. §206, §207; 29 CFR Part 778; 29 CFR 785.18 (short breaks); 29 CFR Part 570 (Subpart C); U.S. DOL Wage and Hour Division, https://www.dol.gov/agencies/whd', '2026-10-15', 'DRAFT', CURRENT_TIMESTAMP);
INSERT INTO "LaborRuleSet" ("tenantId", "jurisdiction", "level", "effectiveFrom", "version", "params", "source", "sourceDate", "status", "updatedAt") VALUES (NULL, 'US-FL', 'STATE', '2024-09-30', 1, '{"minimumWage":{"rateCents":1300},"minors":{"bands":[{"minAge":14,"maxAge":15,"schoolDayMaxHours":3,"schoolWeekMaxHours":15,"nonSchoolDayMaxHours":8,"nonSchoolWeekMaxHours":40,"earliest":"07:00","latest":"19:00","summerLatest":"21:00","schoolNightLatest":null,"mealAfterHours":4},{"minAge":16,"maxAge":17,"schoolDayMaxHours":8,"schoolWeekMaxHours":30,"nonSchoolDayMaxHours":null,"nonSchoolWeekMaxHours":null,"earliest":"06:30","latest":null,"summerLatest":null,"schoolNightLatest":"23:00","mealAfterHours":4}],"severity":"block"}}'::jsonb, 'Fla. Const. Art. X §24; Fla. Stat. §448.110; Fla. Stat. Ch. 450 Part I (§450.081); Florida Department of Commerce minimum wage notice', '2026-10-15', 'DRAFT', CURRENT_TIMESTAMP);
INSERT INTO "LaborRuleSet" ("tenantId", "jurisdiction", "level", "effectiveFrom", "version", "params", "source", "sourceDate", "status", "updatedAt") VALUES (NULL, 'US-FL', 'STATE', '2025-09-30', 1, '{"minimumWage":{"rateCents":1400},"minors":{"bands":[{"minAge":14,"maxAge":15,"schoolDayMaxHours":3,"schoolWeekMaxHours":15,"nonSchoolDayMaxHours":8,"nonSchoolWeekMaxHours":40,"earliest":"07:00","latest":"19:00","summerLatest":"21:00","schoolNightLatest":null,"mealAfterHours":4},{"minAge":16,"maxAge":17,"schoolDayMaxHours":8,"schoolWeekMaxHours":30,"nonSchoolDayMaxHours":null,"nonSchoolWeekMaxHours":null,"earliest":"06:30","latest":null,"summerLatest":null,"schoolNightLatest":"23:00","mealAfterHours":4}],"severity":"block"}}'::jsonb, 'Fla. Const. Art. X §24; Fla. Stat. §448.110; Fla. Stat. Ch. 450 Part I (§450.081); Florida Department of Commerce minimum wage notice', '2026-10-15', 'DRAFT', CURRENT_TIMESTAMP);
INSERT INTO "LaborRuleSet" ("tenantId", "jurisdiction", "level", "effectiveFrom", "version", "params", "source", "sourceDate", "status", "updatedAt") VALUES (NULL, 'US-FL', 'STATE', '2026-09-30', 1, '{"minimumWage":{"rateCents":1500},"minors":{"bands":[{"minAge":14,"maxAge":15,"schoolDayMaxHours":3,"schoolWeekMaxHours":15,"nonSchoolDayMaxHours":8,"nonSchoolWeekMaxHours":40,"earliest":"07:00","latest":"19:00","summerLatest":"21:00","schoolNightLatest":null,"mealAfterHours":4},{"minAge":16,"maxAge":17,"schoolDayMaxHours":8,"schoolWeekMaxHours":30,"nonSchoolDayMaxHours":null,"nonSchoolWeekMaxHours":null,"earliest":"06:30","latest":null,"summerLatest":null,"schoolNightLatest":"23:00","mealAfterHours":4}],"severity":"block"}}'::jsonb, 'Fla. Const. Art. X §24; Fla. Stat. §448.110; Fla. Stat. Ch. 450 Part I (§450.081); Florida Department of Commerce minimum wage notice', '2026-10-15', 'DRAFT', CURRENT_TIMESTAMP);
INSERT INTO "LaborRuleSet" ("tenantId", "jurisdiction", "level", "effectiveFrom", "version", "params", "source", "sourceDate", "status", "updatedAt") VALUES (NULL, 'US-AL', 'STATE', '2009-07-24', 1, '{"minors":{"bands":[{"minAge":14,"maxAge":15,"schoolDayMaxHours":3,"schoolWeekMaxHours":18,"nonSchoolDayMaxHours":8,"nonSchoolWeekMaxHours":40,"earliest":"07:00","latest":"19:00","summerLatest":"21:00","schoolNightLatest":null,"mealAfterHours":5},{"minAge":16,"maxAge":17,"schoolDayMaxHours":null,"schoolWeekMaxHours":null,"nonSchoolDayMaxHours":null,"nonSchoolWeekMaxHours":null,"earliest":"05:00","latest":null,"summerLatest":null,"schoolNightLatest":"22:00","mealAfterHours":null}],"severity":"block"}}'::jsonb, 'Ala. Code §25-8-30 et seq. (Child Labor Law); Alabama Department of Labor, Child Labor Division', '2026-10-15', 'DRAFT', CURRENT_TIMESTAMP);
