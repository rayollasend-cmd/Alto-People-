import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * F500 G5, the ops manager's and the line manager's homes:
 *
 *   - the floor's activity names who published what, for which store and
 *     which days — one row per store and day, not eight "1 shift published";
 *     an incident leads with where, in words;
 *   - /workforce/overview carries the per-store numbers the ops home's
 *     "Stores today" board reads (scheduled today, call-outs, confirmed
 *     tomorrow) and the counts behind the week's fill rate — a store-bound
 *     caller's week is their store's;
 *   - a line manager's "crew" at risk is their team, not the company.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ET = 'America/New_York';
const keyIn = (d: Date, tz = ET) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const plusDays = (key: string, n: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthDay = (key: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
const dayWords = (key: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));

describe('GET /ops-activity — who published what, where, for which days', () => {
  it('groups a publish by store and day, names the publisher and the week, and words an incident by place', async () => {
    const coastal = await createClient('Coastal Resort');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
    const seaside = await createClient('Seaside');
    const { user: dana } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: dana.id }, data: { displayName: 'Dana Reyes' } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { displayName: 'Omar Lead' } });

    // The coming company week (Saturday start): Sat, Sun and Mon of it.
    const today = new Date().toISOString().slice(0, 10);
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const sat = plusDays(today, ((6 - dow + 7) % 7) || 7);
    const at = (key: string) => new Date(`${key}T15:00:00Z`);

    // Dana published three shifts as she created them, an hour ago.
    const publishedAt = new Date(Date.now() - HOUR);
    for (const key of [sat, plusDays(sat, 1), plusDays(sat, 2)]) {
      await prisma.shift.create({
        data: { clientId: coastal.id, locationId: site.id, position: 'Housekeeper', startsAt: at(key), endsAt: new Date(at(key).getTime() + 8 * HOUR), status: 'OPEN', publishedAt, createdAt: publishedAt, createdById: dana.id },
      });
    }
    // A draft Omar published three days later than it was made: named by the audit row.
    const weekAgo = new Date(Date.now() - 3 * DAY);
    const draft = await prisma.shift.create({
      data: { clientId: coastal.id, locationId: site.id, position: 'Houseman', startsAt: at(plusDays(sat, 7)), endsAt: new Date(at(plusDays(sat, 7)).getTime() + 8 * HOUR), status: 'OPEN', publishedAt: weekAgo, createdAt: new Date(weekAgo.getTime() - 3 * DAY) },
    });
    await prisma.auditLog.create({ data: { actorUserId: ops.id, action: 'shift.updated', entityType: 'Shift', entityId: draft.id, createdAt: new Date(weekAgo.getTime() + 500) } });
    // Nobody on record: the row says what, not who.
    await prisma.shift.create({
      data: { clientId: seaside.id, position: 'Cashier', startsAt: at(sat), endsAt: new Date(at(sat).getTime() + 6 * HOUR), status: 'OPEN', publishedAt: new Date(Date.now() - 2 * DAY) },
    });
    await prisma.oshaIncident.create({
      data: { clientId: coastal.id, locationId: site.id, occurredAt: new Date(Date.now() - 4 * HOUR), description: 'Cut on the left hand from a box cutter.', severity: 'DAYS_AWAY' },
    });

    const hr = await loginAs(agent(), dana.email);
    const res = await hr.get('/ops-activity');
    expect(res.status).toBe(200);
    const published = res.body.items.filter((i: { kind: string }) => i.kind === 'published');
    expect(published).toHaveLength(3);
    expect(published[0]).toMatchObject({ title: 'Dana Reyes published 3 shifts · Coastal Resort', detail: `Week of ${monthDay(sat)}` });
    expect(published[0].href).toBe(`/scheduling?view=week&week=${sat}&client=${coastal.id}&location=${site.id}`);
    expect(published.find((i: { title: string }) => i.title.startsWith('1 shift published'))).toMatchObject({ title: '1 shift published · Seaside', detail: dayWords(sat) });
    expect(published.find((i: { title: string }) => i.title.startsWith('Omar'))).toMatchObject({ title: 'Omar Lead published 1 shift · Coastal Resort', detail: dayWords(plusDays(sat, 7)) });

    const incident = res.body.items.find((i: { kind: string }) => i.kind === 'incident');
    expect(incident).toMatchObject({ title: 'Coastal Resort · Injury — days away from work', detail: 'Cut on the left hand from a box cutter.' });
    expect(JSON.stringify(res.body)).not.toMatch(/DAYS_AWAY|Incident reported/);
  });
});

