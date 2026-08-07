-- Default pay/bill rate per (client, position). Lets the scheduling KPIs
-- and labor-cost footer resolve a rate for shifts that have none, instead
-- of showing $0. Resurrected from wip/scheduling-pay-rates.
CREATE TABLE "ShiftRateDefault" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "position" TEXT NOT NULL,
    "payRate" DECIMAL(8,2) NOT NULL,
    "billRate" DECIMAL(8,2),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ShiftRateDefault_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShiftRateDefault_clientId_position_key" ON "ShiftRateDefault"("clientId", "position");
CREATE INDEX "ShiftRateDefault_clientId_idx" ON "ShiftRateDefault"("clientId");

ALTER TABLE "ShiftRateDefault"
  ADD CONSTRAINT "ShiftRateDefault_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
