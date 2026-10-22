-- Transport walk 9 follow-up: the driver's fuel receipt photo gets its own
-- column on the service log instead of riding inside the note text.
ALTER TABLE "VanServiceEntry" ADD COLUMN "photoS3Key" VARCHAR(300);

-- Move the keys the fuel route wrote into the note ("18.4 gal · receipt
-- photo: <key>" or "receipt photo: <key>") into the column, then strip that
-- text from the note; a note left empty becomes NULL.
UPDATE "VanServiceEntry"
SET "photoS3Key" = substring("notes" from 'receipt photo: (\S+)'),
    "notes" = NULLIF(btrim(regexp_replace("notes", '(\s*·\s*)?receipt photo: \S+', '', 'g'), ' ·'), '')
WHERE "notes" ~ 'receipt photo: \S+';
