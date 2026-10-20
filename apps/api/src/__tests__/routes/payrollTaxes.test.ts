import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { depositDue, federalHolidays, periodBounds, quarterlyDueDate, rollToBusinessDay } from '../../lib/payrollTaxCalendar.js';
import { postLiabilitiesForRun, postingsFor, payrollTaxesNeedingYou } from '../../lib/payrollTaxLedger.js';

/**
 * Full-service payroll tax: the calendar, the liability ledger each paid
 * run posts, payments (in house and through a mocked embedded provider,
 * behind a second person), returns generated from the ledger, amendments,
 * reconciliation, agency accounts, registrations and agency notices. No
 * test reaches a real vendor.
 */

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

type Route = { match: RegExp; method?: string; reply: (url: string, init: RequestInit) => { status?: number; body: unknown } };
let routes: Route[] = [];
const calls: Array<{ url: string; method: string; body: string | null }> = [];

beforeEach(async () => {
  await truncateAll();
  routes = [];
  calls.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : null });
    const hit = routes.find((r) => r.match.test(url) && (!r.method || r.method === method));
    if (!hit) throw new Error(`unmocked provider call: ${method} ${url}`);
    const out = hit.reply(url, init);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function payrollAdmin(email = `pay-${Math.random().toString(36).slice(2, 7)}@example.com`) {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email });
  return { user, a: await loginAs(agent(), user.email) };
}

/** A paid run: two people in CA and one in TX, paid on `paidOn`. */
async function paidRun(paidOn: string, opts: { gross?: number } = {}) {
  const client = await createClient();
  const gross = opts.gross ?? 1000;
  const people = [
    { first: 'Ana', last: 'Rios', state: 'CA', ssn: '123456789' },
    { first: 'Ben', last: 'Cole', state: 'CA', ssn: null },
    { first: 'Cy', last: 'Diaz', state: 'TX', ssn: '987654321' },
  ];
  const run = await prisma.payrollRun.create({
    data: { clientId: client.id, periodStart: D(paidOn), periodEnd: D(paidOn), status: 'DISBURSED', finalizedAt: D(paidOn), disbursedAt: new Date(`${paidOn}T15:00:00Z`) },
  });
  for (const p of people) {
    const associate = await prisma.associate.create({ data: { firstName: p.first, lastName: p.last, email: `${p.first.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}@example.com`, state: p.state, ssnLast4: p.ssn ? p.ssn.slice(-4) : null } });
    if (p.ssn) await prisma.w4Submission.create({ data: { associateId: associate.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString(p.ssn) } });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId: associate.id,
        hoursWorked: 40,
        hourlyRate: gross / 40,
        grossPay: gross,
        federalWithholding: 100,
        fica: 62,
        medicare: 14.5,
        employerFica: 62,
        employerMedicare: 14.5,
        employerFuta: 6,
        employerSuta: p.state === 'CA' ? 34 : 27,
        stateWithholding: p.state === 'CA' ? 30 : 0,
        netPay: gross - 206.5,
        taxState: p.state,
        status: 'DISBURSED',
      },
    });
  }
  return run;
}

describe('the payroll-tax calendar', () => {
  it('rolls weekends and federal holidays forward and dates each schedule', () => {
    expect(federalHolidays(2026).has('2026-11-26')).toBe(true); // Thanksgiving
    expect(federalHolidays(2027).has('2027-07-05')).toBe(true); // July 4 on a Sunday, observed Monday
    expect(ymd(rollToBusinessDay(D('2026-10-17')))).toBe('2026-10-19'); // Saturday → Monday
    // Semiweekly: a Friday payday is due the next Wednesday; a Monday payday the next Friday.
    expect(ymd(depositDue(D('2026-10-16'), 'SEMIWEEKLY'))).toBe('2026-10-21');
    expect(ymd(depositDue(D('2026-10-19'), 'SEMIWEEKLY'))).toBe('2026-10-23');
    // Monthly: the 15th of next month; November 15 2026 is a Sunday.
    expect(ymd(depositDue(D('2026-10-16'), 'MONTHLY'))).toBe('2026-11-16');
    expect(ymd(depositDue(D('2026-10-16'), 'MONTHLY', 20))).toBe('2026-11-20');
    // Next day skips the weekend and Veterans Day.
    expect(ymd(depositDue(D('2026-11-10'), 'NEXT_DAY'))).toBe('2026-11-12');
    // Quarterly: the last day of the month after the quarter.
    expect(ymd(depositDue(D('2026-08-03'), 'QUARTERLY'))).toBe('2026-11-02'); // Oct 31 2026 is a Saturday
    expect(ymd(quarterlyDueDate('2026-Q4'))).toBe('2027-02-01');
    expect(periodBounds('2026-Q2')).toMatchObject({ start: D('2026-04-01'), end: D('2026-06-30'), annual: false });
    expect(() => periodBounds('Q5')).toThrow();
  });
});

