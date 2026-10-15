-- Brief 2-5 step 3 — the field-encryption keyring's canary: one row per key id. Additive;
-- the first boot writes key 0's canary under PAYOUT_ENCRYPTION_KEY.

-- CreateTable
CREATE TABLE "EncryptionCanary" (
    "keyId" INTEGER NOT NULL,
    "blob" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EncryptionCanary_pkey" PRIMARY KEY ("keyId")
);

ALTER TABLE "EncryptionCanary" ADD CONSTRAINT "EncryptionCanary_key_check" CHECK ("keyId" BETWEEN 0 AND 255);
