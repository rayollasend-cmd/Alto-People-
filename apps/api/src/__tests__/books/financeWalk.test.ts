import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountBalance, accountByKey, cashOnHand, postEntry } from '../../lib/books/ledger.js';
import { postStatement } from '../../lib/books/posting/statements.js';
import { recordClientPayment } from '../../lib/books/posting/receivables.js';
import { flushPendingBooks } from '../../lib/books/posting/common.js';
import { cashForecast } from '../../lib/cashForecast.js';
import { totalsWithTax } from '../../lib/clientStatement.js';
import { remittanceStub, statementContext, statementMoney } from '../../lib/statementPdf.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import type { StatementSnapshot } from '../../lib/clientStatement.js';

/**
 * The finance and books walk (2026-10-20) and audit Tier 1 #17/#18:
 *
 *   sales tax       a taxable client's statement carries its tax; the PDF and
 *                   the books read it (it was always $0.00)
 *   remit-to        the company's stored remit-to prints on every invoice
 *   cash forecast   starts at the Books cash balance, carries the bills, and
 *                   never drops a payday — every week's numbers add up
 *   one source      the finance home, Books, Receivables and the executive
 *                   view show the same receivables, the same buckets, the
 *                   same "oldest"; the Books close count equals the close page
 *   close inline    finalize the month's statements and post history from the
 *                   checklist; the liabilities step checks itself
 *   bill run        several vendors paid in one run, all or nothing
 *   collections     the worklist, "send reminder now", promises, DSO
 *   roll-up         the statement week close with due, days late, Δ, missing weeks
 */

type Agent = TestAgent<Test>;
const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFrom = (n: number) => new Date(Date.now() + n * DAY);
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function people() {
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
  return { fin, owner, a: await loginAs(agent(), fin.email), b: await loginAs(agent(), owner.email), e: await loginAs(agent(), exec.email) };
}

async function finalStatement(clientId: string, o: { amount: number; number: number; dueAt: Date | null; finalizedAt?: Date; periodStart?: Date; hours?: number; post?: boolean }) {
  const periodStart = o.periodStart ?? new Date(Date.UTC(2026, 8, 1 + o.number * 7));
  const st = await prisma.clientStatement.create({
    data: {
      clientId,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 6 * DAY),
      status: 'FINAL',
      number: o.number,
      finalizedAt: o.finalizedAt ?? new Date((o.dueAt ?? new Date()).getTime() - 30 * DAY),
      dueAt: o.dueAt,
      snapshot: { totals: { amount: o.amount, hours: o.hours ?? 10, regularHours: o.hours ?? 10, otHours: 0 }, lines: [], stores: [] },
    },
  });
  if (o.post !== false) await postStatement(prisma, st.id);
  return st;
}

/* ---- #17: sales tax and remit-to ----------------------------------------- */

