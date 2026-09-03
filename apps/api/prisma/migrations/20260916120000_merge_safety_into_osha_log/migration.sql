-- Corrective: 20260915120000 created SafetyIncident as a SECOND injury log,
-- duplicating the Phase 88 OshaIncident behind /compliance/osha. One log is
-- the law of the land — carry over anything recorded in the brief window the
-- duplicate was live, then drop it. The scorecard safety tile now reads
-- OshaIncident.

INSERT INTO "OshaIncident" (
    "clientId", "associateId", "occurredAt", "reportedAt", "reportedById",
    "location", "description", "severity", "daysAway", "daysRestricted",
    "isRecordable", "status", "resolutionNote", "resolvedAt", "createdAt",
    "updatedAt"
)
SELECT
    s."clientId",
    s."associateId",
    s."occurredAt",
    s."createdAt",
    s."reportedById",
    s."location",
    s."description",
    CASE s."outcome"
        WHEN 'NEAR_MISS'             THEN 'FIRST_AID'::"OshaIncidentSeverity"
        WHEN 'FIRST_AID_ONLY'        THEN 'FIRST_AID'::"OshaIncidentSeverity"
        WHEN 'MEDICAL_TREATMENT'     THEN 'MEDICAL_TREATMENT'::"OshaIncidentSeverity"
        -- OshaIncident's ladder has no LOC step; 1904.7 treats loss of
        -- consciousness as recordable, so it lands as medical treatment
        -- (the isRecordable flag below preserves the recordability).
        WHEN 'LOSS_OF_CONSCIOUSNESS' THEN 'MEDICAL_TREATMENT'::"OshaIncidentSeverity"
        WHEN 'RESTRICTED_DUTY'       THEN 'RESTRICTED_DUTY'::"OshaIncidentSeverity"
        WHEN 'DAYS_AWAY'             THEN 'DAYS_AWAY'::"OshaIncidentSeverity"
        WHEN 'FATALITY'              THEN 'FATAL'::"OshaIncidentSeverity"
    END,
    s."daysAway",
    s."daysRestricted",
    s."recordable",
    CASE s."status"
        WHEN 'CLOSED' THEN 'RESOLVED'::"OshaIncidentStatus"
        ELSE 'REPORTED'::"OshaIncidentStatus"
    END,
    s."closureNotes",
    s."closedAt",
    s."createdAt",
    s."updatedAt"
FROM "SafetyIncident" s
-- OshaIncident.clientId is NOT NULL; a clientless row (associate with no
-- approved application) cannot be represented there. None should exist in
-- the hours the duplicate was live.
WHERE s."clientId" IS NOT NULL;

DROP TABLE "SafetyIncident";
DROP TYPE "SafetyIncidentOutcome";
DROP TYPE "SafetyIncidentStatus";
