-- Hugo and the product taxonomy (2026-10-13). Additive.
--
-- Hugo is the orchestrator and the assistant persona ("Hugo, by Alto
-- People"); each tenant picks the display name its team uses. An agent
-- record names its family and capability from the taxonomy.

ALTER TABLE "OrgSetting" ADD COLUMN IF NOT EXISTS "assistantName" VARCHAR(60) NOT NULL DEFAULT 'Hugo';
ALTER TABLE "AgentProfile" ADD COLUMN IF NOT EXISTS "family" VARCHAR(40);
ALTER TABLE "AgentProfile" ADD COLUMN IF NOT EXISTS "capability" VARCHAR(120);

-- The agents already registered take their place in the taxonomy.
UPDATE "AgentProfile" SET "family" = 'associate-self-service', "capability" = 'Payday, ride and schedule answers on WhatsApp; supervisor handoff'
  WHERE "builtInKey" = 'whatsapp-assistant' AND "family" IS NULL;
UPDATE "AgentProfile" SET "family" = 'deployment', "capability" = 'Build, test, push and watch the deploy'
  WHERE "builtInKey" = 'claude-code-deploy' AND "family" IS NULL;
UPDATE "AgentProfile" SET "family" = 'decision-intelligence', "capability" = 'Read reports and draft recommendations for leadership'
  WHERE "builtInKey" = 'boardroom' AND "family" IS NULL;
UPDATE "Worker" w SET "name" = 'Hugo on WhatsApp'
  FROM "AgentProfile" p WHERE p."workerId" = w."id" AND p."builtInKey" = 'whatsapp-assistant' AND w."name" = 'WhatsApp messaging assistant';
