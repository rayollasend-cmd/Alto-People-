import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountByKey, postEntry } from '../../lib/books/ledger.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';

/**
 * The ledger's screens over HTTP: who may read and write the books, the
 * chart of accounts' rules, manual and opening entries, voids, the journal,
 * the statements and their PDF / Excel, and the overview.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function people() {
  const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
  const { user: marketing } = await createUser({ role: 'MARKETING_MANAGER' });
  return {
    finance: await loginAs(agent(), finance.email),
    exec: await loginAs(agent(), exec.email),
    marketing: await loginAs(agent(), marketing.email),
  };
}

const binary = (res: import('superagent').Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('who reads and keeps the books', () => {
  it('finance reads and writes, the executive only reads, marketing sees nothing', async () => {
    const p = await people();
    expect((await p.finance.get('/books/accounts')).status).toBe(200);
    expect((await p.exec.get('/books/accounts')).status).toBe(200);
    expect((await p.marketing.get('/books/accounts')).status).toBe(403);
    expect((await p.exec.post('/books/accounts').send({ code: '6990', name: 'Meals', type: 'EXPENSE', subtype: 'EXPENSE' })).status).toBe(403);
    expect((await p.finance.post('/books/accounts').send({ code: '6990', name: 'Meals', type: 'EXPENSE', subtype: 'EXPENSE' })).status).toBe(201);
  });
});

describe('the chart of accounts', () => {
  it('lists the seeded chart with balances; codes are unique; subtypes fit their type', async () => {
    const p = await people();
    const list = await p.finance.get('/books/accounts');
    expect(list.body.accounts.find((a: { systemKey: string }) => a.systemKey === 'AR')).toMatchObject({ code: '1100', type: 'ASSET', balance: 0, hasEntries: false });
    expect((await p.finance.post('/books/accounts').send({ code: '1100', name: 'Dup', type: 'ASSET', subtype: 'AR' })).body.error.code).toBe('code_taken');
    expect((await p.finance.post('/books/accounts').send({ code: '1999', name: 'Odd', type: 'ASSET', subtype: 'EXPENSE' })).body.error.code).toBe('bad_subtype');
  });

  it('a used account keeps its type, can’t be deleted, and can’t be turned off while it holds money', async () => {
    const p = await people();
    const made = await p.finance.post('/books/accounts').send({ code: '6990', name: 'Meals', type: 'EXPENSE', subtype: 'EXPENSE' });
    const id = made.body.account.id as string;
    await postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', lines: [{ account: id, debit: 50 }, { account: 'CASH_OPERATING', credit: 50 }] });
    expect((await p.finance.patch(`/books/accounts/${id}`).send({ type: 'ASSET', subtype: 'CURRENT_ASSET' })).body.error.code).toBe('account_in_use');
    expect((await p.finance.delete(`/books/accounts/${id}`)).body.error.code).toBe('account_in_use');
    expect((await p.finance.patch(`/books/accounts/${id}`).send({ isActive: false })).body.error.code).toBe('account_has_balance');
    const renamed = await p.finance.patch(`/books/accounts/${id}`).send({ name: 'Meals and entertainment' });
    expect(renamed.body.account).toMatchObject({ name: 'Meals and entertainment', balance: 50, hasEntries: true });

    const ar = await accountByKey(prisma, 'AR');
    expect((await p.finance.patch(`/books/accounts/${ar.id}`).send({ type: 'EXPENSE', subtype: 'EXPENSE' })).body.error.code).toBe('system_account');
    expect((await p.finance.delete(`/books/accounts/${ar.id}`)).body.error.code).toBe('system_account');

    const spare = await p.finance.post('/books/accounts').send({ code: '6991', name: 'Spare', type: 'EXPENSE', subtype: 'EXPENSE' });
    expect((await p.finance.delete(`/books/accounts/${spare.body.account.id}`)).status).toBe(204);
  });
});

describe('the journal', () => {
  it('posts a balanced manual entry, refuses one that isn’t, lists and shows it, and voids it', async () => {
    const p = await people();
    const accounts = (await p.finance.get('/books/accounts')).body.accounts as Array<{ id: string; systemKey: string | null }>;
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const client = await createClient('Coastal Resort');

    const bad = await p.finance.post('/books/journal').send({ date: '2026-10-05', lines: [{ accountId: id('RENT'), debit: 100 }, { accountId: id('CASH_OPERATING'), credit: 90 }] });
    expect(bad.body.error.code).toBe('entry_unbalanced');
    const both = await p.finance.post('/books/journal').send({ date: '2026-10-05', lines: [{ accountId: id('RENT'), debit: 100, credit: 100 }, { accountId: id('CASH_OPERATING'), credit: 0 }] });
    expect(both.body.error.code).toBe('bad_line');

    const ok = await p.finance.post('/books/journal').send({
      date: '2026-10-05',
      memo: 'October rent',
      lines: [
        { accountId: id('RENT'), debit: 2500, clientId: client.id },
        { accountId: id('CASH_OPERATING'), credit: 2500 },
      ],
    });
    expect(ok.status).toBe(201);
    const list = await p.finance.get('/books/journal?q=rent');
    expect(list.body).toMatchObject({ total: 1, entries: [{ number: 1, memo: 'October rent', amount: 2500, source: 'MANUAL', status: 'POSTED', accounts: 'Rent / Operating checking' }] });
    const detail = await p.finance.get(`/books/journal/${ok.body.entry.id}`);
    expect(detail.body.entry).toMatchObject({ number: 1, total: 2500, periodClosed: false, sourceLink: null });
    expect(detail.body.entry.lines[0]).toMatchObject({ debit: 2500, account: { code: '6100' }, client: { name: 'Coastal Resort' } });

    const voided = await p.finance.post(`/books/journal/${ok.body.entry.id}/void`).send({ reason: 'Entered twice' });
    expect(voided.body).toEqual({ voided: true, reversalId: null });
    expect((await p.finance.get('/books/journal?status=VOID')).body.total).toBe(1);
  });

  it('an entry a record posted can’t be voided from the journal; an accrual names its reversal date', async () => {
    const p = await people();
    const e = await postEntry(prisma, { date: '2026-10-05', source: 'PAYROLL', sourceType: 'PayrollRun', sourceId: '11111111-1111-4111-8111-111111111111', sourceKey: 'payroll-run:x', lines: [{ account: 'WAGES_DIRECT', debit: 10 }, { account: 'NET_PAY_PAYABLE', credit: 10 }] });
    expect((await p.finance.post(`/books/journal/${e.id}/void`).send({ reason: 'Not mine' })).body.error.code).toBe('entry_owned');
    expect((await p.finance.get(`/books/journal/${e.id}`)).body.entry.sourceLink).toEqual({ label: 'Open the payroll run', to: '/payroll/runs/11111111-1111-4111-8111-111111111111' });

    const accounts = (await p.finance.get('/books/accounts')).body.accounts as Array<{ id: string; systemKey: string | null }>;
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const early = await p.finance.post('/books/journal').send({ date: '2026-10-31', reverseOn: '2026-10-30', lines: [{ accountId: id('UTILITIES'), debit: 400 }, { accountId: id('ACCRUED_EXPENSES'), credit: 400 }] });
    expect(early.body.error.code).toBe('bad_reverse_on');
    const accrual = await p.finance.post('/books/journal').send({ date: '2026-10-31', reverseOn: '2026-11-01', memo: 'October power, billed in November', lines: [{ accountId: id('UTILITIES'), debit: 400 }, { accountId: id('ACCRUED_EXPENSES'), credit: 400 }] });
    expect((await p.finance.get(`/books/journal/${accrual.body.entry.id}`)).body.entry).toMatchObject({ source: 'ACCRUAL', reverseOn: '2026-11-01' });
  });

  it('opening balances post once, balance against opening equity, and can be corrected', async () => {
    const p = await people();
    const accounts = (await p.finance.get('/books/accounts')).body.accounts as Array<{ id: string; systemKey: string | null }>;
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const first = await p.finance.post('/books/opening-balances').send({ date: '2025-12-31', lines: [{ accountId: id('CASH_OPERATING'), amount: 80000 }, { accountId: id('AP'), amount: 5000 }] });
    expect(first.status).toBe(200);
    const again = await p.finance.post('/books/opening-balances').send({ date: '2025-12-31', lines: [{ accountId: id('CASH_OPERATING'), amount: 82000 }, { accountId: id('AP'), amount: 5000 }] });
    expect(again.body.entry.id).toBe(first.body.entry.id);
    const read = await p.finance.get('/books/opening-balances');
    expect(read.body.date).toBe('2025-12-31');
    expect(read.body.lines).toEqual(expect.arrayContaining([{ accountId: id('CASH_OPERATING'), amount: 82000 }, { accountId: id('AP'), amount: 5000 }]));
    const bs = await p.finance.get('/books/reports/balance-sheet?asOf=2026-01-01');
    expect(bs.body.totals).toMatchObject({ assets: 82000, liabilities: 5000, balanced: true });
    expect(bs.body.equity.find((r: { name: string }) => r.name === 'Opening balance equity').amount).toBe(77000);
  });
});

describe('the statements', () => {
  it('serve as JSON, PDF and Excel, filtered by client, and the account detail runs a balance', async () => {
    const p = await people();
    const client = await createClient('Seaside Inn');
    await postEntry(prisma, { date: '2026-03-31', source: 'STATEMENT', sourceKey: 's1', lines: [{ account: 'AR', debit: 1000, clientId: client.id }, { account: 'REVENUE_STAFFING', credit: 1000, clientId: client.id }] });
    await postEntry(prisma, { date: '2026-03-31', source: 'MANUAL', lines: [{ account: 'RENT', debit: 300 }, { account: 'CASH_OPERATING', credit: 300 }] });

    const pl = await p.exec.get('/books/reports/profit-and-loss?from=2026-01-01&to=2026-03-31&columns=month');
    expect(pl.body.totals).toMatchObject({ income: 1000, expenses: 300, netIncome: 700 });
    expect(pl.body.columns.map((c: { key: string }) => c.key)).toEqual(['2026-01', '2026-02', '2026-03']);
    const forClient = await p.exec.get(`/books/reports/profit-and-loss?from=2026-01-01&to=2026-03-31&clientId=${client.id}`);
    expect(forClient.body.totals.netIncome).toBe(1000);
    expect((await p.exec.get('/books/reports/trial-balance?asOf=2026-03-31')).body.totals.balanced).toBe(true);
    expect((await p.exec.get('/books/reports/cash-flow?from=2026-01-01&to=2026-03-31')).body.totals.reconciles).toBe(true);
    expect((await p.exec.get('/books/reports/profit-and-loss?from=2026-04-01&to=2026-03-01')).body.error.code).toBe('bad_range');

    for (const r of ['profit-and-loss', 'balance-sheet', 'cash-flow', 'trial-balance']) {
      const pdf = await p.exec.get(`/books/reports/${r}.pdf?from=2026-01-01&to=2026-03-31&asOf=2026-03-31`).buffer(true).parse(binary);
      expect(pdf.status, r).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      const xlsx = await p.exec.get(`/books/reports/${r}.xlsx?from=2026-01-01&to=2026-03-31&asOf=2026-03-31&columns=client`).buffer(true).parse(binary);
      expect(xlsx.status, r).toBe(200);
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    }

    const ar = await accountByKey(prisma, 'AR');
    const detail = await p.exec.get(`/books/accounts/${ar.id}/detail?from=2026-01-01&to=2026-12-31`);
    expect(detail.body).toMatchObject({ opening: 0, closing: 1000, rows: [{ debit: 1000, balance: 1000 }] });
  });
});

describe('the overview', () => {
  it('cash, receivables aged from open statements, payables, profit, the close and what needs you', async () => {
    const p = await people();
    const client = await createClient('Harbor Grill');
    // The company's calendar day: the overview counts cash and the close on it, not UTC's.
    const today = orgDateKey(new Date());
    const longAgo = new Date(Date.now() - 100 * 86_400_000);
    await prisma.clientStatement.create({
      data: { clientId: client.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-01-07'), status: 'FINAL', finalizedAt: longAgo, dueAt: longAgo, snapshot: { totals: { amount: 1200 } } },
    });
    await postEntry(prisma, { date: today, source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 5000 }, { account: 'OWNER_EQUITY', credit: 5000 }] });
    await postEntry(prisma, { date: today, source: 'STATEMENT', sourceKey: 'st', lines: [{ account: 'AR', debit: 1200, clientId: client.id }, { account: 'REVENUE_STAFFING', credit: 1200, clientId: client.id }] });
    const vendor = await prisma.vendor.create({ data: { name: 'Shell Fleet' } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billDate: new Date(today), dueDate: new Date(today), status: 'PENDING_APPROVAL', total: 90, balance: 90 } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billDate: new Date(today), dueDate: new Date(Date.now() + 3 * 86_400_000), status: 'APPROVED', total: 250, balance: 250 } });

    const o = await p.exec.get('/books/overview');
    expect(o.status).toBe(200);
    expect(o.body.cash.total).toBe(5000);
    expect(o.body.cash.accounts.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(['Operating checking', 'Payroll checking']));
    expect(o.body.receivables).toMatchObject({ total: 1200, aging: { over90: 1200 }, topClients: [{ name: 'Harbor Grill', open: 1200 }] });
    expect(o.body.payables).toMatchObject({ total: 250, dueIn7Days: 250, awaitingApproval: 1 });
    expect(o.body.profit.month).toMatchObject({ income: 1200, netIncome: 1200 });
    expect(o.body.profit.trend).toHaveLength(6);
    expect(o.body.quickbooks).toMatchObject({ connected: false, openConflicts: 0 });
    expect(o.body.needsYou.map((n: { key: string }) => n.key)).toEqual(expect.arrayContaining(['bills', 'ar-90']));

    const d = await p.exec.get('/books/dimensions');
    expect(d.body.clients.map((c: { name: string }) => c.name)).toContain('Harbor Grill');
  });
});
