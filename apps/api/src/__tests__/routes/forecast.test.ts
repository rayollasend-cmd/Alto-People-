import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { startOfWeekUTC } from '../../lib/timeAnomalies.js';
import { computeForecastRun, scoreForecastAccuracy } from '../../lib/forecast/run.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';

/**
 * Brief 3-4 — the forecast against the API: verified hours become a run,
 * the run reads back per site with its drivers, a client signal multiplies
 * its week on the next compute, the scoring writes accuracy rows once the
 * weeks have passed, and the planner starts from the forecast in one call.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Twenty completed weeks of approved entries at a site: `hoursPerWeek` hours each, in eight-hour punches. */
async function seedHours(locationId: string, associateId: string, hoursPerWeek: number, weeks = 20, now = new Date()) {
  const thisWeek = startOfWeekUTC(now);
  const rows: Array<{ associateId: string; locationId: string; clockInAt: Date; clockOutAt: Date; status: 'APPROVED' }> = [];
  for (let w = 1; w <= weeks; w++) {
    const weekStart = new Date(thisWeek.getTime() - w * 7 * DAY);
    const punches = Math.round(hoursPerWeek / 8);
    for (let p = 0; p < punches; p++) {
      const clockInAt = new Date(weekStart.getTime() + (p % 7) * DAY + 14 * HOUR);
      rows.push({ associateId, locationId, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 8 * HOUR), status: 'APPROVED' });
    }
  }
  await prisma.timeEntry.createMany({ data: rows });
}

async function world() {
  const client = await createClient('Coastal Resort Holdings');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { name: 'Front Beach 218', timezone: 'America/Chicago' } });
  const quiet = await prisma.site.create({ data: { clientId: client.id, name: 'Thomas Drive 412', timezone: 'America/Chicago' } });
  const assoc = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await seedHours(site.id, assoc.id, 160);
  const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
  return { client, site, quiet, assoc, wfm };
}

