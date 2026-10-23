-- F500 G5: an employee's written response to a disciplinary notice
-- (acknowledging receipt is not agreeing). Columns on an existing table:
-- the table is already under the tenant wall.
ALTER TABLE "DisciplinaryAction" ADD COLUMN "employeeResponse" TEXT;
ALTER TABLE "DisciplinaryAction" ADD COLUMN "employeeRespondedAt" TIMESTAMPTZ(6);
