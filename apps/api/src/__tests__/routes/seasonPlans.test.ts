import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seasonWeeks } from '../../lib/seasonPlanner.js';
import { activeAssociateIds } from '../../lib/activeDefinition.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The Season Planner (Brief 1C-3 acceptance).
 *
 * Enter the 2027 summer numbers — Front Beach 95, Destin 95, Santa Rosa
 * Beach 80, Pier Park 75, Niceville–Miramar 55 on the floor a day — and
 * the planner reproduces the 400-a-day, roughly 620-associate, 450-bed
 * gap computed by hand. Then the rest of the brief: defaults from the
 * stores' staffing targets, plan versus actual, scenarios side by side,
 * the per-store PDF and the CSV.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const SEASON = { seasonStart: '2027-05-01', seasonEnd: '2027-09-30' };
const STORES: Array<[string, number, number, number, number]> = [
  // name, day, evening, overnight, beds available
  ['Front Beach', 40, 35, 20, 50],
  ['Destin', 40, 35, 20, 50],
  ['Santa Rosa Beach', 35, 30, 15, 30],
  ['Pier Park', 30, 30, 15, 24],
  ['Niceville–Miramar', 25, 20, 10, 15],
];

async function world() {
  const client = await createClient('Walmart');
  const first = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: first.id }, data: { name: STORES[0]![0] } });
  const locations = [first];
  for (const [name] of STORES.slice(1)) {
    locations.push(await prisma.site.create({ data: { clientId: client.id, name } }));
  }
  const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
  const { user: chair } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
  return { client, locations, wfm, chair };
}

const DAY = 86_400_000;

