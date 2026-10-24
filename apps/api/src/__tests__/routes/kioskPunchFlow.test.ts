import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { minuteOfDayInZone } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { generateDeviceToken, hashDeviceToken, hmacPin } from '../../lib/kioskAuth.js';
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';
import { runSopExpirySweep } from '../../lib/storeShiftSop.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * The kiosk punch, as the worker meets it:
 *   - the preflight names them ("Maria L.") and carries their language
 *   - the result says back the shift, on time or late, and hours this week;
 *     a break punch shows the break's time, not the clock-in's
 *   - a supervisor's clock-out held by their shift SOP can submit it at
 *     the tablet (with a reason when items are left) and carry on
 *   - only THIS shift's SOP holds the clock; an earlier shift's never does
 *   - SOPs still open 12 hours after the shift ended expire, flagged
 */

const app = () => createApp();
const H = 3_600_000;
const TZ = 'America/New_York';

beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function kioskFor(clientId: string, locationId: string) {
  const { plaintext, prefix } = generateDeviceToken();
  await prisma.kioskDevice.create({
    data: {
      clientId,
      locationId,
      name: 'Front desk tablet',
      tokenHash: hashDeviceToken(plaintext),
      tokenPrefix: prefix,
      tokenExpiresAt: new Date(Date.now() + 90 * 24 * H),
    },
  });
  return plaintext;
}

async function worker() {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { timezone: TZ, state: 'CA' } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'reyes' });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
  await prisma.user.update({ where: { id: user.id }, data: { language: 'es' } });
  const pin = '4321';
  await prisma.kioskPin.create({ data: { clientId: client.id, associateId: ana.id, pinHmac: hmacPin(pin) } });
  const deviceToken = await kioskFor(client.id, site.id);
  const call = (path: string, body: Record<string, unknown> = {}) => {
    _resetKioskRateLimit();
    return request(app()).post(path).send({ deviceToken, pin, ...body });
  };
  return { client, site, ana, call };
}

describe('the punch, said back', () => {
  it('the preflight names the person with an initial and carries their language', async () => {
    const w = await worker();
    const v = await w.call('/kiosk/verify-pin');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ associateFirstName: 'Ana', associateLastInitial: 'R', language: 'es', predictedAction: 'CLOCK_IN' });
  });

  it('a clock-in says the shift, how late, the meal break and the week; a break shows its own time', async () => {
    pinMidweekNoon();
    const w = await worker();
    const startsAt = new Date(Date.now() - 12 * 60_000);
    await prisma.shift.create({
      data: {
        clientId: w.client.id,
        locationId: w.site.id,
        position: 'Housekeeper',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 8 * H),
        status: 'ASSIGNED',
        assignedAssociateId: w.ana.id,
      },
    });
    const inn = await w.call('/kiosk/punch');
    expect(inn.status).toBe(200);
    expect(inn.body.action).toBe('CLOCK_IN');
    expect(inn.body.summary).toMatchObject({ timezone: TZ, shift: { startsAt: startsAt.toISOString() } });
    expect(inn.body.summary.lateMinutes).toBeGreaterThanOrEqual(11);
    expect(inn.body.summary.lateMinutes).toBeLessThanOrEqual(13);
    // California: a meal break is due five hours in.
    expect(new Date(inn.body.summary.mealDueAt).getTime() - new Date(inn.body.at).getTime()).toBeCloseTo(5 * H, -5);
    expect(inn.body.summary.weekMinutes).toBeGreaterThanOrEqual(0);

    // Backdate the clock-in so the break punch is visibly later.
    const entry = await prisma.timeEntry.findFirstOrThrow({ where: { associateId: w.ana.id, status: 'ACTIVE' } });
    await prisma.timeEntry.update({ where: { id: entry.id }, data: { clockInAt: new Date(Date.now() - 3 * H) } });
    const brk = await w.call('/kiosk/punch', { intent: 'BREAK' });
    expect(brk.body.action).toBe('BREAK_START');
    // The break's own time — not the entry's last write (the clock-in).
    expect(Math.abs(new Date(brk.body.at).getTime() - Date.now())).toBeLessThan(60_000);
    expect(brk.body.summary.weekMinutes).toBeGreaterThanOrEqual(175);
    // Nothing on this shared screen about pay.
    expect(JSON.stringify(brk.body.summary)).not.toMatch(/rate|pay|cents/i);
  });
});

/** A store whose "Swing" window runs from an hour ago to seven hours from
 *  now, a two-item SOP on it, and its shift supervisor at the kiosk. */
async function supervisorStore(opts: { assignSop?: boolean } = {}) {
  const client = await createClient('Front Beach');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: store.id }, data: { timezone: TZ } });
  const mod = (h: number) => minuteOfDayInZone(new Date(Date.now() + h * H), TZ);
  await prisma.staffingTarget.create({
    data: { locationId: store.id, targetCount: 6, effectiveFrom: new Date('2026-01-01'), label: 'Swing', startMinute: mod(-1), endMinute: mod(7) },
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
  const a = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: a.id });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: store.id, startedAt: new Date('2026-01-01') } });
  await prisma.supervisorShiftWindow.create({ data: { userId: sup.id, locationId: store.id, label: 'Swing' } });
  const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
  if (opts.assignSop !== false) {
    const opsAgent = await loginAs(agent(), ops.email);
    expect((await opsAgent.put('/ops/store-shifts').send({ locationId: store.id, label: 'Swing', templateId: template.id })).status).toBe(200);
  }
  const pin = '4321';
  await prisma.kioskPin.create({ data: { clientId: client.id, associateId: a.id, pinHmac: hmacPin(pin) } });
  const deviceToken = await kioskFor(client.id, store.id);
  const call = (path: string, body: Record<string, unknown> = {}) => {
    _resetKioskRateLimit();
    return request(app()).post(path).send({ deviceToken, pin, ...body });
  };
  return { client, store, sup, call };
}

