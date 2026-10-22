import type { FiscalPeriod, Prisma, PrismaClient } from '@prisma/client';
import { can, type Role } from '@alto-people/shared';
import type {
  AccrualCreateInput,
  CloseAccrualsResponse,
  CloseListResponse,
  CloseMonthSummary,
  ClosePeriodDetail,
  ClosePeriodStatus,
  CloseTaskUpdateInput,
  CloseTaskView,
} from '@alto-people/shared';
import { HttpError } from '../../../middleware/error.js';
import { createApprovalRequest, registerApplyHandler } from '../../approvalRequests.js';
import { rolesHolding } from '../../approvalPolicy.js';
import { enqueueAudit } from '../../audit.js';
import { notifyUser } from '../../notify.js';
import { tenantIdForWrite } from '../../tenant.js';
import { addMonths, monthEnd, periodKeyOf } from '../assets/depreciation.js';
import { fromCents, postEntry, toCents } from '../ledger.js';
import { CLOSE_TASKS, TASK_BY_KEY, ensurePeriod, runChecks, type CheckResult } from './checklist.js';

/**
 * The month-end close.
 *
 *   OPEN    the month takes postings; its checklist is worked.
 *   READY   the preparer has said it's done (every step done or skipped):
 *           FiscalPeriod.closedById = the preparer, closedAt still empty.
 *   CLOSED  a SECOND person with manage:books signed it off: status
 *           CLOSED, closedAt, signedOffById. The ledger takes nothing
 *           dated in it; a late change lands in the first open month.
 *
 * Reopening a closed month is a PERIOD_REOPEN approval: someone asks with
 * a reason, someone else with manage:books decides.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface Actor {
  id: string;
  role: Role;
  capabilities?: string[] | null;
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

export const monthLabel = (periodKey: string) =>
  new Date(`${periodKey}-01T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function statusOf(p: Pick<FiscalPeriod, 'status' | 'closedById' | 'closedAt'> | null): ClosePeriodStatus {
  if (!p) return 'OPEN';
  if (p.status === 'CLOSED') return 'CLOSED';
  return p.closedById ? 'READY' : 'OPEN';
}

async function names(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: want } }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email)]));
}

const mayManage = (u: Actor) => can(u as Parameters<typeof can>[0], 'manage:books');

/* ---- Tasks ---------------------------------------------------------------- */

function taskViews(
  rows: Array<{ key: string; title: string; detail: string | null; status: string; note: string | null; doneAt: Date | null; doneById: string | null; sortOrder: number }>,
  checks: Map<string, CheckResult> | null,
  who: Map<string, string>,
  periodKey: string,
  closed: boolean,
): CloseTaskView[] {
  return [...rows]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => {
      const tpl = TASK_BY_KEY.get(r.key);
      const auto = tpl?.auto ?? false;
      const check = auto && checks ? checks.get(r.key) ?? null : null;
      const stored = r.status as CloseTaskView['status'];
      // An auto step is DONE while its check passes; a hand skip stands; a closed month keeps what it closed with.
      const status: CloseTaskView['status'] = closed ? (stored === 'OPEN' ? 'DONE' : stored) : stored === 'SKIPPED' ? 'SKIPPED' : auto ? (check?.passing ? 'DONE' : 'OPEN') : stored;
      return {
        key: r.key,
        title: r.title,
        detail: r.detail,
        auto,
        status,
        passing: check ? check.passing : null,
        summary: check?.summary ?? null,
        items: check?.items ?? [],
        link: tpl?.link(periodKey) ?? null,
        action: status === 'OPEN' ? (check?.action ?? null) : null,
        note: r.note,
        doneAt: iso(r.doneAt),
        doneByName: r.doneById ? (who.get(r.doneById) ?? null) : null,
      };
    });
}

