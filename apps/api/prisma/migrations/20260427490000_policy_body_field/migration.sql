-- Phase: Policy.body inline markdown
-- Adds an optional `body` text column so policies can store their full text
-- inline (read by the associate in PolicyAckTask before acknowledging) rather
-- than relying on `bodyUrl` to point at an external file.

ALTER TABLE "Policy" ADD COLUMN "body" TEXT;
