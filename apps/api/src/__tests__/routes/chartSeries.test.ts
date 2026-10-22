import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingNotifications } from '../../lib/notify.js';
import { env } from '../../config/env.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { prisma as appPrisma } from '../../db.js';
import { DEFAULT_TIMEZONE } from '../../lib/timezone.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * The series behind the charts: the vans' weeks (riders, on-time pickups,
 * no-shows, earned against cost), no-show fees waived together, each
 * client's NPS wave by wave, and the hours behind an OSHA injury rate.
 */

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const today = () => dateKeyInZone(new Date(), DEFAULT_TIMEZONE);
const daysBefore = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function transportSeed() {
  const client = await createClient('Coastal');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const { user: driver } = await createUser({ role: 'DRIVER' });
  const van = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 12 } });
  const people = await Promise.all(['Kim', 'Lee', 'Ana', 'Ben'].map((firstName) => createAssociate({ firstName, lastName: 'Rider' })));
  const ride = (associateId: string, serviceDate: string, data: Record<string, unknown>) =>
    prisma.ride.create({
      data: {
        associateId,
        direction: 'TO_WORK',
        locationId: site.id,
        targetAt: new Date(`${serviceDate}T14:00:00Z`),
        serviceDate,
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
        ...data,
      },
    });
  const hr = await loginAs(agent(), director.email);
  return { client, site, director, driver, van, people, ride, hr };
}

describe('the vans, week by week', () => {
  it('counts riders, on-time pickups, no-shows and earned against cost by week, this week last', async () => {
    const s = await transportSeed();
    const lastWeek = daysBefore(today(), 7);
    const pickup = new Date(`${lastWeek}T13:30:00Z`);
    // A finished run, two hours, and a fuel stop.
    const run = await prisma.rideRun.create({
      data: { vanId: s.van.id, driverUserId: s.driver.id, direction: 'TO_WORK', serviceDate: lastWeek, departAt: pickup, status: 'COMPLETED', startedAt: pickup, endedAt: new Date(pickup.getTime() + 2 * 3_600_000), createdById: s.director.id },
    });
    // Last week: two rode (one on time, one 12 minutes late), one no-show (fee waived).
    await s.ride(s.people[0]!.id, lastWeek, { runId: run.id, status: 'COMPLETED', chargeCents: 500, pickupAt: pickup, vanArrivedAt: new Date(pickup.getTime() + 2 * 60_000) });
    await s.ride(s.people[1]!.id, lastWeek, { runId: run.id, status: 'COMPLETED', chargeCents: 500, pickupAt: pickup, boardedAt: new Date(pickup.getTime() + 12 * 60_000) });
    await s.ride(s.people[2]!.id, lastWeek, { runId: run.id, status: 'NO_SHOW', chargeCents: 100, waivedAt: new Date(), waiveReason: 'Wrong stop' });
    // Cancelled rides don't count.
    await s.ride(s.people[3]!.id, lastWeek, { status: 'CANCELLED' });
    // A run a driver never ended: its rider is carried, but the fare isn't counted against zero cost.
    const open = await prisma.rideRun.create({
      data: { vanId: s.van.id, driverUserId: s.driver.id, direction: 'FROM_WORK', serviceDate: lastWeek, departAt: pickup, status: 'ACTIVE', startedAt: pickup, createdById: s.director.id },
    });
    await s.ride(s.people[3]!.id, lastWeek, { runId: open.id, status: 'BOARDED', chargeCents: 500, pickupAt: pickup, boardedAt: pickup });
    await prisma.vanServiceEntry.create({ data: { vanId: s.van.id, kind: 'FUEL', occurredAt: new Date(`${lastWeek}T00:00:00Z`), costCents: 4000 } });

    const res = await s.hr.get('/transport/trends?weeks=4');
    expect(res.status).toBe(200);
    expect(res.body.weeks).toHaveLength(4);
    const [prev, current] = res.body.weeks.slice(-2);
    expect(current.partial).toBe(true);
    expect(prev).toMatchObject({ partial: false, riders: 3, noShows: 1, revenueCents: 1000, noShowPct: 25 });
    // Two timed of the finished run plus the boarded one on time: 2 of 3.
    expect(prev.onTimePct).toBe(66.7);
    // Two hours at the default rate ($15) plus $40 of fuel.
    expect(prev.costCents).toBe(3000 + 4000);
  });

  it('needs view:transport', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/transport/trends')).status).toBe(403);
  });
});

