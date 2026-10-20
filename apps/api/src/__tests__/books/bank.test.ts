import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountBalance, accountByKey, postEntry } from '../../lib/books/ledger.js';
import { csvToTransactions, detectCsvMapping, parseCsv, parseOfx } from '../../lib/books/bank/parse.js';
import { setPlaidClientFactory, type PlaidClient, type PlaidSyncPage } from '../../lib/books/bank/plaid.js';
import { encryptCredentials } from '../../lib/providers/connections.js';
import {
  applyRules,
  categorize,
  completeReconciliation,
  createFeedAccount,
  createRule,
  exclude,
  importFile,
  listTransactions,
  match,
  plaidExchange,
  previewImport,
  reconciliationDetail,
  startReconciliation,
  suggestionsFor,
  syncPlaidItem,
  tick,
  undo,
  undoReconciliation,
} from '../../lib/books/bank/service.js';

/**
 * The books' bank and card accounts: files read right, re-imports change
 * nothing, rules categorize, a decision posts (and undo voids) a balanced
 * entry, matching finds the line already in the books, and a
 * reconciliation completes only at a zero difference.
 */

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  setPlaidClientFactory(null);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const CHASE = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,10/02/2026,"SHELL OIL 57444",-62.10,DEBIT_CARD,9937.90,
CREDIT,10/03/2026,"COASTAL RESORT HOLDINGS ACH",4200.00,ACH_CREDIT,14137.90,
DEBIT,10/05/2026,"STARBUCKS #1234",-5.25,DEBIT_CARD,14132.65,
DEBIT,10/05/2026,"STARBUCKS #1234",-5.25,DEBIT_CARD,14127.40,
CHECK,10/07/2026,"CHECK 1043",-1500.00,CHECK_PAID,12627.40,1043
`;

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002120000<TRNAMT>-62.10<FITID>A1<NAME>SHELL OIL 57444
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261003<TRNAMT>4200.00<FITID>A2<NAME>COASTAL RESORT &amp; SPA<MEMO>ACH
</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>14137.90<DTASOF>20261003</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

async function operating() {
  const cash = await accountByKey(prisma, 'CASH_OPERATING');
  return createFeedAccount(prisma, { ledgerAccountId: cash.id }, null);
}

describe('reading statement files', () => {
  it('detects a bank’s CSV columns and keeps two identical coffees as two', () => {
    const rows = parseCsv(CHASE);
    const m = detectCsvMapping(rows)!;
    expect(m).toMatchObject({ dateColumn: 1, descriptionColumn: 2, amountColumn: 3, referenceColumn: 6, flipSign: false, dateOrder: 'MDY', hasHeader: true });
    const { transactions, errors } = csvToTransactions(rows, m);
    expect(errors).toEqual([]);
    expect(transactions.map((t) => [t.postedOn, t.amount])).toEqual([
      ['2026-10-02', -62.1],
      ['2026-10-03', 4200],
      ['2026-10-05', -5.25],
      ['2026-10-05', -5.25],
      ['2026-10-07', -1500],
    ]);
    expect(transactions[2]!.externalId).not.toBe(transactions[3]!.externalId);
    expect(transactions[4]!.reference).toBe('1043');
  });

  it('reads separate debit and credit columns, and a card export’s positive charges', () => {
    const split = parseCsv('Date,Description,Debit,Credit\n2026-10-01,Rent,"2,000.00",\n2026-10-02,Refund,,(15.00)\n');
    const m = detectCsvMapping(split)!;
    expect(m).toMatchObject({ amountColumn: null, debitColumn: 2, creditColumn: 3, dateOrder: 'YMD' });
    expect(csvToTransactions(split, m).transactions.map((t) => t.amount)).toEqual([-2000, 15]);

    const amex = parseCsv('Date,Description,Amount,Category\n10/01/2026,DELTA AIR,412.20,Travel\n10/02/2026,UBER,23.10,Travel\n');
    const am = detectCsvMapping(amex)!;
    expect(am.flipSign).toBe(true);
    expect(csvToTransactions(amex, am).transactions.map((t) => t.amount)).toEqual([-412.2, -23.1]);
  });

  it('reads OFX: FITID, entities, and the ledger balance', () => {
    const r = parseOfx(OFX);
    expect(r.transactions).toMatchObject([
      { postedOn: '2026-10-02', amount: -62.1, externalId: 'ofx:A1', payee: 'SHELL OIL 57444' },
      { postedOn: '2026-10-03', amount: 4200, externalId: 'ofx:A2', description: 'COASTAL RESORT & SPA — ACH' },
    ]);
    expect(r.ledgerBalance).toEqual({ amount: 14137.9, asOf: '2026-10-03' });
  });
});

describe('importing and deciding', () => {
  it('imports, ignores a re-import, and auto-applies a rule', async () => {
    const feed = await operating();
    const fuel = await accountByKey(prisma, 'FUEL');
    await createRule(prisma, { name: 'Fuel', contains: 'shell', direction: 'OUT', accountId: fuel.id, priority: 10, autoApply: true, isActive: true }, null);

    const preview = await previewImport(prisma, feed.id, 'chase.csv', CHASE);
    expect(preview).toMatchObject({ format: 'CSV', total: 5, duplicates: 0 });
    expect(preview.columns[2]).toBe('Description');

    const first = await importFile(prisma, feed.id, 'chase.csv', CHASE, undefined, null);
    expect(first).toMatchObject({ added: 5, duplicates: 0, autoCategorized: 1 });
    const again = await importFile(prisma, feed.id, 'chase.csv', CHASE, undefined, null);
    expect(again).toMatchObject({ added: 0, duplicates: 5, autoCategorized: 0 });

    const { counts, transactions } = await listTransactions(prisma, feed.id, {});
    expect(counts).toEqual({ UNMATCHED: 4, MATCHED: 0, CATEGORIZED: 1, EXCLUDED: 0 });
    const shell = transactions.find((t) => t.description.startsWith('SHELL'))!;
    expect(shell).toMatchObject({ status: 'CATEGORIZED', ruleName: 'Fuel', category: { code: fuel.code, transfer: false } });
    expect(await accountBalance(prisma, fuel.id, '2026-12-31')).toBe(62.1);

    // OFX with the same bank transactions under FITIDs: they're new rows (different source), and the balance is read.
    const ofx = await importFile(prisma, feed.id, 'stmt.ofx', OFX, undefined, null);
    expect(ofx.added).toBe(2);
    const acct = (await prisma.bankFeedAccount.findUniqueOrThrow({ where: { id: feed.id } }));
    expect(Number(acct.currentBalance)).toBe(14137.9);
  });

  it('categorizes into a balanced entry, undo voids it, and a transfer is flagged', async () => {
    const feed = await operating();
    await importFile(prisma, feed.id, 'chase.csv', CHASE, undefined, null);
    const { transactions } = await listTransactions(prisma, feed.id, {});
    const coffee = transactions.find((t) => t.description.startsWith('STARBUCKS'))!;
    const office = await accountByKey(prisma, 'OFFICE_SUPPLIES');
    const done = await categorize(prisma, coffee.id, { accountId: office.id, memo: 'Team coffee' }, null);
    expect(done).toMatchObject({ status: 'CATEGORIZED', category: { accountId: office.id } });
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: done.journalEntryId! }, include: { lines: true } });
    expect(entry).toMatchObject({ source: 'BANK', sourceKey: `bank-txn:${coffee.id}`, entryDate: new Date('2026-10-05T00:00:00.000Z') });
    expect(entry.lines.map((l) => [l.accountId, Number(l.debit), Number(l.credit)])).toEqual(
      expect.arrayContaining([
        [office.id, 5.25, 0],
        [feed.ledgerAccountId, 0, 5.25],
      ]),
    );
    await expect(categorize(prisma, coffee.id, { accountId: office.id }, null)).rejects.toMatchObject({ code: 'already_decided' });
    await expect(categorize(prisma, transactions.find((t) => t.amount === -1500)!.id, { accountId: feed.ledgerAccountId }, null)).rejects.toMatchObject({ code: 'same_account' });

    const back = await undo(prisma, coffee.id, null);
    expect(back).toMatchObject({ status: 'UNMATCHED', journalEntryId: null });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('VOID');
    expect(await accountBalance(prisma, office.id, '2026-12-31')).toBe(0);
    // Categorized again: a fresh entry, a fresh key.
    const again = await categorize(prisma, coffee.id, { accountId: office.id }, null);
    expect(again.journalEntryId).not.toBe(entry.id);

    const payroll = await accountByKey(prisma, 'CASH_PAYROLL');
    const transfer = await categorize(prisma, transactions.find((t) => t.amount === -1500)!.id, { accountId: payroll.id }, null);
    expect(transfer.category).toMatchObject({ transfer: true });

    const ex = await exclude(prisma, transactions.find((t) => t.amount === 4200)!.id, null);
    expect(ex.status).toBe('EXCLUDED');
    expect((await undo(prisma, ex.id, null)).status).toBe('UNMATCHED');
  });

  it('suggests the ledger line already in the books and matches it', async () => {
    const feed = await operating();
    // Payroll posted a client payment on the 2nd; the bank shows it on the 3rd.
    const entry = await postEntry(prisma, { date: '2026-10-02', source: 'CLIENT_PAYMENT', sourceKey: 'cp:1', lines: [{ account: 'CASH_OPERATING', debit: 4200 }, { account: 'AR', credit: 4200 }] });
    await importFile(prisma, feed.id, 'chase.csv', CHASE, undefined, null);
    const { transactions } = await listTransactions(prisma, feed.id, { status: 'UNMATCHED' });
    const deposit = transactions.find((t) => t.amount === 4200)!;
    const s = await suggestionsFor(prisma, deposit.id);
    const line = entry.lines.find((l) => Number(l.debit) === 4200)!;
    expect(s.matches).toEqual([expect.objectContaining({ lineId: line.id, entryNumber: entry.number, daysApart: 1, source: 'CLIENT_PAYMENT' })]);
    const m = await match(prisma, deposit.id, line.id, null);
    expect(m).toMatchObject({ status: 'MATCHED', matched: { lineId: line.id } });
    // Nothing new posted, and the line can't be matched twice.
    expect(await prisma.journalEntry.count({ where: { source: 'BANK' } })).toBe(0);
    const coffee = transactions.find((t) => t.description.startsWith('STARBUCKS'))!;
    await expect(match(prisma, coffee.id, line.id, null)).rejects.toMatchObject({ code: 'amount_mismatch' });
    expect((await suggestionsFor(prisma, deposit.id)).matches).toEqual([]);
  });

  it('“apply rules now” uses every rule; a rule’s category comes up as a suggestion', async () => {
    const feed = await operating();
    await importFile(prisma, feed.id, 'chase.csv', CHASE, undefined, null);
    const office = await accountByKey(prisma, 'OFFICE_SUPPLIES');
    await createRule(prisma, { name: 'Coffee', contains: 'starbucks', direction: 'ANY', minAmount: 1, maxAmount: 20, accountId: office.id, priority: 100, autoApply: false, isActive: true }, null);
    const { transactions } = await listTransactions(prisma, feed.id, {});
    expect((await suggestionsFor(prisma, transactions.find((t) => t.description.startsWith('STARBUCKS'))!.id)).rule).toMatchObject({ name: 'Coffee', accountId: office.id });
    expect(await applyRules(prisma, { autoOnly: true, userId: null })).toBe(0);
    expect(await applyRules(prisma, { autoOnly: false, userId: null })).toBe(2);
  });
});

describe('reconciling', () => {
  it('ticks lines to a zero difference, completes, refuses a difference, and undoes the latest', async () => {
    const feed = await operating();
    await postEntry(prisma, { date: '2026-09-30', source: 'OPENING', lines: [{ account: 'CASH_OPERATING', debit: 10000 }, { account: 'OPENING_BALANCE', credit: 10000 }] });
    await postEntry(prisma, { date: '2026-10-03', source: 'CLIENT_PAYMENT', lines: [{ account: 'CASH_OPERATING', debit: 4200 }, { account: 'AR', credit: 4200 }] });
    const rentEntry = await postEntry(prisma, { date: '2026-10-28', source: 'MANUAL', lines: [{ account: 'RENT', debit: 2000 }, { account: 'CASH_OPERATING', credit: 2000 }] });
    // The rent check hasn't cleared the bank by the statement date.
    const rec = await startReconciliation(prisma, feed.id, { statementEndDate: '2026-10-31', statementBalance: 14200 }, null);
    expect(rec).toMatchObject({ status: 'IN_PROGRESS', beginningBalance: 0, clearedBalance: 0, difference: 14200 });
    expect(rec.lines).toHaveLength(3);
    const ids = (pred: (a: number) => boolean) => rec.lines.filter((l) => pred(l.amount)).map((l) => l.lineId);
    let d = await tick(prisma, rec.id, ids((a) => a > 0), true);
    expect(d.difference).toBe(0);
    d = await tick(prisma, rec.id, rec.lines.filter((l) => l.amount === -2000).map((l) => l.lineId), true);
    expect(d.difference).toBe(2000);
    await expect(completeReconciliation(prisma, rec.id, null)).rejects.toMatchObject({ code: 'reconciliation_difference' });
    await tick(prisma, rec.id, rec.lines.filter((l) => l.amount === -2000).map((l) => l.lineId), false);
    const done = await completeReconciliation(prisma, rec.id, null);
    expect(done).toMatchObject({ status: 'COMPLETED', clearedCount: 2, canUndo: true });
    expect(await prisma.journalLine.count({ where: { clearedAt: { not: null } } })).toBe(2);

    // Next month starts from 14,200; the rent check clears now.
    const nov = await startReconciliation(prisma, feed.id, { statementEndDate: '2026-11-30', statementBalance: 12200 }, null);
    expect(nov).toMatchObject({ beginningBalance: 14200, difference: -2000 });
    expect(nov.lines.map((l) => l.entryId)).toEqual([rentEntry.id]);
    await expect(startReconciliation(prisma, feed.id, { statementEndDate: '2026-12-31', statementBalance: 1 }, null)).rejects.toMatchObject({ code: 'reconciliation_in_progress' });
    // October can't be undone while November is open.
    expect((await reconciliationDetail(prisma, rec.id)).canUndo).toBe(false);
    await tick(prisma, nov.id, nov.lines.map((l) => l.lineId), true);
    await completeReconciliation(prisma, nov.id, null);
    await expect(undoReconciliation(prisma, rec.id)).rejects.toMatchObject({ code: 'not_latest' });
    const reopened = await undoReconciliation(prisma, nov.id);
    expect(reopened).toMatchObject({ status: 'IN_PROGRESS', difference: 0 });
    expect(await prisma.journalLine.count({ where: { clearedAt: { not: null } } })).toBe(2);
  });

  it('pre-ticks what the bank already showed, and a cleared line can’t be undone from review', async () => {
    const feed = await operating();
    const entry = await postEntry(prisma, { date: '2026-10-02', source: 'CLIENT_PAYMENT', lines: [{ account: 'CASH_OPERATING', debit: 4200 }, { account: 'AR', credit: 4200 }] });
    await importFile(prisma, feed.id, 'chase.csv', CHASE, undefined, null);
    const { transactions } = await listTransactions(prisma, feed.id, {});
    const deposit = transactions.find((t) => t.amount === 4200)!;
    await match(prisma, deposit.id, entry.lines.find((l) => Number(l.debit) === 4200)!.id, null);
    const fuel = await accountByKey(prisma, 'FUEL');
    await categorize(prisma, transactions.find((t) => t.description.startsWith('SHELL'))!.id, { accountId: fuel.id }, null);
    const rec = await startReconciliation(prisma, feed.id, { statementEndDate: '2026-10-31', statementBalance: 4137.9 }, null);
    expect(rec.lines.filter((l) => l.cleared).map((l) => l.amount).sort()).toEqual([-62.1, 4200]);
    expect(rec.difference).toBe(0);
    await completeReconciliation(prisma, rec.id, null);
    await expect(undo(prisma, deposit.id, null)).rejects.toMatchObject({ code: 'reconciled' });
  });
});

describe('Plaid', () => {
  function fakePlaid(pages: PlaidSyncPage[]) {
    const calls: Array<{ cursor: string | null }> = [];
    let i = 0;
    const client: PlaidClient = {
      linkTokenCreate: async () => ({ link_token: 'link-sandbox-1' }),
      publicTokenExchange: async () => ({ access_token: 'access-sandbox-1', item_id: 'item-1' }),
      accountsGet: async () => ({
        item: { institution_id: 'ins_1' },
        institutionName: 'First Coast Bank',
        accounts: [
          { account_id: 'acc-chk', name: 'Business Checking', mask: '0042', type: 'depository', subtype: 'checking', balances: { current: 9800, available: 9700 } },
          { account_id: 'acc-card', name: 'Business Card', mask: '9911', type: 'credit', subtype: 'credit card', balances: { current: 320.5, available: null } },
        ],
      }),
      transactionsSync: async (_token, cursor) => {
        calls.push({ cursor });
        return pages[Math.min(i++, pages.length - 1)]!;
      },
    };
    setPlaidClientFactory(() => client);
    return calls;
  }

  it('links accounts, syncs with the cursor, and applies added / modified / removed', async () => {
    await prisma.providerConnection.create({ data: { kind: 'BANK_FEED', provider: 'PLAID', name: 'Plaid', environment: 'SANDBOX', credentialsEnc: encryptCredentials({ clientId: 'cid', secret: 'sec' }) } });
    const calls = fakePlaid([
      {
        added: [
          { transaction_id: 't1', account_id: 'acc-chk', amount: 62.1, date: '2026-10-02', name: 'SHELL OIL', merchant_name: 'Shell', pending: false },
          { transaction_id: 't2', account_id: 'acc-chk', amount: -4200, date: '2026-10-03', name: 'COASTAL RESORT ACH', pending: false },
          { transaction_id: 't3', account_id: 'acc-chk', amount: 9.99, date: '2026-10-04', name: 'PENDING THING', pending: true },
        ],
        modified: [],
        removed: [],
        next_cursor: 'c1',
        has_more: true,
      },
      { added: [{ transaction_id: 't4', account_id: 'acc-card', amount: 23.1, date: '2026-10-04', name: 'UBER', pending: false }], modified: [], removed: [], next_cursor: 'c2', has_more: false },
    ]);
    const ex = await plaidExchange(prisma, 'public-sandbox-1');
    expect(ex).toMatchObject({ itemId: 'item-1', accounts: [{ accountId: 'acc-chk', name: 'Business Checking', mask: '0042', institution: 'First Coast Bank', linkedFeedId: null }, { accountId: 'acc-card' }] });
    // The access token is kept encrypted with the connection, never in a column.
    const conn = await prisma.providerConnection.findFirstOrThrow({ where: { kind: 'BANK_FEED' } });
    expect(conn.credentialsEnc!.toString('utf8')).not.toContain('access-sandbox-1');

    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const card = await accountByKey(prisma, 'CREDIT_CARD');
    const chk = await createFeedAccount(prisma, { ledgerAccountId: cash.id, plaid: { itemId: 'item-1', accountId: 'acc-chk' } }, null);
    const cc = await createFeedAccount(prisma, { ledgerAccountId: card.id, plaid: { itemId: 'item-1', accountId: 'acc-card' } }, null);
    expect(chk).toMatchObject({ feed: 'PLAID', name: 'Business Checking', mask: '0042', institution: 'First Coast Bank' });

    const r1 = await syncPlaidItem(prisma, 'item-1');
    expect(r1).toMatchObject({ added: 3, removed: 0 });
    expect(calls.map((c) => c.cursor)).toEqual([null, 'c1']);
    const chkTx = (await listTransactions(prisma, chk.id, {})).transactions;
    expect(chkTx.map((t) => [t.description, t.amount]).sort()).toEqual([
      ['COASTAL RESORT ACH', 4200],
      ['SHELL OIL', -62.1],
    ]);
    expect((await listTransactions(prisma, cc.id, {})).transactions[0]).toMatchObject({ amount: -23.1, importedFrom: 'FEED' });
    const feeds = await prisma.bankFeedAccount.findMany({ orderBy: { name: 'asc' } });
    expect(feeds.map((f) => [f.cursor, Number(f.currentBalance)])).toEqual([
      ['c2', 320.5],
      ['c2', 9800],
    ]);

    // Next sync: from c2; a change, and a removal of something undecided.
    const calls2 = fakePlaid([
      {
        added: [],
        modified: [{ transaction_id: 't1', account_id: 'acc-chk', amount: 63.0, date: '2026-10-02', name: 'SHELL OIL 57444', pending: false }],
        removed: [{ transaction_id: 't2' }],
        next_cursor: 'c3',
        has_more: false,
      },
    ]);
    const r2 = await syncPlaidItem(prisma, 'item-1');
    expect(r2).toMatchObject({ added: 0, updated: 1, removed: 1 });
    expect(calls2[0]!.cursor).toBe('c2');
    const after = (await listTransactions(prisma, chk.id, {})).transactions;
    expect(after.map((t) => [t.description, t.amount])).toEqual([['SHELL OIL 57444', -63]]);
  });

  it('the routes: view:books reads, manage:books changes, the link token comes from Plaid', async () => {
    await prisma.providerConnection.create({ data: { kind: 'BANK_FEED', provider: 'PLAID', name: 'Plaid', environment: 'SANDBOX', credentialsEnc: encryptCredentials({ clientId: 'cid', secret: 'sec' }) } });
    fakePlaid([{ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false }]);
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const f = await loginAs(agent(), finance.email);
    const e = await loginAs(agent(), exec.email);
    const r = await loginAs(agent(), recruiter.email);
    expect((await r.get('/books/bank/accounts')).status).toBe(403);
    expect((await e.get('/books/bank/accounts')).status).toBe(200);
    expect((await f.post('/books/bank/plaid/link-token')).body).toEqual({ linkToken: 'link-sandbox-1' });
    expect((await f.get('/books/bank/plaid/status')).body).toEqual({ configured: true, environment: 'SANDBOX' });
    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const created = await f.post('/books/bank/accounts').send({ ledgerAccountId: cash.id });
    expect(created.status).toBe(201);
    expect((await e.post('/books/bank/accounts').send({ ledgerAccountId: cash.id })).status).toBe(403);
    expect((await f.post('/books/bank/accounts').send({ ledgerAccountId: cash.id })).body.error.code).toBe('already_a_feed');
    const imp = await f.post(`/books/bank/accounts/${created.body.account.id}/import`).send({ filename: 'chase.csv', content: CHASE });
    expect(imp.body).toMatchObject({ added: 5 });
    const list = await f.get(`/books/bank/accounts/${created.body.account.id}/transactions?status=UNMATCHED`);
    expect(list.body.counts.UNMATCHED).toBe(5);
    const rec = await f.post(`/books/bank/accounts/${created.body.account.id}/reconciliations`).send({ statementEndDate: '2026-10-31', statementBalance: 0 });
    expect(rec.status).toBe(201);
    const xlsx = await f.get(`/books/bank/reconciliations/${rec.body.id}/report.xlsx`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    const newCard = await f.post('/books/bank/accounts').send({ newAccount: { code: '2060', name: 'Fuel card', subtype: 'CREDIT_CARD' } });
    expect(newCard.body.account).toMatchObject({ subtype: 'CREDIT_CARD', ledgerCode: '2060', booksBalance: 0 });
  });
});
