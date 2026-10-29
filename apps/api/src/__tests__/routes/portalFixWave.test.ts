import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';
import { readAll } from '../../lib/portalMetrics.js';
import { computeExecutiveDecisions } from '../../lib/executiveDecisions.js';

/**
 * The client's numbers, the deep audit of 2026-10-29 (builder PORTAL):
 *
 *   LEAD-2   a checklist the expiry sweep closed is "never submitted", not
 *            "submitted"; one store day per run (never also the day it closed)
 *   LEAD-3   an overnight fills the hours it covers on the day after it starts
 *   LEAD-4   the week's scheduled hours on the contract's basis (staffed, gross)
 *   LEAD-8   "late, not in yet" counts people, not stores
 *   LEAD-10  the ops home's board, one row a store
 *   LEAD-30  a prospect's age is its days in the stage
 *   CODE-19  the history reads every row (paged), never a silent cap
 *   the client's sign-off on a store week's hours — scope and totals
 *
 * Each pins the clock: a store in Chicago read at 11:30 PM Pacific is
 * already on tomorrow, and an overnight straddles two days.
 */

const app = () => createApp();
const H = 3_600_000;
const NY = 'America/New_York';
const CHI = 'America/Chicago';
const ALTO_TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

/** Pin `Date` to the most recent `weekday` (0 = Sunday) at hh:mm UTC — in the past. */
function pinAt(weekday: number, hour: number, minute = 0): Date {
  const real = new Date();
  const back = (real.getUTCDay() - weekday + 7) % 7;
  const d = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate() - back, hour, minute));
  if (d.getTime() > real.getTime()) d.setUTCDate(d.getUTCDate() - 7);
  vi.useFakeTimers({ toFake: ['Date'], now: d });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return d;
}

const keyIn = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 24 * H).toISOString().slice(0, 10);
/** A wall-clock time on a store day. */
const at = (dayKey: string, hour: number, tz = NY) => new Date(utcInstantOfLocalMidnight(dayKey, tz).getTime() + hour * H);
/** The Saturday that starts the store week containing `dayKey`. */
const saturdayOf = (dayKey: string) => {
  const dow = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  return addDays(dayKey, -((dow + 1) % 7));
};

async function storeWithManager(name = 'Front Beach 218', tz = NY) {
  const client = await createClient(name);
  const loc = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: loc.id }, data: { timezone: tz } });
  const { user: manager } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: loc.id, displayName: 'Lauren Whitfield' } });
  const lead = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: lead.id });
  return { client, loc: { ...loc, timezone: tz }, manager, sup };
}

function opsRun(opts: {
  clientId: string;
  locationId: string;
  openedById: string;
  dateKey: string;
  openedAt: Date;
  period?: 'MORNING' | 'OVERNIGHT';
  windowLabel?: string;
  dueAt?: Date;
  closed?: { at: Date; byId: string | null; incomplete?: boolean; reason?: string };
}) {
  return prisma.opsShift.create({
    data: {
      clientId: opts.clientId,
      locationId: opts.locationId,
      department: 'Grocery',
      departments: ['Grocery'],
      period: opts.period ?? 'MORNING',
      position: 'Grocery Shift',
      windowLabel: opts.windowLabel ?? 'Morning',
      dateKey: opts.dateKey,
      openedById: opts.openedById,
      openedAt: opts.openedAt,
      dueAt: opts.dueAt ?? null,
      status: opts.closed ? 'CLOSED' : 'ACTIVE',
      ...(opts.closed
        ? {
            closedAt: opts.closed.at,
            closedById: opts.closed.byId,
            closedIncomplete: opts.closed.incomplete ?? false,
            incompleteReason: opts.closed.reason ?? null,
            sopDone: 3,
            sopTotal: 10,
          }
        : {}),
    },
  });
}

/* ------------------------------------------------------------------ LEAD-2 */

