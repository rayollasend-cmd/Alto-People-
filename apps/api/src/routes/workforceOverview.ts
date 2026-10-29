import { Router } from 'express';
import { z } from 'zod';
import { can } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { cardOn, loadRateCards } from '../lib/rateCards.js';
import {
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
} from '../lib/timeAnomalies.js';
import { addDaysToKey } from '../lib/timezone.js';
import { soonestPayday } from '../lib/payday.js';
import { accountPhotoUrlFor } from '../lib/profilePhotoUrl.js';

/**
 * The Workforce Manager's field cockpit — one round trip behind the
 * WORKFORCE_MANAGER dashboard, shaped by the field-leadership charter:
 *
 *   - THE FLOOR NOW: clocked-in vs scheduled-now, org-wide.
 *   - PRE-SHIFT CHECK: people ON the clock with NO shift behind the punch
 *     ("unscheduled associates go home before clock-in") — named, so the
 *     call to the store can happen this minute.
 *   - TODAY'S GAPS: open shifts today by client — where coverage is thin.
 *   - TOMORROW: confirmed / awaiting / open headcount.
 *   - THE WEEK'S EXCEPTIONS ("silence means green"): unexcused no-shows,
 *     call-outs, lates this org week; incidents reported today.
 *   - DISPATCH: open shifts in the next 48h — the backfill workload.
 *
 * Gated on manage:scheduling — coverage is a scheduler-tier read.
 */

export const workforceOverviewRouter = Router();

const ORG_TZ = 'America/New_York';
const HOUR_MS = 3600_000;
// Client-bounded callers (SHIFT_SUPERVISOR holds manage:scheduling!) are
// clamped to their own client on EVERY query — fail closed when unset,
// same NO_CLIENT convention as lib/scope.ts.
const NO_CLIENT = '00000000-0000-0000-0000-000000000000';
function clientClampFor(user: { role: string; clientId: string | null }): {
  clientId?: string;
} {
  if (user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR') {
    return { clientId: user.clientId ?? NO_CLIENT };
  }
  return {};
}

