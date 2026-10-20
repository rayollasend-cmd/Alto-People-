import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountBalance, accountByKey } from '../../lib/books/ledger.js';
import { trialBalance } from '../../lib/books/reports.js';
import { runPayablesJobs } from '../../lib/books/jobs/payables.js';
import { nextOccurrence } from '../../lib/books/payables/recurring.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * Payables: vendors (tax ID and bank kept encrypted; a bank CHANGE needs a
 * second person), bills (owed only once someone other than the person who
 * entered them approves — then on the books), payments (partial and full,
 * balances and entries), voids, recurring bills, AP aging and the 1099 list.
 *
 *   Today is Monday Oct 19, 2026.
 */

const NOW = new Date('2026-10-19T15:00:00.000Z');
type Agent = TestAgent<Test>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await truncateAll();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function seed() {
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(agent(), fin.email);
  const b = await loginAs(agent(), owner.email);
  const fuel = await accountByKey(prisma, 'FUEL');
  const rent = await accountByKey(prisma, 'RENT');
  const cash = await accountByKey(prisma, 'CASH_OPERATING');
  const card = await accountByKey(prisma, 'CREDIT_CARD');
  return { fin, owner, a, b, fuel, rent, cash, card };
}

const ROUTING = '011000015';
const ROUTING_2 = '091000019';

async function vendor(a: Agent, extra: Record<string, unknown> = {}) {
  const r = await a.post('/books/vendors').send({ name: 'Shell Fleet', termsDays: 15, ...extra });
  expect(r.status).toBe(201);
  return r.body.vendor as { id: string; name: string };
}

async function approvedBill(s: Awaited<ReturnType<typeof seed>>, vendorId: string, amount: number, billDate = '2026-10-01', extra: Record<string, unknown> = {}) {
  const made = await s.a.post('/books/bills').send({ vendorId, billDate, billNumber: `INV-${amount}`, lines: [{ accountId: s.fuel.id, amount, description: 'Van fuel' }], ...extra });
  expect(made.status).toBe(201);
  const sub = await s.a.post(`/books/bills/${made.body.bill.id}/submit`);
  expect(sub.status).toBe(202);
  const ok = await s.b.post(`/approvals/requests/${sub.body.approvalId}/decide`).send({ decision: 'APPROVE' });
  expect(ok.status).toBe(200);
  return (await s.a.get(`/books/bills/${made.body.bill.id}`)).body.bill as { id: string; status: string; balance: number; journalEntryId: string };
}