describe('the demand forecast', () => {
  it('computes a run from verified hours and reads it back per site with its drivers and band', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.wfm.email);

    const before = await admin.get('/forecast/sites');
    expect(before.status).toBe(200);
    expect(before.body.run).toBeNull();
    expect(before.body.sites.map((s: { siteName: string }) => s.siteName).sort()).toEqual(['Front Beach 218', 'Thomas Drive 412']);

    const run = await admin.post('/forecast/runs').send({});
    expect(run.status).toBe(201);
    expect(run.body.sites).toBe(2);
    expect(run.body.weeks).toBe(52); // 26 weeks × 2 sites
    // Twenty weeks of history: enough to score, not enough for a last year.
    expect(run.body.weights.scoredWeeks).toBeGreaterThan(0);

    const sites = await admin.get('/forecast/sites');
    expect(sites.body.run.horizonWeeks).toBe(26);
    const front = sites.body.sites.find((s: { siteName: string }) => s.siteName === 'Front Beach 218');
    expect(front.historyWeeks).toBe(20);
    // 160 hours a week for twenty weeks: the next four weeks say about 640.
    expect(front.next4WeeksHours).toBeGreaterThan(600);
    expect(front.next4WeeksHours).toBeLessThan(680);

    const detail = await admin.get(`/forecast/sites/${w.site.id}`);
    expect(detail.status).toBe(200);
    const past = detail.body.weeks.filter((x: { actualHours: number | null }) => x.actualHours !== null);
    const future = detail.body.weeks.filter((x: { actualHours: number | null }) => x.actualHours === null);
    expect(past.length).toBeGreaterThanOrEqual(20);
    expect(future).toHaveLength(26);
    expect(past[past.length - 1].actualHours).toBe(160);
    const first = future[0];
    expect(first.p10).toBeLessThanOrEqual(first.p50);
    expect(first.p50).toBeLessThanOrEqual(first.p90);
    expect(first.drivers.lastYearScaled).toBeNull();
    expect(first.drivers.recentMean).toBe(160);
    expect(first.drivers.leadWeeks).toBe(1);

    // A site with no hours forecasts zero, honestly, and still lists.
    const quiet = await admin.get(`/forecast/sites/${w.quiet.id}`);
    expect(quiet.body.weeks.filter((x: { actualHours: number | null }) => x.actualHours === null)[0].p50).toBe(0);
  });

  it('a client signal multiplies its week on the next compute and shows among the drivers', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.wfm.email);
    await admin.post('/forecast/runs').send({});
    const detail = await admin.get(`/forecast/sites/${w.site.id}`);
    const target = detail.body.weeks.filter((x: { actualHours: number | null }) => x.actualHours === null)[2];

    const put = await admin.put('/forecast/signals').send({ locationId: w.site.id, weekStart: target.weekStart, kind: 'EVENT', factor: 1.5, source: 'Spring Jam' });
    expect(put.status).toBe(200);
    // Upsert: the same site, week and kind replaces, never duplicates.
    const again = await admin.put('/forecast/signals').send({ locationId: w.site.id, weekStart: target.weekStart, kind: 'EVENT', factor: 1.25, source: 'Spring Jam' });
    expect(again.status).toBe(200);
    expect(await prisma.forecastSignal.count()).toBe(1);

    await admin.post('/forecast/runs').send({});
    const after = await admin.get(`/forecast/sites/${w.site.id}`);
    const week = after.body.weeks.find((x: { weekStart: string }) => x.weekStart === target.weekStart);
    expect(week.p50).toBeCloseTo(target.p50 * 1.25, 0);
    expect(week.drivers.signalFactor).toBe(1.25);
    expect(week.drivers.signals).toEqual([{ kind: 'EVENT', factor: 1.25, source: 'Spring Jam' }]);
    expect(after.body.signals).toHaveLength(1);

    const gone = await admin.delete(`/forecast/signals/${after.body.signals[0].id}`);
    expect(gone.status).toBe(204);
    expect(await prisma.forecastSignal.count()).toBe(0);
  });

  it('the monthly scoring compares what a run said with the hours that came', async () => {
    const w = await world();
    // A run made five weeks ago, as the monthly job would have.
    const fiveWeeksAgo = new Date(Date.now() - 35 * DAY);
    await runWithTenant(ALTO_TENANT_ID, 'job', () => computeForecastRun(prisma, { tenantId: ALTO_TENANT_ID, trigger: 'monthly', now: fiveWeeksAgo }));
    const scored = await runWithTenant(ALTO_TENANT_ID, 'job', () => scoreForecastAccuracy(prisma, { tenantId: ALTO_TENANT_ID }));
    // Four or five of its weeks have ended since; each is scored at its lead.
    expect(scored.scored).toBeGreaterThanOrEqual(4);
    const rows = await prisma.forecastAccuracy.findMany({ where: { locationId: w.site.id }, orderBy: { leadWeeks: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0]!.leadWeeks).toBe(1);
    expect(rows[0]!.actualHours).toBe(160);
    // A flat history forecasts flat: the error is small.
    for (const r of rows) expect(r.absPctError).toBeLessThan(15);

    const admin = await loginAs(agent(), w.wfm.email);
    const detail = await admin.get(`/forecast/sites/${w.site.id}`);
    expect(detail.body.accuracy.length).toBeGreaterThanOrEqual(4);
    const sites = await admin.get('/forecast/sites');
    const front = sites.body.sites.find((s: { siteName: string }) => s.siteName === 'Front Beach 218');
    expect(front.mapePct).not.toBeNull();
  });

  it('starts a season plan from the forecast in one call, people a day from hours a week', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.wfm.email);
    const noRun = await admin.post('/forecast/plan').send({ name: 'Too early', seasonStart: '2027-05-01', seasonEnd: '2027-06-26' });
    expect(noRun.status).toBe(409);

    await admin.post('/forecast/runs').send({});
    const detail = await admin.get(`/forecast/sites/${w.site.id}`);
    const future = detail.body.weeks.filter((x: { actualHours: number | null }) => x.actualHours === null);
    const seasonStart = future[0].weekStart;
    const seasonEnd = future[5].weekStart;
    const created = await admin.post('/forecast/plan').send({ name: 'From the forecast', clientId: w.client.id, seasonStart, seasonEnd, shiftHours: 8 });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('From the forecast');
    expect(created.body.notes).toContain('Demand from the forecast run');
    const front = created.body.sites.find((s: { locationId: string }) => s.locationId === w.site.id);
    expect(front).toBeTruthy();
    // 160 hours a week ÷ 7 days ÷ 8-hour shifts ≈ 3 people a day, all on the day shift (no window targets).
    expect(front.weeks[0].day).toBe(3);
    expect(front.weeks[0].evening).toBe(0);
    expect(front.weeks).toHaveLength(6);
  });

  it('is read by org viewers and written by org managers only', async () => {
    const w = await world();
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), assoc.email);
    expect((await a.get('/forecast/sites')).status).toBe(403);
    expect((await a.post('/forecast/runs').send({})).status).toBe(403);
    const { user: chair } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const c = await loginAs(agent(), chair.email);
    expect((await c.get('/forecast/sites')).status).toBe(200);
    expect((await c.post('/forecast/runs').send({})).status).toBe(403);
    const admin = await loginAs(agent(), w.wfm.email);
    expect((await admin.put('/forecast/signals').send({ locationId: w.site.id, weekStart: '2027-01-02', kind: 'OTHER', factor: 9 })).status).toBe(400);
  });
});