describe('sales tax on a statement (audit #17)', () => {
  it('a taxable client’s statement carries the tax, the books owe it to the state, and the invoice reads it', async () => {
    const p = await people();
    const client = await createClient('Harbor Grill');
    // Taxable without a rate is refused.
    expect((await p.a.patch(`/clients/${client.id}/billing-terms`).send({ salesTaxable: true })).body.error.code).toBe('tax_rate_required');
    const terms = await p.a.patch(`/clients/${client.id}/billing-terms`).send({ salesTaxable: true, salesTaxRatePct: 7 });
    expect(terms.body).toMatchObject({ salesTaxable: true, salesTaxRatePct: 7 });

    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Cook' });
    const start = new Date('2026-09-08T14:00:00Z');
    const shift = await prisma.shift.create({ data: { clientId: client.id, position: 'Cook', startsAt: start, endsAt: new Date(start.getTime() + 8 * 3_600_000), status: 'COMPLETED', assignedAssociateId: ana.id, hourlyRate: 25 } });
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, shiftId: shift.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * 3_600_000), status: 'APPROVED' } });

    const draft = await p.a.post(`/clients/${client.id}/statements`).send({ periodStart: '2026-09-07', periodEnd: '2026-09-13' });
    expect(draft.status).toBe(200);
    const t = draft.body.snapshot.totals;
    expect(t).toMatchObject({ hoursAmount: 200, subtotal: 200, salesTaxRatePct: 7, salesTax: 14, amount: 214 });
    // The sum shown equals the sum of the rows.
    expect(sum(draft.body.snapshot.lines.map((l: { amount: number }) => l.amount))).toBe(t.hoursAmount);
    expect(sum([t.subtotal, t.salesTax])).toBe(t.amount);

    const fin = await p.a.post(`/clients/${client.id}/statements/${draft.body.id}/finalize`);
    expect(fin.status).toBe(200);
    expect(fin.body.snapshot.totals).toMatchObject({ salesTax: 14, amount: 214 });
    // Finalizing posts it (lib/books/posting/hooks).
    await flushPendingBooks();
    const bal = async (key: string) => accountBalance(prisma, (await accountByKey(prisma, key)).id, '2099-12-31');
    expect(await bal('AR')).toBe(214);
    expect(await bal('REVENUE_STAFFING')).toBe(200);
    expect(await bal('SALES_TAX_PAYABLE')).toBe(14);

    // The invoice: subtotal, the tax and its rate, the total.
    const money = statementMoney(fin.body.snapshot as StatementSnapshot);
    expect(money).toMatchObject({ hoursAmount: 200, subtotal: 200, salesTax: 14, salesTaxRate: 7, total: 214 });
    const pdf = await p.a.get(`/clients/${client.id}/statements/${draft.body.id}.pdf`);
    expect(pdf.status).toBe(200);
  });

  it('the tax follows the subtotal when adjustments change it; an old snapshot reads as untaxed', () => {
    expect(totalsWithTax({ hoursAmount: 1000, adjustmentsAmount: 50, salesTaxRatePct: 7 })).toEqual({ hoursAmount: 1000, adjustmentsAmount: 50, subtotal: 1050, salesTaxRatePct: 7, salesTax: 73.5, amount: 1123.5 });
    expect(totalsWithTax({ hoursAmount: 1000, adjustmentsAmount: 0, salesTaxRatePct: null })).toMatchObject({ salesTax: 0, amount: 1000 });
    const old = { clientName: 'X', periodStart: '2026-01-01', periodEnd: '2026-01-07', lines: [], stores: [], totals: { hours: 1, regularHours: 1, otHours: 0, amount: 120 }, sla: { publishedShifts: 0, assignedShifts: 0, fillRatePct: null, punctualPct: null, noShows: 0, pendingEntries: 0 } } as StatementSnapshot;
    expect(statementMoney(old)).toMatchObject({ subtotal: 120, salesTax: 0, total: 120 });
  });
});

describe('the remit-to (audit #17)', () => {
  it('is stored in company settings and printed on the invoice and its stub; without it, the employer of record', async () => {
    const p = await people();
    const client = await createClient('Harbor Grill');
    const st = await finalStatement(client.id, { amount: 500, number: 1, dueAt: daysFrom(10) });
    await prisma.employerOrganization.create({ data: { kind: 'TENANT', legalName: 'Alto HR Inc.', addressLine1: '1 Main St', city: 'Destin', state: 'FL', zip: '32541', isDefault: true } as never });
    const before = await statementContext(prisma, { statementId: st.id, clientId: client.id, tenantId: ALTO_TENANT_ID });
    expect(before.remitTo).toMatchObject({ name: 'Alto HR Inc.', lines: ['1 Main St', 'Destin, FL 32541'] });

    const saved = await p.b.patch('/admin/org/settings').send({ remitToName: 'Alto HR LLC', remitToAddress: 'PO Box 12\nDestin, FL 32541', remitToInstructions: 'ACH to Gulf Bank, routing 011000015', cashMinimum: 25000 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ remitToName: 'Alto HR LLC', remitToAddress: 'PO Box 12\nDestin, FL 32541', cashMinimum: 25000 });
    const ctx = await statementContext(prisma, { statementId: st.id, clientId: client.id, tenantId: ALTO_TENANT_ID });
    expect(ctx.remitTo).toEqual({ name: 'Alto HR LLC', lines: ['PO Box 12', 'Destin, FL 32541'], instructions: 'ACH to Gulf Bank, routing 011000015' });
    expect(remittanceStub({ snapshot: st.snapshot as unknown as StatementSnapshot, number: 1, status: 'FINAL', finalizedAt: st.finalizedAt, ...ctx }).payTo).toBe('Alto HR LLC');
    // Finance can read the settings; only manage:org writes them.
    expect((await p.a.patch('/admin/org/settings').send({ remitToName: 'x' })).status).toBe(403);
  });
});

/* ---- #18 / walk 2: the cash forecast ------------------------------------- */

