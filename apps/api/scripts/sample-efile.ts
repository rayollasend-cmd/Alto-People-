// Generates sample EFW2 + EFW2C + IRS FIRE files from synthetic data
// so finance can upload them to the official validators and get
// positional reports. CI can't run these validators; they're the
// authoritative cross-checks for each spec.
//
//   AccuWage Online (W-2 / W-2c)  →  Pub 42-007 + 42-014
//   IRS FIRE Test System (1099)   →  Pub 1220
//
// Run from repo root:
//   npx tsx apps/api/scripts/sample-efile.ts
//
// Files write to apps/api/scripts/output/. Validators:
//   EFW2 / EFW2C  →  https://www.ssa.gov/employer/accuwage/
//   IRS FIRE      →  https://fire.test.irs.gov  (TCC + login required)
//
// All values are synthetic — fake EIN, fake SSNs, fake names.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEfw2File, type Efw2File } from '../src/lib/efw2.js';
import { buildEfw2cFile, type Efw2cFile } from '../src/lib/efw2c.js';
import { buildIrsFireFile, type IrsFireFile } from '../src/lib/irsFire.js';
import type { W2Boxes } from '../src/lib/w2Aggregator.js';
import type { Form1099NecBoxes } from '../src/lib/f1099NecAggregator.js';

const TAX_YEAR = 2024;

const ssaSubmitter = {
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

function w2Boxes(over: Partial<W2Boxes> = {}): W2Boxes {
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

function necBoxes(over: Partial<Form1099NecBoxes> = {}): Form1099NecBoxes {
  return {
    box1NonemployeeCompensation: 5000,
    box2DirectSales: false,
    box4FitWithheld: 0,
    stateLines: [],
    sourceItemCount: 1,
    ...over,
  };
}

const w2Employees = [
  {
    ssn: '111223333',
    firstName: 'Pat',
    lastName: 'Sample',
    addressLine1: '12 Maple St',
    city: 'Tampa',
    state: 'FL',
    zip5: '33602',
    boxes: w2Boxes(),
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
    boxes: w2Boxes({
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

const efw2: Efw2File = { submitter: ssaSubmitter, employer, employees: w2Employees };

// EFW2C — pretend the second employee was under-reported by $1,000 in
// Box 1 / 3 / 5. Previous + corrected pair lets AccuWage walk every
// box in the RCW record.
const efw2c: Efw2cFile = {
  submitter: ssaSubmitter,
  employer,
  employees: [
    {
      ...w2Employees[1],
      previous: w2Employees[1].boxes,
      corrected: w2Boxes({
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

// IRS FIRE — sibling sample for 1099-NEC. Two contractors: an
// individual (SSN, no backup withholding) and a business (EIN, with
// backup withholding to exercise the Box 4 path).
const irsFire: IrsFireFile = {
  transmitter: {
    tcc: 'AB123',
    ein: ssaSubmitter.ein,
    name: ssaSubmitter.name,
    contactName: ssaSubmitter.contactName,
    contactPhone: ssaSubmitter.contactPhone,
    contactEmail: ssaSubmitter.contactEmail,
    taxYear: TAX_YEAR,
  },
  payer: {
    ein: employer.ein,
    name: employer.name,
    addressLine1: employer.addressLine1,
    city: employer.city,
    state: employer.state,
    zip5: employer.zip5,
  },
  payees: [
    {
      tin: '111223333',
      tinTypeCode: '1',
      name: 'Sam Contractor-Sample',
      addressLine1: '5 Pine St',
      city: 'Tampa',
      state: 'FL',
      zip5: '33602',
      accountNumber: 'NEC000000001',
      boxes: necBoxes({ box1NonemployeeCompensation: 5000 }),
    },
    {
      tin: '987654321',
      tinTypeCode: '2',
      name: 'Test Vendor Co LLC',
      addressLine1: '100 Commerce Dr',
      city: 'Brandon',
      state: 'FL',
      zip5: '33510',
      accountNumber: 'NEC000000002',
      boxes: necBoxes({
        box1NonemployeeCompensation: 12000,
        box4FitWithheld: 2880, // 24% backup withholding (no W-9)
      }),
    },
  ],
};

async function main() {
  const outDir = join(import.meta.dirname ?? __dirname, 'output');
  await mkdir(outDir, { recursive: true });

  const efw2Body = buildEfw2File(efw2);
  const efw2cBody = buildEfw2cFile(efw2c);
  const fireBody = buildIrsFireFile(irsFire);

  const efw2Path = join(outDir, `sample-efw2-TY${TAX_YEAR}.txt`);
  const efw2cPath = join(outDir, `sample-efw2c-TY${TAX_YEAR}.txt`);
  const firePath = join(outDir, `sample-irs-fire-1099nec-TY${TAX_YEAR}.txt`);

  // ASCII per all three specs (no UTF-8 BOM, no smart quotes).
  await writeFile(efw2Path, efw2Body, { encoding: 'ascii' });
  await writeFile(efw2cPath, efw2cBody, { encoding: 'ascii' });
  await writeFile(firePath, fireBody, { encoding: 'ascii' });

  const summarise = (label: string, path: string, body: string, idLen: number) => {
    const lines = body.split('\r\n');
    console.log(`[sample-efile] wrote ${path}`);
    console.log(
      `[sample-efile]   ${lines.length} records, every line ${lines[0].length} chars`,
    );
    console.log(
      `[sample-efile]   record types: ${lines.map((l) => l.slice(0, idLen)).join(' ')}`,
    );
    console.log('');
  };

  summarise('EFW2', efw2Path, efw2Body, 2);
  summarise('EFW2C', efw2cPath, efw2cBody, 3);
  summarise('IRS FIRE', firePath, fireBody, 1);

  console.log('Validators:');
  console.log('  EFW2 / EFW2C  →  https://www.ssa.gov/employer/accuwage/');
  console.log('  IRS FIRE      →  https://fire.test.irs.gov   (TCC + FIRE login required)');
  console.log('');
  console.log('Paste each report into the review thread so any field-position');
  console.log('mismatches get fixed before a real production submission.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
