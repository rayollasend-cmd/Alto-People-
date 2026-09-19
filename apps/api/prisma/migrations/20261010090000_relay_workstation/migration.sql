-- The workstation: what one desk sends another, and the documents the work
-- runs on. Four desks here — Recruiting joins the board's three.
CREATE TYPE "RelayDesk" AS ENUM ('HR', 'RECRUITING', 'WORKFORCE', 'FINANCE');
CREATE TYPE "RelayRequestKind" AS ENUM ('ASK', 'SEND', 'TASK');
CREATE TYPE "RelayRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'ANSWERED', 'CLOSED');

CREATE TABLE "RelayRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "RelayRequestKind" NOT NULL,
    "status" "RelayRequestStatus" NOT NULL DEFAULT 'OPEN',
    "fromUserId" UUID NOT NULL,
    "toDesk" "RelayDesk" NOT NULL,
    "toUserId" UUID,
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(6),
    "aboutAssociateId" UUID,
    "claimedById" UUID,
    "answeredAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "closedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RelayRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RelayRequest_toDesk_status_idx" ON "RelayRequest"("toDesk", "status");
CREATE INDEX "RelayRequest_toUserId_status_idx" ON "RelayRequest"("toUserId", "status");
CREATE INDEX "RelayRequest_fromUserId_idx" ON "RelayRequest"("fromUserId");
CREATE INDEX "RelayRequest_updatedAt_idx" ON "RelayRequest"("updatedAt" DESC);
ALTER TABLE "RelayRequest" ADD CONSTRAINT "RelayRequest_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelayRequest" ADD CONSTRAINT "RelayRequest_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RelayRequest" ADD CONSTRAINT "RelayRequest_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RelayRequest" ADD CONSTRAINT "RelayRequest_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RelayRequest" ADD CONSTRAINT "RelayRequest_aboutAssociateId_fkey" FOREIGN KEY ("aboutAssociateId") REFERENCES "Associate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RelayMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requestId" UUID NOT NULL,
    "authorUserId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelayMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RelayMessage_requestId_createdAt_idx" ON "RelayMessage"("requestId", "createdAt");
ALTER TABLE "RelayMessage" ADD CONSTRAINT "RelayMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RelayRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelayMessage" ADD CONSTRAINT "RelayMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The working shelf. Not the associate's document vault (DocumentRecord),
-- which keeps its own retention rules.
CREATE TABLE "RelayFile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "key" TEXT NOT NULL,
    "mime" VARCHAR(160) NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" UUID,
    "desk" "RelayDesk",
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aboutAssociateId" UUID,
    "requestId" UUID,
    "messageId" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelayFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RelayFile_desk_idx" ON "RelayFile"("desk");
CREATE INDEX "RelayFile_uploadedById_idx" ON "RelayFile"("uploadedById");
CREATE INDEX "RelayFile_requestId_idx" ON "RelayFile"("requestId");
CREATE INDEX "RelayFile_createdAt_idx" ON "RelayFile"("createdAt" DESC);
ALTER TABLE "RelayFile" ADD CONSTRAINT "RelayFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RelayFile" ADD CONSTRAINT "RelayFile_aboutAssociateId_fkey" FOREIGN KEY ("aboutAssociateId") REFERENCES "Associate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RelayFile" ADD CONSTRAINT "RelayFile_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RelayRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RelayFile" ADD CONSTRAINT "RelayFile_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "RelayMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