describe('store operations: expired is not submitted, and a run has one day', () => {
  it('an SOP the expiry sweep closed reads "never submitted" on its own day, and never as the next day\'s checklist', async () => {
    const now = pinAt(4, 15); // Thursday 11 AM Eastern
    const s = await storeWithManager();
    const today = keyIn(now, NY);
    const yesterday = addDays(today, -1);
    // Yesterday's morning run, never submitted: the sweep closed it at 7 AM today.
    const expired = await opsRun({
      clientId: s.client.id,
      locationId: s.loc.id,
      openedById: s.sup.id,
      dateKey: yesterday,
      openedAt: at(yesterday, 7),
      dueAt: at(yesterday, 14),
      closed: { at: at(today, 2), byId: null, incomplete: true, reason: 'Expired — not submitted. Closed automatically 12 hours after the shift ended.' },
    });
    // Yesterday's evening run, submitted by the lead.
    await opsRun({
      clientId: s.client.id,
      locationId: s.loc.id,
      openedById: s.sup.id,
      dateKey: yesterday,
      openedAt: at(yesterday, 15),
      windowLabel: 'Evening',
      closed: { at: at(yesterday, 22), byId: s.sup.id },
    });
    const a = await loginAs(s.manager.email);

    const t = await a.get('/client-portal/ops');
    expect(t.status).toBe(200);
    expect(t.body.date).toBe(today);
    // Closed today, but it is not today's checklist.
    expect(t.body.runs.map((r: { id: string }) => r.id)).not.toContain(expired.id);
    expect(t.body.summary).toMatchObject({ sops: 0, submitted: 0 });

    const y = await a.get(`/client-portal/ops?date=${yesterday}`);
    expect(y.body.summary).toMatchObject({ sops: 2, submitted: 1, expired: 1 });
    const run = y.body.runs.find((r: { id: string }) => r.id === expired.id);
    expect(run).toMatchObject({ expired: true, day: yesterday, carried: false });
    const flag = y.body.attention.find((x: { shiftId: string }) => x.shiftId === expired.id);
    expect(flag).toMatchObject({ kind: 'NOT_SUBMITTED', severity: 'high' });
    expect(flag.title).toMatch(/^Never submitted — expired with 3 of 10 done$/);
    expect(y.body.attention.some((x: { kind: string; shiftId: string }) => x.kind === 'INCOMPLETE' && x.shiftId === expired.id)).toBe(false);

    // The store home counts it apart from a run submitted short.
    const home = await a.get('/client-portal/overview');
    expect(home.body.ops.yesterday).toMatchObject({ expired: 1, incomplete: 0 });
  });

  it('a Chicago store read at 11:30 PM Pacific opens on Chicago\'s day; a carried overnight is live but not counted', async () => {
    const now = pinAt(4, 6, 30); // Thursday 06:30 UTC: Wednesday night in Pacific, after midnight in Chicago
    const s = await storeWithManager('Lakeview 12', CHI);
    const storeDay = keyIn(now, CHI);
    expect(storeDay).not.toBe(keyIn(now, 'America/Los_Angeles'));
    const prev = addDays(storeDay, -1);
    // Last night's overnight, still on the floor (opened 10 PM, due 6 AM).
    const carried = await opsRun({
      clientId: s.client.id,
      locationId: s.loc.id,
      openedById: s.sup.id,
      dateKey: prev,
      period: 'OVERNIGHT',
      windowLabel: 'Overnight',
      openedAt: at(prev, 22, CHI),
      dueAt: at(storeDay, 6, CHI),
    });
    // A run opened by hand just after midnight in Chicago — this store day's.
    const mine = await opsRun({ clientId: s.client.id, locationId: s.loc.id, openedById: s.sup.id, dateKey: storeDay, windowLabel: 'Early', openedAt: new Date(now.getTime() - 15 * 60_000) });
    const a = await loginAs(s.manager.email);

    const r = await a.get('/client-portal/ops');
    expect(r.body).toMatchObject({ date: storeDay, storeToday: storeDay });
    expect(r.body.live.map((l: { id: string }) => l.id).sort()).toEqual([carried.id, mine.id].sort());
    expect(r.body.runs.find((x: { id: string }) => x.id === carried.id)).toMatchObject({ carried: true, day: prev });
    // Counted on its own night, not twice.
    expect(r.body.summary).toMatchObject({ sops: 1, running: 1 });
    const gridRuns = r.body.grid.flatMap((g: { cells: Array<{ runIds: string[] }> }) => g.cells.flatMap((c) => c.runIds));
    expect(gridRuns).toEqual([mine.id]);
    // The store home's "today" is the store's too.
    const home = await a.get('/client-portal/overview');
    expect(home.body.ops.todayKey).toBe(storeDay);
    expect(home.body.today.date).toBe(storeDay);
  });
});

