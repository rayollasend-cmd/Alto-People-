import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import ExcelJS from 'exceljs';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The pre-payroll review: the report an accountant reads before a run pays
 * out, the sign-off pinned to those exact numbers, and the payout gate.
 */

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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

/** Two people at a client, approved time in the week of Apr 13, 2026. Maria also has an earlier, paid check. */
async function seedPeople() {
  const client = await createClient();
  const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const sam = await createAssociate({ firstName: 'Sam', lastName: 'Okafor' });
  for (const a of [maria, sam]) {
    await prisma.associate.update({ where: { id: a.id }, data: { state: 'FL' } });
    await prisma.compensationRecord.create({ data: { associateId: a.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
  }
  // This week: Maria 30h, Sam 8h.
  for (let d = 13; d <= 17; d++) {
    await prisma.timeEntry.create({ data: { associateId: maria.id, clientId: client.id, clockInAt: new Date(`2026-04-${d}T12:00:00Z`), clockOutAt: new Date(`2026-04-${d}T18:00:00Z`), status: 'APPROVED' } });
  }
  await prisma.timeEntry.create({ data: { associateId: sam.id, clientId: client.id, clockInAt: new Date('2026-04-14T12:00:00Z'), clockOutAt: new Date('2026-04-14T20:00:00Z'), status: 'APPROVED' } });
  // Maria's last paycheck (the week before): 8 hours, already paid.
  const prior = await prisma.payrollRun.create({
    data: { clientId: client.id, periodStart: new Date('2026-04-06'), periodEnd: new Date('2026-04-12'), status: 'DISBURSED', kind: 'REGULAR', totalGross: 160, totalNet: 140, finalizedAt: new Date('2026-04-13T00:00:00Z'), disbursedAt: new Date('2026-04-17T00:00:00Z') },
  });
  await prisma.payrollItem.create({
    data: { payrollRunId: prior.id, associateId: maria.id, hoursWorked: 8, hourlyRate: 20, grossPay: 160, federalWithholding: 8, fica: 9.92, medicare: 2.32, netPay: 139.76, status: 'DISBURSED' },
  });
  return { client, maria, sam };
}

async function draftRun(agent: TestAgent<Test>, clientId: string): Promise<string> {
  const created = await agent.post('/payroll/runs').send({ clientId, periodStart: '2026-04-13', periodEnd: '2026-04-19' });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe('the review report', () => {
  it('every row adds up, the cash and taxes tie to the rows, and swings since last payroll lead', async () => {
    const { client } = await seedPeople();
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(finance.email);
    const runId = await draftRun(a, client.id);

    const res = await a.get(`/payroll/runs/${runId}/review`);
    expect(res.status).toBe(200);
    const { report, signoff } = res.body;
    expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.totals.people).toBe(2);
    for (const r of report.rows) {
      const out = r.federal + r.socialSecurity + r.medicare + r.stateTax + r.localTax + r.stateProgram + r.preTax + r.postTax + r.other;
      expect(Math.round((r.gross + r.reimbursements - out) * 100) / 100).toBeCloseTo(r.net, 2);
    }
    const net = report.rows.reduce((s: number, r: { net: number }) => s + r.net, 0);
    expect(report.totals.net).toBeCloseTo(net, 2);
    expect(report.cash.total).toBeCloseTo(report.totals.net + report.totals.employeeTaxes + report.totals.employerTaxes, 2);
    expect(report.taxes.total).toBeCloseTo(report.totals.employeeTaxes + report.totals.employerTaxes, 2);

    // Maria went from 8 to 30 hours: her net is up sharply, and she leads the list.
    expect(report.rows[0].name).toBe('Maria Lopez');
    expect(report.rows[0].flags).toContain('NET_UP');
    expect(report.rows[0].prior.net).toBeCloseTo(139.76, 2);
    // Sam has no earlier check.
    expect(report.rows.find((r: { name: string }) => r.name === 'Sam Okafor').flags).toContain('FIRST_PAYCHECK');
    expect(report.previous).toMatchObject({ periodEnd: '2026-04-12', people: 1 });
    expect(report.byState[0]).toMatchObject({ name: 'FL', people: 2 });

    // The only finance user created it: no one else exists, so they may sign it themselves.
    expect(signoff).toMatchObject({ required: true, current: null, stale: null, canSign: true });
  });

  it('downloads as a PDF and a workbook whose register totals the rows', async () => {
    const { client } = await seedPeople();
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(finance.email);
    const runId = await draftRun(a, client.id);

    const pdf = await a.get(`/payroll/runs/${runId}/review.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('payroll-review-2026-04-13-to-2026-04-19.pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const xlsx = await a.get(`/payroll/runs/${runId}/review.xlsx`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(xlsx.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Register', 'To look at', 'By department', 'By state']);
    const reg = wb.getWorksheet('Register')!;
    expect(reg.getRow(2).getCell(1).value).toBe('Maria Lopez');
    expect(String(reg.getRow(4).getCell(1).value)).toMatch(/^Total · 2 people/);
  });
});

describe('the sign-off', () => {
  it('a second person signs; the creator cannot while one exists; payout waits for it', async () => {
    const { client } = await seedPeople();
    const { user: maker } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'maker@example.com' });
    const { user: checker } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'checker@example.com' });
    const a = await loginAs(maker.email);
    const b = await loginAs(checker.email);
    const runId = await draftRun(a, client.id);
    expect((await a.post(`/payroll/runs/${runId}/finalize`)).status).toBe(200);

    // Not signed: the payout is refused and the close says why.
    const early = await a.post(`/payroll/runs/${runId}/disburse`).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('review_required');
    const close = await a.get(`/payroll/runs/${runId}/close`);
    const steps = Object.fromEntries(close.body.steps.map((s: { key: string; state: string }) => [s.key, s.state]));
    expect(steps.review).toBe('current');
    expect(steps.disburse).toBe('blocked');

    // The checker sees it waiting in their inbox; the maker doesn't.
    const inbox = await b.get('/me/inbox');
    expect(inbox.body.sources.find((x: { key: string }) => x.key === 'payroll-review')?.count).toBe(1);
    expect((await b.get('/payroll/reviews')).body.waiting).toHaveLength(1);
    expect((await a.get('/payroll/reviews')).body.waiting).toHaveLength(0);

    const report = (await a.get(`/payroll/runs/${runId}/review`)).body;
    expect(report.signoff.canSign).toBe(false);
    const self = await a.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: report.report.fingerprint });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('self_review');

    const signed = await b.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: report.report.fingerprint, note: 'Tied out to the time report.' });
    expect(signed.status).toBe(201);
    // A name, never the email (deep audit MONEY-25); the email rides beside it.
    expect(signed.body.signoff).toMatchObject({ signedByName: 'Checker', signedByEmail: 'checker@example.com', note: 'Tied out to the time report.', soleReviewer: false });
    const again = await b.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: report.report.fingerprint });
    expect(again.body.error.code).toBe('already_signed');
    expect((await b.get('/payroll/reviews')).body.waiting).toHaveLength(0);

    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.approvedById).toBe(checker.id);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'payroll.review_signed', entityId: runId } });
    expect(audit).not.toBeNull();

    const paid = await a.post(`/payroll/runs/${runId}/disburse`).send({});
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('DISBURSED');
  });

  it('a change to any paycheck after the sign-off makes it stale, and payout waits for a new one', async () => {
    const { client } = await seedPeople();
    const { user: maker } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'maker@example.com' });
    const { user: checker } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'checker@example.com' });
    const a = await loginAs(maker.email);
    const b = await loginAs(checker.email);
    const runId = await draftRun(a, client.id);
    expect((await a.post(`/payroll/runs/${runId}/finalize`)).status).toBe(200);
    const fp = (await b.get(`/payroll/runs/${runId}/review`)).body.report.fingerprint;
    expect((await b.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: fp })).status).toBe(201);

    // Someone changes Sam's check after the sign-off.
    const sam = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: runId, associate: { firstName: 'Sam' } } });
    await prisma.payrollItem.update({ where: { id: sam.id }, data: { grossPay: Number(sam.grossPay) + 50, netPay: Number(sam.netPay) + 50 } });

    const status = (await a.get(`/payroll/runs/${runId}/review/status`)).body;
    expect(status.signoff.current).toBeNull();
    expect(status.signoff.stale).toMatchObject({ signedByName: 'Checker' });
    const blocked = await a.post(`/payroll/runs/${runId}/disburse`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('review_stale');
    const close = await a.get(`/payroll/runs/${runId}/close`);
    expect(close.body.steps.find((s: { key: string }) => s.key === 'review')).toMatchObject({ state: 'blocked', blockers: 1 });

    // Signing the old version is refused: the reviewer reloads and reads the new numbers.
    expect((await b.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: fp })).body.error.code).toBe('review_changed');
    const fresh = (await b.get(`/payroll/runs/${runId}/review`)).body.report.fingerprint;
    expect(fresh).not.toBe(fp);
    expect((await b.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: fresh })).status).toBe(201);
    expect((await a.post(`/payroll/runs/${runId}/disburse`).send({})).status).toBe(200);
  });

  it('the only person who processes payroll signs their own run, and the record says so', async () => {
    const { client } = await seedPeople();
    const { user: solo } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'solo@example.com' });
    const a = await loginAs(solo.email);
    const runId = await draftRun(a, client.id);
    // A draft can be signed; finalizing doesn't change the numbers, so the sign-off holds.
    const fp = (await a.get(`/payroll/runs/${runId}/review`)).body.report.fingerprint;
    const signed = await a.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: fp });
    expect(signed.status).toBe(201);
    expect(signed.body.signoff.soleReviewer).toBe(true);
    expect((await a.post(`/payroll/runs/${runId}/finalize`)).status).toBe(200);
    expect((await a.get(`/payroll/runs/${runId}/review/status`)).body.signoff.current).not.toBeNull();
    expect((await a.post(`/payroll/runs/${runId}/disburse`).send({})).status).toBe(200);
  });

  it('approving from the run list is the same sign-off, with the same second-person rule', async () => {
    const { client } = await seedPeople();
    const { user: maker } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'maker@example.com' });
    const { user: checker } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'checker@example.com' });
    const a = await loginAs(maker.email);
    const b = await loginAs(checker.email);
    const runId = await draftRun(a, client.id);
    expect((await a.post(`/payroll/runs/${runId}/finalize`)).status).toBe(200);
    expect((await a.post(`/payroll/runs/${runId}/approve`)).body.error.code).toBe('self_review');
    const ok = await b.post(`/payroll/runs/${runId}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.approvedAt).not.toBeNull();
    expect((await a.get(`/payroll/runs/${runId}/review/status`)).body.signoff.current.signedByName).toBe('Checker');
  });

  it('with the switch off, or for a daily settlement, nothing waits on a sign-off', async () => {
    const { client } = await seedPeople();
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: other } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    void other;
    const a = await loginAs(finance.email);
    const runId = await draftRun(a, client.id);
    expect((await a.post(`/payroll/runs/${runId}/finalize`)).status).toBe(200);

    await prisma.orgSetting.upsert({ where: { tenantId: '00000000-0000-4000-8000-000000000001' }, create: { tenantId: '00000000-0000-4000-8000-000000000001', payrollReviewRequired: false }, update: { payrollReviewRequired: false } });
    const status = (await a.get(`/payroll/runs/${runId}/review/status`)).body;
    expect(status.signoff.required).toBe(false);
    expect((await a.get(`/payroll/runs/${runId}/close`)).body.steps.find((s: { key: string }) => s.key === 'review').state).toBe('skip');
    expect((await a.post(`/payroll/runs/${runId}/disburse`).send({})).status).toBe(200);

    // Daily settlements are automatic: exempt even with the switch on.
    await prisma.orgSetting.update({ where: { tenantId: '00000000-0000-4000-8000-000000000001' }, data: { payrollReviewRequired: true } });
    const daily = await prisma.payrollRun.create({ data: { clientId: client.id, periodStart: new Date('2026-04-20'), periodEnd: new Date('2026-04-20'), status: 'FINALIZED', kind: 'DAILY' } });
    expect((await a.get(`/payroll/runs/${daily.id}/review/status`)).body.signoff.required).toBe(false);
  });

  it('only payroll can read or sign it', async () => {
    const { client } = await seedPeople();
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const runId = await draftRun(await loginAs(finance.email), client.id);
    const w = await loginAs(assoc.email);
    expect((await w.get(`/payroll/runs/${runId}/review`)).status).toBe(403);
    expect((await w.post(`/payroll/runs/${runId}/review/sign`).send({ fingerprint: 'a'.repeat(64) })).status).toBe(403);
  });
});
