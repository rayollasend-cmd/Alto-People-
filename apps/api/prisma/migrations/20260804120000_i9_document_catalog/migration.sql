-- I-9 document catalog (additive only — see the compatibility contract).
--
-- HR couldn't verify Section 2 because uploads carried no federal document
-- identity: a U.S. Passport (List A, sufficient alone) and a driver's
-- license (List B, must pair with a List C document) both landed as
-- "Photo ID · image.jpg". The associate now declares the specific document
-- at upload; these columns store it.
--
-- ZERO existing rows are touched: three nullable columns, no updates, no
-- deletes, no defaults that rewrite data. Legacy uploads keep NULLs and the
-- submit gate has an explicit legacy pass-through for them; completed I-9s
-- are never recomputed.

CREATE TYPE "I9DocList" AS ENUM ('A', 'B', 'C');
CREATE TYPE "DocSide" AS ENUM ('FRONT', 'BACK');

ALTER TABLE "DocumentRecord" ADD COLUMN "i9DocTitle" VARCHAR(80);
ALTER TABLE "DocumentRecord" ADD COLUMN "i9List" "I9DocList";
ALTER TABLE "DocumentRecord" ADD COLUMN "side" "DocSide";
