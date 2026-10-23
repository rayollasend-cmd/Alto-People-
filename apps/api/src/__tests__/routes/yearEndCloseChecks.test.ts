// F500 G3 — the year-end close checklist.
//
// A tax year with no one eligible for a W-2 or 1099 has nothing to file or
// send, so "All generated forms filed" and "Recipient copies sent" are done
// for it — before, they stayed open forever and such a year could never
// close. The details read in plain words ("1 run is still open"), not
// "run(s)" or raw status codes.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function finance() {
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const a = request.agent(createApp());
  expect((await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
  return a;
}

type Check = { key: string; done: boolean; detail: string; href: string };
const byKey = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.key, c]));

describe('GET /payroll/year-end-close', () => {
  it('a year with nothing to file can close: the filing and copy steps are done, in plain words', async () => {
    const a = await finance();
    const r = await a.get('/payroll/year-end-close?year=2024');
    expect(r.status).toBe(200);
    const c = byKey(r.body.checks);
    expect(c.forms_filed).toMatchObject({ done: true, detail: 'Nothing to file for 2024.', href: '/payroll/year-end?tab=forms' });
    expect(c.copies_sent).toMatchObject({ done: true, detail: 'No recipient copies to send for 2024.' });
    expect(c.runs_disbursed).toMatchObject({ done: true, detail: 'No payroll run in 2024 is still waiting to be paid.' });
    expect(c.w2_generated.detail).toBe('No one was paid wages in 2024, so no W-2s are due.');
    expect(r.body.readyToClose).toBe(true);
    // Never a raw status code or "(s)".
    for (const check of r.body.checks as Check[]) {
      expect(check.detail).not.toMatch(/\(s\)|DRAFT|FINALIZED|FILED/);
    }
  });

  it('an open run keeps the year open and says how many, pluralised', async () => {
    const a = await finance();
    await prisma.payrollRun.create({ data: { periodStart: new Date('2024-12-14T00:00:00Z'), periodEnd: new Date('2024-12-27T00:00:00Z'), status: 'DRAFT' } });
    const r = await a.get('/payroll/year-end-close?year=2024');
    const c = byKey(r.body.checks);
    expect(c.runs_disbursed).toMatchObject({ done: false, detail: '1 run is still open. Finalize and pay it before closing.' });
    expect(r.body.readyToClose).toBe(false);
  });
});
