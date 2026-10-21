import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountBalance, accountByKey, postEntry } from '../../lib/books/ledger.js';
import { postStatement } from '../../lib/books/posting/statements.js';
import { createFeedAccount, createRule, importFile, listTransactions } from '../../lib/books/bank/service.js';

/**
 * The books' click savers: the review list's suggestions in one call; many
 * bank transactions decided at once (each its own decision and entry, safe
 * to send twice); a deposit recorded as a client's payment and matched in
 * the same step; and several bills approved at once — never the requester's.
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
CHECK,10/07/2026,"CHECK 1043",-1500.00,CHECK_PAID,12627.40,1043
CREDIT,10/08/2026,"HARBOR GRILL LLC DEPOSIT",900.00,ACH_CREDIT,13527.40,
`;

async function setup() {
  const cash = await accountByKey(prisma, 'CASH_OPERATING');
  const feed = await createFeedAccount(prisma, { ledgerAccountId: cash.id }, null);
  await importFile(prisma, feed.id, 'chase.csv', CSV, undefined, null);
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(agent(), fin.email);
  const b = await loginAs(agent(), owner.email);
  const { transactions } = await listTransactions(prisma, feed.id, { status: 'UNMATCHED' });
  const by = (start: string) => transactions.filter((t) => t.description.startsWith(start));
  return { feed, cash, a, b, fin, owner, by, transactions };
}

describe('bank review, many at once', () => {
  it('answers a page of suggestions in one call — exact matches flagged, a deposit’s client guessed', async () => {
    const s = await setup();
    const coastal = await createClient('Coastal Resort, Inc.');
    // The check was entered in the books on the 7th; the coffees match nothing.
    const check = await postEntry(prisma, { date: '2026-10-07', source: 'MANUAL', sourceKey: 'chk:1043', lines: [{ account: 'RENT', debit: 1500 }, { account: 'CASH_OPERATING', credit: 1500 }] });
    const ids = s.transactions.map((t) => t.id);
    const r = await s.a.post('/books/bank/transactions/suggestions').send({ ids });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.suggestions).sort()).toEqual([...ids].sort());
    const chk = s.by('CHECK')[0]!;
    expect(r.body.suggestions[chk.id]).toMatchObject({ exactLineId: check.lines.find((l) => Number(l.credit) === 1500)!.id });
    expect(r.body.suggestions[s.by('COASTAL')[0]!.id].client).toEqual({ id: coastal.id, name: 'Coastal Resort, Inc.' });
    expect(r.body.suggestions[s.by('HARBOR')[0]!.id].client).toBeNull();
    expect(r.body.suggestions[s.by('SHELL')[0]!.id].client).toBeNull();
    // Not ids: refused.
    expect((await s.a.post('/books/bank/transactions/suggestions').send({ ids: ['nope'] })).status).toBe(400);
  });

  it('accepts every suggestion, each its own entry; matches the exact ones; and a second send changes nothing', async () => {
    const s = await setup();
    const office = await accountByKey(prisma, 'OFFICE_SUPPLIES');
    const fuel = await accountByKey(prisma, 'FUEL');
    await createRule(prisma, { name: 'Coffee', contains: 'starbucks', direction: 'OUT', accountId: office.id, priority: 10, autoApply: false, isActive: true }, null);
    await createRule(prisma, { name: 'Fuel', contains: 'shell', direction: 'OUT', accountId: fuel.id, priority: 10, autoApply: false, isActive: true }, null);
    await postEntry(prisma, { date: '2026-10-07', source: 'MANUAL', sourceKey: 'chk:1043', lines: [{ account: 'RENT', debit: 1500 }, { account: 'CASH_OPERATING', credit: 1500 }] });
    const ids = s.transactions.map((t) => t.id);

    const accept = await s.a.post('/books/bank/transactions/bulk').send({ action: 'ACCEPT', ids });
    expect(accept.status).toBe(200);
    // Two coffees and the fuel; the check has a match in the books (match it instead); the deposits have nothing to accept.
    expect(accept.body.done).toHaveLength(3);
    expect(accept.body.skipped).toEqual(
      expect.arrayContaining([
        { id: s.by('CHECK')[0]!.id, reason: expect.stringMatching(/match it instead/) },
        { id: s.by('COASTAL')[0]!.id, reason: 'No suggestion to accept.' },
      ]),
    );
    const bankEntries = await prisma.journalEntry.findMany({ where: { source: 'BANK' }, select: { sourceKey: true } });
    expect(bankEntries.map((e) => e.sourceKey).sort()).toEqual(s.by('STARBUCKS').concat(s.by('SHELL')).map((t) => `bank-txn:${t.id}`).sort());
    expect(await accountBalance(prisma, office.id, '2026-12-31')).toBe(10.5);
    const coffee = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: s.by('STARBUCKS')[0]!.id } });
    expect(coffee).toMatchObject({ status: 'CATEGORIZED' });
    expect(coffee.ruleId).not.toBeNull();

    const matched = await s.b.post('/books/bank/transactions/bulk').send({ action: 'MATCH', ids });
    expect(matched.body.done).toEqual([s.by('CHECK')[0]!.id]);

    // Again: everything already decided is skipped, nothing posts twice.
    const again = await s.a.post('/books/bank/transactions/bulk').send({ action: 'ACCEPT', ids });
    expect(again.body.done).toEqual([]);
    expect(again.body.skipped.filter((x: { reason: string }) => x.reason === 'Already decided.')).toHaveLength(4);
    expect(await prisma.journalEntry.count({ where: { source: 'BANK' } })).toBe(3);

    // Excluding a selection, and undo puts one back.
    const ex = await s.a.post('/books/bank/transactions/bulk').send({ action: 'EXCLUDE', ids: [s.by('HARBOR')[0]!.id] });
    expect(ex.body.done).toEqual([s.by('HARBOR')[0]!.id]);
    expect((await s.a.post(`/books/bank/transactions/${s.by('HARBOR')[0]!.id}/undo`)).body.transaction.status).toBe('UNMATCHED');
  });

  it('leaves an ambiguous match for a person', async () => {
    const s = await setup();
    // Two $1,500 lines on different days around the check, neither on its day.
    await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', sourceKey: 'a', lines: [{ account: 'RENT', debit: 1500 }, { account: 'CASH_OPERATING', credit: 1500 }] });
    await postEntry(prisma, { date: '2026-10-09', source: 'MANUAL', sourceKey: 'b', lines: [{ account: 'RENT', debit: 1500 }, { account: 'CASH_OPERATING', credit: 1500 }] });
    const r = await s.a.post('/books/bank/transactions/bulk').send({ action: 'MATCH', ids: [s.by('CHECK')[0]!.id] });
    expect(r.body).toMatchObject({ done: [], skipped: [{ reason: expect.stringMatching(/More than one entry/) }] });
  });

  it('only people who keep the books decide in bulk', async () => {
    const s = await setup();
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    expect((await e.post('/books/bank/transactions/bulk').send({ action: 'EXCLUDE', ids: [s.transactions[0]!.id] })).status).toBe(403);
    // Reading the suggestions is fine for anyone who can see the books.
    expect((await e.post('/books/bank/transactions/suggestions').send({ ids: [s.transactions[0]!.id] })).status).toBe(200);
  });
});

describe('a deposit recorded as a client payment', () => {
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

  it('lands in that bank account, pays the statement, and matches the deposit — typed once', async () => {
    const s = await setup();
    const client = await createClient('Coastal Resort');
    const st = await statement(client.id, 4200);
    const deposit = s.by('COASTAL')[0]!;
    const r = await s.a.post('/books/receivables/payments').send({ clientId: client.id, receivedOn: '2026-10-03', amount: 4200, method: 'ACH', bankTransactionId: deposit.id, applications: [{ statementId: st.id, amount: 4200 }] });
    expect(r.status).toBe(201);
    expect(r.body.payment).toMatchObject({ amount: 4200, depositAccount: { id: s.cash.id }, unapplied: 0 });
    expect(r.body.bankTransaction).toMatchObject({ id: deposit.id, status: 'MATCHED', matched: { entryId: r.body.payment.journalEntryId } });
    expect((await prisma.clientStatement.findUniqueOrThrow({ where: { id: st.id } })).paidAt).not.toBeNull();
    // Nothing posted from the bank side: the payment's entry is the one.
    expect(await prisma.journalEntry.count({ where: { source: 'BANK' } })).toBe(0);

    // Again from the same deposit: it's decided.
    const twice = await s.a.post('/books/receivables/payments').send({ clientId: client.id, receivedOn: '2026-10-03', amount: 4200, method: 'ACH', bankTransactionId: deposit.id, applications: [] });
    expect(twice.status).toBe(409);
  });

  it('refuses a different amount, money out, or another deposit account', async () => {
    const s = await setup();
    const client = await createClient('Harbor Grill');
    const deposit = s.by('HARBOR')[0]!;
    const base = { clientId: client.id, receivedOn: '2026-10-08', method: 'ACH', applications: [] };
    expect((await s.a.post('/books/receivables/payments').send({ ...base, amount: 899, bankTransactionId: deposit.id })).body.error.code).toBe('amount_mismatch');
    expect((await s.a.post('/books/receivables/payments').send({ ...base, amount: 5.25, bankTransactionId: s.by('STARBUCKS')[0]!.id })).body.error.code).toBe('amount_mismatch');
    const undeposited = await accountByKey(prisma, 'UNDEPOSITED');
    expect((await s.a.post('/books/receivables/payments').send({ ...base, amount: 900, bankTransactionId: deposit.id, depositAccountId: undeposited.id })).body.error.code).toBe('wrong_deposit_account');
    expect(await prisma.clientPayment.count()).toBe(0);
  });
});

describe('approving several bills at once', () => {
  it('approves each as its own decision and skips the approver’s own, saying why', async () => {
    const s = await setup();
    const fuel = await accountByKey(prisma, 'FUEL');
    const vendor = (await s.a.post('/books/vendors').send({ name: 'Shell Fleet', termsDays: 15 })).body.vendor as { id: string };
    const enter = async (who: typeof s.a, amount: number) => {
      const made = await who.post('/books/bills').send({ vendorId: vendor.id, billDate: '2026-10-01', billNumber: `INV-${amount}`, lines: [{ accountId: fuel.id, amount }] });
      await who.post(`/books/bills/${made.body.bill.id}/submit`);
      return made.body.bill.id as string;
    };
    const one = await enter(s.a, 100);
    const two = await enter(s.a, 250);
    const mine = await enter(s.b, 75);
    const draft = (await s.b.post('/books/bills').send({ vendorId: vendor.id, billDate: '2026-10-01', lines: [{ accountId: fuel.id, amount: 10 }] })).body.bill.id as string;

    const r = await s.b.post('/books/bills/approve').send({ ids: [one, two, mine, draft] });
    expect(r.status).toBe(200);
    expect(r.body.approved).toEqual([
      { id: one, total: 100, vendorName: 'Shell Fleet' },
      { id: two, total: 250, vendorName: 'Shell Fleet' },
    ]);
    expect(r.body.skipped).toEqual([
      { id: mine, reason: 'You entered it — a second person approves it.' },
      { id: draft, reason: 'It’s a draft — not sent for approval.' },
    ]);
    expect(await accountBalance(prisma, fuel.id, '2026-12-31')).toBe(350);
    expect(await prisma.approvalRequest.count({ where: { kind: 'BILL_APPROVAL', status: 'APPROVED', decidedById: s.owner.id } })).toBe(2);

    // Sent again: already decided, nothing posts twice.
    const again = await s.b.post('/books/bills/approve').send({ ids: [one] });
    expect(again.body).toEqual({ approved: [], skipped: [{ id: one, reason: 'Already decided.' }] });
    // The other person approves the one they didn't enter.
    expect((await s.a.post('/books/bills/approve').send({ ids: [mine] })).body.approved).toHaveLength(1);
  });
});
