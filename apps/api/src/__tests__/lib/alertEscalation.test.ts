import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { runShiftReminderSweep } from '../../lib/shiftReminder.js';
import { ESCALATION_LINE, runAlertEscalationSweep } from '../../lib/alertEscalation.js';

/**
 * The store's supervisor first, the office after 30 minutes (owner,
 * 2026-11-02). A possible no-show and projected overtime used to reach HR,
 * Ops and the workforce manager — all emailed — and the store's supervisors
 * at once: 1,590 no-show emails to 15 people in 14 days, 1% of the bell
 * copies ever opened. Now the floor hears first; the office hears when the
 * store has no supervisor for it, or once, 30 minutes on, when nobody there
 * opened it and (a no-show) the person is still missing.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const MIN = 60_000;

async function floor(opts: { supervisor: boolean }) {
  const client = await createClient('Lakeside Market');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
  const supervisor = opts.supervisor ? (await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id })).user : null;
  return { client, store, hr, ops, supervisor };
}

/** An assigned shift that started 20 minutes before `now`, nobody punched in. */
async function missedShift(w: Awaited<ReturnType<typeof floor>>, now: Date) {
  const associate = await createAssociate({ firstName: 'Nadia', lastName: 'Ortiz' });
  const startsAt = new Date(now.getTime() - 20 * MIN);
  const shift = await prisma.shift.create({
    data: {
      clientId: w.client.id,
      locationId: w.store.id,
      position: 'Front End',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * 60 * MIN),
      status: 'ASSIGNED',
      assignedAssociateId: associate.id,
      publishedAt: new Date(now.getTime() - 24 * 60 * MIN),
    },
  });
  return { associate, shift };
}

const bells = (category: string, recipientUserId?: string) =>
  prisma.notification.findMany({
    where: { category, channel: 'IN_APP', ...(recipientUserId ? { recipientUserId } : {}) },
    orderBy: { createdAt: 'asc' },
  });

describe('a possible no-show', () => {
  it('goes to the store’s supervisor only, and is waiting on them', async () => {
    const now = pinMidweekNoon();
    const w = await floor({ supervisor: true });
    const { shift } = await missedShift(w, now);

    expect((await runShiftReminderSweep(prisma, now)).noShows).toBe(1);
    await flushPendingNotifications();

    const rows = await bells('shift_no_show');
    expect(rows.map((n) => n.recipientUserId)).toEqual([w.supervisor!.id]);
    expect(rows[0]!.subject).toBe('Possible no-show — Nadia Ortiz');
    const waiting = await prisma.alertEscalation.findFirstOrThrow({ where: { shiftId: shift.id } });
    expect(waiting).toMatchObject({ kind: 'no_show', category: 'shift_no_show', notifiedUserIds: [w.supervisor!.id], escalatedAt: null, resolvedAt: null });
    expect(waiting.escalateAt.getTime() - waiting.notifiedAt.getTime()).toBe(30 * MIN);

    // Not due yet: nothing moves.
    expect(await runAlertEscalationSweep(prisma, new Date(now.getTime() + 20 * MIN))).toMatchObject({ escalated: 0, resolved: 0 });
  });

  it('goes to the office at once when the store has no supervisor for it, with nothing left waiting', async () => {
    const now = pinMidweekNoon();
    const w = await floor({ supervisor: false });
    await missedShift(w, now);

    expect((await runShiftReminderSweep(prisma, now)).noShows).toBe(1);
    await flushPendingNotifications();

    const rows = await bells('shift_no_show');
    expect(rows.map((n) => n.recipientUserId).sort()).toEqual([w.hr.id, w.ops.id].sort());
    expect(rows[0]!.body).not.toContain(ESCALATION_LINE);
    expect(await prisma.alertEscalation.count()).toBe(0);
  });

  it('reaches the office once, 30 minutes on, when nobody opened it and the person is still missing', async () => {
    const now = pinMidweekNoon();
    const w = await floor({ supervisor: true });
    await missedShift(w, now);
    await runShiftReminderSweep(prisma, now);
    await flushPendingNotifications();

    const later = new Date(now.getTime() + 31 * MIN);
    vi.setSystemTime(later);
    expect(await runAlertEscalationSweep(prisma, later)).toMatchObject({ escalated: 1, resolved: 0 });
    await flushPendingNotifications();

    const office = (await bells('shift_no_show')).filter((n) => n.recipientUserId !== w.supervisor!.id);
    expect(office.map((n) => n.recipientUserId).sort()).toEqual([w.hr.id, w.ops.id].sort());
    expect(office[0]!.subject).toBe('Possible no-show — Nadia Ortiz');
    expect(office[0]!.body).toContain("hasn't clocked in");
    expect(office[0]!.body).toContain(ESCALATION_LINE);
    expect((await prisma.alertEscalation.findFirstOrThrow()).escalatedAt).not.toBeNull();

    // Each row escalates once: the next sweep (and the no-show sweep) send nothing.
    const again = new Date(later.getTime() + 5 * MIN);
    vi.setSystemTime(again);
    expect(await runAlertEscalationSweep(prisma, again)).toMatchObject({ escalated: 0, resolved: 0 });
    expect((await runShiftReminderSweep(prisma, again)).noShows).toBe(0);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { category: 'shift_no_show', channel: 'IN_APP' } })).toBe(3);
  });

  it('stays on the floor when the supervisor opened it', async () => {
    const now = pinMidweekNoon();
    const w = await floor({ supervisor: true });
    await missedShift(w, now);
    await runShiftReminderSweep(prisma, now);
    await flushPendingNotifications();

    const [mine] = await bells('shift_no_show', w.supervisor!.id);
    await prisma.notification.update({ where: { id: mine!.id }, data: { readAt: new Date(now.getTime() + 4 * MIN) } });

    const later = new Date(now.getTime() + 31 * MIN);
    vi.setSystemTime(later);
    expect(await runAlertEscalationSweep(prisma, later)).toMatchObject({ escalated: 0, resolved: 1 });
    await flushPendingNotifications();
    expect((await bells('shift_no_show')).map((n) => n.recipientUserId)).toEqual([w.supervisor!.id]);
    expect((await prisma.alertEscalation.findFirstOrThrow()).resolvedAt).not.toBeNull();
  });

  it('is settled when they clock in, or the shift goes to someone else', async () => {
    const now = pinMidweekNoon();
    const w = await floor({ supervisor: true });
    const late = await missedShift(w, now);
    const swapped = await missedShift(w, now);
    await runShiftReminderSweep(prisma, now);
    await flushPendingNotifications();
    expect(await prisma.alertEscalation.count()).toBe(2);

    // Nadia walks in 25 minutes late; the other shift is handed to a cover.
    await prisma.timeEntry.create({
      data: { associateId: late.associate.id, shiftId: late.shift.id, clockInAt: new Date(now.getTime() + 25 * MIN), status: 'ACTIVE' },
    });
    const cover = await createAssociate({ firstName: 'Cover', lastName: 'Person' });
    await prisma.shift.update({ where: { id: swapped.shift.id }, data: { assignedAssociateId: cover.id } });

    const later = new Date(now.getTime() + 31 * MIN);
    vi.setSystemTime(later);
    expect(await runAlertEscalationSweep(prisma, later)).toMatchObject({ escalated: 0, resolved: 2 });
    await flushPendingNotifications();
    expect((await bells('shift_no_show')).every((n) => n.recipientUserId === w.supervisor!.id)).toBe(true);
  });
});

