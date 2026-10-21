import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountBalance, accountByKey, postEntry } from '../../lib/books/ledger.js';
import { postStatement } from '../../lib/books/posting/statements.js';
import { createFeedAccount, createRule, importFile, listTransactions } from '../../lib/books/bank/service.js';

/**
 * The bank review under pressure: two people (or two tabs) deciding the same
 * thing at once, two bank lines that could be the same entry, a decision
 * undone in a closed month, and a deposit recorded as a client's payment —
 * then taken back from either side.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const CSV = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,10/02/2026,"SHELL OIL 57444",-62.10,DEBIT_CARD,9937.90,
CREDIT,10/03/2026,"COASTAL RESORT HOLDINGS ACH",4200.00,ACH_CREDIT,14137.90,
DEBIT,10/05/2026,"STARBUCKS #1234",-5.25,DEBIT_CARD,14132.65,
DEBIT,10/06/2026,"STARBUCKS #1234",-5.25,DEBIT_CARD,14127.40,
CREDIT,10/08/2026,"HARBOR GRILL LLC DEPOSIT",900.00,ACH_CREDIT,13527.40,
`;

async function setup(csv = CSV) {
  const cash = await accountByKey(prisma, 'CASH_OPERATING');
  const feed = await createFeedAccount(prisma, { ledgerAccountId: cash.id }, null);
  await importFile(prisma, feed.id, 'chase.csv', csv, undefined, null);
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const a = await loginAs(agent(), fin.email);
  const a2 = await loginAs(agent(), fin.email);
  const { transactions } = await listTransactions(prisma, feed.id, { status: 'UNMATCHED' });
  const by = (start: string) => transactions.filter((t) => t.description.startsWith(start));
  return { feed, cash, a, a2, fin, by, transactions };
}

async function statement(clientId: string, amount: number) {
  const st = await prisma.clientStatement.create({
    data: {
      clientId,
      periodStart: new Date('2026-09-21'),
      periodEnd: new Date('2026-09-27'),
      status: 'FINAL',
      number: 7,
      finalizedAt: new Date('2026-09-28T12:00:00Z'),
      dueAt: new Date('2026-10-12'),
      snapshot: { totals: { amount }, lines: [], stores: [] },
    },
  });
  await postStatement(prisma, st.id);
  return st;
}

describe('a deposit recorded as a payment', () => {
  it('twice at once: one payment, the cash once, the other told it’s decided', async () => {
    const s = await setup();
    const client = await createClient('Coastal Resort');
    const st = await statement(client.id, 4200);
    const deposit = s.by('COASTAL')[0]!;
    const body = { clientId: client.id, receivedOn: '2026-10-03', amount: 4200, method: 'ACH', bankTransactionId: deposit.id, applications: [{ statementId: st.id, amount: 4200 }] };
    const [r1, r2] = await Promise.all([s.a.post('/books/receivables/payments').send(body), s.a2.post('/books/receivables/payments').send(body)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const ok = r1.status === 201 ? r1 : r2;
    expect(ok.body.depositMatched).toBe(true);
    expect(ok.body.bankTransaction).toMatchObject({ status: 'MATCHED', matched: { entryId: ok.body.payment.journalEntryId } });
    expect(await prisma.clientPayment.count()).toBe(1);
    expect(await accountBalance(prisma, s.cash.id, '2026-12-31')).toBe(4200);
  });

  it('is received on the deposit’s date, whatever was sent', async () => {
    const s = await setup();
    const client = await createClient('Harbor Grill');
    const r = await s.a.post('/books/receivables/payments').send({ clientId: client.id, receivedOn: '2026-08-15', amount: 900, method: 'ACH', bankTransactionId: s.by('HARBOR')[0]!.id, applications: [] });
    expect(r.status).toBe(201);
    expect(r.body.payment.receivedOn).toBe('2026-10-08');
  });

  it('undone from Receivables, the deposit goes back to review', async () => {
    const s = await setup();
    const client = await createClient('Harbor Grill');
    const deposit = s.by('HARBOR')[0]!;
    const r = await s.a.post('/books/receivables/payments').send({ clientId: client.id, receivedOn: '2026-10-08', amount: 900, method: 'ACH', bankTransactionId: deposit.id, applications: [] });
    expect((await s.a.delete(`/books/receivables/payments/${r.body.payment.id}`).send({ reason: 'Wrong client' })).status).toBe(204);
    expect(await prisma.bankTransaction.findUniqueOrThrow({ where: { id: deposit.id } })).toMatchObject({ status: 'UNMATCHED', matchedLineId: null });
    expect(await accountBalance(prisma, s.cash.id, '2026-12-31')).toBe(0);
  });

  it('undone from the bank: only the match by default (the payment named), or the payment too when asked', async () => {
    const s = await setup();
    const client = await createClient('Harbor Grill');
    const deposit = s.by('HARBOR')[0]!;
    const rec = () => s.a.post('/books/receivables/payments').send({ clientId: client.id, receivedOn: '2026-10-08', amount: 900, method: 'ACH', bankTransactionId: deposit.id, applications: [] });

    const first = await rec();
    const matchOnly = await s.a.post(`/books/bank/transactions/${deposit.id}/undo`).send({});
    expect(matchOnly.body).toMatchObject({ transaction: { status: 'UNMATCHED' }, paymentKept: { id: first.body.payment.id, clientName: 'Harbor Grill' }, paymentUndone: false });
    expect((await prisma.clientPayment.findUniqueOrThrow({ where: { id: first.body.payment.id } })).voidedAt).toBeNull();
    // Take the first one back by hand, then record and undo whole.
    await s.a.delete(`/books/receivables/payments/${first.body.payment.id}`).send({ reason: 'Recorded twice' });

    const second = await rec();
    expect(second.status).toBe(201);
    const whole = await s.a.post(`/books/bank/transactions/${deposit.id}/undo`).send({ undoPayment: true });
    expect(whole.body).toMatchObject({ transaction: { status: 'UNMATCHED' }, paymentUndone: true });
    expect((await prisma.clientPayment.findUniqueOrThrow({ where: { id: second.body.payment.id } })).voidedAt).not.toBeNull();
    expect(await accountBalance(prisma, s.cash.id, '2026-12-31')).toBe(0);
  });

  it('a card’s credit is never a payment', async () => {
    const card = await prisma.ledgerAccount.create({ data: { code: '2105', name: 'Company card', type: 'LIABILITY', subtype: 'CREDIT_CARD' } });
    const feed = await createFeedAccount(prisma, { ledgerAccountId: card.id }, null);
    await importFile(prisma, feed.id, 'card.csv', `Date,Description,Amount\n10/03/2026,COASTAL RESORT REFUND,120.00\n`, undefined, null);
    const client = await createClient('Coastal Resort');
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    const [t] = (await listTransactions(prisma, feed.id, { status: 'UNMATCHED' })).transactions;
    const sug = await a.post('/books/bank/transactions/suggestions').send({ ids: [t!.id] });
    expect(sug.body.suggestions[t!.id].client).toBeNull();
    const r = await a.post('/books/receivables/payments').send({ clientId: client.id, receivedOn: '2026-10-03', amount: 120, method: 'ACH', bankTransactionId: t!.id, applications: [] });
    expect(r.body.error.code).toBe('invalid_deposit_account');
  });
});

describe('who a deposit is from', () => {
  it('never a deleted client, never a refund, and nobody when two names tie', async () => {
    const csv = `Date,Description,Amount\n10/03/2026,COASTAL RESORT ACH,500.00\n10/04/2026,HARBOR GRILL REFUND,40.00\n10/05/2026,BAYSIDE CAFE DEPOSIT,75.00\n`;
    const s = await setup(csv);
    const coastal = await createClient('Coastal Resort');
    await prisma.client.update({ where: { id: coastal.id }, data: { deletedAt: new Date() } });
    await createClient('Harbor Grill');
    await createClient('Bayside Cafe');
    await createClient('Bayside Cafe LLC'); // the same name, reduced — two clients, no telling which
    const ids = s.transactions.map((t) => t.id);
    const sug = (await s.a.post('/books/bank/transactions/suggestions').send({ ids })).body.suggestions;
    for (const t of s.transactions) expect(sug[t.id].client).toBeNull();
  });
});

describe('two bank lines, one entry', () => {
  const TWO = `Date,Description,Amount\n10/01/2026,TRANSFER IN,1000.00\n10/05/2026,TRANSFER IN,1000.00\n`;

  it('the entry is exact only for the bank line on its day; Match all exact leaves the other alone', async () => {
    const s = await setup(TWO);
    await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', sourceKey: 'xfer', lines: [{ account: 'CASH_OPERATING', debit: 1000 }, { account: 'RENT', credit: 1000 }] });
    const early = s.transactions.find((t) => t.postedOn === '2026-10-01')!;
    const onDay = s.transactions.find((t) => t.postedOn === '2026-10-05')!;
    const sug = (await s.a.post('/books/bank/transactions/suggestions').send({ ids: [early.id, onDay.id] })).body.suggestions;
    expect(sug[onDay.id].exactLineId).toBeTruthy();
    expect(sug[early.id].exactLineId).toBeNull();
    expect(sug[early.id].matches).toHaveLength(1); // still offered, for a person to choose

    const r = await s.a.post('/books/bank/transactions/bulk').send({ action: 'MATCH', ids: [early.id, onDay.id] });
    expect(r.body.done).toEqual([onDay.id]);
    expect(r.body.skipped).toEqual([{ id: early.id, reason: expect.stringMatching(/closer match/) }]);
  });

  it('two matches of one line at once: one wins', async () => {
    const s = await setup(TWO);
    const e = await postEntry(prisma, { date: '2026-10-03', source: 'MANUAL', sourceKey: 'xfer', lines: [{ account: 'CASH_OPERATING', debit: 1000 }, { account: 'RENT', credit: 1000 }] });
    const lineId = e.lines.find((l) => Number(l.debit) === 1000)!.id;
    const [x, y] = s.transactions;
    const [r1, r2] = await Promise.all([s.a.post(`/books/bank/transactions/${x!.id}/match`).send({ lineId }), s.a2.post(`/books/bank/transactions/${y!.id}/match`).send({ lineId })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await prisma.bankTransaction.count({ where: { matchedLineId: lineId } })).toBe(1);
  });
});

describe('deciding the same thing at once', () => {
  it('four bulk Accepts together: no failures, each transaction posted once, nothing voided', async () => {
    const s = await setup();
    const office = await accountByKey(prisma, 'OFFICE_SUPPLIES');
    const fuel = await accountByKey(prisma, 'FUEL');
    await createRule(prisma, { name: 'Coffee', contains: 'starbucks', direction: 'OUT', accountId: office.id, priority: 10, autoApply: false, isActive: true }, null);
    await createRule(prisma, { name: 'Fuel', contains: 'shell', direction: 'OUT', accountId: fuel.id, priority: 10, autoApply: false, isActive: true }, null);
    const ids = s.transactions.map((t) => t.id);
    const sessions = [s.a, s.a2, await loginAs(agent(), s.fin.email), await loginAs(agent(), s.fin.email)];
    const all = await Promise.all(sessions.map((x) => x.post('/books/bank/transactions/bulk').send({ action: 'ACCEPT', ids })));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(all.flatMap((r) => r.body.done as string[]).sort()).toEqual([...s.by('STARBUCKS'), ...s.by('SHELL')].map((t) => t.id).sort());
    expect(await prisma.journalEntry.count({ where: { source: 'BANK', status: 'POSTED' } })).toBe(3);
    expect(await prisma.journalEntry.count({ where: { source: 'BANK', status: 'VOID' } })).toBe(0);
    expect(await accountBalance(prisma, office.id, '2026-12-31')).toBe(10.5);
  });

  it('a payment-looking deposit is left for Receivables, not accepted into a category', async () => {
    const s = await setup();
    await createClient('Coastal Resort');
    const income = await accountByKey(prisma, 'REVENUE_STAFFING');
    await createRule(prisma, { name: 'Coastal', contains: 'coastal', direction: 'IN', accountId: income.id, priority: 10, autoApply: false, isActive: true }, null);
    const r = await s.a.post('/books/bank/transactions/bulk').send({ action: 'ACCEPT', ids: [s.by('COASTAL')[0]!.id] });
    expect(r.body).toMatchObject({ done: [], skipped: [{ reason: expect.stringMatching(/record it as a payment/) }] });
  });
});

describe('a decision undone in a closed month', () => {
  it('its old entry is never offered back as a match', async () => {
    const s = await setup();
    const fuel = await accountByKey(prisma, 'FUEL');
    const shell = s.by('SHELL')[0]!;
    expect((await s.a.post(`/books/bank/transactions/${shell.id}/categorize`).send({ accountId: fuel.id })).status).toBe(200);
    await prisma.fiscalPeriod.create({ data: { periodKey: '2026-10', status: 'CLOSED', closedAt: new Date() } });
    expect((await s.a.post(`/books/bank/transactions/${shell.id}/undo`).send({})).status).toBe(200);
    // The original still stands (reversed in the next open month) — not a candidate.
    const sug = (await s.a.post('/books/bank/transactions/suggestions').send({ ids: [shell.id] })).body.suggestions[shell.id];
    expect(sug.matches).toEqual([]);
    expect(sug.exactLineId).toBeNull();
    const m = await s.a.post('/books/bank/transactions/bulk').send({ action: 'MATCH', ids: [shell.id] });
    expect(m.body.done).toEqual([]);
    // Categorized again: a new entry, the books net to the one fuel purchase.
    expect((await s.a.post(`/books/bank/transactions/${shell.id}/categorize`).send({ accountId: fuel.id })).status).toBe(200);
    expect(await accountBalance(prisma, fuel.id, '2026-12-31')).toBe(62.1);
  });
});

describe('bills, many at once', () => {
  it('the same id twice is one decision; a books viewer who can’t decide is told so, not refused', async () => {
    const s = await setup();
    const fuel = await accountByKey(prisma, 'FUEL');
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const b = await loginAs(agent(), other.email);
    const vendor = (await s.a.post('/books/vendors').send({ name: 'Shell Fleet', termsDays: 15 })).body.vendor as { id: string };
    const made = await s.a.post('/books/bills').send({ vendorId: vendor.id, billDate: '2026-10-01', billNumber: 'INV-1', lines: [{ accountId: fuel.id, amount: 100 }] });
    await s.a.post(`/books/bills/${made.body.bill.id}/submit`);
    const id = made.body.bill.id as string;

    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    const viewerTry = await e.post('/books/bills/approve').send({ ids: [id] });
    expect(viewerTry.status).toBe(200);
    expect(viewerTry.body.approved).toEqual([]);

    const r = await b.post('/books/bills/approve').send({ ids: [id, id] });
    expect(r.body).toEqual({ approved: [{ id, total: 100, vendorName: 'Shell Fleet' }], skipped: [] });
    expect(await accountBalance(prisma, fuel.id, '2026-12-31')).toBe(100);
  });
});
