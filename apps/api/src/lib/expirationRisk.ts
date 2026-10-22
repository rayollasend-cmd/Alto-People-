import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { scopeAssociates } from './scope.js';
import { shiftTimezone } from './shiftZone.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Expirations, as the floor feels them.
 *
 * A lapsing credential matters when it stops someone working a shift they
 * are already on. So every expiring qualification here carries the
 * person's store (their open assignment), their next scheduled shift, and —
 * the question the desk actually asks — the first upcoming shift the lapse
 * BLOCKS: a shift on or after the expiry date that requires this
 * qualification, either on the shift itself (ShiftQualificationRequirement)
 * or by the site/client's standing rule (CredentialRequirement, kind
 * QUALIFICATION). "At risk" is those, soonest shift first.
 *
 * Scope and shape:
 *   - tenant and caller's reach (scopeAssociates); former people excluded
 *   - a lower bound on old expiries (a year back) and the window ahead, so
 *     a pile of long-expired rows can never push the upcoming ones past
 *     the cap; the cap is reported (`truncated`)
 *   - a 13-week timeline by store, with the already-expired column
 */

const DAY = 86_400_000;
const CAP = 3000;
export const TIMELINE_WEEKS = 13;

export interface RiskShift {
  id: string;
  startsAt: string;
  storeId: string | null;
  storeName: string | null;
  position: string;
  /** The store's IANA zone: the shift is read on its clock. */
  timezone: string;
}

export interface RiskItem {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  qualificationId: string;
  qualificationCode: string;
  qualificationName: string;
  isCert: boolean;
  expiresAt: string;
  daysUntilExpiry: number;
  storeId: string | null;
  storeName: string | null;
  clientId: string | null;
  clientName: string | null;
  nextShift: RiskShift | null;
  /** The first upcoming shift this lapse blocks, and what requires it there. */
  blockingShift: (RiskShift & { requiredBy: 'shift' | 'site' | 'client' }) | null;
}

export interface TimelineRow {
  storeId: string | null;
  storeName: string;
  clientName: string | null;
  expired: number;
  perWeek: number[];
}

export interface ExpirationRisk {
  asOf: string;
  days: number;
  truncated: boolean;
  items: RiskItem[];
  /** Ids of items that block a scheduled shift, soonest shift first. */
  atRisk: string[];
  /** ISO dates: the start of each of the timeline's weeks. */
  weeks: string[];
  timeline: TimelineRow[];
  filters: {
    clients: Array<{ id: string; name: string }>;
    stores: Array<{ id: string; name: string; clientId: string | null }>;
    qualifications: Array<{ id: string; name: string }>;
  };
}

