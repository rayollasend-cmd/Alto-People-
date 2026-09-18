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
import { minuteOfDayInZone } from '@alto-people/shared';
import { supervisorRecipients } from '../../lib/shiftWindows.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * A shift supervisor's shift: the store shift windows they lead, assigned
 * the way a client is. Focus, not a lock — it routes their alerts and
 * shapes their default views; it never narrows what they may see.
 */

const app = () => createApp();
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

const TZ = 'America/New_York';

/** A store with Morning 06–14 and Overnight 22–06, and two supervisors. */
async function seedStore() {
  const client = await createClient('Front Beach');
  const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.location.update({ where: { id: store.id }, data: { timezone: TZ } });
  const eff = new Date('2026-01-01');
  await prisma.staffingTarget.createMany({
    data: [
      { locationId: store.id, targetCount: 12, effectiveFrom: eff },
      { locationId: store.id, targetCount: 8, effectiveFrom: eff, label: 'Morning', startMinute: 360, endMinute: 840 },
      { locationId: store.id, targetCount: 5, effectiveFrom: eff, label: 'Overnight', startMinute: 1320, endMinute: 360 },
    ],
  });
  const mk = async (first: string) => {
    const a = await createAssociate({ firstName: first, lastName: 'Lead' });
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: a.id });
    return user;
  };
  const dana = await mk('Dana');
  const omar = await mk('Omar');
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { client, store, dana, omar, hr: await loginAs(hrUser.email) };
}

/** An instant whose New York wall clock is hh:mm (EDT, UTC−4 in September). */
const nyAt = (hh: number, mm = 0) => new Date(Date.UTC(2026, 8, 20, hh + 4, mm));

/** Two days out, moved to hh:00 on the store's clock (DST-safe). */
function soonAtStoreHour(hh: number): Date {
  const base = new Date(Date.now() + 48 * 3_600_000);
  base.setUTCSeconds(0, 0);
  return new Date(base.getTime() + (hh * 60 - minuteOfDayInZone(base, TZ)) * 60_000);
}

describe('assigning a supervisor their shift', () => {
  it('HR assigns windows; the picker shows who leads what; the supervisor sees their own', async () => {
    const { client, store, dana, hr } = await seedStore();
    const put = await hr
      .put(`/admin/users/${dana.id}/shift-windows`)
      .send({ windows: [{ locationId: store.id, label: 'Overnight' }] });
    expect(put.status).toBe(200);

    const picker = await hr.get(`/admin/shift-windows?clientId=${client.id}`);
    expect(picker.status).toBe(200);
    const windows = picker.body.stores[0].windows as Array<{ label: string; leads: Array<{ name: string }> }>;
    expect(windows.map((w) => w.label)).toEqual(['Morning', 'Overnight']);
    expect(windows.find((w) => w.label === 'Overnight')!.leads.map((l) => l.name)).toEqual(['Dana Lead']);
    // A gap is visible, not hidden.
    expect(windows.find((w) => w.label === 'Morning')!.leads).toEqual([]);

    const users = await hr.get('/admin/users');
    const row = (users.body.users as Array<{ id: string; shiftWindows: Array<{ label: string }> }>).find((u) => u.id === dana.id)!;
    expect(row.shiftWindows.map((w) => w.label)).toEqual(['Overnight']);

    const me = await (await loginAs(dana.email)).get('/me/shift-windows');
    expect(me.body.windows).toEqual([
      expect.objectContaining({ label: 'Overnight', startMinute: 1320, endMinute: 360, timezone: TZ, targetCount: 5 }),
    ]);
  });

  it('refuses a window the store does not define, an empty set, and non-supervisors', async () => {
    const { store, dana, hr } = await seedStore();
    const bogus = await hr
      .put(`/admin/users/${dana.id}/shift-windows`)
      .send({ windows: [{ locationId: store.id, label: 'Graveyard' }] });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe('window_not_found');

    const none = await hr.put(`/admin/users/${dana.id}/shift-windows`).send({ windows: [] });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('shift_required');

    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const notSup = await hr
      .put(`/admin/users/${assoc.id}/shift-windows`)
      .send({ windows: [{ locationId: store.id, label: 'Morning' }] });
    expect(notSup.status).toBe(400);
    expect(notSup.body.error.code).toBe('not_a_supervisor');
  });

  it("a new client drops the old client's windows", async () => {
    const { store, dana, hr } = await seedStore();
    await hr.put(`/admin/users/${dana.id}/shift-windows`).send({ windows: [{ locationId: store.id, label: 'Morning' }] });
    const other = await createClient('Pier Park');
    expect((await hr.patch(`/admin/users/${dana.id}`).send({ clientId: other.id })).status).toBe(204);
    expect(await prisma.supervisorShiftWindow.count({ where: { userId: dana.id } })).toBe(0);
  });

  it('only a supervisor’s admin may assign — the supervisor cannot pick their own', async () => {
    const { store, dana } = await seedStore();
    const self = await (await loginAs(dana.email))
      .put(`/admin/users/${dana.id}/shift-windows`)
      .send({ windows: [{ locationId: store.id, label: 'Morning' }] });
    expect(self.status).toBe(403);
  });
});

