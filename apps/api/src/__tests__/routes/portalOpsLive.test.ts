import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { localDateKey } from '../../lib/timezone.js';
import { utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';

/**
 * Store operations, as the store manager reads it.
 *
 * The page was a calendar box: shifts that OPENED inside the day. An
 * overnight crew clocks on at 22:00 and submits at 06:00, so the manager
 * arriving at seven saw an empty morning and last night's work filed
 * under a day they had to go looking for. These hold the live reading:
 * what is on the floor now, what finished in this day whenever it
 * started, the shift filter that answers "what happened overnight", and
 * the photographs the page used to count and never show.
 */

const app = () => createApp();
const NY = 'America/New_York';
const H = 3_600_000;

/**
 * An instant that is inside TODAY on the store's clock and already past.
 *
 * These fixtures used to say `Date.now() - 1 * H` for "finished this
 * morning". Between midnight and 1am in New York that lands on YESTERDAY,
 * so the shift matched neither openedAt nor closedAt in today's window and
 * the suite failed — one hour in every twenty-four, which is long enough
 * to be a nuisance and short enough to look like a flake. CI caught it at
 * 00:51 EDT.
 *
 * Six in the morning when the day is old enough, and otherwise the most
 * recent moment that is still inside today: either way a real instant,
 * inside today, that has already happened. The clamp to dayStart matters
 * in the first minute after midnight, where "a minute ago" is yesterday
 * again — the same bug one order of magnitude smaller.
 */
function earlierToday(now = new Date()): Date {
  const dayStart = utcInstantOfLocalMidnight(localDateKey(now, NY), NY);
  const six = new Date(dayStart.getTime() + 6 * H);
  const candidate = six.getTime() < now.getTime() ? six : new Date(now.getTime() - 60_000);
  return candidate.getTime() >= dayStart.getTime() ? candidate : dayStart;
}

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

async function store() {
  const client = await createClient('Front Beach 218');
  const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.location.update({ where: { id: loc.id }, data: { timezone: NY } });
  const assoc = await createAssociate({ firstName: 'Tori', lastName: 'Banks' });
  const { user: sup } = await createUser({
    role: 'SHIFT_SUPERVISOR',
    clientId: client.id,
    associateId: assoc.id,
  });
  const { user: manager } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: loc.id } });
  return { client, loc, sup, manager: await loginAs(manager.email) };
}

/** A shift that opened yesterday evening — the overnight crew. */
async function overnight(
  opts: {
    clientId: string;
    locationId: string;
    openedById: string;
    openedAt: Date;
    closedAt?: Date | null;
    department?: string;
  },
) {
  return prisma.opsShift.create({
    data: {
      clientId: opts.clientId,
      locationId: opts.locationId,
      department: opts.department ?? 'Frozen & Dairy',
      departments: [opts.department ?? 'Frozen & Dairy'],
      period: 'OVERNIGHT',
      position: 'F&D Overnight Shift',
      dateKey: localDateKey(opts.openedAt, NY),
      status: opts.closedAt ? 'CLOSED' : 'ACTIVE',
      openedById: opts.openedById,
      openedAt: opts.openedAt,
      ...(opts.closedAt
        ? { closedById: opts.openedById, closedAt: opts.closedAt, sopDone: 9, sopTotal: 10 }
        : {}),
      taskDone: 9,
      taskTotal: 10,
    },
  });
}

