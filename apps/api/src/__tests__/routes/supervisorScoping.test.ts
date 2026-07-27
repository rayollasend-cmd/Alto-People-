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

/**
 * SHIFT_SUPERVISOR is a client-bounded role. These tests pin the tenant
 * boundary on the surfaces that used to leak org-wide: time-off decisions,
 * kiosk PINs/punches/selfies/devices, shift templates (incl. the apply
 * path that creates shifts), marketplace claim decisions, and the
 * approvals badge counts.
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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

async function placeAtSite(associateId: string, clientId: string) {
  const location = await prisma.location.create({
    data: { clientId, name: `Site ${Math.random().toString(36).slice(2, 8)}` },
  });
  await prisma.associateAssignment.create({
    data: { associateId, locationId: location.id, startedAt: new Date('2026-01-01') },
  });
  return location;
}

/** A supervisor bound to `clientId`, plus one associate at each of two sites. */
async function seedTwoClients() {
  const mine = await createClient('Mine LLC');
  const other = await createClient('Other Corp');
  const myAssoc = await createAssociate({ firstName: 'My', lastName: 'Person' });
  const otherAssoc = await createAssociate({ firstName: 'Their', lastName: 'Person' });
  await placeAtSite(myAssoc.id, mine.id);
  await placeAtSite(otherAssoc.id, other.id);
  const { user: supUser } = await createUser({
    role: 'SHIFT_SUPERVISOR',
    clientId: mine.id,
  });
  const sup = await loginAs(supUser.email);
  return { mine, other, myAssoc, otherAssoc, sup };
}

describe('time-off tenant boundary', () => {
  it('supervisor sees only their client, and cannot decide across it', async () => {
    const { myAssoc, otherAssoc, sup } = await seedTwoClients();
    const mkRequest = (associateId: string) =>
      prisma.timeOffRequest.create({
        data: {
          associateId,
          category: 'PTO',
          startDate: new Date('2026-08-03T00:00:00Z'),
          endDate: new Date('2026-08-04T00:00:00Z'),
          requestedMinutes: 960,
          status: 'PENDING',
        },
      });
    const mineReq = await mkRequest(myAssoc.id);
    const theirsReq = await mkRequest(otherAssoc.id);

    const list = await sup.get('/time-off/admin/requests');
    expect(list.status).toBe(200);
    const ids = list.body.requests.map((r: { id: string }) => r.id);
    expect(ids).toContain(mineReq.id);
    expect(ids).not.toContain(theirsReq.id);

    // Deciding the other tenant's request 404s (no existence leak) and
    // the row is untouched.
    const deny = await sup
      .post(`/time-off/admin/requests/${theirsReq.id}/deny`)
      .send({ note: 'nope' });
    expect(deny.status).toBe(404);
    const after = await prisma.timeOffRequest.findUniqueOrThrow({
      where: { id: theirsReq.id },
    });
    expect(after.status).toBe('PENDING');

    // Bulk: the cross-tenant id fails per-row, own-tenant id succeeds.
    const bulk = await sup
      .post('/time-off/admin/requests/bulk-decide')
      .send({ ids: [mineReq.id, theirsReq.id], decision: 'DENY', note: 'coverage' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.decided).toBe(1);
    expect(bulk.body.failed).toHaveLength(1);
    expect(bulk.body.failed[0].id).toBe(theirsReq.id);
  });
});

describe('kiosk tenant boundary', () => {
  it('PIN list is clamped and cross-tenant device mutations 404', async () => {
    const { mine, other, myAssoc, otherAssoc, sup } = await seedTwoClients();
    await prisma.kioskPin.create({
      data: {
        clientId: mine.id,
        associateId: myAssoc.id,
        pinHmac: Buffer.from('a'.repeat(32)),
      },
    });
    await prisma.kioskPin.create({
      data: {
        clientId: other.id,
        associateId: otherAssoc.id,
        pinHmac: Buffer.from('b'.repeat(32)),
      },
    });

    // Requesting the OTHER client explicitly still returns only mine.
    const pins = await sup.get(`/kiosk-pins?clientId=${other.id}`);
    expect(pins.status).toBe(200);
    expect(pins.body.pins).toHaveLength(1);
    expect(pins.body.pins[0].clientId).toBe(mine.id);

    const otherLoc = await prisma.location.findFirstOrThrow({
      where: { clientId: other.id },
    });
    const otherDevice = await prisma.kioskDevice.create({
      data: {
        clientId: other.id,
        locationId: otherLoc.id,
        name: 'Their tablet',
        tokenHash: 'c'.repeat(64),
        tokenPrefix: 'thx',
      },
    });
    expect((await sup.post(`/kiosk-devices/${otherDevice.id}/revoke`)).status).toBe(404);
    expect((await sup.delete(`/kiosk-devices/${otherDevice.id}`)).status).toBe(404);
    const still = await prisma.kioskDevice.findUnique({ where: { id: otherDevice.id } });
    expect(still?.isActive).toBe(true);

    const devices = await sup.get('/kiosk-devices');
    expect(devices.status).toBe(200);
    expect(
      devices.body.devices.find((d: { id: string }) => d.id === otherDevice.id),
    ).toBeUndefined();
  });

  it('cross-tenant punch selfies are unreachable', async () => {
    const { other, otherAssoc, sup } = await seedTwoClients();
    const otherLoc = await prisma.location.findFirstOrThrow({
      where: { clientId: other.id },
    });
    const device = await prisma.kioskDevice.create({
      data: {
        clientId: other.id,
        locationId: otherLoc.id,
        name: 'Their tablet',
        tokenHash: 'd'.repeat(64),
        tokenPrefix: 'thy',
      },
    });
    const punch = await prisma.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        associateId: otherAssoc.id,
        action: 'CLOCK_IN',
        selfie: Buffer.from('jpegbytes'),
      },
    });
    expect((await sup.get(`/kiosk-punches/${punch.id}/selfie`)).status).toBe(404);
  });
});