describe('the cash forecast (audit #18, walk 2)', () => {
  it('starts at the Books cash, carries the bills, never drops a payday, and marks the low point against the floor', async () => {
    const today = ymd(new Date());
    await postEntry(prisma, { date: today, source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 5000 }, { account: 'OWNER_EQUITY', credit: 5000 }] });
    expect(await cashOnHand(prisma, today)).toMatchObject({ total: 5000 });
    // Nobody on the schedule, and the last run paid two months ago.
    await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date(Date.now() - 10 * DAY), payDateOffsetDays: 5 } });
    await prisma.payrollRun.create({ data: { periodStart: daysFrom(-75), periodEnd: daysFrom(-62), status: 'DISBURSED', disbursedAt: daysFrom(-55), totalNet: 3490.2, totalGross: 4054.5 } });
    const vendor = await prisma.vendor.create({ data: { name: 'Shell Fleet' } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billNumber: 'F-1', billDate: daysFrom(-5), dueDate: daysFrom(3), status: 'APPROVED', total: 250, balance: 250 } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billNumber: 'F-0', billDate: daysFrom(-40), dueDate: daysFrom(-10), status: 'PARTIALLY_PAID', total: 400, balance: 120 } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billNumber: 'F-9', billDate: daysFrom(-5), dueDate: daysFrom(3), status: 'PENDING_APPROVAL', total: 999, balance: 999 } });
    await prisma.orgSetting.upsert({ where: { tenantId: ALTO_TENANT_ID }, create: { id: 'singleton', tenantId: ALTO_TENANT_ID, cashMinimum: 10000 }, update: { cashMinimum: 10000 } });

    const f = await cashForecast(new Date(), { weeks: 8 });
    expect(f.opening).toMatchObject({ balance: 5000 });
    expect(f.minimumCash).toBe(10000);
    const bills = f.lines.filter((l) => l.kind === 'BILL');
    expect(bills.map((b) => b.amount).sort((x, y) => x - y)).toEqual([-250, -120]);
    expect(bills.find((b) => b.amount === -120)).toMatchObject({ date: today, confidence: 'overdue' });
    // Both paydays in the horizon are there, each at the last run's net, flagged.
    const pay = f.lines.filter((l) => l.kind === 'PAYROLL');
    expect(pay.length).toBe(2);
    for (const l of pay) expect(l).toMatchObject({ amount: -3490.2, confidence: 'estimated' });
    expect(pay.some((l) => l.warning?.startsWith('0 people on schedule'))).toBe(true);

    // Every number adds up: weeks to lines, balance to opening + running total.
    expect(sum(f.weeks.map((w) => w.net))).toBe(f.totals.net);
    expect(f.totals.net).toBe(sum(f.lines.map((l) => l.amount)));
    for (const w of f.weeks) expect(w.balance).toBe(Math.round((5000 + w.cumulative) * 100) / 100);
    const low = f.weeks.reduce((m, w) => (w.balance < m.balance ? w : m));
    expect(f.lowest).toEqual({ weekStart: low.weekStart, balance: low.balance, belowMinimum: true });
  });
});

/* ---- walk 3 / 15: one source per figure ----------------------------------- */

