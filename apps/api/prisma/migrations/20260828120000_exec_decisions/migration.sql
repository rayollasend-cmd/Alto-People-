-- Chairman's decision queue: state overlay for generated decisions.
CREATE TABLE "ExecDecisionState" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(120) NOT NULL,
  "status" VARCHAR(12) NOT NULL,
  "snoozeUntil" TIMESTAMPTZ(6),
  "stakesAtAction" DECIMAL(12,2),
  "actedById" UUID,
  "actedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ExecDecisionState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExecDecisionState_key_key" ON "ExecDecisionState"("key");