describe('shift template tenant boundary', () => {
  it('create is pinned to own client; cross-tenant apply is rejected', async () => {
    const { mine, other, sup } = await seedTwoClients();

    // Creating for the other client (or globally) is forbidden.
    const forOther = await sup.post('/scheduling/templates').send({
      clientId: other.id,
      name: 'Sneaky',
      position: 'Server',
      dayOfWeek: 1,
      startMinute: 540,
      endMinute: 1020,
    });
    expect(forOther.status).toBe(403);

    const forMine = await sup.post('/scheduling/templates').send({
      clientId: mine.id,
      name: 'Legit',
      position: 'Server',
      dayOfWeek: 1,
      startMinute: 540,
      endMinute: 1020,
    });
    expect(forMine.status).toBe(201);

    // An admin-made template for the other client can't be applied or
    // deleted by the supervisor.
    const theirs = await prisma.shiftTemplate.create({
      data: {
        clientId: other.id,
        name: 'Theirs',
        position: 'Server',
        dayOfWeek: 1,
        startMinute: 540,
        endMinute: 1020,
      },
    });
    const apply = await sup
      .post(`/scheduling/templates/${theirs.id}/apply`)
      .send({ weekStart: '2026-06-08T00:00:00.000Z' });
    expect(apply.status).toBe(403);
    expect(await prisma.shift.count({ where: { clientId: other.id } })).toBe(0);
    expect((await sup.delete(`/scheduling/templates/${theirs.id}`)).status).toBe(404);

    // The list never shows the other client's template.
    const list = await sup.get('/scheduling/templates');
    expect(list.status).toBe(200);
    expect(
      list.body.templates.find((t: { id: string }) => t.id === theirs.id),
    ).toBeUndefined();
  });
});

describe('marketplace claim decisions', () => {
  it('supervisor can decide claims at their client, not across the boundary', async () => {
    const { mine, other, myAssoc, otherAssoc, sup } = await seedTwoClients();
    const mkShiftAndClaim = async (clientId: string, associateId: string) => {
      const loc = await prisma.location.findFirstOrThrow({ where: { clientId } });
      const shift = await prisma.shift.create({
        data: {
          clientId,
          locationId: loc.id,
          position: 'Server',
          startsAt: new Date('2026-08-10T13:00:00Z'),
          endsAt: new Date('2026-08-10T21:00:00Z'),
          status: 'OPEN',
          publishedAt: new Date(),
        },
      });
      const claim = await prisma.openShiftClaim.create({
        data: { shiftId: shift.id, associateId, status: 'PENDING' },
      });
      return { shift, claim };
    };
    const minePair = await mkShiftAndClaim(mine.id, myAssoc.id);
    const theirPair = await mkShiftAndClaim(other.id, otherAssoc.id);

    // Own client: the old hardcoded role allowlist locked supervisors out
    // — the capability gate now lets them decide.
    const ok = await sup
      .put(`/shifts/${minePair.shift.id}/claims/${minePair.claim.id}`)
      .send({ status: 'APPROVED' });
    expect(ok.status).toBe(200);

    // Cross-tenant: 404, untouched.
    const not = await sup
      .put(`/shifts/${theirPair.shift.id}/claims/${theirPair.claim.id}`)
      .send({ status: 'APPROVED' });
    expect(not.status).toBe(404);
    const after = await prisma.openShiftClaim.findUniqueOrThrow({
      where: { id: theirPair.claim.id },
    });
    expect(after.status).toBe('PENDING');

    // The pending queue only shows own-client claims.
    const pending = await sup.get('/shifts/claims/pending');
    expect(pending.status).toBe(200);
    expect(
      pending.body.claims.find((c: { id: string }) => c.id === theirPair.claim.id),
    ).toBeUndefined();
  });
});

describe('approvals badge', () => {
  it('counts are scoped to the supervisor client', async () => {
    const { myAssoc, otherAssoc, sup } = await seedTwoClients();
    const mk = (associateId: string) =>
      prisma.timeOffRequest.create({
        data: {
          associateId,
          category: 'PTO',
          startDate: new Date('2026-08-03T00:00:00Z'),
          endDate: new Date('2026-08-04T00:00:00Z'),
          requestedMinutes: 480,
          status: 'PENDING',
        },
      });
    await mk(myAssoc.id);
    await mk(otherAssoc.id);
    const res = await sup.get('/approvals/count');
    expect(res.status).toBe(200);
    expect(res.body.timeOff).toBe(1);
  });
});
