-- Wave 5.2 — Per-employee vs aggregate JE mode on QuickbooksConnection.

CREATE TYPE "QboJeMode" AS ENUM ('AGGREGATE', 'PER_EMPLOYEE');

ALTER TABLE "QuickbooksConnection"
  ADD COLUMN "jeMode" "QboJeMode" NOT NULL DEFAULT 'AGGREGATE';
