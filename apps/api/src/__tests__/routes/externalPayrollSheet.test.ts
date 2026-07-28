import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import ExcelJS from 'exceljs';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The external payroll sheet is the most sensitive artefact the product
 * produces: full SSN next to full bank account and routing number, per
 * worker, in a downloadable file. These tests pin the three things that make
 * it safe to ship — who can reach it, that the numbers survive Excel intact,
 * and that every generation is recorded.
 */

function binaryParser(res: Test, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.EventEmitter).on('data', (c: Buffer) =>
    chunks.push(Buffer.from(c)),
  );
  (res as unknown as NodeJS.EventEmitter).on('end', () =>
    cb(null, Buffer.concat(chunks)),
  );
}

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const RANGE = {
  from: '2026-06-15T00:00:00.000Z',
  to: '2026-06-22T00:00:00.000Z',
};

/** An associate with a complete payroll record: W-4 + SSN, bank, comp, hours. */
async function seedComplete(clientId: string) {
  const associate = await createAssociate({ firstName: 'Ada', lastName: 'Byron' });
  await prisma.associate.update({
    where: { id: associate.id },
    data: {
      dob: new Date('1990-03-04'),
      phone: '555-0100',
      addressLine1: '12 Mill Lane',
      city: 'Tampa',
      state: 'FL',
      zip: '33602',
    },
  });
  await prisma.w4Submission.create({
    data: {
      associateId: associate.id,
      filingStatus: 'SINGLE',
      // Leading zero on purpose — the classic Excel truncation case.
      ssnEncrypted: encryptString('012-34-5678'),
    },
  });
  await prisma.payoutMethod.create({
    data: {
      associateId: associate.id,
      type: 'BANK_ACCOUNT',
      accountType: 'CHECKING',
      bankName: 'Chase',
      isPrimary: true,
      // Plain UTF-8, matching what the direct-deposit route actually writes —
      // routing numbers are public so they aren't encrypted, despite the
      // column name. Seeding this as ciphertext (as this fixture first did)
      // hides a reader that decrypts instead of decoding.
      routingNumberEnc: Buffer.from('021000021', 'utf8'),
      accountNumberEnc: encryptString('000123456789012'),
    },
  });
  await prisma.compensationRecord.create({
    data: {
      associateId: associate.id,
      amount: 25,
      payType: 'HOURLY',
      // effectiveFrom and reason are both required on CompensationRecord.
      // effectiveTo stays null so the sheet's "current wage" lookup
      // (effectiveTo: null) picks this row up.
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      reason: 'HIRE',
    },
  });
  const clockInAt = new Date('2026-06-15T09:00:00.000Z');
  await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId,
      clockInAt,
      clockOutAt: new Date(clockInAt.getTime() + 8 * 3600_000),
      status: 'APPROVED',
    },
  });
  return associate;
}

