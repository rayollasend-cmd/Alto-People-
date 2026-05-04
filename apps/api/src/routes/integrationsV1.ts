import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import {
  requireApiKey,
  requireApiKeyCapability,
  resolveStoreScope,
} from '../middleware/apiKeyAuth.js';
import { integrationsApiKeyLimiter } from '../middleware/rateLimit.js';

/**
 * Public integration API for AltoHR / ShiftReport Nexus (a.k.a. ASN) and
 * any future read-only consumer of Alto People's schedule + clock-in
 * data. Authenticates via `Authorization: Bearer altop_<hex>` (see
 * apiKeyAuth.ts) and gates each endpoint on a narrow capability:
 *
 *   asn:read:schedule    — list shifts for a store in a window
 *   asn:read:roster      — read the assigned associate(s) for a single shift
 *   asn:read:clocked-in  — see who is currently clocked in at a store
 *   asn:read:kpis        — week-summary counts (scheduled / clocked-in / etc.)
 *
 * Store scoping comes from the issuing ApiKey:
 *   - clientId = null  → "global" key (Command Desk / Operations Manager).
 *                        Sees every store; can list all stores.
 *   - clientId = <id>  → store-scoped (Supervisor / Lead Supervisor).
 *                        Reads of any other store return 404 (deliberate;
 *                        a 403 would leak that the storeId exists).
 *
 * The endpoints here are read-only by design. Writes (create shift,
 * approve clock-out, etc.) intentionally stay on the human-session API
 * so audit logs always carry a real user identity.
 */

export const integrationsV1Router = Router();

// All routes need a valid bearer + the rate limit. Capability checks are
// per-route since each endpoint requires a different one. We mount with
// an empty `capabilities` list at the router level and assert the
// specific capability on each handler via `requireApiKeyCapability`.
integrationsV1Router.use(
  requireApiKey({ capabilities: [] }),
  integrationsApiKeyLimiter,
);

// ---------------------------------------------------------------------------
// GET /integrations/v1/me
//
// Sanity check + scope echo. Lets the ASN side confirm what the key can
// see before it tries to render anything. Doesn't require any specific
// capability beyond the bearer being valid.
// ---------------------------------------------------------------------------

integrationsV1Router.get('/me', async (req, res) => {
  const apiKey = req.apiKey!;
  const store = apiKey.clientId
    ? await prisma.client.findUnique({
        where: { id: apiKey.clientId },
        select: { id: true, name: true, state: true },
      })
    : null;
  res.json({
    name: apiKey.name,
    capabilities: apiKey.capabilities,
    scope: apiKey.clientId
      ? { kind: 'store', store }
      : { kind: 'global' },
  });
});

// ---------------------------------------------------------------------------
// GET /integrations/v1/stores
//
// Global keys only. Lists every active store so an Ops Mgr / Command Desk
// dashboard can render a picker. Store-scoped keys get 403.
// ---------------------------------------------------------------------------

integrationsV1Router.get('/stores', async (req, res) => {
  if (req.apiKey!.clientId !== null) {
    res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'This endpoint requires a global API key.',
      },
    });
    return;
  }
  const stores = await prisma.client.findMany({
    where: { deletedAt: null, status: 'ACTIVE' },
    select: {
      id: true,
      name: true,
      state: true,
      latitude: true,
      longitude: true,
    },
    orderBy: { name: 'asc' },
    take: 1000,
  });
  res.json({
    stores: stores.map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      // Decimal → number for JSON; null means no geofence configured.
      latitude: s.latitude ? Number(s.latitude) : null,
      longitude: s.longitude ? Number(s.longitude) : null,
    })),
  });
});

// ---------------------------------------------------------------------------
// Shared store-scope guard. Use after `requireApiKeyCapability`.
// On scope mismatch, returns 404 (not 403) so a store-scoped key can't
// enumerate which storeIds exist.
// ---------------------------------------------------------------------------