/* -------------------------------------------------------------- LEAD-3, 4 */

describe('the store week in hours', () => {
  it('scheduled hours read on the contract\'s basis: staffed, gross; paid hours apart; open slots in neither', async () => {
    const now = pinAt(3, 16); // Wednesday noon Eastern
    const s = await storeWithManager();
    // Contract: one person, 6a–2p, every day — 56 hours a week.
    await prisma.staffingTarget.create({
      data: { locationId: s.loc.id, targetCount: 1, effectiveFrom: new Date('2020-01-01'), label: 'Morning', startMinute: 360, endMinute: 840 },
    });
    const sat = saturdayOf(keyIn(now, NY));
    const people = await Promise.all(Array.from({ length: 7 }, (_, i) => createAssociate({ firstName: `P${i}`, lastName: 'Crew' })));
    for (let i = 0; i < 7; i += 1) {
      const day = addDays(sat, i);
      await prisma.shift.create({
        data: { clientId: s.client.id, locationId: s.loc.id, position: 'Stocker', assignedAssociateId: people[i]!.id, startsAt: at(day, 6), endsAt: at(day, 14), status: 'ASSIGNED', publishedAt: at(sat, -48) },
      });
    }
    // An unfilled slot on top of the contract.
    await prisma.shift.create({
      data: { clientId: s.client.id, locationId: s.loc.id, position: 'Stocker', startsAt: at(addDays(sat, 5), 14), endsAt: at(addDays(sat, 5), 22), status: 'OPEN', publishedAt: at(sat, -48) },
    });
    const a = await loginAs(s.manager.email);
    const res = await a.get('/client-portal/overview');
    expect(res.status).toBe(200);
    // A fully staffed store reads 56 of 56 — not 49 (breaks out) of 56, nor counting the open slot.
    expect(res.body.week).toMatchObject({ hours: 56, contractedHours: 56, paidHours: 49 });
    // The Schedule page's own sum is the same figure.
    const sch = await a.get('/client-portal/schedule');
    const staffed = (sch.body.days as Array<{ shifts: Array<{ state: string; startsAt: string; endsAt: string }> }>)
      .flatMap((d) => d.shifts)
      .filter((x) => x.state !== 'open')
      .reduce((n, x) => n + (Date.parse(x.endsAt) - Date.parse(x.startsAt)) / H, 0);
    expect(staffed).toBe(res.body.week.hours);
  });

  it('an overnight is counted in the hours it covers on the next day, and only in the day it starts', async () => {
    const now = pinAt(3, 16);
    const s = await storeWithManager();
    const today = keyIn(now, NY);
    const sat = saturdayOf(today);
    const [x, y] = await Promise.all([createAssociate({ firstName: 'Night', lastName: 'One' }), createAssociate({ firstName: 'Night', lastName: 'Two' })]);
    // Last week's Friday overnight runs into this week's Saturday morning.
    const carry = await prisma.shift.create({
      data: { clientId: s.client.id, locationId: s.loc.id, position: 'Stocker', assignedAssociateId: x.id, startsAt: at(addDays(sat, -1), 22), endsAt: at(sat, 6), status: 'ASSIGNED', publishedAt: at(sat, -72) },
    });
    // Last night's overnight, into this morning.
    await prisma.shift.create({
      data: { clientId: s.client.id, locationId: s.loc.id, position: 'Stocker', assignedAssociateId: y.id, startsAt: at(addDays(today, -1), 22), endsAt: at(today, 6), status: 'ASSIGNED', publishedAt: at(sat, -72) },
    });
    // Today's own shift.
    await prisma.shift.create({
      data: { clientId: s.client.id, locationId: s.loc.id, position: 'Stocker', assignedAssociateId: x.id, startsAt: at(today, 14), endsAt: at(today, 22), status: 'ASSIGNED', publishedAt: at(sat, -72) },
    });
    const a = await loginAs(s.manager.email);

    const sch = await a.get('/client-portal/schedule');
    expect(sch.body.carryIn).toEqual([expect.objectContaining({ startsAt: carry.startsAt.toISOString(), endsAt: carry.endsAt.toISOString(), state: 'done' })]);

    const home = await a.get('/client-portal/overview');
    // The roster shows last night's crew finishing; "today's shifts" are the ones that start today, as Schedule counts them.
    expect(home.body.today.roster).toHaveLength(2);
    expect(home.body.today).toMatchObject({ filled: 1, open: 0 });
  });
});

