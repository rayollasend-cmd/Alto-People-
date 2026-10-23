import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAnyCapability } from '../middleware/auth.js';
import { scopeShifts, scopeWhere } from '../lib/scope.js';
import { companyWorkweek, dateKeyInZone } from '../lib/timeAnomalies.js';
import { personDisplayName } from '../lib/displayName.js';

/**
 * GET /ops-activity?days=7 — what happened on the floor, newest first:
 * call-outs, weeks published, swaps decided, incidents reported. The admin
 * home's "Recent activity" used to be the audit log, which on most days is
 * a list of sign-ins. This is the operational record, each row linking to
 * where it's worked. Everything is read through the caller's shift reach.
 *
 * A publish is one row per store and calendar day (the store's clock), named
 * by who published it and which days it covers — "Dana Reyes published 8
 * shifts · Front Beach 218 / Week of Oct 24" — never eight anonymous
 * "1 shift published" rows (F500 G5). An incident leads with where it
 * happened and says what happened in words, not the OSHA enum.
 */
export const opsActivityRouter = Router();

const READ = requireAnyCapability('manage:scheduling', 'manage:time', 'view:executive', 'view:analytics');

export type OpsActivityKind = 'call_out' | 'published' | 'swap' | 'incident';
export interface OpsActivityItem {
  id: string;
  kind: OpsActivityKind;
  at: string;
  title: string;
  detail: string | null;
  href: string;
}

const name = (a: { firstName: string; lastName: string } | null | undefined) => (a ? `${a.firstName} ${a.lastName}` : 'Someone');
const SWAP_DONE = ['MANAGER_APPROVED', 'MANAGER_REJECTED'] as const;

/** What happened, in words (the OSHA severity enum is the form's, not the reader's). */
export const INCIDENT_WORDS: Record<string, string> = {
  FIRST_AID: 'Injury — first aid only',
  MEDICAL_TREATMENT: 'Injury — medical treatment',
  RESTRICTED_DUTY: 'Injury — restricted duty',
  DAYS_AWAY: 'Injury — days away from work',
  FATAL: 'Fatality',
};

/** Audit actions that can stamp a shift's publishedAt (create-as-published, bulk, template, week publish). */
const PUBLISH_ACTIONS = ['shift.created', 'shift.bulk_created', 'shift.created_from_template', 'shift.updated'];

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const DAY_WORDS = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const atNoon = (key: string) => new Date(`${key}T12:00:00.000Z`);
/** The first day of the company week holding a calendar day (YYYY-MM-DD). */
function weekStartKey(key: string, weekStartsOn: number): string {
  const d = atNoon(key);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - weekStartsOn + 7) % 7));
  return d.toISOString().slice(0, 10);
}
/**
 * Which days a publish covers, in words: "Sat, Oct 24" (one day), "Week of
 * Oct 24" (one company week), else "Oct 24 – Nov 6".
 */
export function publishSpan(firstDay: string, lastDay: string, weekStartsOn: number): string {
  if (firstDay === lastDay) return DAY_WORDS.format(atNoon(firstDay));
  const week = weekStartKey(firstDay, weekStartsOn);
  if (weekStartKey(lastDay, weekStartsOn) === week) return `Week of ${MONTH_DAY.format(atNoon(week))}`;
  return `${MONTH_DAY.format(atNoon(firstDay))} – ${MONTH_DAY.format(atNoon(lastDay))}`;
}