describe('no-show fees, waived together', () => {
  it('waives every fee it can with one reason, and refuses a ride someone took', async () => {
    const s = await transportSeed();
    const d = today();
    const kim = await s.ride(s.people[0]!.id, d, { status: 'NO_SHOW', chargeCents: 100 });
    const lee = await s.ride(s.people[1]!.id, d, { status: 'NO_SHOW', chargeCents: 100 });
    const ana = await s.ride(s.people[2]!.id, d, { status: 'COMPLETED', chargeCents: 500 });
    const res = await s.hr.post('/transport/rides/waive').send({ rideIds: [kim.id, lee.id, ana.id], reason: 'The van came to the wrong stop' });
    expect(res.status).toBe(200);
    expect(res.body.waived).toBe(2);
    expect(res.body.skipped).toEqual([expect.objectContaining({ id: ana.id, code: 'ride_taken' })]);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: kim.id } })).waiveReason).toBe('The van came to the wrong stop');
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ana.id } })).waivedAt).toBeNull();
    await flushPendingNotifications();

    // Again: nothing left to waive.
    const again = await s.hr.post('/transport/rides/waive').send({ rideIds: [kim.id], reason: 'Twice' });
    expect(again.body).toMatchObject({ waived: 0, skipped: [{ id: kim.id, code: 'nothing_to_waive' }] });
  });

  it('waives once when two requests race — one waiver, one notice', async () => {
    const s = await transportSeed();
    const kim = await s.ride(s.people[0]!.id, today(), { status: 'NO_SHOW', chargeCents: 100 });
    const [a, b] = await Promise.all([
      s.hr.post('/transport/rides/waive').send({ rideIds: [kim.id], reason: 'Wrong stop' }),
      s.hr.post(`/transport/rides/${kim.id}/waive`).send({ reason: 'Wrong stop' }),
    ]);
    const waivedCount = (a.body.waived ?? 0) + (b.status === 200 ? 1 : 0);
    expect(waivedCount).toBe(1);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'transport.charge_waived', entityId: kim.id } })).toBe(1);
  });

  it('never waives a ride that was boarded after the fee was read (driver undid the no-show)', async () => {
    const s = await transportSeed();
    const kim = await s.ride(s.people[0]!.id, today(), { status: 'NO_SHOW', chargeCents: 100 });
    // Between the waive's read and its write, the driver undoes the no-show and boards Kim.
    const realFindMany = appPrisma.ride.findMany.bind(appPrisma.ride);
    const spy = vi.spyOn(appPrisma.ride, 'findMany').mockImplementationOnce((async (args: Parameters<typeof appPrisma.ride.findMany>[0]) => {
      const stale = await realFindMany(args);
      await prisma.ride.update({ where: { id: kim.id }, data: { status: 'BOARDED', boardedAt: new Date(), chargeCents: 500, noShowAt: null } });
      return stale;
    }) as unknown as typeof appPrisma.ride.findMany);
    const res = await s.hr.post('/transport/rides/waive').send({ rideIds: [kim.id], reason: 'Wrong stop' });
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ waived: 0, skipped: [{ id: kim.id, code: 'changed' }] });
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: kim.id } })).waivedAt).toBeNull();
  });

  it('only for someone who manages transport', async () => {
    const s = await transportSeed();
    const r = await s.ride(s.people[0]!.id, today(), { status: 'NO_SHOW', chargeCents: 100 });
    const { user } = await createUser({ role: 'DRIVER' });
    const a = await loginAs(agent(), user.email);
    expect((await a.post('/transport/rides/waive').send({ rideIds: [r.id], reason: 'Nope nope' })).status).toBe(403);
  });
});