describe('alerts go to the shift’s lead', () => {
  it('routes by the window the shift starts in, and falls back to everyone when nobody leads it', async () => {
    const { client, store, dana, omar } = await seedStore();
    await prisma.supervisorShiftWindow.createMany({
      data: [
        { userId: dana.id, locationId: store.id, label: 'Overnight' },
        { userId: omar.id, locationId: store.id, label: 'Morning' },
      ],
    });
    const ids = async (hh: number) =>
      (await supervisorRecipients(prisma, client.id, { locationId: store.id, startsAt: nyAt(hh) }))
        .map((u) => u.id)
        .sort();

    expect(await ids(23)).toEqual([dana.id]); // 11 PM → Overnight
    expect(await ids(2)).toEqual([dana.id]); // 2 AM → Overnight (wraps midnight)
    expect(await ids(7)).toEqual([omar.id]); // 7 AM → Morning
    // 3 PM: no window covers it → every supervisor at the client.
    expect(await ids(15)).toEqual([dana.id, omar.id].sort());
    // No shift to place (time off, week-level) → everyone.
    expect((await supervisorRecipients(prisma, client.id, null)).length).toBe(2);
  });

  it("an overnight pickup request reaches the overnight lead, not the morning one", async () => {
    const { client, store, dana, omar } = await seedStore();
    await prisma.supervisorShiftWindow.createMany({
      data: [
        { userId: dana.id, locationId: store.id, label: 'Overnight' },
        { userId: omar.id, locationId: store.id, label: 'Morning' },
      ],
    });
    const a = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id });
    await prisma.associateAssignment.create({
      data: { associateId: a.id, locationId: store.id, startedAt: new Date() },
    });
    const startsAt = soonAtStoreHour(23);
    const open = await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: store.id,
        position: 'Server',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 8 * 3_600_000),
        status: 'OPEN',
        publishedAt: new Date(),
      },
    });

    const claim = await (await loginAs(user.email)).post(`/scheduling/me/open-shifts/${open.id}/claim`);
    expect(claim.status).toBe(201);
    await flushPendingNotifications();
    const heard = await prisma.notification.findMany({
      where: { recipientUserId: { in: [dana.id, omar.id] }, channel: 'IN_APP', subject: 'Open-shift pickup request' },
      select: { recipientUserId: true },
    });
    expect(heard.map((n) => n.recipientUserId)).toEqual([dana.id]);
  });
});

describe('the store manager sees who leads each shift', () => {
  it("the day payload names each window's leads; the store's lead card lists theirs", async () => {
    const { client, store, dana, omar } = await seedStore();
    await prisma.supervisorShiftWindow.create({ data: { userId: dana.id, locationId: store.id, label: 'Overnight' } });
    // Omar leads a window at ANOTHER store of the same client.
    const other = await prisma.location.create({ data: { clientId: client.id, name: 'Pier Park', timezone: TZ } });
    await prisma.staffingTarget.create({
      data: { locationId: other.id, targetCount: 4, effectiveFrom: new Date('2026-01-01'), label: 'Morning', startMinute: 360, endMinute: 840 },
    });
    await prisma.supervisorShiftWindow.create({ data: { userId: omar.id, locationId: other.id, label: 'Morning' } });
    const { user: storeMgr } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    await prisma.user.update({ where: { id: storeMgr.id }, data: { locationId: store.id } });
    const portal = await loginAs(storeMgr.email);

    const day = await portal.get('/client-portal/day');
    expect(day.status).toBe(200);
    const leads = day.body.windowLeads as Array<{ label: string; leads: string[] }>;
    expect(leads.find((w) => w.label === 'Overnight')!.leads).toEqual(['Dana Lead']);
    expect(leads.find((w) => w.label === 'Morning')!.leads).toEqual([]);

    const overview = await portal.get('/client-portal/overview');
    const people = overview.body.leads.people as Array<{ name: string; shifts: string[] }>;
    // Dana leads here; Omar leads at the other store, so he isn't this store's lead.
    expect(people.map((p) => p.name)).toEqual(['Dana Lead']);
    expect(people[0].shifts).toEqual(['Overnight']);
  });
});

