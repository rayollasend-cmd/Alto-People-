import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountByKey, entryForKey, postEntry, voidEntry } from '../../lib/books/ledger.js';
import { emitBooksChange } from '../../lib/books/events.js';
import { FakeQboClient, resetStubCompanies } from '../../lib/books/qbo/fake.js';
import { redirectUri, saveCompanyConnection, setQboClientFactory } from '../../lib/books/qbo/connection.js';
import { env } from '../../config/env.js';
import { linkFor } from '../../lib/books/qbo/links.js';
import { initialLink } from '../../lib/books/qbo/mapping.js';
import { flushOutboxQueue, MAX_ATTEMPTS, processOutbox, registerOutboxListener, shouldQueue } from '../../lib/books/qbo/outbox.js';
import { pushCtx } from '../../lib/books/qbo/push.js';
import { resolveConflict } from '../../lib/books/qbo/resolve.js';
import { runSync } from '../../lib/books/qbo/sync.js';
import { signWebhook } from '../../lib/books/qbo/webhook.js';
import { QboError } from '../../lib/books/qbo/types.js';
import { flushQuickbooksWebhookWork } from '../../routes/books/quickbooksWebhook.js';

/**
 * The company QuickBooks, kept in step both ways, against an in-memory
 * QuickBooks: what the site makes goes over (and comes off when voided);
 * what the accountant makes there comes into the ledger (edited and voided
 * with it); a record changed on both sides, or in a closed month on either
 * side, waits for a person; nothing echoes; a failing push backs off and
 * finally says why.
 */

let qbo: FakeQboClient;

beforeEach(async () => {
  await truncateAll();
  resetStubCompanies();
  qbo = new FakeQboClient('R1');
  setQboClientFactory(() => qbo);
  registerOutboxListener();
});
afterEach(() => {
  setQboClientFactory(null);
  delete process.env.INTUIT_WEBHOOK_VERIFIER;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const TOKENS = { access_token: 'a', refresh_token: 'r', expires_in: 3600 };

/** Connected, charts linked — what the connect flow leaves behind. */
async function connect() {
  await saveCompanyConnection(prisma, { realmId: 'R1', tokens: TOKENS, userId: null });
  return initialLink(await pushCtx(prisma, qbo, null));
}

const qboIdOf = async (localType: string, localId: string) => (await linkFor(prisma, localType, localId))!.qboId;
const outboxRows = async () => {
  await flushOutboxQueue();
  return prisma.qboOutbox.findMany({ orderBy: { createdAt: 'asc' } });
};

describe('connecting', () => {
  it('asks Intuit to return to the address the app already registered, and that callback hands company connections on to the books', async () => {
    // Intuit refuses any redirect_uri not on the app's keys tab — the per-client one is.
    expect(redirectUri()).toBe(`${env.APP_BASE_URL}/api/quickbooks/connect/callback`);
    const company = await agent().get('/quickbooks/connect/callback').query({ code: 'C', state: 'company.t.u.n.sig', realmId: 'R1' });
    expect(company.status).toBe(302);
    expect(company.headers.location).toBe(`${env.APP_BASE_URL}/api/books/quickbooks/callback?code=C&state=company.t.u.n.sig&realmId=R1`);
    // The per-client payroll connection is retired: every return goes on to the books, which verify the state.
    const other = await agent().get('/quickbooks/connect/callback').query({ code: 'C', state: 'not-a-company-state', realmId: 'R1' });
    expect(other.status).toBe(302);
    expect(other.headers.location).toBe(`${env.APP_BASE_URL}/api/books/quickbooks/callback?code=C&state=not-a-company-state&realmId=R1`);
  });

  it('connects in stub mode through the callback, matches the charts by number and by name, creates the rest there, and brings QuickBooks’ own accounts and vendors over', async () => {
    qbo.seed('Account', { Name: 'Checking', AcctNum: '1000', AccountType: 'Bank', Classification: 'Asset' });
    qbo.seed('Account', { Name: 'Accounts receivable', AccountType: 'Accounts Receivable', Classification: 'Asset' });
    qbo.seed('Account', { Name: 'Meals', AcctNum: '6420', AccountType: 'Expense', Classification: 'Expense' });
    qbo.seed('Vendor', { DisplayName: 'Shell Fleet', Vendor1099: false });
    await prisma.vendor.create({ data: { name: 'Enterprise Fleet' } });
    await createClient('Coastal Resort');
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);

    const start = await a.get('/books/quickbooks/connect');
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizeUrl);
    expect(url.pathname).toBe('/api/books/quickbooks/callback');
    const back = await a.get(`/books/quickbooks/callback${url.search}`);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe('/books/quickbooks?connected=1');

    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const ar = await accountByKey(prisma, 'AR');
    const checking = qbo.all('Account').find((e) => e.Name === 'Checking')!;
    expect(await qboIdOf('LedgerAccount', cash.id)).toBe(checking.Id);
    expect(await qboIdOf('LedgerAccount', ar.id)).toBe(qbo.all('Account').find((e) => e.Name === 'Accounts receivable')!.Id);
    // QuickBooks' own account came over, numbered as it is there.
    const meals = await prisma.ledgerAccount.findFirstOrThrow({ where: { code: '6420' } });
    expect(meals).toMatchObject({ name: 'Meals', type: 'EXPENSE' });
    expect((await linkFor(prisma, 'LedgerAccount', meals.id))!.owner).toBe('QUICKBOOKS');
    // Every other site account was created there, numbered like the site.
    expect(qbo.all('Account').find((e) => e.AcctNum === '5000')).toMatchObject({ Name: 'Direct labor wages', AccountType: 'Cost of Goods Sold' });
    expect(qbo.all('Account').find((e) => e.AcctNum === '1590')).toMatchObject({ AccountType: 'Fixed Asset', AccountSubType: 'AccumulatedDepreciation' });
    // Vendors both ways, every client a customer.
    expect(qbo.all('Vendor').map((v) => v.DisplayName).sort()).toEqual(['Enterprise Fleet', 'Shell Fleet']);
    expect(await prisma.vendor.findFirst({ where: { name: 'Shell Fleet' } })).not.toBeNull();
    expect(qbo.all('Customer').map((c) => c.DisplayName)).toEqual(['Coastal Resort']);

    const status = await a.get('/books/quickbooks/status');
    expect(status.body.connection).toMatchObject({ realmId: expect.stringMatching(/^STUB-COMPANY-/), status: 'CONNECTED', companyName: 'Alto Sandbox Company' });
    expect(status.body.sandboxOnly).toBe(true);
    expect(status.body.counts.linked).toBeGreaterThan(60);

    // A tampered state is refused.
    const bad = await a.get(`/books/quickbooks/callback?code=x&realmId=R9&state=company.${'0'.repeat(36)}.x.y.z`);
    expect(bad.headers.location).toBe('/books/quickbooks?error=state');
  });
});

