import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { signSession } from '../../lib/jwt.js';
import { loadRulePool } from '../../lib/laborRules/store.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { startOfWeekUTC } from '../../lib/timeAnomalies.js';
import { computeExecutiveSummary } from '../../lib/executiveSummary.js';
import { marginTrend } from '../../lib/financeCockpit.js';
import { runShiftReminderSweep } from '../../lib/shiftReminder.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * Audit 2026-10-21 #11 — the cost and scheduling screens split hours with
 * the labor-rules engine (lib/laborRules/hours), the split the paycheck
 * pays. Before, each counted "past 40 at 1.5×" on its own: a California
 * 10-hour day at a jurisdiction the tenant pays LIVE read as straight time
 * on the floor board, the OT radar, the Assign dialog, the labor-cost
 * report, the executive summary and the finance margin — while the check
 * paid two hours of overtime. And cross-client weeks put a week's overtime
 * on every store in proportion, not on the hours that ran past the line.
 */

const app = () => createApp();
const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function hrCookie(): Promise<string> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return `alto.session=${signSession({ sub: user.id, role: user.role, ver: user.tokenVersion })}`;
}

/** A California store (Pacific) whose jurisdiction the tenant pays LIVE: FEDERAL + US-CA rows signed. */
async function liveCaliforniaSite(name = 'Coastal') {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state: 'CA', city: 'San Diego', timezone: 'America/Los_Angeles' } });
  const pool = await loadRulePool(prisma, ALTO_TENANT_ID);
  await prisma.laborRuleActivation.create({
    data: {
      jurisdiction: 'US-CA',
      status: 'LIVE',
      signedSetIds: pool.filter((s) => s.jurisdiction === 'FEDERAL' || s.jurisdiction === 'US-CA').map((s) => s.id),
      counselName: 'Dana Whit',
      counselFirm: 'Whit & Co LLP',
      counselSignedOn: new Date('2026-10-01T00:00:00Z'),
      attestation: 'signed',
      activatedAt: new Date(),
    },
  });
  return { client, site };
}

/** Pacific wall clock on a date (daylight time, UTC-7). */
const pt = (ymd: string, h: number) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + (h + 7) * H);

describe('live California daily overtime on the cost screens', () => {
  it('the floor board prices a 9-hour punch as 8 straight + 1 overtime, and counts the head as in overtime now', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    await prisma.timeEntry.create({
      data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date(Date.now() - 9 * H), status: 'ACTIVE', payRate: 20 },
    });
    const res = await request(app()).get('/scheduling/floor-now').set('Cookie', [await hrCookie()]);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { locationId: string }) => r.locationId === site.id);
    expect(row.otHeads).toBe(1);
    expect(row.wagePerHour).toBe(30);
    expect(row.wageSoFar).toBeCloseTo(8 * 20 + 1 * 30, 1);
  });

  it('the OT radar names a 10-hour day under 40 hours, priced at the engine’s 1.5×', async () => {
    // "30 minutes from now" is next week's shift from 11:30 PM on a Friday,
    // which the radar (this week only) rightly ignores.
    pinMidweekNoon();
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    // 11 hours on the clock, 10 paid (the schedule's unpaid hour): 2 hours past California's 8.
    const startsAt = new Date(Date.now() + 30 * 60_000);
    await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt, endsAt: new Date(startsAt.getTime() + 11 * H), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() },
    });
    const res = await request(app()).get('/scheduling/ot-outlook').set('Cookie', [await hrCookie()]);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { associateId: string }) => r.associateId === ana.id);
    expect(row).toMatchObject({ projectedOtMinutes: 120 });
    expect(row.estOtBilled).toBeCloseTo(Math.round(2 * env.DEFAULT_ASSOCIATE_BILL_RATE * 1.5 * 10) / 10, 1);
  });

  it('the Assign dialog says a 10-paid-hour shift adds two hours of overtime and its premium, at 0 hours scheduled', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date(Date.now() - 60 * 86_400_000) } });
    const startsAt = new Date(Date.now() + 9 * 86_400_000);
    const target = await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt, endsAt: new Date(startsAt.getTime() + 11 * H), status: 'OPEN', publishedAt: new Date(), payRate: 20 },
    });
    const res = await request(app()).get(`/scheduling/shifts/${target.id}/auto-fill`).set('Cookie', [await hrCookie()]);
    expect(res.status).toBe(200);
    const row = res.body.candidates.find((c: { associateId: string }) => c.associateId === ana.id);
    expect(row).toMatchObject({ weeklyMinutesScheduled: 0, projectedWeeklyMinutes: 600, wouldBeOvertime: true, otMinutes: 120, otPremiumCents: 2000 });
  });

  it('the labor-cost report prices a worked 10-hour day as the paycheck pays it', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate();
    await prisma.timeEntry.create({
      data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: pt('2026-09-14', 6), clockOutAt: pt('2026-09-14', 16), status: 'COMPLETED', payRate: 20 },
    });
    const res = await request(app())
      .get('/scheduling/labor-costs')
      .query({ from: '2026-09-13T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' })
      .set('Cookie', [await hrCookie()]);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { locationId: string }) => r.locationId === site.id);
    expect(row).toMatchObject({ workedMinutes: 600, workedCost: 8 * 20 + 2 * 30 });
  });

  it('the publish preflight names a scheduled 10-hour day and its premium', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt: pt('2026-11-16', 7), endsAt: pt('2026-11-16', 18), status: 'DRAFT', assignedAssociateId: ana.id, payRate: 20 },
    });
    const res = await request(app())
      .get('/scheduling/publish-preflight')
      .query({ from: '2026-11-14T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' })
      .set('Cookie', [await hrCookie()]);
    expect(res.status).toBe(200);
    const ot = res.body.otProjected.find((o: { associateId: string }) => o.associateId === ana.id);
    // 10 paid hours at $20, plus half-time on the two past 8.
    expect(ot).toMatchObject({ hours: 10, projectedCostCents: 20_000 + 2_000 });
  });

  it('the OT radar sweep alerts on a 10-hour California day though the week is far under 40', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    await createUser({ role: 'HR_ADMINISTRATOR' });
    const now = pt('2026-09-15', 5);
    await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt: pt('2026-09-16', 6), endsAt: pt('2026-09-16', 17), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: now },
    });
    const sweep = await runShiftReminderSweep(prisma, now);
    expect(sweep.otAlerts).toBe(1);
    await flushPendingNotifications();
    const alert = await prisma.notification.findFirstOrThrow({ where: { category: 'ot_radar', channel: 'IN_APP' } });
    expect(alert.body).toContain('~2.0h of overtime');
  });

  it('the executive summary and the finance margin count a 10-hour day’s two overtime hours', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate();
    await prisma.compensationRecord.create({ data: { associateId: ana.id, payType: 'HOURLY', amount: 20, reason: 'HIRE', effectiveFrom: new Date('2026-01-01') } });
    await prisma.timeEntry.create({
      data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: pt('2026-09-07', 6), clockOutAt: pt('2026-09-07', 16), status: 'APPROVED', approvedAt: new Date() },
    });
    const now = new Date('2026-09-16T16:00:00.000Z');
    const s = await computeExecutiveSummary(prisma, now);
    expect(s.lastWeek).toMatchObject({ workedHours: 10, otHours: 2, premiumHours: 1 });
    expect(s.lastWeek.estBilled).toBeCloseTo((8 + 2 * 1.5) * env.DEFAULT_ASSOCIATE_BILL_RATE, 2);

    const m = await marginTrend(now, 8);
    const week = m.weeks.find((w) => w.weekStart === '2026-09-05')!;
    expect(week.wages).toBe(8 * 20 + 2 * 30);
  });

  it('attendance trends count the overtime hours the paycheck pays', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate();
    const lastWeek = startOfWeekUTC(new Date(startOfWeekUTC(new Date()).getTime() - 36 * H));
    const monday = new Date(lastWeek.getTime() + 2 * 86_400_000 + 16 * H); // Monday ~09:00 Pacific
    await prisma.timeEntry.create({
      data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: monday, clockOutAt: new Date(monday.getTime() + 10 * H), status: 'APPROVED', approvedAt: new Date() },
    });
    const res = await request(app()).get('/attendance/trends').query({ weeks: 4 }).set('Cookie', [await hrCookie()]);
    expect(res.status).toBe(200);
    const total = res.body.weeks.reduce((n: number, w: { overtimeHours: number }) => n + w.overtimeHours, 0);
    expect(total).toBe(2);
  });
});

