-- Phase: Associate profile photo.
-- Optional uploaded headshot for the directory + avatars across the app.
-- photoS3Key holds the relative path under uploads/profile-photos/.
-- photoUpdatedAt is the cache-buster the API stamps onto every photo URL.

ALTER TABLE "Associate" ADD COLUMN "photoS3Key" TEXT;
ALTER TABLE "Associate" ADD COLUMN "photoUpdatedAt" TIMESTAMPTZ(6);
