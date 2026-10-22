import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { runShiftAutofillSweep } from '../../lib/shiftAutofill.js';
import { windowCovers } from '../../lib/openShiftInvites.js';
import { zonedDayOfWeek } from '../../lib/timezone.js';

/**
 * Open shifts, Rebroadcast (role walk, ops 11): the manager's "ask again"
 * reaches the eligible bench only — not someone who said no, is off that
 * day, keeps availability that doesn't cover it, or lacks a required
 * qualification — never twice inside half an hour, and quiet hours hold the
 * buzz (the bell lands, email and push wait). Sent and declined are stored
 * and read back per shift for the Open shifts tab.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const TZ = 'America/Chicago';
const SINCE = new Date('2026-06-01T00:00:00.000Z');

async function setup() {
  const client = await createClient('Lakeside Hotels');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: store.id }, data: { timezone: TZ } });
  // Starts in ~30 hours, on the hour, for four hours.
  const startsAt = new Date(Math.ceil((Date.now() + 30 * 3_600_000) / 3_600_000) * 3_600_000);
  const shift = await prisma.shift.create({
    data: {
      clientId: client.id,
      locationId: store.id,
      position: 'Housekeeper',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 4 * 3_600_000),
      status: 'OPEN',
      publishedAt: new Date(Date.now() - 3_600_000),
    },
  });
  const person = async (firstName: string) => {
    const associate = await createAssociate({ firstName, lastName: 'Bench' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    await prisma.associateAssignment.create({ data: { associateId: associate.id, locationId: store.id, startedAt: SINCE } });
    return { associate, user };
  };
  return { client, store, shift, person };
}

describe('POST /open-shifts/:id/rebroadcast', () => {
  it('asks the eligible bench again and skips who said no, who is off, who is unavailable and who is unqualified', async () => {
    const { shift, person } = await setup();
    const ready = await person('Ready');
    const free = await person('Free'); // availability on file that covers the shift
    const declined = await person('Declined');
    const off = await person('Off');
    const busyDay = await person('BusyDay');
    const unqualified = await person('Unqualified');

    const dow = zonedDayOfWeek(shift.startsAt, TZ);
    await prisma.associateAvailability.create({ data: { associateId: free.associate.id, dayOfWeek: dow, startMinute: 0, endMinute: 1440 } });
    await prisma.associateAvailability.create({ data: { associateId: busyDay.associate.id, dayOfWeek: (dow + 3) % 7, startMinute: 0, endMinute: 1440 } });
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shift.startsAt);
    await prisma.availabilityException.create({ data: { associateId: off.associate.id, date: new Date(`${localDay}T00:00:00Z`) } });
    await prisma.openShiftInvite.create({ data: { shiftId: shift.id, associateId: declined.associate.id, declinedAt: new Date() } });
    // A required qualification only Ready and Free hold.
    const qual = await prisma.qualification.create({ data: { code: 'FOOD', name: 'Food handler' } });
    await prisma.shiftQualificationRequirement.create({ data: { shiftId: shift.id, qualificationId: qual.id } });
    for (const p of [ready, free, declined, off, busyDay]) {
      await prisma.associateQualification.create({ data: { associateId: p.associate.id, qualificationId: qual.id } });
    }
    void unqualified;

    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), ops.email);
    const res = await a.post(`/open-shifts/${shift.id}/rebroadcast`).send({});
    expect(res.status).toBe(200);
    await flushPendingNotifications();
    expect(res.body.sent).toBe(2);
    expect(res.body.skipped).toEqual({ declined: 1, timeOff: 1, unavailable: 1, unqualified: 1, recent: 0 });
    expect(res.body.counts).toMatchObject({ shiftId: shift.id, sent: 2, declined: 1 });

    const bells = await prisma.notification.findMany({ where: { category: 'shift_autofill', channel: 'IN_APP' }, select: { recipientUserId: true, subject: true, body: true, linkUrl: true } });
    expect(bells.map((b) => b.recipientUserId).sort()).toEqual([ready.user.id, free.user.id].sort());
    expect(bells[0]!.subject).toBe('Still open: Housekeeper at Lakeside Hotels');
    expect(bells[0]!.linkUrl).toBe(`/marketplace?shift=${shift.id}`);
    // On the store's clock, not New York's.
    const chicago = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(shift.startsAt);
    expect(bells[0]!.body).toContain(chicago);

    // Half an hour has not passed: a second tap asks nobody.
    const again = await a.post(`/open-shifts/${shift.id}/rebroadcast`).send({});
    expect(again.status).toBe(200);
    expect(again.body.sent).toBe(0);
    expect(again.body.skipped.recent).toBe(2);
    const rows = await prisma.openShiftInvite.findMany({ where: { shiftId: shift.id, sendCount: { gt: 0 } } });
    expect(rows.every((r) => r.sendCount === 1)).toBe(true);
  });

  it('counts a person in their quiet hours as held: the bell now, the email and push in the morning', async () => {
    const { shift, person } = await setup();
    const sleeper = await person('Sleeper');
    const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    await prisma.user.update({
      where: { id: sleeper.user.id },
      data: { timezone: 'UTC', quietHoursStart: (nowMin + 1380) % 1440, quietHoursEnd: (nowMin + 60) % 1440 },
    });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), ops.email);
    const res = await a.post(`/open-shifts/${shift.id}/rebroadcast`).send({});
    expect(res.status).toBe(200);
    await flushPendingNotifications();
    expect(res.body).toMatchObject({ sent: 1, held: 1 });
    expect(await prisma.notification.count({ where: { recipientUserId: sleeper.user.id, channel: 'IN_APP' } })).toBe(1);
    const waiting = await prisma.deferredNotification.findMany({ where: { userId: sleeper.user.id, sentAt: null } });
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((w) => w.reason === 'QUIET_HOURS' && w.dueAt.getTime() > Date.now())).toBe(true);
  });

  it('refuses a shift outside the caller’s reach, and one that is no longer open', async () => {
    const { client, shift } = await setup();
    const other = await prisma.site.create({ data: { name: 'Other Store', clientId: client.id, timezone: TZ } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [other.id] } });
    const scoped = await loginAs(agent(), ops.email);
    expect((await scoped.post(`/open-shifts/${shift.id}/rebroadcast`).send({})).status).toBe(404);
    const counts = await scoped.get('/open-shifts/invite-counts');
    expect(counts.status).toBe(200);
    expect(counts.body.counts).toEqual([]);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'CANCELLED' } });
    const r = await a.post(`/open-shifts/${shift.id}/rebroadcast`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe('shift_not_open');
    const assoc = await createAssociate({ firstName: 'Nope' });
    const { user: assocUser } = await createUser({ role: 'ASSOCIATE', associateId: assoc.id });
    const asAssociate = await loginAs(agent(), assocUser.email);
    expect((await asAssociate.post(`/open-shifts/${shift.id}/rebroadcast`).send({})).status).toBe(403);
  });
});

describe('Not for me, and the counts', () => {
  it('records a decline from the open-shift feed, folds the shift away, undoes it, and the counts read it back', async () => {
    const { client, shift, person } = await setup();
    const ann = await person('Ann');
    const bo = await person('Bo');

    // The bench sweep asks both and records the sends.
    const sweep = await runShiftAutofillSweep(prisma, new Date());
    await flushPendingNotifications();
    expect(sweep.invitesSent).toBe(2);
    expect(await prisma.openShiftInvite.count({ where: { shiftId: shift.id, sendCount: 1 } })).toBe(2);

    const annAgent = await loginAs(agent(), ann.user.email);
    const feed = await annAgent.get('/shifts/open');
    expect(feed.status).toBe(200);
    expect(feed.body.shifts[0]).toMatchObject({ id: shift.id, declinedByMe: false, timezone: TZ });
    expect((await annAgent.post(`/open-shifts/${shift.id}/decline`).send({})).status).toBe(200);
    expect((await annAgent.get('/shifts/open')).body.shifts[0].declinedByMe).toBe(true);

    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const m = await loginAs(agent(), ops.email);
    const counts = await m.get('/open-shifts/invite-counts');
    expect(counts.status).toBe(200);
    expect(counts.body.counts).toEqual([{ shiftId: shift.id, sent: 2, declined: 1, lastSentAt: expect.any(String) }]);

    // Someone who said no is not asked again — by Rebroadcast or by the sweep.
    await prisma.openShiftInvite.update({
      where: { shiftId_associateId: { shiftId: shift.id, associateId: bo.associate.id } },
      data: { lastSentAt: new Date(Date.now() - 3_600_000) },
    });
    const rb = await m.post(`/open-shifts/${shift.id}/rebroadcast`).send({});
    expect(rb.status).toBe(200);
    expect(rb.body).toMatchObject({ sent: 1, skipped: { declined: 1 } });
    expect((await prisma.openShiftInvite.findFirstOrThrow({ where: { shiftId: shift.id, associateId: bo.associate.id } })).sendCount).toBe(2);
    await flushPendingNotifications();
    // The invite rows are the record now, not the bell rows.
    await prisma.notification.deleteMany({});
    expect((await runShiftAutofillSweep(prisma, new Date())).invitesSent).toBe(0);

    // Changed their mind.
    expect((await annAgent.delete(`/open-shifts/${shift.id}/decline`)).status).toBe(200);
    expect((await annAgent.get('/shifts/open')).body.shifts[0].declinedByMe).toBe(false);

    // A shift they could never pick up is not theirs to decline.
    const elsewhere = await createClient('Elsewhere Inn');
    const far = await prisma.shift.create({
      data: { clientId: elsewhere.id, position: 'Cook', startsAt: shift.startsAt, endsAt: shift.endsAt, status: 'OPEN', publishedAt: new Date() },
    });
    expect((await annAgent.post(`/open-shifts/${far.id}/decline`).send({})).status).toBe(404);
    void client;
  });
});

describe('windowCovers', () => {
  it('reads availability on the store’s clock, and an overnight shift needs the rest of its first day', () => {
    // 2026-07-01 is a Wednesday (3). 14:00Z is 9:00 in Chicago (CDT).
    const startsAt = new Date('2026-07-01T14:00:00Z');
    const day = { startsAt, endsAt: new Date('2026-07-01T22:00:00Z') };
    expect(windowCovers([{ dayOfWeek: 3, startMinute: 8 * 60, endMinute: 17 * 60 }], day, TZ)).toBe(true);
    expect(windowCovers([{ dayOfWeek: 3, startMinute: 10 * 60, endMinute: 17 * 60 }], day, TZ)).toBe(false);
    expect(windowCovers([{ dayOfWeek: 4, startMinute: 0, endMinute: 1440 }], day, TZ)).toBe(false);
    const night = { startsAt: new Date('2026-07-02T03:00:00Z'), endsAt: new Date('2026-07-02T11:00:00Z') }; // 22:00–06:00 CDT, Wednesday
    expect(windowCovers([{ dayOfWeek: 3, startMinute: 20 * 60, endMinute: 1440 }], night, TZ)).toBe(true);
    expect(windowCovers([{ dayOfWeek: 3, startMinute: 20 * 60, endMinute: 23 * 60 }], night, TZ)).toBe(false);
  });
});