describe('the store manager reads a live day', () => {
  it('shows the overnight that is still on the floor this morning', async () => {
    const { client, loc, sup, manager } = await store();
    // Opened eight hours ago, which on any clock crosses into a day the
    // shift is not filed under.
    const opened = new Date(Date.now() - 8 * H);
    const shift = await overnight({
      clientId: client.id,
      locationId: loc.id,
      openedById: sup.id,
      openedAt: opened,
    });

    const res = await manager.get('/client-portal/ops');
    expect(res.status).toBe(200);
    // It is in TODAY, and it is named as running right now.
    expect(res.body.runs.map((r: { id: string }) => r.id)).toContain(shift.id);
    expect(res.body.live).not.toBeNull();
    expect(res.body.live.map((l: { id: string }) => l.id)).toContain(shift.id);
    expect(res.body.live[0]).toMatchObject({
      period: 'OVERNIGHT',
      runBy: 'Tori Banks',
    });
    expect(res.body.summary.running).toBeGreaterThanOrEqual(1);
  });

  it('keeps an overnight that FINISHED this morning in this morning', async () => {
    const { client, loc, sup, manager } = await store();
    // Finished earlier today; started the evening before — the overnight
    // shape, pinned to today's clock rather than to the hour the suite runs.
    const closed = earlierToday();
    const opened = new Date(closed.getTime() - 8 * H);
    const shift = await overnight({
      clientId: client.id,
      locationId: loc.id,
      openedById: sup.id,
      openedAt: opened,
      closedAt: closed,
    });

    const today = await manager.get('/client-portal/ops');
    expect(today.status).toBe(200);
    // Keyed on the open alone, this work vanished from the day the
    // manager was standing in when they read about it.
    expect(today.body.runs.map((r: { id: string }) => r.id)).toContain(shift.id);
    // Nothing is running, so the live list is empty rather than absent.
    expect(today.body.live).toEqual([]);

    // And it is still on the day it opened — the work happened on both.
    const its = await manager.get(
      `/client-portal/ops?date=${localDateKey(opened, NY)}`,
    );
    expect(its.body.runs.map((r: { id: string }) => r.id)).toContain(shift.id);
  });

  it('answers "what happened overnight" as a filter', async () => {
    const { client, loc, sup, manager } = await store();
    const night = await overnight({
      clientId: client.id,
      locationId: loc.id,
      openedById: sup.id,
      openedAt: new Date(earlierToday().getTime() - 8 * H),
      closedAt: earlierToday(),
    });
    const morning = await prisma.opsShift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        department: 'Grocery',
        departments: ['Grocery'],
        period: 'MORNING',
        position: 'Grocery Morning Shift',
        dateKey: localDateKey(new Date(), NY),
        status: 'ACTIVE',
        openedById: sup.id,
        openedAt: new Date(Date.now() - 30 * 60_000),
      },
    });

    const all = await manager.get('/client-portal/ops');
    expect(all.body.runs).toHaveLength(2);
    expect(all.body.departments).toEqual(
      expect.arrayContaining(['Frozen & Dairy', 'Grocery']),
    );
    expect(all.body.filters).toEqual({ period: null, department: null });

    const justNight = await manager.get('/client-portal/ops?period=OVERNIGHT');
    expect(justNight.body.runs.map((r: { id: string }) => r.id)).toEqual([night.id]);
    expect(justNight.body.filters.period).toBe('OVERNIGHT');

    const justGrocery = await manager.get('/client-portal/ops?department=Grocery');
    expect(justGrocery.body.runs.map((r: { id: string }) => r.id)).toEqual([morning.id]);

    // A nonsense shift name narrows nothing rather than erroring.
    const junk = await manager.get('/client-portal/ops?period=BREAKFAST');
    expect(junk.status).toBe(200);
    expect(junk.body.filters.period).toBeNull();
  });

  it('hands over the photographs, not just how many there were', async () => {
    const { client, loc, sup, manager } = await store();
    const shift = await overnight({
      clientId: client.id,
      locationId: loc.id,
      openedById: sup.id,
      openedAt: new Date(Date.now() - 3 * H),
    });
    const task = await prisma.opsTask.create({
      data: {
        opsShiftId: shift.id,
        title: 'Face aisle 4',
        section: 'The floor',
        status: 'DONE',
        completedAt: new Date(),
      },
    });
    await prisma.opsTaskPhoto.create({
      data: {
        taskId: task.id,
        s3Key: 'ops/test/aisle-4.jpg',
        filename: 'aisle-4.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
      },
    });

    const res = await manager.get('/client-portal/ops');
    expect(res.status).toBe(200);
    expect(res.body.summary.photos).toBe(1);
    // The count was all the page ever had. The evidence is the point.
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0]).toMatchObject({
      title: 'Face aisle 4',
      section: 'The floor',
      shiftId: shift.id,
      department: 'Frozen & Dairy',
      period: 'OVERNIGHT',
    });

    // Another store's manager gets none of it.
    const other = await createClient('Destin');
    const { user: otherManager } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: other.id,
    });
    const otherAgent = await loginAs(otherManager.email);
    const theirs = await otherAgent.get('/client-portal/ops');
    expect(theirs.body.photos).toEqual([]);
  });

  it('leads the store home page with now, and offers last night on purpose', async () => {
    const { client, loc, sup, manager } = await store();
    await overnight({
      clientId: client.id,
      locationId: loc.id,
      openedById: sup.id,
      openedAt: new Date(Date.now() - 6 * H),
    });

    const res = await manager.get('/client-portal/overview');
    expect(res.status).toBe(200);
    expect(res.body.ops).toBeTruthy();
    // Running now, whatever day it was filed under — the card used to
    // lead with a finished shift while this one was on the floor.
    expect(res.body.ops.live).toHaveLength(1);
    expect(res.body.ops.live[0]).toMatchObject({ period: 'OVERNIGHT' });
    expect(res.body.ops.current.open).toBe(1);
    expect(res.body.ops).toHaveProperty('lastNight');
    expect(res.body.ops).toHaveProperty('yesterdayKey');
  });
});