/* ------------------------------------------------------------------ LEAD-8 */

describe('the region: late and not in yet', () => {
  it('counts PEOPLE late and not in, apart from how many stores have an alert', async () => {
    pinAt(3, 16);
    const client = await createClient('Front Beach 218');
    const [store] = await prisma.site.findMany({ where: { clientId: client.id } });
    const region = await prisma.region.create({ data: { name: 'Florida Panhandle' } });
    await prisma.site.update({ where: { id: store!.id }, data: { regionId: region.id } });
    const now = new Date();
    for (const name of ['Ann', 'Bo']) {
      const p = await createAssociate({ firstName: name, lastName: 'Late' });
      await prisma.shift.create({
        data: { clientId: client.id, locationId: store!.id, position: 'Stocker', assignedAssociateId: p.id, startsAt: new Date(now.getTime() - H), endsAt: new Date(now.getTime() + 7 * H), status: 'ASSIGNED', publishedAt: new Date(now.getTime() - 48 * H) },
      });
    }
    // An unfilled slot in the same wave is not a person who is late.
    await prisma.shift.create({
      data: { clientId: client.id, locationId: store!.id, position: 'Stocker', startsAt: new Date(now.getTime() - H), endsAt: new Date(now.getTime() + 7 * H), status: 'OPEN', publishedAt: new Date(now.getTime() - 48 * H) },
    });
    const { user } = await createUser({ role: 'CLIENT_PORTAL' });
    await prisma.user.update({ where: { id: user.id }, data: { regionId: region.id } });
    const a = await loginAs(user.email);
    const res = await a.get('/region/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ alerts: 1, lateNotIn: 2, missingFromSchedule: 3 });
    expect(res.body.stores[0].now.lateNotIn).toBe(2);
  });
});

/* ----------------------------------------------------------------- LEAD-10 */

describe('the ops home board, store by store', () => {
  it('one row per store with its client named — not one row per client under a "Store" header', async () => {
    pinAt(3, 16);
    const client = await createClient('Coastal Resort Holdings');
    const [first] = await prisma.site.findMany({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: first!.id }, data: { name: 'Front Beach 218' } });
    const second = await prisma.site.create({ data: { clientId: client.id, name: 'Bayfront 12' } });
    const now = new Date();
    const p = await createAssociate({ firstName: 'Ann', lastName: 'Floor' });
    for (const loc of [first!.id, second.id]) {
      await prisma.shift.create({
        data: { clientId: client.id, locationId: loc, position: 'Stocker', assignedAssociateId: p.id, startsAt: new Date(now.getTime() - H), endsAt: new Date(now.getTime() + 6 * H), status: 'ASSIGNED', publishedAt: now },
      });
    }
    await prisma.shift.create({
      data: { clientId: client.id, locationId: second.id, position: 'Stocker', startsAt: new Date(now.getTime() + H), endsAt: new Date(now.getTime() + 8 * H), status: 'OPEN', publishedAt: now },
    });
    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const a = await loginAs(user.email);
    const res = await a.get('/workforce/overview');
    expect(res.status).toBe(200);
    expect(res.body.today.stores).toHaveLength(1);
    const sites = res.body.today.sites as Array<{ locationId: string; locationName: string; clientName: string; scheduledToday: number; openToday: number; scheduledNow: number; onFloor: number; status: string }>;
    expect(sites).toHaveLength(2);
    const bay = sites.find((x) => x.locationId === second.id)!;
    expect(bay).toMatchObject({ locationName: 'Bayfront 12', clientName: 'Coastal Resort Holdings', scheduledToday: 1, openToday: 1, scheduledNow: 1, onFloor: 0, status: 'red' });
    expect(sites.find((x) => x.locationId === first!.id)).toMatchObject({ locationName: 'Front Beach 218', scheduledToday: 1, openToday: 0 });
  });
});

