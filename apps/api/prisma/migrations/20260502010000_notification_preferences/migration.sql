-- Per-user EMAIL opt-out by category bucket. IN_APP is unaffected.
-- Absence of a row means "send" (default ON). A row with emailEnabled=false
-- means the user has muted that category.

CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_userId_category_key"
    ON "NotificationPreference"("userId", "category");

ALTER TABLE "NotificationPreference"
    ADD CONSTRAINT "NotificationPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