opsActivityRouter.get('/', READ, async (req, res, next) => {
  try {
    const days = z.coerce.number().int().min(1).max(31).default(7).parse(req.query.days ?? 7);
    const since = new Date(Date.now() - days * 86_400_000);
    const shiftScope = scopeShifts(req.user!);
    const shiftIn = (extra: Prisma.ShiftWhereInput = {}) => scopeWhere<Prisma.ShiftWhereInput>(shiftScope, extra);
    // Incidents carry no shift: read them only where the reach is the
    // whole company or one client — never guessed for a site-bound office.
    const keys = Object.keys(shiftScope);
    const incidentScope: Prisma.OshaIncidentWhereInput | null =
      keys.length === 0
        ? {}
        : keys.every((k) => k === 'tenantId' || k === 'clientId') && 'clientId' in shiftScope && typeof shiftScope.clientId === 'string'
          ? { clientId: shiftScope.clientId }
          : null;

    const [callOuts, swaps, published, incidents] = await Promise.all([
      prisma.callOut.findMany({
        where: { createdAt: { gte: since }, shift: { is: shiftIn() } },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true,
          createdAt: true,
          status: true,
          minutesBeforeStart: true,
          associate: { select: { firstName: true, lastName: true } },
          shift: { select: { id: true, position: true, startsAt: true, assignedAssociateId: true, location: true } },
        },
      }),
      prisma.shiftSwapRequest.findMany({
        where: { decidedAt: { gte: since }, status: { in: [...SWAP_DONE] }, shift: { is: shiftIn() } },
        orderBy: { decidedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          decidedAt: true,
          status: true,
          requester: { select: { firstName: true, lastName: true } },
          counterparty: { select: { firstName: true, lastName: true } },
          shift: { select: { position: true, startsAt: true } },
        },
      }),
      // Every shift published in the window, grouped below by store and day.
      prisma.shift.findMany({
        where: shiftIn({ publishedAt: { gte: since } }),
        orderBy: { publishedAt: 'desc' },
        take: 2000,
        select: {
          id: true,
          clientId: true,
          locationId: true,
          startsAt: true,
          publishedAt: true,
          createdAt: true,
          createdById: true,
          client: { select: { name: true } },
          locationRel: { select: { name: true, timezone: true } },
        },
      }),
      incidentScope
        ? prisma.oshaIncident.findMany({
            where: { ...incidentScope, reportedAt: { gte: since } },
            orderBy: { reportedAt: 'desc' },
            take: 25,
            select: {
              id: true,
              reportedAt: true,
              severity: true,
              description: true,
              location: true,
              store: { select: { name: true } },
              client: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    // Who published: the audit row written on the shift at that moment (a
    // week publish writes one row for its batch), else the creator when the
    // shift went live as it was created. Unknown stays unnamed.
    const { weekStartsOn, timezone: companyTz } = companyWorkweek();
    const publishedIds = published.map((p) => p.id);
    const audits = publishedIds.length
      ? await prisma.auditLog.findMany({
          where: { entityType: 'Shift', entityId: { in: publishedIds }, action: { in: PUBLISH_ACTIONS }, createdAt: { gte: new Date(since.getTime() - 60_000) }, actorUserId: { not: null } },
          select: { entityId: true, actorUserId: true, createdAt: true },
          take: 5000,
        })
      : [];
    const auditsByShift = new Map<string, Array<{ actorUserId: string | null; createdAt: Date }>>();
    for (const a of audits) auditsByShift.set(a.entityId, [...(auditsByShift.get(a.entityId) ?? []), a]);
    const publisherOf = (p: (typeof published)[number]): string | null => {
      const at = p.publishedAt!.getTime();
      const hit = (auditsByShift.get(p.id) ?? []).find((a) => a.createdAt.getTime() >= at - 5_000 && a.createdAt.getTime() <= at + 60_000);
      if (hit?.actorUserId) return hit.actorUserId;
      if (p.createdById && Math.abs(p.createdAt.getTime() - at) < 5_000) return p.createdById;
      return null;
    };
    interface PublishBucket { key: string; store: string | null; at: Date; count: number; firstDay: string; lastDay: string; actors: Map<string, number>; clientId: string | null; locationId: string | null }
    const buckets = new Map<string, PublishBucket>();
    for (const p of published) {
      if (!p.publishedAt) continue;
      const tz = p.locationRel?.timezone || companyTz;
      const storeKey = p.locationId ?? p.clientId ?? 'company';
      const key = `${storeKey}:${dateKeyInZone(p.publishedAt, tz)}`;
      const shiftDay = dateKeyInZone(p.startsAt, tz);
      const b =
        buckets.get(key) ??
        ({ key, store: p.locationRel?.name ?? p.client?.name ?? null, at: p.publishedAt, count: 0, firstDay: shiftDay, lastDay: shiftDay, actors: new Map(), clientId: p.clientId, locationId: p.locationId } as PublishBucket);
      b.count += 1;
      if (p.publishedAt > b.at) b.at = p.publishedAt;
      if (shiftDay < b.firstDay) b.firstDay = shiftDay;
      if (shiftDay > b.lastDay) b.lastDay = shiftDay;
      const actor = publisherOf(p);
      if (actor) b.actors.set(actor, (b.actors.get(actor) ?? 0) + 1);
      buckets.set(key, b);
    }
    const actorIds = [...new Set([...buckets.values()].flatMap((b) => [...b.actors.keys()]))];
    const actorUsers = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, role: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
        })
      : [];
    // The shared rule (lib/displayName): a name, else "Role · email" — never the bare address.
    const actorName = new Map(actorUsers.map((u) => [u.id, personDisplayName(u)]));
    const publishTitle = (b: PublishBucket): string => {
      const what = `${b.count} ${b.count === 1 ? 'shift' : 'shifts'}`;
      const ranked = [...b.actors.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => actorName.get(id)).filter((n): n is string => !!n);
      const who = ranked.length === 0 ? null : ranked.length === 1 ? ranked[0]! : `${ranked[0]} and ${ranked.length - 1} ${ranked.length - 1 === 1 ? 'other' : 'others'}`;
      const head = who ? `${who} published ${what}` : `${what} published`;
      return b.store ? `${head} · ${b.store}` : head;
    };

    const items: OpsActivityItem[] = [
      ...callOuts.map((c) => ({
        id: `callout:${c.id}`,
        kind: 'call_out' as const,
        at: c.createdAt.toISOString(),
        title: `${name(c.associate)} called out`,
        detail: `${c.shift.position}${c.shift.location ? ` · ${c.shift.location}` : ''} · ${c.shift.assignedAssociateId ? 'covered' : 'needs cover'}`,
        href: `/call-outs?callout=${c.id}`,
      })),
      ...swaps.map((s) => ({
        id: `swap:${s.id}`,
        kind: 'swap' as const,
        at: (s.decidedAt ?? new Date()).toISOString(),
        title: `Swap ${s.status === 'MANAGER_APPROVED' ? 'approved' : 'declined'}: ${name(s.requester)} → ${name(s.counterparty)}`,
        detail: s.shift.position,
        href: '/approvals?tab=swaps',
      })),
      ...[...buckets.values()]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 25)
        .map((b) => ({
          id: `published:${b.key}`,
          kind: 'published' as const,
          at: b.at.toISOString(),
          title: publishTitle(b),
          detail: publishSpan(b.firstDay, b.lastDay, weekStartsOn),
          // The week it covers, on that store's schedule.
          href: `/scheduling?view=week&week=${b.firstDay}${b.clientId ? `&client=${b.clientId}` : ''}${b.locationId ? `&location=${b.locationId}` : ''}`,
        })),
      ...incidents.map((i) => {
        const where = i.store?.name ?? i.location ?? i.client?.name ?? null;
        const what = INCIDENT_WORDS[i.severity] ?? 'Injury reported';
        return {
          id: `incident:${i.id}`,
          kind: 'incident' as const,
          at: i.reportedAt.toISOString(),
          title: where ? `${where} · ${what}` : what,
          detail: i.description.slice(0, 120) || null,
          href: '/compliance/osha',
        };
      }),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 30);
    res.json({ days, items });
  } catch (err) {
    next(err);
  }
});
