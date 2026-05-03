-- Phase: settings audit row #8 (branding).
-- Singleton table for org-wide branding overrides; enforced via a CHECK
-- constraint on the literal id 'singleton'. Hard defaults stay baked into
-- the email template code so a fresh DB still sends correctly.

CREATE TABLE "OrgSetting" (
    "id"              VARCHAR(16) NOT NULL DEFAULT 'singleton',
    "orgName"         VARCHAR(120) NOT NULL DEFAULT 'Alto HR',
    "senderName"      VARCHAR(120),
    "supportEmail"    VARCHAR(254),
    "primaryColor"    VARCHAR(7),
    "logoBytes"       BYTEA,
    "logoContentType" VARCHAR(64),
    "logoUpdatedAt"   TIMESTAMPTZ(6),
    "updatedAt"       TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrgSetting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrgSetting_singleton_chk" CHECK ("id" = 'singleton')
);
