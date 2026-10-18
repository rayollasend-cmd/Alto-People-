import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';
import { __resetStateAcknowledgmentsForTesting } from '../../lib/payrollTax.js';
import { __resetLocalAcknowledgmentsForTesting } from '../../lib/taxEngine/index.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Local and multi-state taxes end to end: the review gate blocks payroll,
 * a person's home jurisdiction answers the open question, a run persists
 * its taxes by jurisdiction, and the paycheck calculator.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  __resetStateAcknowledgmentsForTesting();
  __resetLocalAcknowledgmentsForTesting();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

const PERIOD = { periodStart: new Date('2026-04-04'), periodEndExclusive: new Date('2026-04-18'), clientId: null };

async function pittsburgher(opts: { city?: string; siteCity?: string; siteState?: string } = {}) {
  const client = await createClient('Steel Co');
  const site = await prisma.site.create({ data: { clientId: client.id, name: 'Strip District', state: opts.siteState ?? 'PA', city: opts.siteCity ?? 'Pittsburgh', zip: '15222' } });
  const a = await createAssociate({ firstName: 'Pat', lastName: 'Burgh' });
  await prisma.associate.update({ where: { id: a.id }, data: { state: 'PA', city: opts.city ?? 'Pittsburgh', employmentType: 'W2_EMPLOYEE' } });
  await prisma.w4Submission.create({ data: { associateId: a.id, filingStatus: 'SINGLE', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 } });
  await prisma.compensationRecord.create({ data: { associateId: a.id, payType: 'HOURLY', amount: 25, effectiveFrom: new Date('2026-01-01'), reason: 'HIRE' } });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
  const start = new Date('2026-04-06T13:00:00Z');
  for (let d = 0; d < 5; d++) {
    const at = new Date(start.getTime() + d * 86_400_000);
    await prisma.timeEntry.create({
      data: { associateId: a.id, clientId: client.id, locationId: site.id, clockInAt: at, clockOutAt: new Date(at.getTime() + 8 * 3_600_000), status: 'APPROVED', approvedAt: new Date() },
    });
  }
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
  return { a, client, site, h: await loginAs(hr.email) };
}

describe('local tax review gate', () => {
  it('blocks payroll until each jurisdiction is reviewed with the tax adviser', async () => {
    const { a, h } = await pittsburgher();

    const before = await computePayrollExceptions(prisma, PERIOD);
    const blocks = before.exceptions.filter((e) => e.kind === 'LOCAL_TAX_REVIEW');
    expect(blocks.map((b) => b.detail?.jurisdiction).sort()).toEqual(['PA-PITTSBURGH', 'PA-PITTSBURGH-LST']);
    expect(blocks.every((b) => b.severity === 'BLOCKING' && b.associateId === a.id)).toBe(true);

    const list = await h.get('/payroll/tax-jurisdictions');
    expect(list.status).toBe(200);
    const pgh = list.body.jurisdictions.find((j: { code: string }) => j.code === 'PA-PITTSBURGH');
    expect(pgh).toMatchObject({ workers: 1, review: { status: 'awaiting' }, confidence: 'medium', taxYear: 2026 });
    expect(list.body.counts).toMatchObject({ inUse: 2, awaitingInUse: 2, blockedWorkers: 1 });
    expect(list.body.engine).toMatchObject({ key: 'IN_HOUSE' });

    expect((await h.post('/payroll/tax-jurisdictions/PA-PITTSBURGH/acknowledge').send({})).status).toBe(400);
    expect((await h.post('/payroll/tax-jurisdictions/NOPE/acknowledge').send({ confirm: true })).status).toBe(400);
    for (const code of ['PA-PITTSBURGH', 'PA-PITTSBURGH-LST']) {
      expect((await h.post(`/payroll/tax-jurisdictions/${code}/acknowledge`).send({ confirm: true, note: 'Checked with our CPA' })).status).toBe(200);
    }
    const after = await computePayrollExceptions(prisma, PERIOD);
    expect(after.exceptions.filter((e) => e.kind === 'LOCAL_TAX_REVIEW')).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'payroll.local_tax_acknowledged' } })).toBe(2);

    const reviewed = await h.get('/payroll/tax-jurisdictions');
    expect(reviewed.body.counts).toMatchObject({ awaitingInUse: 0, blockedWorkers: 0 });

    expect((await h.delete('/payroll/tax-jurisdictions/PA-PITTSBURGH/acknowledge')).status).toBe(204);
    const again = await computePayrollExceptions(prisma, PERIOD);
    expect(again.exceptions.some((e) => e.kind === 'LOCAL_TAX_REVIEW' && e.detail?.jurisdiction === 'PA-PITTSBURGH')).toBe(true);
  });

  it('a Pennsylvania resident with no PSD code blocks until the residency certificate gives one', async () => {
    const { a, h } = await pittsburgher({ city: 'Smalltown' });
    const before = await computePayrollExceptions(prisma, PERIOD);
    expect(before.exceptions.find((e) => e.kind === 'LOCAL_TAX_UNRESOLVED')).toMatchObject({ severity: 'BLOCKING', detail: { question: 'PA_RESIDENT_PSD' } });

    const profile = await h.get(`/payroll/tax-profile/${a.id}`);
    expect(profile.status).toBe(200);
    expect(profile.body.unresolved[0]).toMatch(/PSD code/);

    expect((await h.post(`/payroll/tax-profile/${a.id}/certificates`).send({ kind: 'PA_RESIDENCY', state: 'PA' })).status).toBe(400);
    const saved = await h.post(`/payroll/tax-profile/${a.id}/certificates`).send({ kind: 'PA_RESIDENCY', state: 'PA', psdCode: '700102', signedOn: '2026-04-01' });
    expect(saved.status).toBe(201);
    expect(saved.body.profile.residentPsdCode).toBe('700102');
    expect(saved.body.certificates[0]).toMatchObject({ kind: 'PA_RESIDENCY', formName: 'PA residency certification' });
    expect(saved.body.unresolved).toEqual([]);
    const why = saved.body.withholding.find((w: { code: string }) => w.code === 'PA-PITTSBURGH');
    expect(why).toMatchObject({ resident: true, review: 'awaiting' });

    const after = await computePayrollExceptions(prisma, PERIOD);
    expect(after.exceptions.find((e) => e.kind === 'LOCAL_TAX_UNRESOLVED')).toBeUndefined();

    // A nonresidency certificate only means something where there's reciprocity.
    expect((await h.post(`/payroll/tax-profile/${a.id}/certificates`).send({ kind: 'NONRESIDENCY', state: 'TX' })).status).toBe(400);
    const cert = saved.body.certificates[0].id as string;
    expect((await h.delete(`/payroll/tax-profile/${a.id}/certificates/${cert}`)).status).toBe(204);
  });

  it('a local rule set by hand replaces the engine’s locals and the gate', async () => {
    const { a } = await pittsburgher();
    const rule = await prisma.localTaxRule.create({ data: { state: 'PA', name: 'Custom EIT', rate: 0.02, isActive: true } });
    await prisma.associate.update({ where: { id: a.id }, data: { localTaxRuleId: rule.id } });
    const ex = await computePayrollExceptions(prisma, PERIOD);
    expect(ex.exceptions.filter((e) => e.kind.startsWith('LOCAL_TAX'))).toEqual([]);
  });
});

