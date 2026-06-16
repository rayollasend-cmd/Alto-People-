-- CreateTable
CREATE TABLE "ShiftPosition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ShiftPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftPosition_clientId_deletedAt_idx" ON "ShiftPosition"("clientId", "deletedAt");

-- AddForeignKey
ALTER TABLE "ShiftPosition" ADD CONSTRAINT "ShiftPosition_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: seed the default shift-position catalog (department × daypart)
-- for every existing, non-deleted client. Idempotent via NOT EXISTS so a
-- re-run won't duplicate. sortOrder follows the listed order.
INSERT INTO "ShiftPosition" ("id", "clientId", "name", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", d.name, d.ord, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Client" c
CROSS JOIN (
    VALUES
        ('F&D Morning Shift', 0),
        ('F&D Afternoon Shift', 1),
        ('F&D Overnight Shift', 2),
        ('GM Morning Shift', 3),
        ('GM Afternoon Shift', 4),
        ('GM Overnight Shift', 5),
        ('Produce Morning Shift', 6),
        ('Produce Afternoon Shift', 7),
        ('Produce Overnight Shift', 8),
        ('Meat Morning Shift', 9),
        ('Meat Afternoon Shift', 10),
        ('Meat Overnight Shift', 11),
        ('Bakery Morning Shift', 12),
        ('Bakery Afternoon Shift', 13),
        ('Bakery Overnight Shift', 14),
        ('Deli Morning Shift', 15),
        ('Deli Afternoon Shift', 16),
        ('Deli Overnight Shift', 17)
) AS d(name, ord)
WHERE c."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ShiftPosition" sp
    WHERE sp."clientId" = c."id" AND sp."name" = d.name
  );
