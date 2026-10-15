-- Brief 2-3 step 5: SAML connections and their replay memory.
ALTER TABLE "IdentityConnection" ADD COLUMN "samlIdpCert" TEXT, ADD COLUMN "allowIdpInitiated" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SamlCache" (
    "key" VARCHAR(300) NOT NULL,
    "value" VARCHAR(300) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SamlCache_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "SamlCache_expiresAt_idx" ON "SamlCache"("expiresAt");
