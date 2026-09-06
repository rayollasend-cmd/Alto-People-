import { Router } from 'express';
import { hasCapability, paidMinutesForRange } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import {
  orgDateKey,
  startOfWeekUTC,
  endOfWeekUTC,
  utcInstantOfLocalMidnight,
} from '../lib/timeAnomalies.js';

/**
 * The client portal — "the Walmart view." One round trip that answers a
 * store manager's morning questions: who is on my floor right now,
 * today's roster, this week's fill, tomorrow's confirmed headcount, my
 * statements and their payment status, and how coverage held up.
 *
 * ACCESS: CLIENT_PORTAL users see exactly their own client (fail closed
 * when no clientId is provisioned). view:executive / manage:org holders
 * may preview any client via ?clientId= — the pitch-demo path.
 *
 * PRIVACY INVARIANTS (tested):
 *   - No pay or bill rates anywhere in the payload — statements expose
 *     only their frozen invoice totals, never per-line rates.
 *   - DRAFT statements are invisible (a statement doesn't exist for the
 *     client until payroll finalizes it).
 *   - Unpublished (draft) shifts are invisible — same rule associates get.
 *   - Attendance incidents are COUNTS only, never names: the client sees
 *     coverage performance, not an associate's disciplinary trail.
 */

export const clientPortalRouter = Router();

const ORG_TZ = 'America/New_York';

function fullName(a: { firstName: string; lastName: string }): string {
  return `${a.firstName} ${a.lastName}`.trim();
}