describe('cross-client weeks put the overtime where the week ran past 40', () => {
  it('store trends: 30 hours at one client then 15 at another — the second store wears all five overtime hours', async () => {
    const a = await createClient('First Store');
    const b = await createClient('Second Store');
    const siteA = await prisma.site.findFirstOrThrow({ where: { clientId: a.id } });
    const siteB = await prisma.site.findFirstOrThrow({ where: { clientId: b.id } });
    for (const s of [siteA, siteB]) await prisma.site.update({ where: { id: s.id }, data: { timezone: 'America/New_York', state: 'FL' } });
    const ana = await createAssociate();
    const lastWeek = startOfWeekUTC(new Date(startOfWeekUTC(new Date()).getTime() - 36 * H));
    const day = (d: number, hours: number) => {
      const at = new Date(lastWeek.getTime() + d * 86_400_000 + 9 * H);
      return { clockInAt: at, clockOutAt: new Date(at.getTime() + hours * H) };
    };
    for (const d of [2, 3, 4]) await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.id, locationId: siteA.id, ...day(d, 10), status: 'APPROVED', payRate: 20 } });
    for (const [d, h] of [[5, 10], [6, 5]] as const) await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: b.id, locationId: siteB.id, ...day(d, h), status: 'APPROVED', payRate: 20 } });

    const res = await request(app()).get('/scheduling/store-trends').set('Cookie', [await hrCookie()]);
    expect(res.status).toBe(200);
    const bill = env.DEFAULT_ASSOCIATE_BILL_RATE;
    const burden = 1 + env.LABOR_BURDEN_PERCENT / 100;
    const oh = env.LABOR_OVERHEAD_PER_HOUR;
    const lastWeekOf = (locationId: string) => res.body.stores.find((s: { locationId: string }) => s.locationId === locationId).weeks.at(-1);
    // The first store's 30 hours are all straight time…
    expect(lastWeekOf(siteA.id)).toMatchObject({ hours: 30, marginPerHour: Math.round((bill - 20 * burden - oh) * 100) / 100 });
    // …the second's last 5 are the week's overtime (10 straight + 5 × 1.5).
    const billedB = (10 + 5 * 1.5) * bill;
    const costB = (10 + 5 * 1.5) * 20 * burden + 15 * oh;
    expect(lastWeekOf(siteB.id)).toMatchObject({ hours: 15, marginPerHour: Math.round(((billedB - costB) / 15) * 100) / 100 });
  });
});
