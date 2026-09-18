import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { minuteOfDayInZone } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { generateDeviceToken, hashDeviceToken, hmacPin } from '../../lib/kioskAuth.js';
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';
import { runSopCoverSweep } from '../../lib/storeShiftSop.js';
import { supervisorRecipients } from '../../lib/shiftWindows.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * A floor supervisor is assigned a client, a shift, and the shift
 * supervisor in charge of them. They help on that shift's SOP; they run it
 * — gate and all — when the shift supervisor hands them the day, or isn't
 * on the clock 30 minutes in; the shift supervisor's clock-in takes it back.
 * They punch at the store tablet only — never in the app.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
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

const TZ = 'America/New_York';
const MIN = 60_000;
const at = (min: number) => minuteOfDayInZone(new Date(Date.now() + min * MIN), TZ);
const todayKey = () => dateKeyInZone(new Date(), TZ);

/** Front Beach's "Swing" shift — started `startedMin` minutes ago, runs 7h
 *  more — with an SOP assigned; Dana leads it, Marcus works it under her. */
async function seed(opts: { startedMin?: number } = {}) {
  const client = await createClient('Front Beach');
  const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.location.update({ where: { id: store.id }, data: { timezone: TZ } });
  await prisma.staffingTarget.create({
    data: {
      locationId: store.id,
      targetCount: 6,
      effectiveFrom: new Date('2026-01-01'),
      label: 'Swing',
      startMinute: at(-(opts.startedMin ?? 60)),
      endMinute: at(7 * 60),
    },
  });
  const template = await prisma.opsSopTemplate.create({
    data: {
      name: 'Swing Standard',
      department: 'F&D',
      period: 'EVENING',
      tasks: {
        create: [
          { section: 'Open', order: 1, title: 'Walk the floor', responseType: 'CHECK', required: true },
          { section: 'Open', order: 2, title: 'Check the coolers', responseType: 'CHECK', required: true },
        ],
      },
    },
  });
  await prisma.storeShiftSop.create({ data: { locationId: store.id, label: 'Swing', templateId: template.id } });

  const person = async (first: string, last: string, role: 'SHIFT_SUPERVISOR' | 'FLOOR_SUPERVISOR') => {
    const a = await createAssociate({ firstName: first, lastName: last });
    const { user } = await createUser({ role, clientId: client.id, associateId: a.id });
    await prisma.associateAssignment.create({
      data: { associateId: a.id, locationId: store.id, startedAt: new Date('2026-01-01') },
    });
    await prisma.supervisorShiftWindow.create({ data: { userId: user.id, locationId: store.id, label: 'Swing' } });
    return { user, associate: a };
  };
  const dana = await person('Dana', 'Reyes', 'SHIFT_SUPERVISOR');
  const marcus = await person('Marcus', 'Hill', 'FLOOR_SUPERVISOR');
  await prisma.user.update({ where: { id: marcus.user.id }, data: { leadUserId: dana.user.id } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

  // The store tablet, and Marcus's PIN — the only place he punches.
  const pin = '2468';
  await prisma.kioskPin.create({ data: { clientId: client.id, associateId: marcus.associate.id, pinHmac: hmacPin(pin) } });
  const { plaintext, prefix } = generateDeviceToken();
  await prisma.kioskDevice.create({
    data: {
      clientId: client.id,
      locationId: store.id,
      name: 'Front Beach tablet',
      tokenHash: hashDeviceToken(plaintext),
      tokenPrefix: prefix,
      tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * MIN),
    },
  });
  const tablet = async () => {
    _resetKioskRateLimit();
    return request(app()).post('/kiosk/punch').send({ deviceToken: plaintext, pin });
  };
  return { client, store, template, dana, marcus, hr, tablet };
}

const bell = (userId: string, subject: string | { startsWith: string }) =>
  prisma.notification.findFirst({ where: { recipientUserId: userId, channel: 'IN_APP', subject } });

describe('assigning a floor supervisor their shift supervisor', () => {
  it('HR assigns a shift supervisor at the same client — never another client, never a non-supervisor', async () => {
    const { client, marcus, dana, hr } = await seed();
    const agent = await loginAs(hr.email);
    await prisma.user.update({ where: { id: marcus.user.id }, data: { leadUserId: null } });

    const other = await createClient('Target');
    const { user: elsewhere } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id });
    const { user: floor2 } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id });

    expect((await agent.put(`/admin/users/${marcus.user.id}/lead`).send({ leadUserId: elsewhere.id })).body.error.code).toBe(
      'lead_other_client',
    );
    expect((await agent.put(`/admin/users/${marcus.user.id}/lead`).send({ leadUserId: floor2.id })).body.error.code).toBe(
      'lead_not_found',
    );
    expect((await agent.put(`/admin/users/${dana.user.id}/lead`).send({ leadUserId: dana.user.id })).body.error.code).toBe(
      'not_a_floor_supervisor',
    );
    const ok = await agent.put(`/admin/users/${marcus.user.id}/lead`).send({ leadUserId: dana.user.id });
    expect(ok.status).toBe(200);

    const list = await agent.get('/admin/users');
    const row = list.body.users.find((u: { id: string }) => u.id === marcus.user.id);
    expect(row).toMatchObject({ leadUserId: dana.user.id, leadName: 'Dana Reyes', shiftWindows: [expect.objectContaining({ label: 'Swing' })] });
  });

  it('a floor supervisor works a shift like a shift supervisor does — assigned, and their focus', async () => {
    const { store, marcus, hr } = await seed();
    const agent = await loginAs(hr.email);
    const put = await agent
      .put(`/admin/users/${marcus.user.id}/shift-windows`)
      .send({ windows: [{ locationId: store.id, label: 'Swing' }] });
    expect(put.status).toBe(200);
    const mine = await (await loginAs(marcus.user.email)).get('/me/shift-windows');
    expect(mine.body.windows).toEqual([expect.objectContaining({ label: 'Swing', locationId: store.id })]);
  });

  it('the link undoes itself when the shift supervisor is disabled, and the gap view says so', async () => {
    const { dana, marcus, hr } = await seed();
    const agent = await loginAs(hr.email);
    expect((await agent.patch(`/admin/users/${dana.user.id}`).send({ status: 'DISABLED' })).status).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: marcus.user.id } })).leadUserId).toBeNull();

    const gaps = await agent.get('/admin/shift-windows/gaps');
    const c = gaps.body.clients[0];
    expect(c.floorSupervisors).toEqual([
      expect.objectContaining({ userId: marcus.user.id, name: 'Marcus Hill', noLead: true, noShift: false }),
    ]);
  });

  it('the client view lists every shift supervisor a floor supervisor can report to, with their shifts', async () => {
    const { client, dana, hr } = await seed();
    const { user: newSup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const res = await (await loginAs(hr.email)).get(`/admin/shift-windows?clientId=${client.id}`);
    expect(res.body.supervisors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: dana.user.id, name: 'Dana Reyes', windows: [expect.objectContaining({ label: 'Swing' })] }),
        expect.objectContaining({ userId: newSup.id, windows: [] }),
      ]),
    );
  });
});