async function liabilities(db: Db, periodKey: string) {
  const tenantId = tenantIdForWrite();
  const accounts = await db.ledgerAccount.findMany({ where: { tenantId, subtype: { in: ['PAYROLL_LIABILITY', 'TAX_LIABILITY'] } }, orderBy: { code: 'asc' } });
  if (!accounts.length) return [];
  const sums = await db.journalLine.groupBy({
    by: ['accountId'],
    where: { tenantId, accountId: { in: accounts.map((a) => a.id) }, entry: { status: 'POSTED', entryDate: { lte: dateOnly(monthEnd(periodKey)) } } },
    _sum: { debit: true, credit: true },
  });
  const net = new Map(sums.map((s) => [s.accountId, toCents(s._sum.credit) - toCents(s._sum.debit)]));
  return accounts.map((a) => ({ accountId: a.id, code: a.code, name: a.name, balance: fromCents(net.get(a.id) ?? 0) }));
}

async function pendingReopen(db: Db, periodId: string) {
  return db.approvalRequest.findFirst({ where: { tenantId: tenantIdForWrite(), kind: 'PERIOD_REOPEN', subjectId: periodId, status: 'PENDING' }, select: { id: true } });
}

export function assertPeriodKey(periodKey: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) throw new HttpError(400, 'bad_period', 'A month is YYYY-MM.');
}

/* ---- Reads ---------------------------------------------------------------- */

export async function closeDetail(db: Db, periodKey: string, actor: Actor, now: Date = new Date()): Promise<ClosePeriodDetail> {
  assertPeriodKey(periodKey);
  const period = await ensurePeriod(db, periodKey);
  const tasks = await db.closeTask.findMany({ where: { periodId: period.id } });
  const status = statusOf(period);
  const checks = status === 'CLOSED' ? null : await runChecks(db, periodKey);
  const who = await names(db, [period.closedById, period.signedOffById, period.reopenedById, ...tasks.map((t) => t.doneById)]);
  const views = taskViews(tasks, checks, who, periodKey, status === 'CLOSED');
  const done = views.filter((t) => t.status !== 'OPEN').length;
  const ended = periodKey < periodKeyOf(now);
  const reopenPending = !!(await pendingReopen(db, period.id));
  const manage = mayManage(actor);
  const allDone = done === views.length;
  const why = !manage
    ? 'Only someone who keeps the books can work the close.'
    : status === 'OPEN' && !ended
      ? `${monthLabel(periodKey)} hasn’t ended yet.`
      : status === 'OPEN' && !allDone
        ? `${views.length - done} ${views.length - done === 1 ? 'step is' : 'steps are'} still open.`
        : status === 'READY' && period.closedById === actor.id
          ? 'Ready — a second person signs it off.'
          : status === 'CLOSED' && reopenPending
            ? 'A request to reopen it is waiting for a decision.'
            : null;
  return {
    periodKey,
    label: monthLabel(periodKey),
    status,
    tasksTotal: views.length,
    tasksDone: done,
    preparedByName: period.closedById ? (who.get(period.closedById) ?? null) : null,
    signedOffByName: period.signedOffById ? (who.get(period.signedOffById) ?? null) : null,
    closedAt: iso(period.closedAt),
    reopenedAt: iso(period.reopenedAt),
    ended,
    pendingReopen: reopenPending,
    tasks: views,
    preparedById: period.closedById,
    signedOffById: period.signedOffById,
    signedOffAt: iso(period.signedOffAt),
    reopenReason: period.reopenReason,
    liabilities: await liabilities(db, periodKey),
    can: {
      edit: manage && status === 'OPEN',
      ready: manage && status === 'OPEN' && ended && allDone,
      unready: manage && status === 'READY',
      signOff: manage && status === 'READY' && period.closedById !== actor.id,
      reopen: manage && status === 'CLOSED' && !reopenPending,
      why,
    },
  };
}

/**
 * How far a month's close is, counted exactly as the close page counts it
 * (auto steps by their live check, hand steps by their stored status, a
 * skip standing) — the Books home reads this, so "0 of 10" there and
 * "5 of 10" on the checklist can't disagree (finance walk 3).
 */
