import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { validateNachaFile } from '../../lib/banking/nacha.js';
import { _setAdapterForTesting, resolveAdapter } from '../../lib/disbursement.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll, signOffRun } from '../../../test/db.js';

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

const ROUTING_A = '011000015';
const ROUTING_B = '091000019';

/** Banking set up for our own ACH, in-house file mode. */
async function setupProfile(a: TestAgent<Test>, extra: Record<string, unknown> = {}) {
  const r = await a.put('/payroll-banking/profile').send({
    bankRail: 'ACH',
    achSpeed: 'NEXT_DAY',
    companyName: 'Alto HR',
    companyId: '1234567890',
    immediateDestination: ROUTING_B,
    immediateDestinationName: 'Wells Fargo',
    immediateOrigin: '1234567890',
    immediateOriginName: 'Alto HR',
    originatingDfi: '09100001',
    ...extra,
  });
  expect(r.status).toBe(200);
  return r.body.profile;
}

async function verifiedFundingAccount(a: TestAgent<Test>) {
  const add = await a.post('/payroll-banking/accounts').send({ label: 'Operating', bankName: 'Chase', routingNumber: ROUTING_A, accountNumber: '000123456789', accountType: 'CHECKING' });
  expect(add.status).toBe(201);
  const id = add.body.account.id;
  const sent = await a.post(`/payroll-banking/accounts/${id}/verify`).send({ method: 'MICRODEPOSITS' });
  expect(sent.status).toBe(200);
  expect(sent.body.status).toBe('MICRODEPOSITS_SENT');
  const [x, y] = sent.body.amountsForTest as [number, number];
  const ok = await a.post(`/payroll-banking/accounts/${id}/confirm`).send({ amounts: [y, x] });
  expect(ok.body.status).toBe('VERIFIED');
  const use = await a.post(`/payroll-banking/accounts/${id}/funding`).send({});
  expect(use.status).toBe(200);
  return id as string;
}

async function bankMethod(associateId: string, routing: string, account: string, extra: Record<string, unknown> = {}) {
  return prisma.payoutMethod.create({
    data: {
      associateId,
      type: 'BANK_ACCOUNT',
      routingNumberEnc: Buffer.from(routing, 'utf8'),
      accountNumberEnc: encryptString(account),
      accountType: 'CHECKING',
      isPrimary: true,
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      accountLast4: account.slice(-4),
      accountFingerprint: accountFingerprint(routing, account),
      ...extra,
    },
  });
}

/** A finalized run: two people paid by bank account, net $1,250.50 and $500.00. */
async function finalizedRun() {
  const jane = await createAssociate({ firstName: 'Jane', lastName: 'Doe' });
  const ken = await createAssociate({ firstName: 'Ken', lastName: 'Ito' });
  await bankMethod(jane.id, ROUTING_A, '123456789');
  await bankMethod(ken.id, ROUTING_B, '987654321');
  const run = await prisma.payrollRun.create({
    data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', totalGross: 2000, totalTax: 249.5, totalNet: 1750.5, totalEmployerTax: 120 },
  });
  const item = (associateId: string, net: number) =>
    prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId, hoursWorked: 40, hourlyRate: 25, grossPay: 1000, federalWithholding: 0, netPay: net } });
  const i1 = await item(jane.id, 1250.5);
  const i2 = await item(ken.id, 500);
  return { run, jane, ken, items: [i1, i2] };
}

beforeEach(async () => {
  await truncateAll();
  _setAdapterForTesting(null);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma.$disconnect();
});