describe('floor supervisors punch at the tablet only', () => {
  it('the app refuses every punch — in, out, and breaks — and points them to the tablet', async () => {
    const { marcus, tablet } = await seed();
    const m = await loginAs(marcus.user.email);
    for (const path of ['/time/me/clock-in', '/time/me/clock-out', '/time/me/break/start', '/time/me/break/end']) {
      const res = await m.post(path).send({});
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe('use_kiosk');
    }
    expect((await m.post('/time/me/clock-in').send({})).body.error.message).toMatch(/store tablet/);
    // The tablet takes the punch — and the app still shows they're on.
    expect((await tablet()).body.action).toBe('CLOCK_IN');
    expect((await m.get('/time/me/active')).body.active).not.toBeNull();
  });
});

describe('the floor team, each side', () => {
  it("the shift supervisor sees their floor supervisors on the clock; the floor supervisor sees their lead", async () => {
    const { dana, marcus, tablet } = await seed();
    const m = await loginAs(marcus.user.email);
    expect((await tablet()).body.action).toBe('CLOCK_IN');

    const team = await (await loginAs(dana.user.email)).get('/me/floor-team');
    expect(team.body.role).toBe('lead');
    expect(team.body.team).toEqual([
      expect.objectContaining({ userId: marcus.user.id, name: 'Marcus Hill', onClockSince: expect.any(String), coveringToday: false }),
    ]);

    const mine = await m.get('/me/floor-team');
    expect(mine.body).toMatchObject({ role: 'floor', lead: { userId: dana.user.id, name: 'Dana Reyes', onClockSince: null } });
  });
});

