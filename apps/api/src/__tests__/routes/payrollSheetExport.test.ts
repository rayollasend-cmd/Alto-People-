import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import ExcelJS from 'exceljs';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

// supertest doesn't auto-buffer the xlsx content-type into a Buffer; collect
// the raw bytes so we can re-open the workbook and assert cell values.
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

async function timeEntry(
  associateId: string,
  clientId: string,
  dateYmd: string,
  hours: number,
  status: 'APPROVED' | 'COMPLETED',
) {
  const clockInAt = new Date(`${dateYmd}T09:00:00.000Z`);
  const clockOutAt = new Date(clockInAt.getTime() + hours * 60 * 60 * 1000);
  return prisma.timeEntry.create({
    data: { associateId, clientId, clockInAt, clockOutAt, status },
  });
}

const RANGE = {
  from: '2026-06-15T00:00:00.000Z',
  to: '2026-06-22T00:00:00.000Z', // end-exclusive (Mon..Sun)
};

describe('POST /time/admin/payroll-sheet.xlsx', () => {
  it('returns an .xlsx attachment for APPROVED time in range', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    await timeEntry(associate.id, client.id, '2026-06-15', 9, 'APPROVED');

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(
      'spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toContain('payroll-sheet-2026-06-15');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    // A 200 with the xlsx content-type means the workbook rendered without
    // throwing (a render error would surface as a 500 here).
  });

  it('flags pending (COMPLETED) entries via X-Pending and still returns 200', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    await timeEntry(associate.id, client.id, '2026-06-15', 9, 'APPROVED');
    await timeEntry(associate.id, client.id, '2026-06-16', 9, 'COMPLETED');

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.headers['x-pending']).toBe('1');
  });
});

describe('POST /time/admin/payroll-sheet.pdf', () => {
  it('returns a PDF attachment', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    await timeEntry(associate.id, client.id, '2026-06-15', 9, 'APPROVED');

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post('/time/admin/payroll-sheet.pdf')
      .send({ ...RANGE, clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('rejects an invalid range with 400', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.post('/time/admin/payroll-sheet.pdf').send({
      from: '2026-06-22T00:00:00.000Z',
      to: '2026-06-15T00:00:00.000Z',
    });
    expect(res.status).toBe(400);
  });

  it('denies a user without manage:time', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    const a = await loginAs(user.email);
    const res = await a.post('/time/admin/payroll-sheet.pdf').send(RANGE);
    expect(res.status).toBe(403);
  });
});

describe('payroll-sheet earnings (rate / gross / net, Florida taxes)', () => {
  it('computes gross from the comp-record wage and $0 state tax for a FL client', async () => {
    // Florida client (no state income tax).
    const client = await prisma.client.create({
      data: {
        name: 'FL Grocer',
        state: 'FL',
        status: 'ACTIVE',
        locations: { create: { name: 'Store 1' } },
      },
    });
    const associate = await createAssociate({ firstName: 'Ann', lastName: 'Lee' });
    // Current hourly wage = $20/hr.
    await prisma.compensationRecord.create({
      data: {
        associateId: associate.id,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        payType: 'HOURLY',
        amount: 20,
        reason: 'HIRE',
      },
    });
    // Mon–Fri, 9h each = 45h in one ISO week → 40 regular / 5 OT.
    for (const day of ['15', '16', '17', '18', '19']) {
      const clockInAt = new Date(`2026-06-${day}T09:00:00.000Z`);
      await prisma.timeEntry.create({
        data: {
          associateId: associate.id,
          clientId: client.id,
          clockInAt,
          clockOutAt: new Date(clockInAt.getTime() + 9 * 3600 * 1000),
          status: 'APPROVED',
        },
      });
    }

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a
      .post('/time/admin/payroll-sheet.xlsx')
      .send({ ...RANGE, clientId: client.id })
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Summary')!;
    // Locate Ann's row by name in column 1.
    let row: ExcelJS.Row | null = null;
    ws.eachRow((r) => {
      if (String(r.getCell(1).value) === 'Ann Lee') row = r;
    });
    expect(row).not.toBeNull();
    const get = (c: number) => Number((row as unknown as ExcelJS.Row).getCell(c).value);
    // Cols: 1 name, 2 reg, 3 ot, 4 total, 5 rate, 6 gross, 7 fed, 8 ss, 9 medicare, 10 state, 11 net
    expect(get(2)).toBeCloseTo(40, 2); // regular hours
    expect(get(3)).toBeCloseTo(5, 2); // overtime hours
    expect(get(5)).toBeCloseTo(20, 2); // pay rate
    // Gross = 40×20 + 5×20×1.5 = 950
    expect(get(6)).toBeCloseTo(950, 2);
    // FICA 6.2% and Medicare 1.45% of gross.
    expect(get(8)).toBeCloseTo(58.9, 2);
    expect(get(9)).toBeCloseTo(13.78, 2);
    // Florida → no state income tax.
    expect(get(10)).toBe(0);
    // Net reconciles: gross − fed − ss − medicare − state.
    const fed = get(7);
    expect(get(11)).toBeCloseTo(950 - fed - 58.9 - 13.78 - 0, 1);
    expect(get(11)).toBeLessThan(950);
  });
});