describe('the liability ledger', () => {
  it('groups a run by agency: the 941 carries both halves of FICA and Medicare', () => {
    const z = { federalWithholding: 0, fica: 0, medicare: 0, employerFica: 0, employerMedicare: 0, employerFuta: 0, employerSuta: 0, stateWithholding: 0, localWithholding: 0 };
    const out = postingsFor([
      { ...z, federalWithholding: 100, fica: 62, medicare: 14.5, employerFica: 62, employerMedicare: 14.5, employerFuta: 6, employerSuta: 34, stateWithholding: 30, taxState: 'ca' },
      { ...z, federalWithholding: 50, employerSuta: 10, localWithholding: 12, taxState: 'PA', localJurisdiction: 'PA:Pittsburgh' },
    ]);
    const by = Object.fromEntries(out.map((p) => [`${p.kind}|${p.jurisdiction}`, p.amount]));
    expect(by).toEqual({
      'FEDERAL_WITHHOLDING|US': 303,
      'FEDERAL_UNEMPLOYMENT|US': 6,
      'STATE_WITHHOLDING|CA': 30,
      'STATE_UNEMPLOYMENT|CA': 34,
      'STATE_UNEMPLOYMENT|PA': 10,
      'LOCAL|PA:Pittsburgh': 12,
    });
  });

  it('posts a paid run once per agency, opens new-state accounts waiting on registration, and never rewrites a paid row', async () => {
    const run = await paidRun('2026-10-16');
    expect(await postLiabilitiesForRun(prisma, run.id)).toBe(5);
    const rows = await prisma.taxLiability.findMany({ orderBy: [{ kind: 'asc' }, { jurisdiction: 'asc' }] });
    expect(rows.map((r) => `${r.kind}|${r.jurisdiction}|${Number(r.amount)}|${ymd(r.dueDate)}`)).toEqual([
      'FEDERAL_WITHHOLDING|US|759|2026-11-16',
      'FEDERAL_UNEMPLOYMENT|US|18|2027-02-01',
      'STATE_WITHHOLDING|CA|60|2026-11-16',
      'STATE_UNEMPLOYMENT|CA|68|2027-02-01',
      'STATE_UNEMPLOYMENT|TX|27|2027-02-01',
    ]);
    expect(rows.every((r) => r.periodLabel === '2026-Q4')).toBe(true);
    const accounts = await prisma.taxAgencyAccount.findMany();
    expect(accounts.filter((a) => a.status === 'PENDING_REGISTRATION').map((a) => `${a.kind}|${a.jurisdiction}`).sort()).toEqual(['STATE_UNEMPLOYMENT|CA', 'STATE_UNEMPLOYMENT|TX', 'STATE_WITHHOLDING|CA']);
    // Idempotent, and a paid row is left alone.
    await prisma.taxLiability.updateMany({ where: { kind: 'FEDERAL_WITHHOLDING' }, data: { status: 'PAID' } });
    await prisma.payrollItem.updateMany({ where: { payrollRunId: run.id }, data: { federalWithholding: 999 } });
    expect(await postLiabilitiesForRun(prisma, run.id)).toBe(4);
    expect(await prisma.taxLiability.count()).toBe(5);
    expect(Number((await prisma.taxLiability.findFirstOrThrow({ where: { kind: 'FEDERAL_WITHHOLDING' } })).amount)).toBe(759);
  });

  it('a $100,000 federal liability is due the next business day', async () => {
    const run = await paidRun('2026-10-16', { gross: 200_000 });
    await prisma.payrollItem.updateMany({ where: { payrollRunId: run.id }, data: { federalWithholding: 40_000 } });
    await postLiabilitiesForRun(prisma, run.id);
    const fed = await prisma.taxLiability.findFirstOrThrow({ where: { kind: 'FEDERAL_WITHHOLDING' } });
    expect(ymd(fed.dueDate)).toBe('2026-10-19');
  });
});

