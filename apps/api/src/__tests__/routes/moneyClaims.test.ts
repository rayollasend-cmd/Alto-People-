import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { accountByKey } from '../../lib/books/ledger.js';
import { accrueRemittancesForRun } from '../../lib/garnishmentRemittance.js';
import { remitElectronically, sealPayeeBank, REMIT_CLAIM_STALE_MS, type RemittanceSender } from '../../lib/garnishmentRemit.js';
import { settleDueFunding } from '../../lib/banking/funding.js';
import { _setAdapterForTesting } from '../../lib/disbursement.js';
import { round2 as garnishRound2 } from '../../lib/garnishmentEngine.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Claim-then-act for every money movement (deep audit CODE-10, CODE-18,
 * CODE-26, ASSOC-20 and the claim-then-act upgrade): two people — or two
 * tabs, or two devices — pressing the same money button at the same moment
 * move the money once. Each race fires both requests together and checks
 * there is one winner, one refusal, and exactly one payment / file / debit.
 */

const app = () => createApp();
const H = 3_600_000;

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

beforeEach(async () => {
  await truncateAll();
  _setAdapterForTesting(null);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ EWA -- */

/** Alto's biweekly schedule (Sat→Fri, anchor Sat Jan 3, 2026): one period is Sat Oct 10 – Fri Oct 23, 2026. */
async function ewaPerson() {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Lena', lastName: 'Osei' });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'IL' } });
  const schedule = await prisma.payrollSchedule.create({
    data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-01-03T00:00:00Z'), payDateOffsetDays: 7 },
  });
  await prisma.associate.update({ where: { id: associate.id }, data: { payrollScheduleId: schedule.id } });
  await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' },
  });
  await prisma.payoutMethod.create({
    data: {
      associateId: associate.id,
      type: 'BANK_ACCOUNT',
      accountType: 'CHECKING',
      bankName: 'Chase',
      routingNumberEnc: Buffer.from('062000019', 'utf8'),
      accountNumberEnc: encryptString('555500002222'),
      accountLast4: '2222',
      isPrimary: true,
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
    },
  });
  const chicago = await prisma.site.create({ data: { name: 'Chicago Loop', clientId: client.id, state: 'IL', timezone: 'America/Chicago' } });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id, email: associate.email });
  const shift = (clockInAt: string, hours: number, status: 'APPROVED' | 'COMPLETED' = 'APPROVED') =>
    prisma.timeEntry.create({
      data: { associateId: associate.id, clientId: client.id, locationId: chicago.id, clockInAt: new Date(clockInAt), clockOutAt: new Date(new Date(clockInAt).getTime() + hours * H), status },
    });
  return { associate, user, shift };
}

describe('earned-wage advance: the period on the site’s clock (ASSOC-20) and the company’s day (MONEY-16)', () => {
  it('a 7 PM Friday shift in Chicago on the period’s last day counts in that period; the Friday before it does not', async () => {
    // Fri Oct 23, 2026, 9:30 PM in Chicago — 10:30 PM Eastern, already Saturday in UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T02:30:00Z'));
    const p = await ewaPerson();
    await p.shift('2026-10-24T00:00:00Z', 1.5); // Fri Oct 23, 7:00–8:30 PM CDT: this period's last day
    await p.shift('2026-10-10T00:00:00Z', 8); // Fri Oct 9, 7 PM CDT: the PREVIOUS period, though UTC says Oct 10
    const a = await loginAs(p.user.email);
    const r = await a.get('/me/earned-wage');
    expect(r.status).toBe(200);
    // UTC's "today" would be Sat Oct 24 — the next period, with nothing earned in it.
    expect(r.body.periodStart).toBe('2026-10-10');
    expect(r.body.periodEnd).toBe('2026-10-23');
    expect(r.body.hoursWorked).toBe(1.5);
    expect(r.body.earnedGross).toBe(30);
  });
});

