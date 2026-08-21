-- Collaboration overlay for role decision queues.
CREATE TABLE "DecisionClaim" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(160) NOT NULL,
  "claimedById" UUID NOT NULL,
  "claimedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "escalatedAt" TIMESTAMPTZ(6),
  "escalatedById" UUID,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "DecisionClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DecisionClaim_key_key" ON "DecisionClaim"("key");
ALTER TABLE "DecisionClaim"
  ADD CONSTRAINT "DecisionClaim_claimedById_fkey"
  FOREIGN KEY ("claimedById") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
