-- Two-step self-serve email change. Token hashed (sha256) at rest, raw
-- token only ever lives in the confirmation link emailed to the new
-- address. Older outstanding rows for the same user are invalidated when
-- a new request is minted (logic in routes/auth.ts).

CREATE TABLE "EmailChangeRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "newEmail" VARCHAR(254) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "requestedIp" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailChangeRequest_tokenHash_key" ON "EmailChangeRequest"("tokenHash");
CREATE INDEX "EmailChangeRequest_userId_consumedAt_idx" ON "EmailChangeRequest"("userId", "consumedAt");
CREATE INDEX "EmailChangeRequest_expiresAt_idx" ON "EmailChangeRequest"("expiresAt");

ALTER TABLE "EmailChangeRequest"
    ADD CONSTRAINT "EmailChangeRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
