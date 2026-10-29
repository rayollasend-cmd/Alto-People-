import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { DAY, nextKey, portalCalendar, serviceReportKey, shiftScope, type PortalScope } from './portalMetrics.js';
import { dateColumnKey } from './timezone.js';

/**
 * What needs a client account — one definition for the store home's
 * "Needs you" and the client's Inbox (F500 G5). The Inbox told a store
 * "Nothing is waiting on you" while two statements were past due, last
 * week's service report sat unreviewed and a candidate waited on an answer.
 */

/** Candidates put to this client (and, for a store account, its store or the whole client) still waiting on an answer. */
export function waitingCandidatesWhere(scope: Pick<PortalScope, 'clientId' | 'locationId'>): Prisma.CandidateSubmittalWhereInput {
  return {
    clientId: scope.clientId,
    status: 'PENDING',
    candidate: { deletedAt: null },
    ...(scope.locationId ? { OR: [{ locationId: null }, { locationId: scope.locationId }] } : {}),
  };
}

/** Finalised statements the client hasn't paid. */
export function unpaidStatementsWhere(clientId: string): Prisma.ClientStatementWhereInput {
  return { clientId, status: 'FINAL', paidAt: null };
}

/** Whole calendar days from `fromKey` to `toKey` (YYYY-MM-DD). */
export function keyDays(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T12:00:00Z`) - Date.parse(`${fromKey}T12:00:00Z`)) / DAY);
}

/** Days past the due date on the store's calendar; null when not yet due (or no due date). */
export function daysPastDue(dueAt: Date | null, todayKey: string): number | null {
  if (!dueAt) return null;
  const d = keyDays(dateColumnKey(dueAt), todayKey); // ClientStatement.dueAt is a @db.Date
  return d > 0 ? d : null;
}

/** A client account's portal scope (its client, and its store when pinned). Null for a region account or no client. */
export async function portalScopeOf(user: Pick<SessionUser, 'clientId' | 'locationId'>): Promise<PortalScope | null> {
  if (!user.clientId) return null;
  const [client, location] = await Promise.all([
    prisma.client.findFirst({ where: { id: user.clientId, deletedAt: null }, select: { id: true, name: true } }),
    user.locationId
      ? prisma.site.findFirst({
          where: { id: user.locationId, clientId: user.clientId, deletedAt: null },
          select: { id: true, name: true, timezone: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true },
        })
      : Promise.resolve(null),
  ]);
  if (!client) return null;
  return { clientId: client.id, locationId: location?.id ?? null, client, location };
}

/**
 * Last complete week's service report: its week, whether anything was
 * scheduled in it (an empty week's report is not a task), and whether this
 * account (its store) has marked it reviewed.
 */
export async function serviceReportToReview(scope: PortalScope, now: Date = new Date()): Promise<{ weekStart: string; hadShifts: boolean; reviewed: boolean }> {
  const cal = await portalCalendar(scope);
  const thisWeek = cal.key(cal.weekStart(now));
  const weekStart = nextKey(thisWeek, -7);
  const [shifts, ack] = await Promise.all([
    prisma.shift.count({ where: { ...shiftScope(scope), startsAt: { gte: cal.midnight(weekStart), lt: cal.midnight(thisWeek) } } }),
    prisma.clientAcknowledgement.findFirst({
      where: { clientId: scope.clientId, kind: 'SERVICE_REPORT', subjectKey: serviceReportKey(scope, weekStart) },
      select: { id: true },
    }),
  ]);
  return { weekStart, hadShifts: shifts > 0, reviewed: !!ack };
}