export interface RiskQuery {
  days: number;
  clientId?: string | null;
  storeId?: string | null;
  qualificationId?: string | null;
  isCert?: boolean;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function buildExpirationRisk(user: SessionUser, q: RiskQuery, now = new Date()): Promise<ExpirationRisk> {
  const tenantId = tenantIdForWrite();
  const horizon = new Date(now.getTime() + q.days * DAY);
  const floor = new Date(now.getTime() - 365 * DAY);

  // The person's place first: a store/client filter narrows people to those
  // on an open assignment there.
  const placeFilter: Prisma.AssociateWhereInput =
    q.storeId || q.clientId
      ? {
          assignments: {
            some: {
              endedAt: null,
              ...(q.storeId ? { locationId: q.storeId } : {}),
              ...(q.clientId ? { location: { is: { clientId: q.clientId } } } : {}),
            },
          },
        }
      : {};

  const rows = await prisma.associateQualification.findMany({
    where: {
      tenantId,
      deletedAt: null,
      expiresAt: { not: null, gte: floor, lte: horizon },
      ...(q.qualificationId ? { qualificationId: q.qualificationId } : {}),
      qualification: { deletedAt: null, ...(typeof q.isCert === 'boolean' ? { isCert: q.isCert } : {}) },
      associate: { AND: [{ tenantId, deletedAt: null, deactivatedAt: null }, scopeAssociates(user), placeFilter] },
    },
    orderBy: { expiresAt: 'asc' },
    take: CAP + 1,
    select: {
      id: true,
      expiresAt: true,
      associate: { select: { id: true, firstName: true, lastName: true, email: true } },
      qualification: { select: { id: true, code: true, name: true, isCert: true } },
    },
  });
  const truncated = rows.length > CAP;
  const kept = rows.slice(0, CAP);
  const associateIds = [...new Set(kept.map((r) => r.associate.id))];

  const [assignments, shifts] = associateIds.length
    ? await Promise.all([
        prisma.associateAssignment.findMany({
          where: { associateId: { in: associateIds }, endedAt: null },
          orderBy: { startedAt: 'desc' },
          select: {
            associateId: true,
            location: { select: { id: true, name: true, clientId: true, client: { select: { id: true, name: true } } } },
          },
        }),
        prisma.shift.findMany({
          where: {
            assignedAssociateId: { in: associateIds },
            status: { in: ['ASSIGNED', 'DRAFT'] },
            startsAt: { gte: now, lte: new Date(horizon.getTime() + 14 * DAY) },
          },
          orderBy: { startsAt: 'asc' },
          take: 20_000,
          select: {
            id: true,
            startsAt: true,
            position: true,
            assignedAssociateId: true,
            locationId: true,
            clientId: true,
            locationRel: { select: { name: true, timezone: true } },
            qualReqs: { select: { qualificationId: true } },
          },
        }),
      ])
    : [[], []];

  // Standing rules: a qualification a site or a client requires of everyone working there.
  const qualIds = [...new Set(kept.map((r) => r.qualification.id))];
  const rules = qualIds.length
    ? await prisma.credentialRequirement.findMany({
        where: { tenantId, deletedAt: null, kind: 'QUALIFICATION', qualificationId: { in: qualIds } },
        select: { qualificationId: true, locationId: true, clientId: true },
      })
    : [];
  const siteRule = new Set(rules.filter((r) => r.locationId).map((r) => `${r.qualificationId}@${r.locationId}`));
  const clientRule = new Set(rules.filter((r) => r.clientId && !r.locationId).map((r) => `${r.qualificationId}@${r.clientId}`));

  const placeOf = new Map<string, (typeof assignments)[number]['location']>();
  for (const a of assignments) if (!placeOf.has(a.associateId)) placeOf.set(a.associateId, a.location);
  const shiftsOf = new Map<string, typeof shifts>();
  for (const s of shifts) {
    const list = shiftsOf.get(s.assignedAssociateId!) ?? [];
    list.push(s);
    shiftsOf.set(s.assignedAssociateId!, list);
  }
  const shiftView = (s: (typeof shifts)[number]): RiskShift => ({
    id: s.id,
    startsAt: s.startsAt.toISOString(),
    storeId: s.locationId,
    storeName: s.locationRel?.name ?? null,
    position: s.position,
    timezone: shiftTimezone(s.locationRel),
  });

  const items: RiskItem[] = kept.map((r) => {
    const place = placeOf.get(r.associate.id) ?? null;
    const theirs = shiftsOf.get(r.associate.id) ?? [];
    const expires = r.expiresAt!;
    let blocking: RiskItem['blockingShift'] = null;
    for (const s of theirs) {
      // A shift that starts before the credential lapses isn't blocked by it.
      if (s.startsAt.getTime() < expires.getTime() + DAY) continue;
      const requiredBy = s.qualReqs.some((x) => x.qualificationId === r.qualification.id)
        ? ('shift' as const)
        : s.locationId && siteRule.has(`${r.qualification.id}@${s.locationId}`)
          ? ('site' as const)
          : s.clientId && clientRule.has(`${r.qualification.id}@${s.clientId}`)
            ? ('client' as const)
            : null;
      if (requiredBy) {
        blocking = { ...shiftView(s), requiredBy };
        break;
      }
    }
    return {
      id: r.id,
      associateId: r.associate.id,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      associateEmail: r.associate.email,
      qualificationId: r.qualification.id,
      qualificationCode: r.qualification.code,
      qualificationName: r.qualification.name,
      isCert: r.qualification.isCert,
      expiresAt: ymd(expires),
      daysUntilExpiry: Math.round((expires.getTime() - now.getTime()) / DAY),
      storeId: place?.id ?? null,
      storeName: place?.name ?? null,
      clientId: place?.client?.id ?? null,
      clientName: place?.client?.name ?? null,
      nextShift: theirs[0] ? shiftView(theirs[0]) : null,
      blockingShift: blocking,
    };
  });

  const atRisk = items
    .filter((i) => i.blockingShift)
    .sort((a, b) => a.blockingShift!.startsAt.localeCompare(b.blockingShift!.startsAt))
    .map((i) => i.id);

  // The timeline: weeks across (the org's workweek), stores down.
  const first = startOfWeekUTC(now);
  const weeks = Array.from({ length: TIMELINE_WEEKS }, (_, i) => new Date(first.getTime() + i * 7 * DAY));
  const rowsByStore = new Map<string, TimelineRow>();
  for (const i of items) {
    const key = i.storeId ?? 'none';
    const row = rowsByStore.get(key) ?? {
      storeId: i.storeId,
      storeName: i.storeName ?? 'Not placed',
      clientName: i.clientName,
      expired: 0,
      perWeek: Array(TIMELINE_WEEKS).fill(0) as number[],
    };
    const at = new Date(`${i.expiresAt}T12:00:00Z`).getTime();
    if (i.daysUntilExpiry < 0) row.expired += 1;
    else {
      const w = Math.floor((at - first.getTime()) / (7 * DAY));
      if (w >= 0 && w < TIMELINE_WEEKS) row.perWeek[w]! += 1;
    }
    rowsByStore.set(key, row);
  }
  const timeline = [...rowsByStore.values()].sort(
    (a, b) => (a.storeId ? 0 : 1) - (b.storeId ? 0 : 1) || (a.clientName ?? '').localeCompare(b.clientName ?? '') || a.storeName.localeCompare(b.storeName),
  );

  const clients = new Map<string, string>();
  const stores = new Map<string, { id: string; name: string; clientId: string | null }>();
  const quals = new Map<string, string>();
  for (const i of items) {
    if (i.clientId && i.clientName) clients.set(i.clientId, i.clientName);
    if (i.storeId && i.storeName) stores.set(i.storeId, { id: i.storeId, name: i.storeName, clientId: i.clientId });
    quals.set(i.qualificationId, i.qualificationName);
  }
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

  return {
    asOf: now.toISOString(),
    days: q.days,
    truncated,
    items,
    atRisk,
    weeks: weeks.map(ymd),
    timeline,
    filters: {
      clients: [...clients.entries()].map(([id, name]) => ({ id, name })).sort(byName),
      stores: [...stores.values()].sort(byName),
      qualifications: [...quals.entries()].map(([id, name]) => ({ id, name })).sort(byName),
    },
  };
}
