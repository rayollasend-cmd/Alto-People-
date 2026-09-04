-- The mandatory live profile photo (20260912120000) added the PROFILE_PHOTO
-- TaskKind — but the task rows themselves only ever landed via seed.ts,
-- which never runs in production. Real templates and in-flight checklists
-- never got the step, so associates kept onboarding without a photo and the
-- 100%-checklist approval gate had nothing to hold. This backfills both.

-- 1) Every onboarding template gets the photo task (appended at max+1 —
--    same approach as the seed's upgrade path, so no order collisions).
INSERT INTO "OnboardingTemplateTask" ("id", "templateId", "kind", "title", "description", "order")
SELECT
    gen_random_uuid(),
    t."id",
    'PROFILE_PHOTO'::"TaskKind",
    'Take your profile photo',
    'A quick headshot taken with your camera — shown next to your name across the app.',
    COALESCE((SELECT MAX(tt."order") FROM "OnboardingTemplateTask" tt WHERE tt."templateId" = t."id"), 0) + 1
FROM "OnboardingTemplate" t
WHERE NOT EXISTS (
    SELECT 1 FROM "OnboardingTemplateTask" x
    WHERE x."templateId" = t."id" AND x."kind" = 'PROFILE_PHOTO'
);

-- 2) Every IN-FLIGHT application checklist (not yet approved/rejected) gets
--    the task too, so the current cohort is gated — born DONE when a photo
--    is already on file, PENDING otherwise. Decided applications are left
--    untouched: rewriting a closed checklist would falsify history.
INSERT INTO "OnboardingTask" ("id", "checklistId", "kind", "status", "title", "description", "order", "completedAt", "updatedAt")
SELECT
    gen_random_uuid(),
    c."id",
    'PROFILE_PHOTO'::"TaskKind",
    CASE WHEN a."photoS3Key" IS NOT NULL THEN 'DONE'::"TaskStatus" ELSE 'PENDING'::"TaskStatus" END,
    'Take your profile photo',
    'A quick headshot taken with your camera — shown next to your name across the app.',
    COALESCE((SELECT MAX(ot."order") FROM "OnboardingTask" ot WHERE ot."checklistId" = c."id"), 0) + 1,
    CASE WHEN a."photoS3Key" IS NOT NULL THEN CURRENT_TIMESTAMP END,
    CURRENT_TIMESTAMP
FROM "OnboardingChecklist" c
JOIN "Application" ap ON ap."id" = c."applicationId"
JOIN "Associate" a ON a."id" = ap."associateId"
WHERE ap."status" NOT IN ('APPROVED', 'REJECTED')
  AND ap."deletedAt" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "OnboardingTask" x
      WHERE x."checklistId" = c."id" AND x."kind" = 'PROFILE_PHOTO'
  );