describe("the day is the store's day", () => {
  it("a Pacific store's 10 PM overnight crew is on that Pacific day, not the Eastern tomorrow", async () => {
    const { client, store, dana } = await seedStore();
    await prisma.location.update({ where: { id: store.id }, data: { timezone: 'America/Los_Angeles' } });
    // Oct 5, 10 PM Pacific = Oct 6, 1 AM Eastern.
    const tonight = await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: store.id,
        position: 'Porter',
        startsAt: new Date('2026-10-06T05:00:00Z'),
        endsAt: new Date('2026-10-06T13:00:00Z'),
        status: 'OPEN',
        publishedAt: new Date(),
      },
    });
    const sup = await loginAs(dana.email);
    const day = await sup.get('/client-portal/day?date=2026-10-05');
    expect(day.status).toBe(200);
    expect((day.body.roster as Array<{ shiftId: string }>).map((r) => r.shiftId)).toContain(tonight.id);
    // …and the next Pacific day only sees it as the crew still finishing.
    const next = await sup.get('/client-portal/day?date=2026-10-06');
    expect((next.body.roster as Array<{ shiftId: string }>).map((r) => r.shiftId)).toContain(tonight.id);
    const after = await sup.get('/client-portal/day?date=2026-10-07');
    expect((after.body.roster as Array<{ shiftId: string }>).map((r) => r.shiftId)).not.toContain(tonight.id);
  });
});

describe('who is missing a lead — across every client', () => {
  it('lists the shifts nobody leads and the supervisors with no shift; clears as they are assigned', async () => {
    const { client, store, dana, omar, hr } = await seedStore();
    await prisma.supervisorShiftWindow.create({ data: { userId: dana.id, locationId: store.id, label: 'Overnight' } });
    // A client with no named shifts has nothing to report.
    await createClient('Pier Park');

    const gaps = await hr.get('/admin/shift-windows/gaps');
    expect(gaps.status).toBe(200);
    expect(gaps.body).toMatchObject({ total: 2, covered: 1 });
    expect(gaps.body.clients).toHaveLength(1);
    const c = gaps.body.clients[0];
    expect(c.clientId).toBe(client.id);
    expect(c.uncovered.map((w: { label: string }) => w.label)).toEqual(['Morning']);
    expect(c.noShift).toEqual([omar.id]);
    expect(c.supervisors.map((u: { name: string }) => u.name).sort()).toEqual(['Dana Lead', 'Omar Lead']);

    await hr.put(`/admin/users/${omar.id}/shift-windows`).send({ windows: [{ locationId: store.id, label: 'Morning' }] });
    const after = await hr.get('/admin/shift-windows/gaps');
    expect(after.body).toEqual({ total: 2, covered: 2, clients: [] });
  });

  it('the Workforce Manager, who staffs supervisors, can read the picker and the gaps', async () => {
    const { client } = await seedStore();
    const { user: wf } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agent = await loginAs(wf.email);
    expect((await agent.get('/admin/shift-windows/gaps')).status).toBe(200);
    expect((await agent.get(`/admin/shift-windows?clientId=${client.id}`)).status).toBe(200);
    // An associate can't.
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(assoc.email)).get('/admin/shift-windows/gaps')).status).toBe(403);
  });
});

describe("the live board places each punch at its store", () => {
  it('carries the store — the punch\'s own, else its shift\'s — so "My shift" can place it', async () => {
    const { client, store, dana } = await seedStore();
    const a = await createAssociate({ firstName: 'Ann', lastName: 'Lee' });
    const b = await createAssociate({ firstName: 'Ben', lastName: 'Ray' });
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: store.id,
        position: 'Porter',
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 7 * 3_600_000),
        status: 'ASSIGNED',
        assignedAssociateId: a.id,
        publishedAt: new Date(),
      },
    });
    await prisma.timeEntry.createMany({
      data: [
        // Kiosk punch with no stamped site — inherits the shift's store.
        { associateId: a.id, clientId: client.id, shiftId: shift.id, clockInAt: new Date(), status: 'ACTIVE' },
        // Walk-in at the store's kiosk — its own store, no shift.
        { associateId: b.id, clientId: client.id, locationId: store.id, clockInAt: new Date(), status: 'ACTIVE' },
      ],
    });
    const res = await (await loginAs(dana.email)).get('/time/admin/active');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      (res.body.entries as Array<{ associateName: string; locationId: string | null }>).map((e) => [e.associateName, e.locationId]),
    );
    expect(byName).toEqual({ 'Ann Lee': store.id, 'Ben Ray': store.id });
  });
});
