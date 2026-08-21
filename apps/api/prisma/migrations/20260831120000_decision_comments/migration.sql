-- Item threads: comments on decision keys.
CREATE TABLE "DecisionComment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(160) NOT NULL,
  "userId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionComment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DecisionComment_key_createdAt_idx" ON "DecisionComment"("key", "createdAt");
ALTER TABLE "DecisionComment"
  ADD CONSTRAINT "DecisionComment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