describe('vendors', () => {
  it('keeps the tax ID and bank encrypted, shows only the last four, and a bank change waits for a second person', async () => {
    const s = await seed();
    const made = await s.a.post('/books/vendors').send({
      name: 'Coastal Van Lease',
      is1099: true,
      taxId: '123456789',
      routingNumber: ROUTING,
      accountNumber: '000123456789',
      defaultExpenseAccountId: s.rent.id,
      termsDays: 30,
      state: 'fl',
    });
    expect(made.status).toBe(201);
    expect(made.body.vendor).toMatchObject({ name: 'Coastal Van Lease', hasTaxId: true, taxIdLast4: '6789', hasBank: true, accountLast4: '6789', state: 'FL', balance: 0, pendingBankChange: null });
    expect(JSON.stringify(made.body)).not.toContain('123456789');
    const row = await prisma.vendor.findUniqueOrThrow({ where: { id: made.body.vendor.id } });
    expect(row.taxIdEnc!.toString('utf8')).not.toContain('123456789');
    expect(row.accountNumberEnc!.toString('utf8')).not.toContain('000123456789');

    // Bad routing is refused outright.
    expect((await s.a.patch(`/books/vendors/${row.id}`).send({ routingNumber: '123456789', accountNumber: '1111' })).body.error.code).toBe('invalid_routing');

    // A change to the bank: 202, the old account stays until someone else approves.
    const change = await s.a.patch(`/books/vendors/${row.id}`).send({ routingNumber: ROUTING_2, accountNumber: '99887766', phone: '850-555-0100' });
    expect(change.status).toBe(202);
    expect(change.body.vendor).toMatchObject({ phone: '850-555-0100', accountLast4: '6789', pendingBankChange: { accountLast4: '7766' } });
    expect((await s.a.post(`/approvals/requests/${change.body.approvalId}/decide`).send({ decision: 'APPROVE' })).body.error.code).toBe('maker_checker');
    expect((await s.b.post(`/approvals/requests/${change.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const after = await s.a.get(`/books/vendors/${row.id}`);
    expect(after.body.vendor).toMatchObject({ accountLast4: '7766', pendingBankChange: null });

    const list = await s.a.get('/books/vendors?q=coastal');
    expect(list.body.vendors.map((v: { name: string }) => v.name)).toEqual(['Coastal Van Lease']);
  });

  it('people without the books are turned away; reading needs view, writing needs manage', async () => {
    const s = await seed();
    const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const r = await loginAs(agent(), rec.email);
    expect((await r.get('/books/vendors')).status).toBe(403);
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    expect((await e.get('/books/bills')).status).toBe(200);
    expect((await e.post('/books/vendors').send({ name: 'X' })).status).toBe(403);
    void s;
  });
});

describe('bills', () => {
  it('a bill is owed only after someone else approves it — then a balanced entry posts to AP', async () => {
    const s = await seed();
    const v = await vendor(s.a);
    const made = await s.a.post('/books/bills').send({
      vendorId: v.id,
      billDate: '2026-10-05',
      billNumber: 'SF-1001',
      lines: [
        { accountId: s.fuel.id, amount: 412.5, description: 'Fleet fuel' },
        { accountId: s.rent.id, amount: 87.5, description: 'Yard parking' },
      ],
    });
    expect(made.status).toBe(201);
    expect(made.body.bill).toMatchObject({ status: 'DRAFT', total: 500, balance: 500, dueDate: '2026-10-20', journalEntryId: null });
    expect(await prisma.journalEntry.count()).toBe(0);
    // A bank account can't be a bill line.
    expect((await s.a.post('/books/bills').send({ vendorId: v.id, billDate: '2026-10-05', lines: [{ accountId: s.cash.id, amount: 5 }] })).body.error.code).toBe('account_not_for_bills');

    const sub = await s.a.post(`/books/bills/${made.body.bill.id}/submit`);
    expect(sub.status).toBe(202);
    expect(sub.body.title).toBe('$500.00 bill from Shell Fleet');
    // A pending bill can't be edited.
    expect((await s.a.patch(`/books/bills/${made.body.bill.id}`).send({ vendorId: v.id, billDate: '2026-10-05', lines: [{ accountId: s.fuel.id, amount: 1 }] })).body.error.code).toBe('bill_not_draft');
    // The person who entered it can't approve it.
    expect((await s.a.post(`/approvals/requests/${sub.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    const pending = (await s.b.get(`/books/bills/${made.body.bill.id}`)).body.bill;
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', approval: { status: 'PENDING', mayDecide: true } });
    expect((await s.b.post(`/approvals/requests/${sub.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);

    const bill = (await s.a.get(`/books/bills/${made.body.bill.id}`)).body.bill;
    expect(bill).toMatchObject({ status: 'APPROVED', approval: { status: 'APPROVED' } });
    expect(bill.approvedByName).toBeTruthy();
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: bill.journalEntryId }, include: { lines: true } });
    expect(entry).toMatchObject({ source: 'BILL', sourceKey: `bill:${bill.id}`, periodKey: '2026-10' });
    const ap = await accountByKey(prisma, 'AP');
    expect(await accountBalance(prisma, ap.id, '2026-10-31')).toBe(500);
    expect(await accountBalance(prisma, s.fuel.id, '2026-10-31')).toBe(412.5);
    expect(entry.lines.every((l) => l.vendorId === v.id)).toBe(true);
    expect((await trialBalance(prisma, '2026-10-31')).totals.balanced).toBe(true);
    expect((await s.a.get(`/books/vendors/${v.id}`)).body.vendor.balance).toBe(500);
  });

  it('a rejection sends it back to draft with the reason; withdraw, reopen and void work', async () => {
    const s = await seed();
    const v = await vendor(s.a);
    const made = await s.a.post('/books/bills').send({ vendorId: v.id, billDate: '2026-10-05', lines: [{ accountId: s.fuel.id, amount: 100 }] });
    const id = made.body.bill.id;
    const sub = await s.a.post(`/books/bills/${id}/submit`);
    expect((await s.b.post(`/approvals/requests/${sub.body.approvalId}/decide`).send({ decision: 'REJECT', reason: 'Not our truck' })).status).toBe(200);
    expect((await s.a.get(`/books/bills/${id}`)).body.bill).toMatchObject({ status: 'DRAFT', approval: { status: 'REJECTED', reason: 'Not our truck' } });

    await s.a.post(`/books/bills/${id}/submit`);
    expect((await s.a.post(`/books/bills/${id}/withdraw`)).body.bill.status).toBe('DRAFT');

    // Approved, then reopened: its entry is voided and the AP goes away until it's approved again.
    const bill = await approvedBill(s, v.id, 250);
    const ap = await accountByKey(prisma, 'AP');
    expect(await accountBalance(prisma, ap.id, '2026-10-31')).toBe(250);
    const reopened = await s.a.post(`/books/bills/${bill.id}/reopen`).send({ reason: 'Amount was wrong' });
    expect(reopened.body.bill).toMatchObject({ status: 'DRAFT', journalEntryId: null });
    expect((await accountBalance(prisma, ap.id, '2026-10-31')) + 0).toBe(0);
    // Approve again: the same key posts afresh.
    const sub2 = await s.a.post(`/books/bills/${bill.id}/submit`);
    await s.b.post(`/approvals/requests/${sub2.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(await accountBalance(prisma, ap.id, '2026-10-31')).toBe(250);

    expect((await s.a.post(`/books/bills/${bill.id}/void`).send({ reason: 'Duplicate invoice' })).body.bill).toMatchObject({ status: 'VOID', balance: 0 });
    expect((await accountBalance(prisma, ap.id, '2026-10-31')) + 0).toBe(0);
  });

  it('attaches the vendor’s invoice and serves it back', async () => {
    const s = await seed();
    const v = await vendor(s.a);
    const made = await s.a.post('/books/bills').send({ vendorId: v.id, billDate: '2026-10-05', lines: [{ accountId: s.fuel.id, amount: 10 }] });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    const up = await s.a.post(`/books/bills/${made.body.bill.id}/attachment`).attach('file', pdf, { filename: 'invoice 1001.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(200);
    expect(up.body.bill).toMatchObject({ hasAttachment: true });
    const got = await s.a.get(`/books/bills/${made.body.bill.id}/attachment`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/application\/pdf/);
  });
});

describe('payments', () => {
  it('pays in part and in full across bills, lowers balances, and posts AP against the bank', async () => {
    const s = await seed();
    const v = await vendor(s.a);
    const b1 = await approvedBill(s, v.id, 300);
    const b2 = await approvedBill(s, v.id, 200, '2026-10-03');
    const sources = await s.a.get('/books/bank-sources');
    expect(sources.body).toMatchObject({ ownAch: false });
    expect(sources.body.accounts.map((x: { subtype: string }) => x.subtype).sort()).toEqual(['BANK', 'BANK', 'CREDIT_CARD']);

    // Too much for a bill is refused.
    expect((await s.a.post('/books/bill-payments').send({ vendorId: v.id, paidOn: '2026-10-15', method: 'CHECK', bankAccountId: s.cash.id, applications: [{ billId: b1.id, amount: 301 }] })).body.error.code).toBe('overpayment');
    // A bank account it isn't.
    expect((await s.a.post('/books/bill-payments').send({ vendorId: v.id, paidOn: '2026-10-15', method: 'CHECK', bankAccountId: s.fuel.id, applications: [{ billId: b1.id, amount: 1 }] })).body.error.code).toBe('not_a_bank_account');
    // Our own ACH isn't on.
    expect((await s.a.post('/books/bill-payments').send({ vendorId: v.id, paidOn: '2026-10-15', method: 'ACH', sendAch: true, bankAccountId: s.cash.id, applications: [{ billId: b1.id, amount: 1 }] })).body.error.code).toBe('own_ach_off');

    const pay = await s.a.post('/books/bill-payments').send({
      vendorId: v.id,
      paidOn: '2026-10-15',
      method: 'CHECK',
      checkNumber: 1042,
      bankAccountId: s.cash.id,
      applications: [
        { billId: b1.id, amount: 300 },
        { billId: b2.id, amount: 50 },
      ],
    });
    expect(pay.status).toBe(201);
    expect(pay.body.payment).toMatchObject({ amount: 350, method: 'CHECK', checkNumber: 1042, status: 'SENT' });
    expect((await s.a.get(`/books/bills/${b1.id}`)).body.bill).toMatchObject({ status: 'PAID', balance: 0, payments: [{ amount: 300, method: 'CHECK' }] });
    expect((await s.a.get(`/books/bills/${b2.id}`)).body.bill).toMatchObject({ status: 'PARTIALLY_PAID', balance: 150 });
    const ap = await accountByKey(prisma, 'AP');
    expect(await accountBalance(prisma, ap.id, '2026-10-31')).toBe(150);
    expect(await accountBalance(prisma, s.cash.id, '2026-10-31')).toBe(-350);
    expect((await trialBalance(prisma, '2026-10-31')).totals.balanced).toBe(true);

    // A paid bill can't be voided; the payment can, and the bills are owed again.
    expect((await s.a.post(`/books/bills/${b1.id}/void`).send({ reason: 'Oops' })).body.error.code).toBe('bill_has_payments');
    const voided = await s.a.post(`/books/bill-payments/${pay.body.payment.id}/void`).send({ reason: 'Check lost in the mail' });
    expect(voided.body.payment.status).toBe('VOID');
    expect((await s.a.get(`/books/bills/${b1.id}`)).body.bill).toMatchObject({ status: 'APPROVED', balance: 300 });
    expect((await s.a.get(`/books/bills/${b2.id}`)).body.bill).toMatchObject({ status: 'APPROVED', balance: 200 });
    expect(await accountBalance(prisma, ap.id, '2026-10-31')).toBe(500);
    expect((await accountBalance(prisma, s.cash.id, '2026-10-31')) + 0).toBe(0);
  });

  it('sends a payment over the company’s own ACH to the vendor’s bank', async () => {
    const s = await seed();
    const prof = await s.b.put('/payroll-banking/profile').send({
      bankRail: 'ACH',
      achSpeed: 'NEXT_DAY',
      companyName: 'Alto HR',
      companyId: '1234567890',
      immediateDestination: ROUTING_2,
      immediateDestinationName: 'Wells Fargo',
      immediateOrigin: '1234567890',
      immediateOriginName: 'Alto HR',
      originatingDfi: '09100001',
    });
    expect([200, 202]).toContain(prof.status);
    const profile = await prisma.payrollBankingProfile.findFirst({});
    if (profile?.bankRail !== 'ACH') await prisma.payrollBankingProfile.updateMany({ data: { bankRail: 'ACH', companyName: 'Alto HR', companyId: '1234567890', immediateDestination: ROUTING_2, immediateOrigin: '1234567890', originatingDfi: '09100001' } });
    const v = await vendor(s.a, { routingNumber: ROUTING, accountNumber: '000123456789' });
    const bill = await approvedBill(s, v.id, 125.25);
    const pay = await s.a.post('/books/bill-payments').send({ vendorId: v.id, paidOn: '2026-10-19', method: 'ACH', sendAch: true, bankAccountId: s.cash.id, reference: 'OCT-FUEL', applications: [{ billId: bill.id, amount: 125.25 }] });
    expect(pay.status).toBe(201);
    expect(pay.body.payment.achFileId).toBeTruthy();
    const file = await prisma.achFile.findUniqueOrThrow({ where: { id: pay.body.payment.achFileId } });
    expect(file).toMatchObject({ purpose: 'VENDOR', entryCount: 1 });
    expect(Number(file.totalCreditCents)).toBe(12525);
    // Not yet at the bank (in-house file waiting for upload): it can still be voided.
    expect((await s.a.post(`/books/bill-payments/${pay.body.payment.id}/void`).send({ reason: 'Wrong amount' })).body.payment.status).toBe('VOID');
  });
});

describe('recurring bills', () => {
  it('makes each date’s bill once, catches up missed dates, and can go straight to approval', async () => {
    const s = await seed();
    const v = await vendor(s.a);
    const r = await s.a.post('/books/recurring-bills').send({ vendorId: v.id, name: 'Yard rent', frequency: 'MONTHLY', nextDate: '2026-08-31', lines: [{ accountId: s.rent.id, amount: 1800 }], autoSubmit: true });
    expect(r.status).toBe(201);
    expect(r.body.recurring).toMatchObject({ amount: 1800, autoSubmit: true, nextDate: '2026-08-31' });
    await runPayablesJobs(prisma, NOW);
    await runPayablesJobs(prisma, NOW);
    const bills = await prisma.bill.findMany({ where: { recurringId: r.body.recurring.id }, orderBy: { billDate: 'asc' } });
    expect(bills.map((b) => b.billDate.toISOString().slice(0, 10))).toEqual(['2026-08-31', '2026-09-30']);
    expect(bills.every((b) => b.status === 'PENDING_APPROVAL')).toBe(true);
    const list = await s.a.get('/books/recurring-bills');
    expect(list.body.recurring[0]).toMatchObject({ nextDate: '2026-10-31', billsMade: 2 });
    // Month-end stays month-end; a mid-month date keeps its day.
    expect(nextOccurrence('2026-01-31', 'MONTHLY')).toBe('2026-02-28');
    expect(nextOccurrence('2026-02-28', 'MONTHLY')).toBe('2026-03-31');
    expect(nextOccurrence('2026-01-15', 'QUARTERLY')).toBe('2026-04-15');
    expect(nextOccurrence('2026-10-19', 'WEEKLY')).toBe('2026-10-26');
    // Paused: nothing more.
    await s.a.patch(`/books/recurring-bills/${r.body.recurring.id}`).send({ isActive: false });
    await runPayablesJobs(prisma, new Date('2026-12-15T15:00:00.000Z'));
    expect(await prisma.bill.count({ where: { recurringId: r.body.recurring.id } })).toBe(2);
  });
});

describe('reports', () => {
  it('AP aging buckets open bills by days past due', async () => {
    const s = await seed();
    const v = await vendor(s.a, { termsDays: 0 });
    const w = await vendor(s.a, { name: 'Office Depot', termsDays: 0 });
    await approvedBill(s, v.id, 100, '2026-10-19'); // current
    await approvedBill(s, v.id, 200, '2026-10-01'); // 18 days
    await approvedBill(s, w.id, 300, '2026-08-01'); // 79 days
    await approvedBill(s, w.id, 400, '2026-06-01'); // 140 days
    const r = await s.a.get('/books/payables/aging');
    expect(r.body.asOf).toBe('2026-10-19');
    expect(r.body.totals).toMatchObject({ current: 100, days1to30: 200, days31to60: 0, days61to90: 300, over90: 400, total: 1000, bills: 4 });
    expect(r.body.rows[0]).toMatchObject({ vendorName: 'Office Depot', total: 700 });
  });

  it('the 1099 list counts cash, check and ACH but not card, against the year’s threshold', async () => {
    const s = await seed();
    const contractor = await vendor(s.a, { name: 'Pat the Mechanic', is1099: true });
    const small = await vendor(s.a, { name: 'Window Washer', is1099: true, taxId: '987654321', addressLine1: '1 Main', city: 'Destin', state: 'FL', zip: '32541' });
    const b1 = await approvedBill(s, contractor.id, 2500);
    const b2 = await approvedBill(s, contractor.id, 900);
    const b3 = await approvedBill(s, small.id, 400);
    await s.a.post('/books/bill-payments').send({ vendorId: contractor.id, paidOn: '2026-10-10', method: 'CHECK', bankAccountId: s.cash.id, applications: [{ billId: b1.id, amount: 2500 }] });
    await s.a.post('/books/bill-payments').send({ vendorId: contractor.id, paidOn: '2026-10-11', method: 'CARD', bankAccountId: s.card.id, applications: [{ billId: b2.id, amount: 900 }] });
    await s.a.post('/books/bill-payments').send({ vendorId: small.id, paidOn: '2026-10-12', method: 'OTHER', bankAccountId: s.cash.id, applications: [{ billId: b3.id, amount: 400 }] });
    const r = await s.a.get('/books/payables/1099?year=2026');
    expect(r.body.threshold).toBe(2000);
    expect(r.body.rows[0]).toMatchObject({ name: 'Pat the Mechanic', total: 2500, cardTotal: 900, needs1099: true, missing: ['tax ID (ask for a W-9)', 'mailing address'] });
    expect(r.body.rows[1]).toMatchObject({ name: 'Window Washer', total: 400, needs1099: false, missing: [] });
    const csv = await s.a.get('/books/payables/1099?year=2026&format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Pat the Mechanic,');
    await flushPendingAudits();
    await flushPendingNotifications();
  });
});
