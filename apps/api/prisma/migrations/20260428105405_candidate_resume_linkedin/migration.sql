-- External careers-site applications can carry pasted links to the
-- applicant's resume (Drive/Dropbox/etc) and LinkedIn profile. Both
-- nullable because internal candidate creation (recruiter typing in a
-- referral) doesn't always have these on hand.
ALTER TABLE "Candidate" ADD COLUMN "resumeUrl" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "linkedinUrl" TEXT;
