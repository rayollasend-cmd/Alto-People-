-- Who holds a piece of the relay: a first-paycheck lane, a baton, or a
-- client request — one holder at a time, with who handed it over.
CREATE TABLE "RelayClaim" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subjectType" VARCHAR(20) NOT NULL,
    "subjectKey" VARCHAR(80) NOT NULL,
    "userId" UUID NOT NULL,
    "claimedById" UUID,
    "claimedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelayClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RelayClaim_subjectType_subjectKey_key" ON "RelayClaim"("subjectType", "subjectKey");
CREATE INDEX "RelayClaim_userId_idx" ON "RelayClaim"("userId");
ALTER TABLE "RelayClaim" ADD CONSTRAINT "RelayClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelayClaim" ADD CONSTRAINT "RelayClaim_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