describe('payroll banking: profile and employer accounts', () => {
  it('names what is missing before a file can be written, and refuses a bad routing number', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const s = await a.get('/payroll-banking/summary');
    expect(s.status).toBe(200);
    expect(s.body.profile.bankRail).toBe('PLATFORM');
    expect(s.body.profile.gaps.length).toBeGreaterThan(0);
    const bad = await a.post('/payroll-banking/accounts').send({ label: 'Op', routingNumber: '011000016', accountNumber: '1234' });
    expect(bad.status).toBe(400);
  });

  it('micro-deposits: five wrong tries lock the account', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    const add = await a.post('/payroll-banking/accounts').send({ label: 'Op', routingNumber: ROUTING_A, accountNumber: '55512345' });
    const id = add.body.account.id;
    const sent = await a.post(`/payroll-banking/accounts/${id}/verify`).send({ method: 'MICRODEPOSITS' });
    const [x, y] = sent.body.amountsForTest as [number, number];
    const wrong: [number, number] = [x === 99 ? 98 : x + 1, y];
    let last;
    for (let i = 0; i < 5; i++) last = await a.post(`/payroll-banking/accounts/${id}/confirm`).send({ amounts: wrong });
    expect(last!.body.status).toBe('FAILED');
    // The deposits went out as a real CCD file.
    const files = await a.get('/payroll-banking/files');
    expect(files.body.files[0]).toMatchObject({ purpose: 'MICRODEPOSIT', entryCount: 2, totalCreditCents: x + y });
  });

  it('a lower limit applies now; a higher one waits for a second person', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    await setupProfile(a, { perRunLimitCents: 1_000_000 });
    const raise = await a.put('/payroll-banking/profile').send({ perRunLimitCents: 5_000_000 });
    expect(raise.status).toBe(202);
    expect(raise.body.profile.perRunLimitCents).toBe(1_000_000);
    const b = await loginAs(fin.email);
    const d = await b.post(`/approvals/requests/${raise.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(d.status).toBe(200);
    const s = await a.get('/payroll-banking/summary');
    expect(s.body.profile.perRunLimitCents).toBe(5_000_000);
  });
});

describe('payroll banking: funding gates disbursement', () => {
  it('no pay goes out until the debit settles; then one PPD file pays everyone with trace numbers', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    await verifiedFundingAccount(a);
    const { run, items } = await finalizedRun();

    await signOffRun(run.id);
    const blocked = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code ?? blocked.body.code).toBe('not_funded');

    const preview = await a.get(`/payroll-banking/runs/${run.id}/funding`);
    expect(preview.body.funding).toMatchObject({ status: 'NOT_STARTED', amountCents: 175050 });

    const pull = await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    expect(pull.status).toBe(200);
    expect(pull.body.funding).toMatchObject({ status: 'SUBMITTED', amountCents: 175050 });
    const debitFile = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'FUNDING' } });
    expect(Number(debitFile.totalDebitCents)).toBe(175050);

    await signOffRun(run.id);
    const stillBlocked = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(stillBlocked.status).toBe(409);

    await prisma.payrollFunding.updateMany({ data: { status: 'SETTLED', settledAt: new Date() } });
    await signOffRun(run.id);
    const paid = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(paid.status).toBe(200);
    const after = await prisma.payrollItem.findMany({ where: { payrollRunId: run.id } });
    expect(after.every((i) => i.status === 'DISBURSED' && /^09100001\d{7}$/.test(i.disbursementRef ?? ''))).toBe(true);
    const dd = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    expect(dd.entryCount).toBe(2);
    expect(Number(dd.totalCreditCents)).toBe(175050);
    const dl = await a.get(`/payroll-banking/files/${dd.id}/download`);
    expect(dl.status).toBe(200);
    expect(validateNachaFile(dl.text)).toEqual({ ok: true });
    expect(dl.text).toContain('JANE DOE');
    expect(items).toHaveLength(2);
  });

  it('collects taxes too when we pay them', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a, { collectTaxes: true });
    const { run } = await finalizedRun();
    const p = await a.get(`/payroll-banking/runs/${run.id}/funding`);
    expect(p.body.funding.amountCents).toBe(175050 + 24950 + 12000);
    expect(p.body.funding.breakdown).toMatchObject({ netPayCents: 175050, taxesCents: 36950, achPeople: 2 });
  });

  it('over the per-run limit, the pull waits for a second person, who sends it', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    await setupProfile(a, { perRunLimitCents: 100_000 });
    await verifiedFundingAccount(a);
    const { run } = await finalizedRun();
    const pull = await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    expect(pull.status).toBe(202);
    expect(pull.body.funding.status).toBe('AWAITING_APPROVAL');
    expect(await prisma.achFile.count({ where: { purpose: 'FUNDING' } })).toBe(0);
    // The requester can't approve their own.
    const self = await a.post(`/approvals/requests/${pull.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(self.status).toBeGreaterThanOrEqual(400);
    const b = await loginAs(fin.email);
    const ok = await b.post(`/approvals/requests/${pull.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    const f = await prisma.payrollFunding.findFirstOrThrow({ where: { payrollRunId: run.id } });
    expect(f.status).toBe('SUBMITTED');
  });

  it('an unverified funding account and an unapproved employer on a live bank are refused', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    const add = await a.post('/payroll-banking/accounts').send({ label: 'Op', routingNumber: ROUTING_A, accountNumber: '5551234' });
    const use = await a.post(`/payroll-banking/accounts/${add.body.account.id}/funding`).send({});
    expect(use.status).toBe(409);
    await verifiedFundingAccount(a);
    await prisma.providerConnection.create({
      data: { kind: 'ORIGINATION', provider: 'INCREASE', name: 'Increase', environment: 'PRODUCTION', active: true, credentialsEnc: encryptString(JSON.stringify({ apiKey: 'k' })), settings: { accountId: 'acct_1' } },
    });
    const { run } = await finalizedRun();
    const pull = await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    expect(pull.status).toBe(409);
    expect(JSON.stringify(pull.body)).toContain('kyb_required');
  });
});

describe('payroll banking: what comes back', () => {
  it('a returned funding debit holds pay and asks for a wire; a received wire releases it', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    await verifiedFundingAccount(a);
    const { run } = await finalizedRun();
    await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    const debit = await prisma.achEntry.findFirstOrThrow({ where: { kind: 'DEBIT' } });
    const returnFile = [
      '6' + '26' + '01100001' + '5' + '000123456789'.padEnd(17) + '0000175050' + 'RUN'.padEnd(15) + 'ALTO HR'.padEnd(22) + '  ' + '1' + '011000010000001',
      '7' + '99' + 'R01' + debit.traceNumber + ' '.repeat(6) + '09100001' + ' '.repeat(44) + '011000010000001',
    ].join('\n');
    const up = await a.post('/payroll-banking/returns').send({ content: returnFile });
    expect(up.body).toMatchObject({ returned: 1, total: 1 });
    const f = await prisma.payrollFunding.findFirstOrThrow({ where: { payrollRunId: run.id } });
    expect(f).toMatchObject({ status: 'RETURNED', returnCode: 'R01' });
    await signOffRun(run.id);
    const blocked = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('R01');
    await a.post(`/payroll-banking/runs/${run.id}/wire`).send({ state: 'WIRE_PENDING', note: 'Wire promised by the controller' });
    const got = await a.post(`/payroll-banking/runs/${run.id}/wire`).send({ state: 'WIRE_RECEIVED', note: 'Fed ref 20261013B1QGC07C000123' });
    expect(got.body.funding.status).toBe('WIRE_RECEIVED');
    await signOffRun(run.id);
    const paid = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(paid.status).toBe(200);
  });

  it('a returned paycheck re-pays to a check when there is no other verified account; a NOC replaces the account', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    await verifiedFundingAccount(a);
    const { run, jane, ken } = await finalizedRun();
    await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    await prisma.payrollFunding.updateMany({ data: { status: 'SETTLED' } });
    await signOffRun(run.id);
    await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    const janeEntry = await prisma.achEntry.findFirstOrThrow({ where: { kind: 'CREDIT', associateId: jane.id } });
    const kenEntry = await prisma.achEntry.findFirstOrThrow({ where: { kind: 'CREDIT', associateId: ken.id } });
    const file = [
      '6' + '21' + '01100001' + '5' + '123456789'.padEnd(17) + '0000125050' + 'X'.padEnd(15) + 'JANE DOE'.padEnd(22) + '  ' + '1' + '011000010000001',
      '7' + '99' + 'R02' + janeEntry.traceNumber + ' '.repeat(6) + '01100001' + ' '.repeat(44) + '011000010000001',
      '6' + '21' + '09100001' + '9' + '987654321'.padEnd(17) + '0000000000' + 'X'.padEnd(15) + 'KEN ITO'.padEnd(22) + '  ' + '1' + '091000010000002',
      '7' + '98' + 'C01' + kenEntry.traceNumber + ' '.repeat(6) + '09100001' + '5550001112'.padEnd(29) + ' '.repeat(15) + '091000010000002',
    ].join('\n');
    const up = await a.post('/payroll-banking/returns').send({ content: file });
    expect(up.body).toMatchObject({ returned: 1, corrected: 1, unknown: 0 });
    const janeItem = await prisma.payrollItem.findFirstOrThrow({ where: { associateId: jane.id } });
    expect(janeItem.disbursementRef).toMatch(/^CHECK-/);
    const kenMethods = await prisma.payoutMethod.findMany({ where: { associateId: ken.id }, orderBy: { createdAt: 'asc' } });
    expect(kenMethods).toHaveLength(2);
    expect(kenMethods[0]!.retiredAt).not.toBeNull();
    expect(kenMethods[1]).toMatchObject({ isPrimary: true, accountLast4: '1112', prenoteStatus: 'CLEARED' });
    expect(kenMethods[1]!.verifiedAt).not.toBeNull();
    const entries = await a.get('/payroll-banking/entries');
    expect(entries.body.entries.map((e: { status: string }) => e.status).sort()).toEqual(['CORRECTED', 'RETURNED']);
  });
});

describe('payroll banking: direct deposit details', () => {
  it('splits a paycheck across accounts in one file', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    await verifiedFundingAccount(a);
    const { run, jane } = await finalizedRun();
    await bankMethod(jane.id, ROUTING_B, '44440000', { isPrimary: false, splitKind: 'AMOUNT', splitAmountCents: 25_000, splitOrder: 1 });
    await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    await prisma.payrollFunding.updateMany({ data: { status: 'SETTLED' } });
    await signOffRun(run.id);
    const r = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(r.status).toBe(200);
    const janes = await prisma.achEntry.findMany({ where: { associateId: jane.id, kind: 'CREDIT' }, orderBy: { amountCents: 'asc' } });
    expect(janes.map((e) => Number(e.amountCents))).toEqual([25_000, 100_050]);
  });

  it('prenotes go to verified accounts once; a returned prenote holds pay from that account', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    const { jane } = await finalizedRun();
    const sent = await a.post('/payroll-banking/prenotes').send({});
    expect(sent.body.sent).toBe(2);
    const again = await a.post('/payroll-banking/prenotes').send({});
    expect(again.body.sent).toBe(0);
    const pre = await prisma.achEntry.findFirstOrThrow({ where: { kind: 'PRENOTE', associateId: jane.id } });
    expect(pre.transactionCode).toBe('23');
    const out = await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
      const { applyAchReturn } = await import('../../lib/banking/directDeposit.js');
      return applyAchReturn(prisma, { entryId: pre.id }, 'R03');
    });
    expect(out.outcome).toBe('prenote_returned');
    const dep = await a.get('/payroll-banking/deposits');
    expect(dep.body.counts).toMatchObject({ returned: 1, sent: 1 });
  });

  it('routes each pay method to its rail: cards to Branch, no account to a check', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a, { bankRail: 'CHECK' });
    const adapter = await runWithTenant(ALTO_TENANT_ID, 'job', () => resolveAdapter());
    const r = await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
      const assoc = await createAssociate({ firstName: 'No', lastName: 'Account' });
      const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED' } });
      const item = await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: assoc.id, hoursWorked: 1, hourlyRate: 10, grossPay: 10, federalWithholding: 0, netPay: 10 } });
      return adapter.disburse({ amount: 10, currency: 'USD', recipient: { associateId: assoc.id, fullName: 'No Account' }, idempotencyKey: item.id });
    });
    expect(r).toMatchObject({ provider: 'CHECK', status: 'SUCCESS' });
  });
});

describe('payroll banking: calendar', () => {
  it('shows the year’s pay dates with the holiday moves and funding deadlines', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await setupProfile(a);
    await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-09-12'), payDateOffsetDays: 7 } });
    const add = await a.post('/payroll-banking/holidays').send({ date: '2026-12-10', name: 'Bank closed', closed: true });
    expect(add.status).toBe(201);
    const cal = await a.get('/payroll-banking/calendar?year=2026');
    expect(cal.status).toBe(200);
    const christmas = cal.body.rows.find((r: { nominalPayDate: string }) => r.nominalPayDate === '2026-12-25');
    expect(christmas).toMatchObject({ payDate: '2026-12-24', shiftReason: 'Christmas Day', creditSubmitDate: '2026-12-23' });
    const dec11 = cal.body.rows.find((r: { payDate: string }) => r.payDate === '2026-12-11');
    expect(dec11.creditSubmitDate).toBe('2026-12-09'); // Dec 10 closed by the override
    expect(cal.body.holidays.some((h: { source: string }) => h.source === 'OVERRIDE')).toBe(true);
  });
});