describe('earned-wage advance: two devices at once (CODE-10)', () => {
  it('two draws of everything available: one is paid, the other is refused, and the cap holds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T16:00:00Z')); // Wed Oct 14, noon Eastern
    const p = await ewaPerson();
    await p.shift('2026-10-12T13:00:00Z', 10); // Mon Oct 12, ten hours at $20
    const phone = await loginAs(p.user.email);
    const laptop = await loginAs(p.user.email);
    const avail = await phone.get('/me/earned-wage');
    // 50% of the take-home estimate on $200 (lib/takeHome — the figure the associate's Home shows).
    const all = avail.body.available as number;
    expect(all).toBeGreaterThan(50);
    const [r1, r2] = await Promise.all([
      phone.post('/me/earned-wage').send({ amount: all }),
      laptop.post('/me/earned-wage').send({ amount: all }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const lost = r1.status === 409 ? r1 : r2;
    expect(lost.body.error.code).toBe('over_limit');
    const rows = await prisma.earnedWageAdvance.findMany({ where: { associateId: p.associate.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(Math.round(all * 100));
    expect((await phone.get('/me/earned-wage')).body.available).toBe(0);
  });

  it('a retry with the same Idempotency-Key replays the answer instead of paying again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T16:00:00Z'));
    const p = await ewaPerson();
    await p.shift('2026-10-12T13:00:00Z', 10);
    const a = await loginAs(p.user.email);
    const first = await a.post('/me/earned-wage').set('Idempotency-Key', 'ewa-tap-1').send({ amount: 20 });
    expect(first.status).toBe(201);
    const again = await a.post('/me/earned-wage').set('Idempotency-Key', 'ewa-tap-1').send({ amount: 20 });
    expect(again.status).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.earnedWageAdvance.count({ where: { associateId: p.associate.id } })).toBe(1);
  });
});

/* ------------------------------------------------------------- Payables -- */