describe('one source per figure (walk 3, 15)', () => {
  it('the finance home, Books, Receivables and the executive view show the same receivables, buckets and oldest', async () => {
    const p = await people();
    const coastal = await createClient('Coastal Resort');
    const bay = await createClient('Bay Group');
    await finalStatement(coastal.id, { amount: 1000, number: 1, dueAt: daysFrom(-40) });
    await finalStatement(coastal.id, { amount: 500, number: 2, dueAt: daysFrom(10) });
    const late = await finalStatement(bay.id, { amount: 300, number: 3, dueAt: daysFrom(-72) });
    // A partial payment: the open balance is what every screen counts.
    await recordClientPayment(prisma, { clientId: bay.id, receivedOn: ymd(new Date()), amount: 100, method: 'ACH', applications: [{ statementId: late.id, amount: 100 }], userId: p.fin.id });
    await flushPendingBooks();

    const books = (await p.a.get('/books/receivables')).body;
    const home = (await p.a.get('/finance/overview')).body.receivables;
    const overview = (await p.a.get('/books/overview')).body.receivables;
    const exec = (await p.e.get('/executive/receivables')).body;

    expect(books.totals.open).toBe(1700);
    expect(sum(books.statements.map((s: { open: number }) => s.open))).toBe(books.totals.open);
    expect(home.outstandingTotal).toBe(1700);
    expect(sum(Object.values(home.aging as Record<string, number>))).toBe(home.outstandingTotal);
    expect(sum(home.byClient.map((c: { amount: number }) => c.amount))).toBe(home.outstandingTotal);
    expect(home.aging).toEqual(books.totals.buckets);
    expect(home.oldestDays).toBe(72);
    expect(Math.max(...books.statements.map((s: { daysPastDue: number }) => s.daysPastDue))).toBe(72);
    expect(home.byClient.find((c: { clientName: string }) => c.clientName === 'Bay Group').oldestDays).toBe(72);
    expect(overview.openOnStatements).toBe(1700);
    expect(overview.aging).toEqual(books.totals.buckets);
    expect(exec.totals.outstandingAmount).toBe(1700);
    expect(sum(exec.outstanding.map((s: { amount: number }) => s.amount))).toBe(exec.totals.outstandingAmount);
    expect(exec.totals.aging).toEqual(books.totals.buckets);
    expect(exec.outstanding[0].ageDays).toBe(72);
  });

  it('Books home counts the close as the close page does, names repeated sites by client, and counts connected bank accounts', async () => {
    const p = await people();
    const o = (await p.a.get('/books/overview')).body;
    const close = (await p.a.get(`/books/close/${o.close.periodKey}`)).body;
    expect(o.close.tasksDone).toBe(close.tasksDone);
    expect(o.close.tasksTotal).toBe(close.tasksTotal);
    expect(o.cash.connectedAccounts).toBe(0);
    await prisma.bankFeedAccount.create({ data: { ledgerAccountId: (await accountByKey(prisma, 'CASH_OPERATING')).id, name: 'Operating ••4410' } });
    expect((await p.a.get('/books/overview')).body.cash.connectedAccounts).toBe(1);

    const a = await createClient('Coastal Resorts');
    const b = await createClient('Bay Group');
    await prisma.site.updateMany({ where: { clientId: { in: [a.id, b.id] } }, data: { name: 'The Grand Hotel' } });
    const d = (await p.a.get('/books/dimensions')).body;
    const names = d.sites.map((s: { name: string }) => s.name).filter((n: string) => n.startsWith('The Grand Hotel'));
    expect(names.sort()).toEqual(['The Grand Hotel · Bay Group', 'The Grand Hotel · Coastal Resorts']);
  });
});

/* ---- walk 16: the close, done on the checklist ----------------------------- */

describe('month-end close steps done inline (walk 16)', () => {
  const task = (body: { tasks: Array<{ key: string }> }, key: string) => body.tasks.find((t) => t.key === key) as unknown as { status: string; passing: boolean | null; summary: string; action: { kind: string; label: string } | null; items: unknown[] };

  it('finalizes the month’s drafts and posts history from the checklist', async () => {
    const p = await people();
    const client = await createClient('Harbor Grill');
    const draft = await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-09-14T00:00:00Z'), periodEnd: new Date('2026-09-20T00:00:00Z'), status: 'DRAFT', snapshot: { totals: { amount: 640, hours: 32, regularHours: 32, otHours: 0 }, lines: [], stores: [] } } });
    // A statement finalized in September that never reached the ledger.
    await finalStatement(client.id, { amount: 300, number: 9, dueAt: new Date('2026-10-10T00:00:00Z'), finalizedAt: new Date('2026-09-10T12:00:00Z'), periodStart: new Date('2026-09-01T00:00:00Z'), post: false });

    const before = (await p.a.get('/books/close/2026-09')).body;
    expect(task(before, 'statements_final').action).toEqual({ kind: 'finalize_statements', label: 'Finalize 1 statement' });
    expect(task(before, 'nothing_to_post').action).toEqual({ kind: 'post_history', label: 'Post history' });

    const fin = await p.a.post('/books/close/2026-09/finalize-statements');
    expect(fin.status).toBe(200);
    expect(fin.body.finalized).toBe(1);
    expect(task(fin.body.month, 'statements_final')).toMatchObject({ passing: true, action: null });
    const row = await prisma.clientStatement.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row).toMatchObject({ status: 'FINAL' });
    expect(row.number).not.toBeNull();
    expect(row.dueAt).not.toBeNull();

    await flushPendingBooks();
    const posted = await p.a.post('/books/close/2026-09/post-history');
    expect(posted.status).toBe(200);
    expect(task(posted.body.month, 'nothing_to_post')).toMatchObject({ passing: true, action: null });
    // Executives read the close; they don't work it.
    expect((await p.e.post('/books/close/2026-09/finalize-statements')).status).toBe(403);
  });

  it('ties the payroll tax liability to the deposits still owed, by itself', async () => {
    const p = await people();
    await postEntry(prisma, { date: '2026-09-15', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 564.3 }, { account: 'FIT_PAYABLE', credit: 564.3 }] });
    const off = task((await p.a.get('/books/close/2026-09')).body, 'payroll_liabilities');
    expect(off).toMatchObject({ status: 'OPEN', passing: false });
    expect(off.summary).toMatch(/\$564\.30 on the books with no deposit accrued/);
    // Can't be ticked by hand any more: it checks itself.
    expect((await p.a.post('/books/close/2026-09/tasks/payroll_liabilities').send({ status: 'DONE' })).body.error.code).toBe('auto_task');

    await prisma.taxDeposit.create({ data: { kind: 'FED_941', scheduleUsed: 'MONTHLY', periodLabel: 'Sep 2026', liabilityDate: new Date('2026-09-15'), dueDate: new Date('2026-10-15'), amount: 564.3, breakdown: {} } });
    const on = task((await p.a.get('/books/close/2026-09')).body, 'payroll_liabilities');
    expect(on).toMatchObject({ status: 'DONE', passing: true });
  });
});