describe('external payroll sheet — access', () => {
  it('is reachable by HR_ADMINISTRATOR', async () => {
    const client = await createClient();
    await seedComplete(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('external-payroll-2026-06-15');
  });

  // The whole reason this capability exists. SHIFT_SUPERVISOR holds
  // manage:time (the Time router's usual guard), so if this sheet had reused
  // MANAGE, every floor supervisor could pull their client's SSNs.
  it('is forbidden to SHIFT_SUPERVISOR despite manage:time', async () => {
    const client = await createClient();
    await seedComplete(client.id);
    const { user } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const a = await loginAs(user.email);

    for (const fmt of ['xlsx', 'pdf']) {
      const res = await a
        .post(`/time/admin/external-payroll-sheet.${fmt}`)
        .send({ ...RANGE, clientId: client.id });
      expect(res.status).toBe(403);
    }
  });

  it.each(['OPERATIONS_MANAGER', 'MANAGER', 'MARKETING_MANAGER', 'FINANCE_ACCOUNTANT'] as const)(
    'is forbidden to %s',
    async (role) => {
      const client = await createClient();
      await seedComplete(client.id);
      const { user } = await createUser({ role });
      const a = await loginAs(user.email);

      const res = await a
        .post('/time/admin/external-payroll-sheet.xlsx')
        .send({ ...RANGE, clientId: client.id });
      expect(res.status).toBe(403);
    },
  );
});

describe('external payroll sheet — content', () => {
  it('keeps SSN, routing and account numbers as text with leading zeros', async () => {
    const client = await createClient();
    await seedComplete(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id })
      .buffer()
      .parse(binaryParser);

    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('External Payroll');
    expect(ws).toBeTruthy();

    // Find the data row by the employee name, then read across it.
    let dataRow: ExcelJS.Row | null = null;
    ws!.eachRow((row) => {
      if (row.getCell(1).value === 'Ada Byron') dataRow = row;
    });
    expect(dataRow).toBeTruthy();

    const cellText = (col: number) => String(dataRow!.getCell(col).value ?? '');
    // Column order comes from EXTERNAL_PAYROLL_COLUMNS.
    expect(cellText(3)).toBe('1990-03-04'); // DOB
    expect(cellText(4)).toBe('012-34-5678'); // SSN, leading zero intact
    expect(cellText(11)).toBe('021000021'); // routing, leading zero intact
    expect(cellText(12)).toBe('000123456789012'); // account, no sci-notation
    expect(cellText(9)).toBe('Chase'); // bank name from the payout method
    expect(dataRow!.getCell(15).value).toBe(8); // regular hours
  });

  // Regression: the first version of the reader ran routingNumberEnc through
  // tryDecryptString. Routing numbers are stored as plain UTF-8 (they're
  // public), so that returned null for every real record — blanking the
  // column and inflating missingBankDetails on a file whose entire purpose
  // is to carry routing numbers to a bank.
  it('reads a plaintext routing number without counting it as a gap', async () => {
    const client = await createClient();
    await seedComplete(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id });

    expect(res.status).toBe(200);
    const gaps = JSON.parse(res.headers['x-sheet-gaps']);
    expect(gaps.missingBankDetails).toBe(0);
  });

  // The two writers disagree: onboarding stores the routing number as plain
  // UTF-8, self-service stores ciphertext. Rows exist in both formats, so
  // the sheet has to read both or it blanks the column for half the roster.
  it('reads an encrypted routing number too (self-service format)', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Enc', lastName: 'Format' });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('111-22-3333'),
      },
    });
    await prisma.payoutMethod.create({
      data: {
        associateId: associate.id,
        type: 'BANK_ACCOUNT',
        accountType: 'CHECKING',
        isPrimary: true,
        routingNumberEnc: encryptString('021000021'),
        accountNumberEnc: encryptString('55554444'),
      },
    });
    await prisma.compensationRecord.create({
      data: {
        associateId: associate.id,
        amount: 20,
        payType: 'HOURLY',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        reason: 'HIRE',
      },
    });
    const clockInAt = new Date('2026-06-17T09:00:00.000Z');
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt,
        clockOutAt: new Date(clockInAt.getTime() + 4 * 3600_000),
        status: 'APPROVED',
      },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id })
      .buffer()
      .parse(binaryParser);

    expect(res.status).toBe(200);
    const gaps = JSON.parse(res.headers['x-sheet-gaps']);
    expect(gaps.missingBankDetails).toBe(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('External Payroll');
    let dataRow: ExcelJS.Row | null = null;
    ws!.eachRow((row) => {
      if (row.getCell(1).value === 'Enc Format') dataRow = row;
    });
    expect(String(dataRow!.getCell(11).value)).toBe('021000021');
  });

  it('counts gaps instead of silently shipping blank cells', async () => {
    const client = await createClient();
    // No W-4, no payout method, no compensation record.
    const bare = await createAssociate({ firstName: 'Gap', lastName: 'Case' });
    const clockInAt = new Date('2026-06-16T09:00:00.000Z');
    await prisma.timeEntry.create({
      data: {
        associateId: bare.id,
        clientId: client.id,
        clockInAt,
        clockOutAt: new Date(clockInAt.getTime() + 6 * 3600_000),
        status: 'APPROVED',
      },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.headers['x-employee-count']).toBe('1');
    const gaps = JSON.parse(res.headers['x-sheet-gaps']);
    expect(gaps.missingW4).toBe(1);
    expect(gaps.missingBankDetails).toBe(1);
    expect(gaps.missingPayRate).toBe(1);
  });

  it('never caches the response', async () => {
    const client = await createClient();
    await seedComplete(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/external-payroll-sheet.pdf')
      .send({ ...RANGE, clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('external payroll sheet — audit', () => {
  it('records who exported what before sending the file', async () => {
    const client = await createClient();
    await seedComplete(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id });
    expect(res.status).toBe(200);

    await flushPendingAudits();
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'payroll.external_sheet_exported' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect(entry!.actorUserId).toBe(user.id);
    expect(entry!.clientId).toBe(client.id);
    const meta = entry!.metadata as Record<string, unknown>;
    expect(meta.format).toBe('xlsx');
    expect(meta.employeeCount).toBe(1);
    // The counts that make the record meaningful in a breach review.
    expect(meta.includedFullSsn).toBe(1);
    expect(meta.includedBankAccounts).toBe(1);
  });

  it('records a failed-access attempt as a 403 with no audit row', async () => {
    const client = await createClient();
    await seedComplete(client.id);
    const { user } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const a = await loginAs(user.email);

    await a
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id })
      .expect(403);

    await flushPendingAudits();
    const count = await prisma.auditLog.count({
      where: { action: 'payroll.external_sheet_exported' },
    });
    // The capability guard rejects before the handler runs, so nothing was
    // exported and there is nothing to record.
    expect(count).toBe(0);
  });
});