describe('site → QuickBooks', () => {
  it('a manual entry goes over once, with its customer and class; a void deletes it there', async () => {
    const client = await createClient('Coastal Resort');
    await connect();
    const e = await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', memo: 'October rent', lines: [{ account: 'RENT', debit: 2400, clientId: client.id }, { account: 'CASH_OPERATING', credit: 2400 }] });
    expect((await outboxRows()).map((r) => [r.localType, r.status])).toEqual([['JournalEntry', 'PENDING']]);

    const r = await runSync(prisma);
    expect(r.pushed.sent).toBe(1);
    const je = qbo.all('JournalEntry')[0]!;
    expect(je).toMatchObject({ TxnDate: '2026-10-05', DocNumber: `AH-${e.number}`, PrivateNote: 'October rent' });
    const lines = je.Line as Array<{ Amount: number; JournalEntryLineDetail: { PostingType: string; Entity?: { Type: string }; ClassRef?: { value: string } } }>;
    expect(lines.map((l) => [l.Amount, l.JournalEntryLineDetail.PostingType])).toEqual([[2400, 'Debit'], [2400, 'Credit']]);
    expect(lines[0]!.JournalEntryLineDetail.Entity?.Type).toBe('Customer');
    expect(qbo.all('Class').map((c) => c.Name)).toEqual(['Coastal Resort']);
    // Nothing more to send; its own change coming back is ignored.
    const again = await runSync(prisma);
    expect(again.pushed.sent).toBe(0);
    expect(again.pulled.conflicts).toBe(0);
    expect(qbo.all('JournalEntry')).toHaveLength(1);

    await voidEntry(prisma, e.id, { reason: 'Wrong month' });
    await runSync(prisma);
    expect(qbo.all('JournalEntry')).toHaveLength(0);
    expect(qbo.calls).toContain('delete:JournalEntry');
  });

  it('vendors, approved bills, bill payments, final statements and client payments go over as themselves — drafts and their own ledger entries don’t', async () => {
    const client = await createClient('Coastal Resort');
    await connect();
    const fuel = await accountByKey(prisma, 'FUEL');
    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const vendor = await prisma.vendor.create({ data: { name: 'Shell Fleet', is1099: false, email: 'ap@shell.example' } });
    const bill = await prisma.bill.create({
      data: { vendorId: vendor.id, billNumber: 'INV-77', billDate: new Date('2026-10-02'), dueDate: new Date('2026-11-01'), status: 'APPROVED', total: 300, balance: 300, lines: { create: [{ lineNo: 1, accountId: fuel.id, amount: 300, description: 'Van fuel' }] } },
    });
    const draft = await prisma.bill.create({ data: { vendorId: vendor.id, billDate: new Date('2026-10-03'), dueDate: new Date('2026-11-02'), status: 'DRAFT', total: 50, balance: 50, lines: { create: [{ lineNo: 1, accountId: fuel.id, amount: 50 }] } } });
    const pay = await prisma.billPayment.create({ data: { vendorId: vendor.id, paidOn: new Date('2026-10-10'), method: 'CHECK', amount: 300, bankAccountId: cash.id, checkNumber: 1001, status: 'SENT', applications: { create: [{ billId: bill.id, amount: 300 }] } } });
    const stmt = await prisma.clientStatement.create({
      data: { clientId: client.id, periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-02'), status: 'FINAL', number: 12, finalizedAt: new Date('2026-10-03T12:00:00Z'), dueAt: new Date('2026-11-02'), snapshot: { totals: { amount: 1200, adjustmentsAmount: -100 } } },
    });
    const cp = await prisma.clientPayment.create({ data: { clientId: client.id, receivedOn: new Date('2026-10-12'), amount: 1100, method: 'ACH', reference: 'ACH-9', depositAccountId: cash.id, applications: { create: [{ statementId: stmt.id, amount: 1100 }] } } });
    for (const [localType, localId] of [['Vendor', vendor.id], ['Bill', bill.id], ['Bill', draft.id], ['BillPayment', pay.id], ['ClientStatement', stmt.id], ['ClientPayment', cp.id]] as const) emitBooksChange({ localType, localId, op: 'UPSERT' });
    // The bill's own ledger entry isn't sent as a journal entry.
    const billEntry = await postEntry(prisma, { date: '2026-10-02', source: 'BILL', sourceType: 'Bill', sourceId: bill.id, sourceKey: `bill:${bill.id}`, lines: [{ account: 'FUEL', debit: 300 }, { account: 'AP', credit: 300, vendorId: vendor.id }] });
    await flushOutboxQueue();
    expect(await prisma.qboOutbox.count({ where: { localId: billEntry.id } })).toBe(0);

    await runSync(prisma);
    const v = qbo.all('Vendor').find((x) => x.DisplayName === 'Shell Fleet')!;
    const qb = qbo.all('Bill');
    expect(qb).toHaveLength(1);
    expect(qb[0]).toMatchObject({ VendorRef: { value: v.Id }, DocNumber: 'INV-77', TxnDate: '2026-10-02', DueDate: '2026-11-01' });
    expect((qb[0]!.Line as Array<{ Amount: number }>)[0]!.Amount).toBe(300);
    expect(qbo.all('BillPayment')[0]).toMatchObject({ PayType: 'Check', TotalAmt: 300, DocNumber: '1001', Line: [{ Amount: 300, LinkedTxn: [{ TxnId: qb[0]!.Id, TxnType: 'Bill' }] }] });
    const inv = qbo.all('Invoice')[0]!;
    expect(inv).toMatchObject({ DocNumber: '0012', CustomerRef: { value: qbo.all('Customer')[0]!.Id } });
    expect((inv.Line as Array<{ Amount: number; Description: string }>).map((l) => [l.Description, l.Amount])).toEqual([['Staffing services 2026-09-26 – 2026-10-02', 1300], ['Billing adjustments', -100]]);
    expect(qbo.all('Item').map((i) => i.Name).sort()).toEqual(['Billing adjustments', 'Staffing services']);
    expect(qbo.all('Payment')[0]).toMatchObject({ TotalAmt: 1100, PaymentRefNum: 'ACH-9', Line: [{ Amount: 1100, LinkedTxn: [{ TxnId: inv.Id, TxnType: 'Invoice' }] }] });
    // The draft bill waited.
    expect((await prisma.qboOutbox.findFirstOrThrow({ where: { localId: draft.id } })).status).toBe('SKIPPED');

    // A voided client payment is voided there.
    await prisma.clientPayment.update({ where: { id: cp.id }, data: { voidedAt: new Date() } });
    emitBooksChange({ localType: 'ClientPayment', localId: cp.id, op: 'DELETE' });
    await runSync(prisma);
    expect(qbo.calls).toContain('void:Payment');
    expect(qbo.all('Payment')[0]!.TotalAmt).toBe(0);
  });

  it('a transaction dated inside QuickBooks’ closed books isn’t sent — it waits with a conflict saying why', async () => {
    await connect();
    qbo.bookCloseDate = '2026-10-31';
    const e = await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', lines: [{ account: 'RENT', debit: 10 }, { account: 'CASH_OPERATING', credit: 10 }] });
    const r = await runSync(prisma);
    expect(r.pushed.skipped).toBe(1);
    expect(qbo.all('JournalEntry')).toHaveLength(0);
    const c = await prisma.qboSyncConflict.findFirstOrThrow({ where: { localId: e.id } });
    expect(c.summary).toMatch(/closed through Oct 31, 2026/);
    expect((c.qboVersion as { reason: string }).reason).toBe('BOOKS_CLOSED');
    // Keeping the site sends it anyway.
    await resolveConflict(prisma, c.id, 'SITE', null);
    expect(qbo.all('JournalEntry')).toHaveLength(1);
  });

  it('a failing push backs off, then gives up with QuickBooks’ own words; a refused connection stops the run', async () => {
    await connect();
    await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', lines: [{ account: 'RENT', debit: 10 }, { account: 'CASH_OPERATING', credit: 10 }] });
    qbo.failNext('create:JournalEntry', new QboError('Service unavailable', 503, null, 'Try later'), MAX_ATTEMPTS);
    const conn = (await prisma.qboCompanyConnection.findFirst())!;
    const ctx = await pushCtx(prisma, qbo, null);
    await flushOutboxQueue();
    let now = new Date(Date.now() + 1000);
    await processOutbox(ctx, conn, { now });
    let row = (await outboxRows())[0]!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'Service unavailable — Try later' });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    // Not due yet: nothing happens.
    await processOutbox(ctx, conn, { now });
    expect((await outboxRows())[0]!.attempts).toBe(1);
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      now = new Date(now.getTime() + 7 * 60 * 60_000);
      await processOutbox(ctx, conn, { now });
    }
    row = (await outboxRows())[0]!;
    expect(row).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
    expect((await prisma.qboSyncEvent.findFirstOrThrow({ where: { result: 'ERROR' }, orderBy: { createdAt: 'desc' } })).message).toMatch(/^Gave up after 6 tries/);

    // Retry, and QuickBooks says the connection is gone.
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    expect((await a.post('/books/quickbooks/outbox/retry-failed')).body).toEqual({ retried: 1 });
    qbo.failNext('create:JournalEntry', new QboError('Unauthorized', 401), 1);
    await runSync(prisma);
    expect((await prisma.qboCompanyConnection.findFirstOrThrow()).status).toBe('NEEDS_RECONNECT');
    expect((await outboxRows())[0]!.status).toBe('PENDING');
  });
});

