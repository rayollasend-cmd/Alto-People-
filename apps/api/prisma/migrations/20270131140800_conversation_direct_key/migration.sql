-- One direct thread per pair of people (F500 G5).
--
-- POST /messages/conversations looked for an existing DIRECT thread and
-- created one when it found none, with nothing to stop two requests doing
-- both at once — two clicks (or the ?to= deep link firing twice) made two
-- empty "Aaliyah Brooks" threads. Conversation gains `directKey`: the two
-- participants' user ids, sorted, joined by ":"; unique per tenant, null
-- for groups and store channels.
--
-- Existing duplicates are merged into the oldest thread of each pair: its
-- messages move over, each participant keeps the later read mark, the
-- latest preview wins, and the emptied newer threads are removed. No
-- message is lost. (Dev data held five such pairs, all without messages.)
-- Conversation is already under the database wall (tenancy_rls); a new
-- column needs no policy change.

ALTER TABLE "Conversation" ADD COLUMN "directKey" VARCHAR(80);

CREATE TEMP TABLE "_alto_direct" AS
WITH pairs AS (
  SELECT c."id", c."tenantId", c."createdAt",
         (SELECT string_agg(p."userId"::text, ':' ORDER BY p."userId"::text) FROM "ConversationParticipant" p WHERE p."conversationId" = c."id") AS "k",
         (SELECT count(*) FROM "ConversationParticipant" p WHERE p."conversationId" = c."id") AS "n"
  FROM "Conversation" c
  WHERE c."kind" = 'DIRECT'
)
SELECT "id", "tenantId", "k",
       first_value("id") OVER (PARTITION BY "tenantId", "k" ORDER BY "createdAt", "id") AS "keep"
FROM pairs
WHERE "n" = 2;

-- The newer threads' messages move to the oldest.
UPDATE "Message" m SET "conversationId" = d."keep"
FROM "_alto_direct" d
WHERE m."conversationId" = d."id" AND d."id" <> d."keep";

-- Each participant keeps the later of their read marks.
UPDATE "ConversationParticipant" kp SET "lastReadAt" = GREATEST(kp."lastReadAt", dp."lastReadAt")
FROM "_alto_direct" d
JOIN "ConversationParticipant" dp ON dp."conversationId" = d."id"
WHERE d."id" <> d."keep" AND kp."conversationId" = d."keep" AND kp."userId" = dp."userId";

-- The latest message's time and preview, across the merged threads.
UPDATE "Conversation" k SET "lastMessageAt" = src."lastMessageAt", "lastPreview" = src."lastPreview"
FROM (
  SELECT DISTINCT ON (d."keep") d."keep", c."lastMessageAt", c."lastPreview"
  FROM "_alto_direct" d
  JOIN "Conversation" c ON c."id" = d."id"
  WHERE c."lastMessageAt" IS NOT NULL
  ORDER BY d."keep", c."lastMessageAt" DESC
) src
WHERE k."id" = src."keep";

-- The emptied newer threads go (their participant rows cascade).
DELETE FROM "Conversation" c USING "_alto_direct" d WHERE c."id" = d."id" AND d."id" <> d."keep";

-- The kept thread of each pair carries the key.
UPDATE "Conversation" c SET "directKey" = d."k" FROM "_alto_direct" d WHERE c."id" = d."id" AND d."id" = d."keep";

CREATE UNIQUE INDEX "Conversation_tenantId_directKey_key" ON "Conversation"("tenantId", "directKey");

DROP TABLE "_alto_direct";
