-- Who a staff account reports to. An associate's manager lives on the
-- person record (Associate.managerId); an office account with no person
-- record had nowhere to say it, so the company's own chart was flat.
ALTER TABLE "User" ADD COLUMN "reportsToUserId" UUID;
ALTER TABLE "User"
  ADD CONSTRAINT "User_reportsToUserId_fkey"
  FOREIGN KEY ("reportsToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "User_reportsToUserId_idx" ON "User"("reportsToUserId");