describe('QuickBooks → site', () => {
  it('an expense the accountant enters there lands in the ledger, follows its edits, and is voided when deleted — never sent back', async () => {
    await connect();
    const fuel = await accountByKey(prisma, 'FUEL');
    const card = await accountByKey(prisma, 'CREDIT_CARD');
    const purchase = qbo.seed('Purchase', {
      TxnDate: '2026-10-08',
      PaymentType: 'CreditCard',
      AccountRef: { value: await qboIdOf('LedgerAccount', card.id) },
      TotalAmt: 42.5,
      PrivateNote: 'Fuel at Shell',
      Line: [{ Amount: 42.5, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: await qboIdOf('LedgerAccount', fuel.id) } } }],
    });
    const r = await runSync(prisma);
    expect(r.pulled.ok).toBeGreaterThanOrEqual(1);
    const entry = (await entryForKey(prisma, `qbo:Purchase:${purchase.Id}`))!;
    expect(entry).toMatchObject({ origin: 'QUICKBOOKS', source: 'QUICKBOOKS', status: 'POSTED' });
    expect(entry.lines.map((l) => [l.accountId, Number(l.debit), Number(l.credit)])).toEqual([[fuel.id, 42.5, 0], [card.id, 0, 42.5]]);
    // No echo: nothing queued to go back.
    await flushOutboxQueue();
    expect(await prisma.qboOutbox.count()).toBe(0);
    expect(shouldQueue({ localType: 'JournalEntry', localId: entry.id, op: 'UPSERT', source: 'QUICKBOOKS', origin: 'QUICKBOOKS' })).toBe(false);

    qbo.edit('Purchase', purchase.Id, { TotalAmt: 50, Line: [{ Amount: 50, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: await qboIdOf('LedgerAccount', fuel.id) } } }] });
    await runSync(prisma);
    const edited = (await entryForKey(prisma, `qbo:Purchase:${purchase.Id}`))!;
    expect(edited.id).toBe(entry.id);
    expect(Number(edited.totalDebit)).toBe(50);

    qbo.drop('Purchase', purchase.Id);
    await runSync(prisma);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('VOID');
    await flushOutboxQueue();
    expect(await prisma.qboOutbox.count()).toBe(0);
  });

  it('a change in a month the site has closed waits for a person; keeping QuickBooks posts it in the first open month', async () => {
    await connect();
    await prisma.fiscalPeriod.create({ data: { periodKey: '2026-08', status: 'CLOSED', closedAt: new Date() } });
    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const fees = await accountByKey(prisma, 'BANK_FEES');
    const p = qbo.seed('Purchase', {
      TxnDate: '2026-08-20',
      PaymentType: 'Cash',
      AccountRef: { value: await qboIdOf('LedgerAccount', cash.id) },
      TotalAmt: 15,
      Line: [{ Amount: 15, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: await qboIdOf('LedgerAccount', fees.id) } } }],
    });
    const r = await runSync(prisma);
    expect(r.pulled.conflicts).toBe(1);
    expect(await entryForKey(prisma, `qbo:Purchase:${p.Id}`)).toBeNull();
    const c = await prisma.qboSyncConflict.findFirstOrThrow();
    expect(c.summary).toMatch(/August 2026, which is closed in the books here/);

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    const list = await a.get('/books/quickbooks/conflicts');
    expect(list.body.conflicts[0]).toMatchObject({ reason: 'SITE_PERIOD_CLOSED', status: 'OPEN' });
    const done = await a.post(`/books/quickbooks/conflicts/${c.id}/resolve`).send({ keep: 'QUICKBOOKS' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('KEPT_QUICKBOOKS');
    const posted = (await entryForKey(prisma, `qbo:Purchase:${p.Id}`))!;
    expect(posted.periodKey > '2026-08').toBe(true);
  });

  it('a site-owned record changed on both sides is a conflict; either side can win', async () => {
    await connect();
    const vendor = await prisma.vendor.create({ data: { name: 'Enterprise Fleet' } });
    emitBooksChange({ localType: 'Vendor', localId: vendor.id, op: 'UPSERT' });
    await runSync(prisma);
    const qv = qbo.all('Vendor').find((v) => v.DisplayName === 'Enterprise Fleet')!;
    // Renamed here (not yet sent) and there.
    await prisma.vendor.update({ where: { id: vendor.id }, data: { name: 'Enterprise Fleet Leasing' } });
    qbo.edit('Vendor', qv.Id, { DisplayName: 'Enterprise Holdings' });
    await runSync(prisma, { push: false });
    const c = await prisma.qboSyncConflict.findFirstOrThrow({ where: { localId: vendor.id } });
    expect(c.summary).toMatch(/changed here and in QuickBooks/);
    await resolveConflict(prisma, c.id, 'QUICKBOOKS', null);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).name).toBe('Enterprise Holdings');

    // A bill (its truth is the site's payables): an edit there is never applied silently.
    const fuel = await accountByKey(prisma, 'FUEL');
    const bill = await prisma.bill.create({ data: { vendorId: vendor.id, billDate: new Date('2026-10-02'), dueDate: new Date('2026-11-01'), status: 'APPROVED', total: 300, balance: 300, lines: { create: [{ lineNo: 1, accountId: fuel.id, amount: 300 }] } } });
    emitBooksChange({ localType: 'Bill', localId: bill.id, op: 'UPSERT' });
    await runSync(prisma);
    const qb = qbo.all('Bill')[0]!;
    qbo.edit('Bill', qb.Id, { TotalAmt: 350, Line: [{ ...(qb.Line as object[])[0], Amount: 350 }] });
    await runSync(prisma);
    const billConflict = await prisma.qboSyncConflict.findFirstOrThrow({ where: { localId: bill.id, status: 'OPEN' } });
    expect(billConflict.summary).toMatch(/its record lives here/);
    await resolveConflict(prisma, billConflict.id, 'SITE', null);
    expect((qbo.all('Bill')[0]!.Line as Array<{ Amount: number }>)[0]!.Amount).toBe(300);
  });

  it('a manual entry edited only in QuickBooks is replaced by QuickBooks’ version', async () => {
    await connect();
    const e = await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', memo: 'Supplies', lines: [{ account: 'OFFICE_SUPPLIES', debit: 80 }, { account: 'CASH_OPERATING', credit: 80 }] });
    await runSync(prisma);
    const je = qbo.all('JournalEntry')[0]!;
    const lines = (je.Line as Array<{ Amount: number }>).map((l) => ({ ...l, Amount: 95 }));
    qbo.edit('JournalEntry', je.Id, { Line: lines });
    await runSync(prisma);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('VOID');
    const link = await prisma.qboSyncLink.findFirstOrThrow({ where: { qboType: 'JournalEntry', qboId: je.Id } });
    const replacement = await prisma.journalEntry.findUniqueOrThrow({ where: { id: link.localId } });
    expect(Number(replacement.totalDebit)).toBe(95);
    expect(replacement.origin).toBe('QUICKBOOKS');
    expect(await prisma.qboSyncConflict.count()).toBe(0);
  });

  it('Intuit’s webhook is verified over the raw body and starts a pull', async () => {
    await connect();
    process.env.INTUIT_WEBHOOK_VERIFIER = 'verifier-token';
    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const dep = qbo.seed('Transfer', { TxnDate: '2026-10-09', Amount: 500, FromAccountRef: { value: await qboIdOf('LedgerAccount', cash.id) }, ToAccountRef: { value: await qboIdOf('LedgerAccount', (await accountByKey(prisma, 'CASH_PAYROLL')).id) } });
    const body = JSON.stringify({ eventNotifications: [{ realmId: 'R1', dataChangeEvent: { entities: [{ name: 'Transfer', id: dep.Id, operation: 'Create' }] } }] });
    const bad = await agent().post('/books/quickbooks/webhook').set('content-type', 'application/json').set('intuit-signature', 'nope').send(body);
    expect(bad.status).toBe(401);
    const good = await agent().post('/books/quickbooks/webhook').set('content-type', 'application/json').set('intuit-signature', signWebhook(body, 'verifier-token')).send(body);
    expect(good.status).toBe(200);
    await flushQuickbooksWebhookWork();
    expect((await entryForKey(prisma, `qbo:Transfer:${dep.Id}`))?.origin).toBe('QUICKBOOKS');
  });
});

