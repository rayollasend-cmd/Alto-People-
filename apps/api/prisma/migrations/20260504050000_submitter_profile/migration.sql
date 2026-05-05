-- Gap 1 — Singleton SubmitterProfile carrying SSA BSO submitter info.
-- One row, fixed id 'singleton' (matches the OrgSetting pattern). HR
-- types this in once when they enroll for BSO; the EFW2 e-file route
-- reads from here so finance doesn't re-enter the User ID per filing.

CREATE TABLE "SubmitterProfile" (
  "id"            VARCHAR(16) PRIMARY KEY DEFAULT 'singleton',
  "ein"           VARCHAR(9) NOT NULL,
  "userId"        VARCHAR(17) NOT NULL,
  "name"          VARCHAR(57) NOT NULL,
  "addressLine1"  VARCHAR(22) NOT NULL,
  "addressLine2"  VARCHAR(22),
  "city"          VARCHAR(22) NOT NULL,
  "state"         VARCHAR(2)  NOT NULL,
  "zip5"          VARCHAR(5)  NOT NULL,
  "zip4"          VARCHAR(4),
  "contactName"   VARCHAR(57) NOT NULL,
  "contactPhone"  VARCHAR(20) NOT NULL,
  "contactEmail"  VARCHAR(40) NOT NULL,
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CHECK ("ein" ~ '^[0-9]{9}$'),
  CHECK ("zip5" ~ '^[0-9]{5}$'),
  CHECK ("zip4" IS NULL OR "zip4" ~ '^[0-9]{4}$')
);