/* ----------------------------------------------------------------- LEAD-30 */

describe('a prospect\'s age', () => {
  it('is its days in the stage — an edit yesterday does not make a nine-day verbal yes read "6 days"', async () => {
    const now = pinAt(3, 16);
    await prisma.clientProspect.create({
      data: { name: 'Destin Marina', stage: 'VERBAL', stageChangedAt: new Date(now.getTime() - 9 * 24 * H) },
    });
    const decisions = await computeExecutiveDecisions(prisma, now);
    const verbal = decisions.find((d) => d.key.startsWith('prospect:verbal:'));
    expect(verbal?.ageDays).toBe(9);
  });
});

/* ----------------------------------------------------------------- CODE-19 */

describe('portal history reads every row', () => {
  it('pages past any batch size, and says truncated only when its ceiling stops it', async () => {
    const client = await createClient('Paged');
    const now = new Date();
    for (let i = 0; i < 5; i += 1) {
      await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: new Date(now.getTime() + i * H), endsAt: new Date(now.getTime() + (i + 1) * H), status: 'OPEN', publishedAt: now } });
    }
    const read = (ceiling?: number) =>
      readAll((page) => prisma.shift.findMany({ where: { clientId: client.id }, select: { id: true }, ...page }), { batch: 2, ...(ceiling ? { ceiling } : {}) });
    const all = await read();
    expect(all.rows).toHaveLength(5);
    expect(new Set(all.rows.map((r) => r.id)).size).toBe(5);
    expect(all.truncated).toBe(false);
    const cut = await read(3);
    expect(cut.truncated).toBe(true);
  });

  it('rolls the checklists up in SQL, an expired one counted apart from one submitted short', async () => {
    const now = pinAt(3, 16);
    const s = await storeWithManager();
    const day = addDays(keyIn(now, NY), -2);
    await opsRun({ clientId: s.client.id, locationId: s.loc.id, openedById: s.sup.id, dateKey: day, openedAt: at(day, 7), closed: { at: at(day, 21), byId: null, incomplete: true } });
    await opsRun({ clientId: s.client.id, locationId: s.loc.id, openedById: s.sup.id, dateKey: day, openedAt: at(day, 15), windowLabel: 'Evening', closed: { at: at(day, 22), byId: s.sup.id, incomplete: true, reason: 'Two call-outs' } });
    const a = await loginAs(s.manager.email);
    const res = await a.get(`/client-portal/history?from=${addDays(day, -1)}&to=${day}`);
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.ops).toMatchObject({ shifts: 2, sopDone: 6, sopTotal: 20, incomplete: 1, expired: 1 });
  });
});

/* -------------------------------------------------------- hours sign-off */

