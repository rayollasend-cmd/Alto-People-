-- CreateEnum
CREATE TYPE "I9CitizenshipStatus" AS ENUM ('US_CITIZEN', 'NON_CITIZEN_NATIONAL', 'LAWFUL_PERMANENT_RESIDENT', 'ALIEN_AUTHORIZED_TO_WORK');

-- AlterTable
ALTER TABLE "I9Verification" ADD COLUMN     "alienRegistrationNumberEnc" BYTEA,
ADD COLUMN     "citizenshipStatus" "I9CitizenshipStatus",
ADD COLUMN     "section1Ip" TEXT,
ADD COLUMN     "section1TypedName" TEXT,
ADD COLUMN     "section1UserAgent" TEXT,
ADD COLUMN     "workAuthExpiresAt" DATE;
