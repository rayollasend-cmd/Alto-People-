-- Room 2.0: the pinned next step per decision item.
CREATE TABLE "DecisionNextStep" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(160) NOT NULL,
  "text" TEXT NOT NULL,
  "ownerId" UUID,
  "dueDay" DATE,
  "setById" UUID NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionNextStep_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DecisionNextStep_key_key" ON "DecisionNextStep"("key");
ALTER TABLE "DecisionNextStep"
  ADD CONSTRAINT "DecisionNextStep_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