describe('projected overtime', () => {
  /** Three 16-hour shifts Wed–Fri from a Tuesday noon: 48 hours left in the org week. */
  async function longWeek(w: Awaited<ReturnType<typeof floor>>) {
    const associate = await createAssociate({ firstName: 'Over', lastName: 'Time' });
    const now = new Date('2026-09-01T12:00:00.000Z');
    for (const day of ['02', '03', '04']) {
      await prisma.shift.create({
        data: {
          clientId: w.client.id,
          position: 'Associate',
          startsAt: new Date(`2026-09-${day}T06:00:00.000Z`),
          endsAt: new Date(`2026-09-${day}T22:00:00.000Z`),
          status: 'ASSIGNED',
          assignedAssociateId: associate.id,
          publishedAt: now,
        },
      });
    }
    vi.useFakeTimers({ toFake: ['Date'], now });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    return { associate, now };
  }

  it('goes to the supervisor first, and to the office 30 minutes on if they never opened it', async () => {
    const w = await floor({ supervisor: true });
    const { associate, now } = await longWeek(w);
    expect((await runShiftReminderSweep(prisma, now)).otAlerts).toBe(1);
    await flushPendingNotifications();
    expect((await bells('ot_radar')).map((n) => n.recipientUserId)).toEqual([w.supervisor!.id]);
    expect(await prisma.alertEscalation.findFirstOrThrow()).toMatchObject({ kind: 'ot_radar', associateId: associate.id, weekKey: '2026-08-29' });

    const later = new Date(now.getTime() + 31 * MIN);
    vi.setSystemTime(later);
    expect(await runAlertEscalationSweep(prisma, later)).toMatchObject({ escalated: 1 });
    await flushPendingNotifications();
    const office = (await bells('ot_radar')).filter((n) => n.recipientUserId !== w.supervisor!.id);
    expect(office.map((n) => n.recipientUserId).sort()).toEqual([w.hr.id, w.ops.id].sort());
    expect(office[0]!.subject).toBe('Overtime ahead — Over Time');
    expect(office[0]!.body).toContain(ESCALATION_LINE);
  });

  it('stays with the supervisor who opened it', async () => {
    const w = await floor({ supervisor: true });
    const { now } = await longWeek(w);
    await runShiftReminderSweep(prisma, now);
    await flushPendingNotifications();
    await prisma.notification.updateMany({ where: { recipientUserId: w.supervisor!.id, category: 'ot_radar' }, data: { readAt: now } });

    const later = new Date(now.getTime() + 31 * MIN);
    vi.setSystemTime(later);
    expect(await runAlertEscalationSweep(prisma, later)).toMatchObject({ escalated: 0, resolved: 1 });
    await flushPendingNotifications();
    expect((await bells('ot_radar')).map((n) => n.recipientUserId)).toEqual([w.supervisor!.id]);
  });
});
