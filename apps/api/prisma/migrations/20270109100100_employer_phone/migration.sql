-- The employer's telephone number: New York requires it on every wage
-- statement (Labor Law §195(3)) and on the pay notice (§195(1)).
ALTER TABLE "EmployerOrganization" ADD COLUMN "phone" VARCHAR(32);
