import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import {
  generateDeviceToken,
  hashDeviceToken,
  hmacPin,
} from '../../lib/kioskAuth.js';
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Kiosk schedule gate + walk-in clock-in requests.
 *
 * With KIOSK_REQUIRE_SCHEDULED_SHIFT on, a fresh CLOCK_IN needs an
 * ASSIGNED shift covering the punch; a blocked walk-in parks as a
 * ClockInRequest that a supervisor approves (backdated ACTIVE entry) or
 * denies. The suite-wide default is OFF (test/setup.ts); these tests flip
 * the parsed env flag per-test.
 */

const app = () => createApp();

async function setupKiosk() {
  const client = await createClient();
  const location = await prisma.location.findFirstOrThrow({
    where: { clientId: client.id },
  });
  const associate = await createAssociate({ firstName: 'Walk', lastName: 'In' });
  const pin = '7788';
  await prisma.kioskPin.create({
    data: { clientId: client.id, associateId: associate.id, pinHmac: hmacPin(pin) },
  });
  const { plaintext, prefix } = generateDeviceToken();
  await prisma.kioskDevice.create({
    data: {
      clientId: client.id,
      locationId: location.id,
      name: 'Gate kiosk',
      tokenHash: hashDeviceToken(plaintext),
      tokenPrefix: prefix,
      tokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    },
  });
  return { client, location, associate, pin, deviceToken: plaintext };
}

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  expect(r.status).toBe(200);
  return a;
}

async function assignedShiftNow(clientId: string, associateId: string) {
  return prisma.shift.create({
    data: {
      clientId,
      position: 'Associate',
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 7 * 3600_000),
      status: 'ASSIGNED',
      assignedAssociateId: associateId,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
  env.KIOSK_REQUIRE_SCHEDULED_SHIFT = true;
});

afterEach(() => {
  env.KIOSK_REQUIRE_SCHEDULED_SHIFT = false;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('kiosk schedule gate', () => {
  it('blocks an unscheduled clock-in at the keypad and files ONE pending request', async () => {
    const { deviceToken, pin, associate, client } = await setupKiosk();

    const pre = await request(app())
      .post('/kiosk/verify-pin')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(pre.status).toBe(409);
    expect(pre.body.error.code).toBe('not_on_schedule');

    // The punch path enforces too (offline replays skip preflight) and
    // reuses the pending request instead of filing a duplicate.
    const punch = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(punch.status).toBe(409);
    expect(punch.body.error.code).toBe('not_on_schedule');

    const requests = await prisma.clockInRequest.findMany({
      where: { associateId: associate.id },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('PENDING');
    expect(requests[0].clientId).toBe(client.id);
    // No time entry was created.
    expect(
      await prisma.timeEntry.count({ where: { associateId: associate.id } }),
    ).toBe(0);
    // Both refusals left an audit trail in the punch log.
    const rejected = await prisma.kioskPunch.findMany({
      where: { associateId: associate.id, action: 'REJECTED' },
    });
    expect(rejected.length).toBe(2);
  });

  it('lets a scheduled associate clock in, linked to their shift', async () => {
    const { deviceToken, pin, associate, client } = await setupKiosk();
    const shift = await assignedShiftNow(client.id, associate.id);

    const res = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('CLOCK_IN');
    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { associateId: associate.id },
    });
    expect(entry.shiftId).toBe(shift.id);
  });

  it('never gates a clock-out — the schedule can change under an active shift', async () => {
    const { deviceToken, pin, associate, client } = await setupKiosk();
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date(Date.now() - 4 * 3600_000),
        status: 'ACTIVE',
      },
    });
    const res = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('CLOCK_OUT');
  });

  it('stays open when the flag is off', async () => {
    env.KIOSK_REQUIRE_SCHEDULED_SHIFT = false;
    const { deviceToken, pin, associate } = await setupKiosk();
    const res = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('CLOCK_IN');
    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { associateId: associate.id },
    });
    expect(entry.shiftId).toBeNull();
  });
});

