import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReliabilityWeekRow } from '@alto-people/shared';
import { computeReliability, consecutiveWeeksUnderBudget, recordApiBoot } from '../../lib/reliability.js';
import { emptyLatencyHistogram, latencyBucket } from '../../lib/usageTracker.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The four numbers the reliability page shows, from the rollups the API
 * already keeps. What matters: a REJECTED punch is the failure, a
 * cancelled ride is not, a seat nobody closed counts against completion,
 * and with no Sentry token the error budget is "unknown", never "zero".
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

// A Wednesday, mid-day UTC, so "today" is the same day in Florida.
const NOW = new Date('2026-07-08T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const utcDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

async function seedRoute(route: string, opts: { requests: number; ms: number; serverError?: number; daysAgo?: number }) {
  const histogram = emptyLatencyHistogram();
  histogram[latencyBucket(opts.ms)] = opts.requests;
  await prisma.routeUsageDaily.create({
    data: {
      day: utcDay(new Date(NOW.getTime() - (opts.daysAgo ?? 0) * DAY)),
      method: 'GET',
      route,
      ok: opts.requests - (opts.serverError ?? 0),
      serverError: opts.serverError ?? 0,
      totalMs: BigInt(opts.requests * opts.ms),
      histogram,
    },
  });
}

async function seedKiosk() {
  const client = await createClient();
  const location = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  const device = await prisma.kioskDevice.create({
    data: { clientId: client.id, locationId: location.id, name: 'Front door', tokenHash: 'x' },
  });
  return { client, location, device };
}

describe('computeReliability', () => {
  it('counts a rejected punch as the failure and a cancelled ride as nobody’s fault', async () => {
    const { device, location } = await seedKiosk();
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const at = new Date(NOW.getTime() - DAY);
    await prisma.kioskPunch.createMany({
      data: [
        { kioskDeviceId: device.id, associateId: associate.id, action: 'CLOCK_IN', createdAt: at },
        { kioskDeviceId: device.id, associateId: associate.id, action: 'CLOCK_OUT', createdAt: at },
        { kioskDeviceId: device.id, action: 'REJECTED', rejectReason: 'pin_not_recognized', createdAt: at },
        { kioskDeviceId: device.id, associateId: associate.id, action: 'BREAK_START', createdAt: at },
      ],
    });
    const ride = (status: 'COMPLETED' | 'NO_SHOW' | 'CANCELLED' | 'SCHEDULED', targetAt: Date) =>
      prisma.ride.create({
        data: {
          associateId: associate.id,
          direction: 'TO_WORK',
          locationId: location.id,
          address: '1 Main St',
          targetAt,
          serviceDate: targetAt.toISOString().slice(0, 10),
          status,
          fareCents: 0,
          noShowFeeCents: 0,
          createdById: hr.id,
        },
      });
    await ride('COMPLETED', at);
    await ride('COMPLETED', at);
    await ride('NO_SHOW', at);
    await ride('CANCELLED', at);
    // Past its pickup time and never closed: counts against completion.
    await ride('SCHEDULED', at);
    // Tomorrow's seat is not a result yet.
    await ride('SCHEDULED', new Date(NOW.getTime() + DAY));

    const r = await computeReliability(7, NOW);
    expect(r.kiosk).toMatchObject({ total: 4, accepted: 3, rejected: 1, rate: 0.75 });
    expect(r.kiosk.series).toHaveLength(7);
    expect(r.kiosk.series.find((p) => p.day === at.toISOString().slice(0, 10))).toEqual({
      day: at.toISOString().slice(0, 10),
      total: 4,
      accepted: 3,
    });
    expect(r.rides).toEqual({ total: 4, completed: 2, noShow: 1, unresolved: 1, rate: 0.5 });
  });

  it('ranks routes by traffic with a p95 from the histogram, and the slowest among the busy ones', async () => {
    await seedRoute('/time/me', { requests: 500, ms: 80 });
    await seedRoute('/rides/:id', { requests: 40, ms: 2_500, serverError: 2 });
    await seedRoute('/clients', { requests: 3, ms: 9_000 });
    // Outside the window: ignored.
    await seedRoute('/old', { requests: 900, ms: 20_000, daysAgo: 30 });
    // Written before the histogram existed: mean only, no p95.
    await prisma.routeUsageDaily.create({
      data: { day: utcDay(NOW), method: 'POST', route: '/legacy', ok: 100, totalMs: BigInt(100 * 50), histogram: [] },
    });

    const r = await computeReliability(7, NOW);
    expect(r.routes.busiest.map((x) => x.route)).toEqual(['/time/me', '/legacy', '/rides/:id', '/clients']);
    expect(r.routes.busiest[0]).toMatchObject({ requests: 500, avgMs: 80, p95Ms: 100 });
    expect(r.routes.busiest.find((x) => x.route === '/legacy')).toMatchObject({ avgMs: 50, p95Ms: null });
    // Three requests at nine seconds is noise, not the slowest route.
    expect(r.routes.slowest.map((x) => x.route)).toEqual(['/rides/:id', '/time/me']);
    expect(r.routes.slowest[0]).toMatchObject({ p95Ms: 3_000, serverError: 2 });
  });

  it('says the error budget is unknown without Sentry, and still counts 5xx and restarts', async () => {
    await seedRoute('/x', { requests: 10, ms: 10, serverError: 3 });
    await recordApiBoot('abc123');
    await recordApiBoot('abc123');
    await prisma.apiBoot.create({ data: { version: 'ancient', nodeVersion: 'v1', bootAt: new Date(NOW.getTime() - 60 * DAY) } });

    const r = await computeReliability(7, NOW);
    expect(r.budget).toBe(10);
    expect(r.sentry).toEqual({ configured: false, issues: [] });
    expect(r.errors.thisWeek).toBeNull();
    expect(r.errors.consecutiveWeeksUnderBudget).toBeNull();
    expect(r.errors.serverErrorsThisWeek).toBe(3);
    expect(r.errors.weeks).toHaveLength(8);
    // Oldest first; the last row is the week in progress and is never judged.
    const last = r.errors.weeks[r.errors.weeks.length - 1]!;
    expect(last.current).toBe(true);
    expect(last.underBudget).toBeNull();
    expect(new Date(last.weekStart).getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(new Date(last.weekEnd).getTime()).toBeGreaterThan(NOW.getTime());
    expect(r.errors.weeks.slice(0, -1).every((w) => !w.current)).toBe(true);
    // Weeks are consecutive org weeks: each ends where the next begins.
    for (let i = 1; i < r.errors.weeks.length; i++) {
      expect(r.errors.weeks[i]!.weekStart).toBe(r.errors.weeks[i - 1]!.weekEnd);
    }
    expect(r.restarts.count).toBe(2);
    expect(r.restarts.version).toBe('abc123');
  });

  it('fills a week Sentry no longer holds from the digest’s snapshot', async () => {
    const r0 = await computeReliability(7, NOW);
    const closed = r0.errors.weeks[r0.errors.weeks.length - 2]!;
    await prisma.reliabilityWeek.create({
      data: { weekStart: new Date(closed.weekStart), sentryErrors: 4, serverErrors: 1, requests: 10, underBudget: true },
    });
    const r = await computeReliability(7, NOW);
    const again = r.errors.weeks[r.errors.weeks.length - 2]!;
    expect(again.sentryErrors).toBe(4);
    expect(again.underBudget).toBe(true);
    // One known-good closed week, then the live weeks before it are unknown: the streak is one.
    expect(r.errors.consecutiveWeeksUnderBudget).toBe(1);
  });
});

describe('consecutiveWeeksUnderBudget', () => {
  const week = (sentryErrors: number | null, current = false): ReliabilityWeekRow => ({
    weekStart: 'a',
    weekEnd: 'b',
    sentryErrors,
    serverErrors: 0,
    requests: 0,
    underBudget: current || sentryErrors === null ? null : sentryErrors <= 10,
    current,
  });

  it('counts back from the most recent closed week and stops at the first miss', () => {
    expect(consecutiveWeeksUnderBudget([week(30), week(2), week(9), week(10), week(5, true)])).toBe(3);
    expect(consecutiveWeeksUnderBudget([week(2), week(11), week(1, true)])).toBe(0);
    // The week in progress never counts, even when it is under.
    expect(consecutiveWeeksUnderBudget([week(1), week(1, true)])).toBe(1);
  });

  it('is unknown when no closed week has a Sentry number', () => {
    expect(consecutiveWeeksUnderBudget([week(null), week(null), week(null, true)])).toBeNull();
    // An unknown week in the run breaks the streak rather than counting as under.
    expect(consecutiveWeeksUnderBudget([week(1), week(null), week(1), week(null, true)])).toBe(1);
  });
});