clientPortalRouter.get(
  '/client-portal/overview',
  requireAuth,
  async (req, res, next) => {
    try {
      const user = req.user!;
      let clientId: string | null = null;
      if (user.role === 'CLIENT_PORTAL') {
        // Always clamped to their own client — a passed ?clientId is ignored.
        clientId = user.clientId ?? null;
        if (!clientId) {
          throw new HttpError(
            403,
            'no_client_assigned',
            'No client is linked to this portal account yet — ask your Alto contact.',
          );
        }
      } else if (
        hasCapability(user.role, 'view:executive') ||
        hasCapability(user.role, 'manage:org')
      ) {
        const requested = req.query.clientId;
        if (typeof requested !== 'string' || !requested) {
          throw new HttpError(400, 'client_required', 'Pass ?clientId= to preview a client portal.');
        }
        clientId = requested;
      } else {
        throw new HttpError(403, 'forbidden', 'The client portal is for client accounts.');
      }

      const client = await prisma.client.findFirst({
        where: { id: clientId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!client) {
        throw new HttpError(404, 'client_not_found', 'Client not found');
      }

      const now = new Date();
      const todayKey = orgDateKey(now);
      const todayStart = utcInstantOfLocalMidnight(todayKey, ORG_TZ);
      // Calendar-day arithmetic through the key, not +24h, so DST days
      // keep their local-midnight boundaries.
      const nextKey = (key: string, days: number) => {
        const [y, m, d] = key.split('-').map(Number);
        const at = new Date(Date.UTC(y!, m! - 1, d! + days));
        return at.toISOString().slice(0, 10);
      };
      const tomorrowStart = utcInstantOfLocalMidnight(nextKey(todayKey, 1), ORG_TZ);
      const dayAfterStart = utcInstantOfLocalMidnight(nextKey(todayKey, 2), ORG_TZ);
      const weekStart = startOfWeekUTC(now);
      const weekEnd = endOfWeekUTC(now);

      const publishedAtClient = {
        clientId,
        publishedAt: { not: null },
        status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] as ('OPEN' | 'ASSIGNED' | 'COMPLETED')[] },
      };

      const [onFloorEntries, todayShifts, weekShifts, tomorrowShifts, statements, weekEvents, coveredClaims] =
        await Promise.all([
          prisma.timeEntry.findMany({
            where: { clientId, status: 'ACTIVE' },
            select: {
              clockInAt: true,
              associateId: true,
              associate: { select: { id: true, firstName: true, lastName: true } },
              shift: { select: { position: true } },
            },
            orderBy: { clockInAt: 'asc' },
            take: 100,
          }),
          prisma.shift.findMany({
            where: {
              ...publishedAtClient,
              startsAt: { lt: tomorrowStart },
              endsAt: { gt: todayStart },
            },
            select: {
              id: true,
              position: true,
              startsAt: true,
              endsAt: true,
              status: true,
              acknowledgedAt: true,
              assignedAssociateId: true,
              assignedAssociate: {
                select: { firstName: true, lastName: true },
              },
              locationRel: { select: { name: true, timezone: true } },
            },
            orderBy: { startsAt: 'asc' },
            take: 200,
          }),
          prisma.shift.findMany({
            where: {
              ...publishedAtClient,
              startsAt: { gte: weekStart, lt: weekEnd },
            },
            select: { startsAt: true, endsAt: true, status: true },
            take: 1000,
          }),
          prisma.shift.findMany({
            where: {
              ...publishedAtClient,
              startsAt: { gte: tomorrowStart, lt: dayAfterStart },
            },
            select: { status: true, acknowledgedAt: true },
            take: 500,
          }),
          prisma.clientStatement.findMany({
            where: { clientId, status: 'FINAL' },
            orderBy: { periodEnd: 'desc' },
            take: 6,
            select: {
              id: true,
              number: true,
              periodStart: true,
              periodEnd: true,
              finalizedAt: true,
              paidAt: true,
              snapshot: true,
            },
          }),
          prisma.attendanceEvent.findMany({
            where: {
              clientId,
              occurredOn: { gte: weekStart },
              excusedAt: null,
            },
            select: { kind: true },
            take: 1000,
          }),
          prisma.openShiftClaim.count({
            where: {
              status: 'APPROVED',
              decidedAt: { gte: weekStart },
              shift: { clientId },
            },
          }),
        ]);

      const onFloorIds = new Set(onFloorEntries.map((e) => e.associateId));

      const roster = todayShifts.map((s) => {
        const done = s.status === 'COMPLETED' || s.endsAt.getTime() <= now.getTime();
        const onFloor =
          s.assignedAssociateId !== null && onFloorIds.has(s.assignedAssociateId);
        return {
          shiftId: s.id,
          associateId: s.assignedAssociateId,
          name: s.assignedAssociate ? fullName(s.assignedAssociate) : null,
          position: s.position,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          timezone: s.locationRel?.timezone ?? ORG_TZ,
          locationName: s.locationRel?.name ?? null,
          state: s.status === 'OPEN'
            ? ('open' as const)
            : onFloor
              ? ('on-floor' as const)
              : done
                ? ('done' as const)
                : s.acknowledgedAt
                  ? ('confirmed' as const)
                  : ('unconfirmed' as const),
        };
      });

      // Week shape, bucketed by ORG-local calendar day (Sat→Fri, the same
      // week every statement and OT figure uses).
      const dayKeys: string[] = [];
      for (let i = 0; i < 7; i++) {
        dayKeys.push(nextKey(orgDateKey(weekStart), i));
      }
      const dayMap = new Map(
        dayKeys.map((k) => [k, { date: k, filled: 0, open: 0 }]),
      );
      let weekMinutes = 0;
      let weekFilled = 0;
      let weekOpen = 0;
      for (const s of weekShifts) {
        const bucket = dayMap.get(orgDateKey(s.startsAt));
        if (!bucket) continue;
        if (s.status === 'OPEN') {
          bucket.open += 1;
          weekOpen += 1;
        } else {
          bucket.filled += 1;
          weekFilled += 1;
        }
        weekMinutes += paidMinutesForRange(s.startsAt, s.endsAt);
      }
      const weekTotal = weekFilled + weekOpen;

      const tomorrow = {
        confirmed: tomorrowShifts.filter(
          (s) => s.status === 'ASSIGNED' && s.acknowledgedAt !== null,
        ).length,
        unconfirmed: tomorrowShifts.filter(
          (s) => s.status === 'ASSIGNED' && s.acknowledgedAt === null,
        ).length,
        open: tomorrowShifts.filter((s) => s.status === 'OPEN').length,
      };

      const incidentCount = (kind: string) =>
        weekEvents.filter((e) => e.kind === kind).length;

      res.json({
        client: { id: client.id, name: client.name },
        generatedAt: now.toISOString(),
        now: {
          onFloor: onFloorEntries.map((e) => ({
            associateId: e.associate.id,
            name: fullName(e.associate),
            position: e.shift?.position ?? null,
            clockInAt: e.clockInAt.toISOString(),
          })),
          scheduledNow: todayShifts.filter(
            (s) =>
              s.status !== 'OPEN' &&
              s.startsAt.getTime() <= now.getTime() &&
              s.endsAt.getTime() > now.getTime(),
          ).length,
        },
        today: {
          date: todayKey,
          roster,
          filled: roster.filter((r) => r.state !== 'open').length,
          open: roster.filter((r) => r.state === 'open').length,
        },
        week: {
          start: orgDateKey(weekStart),
          end: nextKey(orgDateKey(weekStart), 6),
          days: dayKeys.map((k) => dayMap.get(k)!),
          filled: weekFilled,
          open: weekOpen,
          fillRatePct: weekTotal > 0 ? Math.round((weekFilled / weekTotal) * 100) : null,
          hours: Math.round((weekMinutes / 60) * 10) / 10,
        },
        tomorrow,
        statements: statements.map((st) => {
          const snap = st.snapshot as { totals?: { amount?: number; hours?: number } } | null;
          return {
            id: st.id,
            number: st.number,
            periodStart: st.periodStart.toISOString().slice(0, 10),
            periodEnd: st.periodEnd.toISOString().slice(0, 10),
            amount: snap?.totals?.amount ?? null,
            hours: snap?.totals?.hours ?? null,
            finalizedAt: st.finalizedAt ? st.finalizedAt.toISOString() : null,
            paidAt: st.paidAt ? st.paidAt.toISOString() : null,
          };
        }),
        coverage: {
          weekStart: orgDateKey(weekStart),
          noCallNoShows: incidentCount('NO_CALL_NO_SHOW'),
          callOuts: incidentCount('CALL_OUT'),
          lates: incidentCount('LATE'),
          replacementsFound: coveredClaims,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