function withStore(
  req: Parameters<Parameters<typeof integrationsV1Router.get>[1]>[0],
): { storeId: string } {
  const requested = String(req.params.storeId ?? '');
  const scoped = resolveStoreScope(req, requested);
  if (!scoped.ok) {
    throw new HttpError(404, 'not_found', 'Store not found.');
  }
  return { storeId: scoped.storeId };
}

// ---------------------------------------------------------------------------
// GET /integrations/v1/stores/:storeId/schedule?from=ISO&to=ISO
//
// List shifts in the window for the given store. Includes assigned
// associate's id + name + position; no PII beyond what a supervisor
// already sees on the shift roster screen. Defaults to the current
// Monday → next Monday window if from/to are missing.
// ---------------------------------------------------------------------------

const ScheduleQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Optional status filter — defaults to "anything not cancelled".
  status: z
    .enum(['DRAFT', 'OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED'])
    .optional(),
});

integrationsV1Router.get(
  '/stores/:storeId/schedule',
  requireApiKeyCapability('asn:read:schedule'),
  async (req, res) => {
    const { storeId } = withStore(req);
    const q = ScheduleQuerySchema.parse(req.query);
    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setHours(0, 0, 0, 0);
    // Roll back to Monday (Mon=1, Sun=0 in JS — adjust so Sunday goes 6 back).
    const dow = (defaultFrom.getDay() + 6) % 7;
    defaultFrom.setDate(defaultFrom.getDate() - dow);
    const defaultTo = new Date(defaultFrom);
    defaultTo.setDate(defaultTo.getDate() + 7);
    const from = q.from ? new Date(q.from) : defaultFrom;
    const to = q.to ? new Date(q.to) : defaultTo;

    const where: Prisma.ShiftWhereInput = {
      clientId: storeId,
      startsAt: { gte: from, lt: to },
      ...(q.status ? { status: q.status } : { status: { not: 'CANCELLED' } }),
    };

    const shifts = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: 500,
      select: {
        id: true,
        position: true,
        startsAt: true,
        endsAt: true,
        status: true,
        location: true,
        publishedAt: true,
        assignedAssociate: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    res.json({
      storeId,
      from: from.toISOString(),
      to: to.toISOString(),
      count: shifts.length,
      shifts: shifts.map((s) => ({
        id: s.id,
        position: s.position,
        location: s.location,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        status: s.status,
        publishedAt: s.publishedAt?.toISOString() ?? null,
        assignee: s.assignedAssociate
          ? {
              id: s.assignedAssociate.id,
              firstName: s.assignedAssociate.firstName,
              lastName: s.assignedAssociate.lastName,
            }
          : null,
      })),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /integrations/v1/stores/:storeId/shifts/:shiftId/roster
//
// Single shift detail — who's assigned and whether they're currently
// clocked in for this work block. Useful when a supervisor taps a shift
// in ASN and wants the live status.
// ---------------------------------------------------------------------------

integrationsV1Router.get(
  '/stores/:storeId/shifts/:shiftId/roster',
  requireApiKeyCapability('asn:read:roster'),
  async (req, res) => {
    const { storeId } = withStore(req);
    const shiftId = String(req.params.shiftId ?? '');
    const shift = await prisma.shift.findFirst({
      where: { id: shiftId, clientId: storeId },
      select: {
        id: true,
        position: true,
        startsAt: true,
        endsAt: true,
        status: true,
        location: true,
        assignedAssociateId: true,
        assignedAssociate: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    if (!shift) {
      throw new HttpError(404, 'not_found', 'Shift not found.');
    }

    // For the assigned associate, find any ACTIVE TimeEntry overlapping
    // the shift window so we can label their live status.
    let liveStatus:
      | { state: 'CLOCKED_IN'; clockInAt: string }
      | { state: 'CLOCKED_OUT' }
      | null = null;
    if (shift.assignedAssociateId) {
      const active = await prisma.timeEntry.findFirst({
        where: {
          associateId: shift.assignedAssociateId,
          clientId: storeId,
          status: 'ACTIVE',
          clockOutAt: null,
        },
        select: { clockInAt: true },
      });
      liveStatus = active
        ? { state: 'CLOCKED_IN', clockInAt: active.clockInAt.toISOString() }
        : { state: 'CLOCKED_OUT' };
    }

    res.json({
      storeId,
      shift: {
        id: shift.id,
        position: shift.position,
        location: shift.location,
        startsAt: shift.startsAt.toISOString(),
        endsAt: shift.endsAt.toISOString(),
        status: shift.status,
        assignee: shift.assignedAssociate
          ? {
              id: shift.assignedAssociate.id,
              firstName: shift.assignedAssociate.firstName,
              lastName: shift.assignedAssociate.lastName,
              live: liveStatus,
            }
          : null,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// GET /integrations/v1/stores/:storeId/clocked-in
//
// Live roster — every associate with an ACTIVE TimeEntry at this store.
// The denormalized TimeEntry.clientId (set at clock-in time) is what
// makes this an indexed query (see schema.prisma:954).
// ---------------------------------------------------------------------------

integrationsV1Router.get(
  '/stores/:storeId/clocked-in',
  requireApiKeyCapability('asn:read:clocked-in'),
  async (req, res) => {
    const { storeId } = withStore(req);
    const entries = await prisma.timeEntry.findMany({
      where: {
        clientId: storeId,
        status: 'ACTIVE',
        clockOutAt: null,
      },
      orderBy: { clockInAt: 'asc' },
      take: 500,
      select: {
        id: true,
        clockInAt: true,
        associate: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    res.json({
      storeId,
      count: entries.length,
      asOf: new Date().toISOString(),
      clockedIn: entries.map((e) => ({
        timeEntryId: e.id,
        clockInAt: e.clockInAt.toISOString(),
        associate: {
          id: e.associate.id,
          firstName: e.associate.firstName,
          lastName: e.associate.lastName,
        },
      })),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /integrations/v1/stores/:storeId/kpis?days=7
//
// Week-summary signal strip for an ASN store dashboard:
//   - scheduledShifts        — non-cancelled shifts in window
//   - assignedShifts         — shifts with an assignee (any status)
//   - openShifts             — OPEN status (unfilled, published)
//   - clockedInRightNow      — point-in-time count (live)
//   - distinctAssociatesScheduled — headcount for the window
// ---------------------------------------------------------------------------

const KpisQuerySchema = z.object({
  // 1..30 days. Default 7 (current Mon→next Mon).
  days: z.coerce.number().int().min(1).max(30).default(7),
});

integrationsV1Router.get(
  '/stores/:storeId/kpis',
  requireApiKeyCapability('asn:read:kpis'),
  async (req, res) => {
    const { storeId } = withStore(req);
    const { days } = KpisQuerySchema.parse(req.query);

    const now = new Date();
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    const dow = (from.getDay() + 6) % 7;
    from.setDate(from.getDate() - dow);
    const to = new Date(from);
    to.setDate(to.getDate() + days);

    const baseWhere: Prisma.ShiftWhereInput = {
      clientId: storeId,
      startsAt: { gte: from, lt: to },
    };

    const [grouped, distinctAssignees, clockedInNow] = await Promise.all([
      prisma.shift.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.shift.findMany({
        take: 100,
        where: { ...baseWhere, assignedAssociateId: { not: null } },
        select: { assignedAssociateId: true },
        distinct: ['assignedAssociateId'],
      }),
      prisma.timeEntry.count({
        where: {
          clientId: storeId,
          status: 'ACTIVE',
          clockOutAt: null,
        },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const scheduled =
      (counts.DRAFT ?? 0) +
      (counts.OPEN ?? 0) +
      (counts.ASSIGNED ?? 0) +
      (counts.COMPLETED ?? 0);
    const assigned = (counts.ASSIGNED ?? 0) + (counts.COMPLETED ?? 0);
    const open = counts.OPEN ?? 0;

    res.json({
      storeId,
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
        days,
      },
      kpis: {
        scheduledShifts: scheduled,
        assignedShifts: assigned,
        openShifts: open,
        cancelledShifts: counts.CANCELLED ?? 0,
        clockedInRightNow: clockedInNow,
        distinctAssociatesScheduled: distinctAssignees.length,
      },
    });
  },
);
