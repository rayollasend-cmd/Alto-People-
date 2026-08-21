-- Workforce collaboration: assignment + postponement on decision claims,
-- and the personal day/week planner.
ALTER TABLE "DecisionClaim"
  ADD COLUMN "assignedById" UUID,
  ADD COLUMN "postponedUntil" TIMESTAMPTZ(6);

CREATE TABLE "WorkPlanItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "day" DATE NOT NULL,
  "title" TEXT NOT NULL,
  "decisionKey" VARCHAR(160),
  "linkUrl" TEXT,
  "doneAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "WorkPlanItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkPlanItem_userId_day_idx" ON "WorkPlanItem"("userId", "day");
ALTER TABLE "WorkPlanItem"
  ADD CONSTRAINT "WorkPlanItem_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
