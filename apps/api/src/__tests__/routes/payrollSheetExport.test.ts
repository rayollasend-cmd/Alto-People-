import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

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