async function payablesSeed() {
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(fin.email);
  const a2 = await loginAs(fin.email);
  const b = await loginAs(owner.email);
  const fuel = await accountByKey(prisma, 'FUEL');
  const cash = await accountByKey(prisma, 'CASH_OPERATING');
  const v = await a.post('/books/vendors').send({ name: 'Shell Fleet', termsDays: 15 });
  expect(v.status).toBe(201);
  const made = await a.post('/books/bills').send({ vendorId: v.body.vendor.id, billDate: '2026-10-01', billNumber: 'INV-100', lines: [{ accountId: fuel.id, amount: 100, description: 'Van fuel' }] });
  expect(made.status).toBe(201);
  const sub = await a.post(`/books/bills/${made.body.bill.id}/submit`);
  expect(sub.status).toBe(202);
  expect((await b.post(`/approvals/requests/${sub.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
  return { a, a2, cash, vendorId: v.body.vendor.id as string, billId: made.body.bill.id as string };
}

describe('bill payments: two at once (CODE-18)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T15:00:00.000Z'));
  });

  it('two payments of the whole bill: one is paid, the other refused — one payment, balance exactly zero', async () => {
    const s = await payablesSeed();
    const body = { vendorId: s.vendorId, paidOn: '2026-10-15', method: 'CHECK', bankAccountId: s.cash.id, applications: [{ billId: s.billId, amount: 100 }] };
    const [r1, r2] = await Promise.all([s.a.post('/books/bill-payments').send(body), s.a2.post('/books/bill-payments').send(body)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await prisma.billPayment.count()).toBe(1);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: s.billId } });
    expect(Number(bill.balance)).toBe(0);
    expect(bill.status).toBe('PAID');
  });

  it('two partial payments that together overpay: no lost update — the second waits, sees $40 left and is refused', async () => {
    const s = await payablesSeed();
    const body = { vendorId: s.vendorId, paidOn: '2026-10-15', method: 'CHECK', bankAccountId: s.cash.id, applications: [{ billId: s.billId, amount: 60 }] };
    const [r1, r2] = await Promise.all([s.a.post('/books/bill-payments').send(body), s.a2.post('/books/bill-payments').send(body)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: s.billId } });
    expect(Number(bill.balance)).toBe(40);
    expect(bill.status).toBe('PARTIALLY_PAID');
    // Two partial payments that fit both land, and the balance is the sum of both.
    const ok = await s.a.post('/books/bill-payments').send({ ...body, applications: [{ billId: s.billId, amount: 15 }] });
    expect(ok.status).toBe(201);
    expect(Number((await prisma.bill.findUniqueOrThrow({ where: { id: s.billId } })).balance)).toBe(25);
  });

  it('two voids of one payment at once give the bill its money back once', async () => {
    const s = await payablesSeed();
    const pay = await s.a.post('/books/bill-payments').send({ vendorId: s.vendorId, paidOn: '2026-10-15', method: 'CHECK', bankAccountId: s.cash.id, applications: [{ billId: s.billId, amount: 70 }] });
    expect(pay.status).toBe(201);
    const [v1, v2] = await Promise.all([
      s.a.post(`/books/bill-payments/${pay.body.payment.id}/void`).send({ reason: 'Check lost' }),
      s.a2.post(`/books/bill-payments/${pay.body.payment.id}/void`).send({ reason: 'Check lost' }),
    ]);
    expect([v1.status, v2.status]).toContain(200);
    expect([v1.status, v2.status].filter((x) => x === 200)).toHaveLength(1);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: s.billId } });
    expect(Number(bill.balance)).toBe(100);
    expect(bill.status).toBe('APPROVED');
  });
});

/* ---------------------------------------------------------- Remittances -- */

async function pendingRemittance() {
  const p = await createAssociate({ firstName: 'Ann', lastName: 'Lee' });
  const g = await prisma.garnishment.create({
    data: { associateId: p.id, kind: 'CREDITOR', amountPerRun: 100, startDate: new Date('2026-01-01'), remitTo: 'Acme Collections', remitMethod: 'ACH', caseNumber: 'CV-1', ...sealPayeeBank('011000015', '99887766') },
  });
  const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'DISBURSED' } });
  await prisma.garnishmentDeduction.create({ data: { garnishmentId: g.id, payrollRunId: run.id, amount: 100 } });
  await accrueRemittancesForRun(prisma, run.id);
  return prisma.garnishmentRemittance.findFirstOrThrow({ where: { payrollRunId: run.id } });
}

/** A rail that writes a "file" after a beat, and counts the files. */
function countingSender(opts: { fail?: boolean } = {}): RemittanceSender & { files: number } {
  const s = {
    files: 0,
    async send() {
      await new Promise((r) => setTimeout(r, 50));
      if (opts.fail) throw new Error('bank connection down');
      s.files += 1;
      return { file: { id: crypto.randomUUID(), status: 'CREATED', error: null }, entries: [] } as never;
    },
  };
  return s;
}

describe('garnishment remittance: two sends at once (CODE-18)', () => {
  const opts = (sender: RemittanceSender, actorUserId: string) => ({ effectiveDate: '2026-10-19', actorUserId, payDateOf: async () => '2026-10-16', sender });

  it('one ACH file, one SENT remittance; the other send is refused', async () => {
    const rem = await pendingRemittance();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const sender = countingSender();
    const results = await Promise.allSettled([remitElectronically(prisma, [rem.id], opts(sender, user.id)), remitElectronically(prisma, [rem.id], opts(sender, user.id))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as { status: number }).status).toBe(409);
    expect(sender.files).toBe(1);
    expect(await prisma.garnishmentRemittance.findUniqueOrThrow({ where: { id: rem.id } })).toMatchObject({ status: 'SENT', sendingAt: null });
  });

  it('a send that fails before a file lets go of its claim, so it can be sent again', async () => {
    const rem = await pendingRemittance();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await expect(remitElectronically(prisma, [rem.id], opts(countingSender({ fail: true }), user.id))).rejects.toThrow(/bank connection down/);
    expect(await prisma.garnishmentRemittance.findUniqueOrThrow({ where: { id: rem.id } })).toMatchObject({ status: 'PENDING', sendingAt: null });
    const ok = countingSender();
    await remitElectronically(prisma, [rem.id], opts(ok, user.id));
    expect(ok.files).toBe(1);
  });

  it('a send claimed a moment ago is "being sent"; a stale claim whose file was written is never re-sent', async () => {
    const rem = await pendingRemittance();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.garnishmentRemittance.update({ where: { id: rem.id }, data: { sendingAt: new Date() } });
    await expect(remitElectronically(prisma, [rem.id], opts(countingSender(), user.id))).rejects.toMatchObject({ status: 409 });
    // A crash after the file: claimed 20 minutes ago, a GARNISHMENT file written since.
    const claimed = new Date(Date.now() - REMIT_CLAIM_STALE_MS - 5 * 60_000);
    await prisma.garnishmentRemittance.update({ where: { id: rem.id }, data: { sendingAt: claimed } });
    await prisma.achFile.create({
      data: { purpose: 'GARNISHMENT', provider: 'IN_HOUSE', fileIdModifier: 'A', effectiveDate: new Date('2026-10-19'), entryCount: 1, totalCreditCents: 10000n, contentEnc: encryptString('x'), sha256: 'x'.repeat(64), createdAt: new Date(claimed.getTime() + 1000) },
    });
    const sender = countingSender();
    await expect(remitElectronically(prisma, [rem.id], opts(sender, user.id))).rejects.toMatchObject({ status: 409, code: 'remittance_send_unfinished' });
    expect(sender.files).toBe(0);
  });
});

/* -------------------------------------------------------------- Funding -- */

const ROUTING_A = '011000015';
const ROUTING_B = '091000019';

async function fundingSetup() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(user.email);
  const a2 = await loginAs(user.email);
  const prof = await a.put('/payroll-banking/profile').send({
    bankRail: 'ACH',
    achSpeed: 'NEXT_DAY',
    companyName: 'Alto HR',
    companyId: '1234567890',
    immediateDestination: ROUTING_B,
    immediateDestinationName: 'Wells Fargo',
    immediateOrigin: '1234567890',
    immediateOriginName: 'Alto HR',
    originatingDfi: '09100001',
  });
  expect(prof.status).toBe(200);
  const add = await a.post('/payroll-banking/accounts').send({ label: 'Operating', bankName: 'Chase', routingNumber: ROUTING_A, accountNumber: '000123456789', accountType: 'CHECKING' });
  const id = add.body.account.id;
  const sent = await a.post(`/payroll-banking/accounts/${id}/verify`).send({ method: 'MICRODEPOSITS' });
  const [x, y] = sent.body.amountsForTest as [number, number];
  expect((await a.post(`/payroll-banking/accounts/${id}/confirm`).send({ amounts: [y, x] })).body.status).toBe('VERIFIED');
  expect((await a.post(`/payroll-banking/accounts/${id}/funding`).send({})).status).toBe(200);
  const jane = await createAssociate({ firstName: 'Jane', lastName: 'Doe' });
  await prisma.payoutMethod.create({
    data: {
      associateId: jane.id,
      type: 'BANK_ACCOUNT',
      routingNumberEnc: Buffer.from(ROUTING_A, 'utf8'),
      accountNumberEnc: encryptString('123456789'),
      accountType: 'CHECKING',
      isPrimary: true,
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      accountLast4: '6789',
      accountFingerprint: accountFingerprint(ROUTING_A, '123456789'),
    },
  });
  const run = await prisma.payrollRun.create({
    data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', totalGross: 1000, totalTax: 0, totalNet: 1000, totalEmployerTax: 0 },
  });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: jane.id, hoursWorked: 40, hourlyRate: 25, grossPay: 1000, federalWithholding: 0, netPay: 1000 } });
  return { a, a2, run };
}

describe('payroll funding: "Pull funds" twice at once (claim-then-act)', () => {
  it('one debit, one file; the other pull is told it is already under way', async () => {
    const s = await fundingSetup();
    const [r1, r2] = await Promise.all([s.a.post(`/payroll-banking/runs/${s.run.id}/funding`).send({}), s.a2.post(`/payroll-banking/runs/${s.run.id}/funding`).send({})]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const lost = r1.status === 409 ? r1 : r2;
    expect(lost.body.error.code).toBe('already_funding');
    expect(await prisma.achFile.count({ where: { purpose: 'FUNDING' } })).toBe(1);
    expect(await prisma.payrollFunding.findUniqueOrThrow({ where: { payrollRunId: s.run.id } })).toMatchObject({ status: 'SUBMITTED' });
  });

  it('"Pull again" twice after a return: one new debit', async () => {
    const s = await fundingSetup();
    expect((await s.a.post(`/payroll-banking/runs/${s.run.id}/funding`).send({})).status).toBe(200);
    await prisma.payrollFunding.updateMany({ data: { status: 'RETURNED', returnCode: 'R01', returnReason: 'Insufficient funds', returnedAt: new Date() } });
    const [r1, r2] = await Promise.all([s.a.post(`/payroll-banking/runs/${s.run.id}/funding`).send({}), s.a2.post(`/payroll-banking/runs/${s.run.id}/funding`).send({})]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await prisma.achFile.count({ where: { purpose: 'FUNDING' } })).toBe(2);
  });
});

describe('payroll funding settles on New York’s banking day (CODE-26)', () => {
  it('not at 9 PM Eastern the evening before, not on the effective date itself, but once that day has passed', async () => {
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED' } });
    const f = await prisma.payrollFunding.create({
      data: { payrollRunId: run.id, amountCents: 100000n, payDate: new Date('2026-10-23'), debitEffectiveDate: new Date('2026-10-21'), fundingDeadline: new Date('2026-10-20T20:00:00Z'), achSpeed: 'NEXT_DAY', status: 'SUBMITTED', submittedAt: new Date('2026-10-20T15:00:00Z') },
    });
    // Tue Oct 20, 9 PM Eastern = Oct 21 01:00 UTC: UTC already reads the effective date.
    expect(await settleDueFunding(prisma, new Date('2026-10-21T01:00:00Z'))).toBe(0);
    // Wed Oct 21, 11 PM Eastern: the effective date itself, not yet passed.
    expect(await settleDueFunding(prisma, new Date('2026-10-22T03:00:00Z'))).toBe(0);
    expect((await prisma.payrollFunding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe('SUBMITTED');
    // Thu Oct 22, 12:30 AM Eastern.
    expect(await settleDueFunding(prisma, new Date('2026-10-22T04:30:00Z'))).toBe(1);
    expect((await prisma.payrollFunding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe('SETTLED');
  });

  it('a return that lands between the read and the write keeps the debit RETURNED', async () => {
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED' } });
    const f = await prisma.payrollFunding.create({
      data: { payrollRunId: run.id, amountCents: 100000n, payDate: new Date('2026-10-23'), debitEffectiveDate: new Date('2026-10-21'), fundingDeadline: new Date('2026-10-20T20:00:00Z'), achSpeed: 'NEXT_DAY', status: 'RETURNED', returnCode: 'R01' },
    });
    expect(await settleDueFunding(prisma, new Date('2026-10-23T15:00:00Z'))).toBe(0);
    expect((await prisma.payrollFunding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe('RETURNED');
  });
});

/* ------------------------------------------------------------- Rounding -- */

describe('garnishment math rounds half-cents up (CODE-27)', () => {
  it('uses the same integer-cent rounding as pay', () => {
    expect(garnishRound2(4.015)).toBe(4.02);
    expect(garnishRound2(0.5 * 8.03)).toBe(4.02);
    expect(garnishRound2(-4.015)).toBe(-4.02);
  });
});