describe('clock-in request decisions', () => {
  async function blockedRequest() {
    const kiosk = await setupKiosk();
    await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken: kiosk.deviceToken, pin: kiosk.pin, latitude: null, longitude: null });
    const reqRow = await prisma.clockInRequest.findFirstOrThrow({
      where: { associateId: kiosk.associate.id },
    });
    return { ...kiosk, reqRow };
  }

  it('approve creates an ACTIVE entry backdated to the punch instant', async () => {
    const { reqRow, associate, client } = await blockedRequest();
    const { user } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const sup = await loginAs(user.email);

    const res = await sup.post(`/time/admin/clock-in-requests/${reqRow.id}/approve`);
    expect(res.status).toBe(200);

    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { associateId: associate.id },
    });
    expect(entry.status).toBe('ACTIVE');
    expect(entry.clockInAt.getTime()).toBe(reqRow.requestedAt.getTime());
    expect(entry.clientId).toBe(client.id);

    const decided = await prisma.clockInRequest.findUniqueOrThrow({
      where: { id: reqRow.id },
    });
    expect(decided.status).toBe('APPROVED');
    expect(decided.timeEntryId).toBe(entry.id);

    // Second approve is refused, not double-clocked.
    const again = await sup.post(`/time/admin/clock-in-requests/${reqRow.id}/approve`);
    expect(again.status).toBe(409);
    expect(
      await prisma.timeEntry.count({ where: { associateId: associate.id } }),
    ).toBe(1);
  });

  it('deny records the decision and creates no entry', async () => {
    const { reqRow, associate, client } = await blockedRequest();
    const { user } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const sup = await loginAs(user.email);

    const res = await sup
      .post(`/time/admin/clock-in-requests/${reqRow.id}/deny`)
      .send({ reason: 'Not scheduled today.' });
    expect(res.status).toBe(200);

    const decided = await prisma.clockInRequest.findUniqueOrThrow({
      where: { id: reqRow.id },
    });
    expect(decided.status).toBe('DENIED');
    expect(decided.denyReason).toBe('Not scheduled today.');
    expect(
      await prisma.timeEntry.count({ where: { associateId: associate.id } }),
    ).toBe(0);
  });

  it('refuses to approve a stale request — manual entry is the honest tool', async () => {
    const { reqRow, client } = await blockedRequest();
    await prisma.clockInRequest.update({
      where: { id: reqRow.id },
      data: { requestedAt: new Date(Date.now() - 20 * 3600_000) },
    });
    const { user } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const sup = await loginAs(user.email);
    const res = await sup.post(`/time/admin/clock-in-requests/${reqRow.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('too_old');
  });

  it("clamps supervisors to their own client's requests", async () => {
    const { reqRow } = await blockedRequest();
    const otherClient = await createClient('Other Corp');
    const { user } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: otherClient.id,
    });
    const sup = await loginAs(user.email);

    const list = await sup.get('/time/admin/clock-in-requests');
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(0);

    await sup.post(`/time/admin/clock-in-requests/${reqRow.id}/approve`).expect(404);
    await sup.post(`/time/admin/clock-in-requests/${reqRow.id}/deny`).expect(404);
  });

  it('lists pending requests with names for the approvals page', async () => {
    const { reqRow, client, location } = await blockedRequest();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(user.email);

    const res = await hr.get('/time/admin/clock-in-requests');
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    const row = res.body.requests[0];
    expect(row.id).toBe(reqRow.id);
    expect(row.associateName).toBe('Walk In');
    expect(row.clientName).toBeTruthy();
    expect(row.locationName).toBe(location.name);
    expect(row.status).toBe('PENDING');

    // The approvals badge counts it.
    const count = await hr.get('/approvals/count');
    expect(count.status).toBe(200);
    expect(count.body.clockIns).toBe(1);
    void client;
  });
});
