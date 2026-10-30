import type { Prisma } from '@prisma/client';
import type { HugoActivityItem, HugoActivityPage, HugoNoteData, HugoNoteKind, HugoTaskKind, HugoTaskSubject } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { allowanceStatus } from './hugoAllowance.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * What Hugo did for one person, newest first (GET /hugo/activity): every
 * line on their tasks' trails (all kinds — cover asks, watches, briefs
 * delivered, goal steps), the notes they accepted or put away, the actions
 * they confirmed through the assistant and how each went (it ran as them,
 * through the product's own route — AssistantAction is that record), and
 * the moment this period's allowance ran out.
 *
 *   Their own rows only: every read is by their user id inside the
 *   tenant, so another person's history never comes back — and each line
 *   carries only what its trail already named.
 *
 *   Paged by a cursor over (time, id), newest first: `next` is the last
 *   line's, and `before=<next>` continues exactly where the page stopped,
 *   even when lines share a millisecond.
 */

/** Trail lines that are bookkeeping, not something Hugo did for them (a goal's thinking step). */
const HIDDEN_CODES = ['STEP'];

/** Where a confirmed action's line opens (the same places lib/assistantActions sends people). */
const ACTION_LINK: Record<string, string> = {
  'time_off.decide': '/time-off',
  'timesheet.approve': '/time',
  'shift.give': '/scheduling',
  'crew.message': '/',
  'hr_case.file': '/hr-cases',
  'schedule.request': '/messages',
  call_out: '/',
};

interface Cursor {
  at: Date;
  id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `before` is a page's `next` ("<ISO time>~<id>"), or a bare ISO time. */
export function parseActivityCursor(before: string | null | undefined): Cursor | null {
  if (!before) return null;
  const [iso, id] = before.split('~');
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime()) || (id !== undefined && !UUID.test(id))) throw new HttpError(400, 'invalid_cursor', 'That page marker is not valid.');
  return { at, id: id ? id.toLowerCase() : null };
}

const cursorOf = (item: Pick<HugoActivityItem, 'at' | 'id'>) => `${item.at}~${item.id}`;

/** Rows strictly before the cursor, in (time, id) order. */
function before<K extends string>(field: K, c: Cursor | null): Record<string, unknown> {
  if (!c) return {};
  if (!c.id) return { [field]: { lt: c.at } };
  return { OR: [{ [field]: { lt: c.at } }, { [field]: c.at, id: { lt: c.id } }] };
}

/** Newest first; a shared millisecond falls back to the id, as the queries order it. */
const newestFirst = (a: HugoActivityItem, b: HugoActivityItem) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1);

/** The usage row that ran this period's allowance out, if it has run out (the ledger, lib/hugoAllowance). */
async function usedUpMoment(userId: string, tenantId: string, now: Date): Promise<HugoActivityItem | null> {
  const status = await allowanceStatus(userId, now);
  if (!status.exhausted) return null;
  const rows = await prisma.hugoUsage.findMany({
    where: { tenantId, userId, createdAt: { gte: status.periodStart } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, createdAt: true, costMicros: true },
    take: 20_000,
  });
  let sum = 0;
  for (const r of rows) {
    sum += r.costMicros;
    if (sum >= status.capMicros) {
      return { id: r.id, at: r.createdAt.toISOString(), kind: 'usage', code: 'USED_UP', data: { renewsAt: status.renewsAt.toISOString() }, linkUrl: null };
    }
  }
  return null;
}

export async function listHugoActivity(userId: string, opts: { before?: string | null; limit?: number; now?: Date } = {}): Promise<HugoActivityPage> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const cursor = parseActivityCursor(opts.before);
  const tenantId = tenantIdForWrite();
  const take = limit + 1;

  const [events, notes, actions, usedUp] = await Promise.all([
    prisma.hugoTaskEvent.findMany({
      where: { AND: [{ tenantId, task: { userId }, code: { notIn: HIDDEN_CODES } }, before('createdAt', cursor) as Prisma.HugoTaskEventWhereInput] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, code: true, data: true, createdAt: true, task: { select: { id: true, kind: true, subject: true, linkUrl: true } } },
    }),
    prisma.hugoNote.findMany({
      where: { AND: [{ tenantId, userId, status: { in: ['ACCEPTED', 'DISMISSED'] }, actedAt: { not: null } }, before('actedAt', cursor) as Prisma.HugoNoteWhereInput] },
      orderBy: [{ actedAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, kind: true, status: true, data: true, actedAt: true },
    }),
    prisma.assistantAction.findMany({
      where: { AND: [{ tenantId, userId, status: { in: ['CONFIRMED', 'FAILED'] }, decidedAt: { not: null }, resultStatus: { not: null } }, before('decidedAt', cursor) as Prisma.AssistantActionWhereInput] },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, kind: true, title: true, status: true, resultStatus: true, result: true, decidedAt: true },
    }),
    usedUpMoment(userId, tenantId, opts.now ?? new Date()).catch(() => null),
  ]);

  const items: HugoActivityItem[] = [
    ...events.map(
      (e): HugoActivityItem => ({
        id: e.id,
        at: e.createdAt.toISOString(),
        kind: 'task',
        code: e.code,
        data: (e.data ?? {}) as Record<string, string | number | null>,
        linkUrl: e.task.linkUrl,
        task: { id: e.task.id, kind: e.task.kind as HugoTaskKind, subject: e.task.subject as HugoTaskSubject },
      }),
    ),
    ...notes.map(
      (n): HugoActivityItem => ({
        id: n.id,
        at: n.actedAt!.toISOString(),
        kind: 'note',
        code: n.status,
        data: {},
        linkUrl: null,
        note: { id: n.id, kind: n.kind as HugoNoteKind, data: n.data as HugoNoteData },
      }),
    ),
    ...actions.map((a): HugoActivityItem => {
      const status = a.resultStatus ?? 0;
      const pending = status === 202 || (a.result as { pending?: boolean } | null)?.pending === true;
      const ok = a.status === 'CONFIRMED' && status >= 200 && status < 300;
      return {
        id: a.id,
        at: a.decidedAt!.toISOString(),
        kind: 'action',
        code: ok ? (pending ? 'SENT_FOR_APPROVAL' : 'DONE') : 'FAILED',
        data: { title: a.title, action: a.kind },
        linkUrl: ok ? (ACTION_LINK[a.kind] ?? null) : null,
      };
    }),
  ];
  if (usedUp && (!cursor || usedUp.at < cursor.at.toISOString() || (usedUp.at === cursor.at.toISOString() && cursor.id !== null && usedUp.id < cursor.id))) items.push(usedUp);

  items.sort(newestFirst);
  const page = items.slice(0, limit);
  return { items: page, next: items.length > limit ? cursorOf(page[page.length - 1]!) : null };
}