describe('each client’s NPS, wave by wave', () => {
  it('returns every client in any wave with its score per quarter', async () => {
    const coastal = await createClient('Coastal');
    const harbor = await createClient('Harbor');
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const wave = (quarter: string, sentAt: Date) => prisma.clientNpsWave.create({ data: { quarter, sentAt, closesAt: new Date(sentAt.getTime() + 21 * 86_400_000) } });
    const q1 = await wave('2026-Q2', new Date('2026-04-02T00:00:00Z'));
    const q2 = await wave('2026-Q3', new Date('2026-07-02T00:00:00Z'));
    let n = 0;
    const invite = (waveId: string, clientId: string, score: number | null) =>
      prisma.clientNpsInvite.create({ data: { waveId, clientId, email: `m${n}@x.test`, tokenHash: `hash-${n++}`, expiresAt: new Date('2027-01-01'), score, respondedAt: score === null ? null : new Date() } });
    await invite(q1.id, coastal.id, 10);
    await invite(q1.id, harbor.id, 3);
    await invite(q2.id, coastal.id, 6);

    const a = await loginAs(agent(), exec.email);
    const res = await a.get('/executive/nps');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.clientTrends.map((c: { clientName: string; points: unknown[] }) => [c.clientName, c.points]));
    expect(byName.Coastal).toEqual([
      { quarter: '2026-Q2', nps: 100, responded: 1 },
      { quarter: '2026-Q3', nps: -100, responded: 1 },
    ]);
    // Harbor wasn't asked in Q3: its point is empty, not zero.
    expect(byName.Harbor).toEqual([
      { quarter: '2026-Q2', nps: -100, responded: 1 },
      { quarter: '2026-Q3', nps: null, responded: 0 },
    ]);
  });
});

describe('OSHA 300A — the hours behind the injury rate', () => {
  it('adds the year’s hours on the clock, TRIR and DART', async () => {
    const client = await createClient('Coastal');
    const other = await createClient('Elsewhere');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    // 2,000 hours at this client in 2025 (250 eight-hour days), and some elsewhere that don't count.
    const day = (i: number) => new Date(Date.UTC(2025, 0, 2 + i, 13));
    await prisma.timeEntry.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({ associateId: ana.id, clientId: client.id, clockInAt: day(i), clockOutAt: new Date(day(i).getTime() + 8 * 3_600_000), status: 'APPROVED' as const })),
    });
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: other.id, clockInAt: day(300), clockOutAt: new Date(day(300).getTime() + 8 * 3_600_000), status: 'APPROVED' } });
    // Four unpaid half-hour meals come off (2 hours); a paid rest break stays.
    const withBreaks = await prisma.timeEntry.findMany({ where: { clientId: client.id }, orderBy: { clockInAt: 'asc' }, take: 5 });
    for (const [i, e] of withBreaks.entries()) {
      const start = new Date(e.clockInAt.getTime() + 4 * 3_600_000);
      await prisma.breakEntry.create({ data: { timeEntryId: e.id, type: i < 4 ? 'MEAL' : 'REST', startedAt: start, endedAt: new Date(start.getTime() + (i < 4 ? 30 : 15) * 60_000) } });
    }
    await prisma.oshaIncident.create({ data: { clientId: client.id, occurredAt: new Date('2025-05-01T15:00:00Z'), description: 'Slipped', severity: 'DAYS_AWAY', daysAway: 3, isRecordable: true } });
    await prisma.oshaIncident.create({ data: { clientId: client.id, occurredAt: new Date('2025-06-01T15:00:00Z'), description: 'Cut', severity: 'MEDICAL_TREATMENT', isRecordable: true } });

    const a = await loginAs(agent(), hrUser.email);
    const res = await a.get(`/osha/300a?clientId=${client.id}&year=2025`);
    expect(res.status).toBe(200);
    // 2,000 on the clock less 2 hours of unpaid meals: 1,998. TRIR 2 × 200,000 / 1,998.
    expect(res.body).toMatchObject({ totalCases: 2, hoursWorked: 1998, trir: 200.2, dart: 100.1 });

    const none = await a.get(`/osha/300a?clientId=${client.id}&year=2024`);
    expect(none.body).toMatchObject({ hoursWorked: 0, trir: null, dart: null });
  });
});