describe('the desk', () => {
  it('is whole-company only: a payroll admin narrowed to sites is refused', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: ['11111111-1111-4111-8111-111111111111'] } });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/payroll-taxes/overview')).status).toBe(403);
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(agent(), assoc.email)).get('/payroll-taxes/overview')).status).toBe(403);
  });

  it('in house: pay a deposit, record the confirmation, see it on the overview and in reconciliation', async () => {
    const { a } = await payrollAdmin();
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);

    const ov = await a.get('/payroll-taxes/overview');
    expect(ov.status, JSON.stringify(ov.body)).toBe(200);
    expect(ov.body.filing).toMatchObject({ mode: 'IN_HOUSE', penaltyGuarantee: false });
    expect(ov.body.registrations.map((r: { jurisdiction: string; kind: string }) => `${r.kind}|${r.jurisdiction}`)).toEqual(expect.arrayContaining(['STATE_WITHHOLDING|CA', 'STATE_UNEMPLOYMENT|TX']));
    // TX has no wage income tax: never a withholding registration there.
    expect(ov.body.registrations.some((r: { kind: string; jurisdiction: string }) => r.kind === 'STATE_WITHHOLDING' && r.jurisdiction === 'TX')).toBe(false);

    const fed = (await a.get('/payroll-taxes/liabilities?kind=FEDERAL_WITHHOLDING')).body.liabilities;
    const sui = (await a.get('/payroll-taxes/liabilities?kind=STATE_UNEMPLOYMENT')).body.liabilities;
    // One payment, one agency.
    const mixed = await a.post('/payroll-taxes/payments').send({ liabilityIds: [fed[0].id, sui[0].id] });
    expect(mixed.status).toBe(400);

    const created = await a.post('/payroll-taxes/payments').send({ liabilityIds: [fed[0].id] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.payment).toMatchObject({ method: 'EFTPS', status: 'SCHEDULED', amount: 759, dueDate: '2026-11-16' });
    expect(created.body.pending).toBeNull();
    const again = await a.post('/payroll-taxes/payments').send({ liabilityIds: [fed[0].id] });
    expect(again.status).toBe(409);

    const sheet = await a.get(`/payroll-taxes/payments/${created.body.payment.id}/worksheet.csv`);
    expect(sheet.status).toBe(200);
    expect(sheet.text).toContain('Internal Revenue Service');
    expect(sheet.text).toContain('759.00');

    expect((await a.post(`/payroll-taxes/payments/${created.body.payment.id}/mark-paid`).send({ confirmationNumber: '' })).status).toBe(400);
    const paid = await a.post(`/payroll-taxes/payments/${created.body.payment.id}/mark-paid`).send({ confirmationNumber: 'EFT-270000123', paidOn: '2026-10-17' });
    expect(paid.status).toBe(200);
    expect(paid.body.payment).toMatchObject({ status: 'PAID', confirmationNumber: 'EFT-270000123', late: false });
    expect((await prisma.taxLiability.findUniqueOrThrow({ where: { id: fed[0].id } })).status).toBe('PAID');

    const recon = await a.get('/payroll-taxes/reconciliation?period=2026-Q4');
    const fedLine = recon.body.lines.find((l: { kind: string }) => l.kind === 'FEDERAL_WITHHOLDING');
    expect(fedLine).toMatchObject({ posted: 759, paid: 759, open: 0, latePayments: 0 });
    expect(fedLine.flags).toEqual(['No return generated for this quarter yet']);
    const caLine = recon.body.lines.find((l: { kind: string; jurisdiction: string }) => l.kind === 'STATE_WITHHOLDING' && l.jurisdiction === 'CA');
    expect(caLine.flags).toContain('$60.00 not paid yet');

    // The inbox count: the deposits due within a week or late, from the payroll admin's desk.
    const n = await payrollTaxesNeedingYou(prisma, D('2026-11-14'));
    expect(n).toBe(1); // CA withholding, due Nov 16
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'payroll_tax.payment_paid' } })).toBe(1);
  });

  it('through a provider: a second person approves, the payment is sent once, and the guarantee shows', async () => {
    const { a, user } = await payrollAdmin();
    const { a: b } = await payrollAdmin();
    const conn = await a.post('/provider-connections').send({ kind: 'EMBEDDED_PAYROLL', provider: 'CHECK_HQ', environment: 'SANDBOX', credentials: { apiKey: 'sk_check_test' }, settings: { companyId: 'com_123', penaltyGuarantee: true } });
    expect(conn.status, JSON.stringify(conn.body)).toBe(201);
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);

    const ov = await a.get('/payroll-taxes/overview');
    expect(ov.body.filing).toMatchObject({ mode: 'PROVIDER', providerLabel: 'Check', penaltyGuarantee: true, environment: 'SANDBOX' });

    const fed = (await a.get('/payroll-taxes/liabilities?kind=FEDERAL_WITHHOLDING')).body.liabilities;
    const created = await a.post('/payroll-taxes/payments').send({ liabilityIds: [fed[0].id] });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect(created.body.pending.title).toContain('through Check');
    expect(calls).toHaveLength(0); // nothing moves before the second person

    routes = [{ match: /sandbox\.checkhq\.com\/companies\/com_123\/tax_deposits$/, method: 'POST', reply: () => ({ body: { id: 'td_1', status: 'submitted' } }) }];
    // The requester can't approve their own payment.
    const self = await a.post(`/approvals/requests/${created.body.pending.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(self.status).toBeGreaterThanOrEqual(400);
    const ok = await b.post(`/approvals/requests/${created.body.pending.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const pay = await prisma.taxPayment.findUniqueOrThrow({ where: { id: created.body.payment.id } });
    expect(pay).toMatchObject({ status: 'SUBMITTED', providerRef: 'td_1', method: 'PROVIDER' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain('"amount":"759.00"');

    // The provider reports it paid.
    routes = [{ match: /sandbox\.checkhq\.com\/tax_deposits\/td_1$/, method: 'GET', reply: () => ({ body: { id: 'td_1', status: 'paid', confirmation_number: 'IRS-778' } }) }];
    const refreshed = await a.post('/payroll-taxes/payments/refresh').send({});
    expect(refreshed.body.changed).toBe(1);
    expect((await prisma.taxPayment.findUniqueOrThrow({ where: { id: pay.id } })).confirmationNumber).toBe('IRS-778');
    expect((await prisma.taxLiability.findUniqueOrThrow({ where: { id: fed[0].id } })).status).toBe('PAID');
    expect(user.id).toBeTruthy();
  });

  it('a rejected provider payment reopens its taxes', async () => {
    const { a } = await payrollAdmin();
    const { a: b } = await payrollAdmin();
    await a.post('/provider-connections').send({ kind: 'EMBEDDED_PAYROLL', provider: 'ZEAL', environment: 'SANDBOX', credentials: { apiKey: 'zk' }, settings: { companyId: 'z1' } });
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);
    const fed = (await a.get('/payroll-taxes/liabilities?kind=FEDERAL_WITHHOLDING')).body.liabilities;
    const created = await a.post('/payroll-taxes/payments').send({ liabilityIds: [fed[0].id] });
    const no = await b.post(`/approvals/requests/${created.body.pending.approvalId}/decide`).send({ decision: 'REJECT', reason: 'Wrong amount' });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect((await prisma.taxPayment.findUniqueOrThrow({ where: { id: created.body.payment.id } })).status).toBe('CANCELLED');
    expect((await prisma.taxLiability.findUniqueOrThrow({ where: { id: fed[0].id } })).status).toBe('OPEN');
    expect(calls).toHaveLength(0);
  });
});