describe('a run’s taxes by jurisdiction', () => {
  it('persists the lines and adds them up by jurisdiction', async () => {
    const { h } = await pittsburgher();
    const run = await h.post('/payroll/runs').send({ periodStart: '2026-04-04', periodEnd: '2026-04-17' });
    expect(run.status).toBe(201);
    const item = run.body.items[0];
    // 40h × $25 = $1,000: Pittsburgh EIT 3% and the $52 LST over 26 checks.
    expect(item.grossPay).toBe(1000);
    const row = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(row.localWithholding)).toBeCloseTo(32, 2);
    const lines = await prisma.payrollItemTaxLine.findMany({ where: { payrollItemId: item.id } });
    expect(lines.map((l) => l.code).sort()).toEqual(['PA-PITTSBURGH', 'PA-PITTSBURGH-LST', 'ST-PA', 'SUI-PA']);
    expect(Number(lines.find((l) => l.code === 'ST-PA')!.amount)).toBeCloseTo(item.stateWithholding, 2);

    const by = await h.get(`/payroll/runs/${run.body.id}/tax-lines`);
    expect(by.status).toBe(200);
    expect(by.body.totals).toMatchObject({ local: 32, employer: 0 });
    expect(by.body.jurisdictions[0]).toMatchObject({ kind: 'STATE', code: 'ST-PA', people: 1 });

    // Re-aggregating replaces, never duplicates.
    const bonus = await h.post(`/payroll/runs/${run.body.id}/add-ons`).send({ associateId: item.associateId, kind: 'BONUS', amount: 100 });
    expect(bonus.status).toBeLessThan(300);
    expect(await prisma.payrollItemTaxLine.count({ where: { payrollItem: { payrollRunId: run.body.id } } })).toBe(4);
  });
});

describe('the paycheck calculator and reference', () => {
  it('works out one check for a resident and a nonresident', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'calc@example.com' });
    const h = await loginAs(hr.email);
    const res = await h.get('/payroll/tax-jurisdictions/calculate').query({ code: 'PA-PHILADELPHIA', wages: 1000, resident: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.lines.find((l: { code: string }) => l.code === 'PA-PHILADELPHIA')).toMatchObject({ amount: 37.4, resident: true });
    const non = await h.get('/payroll/tax-jurisdictions/calculate').query({ code: 'PA-PHILADELPHIA', wages: 1000, resident: 'false' });
    expect(non.body.lines.find((l: { code: string }) => l.code === 'PA-PHILADELPHIA')).toMatchObject({ amount: 34.3, resident: false });
    const recip = await h.get('/payroll/tax-reciprocity');
    expect(recip.body.agreements.find((r: { workState: string }) => r.workState === 'NJ')).toMatchObject({ residentStates: ['PA'], form: 'NJ-165' });
  });

  it('needs payroll access', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE', email: 'w@example.com' });
    const w = await loginAs(user.email);
    expect((await w.get('/payroll/tax-jurisdictions')).status).toBe(403);
  });
});
