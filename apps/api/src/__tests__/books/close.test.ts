import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountByKey, postEntry } from '../../lib/books/ledger.js';
import { runCloseJobs } from '../../lib/books/jobs/close.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * The month-end close: a checklist made per month whose automatic steps
 * read the books live, hand-ticked steps with notes, "ready" by one person
 * and the sign-off by a SECOND, a closed month that takes no posting, and
 * reopening through an approval someone else decides. Accruals reverse
 * themselves, once.
 *
 *   Today is Monday Oct 19, 2026: September has ended, October hasn't.
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
  const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
  return {
    fin,
    owner,
    a: await loginAs(agent(), fin.email),
    b: await loginAs(agent(), owner.email),
    e: await loginAs(agent(), exec.email),
  };
}

const task = (body: { tasks: Array<{ key: string }> }, key: string) => body.tasks.find((t) => t.key === key) as { key: string; status: string; passing: boolean | null; summary: string; items: Array<{ label: string; link: string }> };

async function tickManual(a: Agent, periodKey: string) {
  for (const key of ['accruals_reviewed', 'payroll_liabilities', 'budget_review']) {
    const r = await a.post(`/books/close/${periodKey}/tasks/${key}`).send({ status: 'DONE', note: 'Reviewed' });
    expect(r.status, key).toBe(200);
  }
}

describe('the checklist', () => {
  it('is made per month, checks the books itself, and lists what to fix and where', async () => {
    const s = await seed();
    const client = await createClient('Coastal Resort');
    const ledgerCash = await accountByKey(prisma, 'CASH_OPERATING');
    const feed = await prisma.bankFeedAccount.create({ data: { ledgerAccountId: ledgerCash.id, name: 'Operating ••4410' } });
    await prisma.bankTransaction.create({ data: { feedAccountId: feed.id, postedOn: new Date('2026-09-12T00:00:00Z'), amount: -42.5, description: 'SHELL OIL', externalId: 'x1', importedFrom: 'CSV' } });
    await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date('2026-09-07T00:00:00Z'), status: 'DRAFT', snapshot: {} } });
    const vendor = await prisma.vendor.create({ data: { name: 'Gulf Coast Fuel' } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billNumber: 'F-88', billDate: new Date('2026-09-20T00:00:00Z'), dueDate: new Date('2026-10-20T00:00:00Z'), status: 'PENDING_APPROVAL', total: 310, balance: 310 } });

    const r = await s.a.get('/books/close/2026-09');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ periodKey: '2026-09', label: 'September 2026', status: 'OPEN', ended: true, tasksTotal: 10 });
    expect(await prisma.closeTask.count()).toBe(10);
    expect(task(r.body, 'bank_reconciled')).toMatchObject({ status: 'OPEN', passing: false, items: [{ label: 'Reconcile Operating ••4410', link: `/books/bank/${feed.id}/reconcile` }] });
    expect(task(r.body, 'bank_reviewed').summary).toBe('1 line from the month to review.');
    expect(task(r.body, 'statements_final')).toMatchObject({ passing: false, items: [{ label: 'Coastal Resort — draft statement' }] });
    expect(task(r.body, 'bills_approved').items[0]!.label).toBe('Gulf Coast Fuel #F-88 — $310.00');
    expect(task(r.body, 'depreciation_posted')).toMatchObject({ passing: true, summary: 'No fixed assets on the register.' });
    expect(task(r.body, 'quickbooks_in_sync')).toMatchObject({ passing: true });
    expect(task(r.body, 'accruals_reviewed')).toMatchObject({ status: 'OPEN', passing: null });
    expect(r.body.can).toMatchObject({ edit: true, ready: false });
    expect(r.body.can.why).toMatch(/steps are still open/);

    // An automatic step can't be ticked by hand — only skipped, with a reason.
    expect((await s.a.post('/books/close/2026-09/tasks/bank_reconciled').send({ status: 'DONE' })).body.error.code).toBe('auto_task');
    expect((await s.a.post('/books/close/2026-09/tasks/bank_reconciled').send({ status: 'SKIPPED' })).body.error.code).toBe('note_required');
    const skipped = await s.a.post('/books/close/2026-09/tasks/bank_reconciled').send({ status: 'SKIPPED', note: 'The bank closed this account Sep 30; final statement not issued.' });
    expect(task(skipped.body, 'bank_reconciled').status).toBe('SKIPPED');

    // Read-only: the executive sees it, can't work it.
    const ex = await s.e.get('/books/close/2026-09');
    expect(ex.body.can).toMatchObject({ edit: false, ready: false });
    expect((await s.e.post('/books/close/2026-09/tasks/budget_review').send({ status: 'DONE' })).status).toBe(403);

    const list = await s.a.get('/books/close');
    expect(list.body.months).toHaveLength(13);
    expect(list.body.months[0]).toMatchObject({ periodKey: '2026-10', ended: false });
    expect(list.body.nextToClose).toBe('2026-09');
  });
});