export async function closeProgress(db: Db, periodKey: string): Promise<{ status: ClosePeriodStatus; tasksDone: number; tasksTotal: number; closedAt: string | null }> {
  const tenantId = tenantIdForWrite();
  const p = await db.fiscalPeriod.findUnique({ where: { tenantId_periodKey: { tenantId, periodKey } }, include: { closeTasks: true } });
  const status = statusOf(p);
  if (status === 'CLOSED') return { status, tasksDone: CLOSE_TASKS.length, tasksTotal: CLOSE_TASKS.length, closedAt: iso(p?.closedAt) };
  const checks = await runChecks(db, periodKey);
  const stored = new Map((p?.closeTasks ?? []).map((r) => [r.key, r.status]));
  const done = CLOSE_TASKS.filter((t) => stored.get(t.key) === 'SKIPPED' || (t.auto ? checks.get(t.key)?.passing : stored.get(t.key) === 'DONE')).length;
  return { status, tasksDone: done, tasksTotal: CLOSE_TASKS.length, closedAt: iso(p?.closedAt) };
}

export async function closeList(db: Db, now: Date = new Date()): Promise<CloseListResponse> {
  const tenantId = tenantIdForWrite();
  const current = periodKeyOf(now);
  const keys = Array.from({ length: 13 }, (_, i) => addMonths(current, -i));
  const periods = await db.fiscalPeriod.findMany({ where: { tenantId, periodKey: { in: keys } }, include: { closeTasks: true } });
  const byKey = new Map(periods.map((p) => [p.periodKey, p]));
  const who = await names(db, periods.flatMap((p) => [p.closedById, p.signedOffById]));
  const pending = await db.approvalRequest.findMany({ where: { tenantId, kind: 'PERIOD_REOPEN', status: 'PENDING', subjectId: { in: periods.map((p) => p.id) } }, select: { subjectId: true } });
  const reopenFor = new Set(pending.map((r) => r.subjectId));
  const months: CloseMonthSummary[] = [];
  for (const key of keys) {
    const p = byKey.get(key) ?? null;
    const status = statusOf(p);
    const done = (await closeProgress(db, key)).tasksDone;
    months.push({
      periodKey: key,
      label: monthLabel(key),
      status,
      tasksTotal: CLOSE_TASKS.length,
      tasksDone: done,
      preparedByName: p?.closedById ? (who.get(p.closedById) ?? null) : null,
      signedOffByName: p?.signedOffById ? (who.get(p.signedOffById) ?? null) : null,
      closedAt: iso(p?.closedAt),
      reopenedAt: iso(p?.reopenedAt),
      ended: key < current,
      pendingReopen: !!p && reopenFor.has(p.id),
    });
  }
  // The month after the last one closed; with nothing closed yet, last month.
  const lastClosed = months.find((m) => m.status === 'CLOSED')?.periodKey ?? null;
  const nextToClose = lastClosed
    ? ([...months].reverse().find((m) => m.ended && m.status !== 'CLOSED' && m.periodKey > lastClosed)?.periodKey ?? null)
    : (months.find((m) => m.ended)?.periodKey ?? null);
  return { months, nextToClose };
}

/* ---- Writes --------------------------------------------------------------- */

function audit(actor: Actor, action: string, periodId: string, metadata: Record<string, unknown>) {
  enqueueAudit({ actorUserId: actor.id, clientId: null, action, entityType: 'FiscalPeriod', entityId: periodId, metadata: metadata as Prisma.InputJsonValue }, 'books.close');
}

export async function updateTask(db: Db, periodKey: string, key: string, input: CloseTaskUpdateInput, actor: Actor): Promise<void> {
  assertPeriodKey(periodKey);
  if (!mayManage(actor)) throw new HttpError(403, 'forbidden', 'Only someone who keeps the books can work the close.');
  const tpl = TASK_BY_KEY.get(key);
  if (!tpl) throw new HttpError(404, 'task_not_found', 'No such close step.');
  const period = await ensurePeriod(db, periodKey);
  if (statusOf(period) !== 'OPEN') throw new HttpError(409, 'period_not_open', statusOf(period) === 'READY' ? 'This month is waiting for sign-off. Take it back to change a step.' : 'This month is closed.');
  if (tpl.auto && input.status === 'DONE') throw new HttpError(400, 'auto_task', 'This step checks itself — fix what it found, or skip it with a note.');
  if (input.status === 'SKIPPED' && !input.note?.trim()) throw new HttpError(400, 'note_required', 'Say why the step is skipped.');
  await db.closeTask.update({
    where: { periodId_key: { periodId: period.id, key } },
    data: {
      status: input.status,
      note: input.note ?? null,
      doneAt: input.status === 'OPEN' ? null : new Date(),
      doneById: input.status === 'OPEN' ? null : actor.id,
    },
  });
  audit(actor, 'books.close.task', period.id, { periodKey, key, status: input.status, note: input.note ?? null });
}