describe('GET /workforce/overview — the per-store board and the week behind the rate', () => {
  it('counts scheduled today, call-outs today and confirmed tomorrow per store, and the shifts behind the fill rate', async () => {
    const now = Date.now();
    const store = await createClient('Front Beach 218');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });
    // Live now and assigned; live now and still open.
    await prisma.shift.create({ data: { clientId: store.id, assignedAssociateId: ana.id, position: 'Stocker', startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), status: 'ASSIGNED', publishedAt: new Date(now - DAY) } });
    await prisma.shift.create({ data: { clientId: store.id, position: 'Stocker', startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), status: 'OPEN', publishedAt: new Date(now - DAY) } });
    // Tomorrow: one confirmed, one not yet.
    const tomorrow = new Date(`${plusDays(keyIn(new Date()), 1)}T17:00:00Z`);
    await prisma.shift.create({ data: { clientId: store.id, assignedAssociateId: ana.id, position: 'Stocker', startsAt: tomorrow, endsAt: new Date(tomorrow.getTime() + 4 * HOUR), status: 'ASSIGNED', publishedAt: new Date(now - DAY), acknowledgedAt: new Date(now - HOUR) } });
    await prisma.shift.create({ data: { clientId: store.id, assignedAssociateId: ben.id, position: 'Stocker', startsAt: tomorrow, endsAt: new Date(tomorrow.getTime() + 4 * HOUR), status: 'ASSIGNED', publishedAt: new Date(now - DAY) } });
    // Ben called out today.
    await prisma.attendanceEvent.create({ data: { associateId: ben.id, clientId: store.id, kind: 'CALL_OUT', points: 1, occurredOn: new Date(`${keyIn(new Date())}T00:00:00Z`) } });

    const { user: opsUser } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const ops = await loginAs(agent(), opsUser.email);
    const res = await ops.get('/workforce/overview');
    expect(res.status).toBe(200);
    const row = res.body.today.stores.find((s: { clientName: string }) => s.clientName === 'Front Beach 218');
    expect(row).toMatchObject({ scheduledToday: 1, scheduledNow: 1, openToday: 1, callOutsToday: 1, confirmedTomorrow: 1, unconfirmedTomorrow: 1 });
    // The rate's own counts: 1 filled of the 2 shifts live today (tomorrow may sit in next week).
    expect(res.body.week.filled).toBeGreaterThanOrEqual(1);
    expect(res.body.week.total).toBeGreaterThanOrEqual(2);
    expect(res.body.week.fillRatePct).toBe(Math.round((res.body.week.filled / res.body.week.total) * 100));
  });

  it("keeps a store later today on the board, and a store-bound supervisor's week to their store", async () => {
    pinMidweekNoon();
    const now = Date.now();
    const mine = await createClient('Mine');
    const theirs = await createClient('Theirs');
    const ana = await createAssociate();
    // Mine: one assigned shift spanning now. Theirs: three open shifts spanning now.
    await prisma.shift.create({ data: { clientId: mine.id, assignedAssociateId: ana.id, position: 'Stocker', startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), status: 'ASSIGNED', publishedAt: new Date(now - DAY) } });
    for (let i = 0; i < 3; i += 1) {
      await prisma.shift.create({ data: { clientId: theirs.id, position: 'Stocker', startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), status: 'OPEN', publishedAt: new Date(now - DAY) } });
    }
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const s = await loginAs(agent(), sup.email);
    const res = await s.get('/workforce/overview');
    expect(res.status).toBe(200);
    // Their store's three open shifts are not this supervisor's week.
    expect(res.body.week).toMatchObject({ filled: 1, total: 1, fillRatePct: 100 });
    expect(JSON.stringify(res.body.today.stores)).not.toMatch(/Theirs/);
  });
});

describe('GET /retention/crew — a manager’s crew is their team', () => {
  it('counts the manager’s direct reports only, and says whose crew it is', async () => {
    const boss = await createAssociate({ firstName: 'Mia', lastName: 'Boss' });
    const report = await createAssociate({ firstName: 'Rae', lastName: 'Report' });
    const stranger = await createAssociate({ firstName: 'Sam', lastName: 'Stranger' });
    await prisma.associate.update({ where: { id: report.id }, data: { managerId: boss.id } });
    const risk = (associateId: string, band: 'HIGH' | 'MEDIUM') =>
      prisma.flightRisk.create({ data: { associateId, score: band === 'HIGH' ? 60 : 30, band, reasons: [], plays: [], computedAt: new Date() } });
    await risk(report.id, 'MEDIUM');
    await risk(stranger.id, 'HIGH');

    const { user: mgr } = await createUser({ role: 'MANAGER', associateId: boss.id });
    const m = await loginAs(agent(), mgr.email);
    const mine = await m.get('/retention/crew');
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ high: 0, medium: 1, scope: 'team' });

    // A manager with no associate record has no team to count.
    const { user: unlinked } = await createUser({ role: 'MANAGER' });
    const u = await loginAs(agent(), unlinked.email);
    expect((await u.get('/retention/crew')).body).toEqual({ high: 0, medium: 0, scope: 'team' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(agent(), hr.email);
    expect((await h.get('/retention/crew')).body).toEqual({ high: 1, medium: 1, scope: 'reach' });
  });
});

describe('GET /team/reports — the roster names its photos', () => {
  it('sends photoUrl, null when there is no headshot, so the roster asks for no photo that would 404', async () => {
    const boss = await createAssociate({ firstName: 'Mia', lastName: 'Boss' });
    const withPhoto = await createAssociate({ firstName: 'Pat', lastName: 'Photo' });
    const without = await createAssociate({ firstName: 'Nia', lastName: 'Nophoto' });
    const at = new Date('2026-10-01T12:00:00Z');
    await prisma.associate.update({ where: { id: withPhoto.id }, data: { managerId: boss.id, photoS3Key: 'photos/pat.jpg', photoUpdatedAt: at } });
    await prisma.associate.update({ where: { id: without.id }, data: { managerId: boss.id } });
    const { user: mgr } = await createUser({ role: 'MANAGER', associateId: boss.id });
    const m = await loginAs(agent(), mgr.email);
    const res = await m.get('/team/reports');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.reports.map((r: { firstName: string; photoUrl: string | null }) => [r.firstName, r.photoUrl]));
    expect(byName).toEqual({ Pat: `/api/associates/${withPhoto.id}/photo?v=${at.getTime()}`, Nia: null });
  });
});
