import type { Prisma, PrismaClient } from '@prisma/client';
import { inShiftWindow, minuteOfDayInZone } from '@alto-people/shared';

/**
 * Supervisor shift windows — "their shift", the way a store is their client.
 *
 * A store names its shift windows as labeled StaffingTargets ("Overnight",
 * 22:00→06:00, 12 people); a supervisor is assigned (store, label) pairs.
 * The hours always come from the store's CURRENT target for that label.
 *
 * Focus, not a lock: nothing here narrows what a supervisor may see. It
 * decides their default view and who is paged first — the window's leads,
 * or every supervisor at the client when nobody leads it.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface StoreWindow {
  locationId: string;
  label: string;
  startMinute: number;
  endMinute: number;
  targetCount: number;
}

/** The current definition of every labeled window at these stores,
 *  keyed `${locationId}|${label}`. Effective-dating is per label: the
 *  newest row on or before today wins. */
export async function currentStoreWindows(
  db: Db,
  locationIds: string[],
  now: Date = new Date(),
): Promise<Map<string, StoreWindow>> {
  const out = new Map<string, StoreWindow>();
  if (locationIds.length === 0) return out;
  const rows = await db.staffingTarget.findMany({
    where: {
      locationId: { in: locationIds },
      label: { not: null },
      startMinute: { not: null },
      endMinute: { not: null },
      effectiveFrom: { lte: now },
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { locationId: true, label: true, startMinute: true, endMinute: true, targetCount: true },
  });
  for (const r of rows) {
    const key = `${r.locationId}|${r.label}`;
    if (out.has(key)) continue;
    out.set(key, {
      locationId: r.locationId,
      label: r.label!,
      startMinute: r.startMinute!,
      endMinute: r.endMinute!,
      targetCount: r.targetCount,
    });
  }
  return out;
}

export interface LedWindow extends StoreWindow {
  userId: string;
  userName: string;
  locationName: string;
  timezone: string;
}

/** Every window assignment of the active shift supervisors at a client (or
 *  of one user), resolved against the store's current definition. An
 *  assignment whose label the store no longer defines is dropped. */
export async function ledWindows(
  db: Db,
  where: { clientId: string } | { userId: string },
  now: Date = new Date(),
): Promise<LedWindow[]> {
  const rows = await db.supervisorShiftWindow.findMany({
    where:
      'userId' in where
        ? { userId: where.userId }
        : {
            user: {
              clientId: where.clientId,
              role: 'SHIFT_SUPERVISOR',
              status: 'ACTIVE',
              deletedAt: null,
            },
          },
    select: {
      userId: true,
      locationId: true,
      label: true,
      location: { select: { name: true, timezone: true } },
      user: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
  });
  const defs = await currentStoreWindows(
    db,
    [...new Set(rows.map((r) => r.locationId))],
    now,
  );
  const out: LedWindow[] = [];
  for (const r of rows) {
    const def = defs.get(`${r.locationId}|${r.label}`);
    if (!def) continue;
    out.push({
      ...def,
      userId: r.userId,
      userName: r.user.associate
        ? `${r.user.associate.firstName} ${r.user.associate.lastName}`
        : (r.user.email.split('@')[0] ?? r.user.email),
      locationName: r.location.name,
      timezone: r.location.timezone,
    });
  }
  return out.sort((a, b) => a.locationName.localeCompare(b.locationName) || a.startMinute - b.startMinute);
}

/** Does a shift (store + start) fall in this led window? Site-less shifts
 *  belong to the client, not a store — they never match a store window. */
export function windowCovers(
  w: Pick<LedWindow, 'locationId' | 'startMinute' | 'endMinute' | 'timezone'>,
  at: { locationId: string | null; startsAt: Date },
): boolean {
  if (!at.locationId || at.locationId !== w.locationId) return false;
  return inShiftWindow(minuteOfDayInZone(at.startsAt, w.timezone), w);
}

/**
 * Who hears about a shift-shaped event at a client: the supervisors who
 * lead the window the shift starts in — or, when nobody leads it (or there
 * is no shift to place), every active shift supervisor at the client, so
 * nothing ever goes unheard.
 */
export async function supervisorRecipients(
  db: Db,
  clientId: string,
  at?: { locationId: string | null; startsAt: Date } | null,
  opts: { excludeUserId?: string | null } = {},
): Promise<Array<{ id: string; email: string }>> {
  const everyone = await db.user.findMany({
    where: {
      role: 'SHIFT_SUPERVISOR',
      status: 'ACTIVE',
      deletedAt: null,
      clientId,
      ...(opts.excludeUserId ? { NOT: { id: opts.excludeUserId } } : {}),
    },
    select: { id: true, email: true },
  });
  if (!at || everyone.length === 0) return everyone;
  const leads = new Set(
    (await ledWindows(db, { clientId }))
      .filter((w) => windowCovers(w, at))
      .map((w) => w.userId),
  );
  const owners = everyone.filter((u) => leads.has(u.id));
  return owners.length > 0 ? owners : everyone;
}
