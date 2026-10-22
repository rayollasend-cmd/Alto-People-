import type { Prisma, PrismaClient, TimeEntryStatus } from '@prisma/client';
import { splitByPerson } from './laborRules/hours.js';
import { loadPayContext, type PayContext } from './laborRules/payContext.js';
import { companyWorkweek, endOfWeekInZone, startOfWeekForSite } from './timeAnomalies.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Each time entry's share of the labor-rules engine's split (audit
 * 2026-10-21 #11): the regular, overtime and double-time minutes it adds,
 * computed the way the paycheck computes them (lib/laborRules/hours via
 * payContext — live rules, punch rounding, the site's week). The time
 * views used to subtract 40 hours from a week's total on the client; a
 * California 10-hour day (live) read as straight time there while pay
 * split it, and a person's hours at another client never counted.
 *
 *   The split is over the person's WHOLE covering workweeks — every entry
 *   of theirs in those weeks, at any client or site, not just the page the
 *   caller is showing — so an entry's overtime is the same on every screen.
 *   Overtime is the latest hours worked (the engine fills chronologically).
 *
 *   By default COMPLETED (awaiting approval) and ACTIVE (on the clock now,
 *   counted to `now`, at most 16 h) entries count too: a reviewer and the
 *   associate see what the hours WILL split as once approved. Pass
 *   `statuses: ['APPROVED']` for exactly what payroll pays today.
 */

export interface EntryLaborShare {
  regularMinutes: number;
  overtimeMinutes: number;
  doubleTimeMinutes: number;
  /** The multipliers the person's overtime and double time pay at (1.5×, 2× unless a live rule says more). */
  overtimeMultiplier: number;
  doubleMultiplier: number;
}

type Db = PrismaClient | Prisma.TransactionClient;

const ACTIVE_CAP_MS = 16 * 3_600_000;
const toMin = (h: number) => Math.round(h * 60 * 100) / 100;

export async function laborSharesForEntries(
  db: Db,
  entries: ReadonlyArray<{ associateId: string; clockInAt: Date; location?: { timezone: string | null } | null }>,
  opts: { now?: Date; statuses?: TimeEntryStatus[]; pay?: PayContext } = {},
): Promise<Map<string, EntryLaborShare>> {
  const out = new Map<string, EntryLaborShare>();
  if (entries.length === 0) return out;
  const now = opts.now ?? new Date();
  const statuses = opts.statuses ?? ['APPROVED', 'COMPLETED', 'ACTIVE'];
  const companyTz = companyWorkweek().timezone;
  let from = Infinity;
  let to = -Infinity;
  for (const e of entries) {
    const tz = e.location?.timezone ?? companyTz;
    from = Math.min(from, startOfWeekForSite(e.clockInAt, tz).getTime());
    to = Math.max(to, endOfWeekInZone(e.clockInAt, tz).getTime());
  }
  const associateIds = [...new Set(entries.map((e) => e.associateId))];
  const [pay, rows] = await Promise.all([
    opts.pay ?? loadPayContext(db),
    db.timeEntry.findMany({
      where: {
        tenantId: tenantIdForWrite(),
        associateId: { in: associateIds },
        status: { in: statuses },
        // A day of slack either side: a site west of the company zone starts its week later.
        clockInAt: { gte: new Date(from - 86_400_000), lt: new Date(to + 86_400_000) },
      },
      select: {
        id: true,
        associateId: true,
        status: true,
        clockInAt: true,
        clockOutAt: true,
        locationId: true,
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
        location: { select: { id: true, state: true, city: true, timezone: true } },
      },
      take: 20_000,
    }),
  ]);
  const work = rows.map((raw) => {
    const r = pay.forPay(raw);
    const clockOutAt = r.clockOutAt ?? (r.status === 'ACTIVE' && now > r.clockInAt ? new Date(Math.min(now.getTime(), r.clockInAt.getTime() + ACTIVE_CAP_MS)) : null);
    return { id: r.id, associateId: r.associateId, clockInAt: r.clockInAt, clockOutAt, breaks: r.breaks, site: r.location };
  });
  const { byEntry, byPerson } = splitByPerson(pay.rules, work);
  for (const w of work) {
    const h = byEntry.get(w)!;
    const p = byPerson.get(w.associateId)!;
    out.set(w.id, {
      regularMinutes: toMin(h.regularHours),
      overtimeMinutes: toMin(h.overtimeHours),
      doubleTimeMinutes: toMin(h.doubleTimeHours),
      overtimeMultiplier: p.overtimeMultiplier,
      doubleMultiplier: p.doubleMultiplier,
    });
  }
  return out;
}