describe('returns', () => {
  it('builds the 941 from the ledger, files it, and amends it with the difference', async () => {
    const { a } = await payrollAdmin();
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);

    const list = await a.get('/payroll-taxes/returns?period=2026-Q4');
    expect(list.body.checklist.map((c: { kind: string; jurisdiction: string }) => `${c.kind}|${c.jurisdiction}`)).toEqual(['F941|US', 'F940|US', 'STATE_WH_QUARTERLY|CA', 'STATE_WH_ANNUAL|CA', 'SUI_WAGE_REPORT|CA', 'SUI_WAGE_REPORT|TX']);

    const gen = await a.post('/payroll-taxes/returns/generate').send({ kind: 'F941', jurisdiction: 'US', periodLabel: '2026-Q4' });
    expect(gen.status, JSON.stringify(gen.body)).toBe(201);
    const t = gen.body.return.totals;
    expect(t).toMatchObject({ line1_employees: 3, line2_wages: 3000, line3_federalIncomeTax: 300, line5a_socialSecurityWages: 3000, line5a_socialSecurityTax: 372, line5c_medicareTax: 87, line12_totalTax: 759, line13_deposits: 0, line14_balanceDue: 759, month1_liability: 759 });
    expect(gen.body.return.dueDate).toBe('2027-02-01');

    // The quarter's 941 is wrong for the wrong period shape.
    expect((await a.post('/payroll-taxes/returns/generate').send({ kind: 'F941', jurisdiction: 'US', periodLabel: '2026' })).status).toBe(400);

    expect((await a.post(`/payroll-taxes/returns/${gen.body.return.id}/file`).send({ method: 'MANUAL' })).status).toBe(400);
    const filed = await a.post(`/payroll-taxes/returns/${gen.body.return.id}/file`).send({ method: 'MANUAL', confirmationNumber: '941-CONF-1' });
    expect(filed.body.return).toMatchObject({ status: 'FILED', confirmationNumber: '941-CONF-1', method: 'MANUAL' });

    // A late correction to the run, then the amendment.
    await prisma.payrollItem.updateMany({ where: { payrollRunId: run.id }, data: { federalWithholding: 110 } });
    const amended = await a.post(`/payroll-taxes/returns/${gen.body.return.id}/amend`).send({});
    expect(amended.status, JSON.stringify(amended.body)).toBe(201);
    expect(amended.body.return).toMatchObject({ kind: 'F941X', amendsId: gen.body.return.id, status: 'DRAFT' });
    expect(amended.body.return.delta).toMatchObject({ line3_federalIncomeTax: 30, line12_totalTax: 30 });
    expect((await a.post(`/payroll-taxes/returns/${amended.body.return.id}/amend`).send({})).status).toBe(409);
  });

  it('a state unemployment wage report: every person, wages over the wage base, weeks worked; SSNs only in a guarded export', async () => {
    const { a } = await payrollAdmin();
    // An earlier quarter's pay counts toward the $7,000 CA wage base.
    await paidRun('2026-05-15', { gross: 6500 });
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);
    const gen = await a.post('/payroll-taxes/returns/generate').send({ kind: 'SUI_WAGE_REPORT', jurisdiction: 'CA', periodLabel: '2026-Q4' });
    expect(gen.status, JSON.stringify(gen.body)).toBe(201);
    const r = gen.body.return;
    expect(r.rowCount).toBe(2);
    // Different people in the two runs (each run makes its own), so each Q4 person is under the base.
    expect(r.totals).toMatchObject({ employees: 2, totalWages: 2000, taxableWages: 2000, excessWages: 0 });
    expect(r.rows[0]).not.toHaveProperty('ssn');
    expect(r.notes.join(' ')).toContain('no readable SSN');

    const plain = await a.get(`/payroll-taxes/returns/${r.id}/export.csv`);
    expect(plain.status).toBe(200);
    expect(plain.text).toContain('CONFIRM format');
    expect(plain.text).not.toContain('123456789');
    const withSsn = await a.get(`/payroll-taxes/returns/${r.id}/export.csv?ssn=1`);
    expect(withSsn.status).toBe(200);
    expect(withSsn.text).toContain('123456789');
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'payroll_tax.return_exported_with_ssn' } })).toBe(1);
  });

  it('caps taxable wages at the account’s wage base across the year', async () => {
    const { a } = await payrollAdmin();
    const run = await paidRun('2026-10-16', { gross: 5000 });
    await postLiabilitiesForRun(prisma, run.id);
    // A second paid run for the same people later in the quarter.
    const items = await prisma.payrollItem.findMany({ where: { payrollRunId: run.id } });
    const run2 = await prisma.payrollRun.create({ data: { clientId: run.clientId, periodStart: D('2026-10-30'), periodEnd: D('2026-10-30'), status: 'DISBURSED', disbursedAt: new Date('2026-10-30T15:00:00Z') } });
    for (const i of items) await prisma.payrollItem.create({ data: { payrollRunId: run2.id, associateId: i.associateId, hoursWorked: 40, hourlyRate: 125, grossPay: 5000, federalWithholding: 0, netPay: 5000, taxState: i.taxState, employerSuta: 10, status: 'DISBURSED' } });
    await prisma.taxAgencyAccount.updateMany({ where: { kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'CA' }, data: { wageBase: 7000, rate: 0.034, accountNumber: '123-4567-8', status: 'ACTIVE' } });
    const gen = await a.post('/payroll-taxes/returns/generate').send({ kind: 'SUI_WAGE_REPORT', jurisdiction: 'CA', periodLabel: '2026-Q4' });
    expect(gen.body.return.totals).toMatchObject({ totalWages: 20000, taxableWages: 14000, excessWages: 6000, rate: 0.034, contributionDue: 476 });
    expect(gen.body.return.notes.join(' ')).not.toContain('state default');
  });
});

