-- Closing the portal's loops: a request may name the person it is about,
-- and the client can mark a statement or weekly report as reviewed.

ALTER TABLE "ClientRequest" ADD COLUMN "associateId" UUID;
ALTER TABLE "ClientRequest"
    ADD CONSTRAINT "ClientRequest_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "ClientAcknowledgementKind" AS ENUM ('STATEMENT', 'SERVICE_REPORT');

CREATE TABLE "ClientAcknowledgement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "kind" "ClientAcknowledgementKind" NOT NULL,
    "subjectKey" VARCHAR(64) NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientAcknowledgement_clientId_kind_subjectKey_key"
    ON "ClientAcknowledgement"("clientId", "kind", "subjectKey");

ALTER TABLE "ClientAcknowledgement"
    ADD CONSTRAINT "ClientAcknowledgement_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientAcknowledgement"
    ADD CONSTRAINT "ClientAcknowledgement_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
