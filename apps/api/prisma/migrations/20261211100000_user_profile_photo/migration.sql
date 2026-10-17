-- A login with no associate record (HR, recruiters, managers, most
-- supervisors) had nowhere to keep a profile photo, so every staff avatar
-- was initials. Same shape as Associate.photoS3Key / photoUpdatedAt.
ALTER TABLE "User" ADD COLUMN "photoS3Key" TEXT;
ALTER TABLE "User" ADD COLUMN "photoUpdatedAt" TIMESTAMPTZ(6);
