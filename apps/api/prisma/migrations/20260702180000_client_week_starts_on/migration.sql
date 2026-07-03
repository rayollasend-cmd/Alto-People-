-- Per-client scheduling week start (0=Sunday … 6=Saturday). Drives the
-- associate week-ahead digest timing/window.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "weekStartsOn" INTEGER NOT NULL DEFAULT 0;