describe('helping on the shift supervisor\'s SOP', () => {
  it("the floor supervisor's clock-in opens nothing; on the lead's SOP they check items off but can't submit it", async () => {
    const { dana, marcus, tablet } = await seed();
    const m = await loginAs(marcus.user.email);
    expect((await tablet()).body.action).toBe('CLOCK_IN');
    expect(await prisma.opsShift.count()).toBe(0);

    const d = await loginAs(dana.user.email);
    expect((await d.post('/time/me/clock-in').send({})).status).toBe(201);
    const sop = await prisma.opsShift.findFirstOrThrow();
    expect(sop.openedById).toBe(dana.user.id);

    const my = await m.get('/ops/my-sop');
    expect(my.body.sop).toBeNull();
    expect(my.body.helping).toMatchObject({ id: sop.id, windowLabel: 'Swing', runBy: { name: 'Dana Reyes' }, sopTotal: 2 });

    const detail = await m.get(`/ops/shifts/${sop.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.access).toBe('help');
    const task = detail.body.tasks[0];
    expect((await m.patch(`/ops/tasks/${task.id}`).send({ status: 'DONE' })).status).toBe(200);

    const close = await m.post(`/ops/shifts/${sop.id}/close`).send({ handoverNone: true, incompleteReason: 'Leaving early today.' });
    expect(close.status).toBe(403);
    expect(close.body.error.code).toBe('not_running');
    expect((await m.post(`/ops/shifts/${sop.id}/handover`).send({ items: [{ kind: 'NOTE', body: 'x' }] })).status).toBe(403);
    // Their clock-out isn't held by an SOP they don't run.
    expect((await tablet()).body.action).toBe('CLOCK_OUT');
  });

  it("an SOP that isn't their shift's stays closed to them", async () => {
    const { client, store, template, marcus } = await seed();
    const { user: eve } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const other = await prisma.opsShift.create({
      data: {
        clientId: client.id,
        department: 'F&D',
        period: 'MORNING',
        position: 'Morning shift',
        dateKey: todayKey(),
        openedById: eve.id,
        locationId: store.id,
        windowLabel: 'Morning',
        templateId: template.id,
      },
    });
    const m = await loginAs(marcus.user.email);
    expect((await m.get(`/ops/shifts/${other.id}`)).status).toBe(403);
    expect((await m.post('/ops/shifts/open').send({ position: 'Deli' })).status).toBe(403);
  });
});

describe('handing the shift over', () => {
  it('the shift supervisor hands a day to their floor supervisor, who is told; the clock-in opens the SOP for THEM and holds their clock-out', async () => {
    const { dana, marcus, tablet } = await seed();
    const d = await loginAs(dana.user.email);
    const cover = await d
      .post('/shift-covers')
      .send({ coverUserId: marcus.user.id, fromDate: todayKey(), toDate: todayKey(), note: 'Dentist — back tomorrow.' });
    expect(cover.status).toBe(201);
    await flushPendingNotifications();
    const told = await bell(marcus.user.id, { startsWith: 'Dana handed you the Swing shift' });
    expect(told?.body).toMatch(/clocking in at the store tablet opens the SOP for you/);
    expect(told?.body).toMatch(/Dentist — back tomorrow\./);

    const m = await loginAs(marcus.user.email);
    expect((await tablet()).body.action).toBe('CLOCK_IN');
    const sop = await prisma.opsShift.findFirstOrThrow();
    expect(sop).toMatchObject({ openedById: marcus.user.id, coveringForId: dana.user.id, windowLabel: 'Swing' });

    const my = await m.get('/ops/my-sop');
    expect(my.body.sop).toMatchObject({ id: sop.id, coveringFor: { id: dana.user.id, name: 'Dana Reyes' } });
    const out = await tablet();
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe('sop_open');

    // They run it end to end — the record says for whom, and Dana hears.
    const detail = await m.get(`/ops/shifts/${sop.id}`);
    expect(detail.body.access).toBe('run');
    expect(detail.body.shift).toMatchObject({ runBy: { name: 'Marcus Hill' }, coveringFor: { name: 'Dana Reyes' } });
    for (const t of detail.body.tasks) {
      expect((await m.patch(`/ops/tasks/${t.id}`).send({ status: 'DONE' })).status).toBe(200);
    }
    expect((await m.post(`/ops/shifts/${sop.id}/close`).send({ handoverNone: true })).status).toBe(200);
    await flushPendingNotifications();
    const report = await bell(dana.user.id, 'Marcus Hill submitted your Swing SOP');
    expect(report?.body).toMatch(/2 of 2 done/);
    expect((await tablet()).body.action).toBe('CLOCK_OUT');
  });

  it("only to their own floor supervisors, never overlapping; HR can hand over for them; taking it back tells the cover", async () => {
    const { client, dana, marcus, hr } = await seed();
    const { user: stranger } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id });
    const d = await loginAs(dana.user.email);
    const today = todayKey();

    const notMine = await d.post('/shift-covers').send({ coverUserId: stranger.id, fromDate: today, toDate: today });
    expect(notMine.body.error.code).toBe('not_your_team');

    const first = await d.post('/shift-covers').send({ coverUserId: marcus.user.id, fromDate: today, toDate: today });
    expect(first.status).toBe(201);
    const clash = await d.post('/shift-covers').send({ coverUserId: marcus.user.id, fromDate: today, toDate: today });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('cover_overlaps');

    // Marcus can't hand Dana's shift to himself.
    const m = await loginAs(marcus.user.email);
    expect((await m.post('/shift-covers').send({ coverUserId: marcus.user.id, fromDate: today, toDate: today })).status).toBe(403);

    expect((await d.delete(`/shift-covers/${first.body.cover.id}`)).status).toBe(204);
    await flushPendingNotifications();
    expect(await bell(marcus.user.id, { startsWith: 'Dana took their shift back' })).not.toBeNull();

    // HR, for Dana — any floor supervisor at her client; Dana is told.
    const h = await loginAs(hr.email);
    const byHr = await h
      .post('/shift-covers')
      .send({ leadUserId: dana.user.id, coverUserId: stranger.id, fromDate: today, toDate: today });
    expect(byHr.status).toBe(201);
    await flushPendingNotifications();
    expect(await bell(dana.user.id, { startsWith: `${stranger.email.split('@')[0]} covers your shift` })).not.toBeNull();

    const team = await h.get(`/admin/users/${dana.user.id}/floor-team`);
    expect(team.body.covers).toEqual([expect.objectContaining({ coverUserId: stranger.id, fromDate: today })]);
  });

  it("approving the shift supervisor's time off asks who covers their SOP", async () => {
    const { dana, hr } = await seed();
    await prisma.timeOffBalance.create({
      data: { associateId: dana.associate.id, category: 'PTO', balanceMinutes: 40 * 60 },
    });
    const req = await prisma.timeOffRequest.create({
      data: {
        associateId: dana.associate.id,
        category: 'PTO',
        startDate: new Date('2026-10-20T00:00:00Z'),
        endDate: new Date('2026-10-22T00:00:00Z'),
        requestedMinutes: 24 * 60,
        status: 'PENDING',
      },
    });
    const approve = await (await loginAs(hr.email)).post(`/time-off/admin/requests/${req.id}/approve`).send({});
    expect(approve.status).toBe(200);
    await flushPendingNotifications();
    const ask = await bell(dana.user.id, { startsWith: 'Who covers your SOP' });
    expect(ask?.subject).toBe('Who covers your SOP on Tue, Oct 20 – Thu, Oct 22?');
    expect(ask?.body).toMatch(/Hand your shift to Marcus/);
    expect(ask?.linkUrl).toBe('/?handover=2026-10-20..2026-10-22');
  });
});

describe('the shift supervisor is not on the clock', () => {
  it('30 minutes in, the SOP moves to the floor supervisor on the clock — lead and Workforce told; the lead clocking in takes it back', async () => {
    const { dana, marcus, tablet } = await seed({ startedMin: 45 });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const m = await loginAs(marcus.user.email);
    expect((await tablet()).body.action).toBe('CLOCK_IN');

    expect(await runSopCoverSweep(prisma)).toEqual({ opened: 1 });
    // Once — never a second SOP for the same shift.
    expect(await runSopCoverSweep(prisma)).toEqual({ opened: 0 });
    const sop = await prisma.opsShift.findFirstOrThrow();
    expect(sop).toMatchObject({ openedById: marcus.user.id, coveringForId: dana.user.id });
    await flushPendingNotifications();
    expect((await bell(marcus.user.id, 'The Swing SOP is yours today'))?.body).toMatch(/Dana Reyes isn't on the clock 30 minutes/);
    expect(await bell(dana.user.id, 'Marcus Hill is running your Swing SOP')).not.toBeNull();
    expect(await bell(wfm.id, { startsWith: 'SOP moved to a floor supervisor' })).not.toBeNull();
    expect((await tablet()).status).toBe(409);

    // A checked item survives the hand-back.
    const detail = await m.get(`/ops/shifts/${sop.id}`);
    await m.patch(`/ops/tasks/${detail.body.tasks[0].id}`).send({ status: 'DONE' });

    const d = await loginAs(dana.user.email);
    expect((await d.post('/time/me/clock-in').send({})).status).toBe(201);
    const back = await prisma.opsShift.findUniqueOrThrow({ where: { id: sop.id } });
    expect(back).toMatchObject({ openedById: dana.user.id, coveringForId: null, status: 'ACTIVE' });
    expect(await prisma.opsShift.count()).toBe(1);
    expect((await d.get('/ops/my-sop')).body.sop).toMatchObject({ id: sop.id, sopDone: 1 });
    await flushPendingNotifications();
    expect(await bell(marcus.user.id, 'Dana Reyes took the Swing SOP back')).not.toBeNull();
    // Marcus's clock-out is free again.
    expect((await tablet()).body.action).toBe('CLOCK_OUT');
  });

  it("not before 30 minutes, and never while the shift supervisor is on the clock", async () => {
    const early = await seed({ startedMin: 10 });
    expect((await early.tablet()).body.action).toBe('CLOCK_IN');
    expect(await runSopCoverSweep(prisma)).toEqual({ opened: 0 });

    // 45 minutes in — but Dana is on the clock (clocked in elsewhere, say).
    await prisma.timeEntry.create({
      data: { associateId: early.dana.associate.id, clientId: early.client.id, clockInAt: new Date(), status: 'ACTIVE' },
    });
    expect(await runSopCoverSweep(prisma, new Date(Date.now() + 35 * MIN))).toEqual({ opened: 0 });
  });
});

describe("a floor supervisor's no-show", () => {
  it('reaches the shift supervisor in charge of them first', async () => {
    const { client, store, dana, marcus } = await seed();
    const { user: other } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    await prisma.supervisorShiftWindow.create({ data: { userId: other.id, locationId: store.id, label: 'Swing' } });
    const toWindow = await supervisorRecipients(prisma, client.id, { locationId: store.id, startsAt: new Date() });
    expect(toWindow.map((u) => u.id).sort()).toEqual([dana.user.id, other.id].sort());
    const aboutMarcus = await supervisorRecipients(
      prisma,
      client.id,
      { locationId: store.id, startsAt: new Date() },
      { aboutAssociateId: marcus.associate.id },
    );
    expect(aboutMarcus.map((u) => u.id)).toEqual([dana.user.id]);
  });
});
