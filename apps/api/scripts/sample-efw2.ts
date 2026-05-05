// Generates a sample EFW2 + EFW2C file pair from synthetic data so
// finance can upload them to the SSA AccuWage Online validator and get a
// positional report. AccuWage is the authoritative cross-check we don't
// have access to from CI — it parses every field according to Pub 42-007
// (W-2) and Pub 42-014 (W-2c) and reports any position/format mismatch.
//
// Run from repo root:
//   npx tsx apps/api/scripts/sample-efw2.ts
//
// Files write to apps/api/scripts/output/. Take both files to
// https://www.ssa.gov/employer/accuwage/index.html, run the validator,
// and paste the report into the Phase 7 review channel.
//
// The output is intentionally human-recognisable but synthetic — fake
// EIN, fake SSNs, fake names. Don't ship the output anywhere downstream
// of AccuWage; it is not a real filing.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEfw2File, type Efw2File } from '../src/lib/efw2.js';
import { buildEfw2cFile, type Efw2cFile } from '../src/lib/efw2c.js';
import type { W2Boxes } from '../src/lib/w2Aggregator.js';

const TAX_YEAR = 2024;

const submitter = {
  ein: '123456789',
  userId: 'TEST00000ALTOHR',
  name: 'Alto Etho LLC dba Alto HR',
  addressLine1: '1 Sample Way',
  city: 'Tampa',
  state: 'FL',
  zip5: '33601',
  zip4: '0001',
  contactName: 'Sample Submitter',
  contactPhone: '5555550100',
  contactEmail: 'efw2-test@altohr.com',
};

const employer = {
  ein: '987654321',
  taxYear: TAX_YEAR,
  name: 'Acme Sample Co LLC',
  addressLine1: '500 Industrial Blvd',
  city: 'Tampa',
  state: 'FL',
  zip5: '33602',
};

function boxes(over: Partial<W2Boxes> = {}): W2Boxes {
  return {
    box1Wages: 50000,
    box2FitWithheld: 5500,
    box3SsWages: 50000,
    box4SsTax: 3100,
    box5MedicareWages: 50000,
    box6MedicareTax: 725,
    stateLines: [{ state: 'FL', stateWages: 50000, stateIncomeTax: 0 }],
    sourceItemCount: 24,
    ...over,
  };
}

const employees = [
  {
    ssn: '111223333',
    firstName: 'Pat',
    lastName: 'Sample',
    addressLine1: '12 Maple St',
    city: 'Tampa',
    state: 'FL',
    zip5: '33602',
    boxes: boxes(),
  },
  {
    ssn: '444556666',
    firstName: 'Jordan',
    middleName: 'A',
    lastName: 'Test-Person',
    suffix: 'Jr',
    addressLine1: '88 Oak Ave',
    city: 'Brandon',
    state: 'FL',
    zip5: '33510',
    boxes: boxes({
      box1Wages: 75000,
      box2FitWithheld: 9000,
      box3SsWages: 75000,
      box4SsTax: 4650,
      box5MedicareWages: 75000,
      box6MedicareTax: 1087.5,
      stateLines: [{ state: 'FL', stateWages: 75000, stateIncomeTax: 0 }],
    }),
  },
];

const efw2: Efw2File = { submitter, employer, employees };

// EFW2C — pretend the second employee was under-reported by $1,000 in
// Box 1 / Box 3 / Box 5. Previous + corrected pair lets AccuWage walk
// every box in the RCW record without ambiguity.
const efw2c: Efw2cFile = {
  submitter,
  employer,
  employees: [
    {
      ...employees[1],
      previous: employees[1].boxes,
      corrected: boxes({
        box1Wages: 76000,
        box2FitWithheld: 9120,
        box3SsWages: 76000,
        box4SsTax: 4712,
        box5MedicareWages: 76000,
        box6MedicareTax: 1102,
        stateLines: [{ state: 'FL', stateWages: 76000, stateIncomeTax: 0 }],
      }),
    },
  ],
};

async function main() {
  const outDir = join(import.meta.dirname ?? __dirname, 'output');
  await mkdir(outDir, { recursive: true });

  const efw2Body = buildEfw2File(efw2);
  const efw2cBody = buildEfw2cFile(efw2c);

  const efw2Path = join(outDir, `sample-efw2-TY${TAX_YEAR}.txt`);
  const efw2cPath = join(outDir, `sample-efw2c-TY${TAX_YEAR}.txt`);

  // Encode CRLF + ASCII per SSA spec. writeFile defaults to utf8 which
  // is fine for the printable-ASCII subset our generator emits, but we
  // want the bytes to be exactly what BSO / AccuWage expect.
  await writeFile(efw2Path, efw2Body, { encoding: 'ascii' });
  await writeFile(efw2cPath, efw2cBody, { encoding: 'ascii' });

  const efw2Lines = efw2Body.split('\r\n');
  const efw2cLines = efw2cBody.split('\r\n');

  console.log(`[sample-efw2] wrote ${efw2Path}`);
  console.log(`[sample-efw2]   ${efw2Lines.length} records, every line ${efw2Lines[0].length} chars`);
  console.log(`[sample-efw2]   record types: ${efw2Lines.map((l) => l.slice(0, 2)).join(' ')}`);
  console.log('');
  console.log(`[sample-efw2] wrote ${efw2cPath}`);
  console.log(`[sample-efw2]   ${efw2cLines.length} records, every line ${efw2cLines[0].length} chars`);
  console.log(`[sample-efw2]   record types: ${efw2cLines.map((l) => l.slice(0, 3)).join(' ')}`);
  console.log('');
  console.log('Next step: upload both files to https://www.ssa.gov/employer/accuwage/');
  console.log('Paste the AccuWage report into the Phase 7 review thread so any');
  console.log('field-position mismatches get fixed before a real BSO submission.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