describe('closing a month', () => {
  it('one person marks it ready, a second signs it off; then nothing posts to it until a reopen is approved', async () => {
    const s = await seed();
    // October hasn't ended.
    await tickManual(s.a, '2026-10');
    expect((await s.a.post('/books/close/2026-10/ready')).body.error.code).toBe('not_ready');

    await tickManual(s.a, '2026-09');
    const ready = await s.a.post('/books/close/2026-09/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'READY', preparedByName: expect.any(String) });
    expect(ready.body.can).toMatchObject({ signOff: false, unready: true });
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: s.owner.id, linkUrl: '/books/close/2026-09' } })).toBe(1);

    // Ticks are frozen while it waits; the preparer can't sign their own close.
    expect((await s.a.post('/books/close/2026-09/tasks/budget_review').send({ status: 'OPEN' })).body.error.code).toBe('period_not_open');
    expect((await s.a.post('/books/close/2026-09/sign-off')).body.error.code).toBe('same_person');

    const signed = await s.b.post('/books/close/2026-09/sign-off');
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ status: 'CLOSED', signedOffByName: expect.any(String) });
    expect(signed.body.can.reopen).toBe(true);
    const period = await prisma.fiscalPeriod.findFirstOrThrow({ where: { periodKey: '2026-09' } });
    expect(period).toMatchObject({ status: 'CLOSED', closedById: s.fin.id, signedOffById: s.owner.id });

    // The ledger refuses September now.
    await expect(postEntry(prisma, { date: '2026-09-15', source: 'MANUAL', lines: [{ account: 'RENT', debit: 100 }, { account: 'CASH_OPERATING', credit: 100 }] })).rejects.toMatchObject({ code: 'period_closed' });

    // Reopen: asked with a reason, decided by someone else.
    const asked = await s.a.post('/books/close/2026-09/reopen').send({ reason: 'A September vendor bill arrived late.' });
    expect(asked.status).toBe(202);
    expect((await s.a.post('/books/close/2026-09/reopen').send({ reason: 'Again, please.' })).body.error.code).toBe('reopen_pending');
    expect((await s.a.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    const decided = await s.b.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(decided.status).toBe(200);
    const reopened = await s.a.get('/books/close/2026-09');
    expect(reopened.body).toMatchObject({ status: 'OPEN', reopenReason: 'A September vendor bill arrived late.' });
    await postEntry(prisma, { date: '2026-09-15', source: 'MANUAL', lines: [{ account: 'RENT', debit: 100 }, { account: 'CASH_OPERATING', credit: 100 }] });

    await flushPendingAudits();
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'FiscalPeriod' } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['books.close.ready', 'books.close.signed_off', 'books.close.reopen_requested', 'books.close.reopened']));
  });

  it('a step that comes undone after "ready" stops the sign-off', async () => {
    const s = await seed();
    await tickManual(s.a, '2026-09');
    await s.a.post('/books/close/2026-09/ready').expect(200);
    const client = await createClient('Harbor Grill');
    await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-09-20T00:00:00Z'), periodEnd: new Date('2026-09-26T00:00:00Z'), status: 'DRAFT', snapshot: {} } });
    const r = await s.b.post('/books/close/2026-09/sign-off');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('steps_open');
    // The preparer takes it back.
    expect((await s.a.post('/books/close/2026-09/unready')).body.status).toBe('OPEN');
  });
});

describe('accruals', () => {
  it('are recorded with a reversal date and reverse themselves once', async () => {
    const s = await seed();
    const made = await s.a.post('/books/close/accruals').send({
      date: '2026-09-30',
      memo: 'September utilities, billed in October',
      lines: [
        { account: 'UTILITIES', debit: 840 },
        { account: 'ACCRUED_EXPENSES', credit: 840 },
      ],
    });
    expect(made.status).toBe(201);
    const listed = await s.a.get('/books/close/2026-09/accruals');
    expect(listed.body.accruals).toEqual([expect.objectContaining({ amount: 840, reverseOn: '2026-10-01', reversedEntryId: null })]);

    await runCloseJobs(prisma, NOW);
    await runCloseJobs(prisma, NOW);
    const after = await s.a.get('/books/close/2026-09/accruals');
    expect(after.body.accruals[0]).toMatchObject({ reversedOn: '2026-10-01', reversedEntryId: expect.any(String) });
    expect(await prisma.journalEntry.count({ where: { source: 'REVERSAL' } })).toBe(1);
    const accrued = await accountByKey(prisma, 'ACCRUED_EXPENSES');
    const bal = await prisma.journalLine.aggregate({ where: { accountId: accrued.id, entry: { status: 'POSTED' } }, _sum: { debit: true, credit: true } });
    expect(Number(bal._sum.debit)).toBe(Number(bal._sum.credit));

    expect((await s.a.post('/books/close/accruals').send({ date: '2026-09-30', reverseOn: '2026-09-01', memo: 'x', lines: [{ account: 'UTILITIES', debit: 1 }, { account: 'ACCRUED_EXPENSES', credit: 1 }] })).body.error.code).toBe('reverse_before_date');
  });
});
