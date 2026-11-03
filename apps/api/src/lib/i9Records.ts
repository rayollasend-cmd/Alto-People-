import type { Prisma, PrismaClient } from '@prisma/client';
import type { SessionUser } from '../types/express.js';
import { prisma as defaultPrisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';
import { scopeAssociates, scopeAssociatesIncludingFormer } from './scope.js';
import { readWorkforce, type WorkforceReading } from './complianceWorkforce.js';
import { i9PastRetention, i9RetainUntil, i9RetentionWhere, i9TerminationDay } from './hiringCompliance.js';
import { hireDatesFor } from './hireDate.js';
import { dateColumnKey } from './timezone.js';
import { auditRequestStore } from './auditRequestContext.js';

/**
 * The database half of the I-9 and E-Verify lists (owner, 2026-11-03): who
 * the caller may see, when each person's employment ended, and their
 * employment spells. lib/hiringCompliance holds the rules; this reads what
 * they need, once per list.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The caller's reach on the I-9 and E-Verify lists and their by-id routes:
 * the people they reach today (scopeAssociates), plus the people who LEFT
 * from a site in their reach — a separated person has no open assignment,
 * so the open-assignment clamp alone hid every former employee from a
 * store-bound HR account, and the Former view (retention, cases left open)
 * is about exactly them. An unscoped account reaches everyone either way.
 * AND it with the route's own conditions; never spread it.
 */
export function i9ListReach(user: SessionUser): Prisma.AssociateWhereInput {
  const today = scopeAssociates(user);
  // Unscoped: no condition at all. (Prisma drops an empty `{}` from an OR
  // instead of reading it as "everyone", so it must not go in one.)
  if (Object.keys(today).length === 0) return {};
  return {
    OR: [today, { AND: [{ OR: [{ separatedAt: { not: null } }, { erasedAt: { not: null } }] }, scopeAssociatesIncludingFormer(user)] }],
  };
}

/** When each person's employment ended (i9TerminationDay): the latest completed separation's last day worked, else separatedAt. */
export async function terminationDaysFor(db: Db, people: ReadonlyArray<{ id: string; separatedAt: Date | null }>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const left = people.filter((p) => p.separatedAt);
  const done = left.length
    ? await db.separation.findMany({
        where: { associateId: { in: left.map((p) => p.id) }, status: 'COMPLETE' },
        select: { associateId: true, lastDayWorked: true },
        orderBy: { lastDayWorked: 'desc' },
      })
    : [];
  const last = new Map<string, Date>();
  for (const s of done) if (!last.has(s.associateId)) last.set(s.associateId, s.lastDayWorked);
  for (const p of people) out.set(p.id, p.separatedAt ? i9TerminationDay(last.get(p.id) ?? null, p.separatedAt) : null);
  return out;
}

/** Each person's employment spells (a rehire has more than one). */
export async function employmentSpellsFor(db: Db, associateIds: string[]): Promise<Map<string, Array<{ hireDate: Date; endDate: Date | null }>>> {
  const out = new Map<string, Array<{ hireDate: Date; endDate: Date | null }>>();
  if (associateIds.length === 0) return out;
  const rows = await db.employment.findMany({
    where: { associateId: { in: associateIds } },
    select: { associateId: true, hireDate: true, endDate: true },
  });
  for (const r of rows) {
    const list = out.get(r.associateId) ?? [];
    list.push({ hireDate: r.hireDate, endDate: r.endDate });
    out.set(r.associateId, list);
  }
  return out;
}

/**
 * One computation per request, shared by the Inbox's several I-9 and
 * E-Verify sources. Keyed by the request's own context object
 * (auditRequestStore) — never by req.user, which the auth middleware
 * caches across requests for 30 seconds and would serve stale counts. No
 * request context (a script): no sharing.
 */
export function perRequest<T>(memo: WeakMap<object, Promise<T>>, compute: () => Promise<T>): Promise<T> {
  const key = auditRequestStore.getStore();
  if (!key) return compute();
  let hit = memo.get(key);
  if (!hit) {
    hit = compute();
    memo.set(key, hit);
  }
  return hit;
}

/** The workforce reading for one request (perRequest). */
const readingMemo = new WeakMap<object, Promise<WorkforceReading>>();
export function workforceForRequest(_user: SessionUser): Promise<WorkforceReading> {
  return perRequest(readingMemo, () => readWorkforce(tenantIdForWrite(), new Date(), defaultPrisma));
}

/**
 * How many I-9s of people who left (the Former group) are past retention,
 * in the caller's reach — the Inbox count, by the list's own rule
 * (i9RetentionWhere narrows, i9PastRetention decides).
 */
export async function pastRetentionCount(user: SessionUser, reading: WorkforceReading, now: Date = new Date()): Promise<number> {
  const formerIds = reading.idsOf('former') ?? [];
  if (formerIds.length === 0) return 0;
  const rows = await defaultPrisma.i9Verification.findMany({
    where: {
      AND: [
        { tenantId: tenantIdForWrite(), associateId: { in: formerIds } },
        i9RetentionWhere(now),
        { associate: { AND: [{ deletedAt: null }, i9ListReach(user)] } },
      ],
    },
    select: {
      associateId: true,
      associate: { select: { separatedAt: true, applications: { select: { startDate: true }, orderBy: { invitedAt: 'desc' }, take: 1 } } },
    },
  });
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.associateId);
  const planned = new Map(rows.map((r) => [r.associateId, r.associate.applications[0]?.startDate ?? null]));
  const [hired, ended] = await Promise.all([
    hireDatesFor(defaultPrisma, ids, planned),
    terminationDaysFor(defaultPrisma, rows.map((r) => ({ id: r.associateId, separatedAt: r.associate.separatedAt }))),
  ]);
  return rows.filter((r) => {
    const end = ended.get(r.associateId) ?? null;
    return i9PastRetention(i9RetainUntil(hired.get(r.associateId)?.date ?? null, end), end, now);
  }).length;
}

/** Each person's REHIRE Supplement B entries (rehire day, day recorded) — which employment reused the earlier I-9. */
export async function rehiresFor(db: Db, associateIds: string[]): Promise<Map<string, Array<{ rehiredOn: string; reviewedOn: string }>>> {
  const out = new Map<string, Array<{ rehiredOn: string; reviewedOn: string }>>();
  if (associateIds.length === 0) return out;
  const rows = await db.i9Reverification.findMany({
    where: { associateId: { in: associateIds }, kind: 'REHIRE', rehiredOn: { not: null } },
    select: { associateId: true, rehiredOn: true, reviewedOn: true },
  });
  for (const r of rows) {
    const list = out.get(r.associateId) ?? [];
    list.push({ rehiredOn: dateColumnKey(r.rehiredOn!), reviewedOn: dateColumnKey(r.reviewedOn) });
    out.set(r.associateId, list);
  }
  return out;
}