describe('the client signs off a store week\'s hours', () => {
  async function seedSignOff() {
    const now = pinAt(3, 16); // Wednesday: last week (Sat → Fri) has ended
    const client = await createClient('Coastal Resort Holdings');
    const [a] = await prisma.site.findMany({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: a!.id }, data: { name: 'Front Beach 218', timezone: NY } });
    const b = await prisma.site.create({ data: { clientId: client.id, name: 'Bayfront 12', timezone: NY } });
    const lastSat = addDays(saturdayOf(keyIn(now, NY)), -7);
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const ken = await createAssociate({ firstName: 'Ken', lastName: 'Adams' });
    const zoe = await createAssociate({ firstName: 'Zoe', lastName: 'Park' });
    const punch = async (who: string, loc: string, day: string, from: number, to: number, mealMin = 0) => {
      const e = await prisma.timeEntry.create({
        data: { associateId: who, clientId: client.id, locationId: loc, clockInAt: at(day, from), clockOutAt: at(day, to), status: 'COMPLETED' },
      });
      if (mealMin) await prisma.breakEntry.create({ data: { timeEntryId: e.id, type: 'MEAL', startedAt: at(day, from + 4), endedAt: new Date(at(day, from + 4).getTime() + mealMin * 60_000) } });
      return e;
    };
    // Store A: Maria 2 × (8h − 30 min) = 15h; Ken 6h. Store B: Zoe 4h.
    await punch(maria.id, a!.id, lastSat, 6, 14, 30);
    await punch(maria.id, a!.id, addDays(lastSat, 1), 6, 14, 30);
    await punch(ken.id, a!.id, addDays(lastSat, 2), 9, 15);
    await punch(zoe.id, b.id, addDays(lastSat, 2), 9, 13);
    // A punch never closed: counted apart, not as hours.
    await prisma.timeEntry.create({ data: { associateId: ken.id, clientId: client.id, locationId: a!.id, clockInAt: at(addDays(lastSat, 4), 9), status: 'ACTIVE' } });
    const { user: storeA } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    await prisma.user.update({ where: { id: storeA.id }, data: { locationId: a!.id, displayName: 'Lauren Whitfield' } });
    const { user: market } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const other = await createClient('Seaside Hospitality');
    const { user: otherUser } = await createUser({ role: 'CLIENT_PORTAL', clientId: other.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    return { now, client, a: a!, b, lastSat, maria, ken, zoe, storeA, market, otherUser, hr, punch };
  }

  it('reads each person\'s worked hours, breaks out, and signs the week — its own store only', async () => {
    const s = await seedSignOff();
    const agent = await loginAs(s.storeA.email);
    // A store account is pinned to its store: naming another changes nothing.
    const res = await agent.get(`/client-portal/hours?locationId=${s.b.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ store: { id: s.a.id }, week: { start: s.lastSat, end: addDays(s.lastSat, 6) }, signable: true, canSign: true, totalHours: 21, people: 2, openPunches: 1, state: 'unsigned', signOff: null });
    expect(res.body.lines).toEqual([
      { associateId: s.ken.id, name: 'Ken Adams', hours: 6, punches: 1 },
      { associateId: s.maria.id, name: 'Maria Lopez', hours: 15, punches: 2 },
    ]);
    // Hours only: no rate anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toMatch(/payRate|billRate|amount/);

    const signed = await agent.post(`/client-portal/hours/sign?locationId=${s.b.id}`).send({ week: addDays(s.lastSat, 3), expectTotalHours: 21 });
    expect(signed.status).toBe(201);
    expect(signed.body).toMatchObject({ week: { start: s.lastSat }, state: 'signed', signOff: { status: 'SIGNED', signedByName: 'Lauren Whitfield', totalHours: 21, people: 2 } });
    const rows = await prisma.clientHoursSignOff.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ locationId: s.a.id, clientId: s.client.id, people: 2 });
    expect(Number(rows[0]!.totalHours)).toBe(21);

    // A week still being worked can't be signed.
    const early = await agent.post('/client-portal/hours/sign').send({ week: keyIn(s.now, NY) });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('week_not_signable');

    // Hours that move after the signature read "changed", not signed.
    await s.punch(s.ken.id, s.a.id, addDays(s.lastSat, 5), 9, 11);
    const after = await agent.get('/client-portal/hours');
    expect(after.body).toMatchObject({ totalHours: 23, state: 'changed', signOff: { totalHours: 21 } });
    // Signing against the total the manager no longer sees is refused.
    const stale = await agent.post('/client-portal/hours/sign').send({ week: s.lastSat, expectTotalHours: 21 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('hours_changed');
  });

  it('flags a line with a note, refuses a line from another store, and tells the desk', async () => {
    const s = await seedSignOff();
    const agent = await loginAs(s.storeA.email);
    const wrong = await agent.post('/client-portal/hours/sign').send({ week: s.lastSat, flags: [{ associateId: s.zoe.id, note: 'Not ours' }] });
    expect(wrong.status).toBe(400);
    const flagged = await agent.post('/client-portal/hours/sign').send({ week: s.lastSat, flags: [{ associateId: s.ken.id, note: 'Left at 1 PM, not 3' }], note: 'Rest is fine' });
    expect(flagged.status).toBe(201);
    expect(flagged.body.signOff).toMatchObject({ status: 'FLAGGED', flags: [{ associateId: s.ken.id, name: 'Ken Adams', hours: 6, note: 'Left at 1 PM, not 3' }], note: 'Rest is fine' });
    expect(flagged.body.state).toBe('flagged');

    // Staff read it on the client's page, store by store, week by week.
    const hr = await loginAs(s.hr.email);
    const staff = await hr.get(`/clients/${s.client.id}/hours-signoffs`);
    expect(staff.status).toBe(200);
    expect(staff.body.enabled).toBe(true);
    const mine = staff.body.weeks.find((w: { locationId: string; weekStart: string }) => w.locationId === s.a.id && w.weekStart === s.lastSat);
    expect(mine).toMatchObject({ storeName: 'Front Beach 218', state: 'flagged', signOff: { signedByName: 'Lauren Whitfield' } });
    const theirs = staff.body.weeks.find((w: { locationId: string }) => w.locationId === s.b.id);
    expect(theirs).toMatchObject({ state: 'unsigned', hours: { totalHours: 4, people: 1 } });
  });

  it('a market account signs a store it names; another client and an admin preview cannot sign', async () => {
    const s = await seedSignOff();
    const market = await loginAs(s.market.email);
    // Hours are signed store by store: a several-store client's account names one.
    expect((await market.get('/client-portal/hours')).status).toBe(400);
    const b = await market.post(`/client-portal/hours/sign?locationId=${s.b.id}`).send({ week: s.lastSat });
    expect(b.status).toBe(201);
    expect(b.body.signOff).toMatchObject({ totalHours: 4, people: 1 });

    const other = await loginAs(s.otherUser.email);
    const cross = await other.post(`/client-portal/hours/sign?locationId=${s.a.id}`).send({ week: s.lastSat });
    expect(cross.status).toBe(404);
    expect(await prisma.clientHoursSignOff.count({ where: { locationId: s.a.id } })).toBe(0);

    const hr = await loginAs(s.hr.email);
    const preview = await hr.get(`/client-portal/hours?clientId=${s.client.id}&locationId=${s.a.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body.canSign).toBe(false);
    const forged = await hr.post(`/client-portal/hours/sign?clientId=${s.client.id}&locationId=${s.a.id}`).send({ week: s.lastSat });
    expect(forged.status).toBe(403);
  });

  it('beside each statement, how many of its store weeks the client signed — only where the portal is on', async () => {
    const s = await seedSignOff();
    const agent = await loginAs(s.storeA.email);
    await agent.post('/client-portal/hours/sign').send({ week: s.lastSat });
    await prisma.clientStatement.create({
      data: {
        clientId: s.client.id,
        status: 'FINAL',
        periodStart: new Date(`${s.lastSat}T00:00:00.000Z`),
        periodEnd: new Date(`${addDays(s.lastSat, 6)}T00:00:00.000Z`),
        finalizedAt: s.now,
        snapshot: { totals: { amount: 100, hours: 25 }, stores: [] },
      },
    });
    const finance = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(finance.user.email);
    const list = await f.get(`/clients/${s.client.id}/statements`);
    expect(list.status).toBe(200);
    expect(list.body.statements[0].hoursSignOff).toEqual({ signed: 1, flagged: 0 });

    // A tenant without the client portal has no sign-off anywhere.
    await prisma.tenant.update({ where: { id: ALTO_TENANT }, data: { modules: { clientPortal: false } } });
    const hr = await loginAs(s.hr.email);
    // (The clients area itself answers 404 there; the route also says it is off.)
    const off = await hr.get(`/clients/${s.client.id}/hours-signoffs`);
    expect(off.status === 404 || off.body.enabled === false).toBe(true);
    expect(JSON.stringify(off.body)).not.toContain('Lauren');
    expect((await agent.get('/client-portal/hours')).status).toBe(404);
  });
});