describe('the page’s endpoints', () => {
  it('status, outbox, history, mapping and relink, settings, pause and resume, and who may do what', async () => {
    await createClient('Coastal Resort');
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/books/quickbooks/status')).body.connection).toBeNull();
    await connect();
    const extra = qbo.seed('Account', { Name: 'Petty cash', AcctNum: '1099', AccountType: 'Bank', Classification: 'Asset' });

    const map = await a.get('/books/quickbooks/mappings?kind=accounts');
    expect(map.status).toBe(200);
    const rent = await accountByKey(prisma, 'RENT');
    expect(map.body.rows.find((r: { localId: string }) => r.localId === rent.id)).toMatchObject({ siteName: `${rent.code} ${rent.name}`, qboName: `${rent.code} ${rent.name}`, owner: 'SITE' });
    expect((await a.get('/books/quickbooks/qbo-accounts')).body.accounts.some((x: { id: string }) => x.id === extra.Id)).toBe(true);
    expect((await a.put(`/books/quickbooks/mappings/accounts/${rent.id}`).send({ qboId: extra.Id })).status).toBe(200);
    expect(await qboIdOf('LedgerAccount', rent.id)).toBe(extra.Id);
    expect((await a.get('/books/quickbooks/mappings?kind=customers')).body.rows[0]).toMatchObject({ siteName: 'Coastal Resort', qboName: 'Coastal Resort' });

    expect((await a.put('/books/quickbooks/settings').send({ classMode: 'DEPARTMENT' })).body).toEqual({ classMode: 'DEPARTMENT', locationMode: 'SITE' });
    expect((await a.get('/books/quickbooks/settings')).body.classMode).toBe('DEPARTMENT');

    await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', lines: [{ account: 'RENT', debit: 5 }, { account: 'CASH_OPERATING', credit: 5 }] });
    await flushOutboxQueue();
    expect((await a.get('/books/quickbooks/outbox')).body.rows[0]).toMatchObject({ localType: 'JournalEntry', status: 'PENDING', label: expect.stringMatching(/^Journal entry #/) });
    expect((await a.post('/books/quickbooks/pause')).status).toBe(200);
    expect((await a.post('/books/quickbooks/sync-now')).body.error.code).toBe('quickbooks_not_connected');
    expect((await a.post('/books/quickbooks/resume')).status).toBe(200);
    const run = await a.post('/books/quickbooks/sync-now');
    expect(run.body.pushed.sent).toBe(1);
    // The rent now posts to QuickBooks' Petty cash account, as relinked.
    expect((qbo.all('JournalEntry')[0]!.Line as Array<{ JournalEntryLineDetail: { AccountRef: { value: string } } }>)[0]!.JournalEntryLineDetail.AccountRef.value).toBe(extra.Id);
    const hist = await a.get('/books/quickbooks/events?limit=2');
    expect(hist.body.events).toHaveLength(2);
    expect(hist.body.nextCursor).not.toBeNull();
    expect((await a.get(`/books/quickbooks/events?limit=2&cursor=${hist.body.nextCursor}`)).body.events[0].id).not.toBe(hist.body.events[0].id);
    expect((await a.get('/books/quickbooks/status')).body.counts).toMatchObject({ pending: 0, failed: 0, conflicts: 0 });

    // The owner reads but doesn't run the sync; marketing doesn't see the books at all.
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    expect((await e.get('/books/quickbooks/status')).status).toBe(200);
    expect((await e.post('/books/quickbooks/sync-now')).status).toBe(403);
    const { user: mkt } = await createUser({ role: 'MARKETING_MANAGER' });
    expect((await (await loginAs(agent(), mkt.email)).get('/books/quickbooks/status')).status).toBe(403);

    expect((await a.post('/books/quickbooks/disconnect')).status).toBe(200);
    expect((await a.get('/books/quickbooks/status')).body.connection).toBeNull();
    // Disconnected: site changes no longer queue.
    await postEntry(prisma, { date: '2026-10-06', source: 'MANUAL', lines: [{ account: 'RENT', debit: 5 }, { account: 'CASH_OPERATING', credit: 5 }] });
    await flushOutboxQueue();
    expect(await prisma.qboOutbox.count({ where: { status: 'PENDING' } })).toBe(0);
  });
});

describe('the HTTP client’s reading of QuickBooks’ errors', () => {
  it('turns Intuit’s Fault envelope into a QboError with its code and detail', async () => {
    const { parseFault } = await import('../../lib/books/qbo/http.js');
    const e = parseFault(400, JSON.stringify({ Fault: { Error: [{ Message: 'Stale Object Error', Detail: 'You and Bob edited the same thing', code: '5010' }], type: 'ValidationFault' } }));
    expect(e).toMatchObject({ message: 'Stale Object Error', status: 400, code: '5010', detail: 'You and Bob edited the same thing' });
    expect(e.retryable).toBe(true);
    expect(parseFault(401, '{"fault":{"error":[{"message":"AuthenticationFailed","code":"3200"}]}}').needsReconnect).toBe(true);
    expect(parseFault(503, 'upstream down').message).toBe('QuickBooks answered 503: upstream down');
  });

  it('webhooks are refused while no verifier is set', async () => {
    const res = await agent().post('/books/quickbooks/webhook').set('content-type', 'application/json').send('{}');
    expect(res.status).toBe(503);
  });
});
