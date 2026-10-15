import type { Prisma } from '@prisma/client';
import { netWorkedMinutes } from '../timeAnomalies.js';
import { DEFAULT_TIMEZONE } from '../timezone.js';

/**
 * Brief 2-4 — row → public shape, one copy for the /v1 responses and the
 * webhook payloads, so an event never carries more than the API would.
 * `pay` is the pay:read scope; webhooks never set it.
 */

const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const SHIFT_PUBLIC_INCLUDE = { client: { select: { name: true } }, locationRel: { select: { id: true, name: true, timezone: true } } } as const;
export type PublicShiftRow = Prisma.ShiftGetPayload<{ include: typeof SHIFT_PUBLIC_INCLUDE }>;

export function shiftPublic(s: PublicShiftRow, opts: { pay?: boolean } = {}) {
  return {
    id: s.id,
    siteId: s.locationId,
    position: s.position,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    timezone: s.locationRel?.timezone ?? DEFAULT_TIMEZONE,
    status: s.status,
    assignedWorkerId: s.workerId,
    publishedAt: isoOrNull(s.publishedAt),
    acknowledgedAt: isoOrNull(s.acknowledgedAt),
    ...(opts.pay ? { payRate: s.payRate !== null ? Number(s.payRate) : null } : {}),
  };
}

export const ENTRY_PUBLIC_INCLUDE = { breaks: { select: { type: true, startedAt: true, endedAt: true } }, associate: { select: { worker: { select: { id: true } } } } } as const;
export type PublicEntryRow = Prisma.TimeEntryGetPayload<{ include: typeof ENTRY_PUBLIC_INCLUDE }>;

export function entryPublic(e: PublicEntryRow, opts: { pay?: boolean } = {}) {
  return {
    id: e.id,
    workerId: e.associate.worker?.id ?? null,
    siteId: e.locationId,
    shiftId: e.shiftId,
    clockInAt: e.clockInAt.toISOString(),
    clockOutAt: isoOrNull(e.clockOutAt),
    status: e.status,
    netMinutes: e.clockOutAt ? Math.round(netWorkedMinutes(e, e.breaks)) : null,
    breaks: e.breaks.map((b) => ({ startedAt: b.startedAt.toISOString(), endedAt: isoOrNull(b.endedAt) })),
    approvedAt: isoOrNull(e.approvedAt),
    ...(opts.pay ? { payRate: e.payRate !== null ? Number(e.payRate) : null } : {}),
  };
}
