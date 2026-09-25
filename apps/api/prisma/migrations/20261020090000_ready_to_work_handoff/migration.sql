-- CreateTable
CREATE TABLE "ReadyToWorkHandoff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "locationId" UUID,
    "issuedById" UUID,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supervisorUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fallbackToClient" BOOLEAN NOT NULL DEFAULT false,
    "associateNotifiedAt" TIMESTAMPTZ(6),
    "supervisorsNotifiedAt" TIMESTAMPTZ(6),
    "nudgedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ReadyToWorkHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReadyToWorkHandoff_associateId_key" ON "ReadyToWorkHandoff"("associateId");

-- CreateIndex
CREATE INDEX "ReadyToWorkHandoff_clientId_locationId_issuedAt_idx" ON "ReadyToWorkHandoff"("clientId", "locationId", "issuedAt" DESC);

-- CreateIndex
CREATE INDEX "ReadyToWorkHandoff_nudgedAt_supervisorsNotifiedAt_idx" ON "ReadyToWorkHandoff"("nudgedAt", "supervisorsNotifiedAt");

-- AddForeignKey
ALTER TABLE "ReadyToWorkHandoff" ADD CONSTRAINT "ReadyToWorkHandoff_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadyToWorkHandoff" ADD CONSTRAINT "ReadyToWorkHandoff_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadyToWorkHandoff" ADD CONSTRAINT "ReadyToWorkHandoff_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadyToWorkHandoff" ADD CONSTRAINT "ReadyToWorkHandoff_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

