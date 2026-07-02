-- Web-push subscriptions: one row per (user, browser/device). Endpoint is
-- globally unique (the push service mints it per subscription); dead rows
-- are pruned by the sender on 404/410.
CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "endpoint" VARCHAR(1000) NOT NULL,
    "p256dh" VARCHAR(300) NOT NULL,
    "auth" VARCHAR(100) NOT NULL,
    "userAgent" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