workforceOverviewRouter.get(
  '/workforce/overview',
  requireCapability('manage:scheduling'),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const clamp = clientClampFor(user);
      const now = new Date();
      const todayKey = orgDateKey(now);
      const todayStart = utcInstantOfLocalMidnight(todayKey, ORG_TZ);
      const dayKeyPlus = addDaysToKey;
      const tomorrowStart = utcInstantOfLocalMidnight(dayKeyPlus(todayKey, 1), ORG_TZ);
      const dayAfterStart = utcInstantOfLocalMidnight(dayKeyPlus(todayKey, 2), ORG_TZ);
      const weekStart = startOfWeekUTC(now);

      const published = { publishedAt: { not: null } } as const;

      const [activeEntries, todayShifts, tomorrowShifts, weekEvents, incidentRows, openNext48h, todayEvents, upcomingOpen, pendingApprovals, payday, recentApproved] =
        await Promise.all([
          prisma.timeEntry.findMany({
            where: { status: 'ACTIVE', ...clamp },
            select: {
              clockInAt: true,
              shiftId: true,
              clientId: true,
              // The store the punch is at (its own, else its shift's) — the per-store board.
              locationId: true,
              shift: { select: { locationId: true } },
              associate: { select: { id: true, firstName: true, lastName: true } },
            },
            take: 1000,
          }),
          prisma.shift.findMany({
            where: {
              ...published,
              status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] },
              ...clamp,
              startsAt: { lt: tomorrowStart },
              endsAt: { gt: todayStart },
            },
            select: {
              id: true,
              status: true,
              startsAt: true,
              endsAt: true,
              position: true,
              payRate: true,
              client: { select: { id: true, name: true } },
              locationId: true,
              locationRel: { select: { name: true } },
            },
            take: 2000,
          }),
          prisma.shift.findMany({
            where: {
              ...published,
              status: { in: ['OPEN', 'ASSIGNED'] },
              ...clamp,
              startsAt: { gte: tomorrowStart, lt: dayAfterStart },
            },
            select: { status: true, acknowledgedAt: true, client: { select: { id: true } }, locationId: true },
            take: 2000,
          }),
          prisma.attendanceEvent.findMany({
            where: { occurredOn: { gte: weekStart }, excusedAt: null, ...clamp },
            select: { kind: true },
            take: 2000,
          }),
          prisma.oshaIncident.findMany({
            where: { occurredAt: { gte: todayStart }, ...clamp },
            orderBy: { occurredAt: 'desc' },
            take: 20,
            select: { occurredAt: true, clientId: true, severity: true, locationId: true },
          }),
          prisma.shift.count({
            where: {
              ...published,
              status: 'OPEN',
              ...clamp,
              startsAt: { gte: now, lt: new Date(now.getTime() + 48 * HOUR_MS) },
            },
          }),
          // Today's exception FEED — names, not just counts ("daily
          // exception post; silence means green").
          prisma.attendanceEvent.findMany({
            where: { occurredOn: { gte: todayStart }, excusedAt: null, ...clamp },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
              kind: true,
              clientId: true,
              shiftId: true,
              createdAt: true,
              associate: { select: { firstName: true, lastName: true } },
            },
          }),
          // The dispatch list itself — the next open shifts to backfill.
          prisma.shift.findMany({
            where: {
              ...published,
              status: 'OPEN',
              ...clamp,
              startsAt: { gte: now, lt: new Date(now.getTime() + 48 * HOUR_MS) },
            },
            orderBy: { startsAt: 'asc' },
            take: 5,
            select: {
              id: true,
              position: true,
              startsAt: true,
              client: { select: { name: true } },
              // One time zone per shift (role walk, ops 2): the card shows
              // the store's wall clock, never the reader's browser zone.
              locationRel: { select: { name: true, timezone: true } },
            },
          }),
          // SEAM: the money cycle. Completed-but-unapproved timesheets are
          // what Finance chases to close payroll — surface the number on
          // the field side so the chase mostly never has to happen.
          prisma.timeEntry.count({
            where: { status: 'COMPLETED', clockOutAt: { not: null }, ...clamp },
          }),
          soonestPayday(prisma, now),
          // SEAM: the people supply chain. HR approved them; the next move
          // (scheduling) is THIS desk's. Candidates resolve below.
          prisma.application.findMany({
            where: {
              status: 'APPROVED',
              approvedAt: { gte: new Date(now.getTime() - 60 * 24 * HOUR_MS) },
              deletedAt: null,
              ...clamp,
            },
            orderBy: { approvedAt: 'desc' },
            take: 100,
            select: {
              associateId: true,
              approvedAt: true,
              clientId: true,
              position: true,
              client: { select: { name: true } },
              location: { select: { name: true } },
              associate: {
                select: { id: true, firstName: true, lastName: true, deletedAt: true },
              },
            },
          }),
        ]);

      // Ready to schedule: approved in the last 60 days, and NOT holding a
      // single upcoming assigned shift — the baton is on the floor.
      const approvedIds = recentApproved
        .filter((a) => a.associate.deletedAt === null)
        .map((a) => a.associateId);
      const withUpcoming =
        approvedIds.length > 0
          ? await prisma.shift.findMany({
              where: {
                assignedAssociateId: { in: approvedIds },
                status: 'ASSIGNED',
                startsAt: { gte: now },
              },
              select: { assignedAssociateId: true },
              distinct: ['assignedAssociateId'],
            })
          : [];
      const scheduledIds = new Set(withUpcoming.map((s) => s.assignedAssociateId));
      const readyRows = recentApproved
        .filter(
          (a) => a.associate.deletedAt === null && !scheduledIds.has(a.associateId),
        )
        .map((a) => ({
          associateId: a.associateId,
          name: `${a.associate.firstName} ${a.associate.lastName}`.trim(),
          clientName: a.client?.name ?? null,
          approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
          clientId: a.clientId,
          position: a.position ?? null,
          storeName: a.location?.name ?? null,
        }));
      // The earliest open shift each shown row could fill (same client, and
      // the same position when the application names one), so the row is
      // actionable from home: "Stocker · Front Beach 218 · first open Sat 6 AM".
      const shownReady = readyRows.slice(0, 8);
      const readyClientIds = [...new Set(shownReady.map((r) => r.clientId).filter((id): id is string => !!id))];
      const openForReady =
        readyClientIds.length > 0
          ? await prisma.shift.findMany({
              where: { status: 'OPEN', clientId: { in: readyClientIds }, startsAt: { gte: now }, ...clamp },
              orderBy: { startsAt: 'asc' },
              take: 200,
              select: { id: true, clientId: true, position: true, startsAt: true, locationRel: { select: { name: true, timezone: true } } },
            })
          : [];
      const earliestOpenFor = (clientId: string | null, position: string | null) => {
        if (!clientId) return null;
        const want = position?.trim().toLowerCase() || null;
        const hit = openForReady.find((s) => s.clientId === clientId && (!want || s.position.trim().toLowerCase() === want));
        return hit
          ? { shiftId: hit.id, startsAt: hit.startsAt.toISOString(), position: hit.position, storeName: hit.locationRel?.name ?? null, timezone: hit.locationRel?.timezone ?? ORG_TZ }
          : null;
      };

      // THE INTERNAL LABOR MARKET: for each of the next 3 days, stores
      // that are short (open shifts) side by side with the bench — active
      // workers (worked in the last 30 days) holding NO shift that day.
      // The field trades labor like one organism instead of silos.
      // Skipped for client-bounded callers: the bench is org-wide data.
      let rebalance: Array<{
        dateKey: string;
        clientId: string;
        clientName: string;
        open: number;
        bench: number;
      }> = [];
      if (!('clientId' in clamp)) {
        const horizon = 3;
        const openAhead = await prisma.shift.findMany({
          where: {
            ...published,
            status: 'OPEN',
            startsAt: { gte: todayStart, lt: utcInstantOfLocalMidnight(dayKeyPlus(todayKey, horizon), ORG_TZ) },
          },
          select: { startsAt: true, client: { select: { id: true, name: true } } },
          take: 500,
        });
        if (openAhead.length > 0) {
          const recentWorkers = await prisma.timeEntry.findMany({
            where: {
              clockInAt: { gte: new Date(now.getTime() - 30 * 24 * HOUR_MS) },
              associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
            },
            select: { associateId: true },
            distinct: ['associateId'],
            take: 2000,
          });
          const activeIds = recentWorkers.map((w) => w.associateId);
          const busyAhead = await prisma.shift.findMany({
            where: {
              assignedAssociateId: { in: activeIds },
              status: 'ASSIGNED',
              startsAt: { gte: todayStart, lt: utcInstantOfLocalMidnight(dayKeyPlus(todayKey, horizon), ORG_TZ) },
            },
            select: { assignedAssociateId: true, startsAt: true },
            take: 2000,
          });
          const busyByDay = new Map<string, Set<string>>();
          for (const s of busyAhead) {
            const key = orgDateKey(s.startsAt);
            const set = busyByDay.get(key) ?? new Set<string>();
            if (s.assignedAssociateId) set.add(s.assignedAssociateId);
            busyByDay.set(key, set);
          }
          const needMap = new Map<
            string,
            { dateKey: string; clientId: string; clientName: string; open: number }
          >();
          for (const s of openAhead) {
            if (!s.client) continue;
            const dateKey = orgDateKey(s.startsAt);
            const k = `${dateKey}:${s.client.id}`;
            const row =
              needMap.get(k) ??
              ({ dateKey, clientId: s.client.id, clientName: s.client.name, open: 0 });
            row.open += 1;
            needMap.set(k, row);
          }
          rebalance = [...needMap.values()]
            .map((r) => ({
              ...r,
              bench: Math.max(
                0,
                activeIds.length - (busyByDay.get(r.dateKey)?.size ?? 0),
              ),
            }))
            .sort(
              (a, b) => a.dateKey.localeCompare(b.dateKey) || b.open - a.open,
            )
            .slice(0, 6);
        }
      }

      // Pre-shift check: on the clock with no shift behind the punch.
      const unscheduled = activeEntries.filter((e) => e.shiftId === null);
      const nameNeededIds = [
        ...new Set(
          [...unscheduled.map((e) => e.clientId), ...todayEvents.map((e) => e.clientId), ...incidentRows.map((i) => i.clientId)]
            .filter((c): c is string => !!c),
        ),
      ];
      const clientNames = new Map(
        (
          await prisma.client.findMany({
            where: { id: { in: nameNeededIds } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );

      const scheduledNow = todayShifts.filter(
        (s) =>
          s.status !== 'OPEN' &&
          s.startsAt.getTime() <= now.getTime() &&
          s.endsAt.getTime() > now.getTime(),
      ).length;

      // THE BOARD: every operationally-live store as a status tile —
      // now-state, today's holes, tomorrow's uncertainty, today's
      // exceptions and incidents — triage-sorted red → amber → green.
      interface StoreTile {
        clientId: string | null;
        clientName: string;
        onFloor: number;
        scheduledNow: number;
        /** Filled shifts on today's schedule (assigned or done), whenever they start. */
        scheduledToday: number;
        openToday: number;
        unconfirmedTomorrow: number;
        openTomorrow: number;
        /** Assigned shifts tomorrow the worker has confirmed (the ops home's per-store board). */
        confirmedTomorrow: number;
        /** Call-outs logged today (unexcused attendance events of kind CALL_OUT). */
        callOutsToday: number;
        exceptionsToday: number;
        noShowsToday: number;
        incidentsToday: number;
        unscheduledNow: number;
        /** Today's scheduled labor in dollars (shift hours × pay rate), org roles only; null when withheld. */
        laborToday: number | null;
        /** Shifts today with no resolvable pay rate — a $0 that means "rate missing". */
        laborUnpriced: number;
        /** Agent proposals waiting on a person, about this store's shifts. */
        proposalsPending: number;
        status: 'red' | 'amber' | 'green';
      }
      // Labor dollars (field roles, 2026-10): the Workforce Manager flew
      // blind on cost by charter; the charter changed. Priced like the
      // scheduling KPI strip — the shift's own rate, else the rate card in
      // force. Store-bound callers still get null.
      const showCost = !(user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR');
      const cards = showCost ? await loadRateCards(prisma, [...new Set(todayShifts.map((s) => s.client?.id ?? null))]) : [];
      const storeMap = new Map<string, StoreTile>();
      const storeBucket = (id: string | null, name: string | null) => {
        const key = id ?? 'none';
        const b =
          storeMap.get(key) ??
          ({
            clientId: id,
            clientName: name ?? '—',
            onFloor: 0,
            scheduledNow: 0,
            scheduledToday: 0,
            openToday: 0,
            unconfirmedTomorrow: 0,
            openTomorrow: 0,
            confirmedTomorrow: 0,
            callOutsToday: 0,
            exceptionsToday: 0,
            noShowsToday: 0,
            incidentsToday: 0,
            unscheduledNow: 0,
            laborToday: showCost ? 0 : null,
            laborUnpriced: 0,
            proposalsPending: 0,
            status: 'green',
          } as StoreTile);
        storeMap.set(key, b);
        return b;
      };
      const shiftClient = new Map<string, string | null>();
      for (const s of todayShifts) {
        const b = storeBucket(s.client?.id ?? null, s.client?.name ?? null);
        shiftClient.set(s.id, s.client?.id ?? null);
        if (s.status === 'OPEN') b.openToday += 1;
        else {
          b.scheduledToday += 1;
          if (s.startsAt.getTime() <= now.getTime() && s.endsAt.getTime() > now.getTime()) b.scheduledNow += 1;
        }
        if (showCost && b.laborToday !== null) {
          const rate = s.payRate !== null ? Number(s.payRate) : cardOn(cards, s.client?.id ?? null, s.position, s.startsAt)?.payRate ?? null;
          if (rate === null) b.laborUnpriced += 1;
          else b.laborToday += ((s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000) * rate;
        }
      }
      // The agents' proposals, grouped by store: each names the shift it is about.
      const pendingProposals = await prisma.agentProposal.findMany({
        where: { tenantId: tenantIdForWrite(), status: 'PROPOSED', subjectType: 'Shift', subjectId: { in: [...shiftClient.keys()] } },
        select: { subjectId: true },
        take: 500,
      });
      for (const p of pendingProposals) {
        const cid = p.subjectId ? shiftClient.get(p.subjectId) : undefined;
        if (cid === undefined) continue;
        const b = storeMap.get(cid ?? 'none');
        if (b) b.proposalsPending += 1;
      }
      for (const s of tomorrowShifts) {
        if (!s.client?.id) continue;
        if (!storeMap.has(s.client.id)) continue; // named below if needed
        const b = storeMap.get(s.client.id)!;
        if (s.status === 'OPEN') b.openTomorrow += 1;
        else if (s.acknowledgedAt === null) b.unconfirmedTomorrow += 1;
        else b.confirmedTomorrow += 1;
      }
      for (const e of todayEvents) {
        if (!e.clientId) continue;
        const b = storeMap.get(e.clientId);
        if (!b) continue;
        b.exceptionsToday += 1;
        if (e.kind === 'NO_CALL_NO_SHOW') b.noShowsToday += 1;
        if (e.kind === 'CALL_OUT') b.callOutsToday += 1;
      }
      for (const i of incidentRows) {
        const b = storeMap.get(i.clientId);
        if (b) b.incidentsToday += 1;
      }
      for (const e of activeEntries) {
        if (!e.clientId) continue;
        const existing = storeMap.get(e.clientId);
        if (existing) {
          existing.onFloor += 1;
          if (e.shiftId === null) existing.unscheduledNow += 1;
        }
      }
      // Punches at clients with no shifts today still deserve a tile.
      const missingIds = [
        ...new Set(
          activeEntries
            .map((e) => e.clientId)
            .filter((c): c is string => !!c && !storeMap.has(c)),
        ),
      ];
      if (missingIds.length > 0) {
        const named = await prisma.client.findMany({
          where: { id: { in: missingIds } },
          select: { id: true, name: true },
        });
        for (const c of named) storeBucket(c.id, c.name);
        for (const e of activeEntries) {
          if (e.clientId && missingIds.includes(e.clientId)) {
            const b = storeMap.get(e.clientId)!;
            b.onFloor += 1;
            if (e.shiftId === null) b.unscheduledNow += 1;
          }
        }
      }
      const rank = { red: 0, amber: 1, green: 2 } as const;
      const stores = [...storeMap.values()]
        .filter(
          (s) =>
            // A store with shifts later today is live today too (it used to
            // drop off the board until its first shift started).
            s.onFloor + s.scheduledNow + s.scheduledToday + s.openToday + s.unconfirmedTomorrow + s.openTomorrow > 0,
        )
        .map((s) => {
          if (s.laborToday !== null) s.laborToday = Math.round(s.laborToday * 100) / 100;
          s.status =
            s.noShowsToday > 0 ||
            s.incidentsToday > 0 ||
            s.unscheduledNow > 0 ||
            s.onFloor < s.scheduledNow
              ? 'red'
              : s.openToday > 0 || s.openTomorrow > 0 || s.unconfirmedTomorrow > 0
                ? 'amber'
                : 'green';
          return s;
        })
        .sort(
          (a, b) =>
            rank[a.status] - rank[b.status] ||
            b.openToday - a.openToday ||
            a.clientName.localeCompare(b.clientName),
        )
        .slice(0, 12);
      const needsAttention = stores.filter((s) => s.status !== 'green').length;

      // THE SAME BOARD, ONE ROW A STORE (LEAD-10). The tiles above are one per
      // CLIENT, and the ops home drew them under a "Store" header — "2 stores"
      // with four, Coastal's three rolled into one, so Front Beach being 0 of
      // 2 on the floor could not be seen. Same counts, keyed by location;
      // work with no store set stays under its client as "no store set".
      interface SiteTile {
        key: string;
        locationId: string | null;
        locationName: string | null;
        clientId: string | null;
        clientName: string;
        onFloor: number;
        scheduledNow: number;
        scheduledToday: number;
        openToday: number;
        callOutsToday: number;
        noShowsToday: number;
        incidentsToday: number;
        unscheduledNow: number;
        confirmedTomorrow: number;
        unconfirmedTomorrow: number;
        openTomorrow: number;
        status: 'red' | 'amber' | 'green';
      }
      const siteMap = new Map<string, SiteTile>();
      const siteNames = new Map<string, string>();
      for (const s of todayShifts) if (s.locationId && s.locationRel) siteNames.set(s.locationId, s.locationRel.name);
      const siteBucket = (clientId: string | null, locationId: string | null): SiteTile => {
        const key = `${clientId ?? 'none'}|${locationId ?? 'none'}`;
        let b = siteMap.get(key);
        if (!b) {
          b = {
            key,
            locationId,
            locationName: locationId ? (siteNames.get(locationId) ?? null) : null,
            clientId,
            clientName: (clientId ? storeMap.get(clientId)?.clientName ?? clientNames.get(clientId) : null) ?? '—',
            onFloor: 0,
            scheduledNow: 0,
            scheduledToday: 0,
            openToday: 0,
            callOutsToday: 0,
            noShowsToday: 0,
            incidentsToday: 0,
            unscheduledNow: 0,
            confirmedTomorrow: 0,
            unconfirmedTomorrow: 0,
            openTomorrow: 0,
            status: 'green',
          };
          siteMap.set(key, b);
        }
        return b;
      };
      const shiftSite = new Map<string, { clientId: string | null; locationId: string | null }>();
      for (const s of todayShifts) {
        const b = siteBucket(s.client?.id ?? null, s.locationId);
        shiftSite.set(s.id, { clientId: s.client?.id ?? null, locationId: s.locationId });
        if (s.status === 'OPEN') b.openToday += 1;
        else {
          b.scheduledToday += 1;
          if (s.startsAt.getTime() <= now.getTime() && s.endsAt.getTime() > now.getTime()) b.scheduledNow += 1;
        }
      }
      for (const s of tomorrowShifts) {
        if (!s.client?.id || !siteMap.has(`${s.client.id}|${s.locationId ?? 'none'}`)) continue;
        const b = siteBucket(s.client.id, s.locationId);
        if (s.status === 'OPEN') b.openTomorrow += 1;
        else if (s.acknowledgedAt === null) b.unconfirmedTomorrow += 1;
        else b.confirmedTomorrow += 1;
      }
      for (const e of todayEvents) {
        if (!e.clientId) continue;
        const at = e.shiftId ? shiftSite.get(e.shiftId) : undefined;
        const b = siteMap.get(`${e.clientId}|${at?.locationId ?? 'none'}`) ?? siteBucket(e.clientId, at?.locationId ?? null);
        if (e.kind === 'NO_CALL_NO_SHOW') b.noShowsToday += 1;
        if (e.kind === 'CALL_OUT') b.callOutsToday += 1;
      }
      for (const i of incidentRows) siteBucket(i.clientId, i.locationId).incidentsToday += 1;
      for (const e of activeEntries) {
        if (!e.clientId) continue;
        const b = siteBucket(e.clientId, e.locationId ?? e.shift?.locationId ?? null);
        b.onFloor += 1;
        if (e.shiftId === null) b.unscheduledNow += 1;
      }
      // Stores named by a punch or an incident only (no shift today).
      const unnamed = [...siteMap.values()].filter((s) => s.locationId && !s.locationName).map((s) => s.locationId!);
      if (unnamed.length > 0) {
        const named = await prisma.site.findMany({ where: { id: { in: unnamed } }, select: { id: true, name: true } });
        const byId = new Map(named.map((n) => [n.id, n.name]));
        for (const s of siteMap.values()) if (s.locationId && !s.locationName) s.locationName = byId.get(s.locationId) ?? null;
      }
      const sites = [...siteMap.values()]
        .filter((s) => s.onFloor + s.scheduledNow + s.scheduledToday + s.openToday + s.unconfirmedTomorrow + s.openTomorrow + s.noShowsToday + s.incidentsToday > 0)
        .map((s) => {
          s.status =
            s.noShowsToday > 0 || s.incidentsToday > 0 || s.unscheduledNow > 0 || s.onFloor < s.scheduledNow
              ? 'red'
              : s.openToday > 0 || s.openTomorrow > 0 || s.unconfirmedTomorrow > 0
                ? 'amber'
                : 'green';
          return s;
        })
        .sort(
          (a, b) =>
            rank[a.status] - rank[b.status] ||
            b.openToday - a.openToday ||
            a.clientName.localeCompare(b.clientName) ||
            (a.locationName ?? '').localeCompare(b.locationName ?? ''),
        );

      // THE WIRE: everything happening everywhere, newest first —
      // exceptions, incidents, and unscheduled punches, one stream.
      const wire = [
        ...todayEvents.slice(0, 8).map((e) => ({
          type: 'exception' as const,
          kind: e.kind as string,
          name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
          clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
          at: e.createdAt.toISOString(),
        })),
        ...incidentRows.slice(0, 6).map((i) => ({
          type: 'incident' as const,
          kind: i.severity as string,
          name: null as string | null,
          clientName: clientNames.get(i.clientId) ?? null,
          at: i.occurredAt.toISOString(),
        })),
        ...unscheduled.slice(0, 6).map((e) => ({
          type: 'unscheduled' as const,
          kind: null as string | null,
          name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
          clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
          at: e.clockInAt.toISOString(),
        })),
      ]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 12);

      const kindCount = (kind: string) =>
        weekEvents.filter((e) => e.kind === kind).length;

      const weekShiftAgg = await prisma.shift.groupBy({
        by: ['status'],
        where: {
          ...published,
          status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] },
          // A store-bound caller's week is their store's, like every other read here.
          ...clamp,
          startsAt: { gte: weekStart, lt: new Date(weekStart.getTime() + 7 * 24 * HOUR_MS) },
        },
        _count: true,
      });
      const weekOpen = weekShiftAgg.find((r) => r.status === 'OPEN')?._count ?? 0;
      const weekFilled = weekShiftAgg
        .filter((r) => r.status !== 'OPEN')
        .reduce((s, r) => s + r._count, 0);
      const weekTotal = weekOpen + weekFilled;

      res.json({
        generatedAt: now.toISOString(),
        now: {
          onFloor: activeEntries.length,
          scheduledNow,
          // Faces for the hero — who is actually out there right now.
          people: activeEntries.slice(0, 12).map((e) => ({
            associateId: e.associate.id,
            name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
          })),
          unscheduled: unscheduled.slice(0, 10).map((e) => ({
            associateId: e.associate.id,
            name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
            clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
            clockInAt: e.clockInAt.toISOString(),
          })),
          unscheduledCount: unscheduled.length,
        },
        today: {
          filled: todayShifts.filter((s) => s.status !== 'OPEN').length,
          open: todayShifts.filter((s) => s.status === 'OPEN').length,
          stores,
          /** One row per store (location), the ops home's "Stores today" board. */
          sites,
        },
        exceptionsToday: {
          count: todayEvents.length,
          feed: todayEvents.slice(0, 6).map((e) => ({
            kind: e.kind,
            name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
            clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
            at: e.createdAt.toISOString(),
          })),
        },
        tomorrow: {
          confirmed: tomorrowShifts.filter(
            (s) => s.status === 'ASSIGNED' && s.acknowledgedAt !== null,
          ).length,
          unconfirmed: tomorrowShifts.filter(
            (s) => s.status === 'ASSIGNED' && s.acknowledgedAt === null,
          ).length,
          open: tomorrowShifts.filter((s) => s.status === 'OPEN').length,
        },
        week: {
          start: orgDateKey(weekStart),
          fillRatePct: weekTotal > 0 ? Math.round((weekFilled / weekTotal) * 100) : null,
          // The counts behind the rate, so a tile can say "X of Y shifts filled".
          filled: weekFilled,
          total: weekTotal,
          noCallNoShows: kindCount('NO_CALL_NO_SHOW'),
          callOuts: kindCount('CALL_OUT'),
          lates: kindCount('LATE'),
        },
        incidentsToday: incidentRows.length,
        needsAttention,
        wire,
        close: {
          pendingApprovals,
          payday: payday ? { date: payday.date, schedule: payday.schedule } : null,
        },
        readyToSchedule: {
          count: readyRows.length,
          rows: readyRows.slice(0, 8).map(({ clientId, ...r }) => ({ ...r, earliestOpen: earliestOpenFor(clientId, r.position) })),
        },
        rebalance,
        dispatch: {
          openNext48h,
          upcoming: upcomingOpen.map((s) => ({
            shiftId: s.id,
            // A company's own shift has no client: name the store instead of "—".
            clientName: s.client?.name ?? s.locationRel?.name ?? '—',
            position: s.position,
            startsAt: s.startsAt.toISOString(),
            timezone: s.locationRel?.timezone ?? ORG_TZ,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The supervisor corps — the WFM's direct line. Every active shift and
 * floor supervisor account, with the contact facts that make the call
 * possible: name/phone/photo from the linked associate record (accounts
 * themselves carry only an email), grouped by store.
 */
workforceOverviewRouter.get(
  '/workforce/supervisors',
  requireCapability('manage:scheduling'),
  async (req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
          ...clientClampFor(req.user!),
        },
        select: {
          id: true,
          email: true,
          role: true,
          clientId: true,
          locationId: true,
          photoS3Key: true,
          photoUpdatedAt: true,
          associate: {
            select: { id: true, firstName: true, lastName: true, phone: true, photoS3Key: true, photoUpdatedAt: true },
          },
          supervisorShiftWindows: { select: { locationId: true, label: true } },
          lead: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
        },
        take: 200,
      });
      const clientIds = [
        ...new Set(users.map((u) => u.clientId).filter((c): c is string => !!c)),
      ];
      const clients = new Map(
        (
          await prisma.client.findMany({
            where: { id: { in: clientIds } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      const rows = users
        .map((u) => ({
          userId: u.id,
          role: u.role as 'SHIFT_SUPERVISOR' | 'FLOOR_SUPERVISOR',
          email: u.email,
          name: u.associate
            ? `${u.associate.firstName} ${u.associate.lastName}`.trim()
            : u.email.split('@')[0]!,
          phone: u.associate?.phone ?? null,
          associateId: u.associate?.id ?? null,
          // A supervisor is a staff login: their account photo when there's
          // no associate headshot.
          photoUrl: accountPhotoUrlFor(u),
          clientId: u.clientId,
          clientName: u.clientId ? clients.get(u.clientId) ?? null : null,
          locationId: u.locationId,
          windows: u.supervisorShiftWindows,
          lead: u.lead
            ? { userId: u.lead.id, name: u.lead.associate ? `${u.lead.associate.firstName} ${u.lead.associate.lastName}`.trim() : u.lead.email.split('@')[0]! }
            : null,
        }))
        .sort(
          (a, b) =>
            (a.clientName ?? 'zz').localeCompare(b.clientName ?? 'zz') ||
            a.role.localeCompare(b.role) ||
            a.name.localeCompare(b.name),
        );
      res.json({ supervisors: rows });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The supervisor corps (field roles, 2026-10): the Workforce Manager places
 * a supervisor at a client and store without opening Users & access. Only
 * the two supervisor roles, only the client and store — role, status and
 * everything else stay with HR (PATCH /admin/users/:id). A client change
 * drops the shift windows, which belong to the old client's stores.
 */
const PlaceInput = z.object({
  clientId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
});

workforceOverviewRouter.patch(
  '/workforce/supervisors/:userId',
  requireCapability('manage:org'),
  async (req, res, next) => {
    try {
      const actor = req.user!;
      if (!can(actor, 'manage:scheduling')) throw new HttpError(403, 'forbidden', 'The supervisor corps is placed by field leadership.');
      const id = z.string().uuid().parse(req.params.userId);
      const input = PlaceInput.parse(req.body ?? {});
      if (input.clientId === undefined && input.locationId === undefined) {
        throw new HttpError(400, 'nothing_to_change', 'Name the client or the store.');
      }
      const target = await prisma.user.findFirst({
        where: { id, deletedAt: null, tenantId: tenantIdForWrite() },
        select: { id: true, role: true, clientId: true, locationId: true },
      });
      if (!target) throw new HttpError(404, 'not_found', 'User not found.');
      if (target.role !== 'SHIFT_SUPERVISOR' && target.role !== 'FLOOR_SUPERVISOR') {
        throw new HttpError(400, 'not_a_supervisor', 'Only shift and floor supervisors are placed here.');
      }
      const clientId = input.clientId === undefined ? target.clientId : input.clientId;
      const locationId = input.locationId === undefined ? target.locationId : input.locationId;
      if (clientId) {
        const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true } });
        if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
      }
      if (locationId) {
        const site = await prisma.site.findFirst({ where: { id: locationId, deletedAt: null }, select: { clientId: true } });
        if (!site) throw new HttpError(404, 'site_not_found', 'Store not found.');
        if (site.clientId !== clientId) throw new HttpError(400, 'site_not_at_client', 'That store belongs to another client.');
      }
      const clientChanged = clientId !== target.clientId;
      await prisma.$transaction([
        prisma.user.update({ where: { id }, data: { clientId, locationId: clientChanged && input.locationId === undefined ? null : locationId } }),
        ...(clientChanged ? [prisma.supervisorShiftWindow.deleteMany({ where: { userId: id } })] : []),
      ]);
      invalidateUserCache(id);
      enqueueAudit(
        {
          actorUserId: actor.id,
          clientId: clientId ?? null,
          action: 'user.placed_by_field',
          entityType: 'User',
          entityId: id,
          metadata: { from: { clientId: target.clientId, locationId: target.locationId }, to: { clientId, locationId }, windowsDropped: clientChanged },
        },
        'workforce.place_supervisor',
      );
      res.json({ userId: id, clientId, locationId, windowsDropped: clientChanged });
    } catch (err) {
      next(err);
    }
  },
);