describe('client margin, priced the way a statement prices it', () => {
  it('bills at the rate card, pays at the punch’s own rate, and says how much ran at standard rates', async () => {
    const coastal = await createClient('Coastal');
    const harbor = await createClient('Harbor');
    const coastalSite = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
    const harborSite = await prisma.site.findFirstOrThrow({ where: { clientId: harbor.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    // Coastal bills housekeepers at $30; Harbor has no card at all.
    await prisma.shiftRateDefault.create({ data: { clientId: coastal.id, position: 'Housekeeper', payRate: 16, billRate: 30, effectiveFrom: new Date('2020-01-01') } });
    const start = new Date(Date.now() - 9 * 86_400_000);
    start.setUTCHours(14, 0, 0, 0);
    const end = new Date(start.getTime() + 8 * 3_600_000);
    const coastalShift = await prisma.shift.create({ data: { clientId: coastal.id, locationId: coastalSite.id, position: 'Housekeeper', startsAt: start, endsAt: end, status: 'COMPLETED' } });
    const harborShift = await prisma.shift.create({ data: { clientId: harbor.id, locationId: harborSite.id, position: 'Housekeeper', startsAt: start, endsAt: end, status: 'COMPLETED' } });
    // Ana's punch carries her own $18; Ben's carries none.
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: coastal.id, locationId: coastalSite.id, shiftId: coastalShift.id, clockInAt: start, clockOutAt: end, status: 'APPROVED', payRate: 18 } });
    await prisma.timeEntry.create({ data: { associateId: ben.id, clientId: harbor.id, locationId: harborSite.id, shiftId: harborShift.id, clockInAt: start, clockOutAt: end, status: 'APPROVED' } });

    const a = await loginAs(agent(), user.email);
    const res = await a.get('/scheduling/store-trends');
    expect(res.status).toBe(200);
    const byClient = Object.fromEntries(res.body.stores.map((st: { clientName: string }) => [st.clientName, st]));
    const burden = 1 + env.LABOR_BURDEN_PERCENT / 100;
    const coastalWeek = byClient.Coastal.weeks.find((w: { hours: number }) => w.hours > 0);
    expect(coastalWeek.marginPerHour).toBeCloseTo(30 - 18 * burden - env.LABOR_OVERHEAD_PER_HOUR, 2);
    expect(byClient.Coastal.standardShare).toBe(0);
    // Harbor has no card: priced at the org standard, and it says so.
    const harborWeek = byClient.Harbor.weeks.find((w: { hours: number }) => w.hours > 0);
    expect(harborWeek.marginPerHour).toBeCloseTo(env.DEFAULT_ASSOCIATE_BILL_RATE - env.DEFAULT_ASSOCIATE_PAY_RATE * burden - env.LABOR_OVERHEAD_PER_HOUR, 2);
    expect(byClient.Harbor.standardShare).toBe(1);
  });
});

describe('headcount and hiring cohorts', () => {
  it('count people actually hired — never an onboarding invite who didn’t start', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hired = await createAssociate({ firstName: 'Hired', lastName: 'Person' });
    const hireDate = new Date(Date.now() - 60 * 86_400_000);
    await prisma.associate.update({ where: { id: hired.id }, data: { hireDate } });
    // An invite: an Associate row with a draft application, no hire date and
    // no work. (F500 SH-4: a record with no application at all is someone on
    // file — a driver's or an office hire's — and counts as on the books.)
    const invited = await createAssociate({ firstName: 'Invited', lastName: 'Never' });
    await prisma.application.create({ data: { associateId: invited.id, onboardingTrack: 'STANDARD', status: 'DRAFT' } });

    const a = await loginAs(agent(), user.email);
    const res = await a.get('/people-analytics?months=3');
    expect(res.status).toBe(200);
    const hires = res.body.headcount.reduce((n: number, m: { hires: number }) => n + m.hires, 0);
    expect(hires).toBe(1);
    expect(res.body.headcount[res.body.headcount.length - 1].headcount).toBe(1);
  });
});
