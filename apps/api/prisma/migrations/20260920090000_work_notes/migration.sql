-- The thread on the work itself: staff notes attached to an object
-- (associate record first), with desk @mentions. Generic subject keys so
-- future subjects (timesheet weeks, batons) need no schema change.
CREATE TABLE "WorkNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subjectType" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" UUID,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkNote_subjectType_subjectKey_createdAt_idx"
    ON "WorkNote"("subjectType", "subjectKey", "createdAt" DESC);

ALTER TABLE "WorkNote"
    ADD CONSTRAINT "WorkNote_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