/* ---- walk 8: pay several vendors in one run --------------------------------- */

describe('the bill run (walk 8)', () => {
  async function approvedBill(a: Agent, b: Agent, vendorId: string, amount: number, number: string) {
    const fuel = await accountByKey(prisma, 'FUEL');
    const made = await a.post('/books/bills').send({ vendorId, billDate: ymd(daysFrom(-3)), billNumber: number, lines: [{ accountId: fuel.id, amount, description: 'Fuel' }] });
    expect(made.status).toBe(201);
    const sub = await a.post(`/books/bills/${made.body.bill.id}/submit`);
    expect((await b.post(`/approvals/requests/${sub.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    return made.body.bill.id as string;
  }

  it('pays several vendors in one go, all or nothing, and says the cash left', async () => {
    const p = await people();
    await postEntry(prisma, { date: ymd(daysFrom(-10)), source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 2000 }, { account: 'OWNER_EQUITY', credit: 2000 }] });
    const shell = (await p.a.post('/books/vendors').send({ name: 'Shell Fleet', termsDays: 15 })).body.vendor.id as string;
    const lease = (await p.a.post('/books/vendors').send({ name: 'Coastal Van Lease', termsDays: 15 })).body.vendor.id as string;
    const s1 = await approvedBill(p.a, p.b, shell, 300, 'S-1');
    const s2 = await approvedBill(p.a, p.b, shell, 200, 'S-2');
    const l1 = await approvedBill(p.a, p.b, lease, 450, 'L-1');
    const cash = await accountByKey(prisma, 'CASH_OPERATING');

    // One bad line (more than the bill owes) stops the whole run before anything posts.
    const bad = await p.a.post('/books/bill-payments/batch').send({ paidOn: ymd(new Date()), method: 'CHECK', bankAccountId: cash.id, vendors: [{ vendorId: shell, applications: [{ billId: s1, amount: 300 }] }, { vendorId: lease, applications: [{ billId: l1, amount: 999 }] }] });
    expect(bad.status).toBe(400);
    expect(await prisma.billPayment.count()).toBe(0);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: s1 } })).status).toBe('APPROVED');

    const run = await p.a.post('/books/bill-payments/batch').send({
      paidOn: ymd(new Date()),
      method: 'CHECK',
      bankAccountId: cash.id,
      vendors: [
        { vendorId: shell, checkNumber: 1001, applications: [{ billId: s1, amount: 300 }, { billId: s2, amount: 200 }] },
        { vendorId: lease, checkNumber: 1002, applications: [{ billId: l1, amount: 450 }] },
      ],
    });
    expect(run.status).toBe(201);
    expect(run.body.payments).toHaveLength(2);
    expect(sum(run.body.payments.map((x: { amount: number }) => x.amount))).toBe(950);
    for (const id of [s1, s2, l1]) expect((await prisma.bill.findUniqueOrThrow({ where: { id } })).status).toBe('PAID');
    expect(run.body.cashAfter).toBe(1050);
    expect((await p.a.get('/books/payables/options')).body.cashOnHand).toBe(1050);
  });
});

/* ---- walk 7: collections ------------------------------------------------------ */

describe('the collections worklist (walk 7)', () => {
  it('lists each open statement with its reminder stage and next action; send now, promise to pay, and the DSO trend', async () => {
    const p = await people();
    const client = await createClient('Coastal Resort');
    await prisma.client.update({ where: { id: client.id }, data: { contactEmail: 'ap@coastal.test' } });
    const late = await finalStatement(client.id, { amount: 900, number: 5, dueAt: daysFrom(-10) });
    await finalStatement(client.id, { amount: 400, number: 6, dueAt: daysFrom(20) });
    const today = ymd(new Date());

    const w = (await p.a.get('/books/receivables/worklist')).body;
    expect(w.items).toHaveLength(2);
    expect(w.totals.open).toBe(1300);
    expect(sum(w.items.map((i: { open: number }) => i.open))).toBe(w.totals.open);
    expect(w.items[0]).toMatchObject({ statementId: late.id, daysPastDue: 10, reminderStage: 0, nextActionOn: today, paused: false });

    const sent = await p.a.post(`/clients/${client.id}/dunning/send-now`).send({ statementId: late.id });
    expect(sent.status).toBe(200);
    expect(sent.body.stage).toBe(3);
    expect(await prisma.clientStatementReminder.count({ where: { statementId: late.id, stage: 3 } })).toBe(1);

    expect((await p.a.post(`/clients/${client.id}/collection-notes`).send({ kind: 'PROMISE', note: 'Check Friday', statementId: late.id })).status).toBe(400);
    const promisedOn = ymd(daysFrom(5));
    const note = await p.a.post(`/clients/${client.id}/collection-notes`).send({ kind: 'PROMISE', note: 'Check Friday', statementId: late.id, promisedOn, promisedAmount: 900 });
    expect(note.status).toBe(201);
    const after = (await p.a.get('/books/receivables/worklist')).body.items.find((i: { statementId: string }) => i.statementId === late.id);
    expect(after).toMatchObject({ reminderStage: 3, lastNote: { kind: 'PROMISE', promisedOn, promisedAmount: 900 }, nextActionOn: promisedOn });
    expect(after.lastReminderAt).not.toBeNull();
    expect((await p.a.get(`/clients/${client.id}/collection-notes`)).body.notes).toHaveLength(1);

    // Days to collect, by the month payments landed.
    await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-07'), status: 'FINAL', number: 1, finalizedAt: daysFrom(-20), paidAt: new Date(), snapshot: { totals: { amount: 100 } } } });
    const dso = (await p.a.get('/books/receivables/dso?months=3')).body.months;
    expect(dso).toHaveLength(3);
    expect(dso[2]).toMatchObject({ key: today.slice(0, 7), days: 20, statements: 1, collected: 100 });
  });
});

/* ---- walk 6: the statement week close ------------------------------------------ */

describe('the statement week close (walk 6)', () => {
  it('shows due, days late, the change against the last statement, and the weeks no statement covers', async () => {
    const p = await people();
    const client = await createClient('Harbor Grill');
    const prev = await finalStatement(client.id, { amount: 1000, number: 1, hours: 40, dueAt: daysFrom(-5), periodStart: new Date('2026-09-07T00:00:00Z') });
    const draft = await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-09-14T00:00:00Z'), periodEnd: new Date('2026-09-20T00:00:00Z'), status: 'DRAFT', snapshot: { totals: { amount: 1300, hours: 52, regularHours: 52, otHours: 0 }, lines: [], stores: [] } } });
    // Approved work 20 days ago that no statement covers.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Cook' });
    const at = daysFrom(-20);
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, clockInAt: at, clockOutAt: new Date(at.getTime() + 6 * 3_600_000), status: 'APPROVED' } });

    const r = await p.a.get('/clients/statements/rollup');
    expect(r.status).toBe(200);
    const d = r.body.statements.find((s: { id: string }) => s.id === draft.id);
    expect(d.previous).toMatchObject({ statementId: prev.id, hours: 40, amount: 1000 });
    const f = r.body.statements.find((s: { id: string }) => s.id === prev.id);
    expect(f).toMatchObject({ dueOn: ymd(daysFrom(-5)), daysLate: 5, open: 1000 });
    expect(r.body.missingWeeks).toEqual([expect.objectContaining({ clientId: client.id, clientName: 'Harbor Grill', hours: 6 })]);
  });
});