export async function markReady(db: PrismaClient, periodKey: string, actor: Actor, now: Date = new Date()): Promise<void> {
  const d = await closeDetail(db, periodKey, actor, now);
  if (!d.can.ready) throw new HttpError(409, 'not_ready', d.can.why ?? 'This month can’t be marked ready.');
  const tenantId = tenantIdForWrite();
  const period = await db.fiscalPeriod.update({ where: { tenantId_periodKey: { tenantId, periodKey } }, data: { closedById: actor.id, closedAt: null } });
  audit(actor, 'books.close.ready', period.id, { periodKey });
  // Ring everyone else who can sign it off.
  const signers = await db.user.findMany({ where: { tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesHolding('manage:books') }, id: { not: actor.id } }, select: { id: true }, take: 25 });
  const preparer = (await names(db, [actor.id])).get(actor.id) ?? 'Someone';
  for (const u of signers) {
    void notifyUser(u.id, {
      subject: `${monthLabel(periodKey)} is ready to close`,
      body: `${preparer} worked the close for ${monthLabel(periodKey)}. It needs a second person to sign it off.`,
      category: 'payroll',
      linkUrl: `/books/close/${periodKey}`,
    });
  }
}

export async function unready(db: PrismaClient, periodKey: string, actor: Actor): Promise<void> {
  assertPeriodKey(periodKey);
  if (!mayManage(actor)) throw new HttpError(403, 'forbidden', 'Only someone who keeps the books can work the close.');
  const tenantId = tenantIdForWrite();
  const period = await db.fiscalPeriod.findUnique({ where: { tenantId_periodKey: { tenantId, periodKey } } });
  if (statusOf(period) !== 'READY') throw new HttpError(409, 'not_ready', 'This month isn’t waiting for sign-off.');
  await db.fiscalPeriod.update({ where: { id: period!.id }, data: { closedById: null } });
  audit(actor, 'books.close.unready', period!.id, { periodKey });
}

export async function signOff(db: PrismaClient, periodKey: string, actor: Actor, now: Date = new Date()): Promise<void> {
  const d = await closeDetail(db, periodKey, actor, now);
  if (d.status !== 'READY') throw new HttpError(409, 'not_ready', 'This month isn’t waiting for sign-off.');
  if (d.preparedById === actor.id) throw new HttpError(409, 'same_person', 'You prepared this close — a second person signs it off.');
  if (!d.can.signOff) throw new HttpError(403, 'forbidden', d.can.why ?? 'You can’t sign this month off.');
  // The steps must still hold now, not just when it was marked ready.
  const open = d.tasks.filter((t) => t.status === 'OPEN');
  if (open.length) throw new HttpError(409, 'steps_open', `Since it was marked ready, ${open.map((t) => t.title.toLowerCase()).join('; ')} came undone.`);
  const tenantId = tenantIdForWrite();
  const period = await db.fiscalPeriod.update({
    where: { tenantId_periodKey: { tenantId, periodKey } },
    data: { status: 'CLOSED', closedAt: now, signedOffById: actor.id, signedOffAt: now },
  });
  audit(actor, 'books.close.signed_off', period.id, { periodKey, preparedById: d.preparedById });
  if (d.preparedById) {
    void notifyUser(d.preparedById, {
      subject: `${monthLabel(periodKey)} is closed`,
      body: `${(await names(db, [actor.id])).get(actor.id) ?? 'A second person'} signed off the close. Nothing more posts to ${monthLabel(periodKey)}.`,
      category: 'payroll',
      linkUrl: `/books/close/${periodKey}`,
    });
  }
}