describe('the SOP gate at the tablet', () => {
  it('names what is open; submitting incomplete needs a reason; then the clock-out goes through', async () => {
    const s = await supervisorStore();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    expect((await s.call('/kiosk/punch')).body.action).toBe('CLOCK_IN');

    const held = await s.call('/kiosk/verify-pin');
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe('sop_open');
    expect(held.body.error.details).toMatchObject({ label: 'Swing SOP', requiredOpen: 2, sopDone: 0, sopTotal: 2 });

    const bare = await s.call('/kiosk/sop/submit', {});
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('reason_required');

    // Someone else's number can't submit Dana's SOP.
    const stranger = await s.call('/kiosk/sop/submit', { pin: '9999', reason: 'Leaving now, sorry' });
    expect(stranger.status).toBe(401);
    expect((await prisma.opsShift.findFirstOrThrow({ where: { openedById: s.sup.id } })).status).toBe('ACTIVE');

    const ok = await s.call('/kiosk/sop/submit', { reason: 'Family emergency — leaving early', handoverNote: 'Cooler 2 warm' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ submitted: true, closedIncomplete: true });
    const sop = await prisma.opsShift.findFirstOrThrow({ where: { openedById: s.sup.id } });
    expect(sop).toMatchObject({ status: 'CLOSED', closedIncomplete: true, incompleteReason: 'Family emergency — leaving early', handoverNone: false });
    expect(await prisma.opsHandoverItem.count({ where: { fromShiftId: sop.id } })).toBe(1);

    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: hr.id, category: 'ops.incomplete_close', channel: 'IN_APP' } })).toBe(1);

    const out = await s.call('/kiosk/punch');
    expect(out.status).toBe(200);
    expect(out.body.action).toBe('CLOCK_OUT');
  });

  it("an earlier shift's open SOP never holds today's clock-out — this shift's does", async () => {
    const s = await supervisorStore({ assignSop: false });
    expect((await s.call('/kiosk/punch')).body.action).toBe('CLOCK_IN');
    const old = await prisma.opsShift.create({
      data: {
        clientId: s.client.id,
        locationId: s.store.id,
        department: 'F&D',
        period: 'EVENING',
        position: 'Shift supervisor',
        windowLabel: 'Swing',
        dateKey: '2026-01-01',
        openedById: s.sup.id,
        // Its shift ended before today's clock-in began.
        openedAt: new Date(Date.now() - 10 * H),
        dueAt: new Date(Date.now() - 3 * H),
      },
    });
    const v = await s.call('/kiosk/verify-pin');
    expect(v.status).toBe(200);
    expect(v.body.predictedAction).toBe('CLOCK_OUT');

    // One whose window runs through this shift does hold it.
    await prisma.opsShift.update({ where: { id: old.id }, data: { dueAt: new Date(Date.now() + 2 * H) } });
    expect((await s.call('/kiosk/verify-pin')).status).toBe(409);
  });
});

describe('the SOP expiry sweep', () => {
  it('closes SOPs still open 12 hours after the shift ended as "Expired — not submitted", and flags the desk', async () => {
    const s = await supervisorStore({ assignSop: false });
    const { user: desk } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const base = {
      clientId: s.client.id,
      locationId: s.store.id,
      department: 'F&D',
      period: 'EVENING' as const,
      position: 'Shift supervisor',
      windowLabel: 'Swing',
      dateKey: '2026-09-18',
      openedById: s.sup.id,
    };
    const stale = await prisma.opsShift.create({ data: { ...base, openedAt: new Date(Date.now() - 22 * H), dueAt: new Date(Date.now() - 13 * H) } });
    const recent = await prisma.opsShift.create({ data: { ...base, openedAt: new Date(Date.now() - 20 * H), dueAt: new Date(Date.now() - 11 * H) } });

    expect(await runSopExpirySweep(prisma)).toEqual({ expired: 1 });
    expect(await prisma.opsShift.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
      status: 'CLOSED',
      closedIncomplete: true,
      closedById: null,
    });
    expect((await prisma.opsShift.findUniqueOrThrow({ where: { id: stale.id } })).incompleteReason).toMatch(/^Expired — not submitted/);
    expect((await prisma.opsShift.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe('ACTIVE');
    // Running again does nothing more.
    expect(await runSopExpirySweep(prisma)).toEqual({ expired: 0 });

    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: s.sup.id, subject: { startsWith: 'Your Swing SOP expired' }, channel: 'IN_APP' } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientUserId: desk.id, category: 'ops.sop_expired', channel: 'IN_APP' } })).toBe(1);
  });
});
