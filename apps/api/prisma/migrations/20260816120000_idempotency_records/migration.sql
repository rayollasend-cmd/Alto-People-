-- Optional Idempotency-Key support on money-moving / bulk-send POSTs.
-- One remembered response per (user, method, path, key); NULL
-- responseStatus claims the key while the original request is in flight.
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(512) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdempotencyRecord_userId_method_path_key_key"
    ON "IdempotencyRecord"("userId", "method", "path", "key");

CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
