-- Shift teams: standing crews at a work site ("Front Beach Morning").
-- Scheduling filters its roster to a team's members so building the week
-- shows only the people who work that shift.

CREATE TABLE "ShiftTeam" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ShiftTeam_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShiftTeam_clientId_deletedAt_idx" ON "ShiftTeam"("clientId", "deletedAt");
CREATE INDEX "ShiftTeam_locationId_deletedAt_idx" ON "ShiftTeam"("locationId", "deletedAt");

ALTER TABLE "ShiftTeam" ADD CONSTRAINT "ShiftTeam_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftTeam" ADD CONSTRAINT "ShiftTeam_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ShiftTeamMember" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "teamId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftTeamMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShiftTeamMember_teamId_associateId_key" ON "ShiftTeamMember"("teamId", "associateId");
CREATE INDEX "ShiftTeamMember_associateId_idx" ON "ShiftTeamMember"("associateId");

ALTER TABLE "ShiftTeamMember" ADD CONSTRAINT "ShiftTeamMember_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "ShiftTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftTeamMember" ADD CONSTRAINT "ShiftTeamMember_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