describe('the 2027 summer plan', () => {
  it('turns 400 a day into roughly 620 associates and a 450-bed gap', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.wfm.email);
    const weeks = seasonWeeks(SEASON.seasonStart, SEASON.seasonEnd);
    expect(weeks[0]).toBe('2027-05-01'); // a Saturday — the org week
    expect(weeks).toHaveLength(22);

    const created = await admin.post('/season-plans').send({
      name: 'Summer 2027 — original',
      clientId: w.client.id,
      ...SEASON,
      // Everyone housed: that is the hand calculation's assumption.
      channelMix: { LOCAL: 0, J1_NORTH: 50, J1_SOUTH: 25, H2B: 25 },
      sites: STORES.map(([, day, evening, overnight, beds], i) => ({
        locationId: w.locations[i]!.id,
        bedsAvailable: beds,
        vanSeatsPerRun: 14,
        runsPerShift: 2,
        routeMinutes: 45,
        demand: weeks.map((week) => ({ week, day, evening, overnight })),
      })),
    });
    expect(created.status).toBe(201);
    const plan = created.body;
    expect(plan.sites).toHaveLength(5);
    expect(plan.weeks).toHaveLength(22);

    // 400 on the floor a day across the five stores.
    expect(plan.peak.daily).toBe(400);
    // 95 a day → 665 slots → ÷5 → 133 → ×1.1 → 147, and so on: 619 in all.
    const fb = plan.sites.find((s: { siteName: string }) => s.siteName === 'Front Beach');
    expect(fb.peak.associatesNeeded).toBe(147);
    expect(fb.weeks[0]).toMatchObject({ daily: 95, shiftSlots: 665, associatesNeeded: 147, bedsNeeded: 147, bedsAvailable: 50, bedsGap: 97 });
    expect(plan.peak.associatesNeeded).toBe(619);
    // Every one of them needs a bed; 169 beds exist: 450 short.
    expect(plan.peak.bedsNeeded).toBe(619);
    expect(plan.peak.bedsAvailable).toBe(169);
    expect(plan.peak.bedsGap).toBe(450);
    // Van seats: the biggest shift at Front Beach is 40 riders; two runs of 14 carry 28.
    expect(fb.weeks[0]).toMatchObject({ vanSeatsNeeded: 40, vanSeatsAvailable: 28, vanSeatsGap: 12 });

    // Recruiting targets split the peak by channel and back off the start.
    const by = Object.fromEntries(plan.recruiting.map((r: { channel: string }) => [r.channel, r]));
    expect(by.J1_NORTH).toMatchObject({ sharePct: 50, target: 310, pipeline: 0, gap: 310, recruitBy: '2027-02-20' });
    expect(by.H2B).toMatchObject({ target: 155, recruitBy: '2026-12-12' });
    expect(by.LOCAL.target).toBe(0);

    // Every shortfall, named — beds at every store, seats where the runs fall short, people to recruit.
    const kinds = plan.gaps.map((g: { kind: string }) => g.kind);
    expect(kinds.filter((k: string) => k === 'BEDS')).toHaveLength(5);
    expect(kinds).toContain('VAN_SEATS');
    expect(kinds).toContain('RECRUITING');
    expect(kinds).toContain('HEADCOUNT');
    expect(plan.gaps[0].shortfall).toBeGreaterThanOrEqual(plan.gaps[1].shortfall);
    expect(plan.gaps.find((g: { kind: string; siteName: string }) => g.kind === 'BEDS' && g.siteName === 'Front Beach').text).toContain('97 short');
  });

  it('seeds demand from the stores’ staffing targets, and reads plan versus actual', async () => {
    const w = await world();
    const fb = w.locations[0]!;
    // Front Beach names its windows: Morning 40 at 06:00, Evening 35 at 14:00, Overnight 20 at 22:00.
    for (const [label, start, end, count] of [
      ['Morning', 6 * 60, 14 * 60, 40],
      ['Evening', 14 * 60, 22 * 60, 35],
      ['Overnight', 22 * 60, 6 * 60, 20],
    ] as const) {
      await prisma.staffingTarget.create({ data: { locationId: fb.id, label, startMinute: start, endMinute: end, targetCount: count, effectiveFrom: new Date('2026-01-01') } });
    }
    // Destin has only a floor total.
    await prisma.staffingTarget.create({ data: { locationId: w.locations[1]!.id, targetCount: 90, effectiveFrom: new Date('2026-01-01') } });
    await prisma.van.create({ data: { name: 'Van 1', capacity: 15 } });

    const admin = await loginAs(agent(), w.wfm.email);
    const defaults = await admin.get(`/season-plans/defaults?clientId=${w.client.id}&seasonStart=${SEASON.seasonStart}&seasonEnd=${SEASON.seasonEnd}`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.vans).toEqual({ count: 1, maxCapacity: 15 });
    const fbDefault = defaults.body.sites.find((s: { siteName: string }) => s.siteName === 'Front Beach');
    expect(fbDefault.demand[0]).toEqual({ week: '2027-05-01', day: 40, evening: 35, overnight: 20 });
    expect(fbDefault.vanSeatsPerRun).toBe(15);
    const destinDefault = defaults.body.sites.find((s: { siteName: string }) => s.siteName === 'Destin');
    expect(destinDefault.demand[0]).toEqual({ week: '2027-05-01', day: 90, evening: 0, overnight: 0 });

    // A plan for the season already under way: actuals fill in.
    const now = new Date();
    const thisWeekStart = seasonWeeks(now.toISOString().slice(0, 10), now.toISOString().slice(0, 10))[0]!;
    const assoc = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.associateAssignment.create({ data: { associateId: assoc.id, locationId: fb.id, startedAt: new Date('2026-01-01') } });
    await prisma.shift.create({
      data: {
        clientId: w.client.id,
        locationId: fb.id,
        position: 'Associate',
        startsAt: new Date(now.getTime() + 2 * DAY),
        endsAt: new Date(now.getTime() + 2 * DAY + 8 * 3_600_000),
        status: 'ASSIGNED',
        assignedAssociateId: assoc.id,
        publishedAt: now,
      },
    });
    expect((await activeAssociateIds({ locationId: fb.id }, now)).size).toBe(1);
    const live = await admin.post('/season-plans').send({
      name: 'This season',
      clientId: w.client.id,
      seasonStart: thisWeekStart,
      seasonEnd: new Date(now.getTime() + 20 * DAY).toISOString().slice(0, 10),
    });
    expect(live.status).toBe(201);
    const fbLive = live.body.sites.find((s: { siteName: string }) => s.siteName === 'Front Beach');
    const current = fbLive.weeks.find((x: { week: string }) => x.week === thisWeekStart);
    expect(current.activeHeadcount).toBe(1);
    const weekWithShift = fbLive.weeks.find((x: { scheduledHours: number | null }) => (x.scheduledHours ?? 0) > 0);
    expect(weekWithShift.scheduledHours).toBe(8);
  });

  it('saves scenarios, compares two side by side, and exports the store plan and the CSV', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.wfm.email);
    const weeks = seasonWeeks(SEASON.seasonStart, SEASON.seasonEnd);
    const original = await admin.post('/season-plans').send({
      name: 'original',
      clientId: w.client.id,
      ...SEASON,
      sites: [{ locationId: w.locations[0]!.id, bedsAvailable: 100, demand: weeks.map((week) => ({ week, day: 40, evening: 35, overnight: 20 })) }],
    });
    expect(original.status).toBe(201);
    const copy = await admin.post(`/season-plans/${original.body.id}/duplicate`).send({ name: 'Corso overnight-first' });
    expect(copy.status).toBe(201);
    expect(copy.body.name).toBe('Corso overnight-first');
    expect(copy.body.peak.associatesNeeded).toBe(original.body.peak.associatesNeeded);

    // The overnight-first idea: shift the load to the night, fewer people on days.
    const edited = await admin.patch(`/season-plans/${copy.body.id}`).send({
      reservePct: 5,
      sites: [{ locationId: w.locations[0]!.id, bedsAvailable: 100, runsPerShift: 3, demand: weeks.map((week) => ({ week, day: 25, evening: 30, overnight: 40 })) }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.reservePct).toBe(5);
    // 95 a day still, but with 5% reserve: 665 ÷ 5 × 1.05 = 140.
    expect(edited.body.peak.associatesNeeded).toBe(140);

    const cmp = await admin.get(`/season-plans/compare?a=${original.body.id}&b=${copy.body.id}`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.a.name).toBe('original');
    expect(cmp.body.b.name).toBe('Corso overnight-first');
    expect(cmp.body.a.peak.associatesNeeded).toBe(147);
    expect(cmp.body.b.peak.associatesNeeded).toBe(140);

    const list = await admin.get('/season-plans');
    expect(list.body.plans.map((p: { name: string }) => p.name).sort()).toEqual(['Corso overnight-first', 'original']);
    await admin.patch(`/season-plans/${copy.body.id}`).send({ archived: true });
    expect((await admin.get('/season-plans')).body.plans).toHaveLength(1);
    expect((await admin.get('/season-plans?archived=1')).body.plans).toHaveLength(2);

    const csv = await admin.get(`/season-plans/${original.body.id}/csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.split('\r\n');
    expect(lines[0]).toContain('Plan,Site,Client,Week,Day,Evening,Overnight');
    expect(lines).toHaveLength(1 + weeks.length);
    expect(lines[1]).toContain('original,Front Beach,Walmart,2027-05-01,40,35,20,95,665,147');

    const pdf = await admin
      .get(`/season-plans/${original.body.id}/sites/${w.locations[0]!.id}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await admin.get(`/season-plans/${original.body.id}/sites/${w.locations[1]!.id}/pdf`)).status).toBe(404);
  });

  it('is read for everyone who sees the org and written by those who manage it', async () => {
    const w = await world();
    const chair = await loginAs(agent(), w.chair.email);
    expect((await chair.get('/season-plans')).status).toBe(200);
    expect((await chair.post('/season-plans').send({ name: 'x', ...SEASON })).status).toBe(403);
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), assoc.email);
    expect((await a.get('/season-plans')).status).toBe(403);
    const admin = await loginAs(agent(), w.wfm.email);
    const bad = await admin.post('/season-plans').send({ name: 'Backwards', seasonStart: '2027-09-30', seasonEnd: '2027-05-01' });
    expect(bad.status).toBe(400);
  });
});