export async function requestReopen(db: PrismaClient, periodKey: string, reason: string, actor: Actor) {
  assertPeriodKey(periodKey);
  if (!mayManage(actor)) throw new HttpError(403, 'forbidden', 'Only someone who keeps the books can ask to reopen a month.');
  const tenantId = tenantIdForWrite();
  const period = await db.fiscalPeriod.findUnique({ where: { tenantId_periodKey: { tenantId, periodKey } } });
  if (!period || period.status !== 'CLOSED') throw new HttpError(409, 'not_closed', 'This month isn’t closed.');
  if (await pendingReopen(db, period.id)) throw new HttpError(409, 'reopen_pending', 'A request to reopen it is already waiting.');
  const row = await createApprovalRequest(db, {
    kind: 'PERIOD_REOPEN',
    subjectType: 'FiscalPeriod',
    subjectId: period.id,
    title: `Reopen ${monthLabel(periodKey)}`,
    summary: `Reopening lets entries post to ${monthLabel(periodKey)} again. Reason: ${reason}`,
    proposed: { periodKey, reason },
    before: { status: 'CLOSED', closedAt: iso(period.closedAt), signedOffById: period.signedOffById },
    requesterUserId: actor.id,
    approver: { capability: 'manage:books' },
  });
  audit(actor, 'books.close.reopen_requested', period.id, { periodKey, reason, approvalId: row.id });
  return row;
}

registerApplyHandler('PERIOD_REOPEN', async (db, row, decider) => {
  const p = row.proposed as { periodKey: string; reason: string };
  const period = await db.fiscalPeriod.findFirst({ where: { id: row.subjectId } });
  if (!period || period.status !== 'CLOSED') return;
  await db.fiscalPeriod.update({
    where: { id: period.id },
    data: { status: 'OPEN', closedAt: null, closedById: null, signedOffById: null, signedOffAt: null, reopenedAt: new Date(), reopenedById: row.requesterUserId, reopenReason: p.reason.slice(0, 500) },
  });
  enqueueAudit(
    { actorUserId: decider.id, clientId: null, action: 'books.close.reopened', entityType: 'FiscalPeriod', entityId: period.id, metadata: { periodKey: p.periodKey, reason: p.reason, requestedById: row.requesterUserId, approvalId: row.id } },
    'books.close',
  );
});

/* ---- Accruals ------------------------------------------------------------- */

export async function accrualsFor(db: Db, periodKey: string): Promise<CloseAccrualsResponse> {
  assertPeriodKey(periodKey);
  const tenantId = tenantIdForWrite();
  const entries = await db.journalEntry.findMany({
    where: { tenantId, status: 'POSTED', periodKey, OR: [{ source: 'ACCRUAL' }, { reverseOn: { not: null } }] },
    orderBy: [{ entryDate: 'asc' }, { number: 'asc' }],
  });
  const reversals = entries.length
    ? await db.journalEntry.findMany({ where: { tenantId, sourceKey: { in: entries.map((e) => `reversal:${e.id}`) } }, select: { id: true, sourceId: true, entryDate: true } })
    : [];
  const rev = new Map(reversals.map((r) => [r.sourceId, r]));
  return {
    periodKey,
    accruals: entries.map((e) => ({
      entryId: e.id,
      number: e.number,
      date: ymd(e.entryDate)!,
      memo: e.memo,
      amount: Number(e.totalDebit),
      reverseOn: ymd(e.reverseOn),
      reversedEntryId: rev.get(e.id)?.id ?? null,
      reversedOn: ymd(rev.get(e.id)?.entryDate),
    })),
  };
}

export async function createAccrual(db: PrismaClient, input: AccrualCreateInput, actor: Actor): Promise<{ entryId: string }> {
  if (!mayManage(actor)) throw new HttpError(403, 'forbidden', 'Only someone who keeps the books can record an accrual.');
  const reverseOn = input.reverseOn ?? `${addMonths(input.date.slice(0, 7), 1)}-01`;
  if (reverseOn <= input.date) throw new HttpError(400, 'reverse_before_date', 'An accrual reverses after the day it’s recorded.');
  const entry = await postEntry(db, {
    date: input.date,
    memo: input.memo,
    source: 'ACCRUAL',
    reverseOn,
    createdById: actor.id,
    lines: input.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, memo: l.memo ?? null, clientId: l.clientId ?? null, departmentId: l.departmentId ?? null })),
  });
  enqueueAudit({ actorUserId: actor.id, clientId: null, action: 'books.accrual.created', entityType: 'JournalEntry', entityId: entry.id, metadata: { date: input.date, reverseOn, amount: Number(entry.totalDebit) } }, 'books.close');
  return { entryId: entry.id };
}