describe('agency accounts and notices', () => {
  it('entering the account number completes a registration', async () => {
    const { a } = await payrollAdmin();
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);
    const acct = await prisma.taxAgencyAccount.findFirstOrThrow({ where: { kind: 'STATE_WITHHOLDING', jurisdiction: 'CA' } });
    const r = await a.patch(`/payroll-taxes/accounts/${acct.id}`).send({ accountNumber: '987-6543-2', depositFrequency: 'SEMIWEEKLY' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.account).toMatchObject({ status: 'ACTIVE', accountNumber: '987-6543-2', depositFrequency: 'SEMIWEEKLY' });
    expect((await a.get('/payroll-taxes/registrations')).body.registrations.some((x: { kind: string; jurisdiction: string }) => x.kind === 'STATE_WITHHOLDING' && x.jurisdiction === 'CA')).toBe(false);
    expect((await a.post('/payroll-taxes/accounts').send({ kind: 'STATE_WITHHOLDING', jurisdiction: 'ca' })).status).toBe(409);
    const ny = await a.post('/payroll-taxes/accounts').send({ kind: 'STATE_WITHHOLDING', jurisdiction: 'ny' });
    expect(ny.body.account).toMatchObject({ jurisdiction: 'NY', agencyName: 'New York withholding', status: 'PENDING_REGISTRATION' });

    const drill = await a.get(`/payroll-taxes/agencies/STATE_WITHHOLDING/CA`);
    expect(drill.status).toBe(200);
    expect(drill.body.liabilities).toHaveLength(1);
    expect(drill.body.accounts[0].accountNumber).toBe('987-6543-2');
  });

  it('logs a notice with its letter, assigns it, responds with the ledger as evidence, and resolves an abated penalty', async () => {
    const { a, user } = await payrollAdmin();
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);
    const fedAcct = await prisma.taxAgencyAccount.findFirstOrThrow({ where: { kind: 'FEDERAL_WITHHOLDING' } });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    const created = await a
      .post('/payroll-taxes/notices')
      .field('accountId', fedAcct.id)
      .field('agencyName', 'Internal Revenue Service')
      .field('noticeType', 'Late deposit penalty')
      .field('noticeNumber', 'CP136')
      .field('noticeDate', '2026-12-01')
      .field('periodLabel', '2026-Q4')
      .field('amountDue', '45.50')
      .field('responseDueAt', '2026-12-31')
      .field('assignedToId', '')
      .attach('file', pdf, { filename: 'cp136.pdf', contentType: 'application/pdf' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.notice.id;
    expect(created.body.notice).toMatchObject({ status: 'NEW', hasFile: true, amountDue: 45.5, evidence: { liabilities: 759, paid: 0 } });

    const file = await a.get(`/payroll-taxes/notices/${id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');

    expect((await a.patch(`/payroll-taxes/notices/${id}`).send({ status: 'RESPONDED' })).status).toBe(400);
    const assigned = await a.patch(`/payroll-taxes/notices/${id}`).send({ assignedToId: user.id, status: 'IN_REVIEW' });
    expect(assigned.body.notice).toMatchObject({ status: 'IN_REVIEW', assignedToId: user.id });
    const responded = await a.patch(`/payroll-taxes/notices/${id}`).send({ status: 'RESPONDED', response: 'Deposit was made on time; EFT confirmation attached.', penaltyAmount: 45.5 });
    expect(responded.body.notice.respondedAt).toBeTruthy();
    expect((await a.patch(`/payroll-taxes/notices/${id}`).send({ abatedAmount: 60 })).status).toBe(400);
    const resolved = await a.patch(`/payroll-taxes/notices/${id}`).send({ status: 'RESOLVED', resolution: 'IRS abated the penalty in full.', abatedAmount: 45.5 });
    expect(resolved.body.notice).toMatchObject({ status: 'RESOLVED', abatedAmount: 45.5 });
    expect(resolved.body.notice.events.map((e: { what: string }) => e.what)).toEqual(['Logged the notice', 'Started review', 'Assigned', 'Responded to the agency', 'Penalty set to $45.50', 'Resolved', 'Abatement recorded: $45.50']);

    const list = await a.get('/payroll-taxes/notices?status=ACTIVE');
    expect(list.body.notices).toHaveLength(0);
    expect(list.body.dashboard).toMatchObject({ open: 0, penalties: 45.5, abated: 45.5 });

    // A notice that is not a PDF or photo is refused.
    const bad = await a.post('/payroll-taxes/notices').field('agencyName', 'IRS').field('noticeType', 'Other').field('noticeDate', '2026-12-01').attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
  });
});

describe('year-end reconciliation', () => {
  it('compares paychecks, 941s, deposits and W-2s; drills to people; exports a workbook; site-bound accounts are refused', async () => {
    const { a } = await payrollAdmin();
    const run = await paidRun('2026-10-16');
    await postLiabilitiesForRun(prisma, run.id);
    const res = await a.get('/payroll-taxes/year-end/2026');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const fed = res.body.sections.find((s: { key: string }) => s.key === 'federal');
    expect(fed.rows.find((r: { key: string }) => r.key === 'wages')).toMatchObject({ ok: true, values: { paychecks: 3000, f941: 3000, w2: 3000 } });
    expect(res.body.summary.rows).toBeGreaterThan(0);

    const people = await a.get('/payroll-taxes/year-end/2026/people?metric=box1');
    expect(people.status).toBe(200);
    expect(people.body.people).toHaveLength(3);
    expect((await a.get('/payroll-taxes/year-end/2026/people?metric=box9')).status).toBe(400);

    const xlsx = await a.get('/payroll-taxes/year-end/2026/export.xlsx').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    const { user: narrowed } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'narrow@example.com' });
    const site = await prisma.site.findFirst({ select: { id: true } });
    if (site) {
      await prisma.user.update({ where: { id: narrowed.id }, data: { scopeSiteIds: [site.id] } });
      const n = await loginAs(agent(), 'narrow@example.com');
      expect((await n.get('/payroll-taxes/year-end/2026')).status).toBe(403);
    }
  });
});
