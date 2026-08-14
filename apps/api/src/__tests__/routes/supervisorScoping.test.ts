import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * SHIFT_SUPERVISOR is a client-bounded role. These tests pin the tenant
 * boundary on the surfaces that used to leak org-wide: time-off decisions,
 * kiosk PINs/punches/selfies/devices, shift templates (incl. the apply
 * path that creates shifts), marketplace claim decisions, the approvals
 * badge counts, and onboarding applications.
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

/**
 * Supervisors hold invite:onboarding (send/resend/nudge + watch progress)
 * but NOT manage:onboarding (approve/reject, I-9 Section 2, applicant PII).
 * These pin both halves — the capability split and the tenant boundary that
 * scopeApplications was missing entirely before this feature.
 */
describe('onboarding tenant boundary', () => {
  it('supervisor invites into their own client and is clamped to it', async () => {
    const { mine, other, sup } = await seedTwoClients();
    const template = await createStandardTemplate();
    // mine has TWO sites here (the createClient fixture's default plus
    // placeAtSite's). Pick one and deactivate the rest so the auto-assign
    // case below sees a single-site client.
    const mySite = await prisma.location.findFirstOrThrow({
      where: { clientId: mine.id },
    });
    await prisma.location.updateMany({
      where: { clientId: mine.id, id: { not: mySite.id } },
      data: { isActive: false },
    });

    const ok = await sup.post('/onboarding/applications/bulk').send({
      clientId: mine.id,
      locationId: mySite.id,
      templateId: template.id,
      applicants: [
        { email: 'floor.hire@example.com', firstName: 'Floor', lastName: 'Hire' },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.succeeded).toBe(1);
    expect(ok.body.failed).toBe(0);

    // Asking for the other tenant lands on their own client anyway — the
    // dialog preselecting the client is convenience, not a control. The
    // location is validated against the CLAMPED client, so their own site
    // passes while the other tenant's would be a mismatch.
    const clamped = await sup.post('/onboarding/applications/bulk').send({
      clientId: other.id,
      locationId: mySite.id,
      templateId: template.id,
      applicants: [
        { email: 'poached@example.com', firstName: 'Poach', lastName: 'Ed' },
      ],
    });
    expect(clamped.status).toBe(200);
    expect(clamped.body.succeeded).toBe(1);
    const poached = await prisma.application.findFirstOrThrow({
      where: { associate: { email: 'poached@example.com' } },
    });
    expect(poached.clientId).toBe(mine.id);
    expect(poached.locationId).toBe(mySite.id);

    // A single-site client picks itself: omitting the site auto-assigns
    // the only location instead of erroring — the client effectively IS
    // the work site until a second store appears.
    const auto = await sup.post('/onboarding/applications/bulk').send({
      clientId: mine.id,
      templateId: template.id,
      applicants: [
        { email: 'auto.site@example.com', firstName: 'Auto', lastName: 'Site' },
      ],
    });
    expect(auto.status).toBe(200);
    expect(auto.body.succeeded).toBe(1);
    const autoApp = await prisma.application.findFirstOrThrow({
      where: { associate: { email: 'auto.site@example.com' } },
    });
    expect(autoApp.locationId).toBe(mySite.id);

    // With a SECOND active site the choice is ambiguous — the site applies
    // to the whole batch, so it's one clear 400 up front (not N identical
    // row errors). A location-less invite would leave the associate's site
    // unrecorded forever (approval only opens an assignment when it's set).
    await prisma.location.updateMany({
      where: { clientId: mine.id },
      data: { isActive: true },
    });
    const missing = await sup.post('/onboarding/applications/bulk').send({
      clientId: mine.id,
      templateId: template.id,
      applicants: [
        { email: 'no.site@example.com', firstName: 'No', lastName: 'Site' },
      ],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe('location_required');
  });

  it('invite-locations serves the picker to supervisors, clamped to their client', async () => {
    const { mine, other, sup } = await seedTwoClients();
    const mySite = await prisma.location.findFirstOrThrow({
      where: { clientId: mine.id },
    });

    // Their own client's sites load (they have no view:clients, so the
    // /clients locations route is closed to them — this one isn't).
    const res = await sup.get(`/onboarding/invite-locations?clientId=${mine.id}`);
    expect(res.status).toBe(200);
    expect(res.body.locations.map((l: { id: string }) => l.id)).toContain(mySite.id);

    // Asking for the other tenant is clamped to their own — no site names
    // leak across the boundary.
    const clamped = await sup.get(`/onboarding/invite-locations?clientId=${other.id}`);
    expect(clamped.status).toBe(200);
    const ids = clamped.body.locations.map((l: { id: string }) => l.id);
    expect(ids).toContain(mySite.id);
    const otherSite = await prisma.location.findFirstOrThrow({
      where: { clientId: other.id },
    });
    expect(ids).not.toContain(otherSite.id);
  });

  it('supervisor lists only their own client applications', async () => {
    const { mine, other, myAssoc, otherAssoc, sup } = await seedTwoClients();
    const mineApp = await createApplicationWithChecklist({
      associateId: myAssoc.id,
      clientId: mine.id,
    });
    const theirsApp = await createApplicationWithChecklist({
      associateId: otherAssoc.id,
      clientId: other.id,
    });

    const list = await sup.get('/onboarding/applications?status=ALL');
    expect(list.status).toBe(200);
    const ids = list.body.applications.map((r: { id: string }) => r.id);
    expect(ids).toContain(mineApp.id);
    expect(ids).not.toContain(theirsApp.id);

    // Progress on their own client is readable — that's the point of the role.
    const detail = await sup.get(`/onboarding/applications/${mineApp.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.tasks.length).toBeGreaterThan(0);
    expect(detail.body.percentComplete).toBe(0);

    // The other tenant 404s rather than 403 — no existence leak.
    expect((await sup.get(`/onboarding/applications/${theirsApp.id}`)).status).toBe(404);
  });

  it('supervisor cannot review an application or read applicant PII', async () => {
    const { mine, myAssoc, sup } = await seedTwoClients();
    const template = await createStandardTemplate();
    const app = await createApplicationWithChecklist({
      associateId: myAssoc.id,
      clientId: mine.id,
    });

    // HR review powers — blocked at the capability guard.
    expect(
      (await sup.post(`/onboarding/applications/${app.id}/approve`).send({
        hireDate: '2026-09-01',
      })).status,
    ).toBe(403);
    expect(
      (await sup.post(`/onboarding/applications/${app.id}/reject`).send({
        reason: 'no',
      })).status,
    ).toBe(403);
    expect(
      (await sup.post(`/onboarding/applications/${app.id}/i9/section2`).send({
        documentList: 'LIST_A',
        supportingDocIds: ['00000000-0000-0000-0000-000000000001'],
      })).status,
    ).toBe(403);

    // Single-invite carries hireRole, which would let a supervisor mint an
    // admin account — stays on manage:onboarding for exactly that reason.
    expect(
      (await sup.post('/onboarding/applications').send({
        associateEmail: 'confederate@example.com',
        associateFirstName: 'Con',
        associateLastName: 'Federate',
        clientId: mine.id,
        templateId: template.id,
        hireRole: 'OPERATIONS_MANAGER',
      })).status,
    ).toBe(403);

    // Applicant PII on their OWN client — scope passes, capability doesn't.
    expect((await sup.get(`/onboarding/applications/${app.id}/w4`)).status).toBe(403);
    expect((await sup.get(`/onboarding/applications/${app.id}/i9`)).status).toBe(403);
    expect((await sup.get(`/onboarding/applications/${app.id}/profile`)).status).toBe(403);
    expect(
      (await sup.get(`/onboarding/applications/${app.id}/i9/documents`)).status,
    ).toBe(403);
    expect(
      (await sup.get(`/onboarding/applications/${app.id}/esign/agreements`)).status,
    ).toBe(403);

    // ...and cannot write it either.
    expect(
      (await sup.post(`/onboarding/applications/${app.id}/w4`).send({
        filingStatus: 'SINGLE',
        multipleJobs: false,
        dependentsAmount: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
        signature: 'Not Me',
      })).status,
    ).toBe(403);
  });

  it('HR admin keeps full access to the same surfaces', async () => {
    const { mine, other, myAssoc, otherAssoc } = await seedTwoClients();
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);
    const mineApp = await createApplicationWithChecklist({
      associateId: myAssoc.id,
      clientId: mine.id,
    });
    const theirsApp = await createApplicationWithChecklist({
      associateId: otherAssoc.id,
      clientId: other.id,
    });

    const list = await hr.get('/onboarding/applications?status=ALL');
    expect(list.status).toBe(200);
    const ids = list.body.applications.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([mineApp.id, theirsApp.id]));

    // The new PII gate is a no-op for manage:onboarding holders.
    expect((await hr.get(`/onboarding/applications/${mineApp.id}/w4`)).status).toBe(200);
    expect((await hr.get(`/onboarding/applications/${mineApp.id}/i9`)).status).toBe(200);
    expect(
      (await hr.get(`/onboarding/applications/${mineApp.id}/profile`)).status,
    ).toBe(200);
  });
});

describe('supervisor scheduling cascade: locations, positions, teams', () => {
  it('reads own-client locations through the /clients gate; other clients 404; admin area stays 403', async () => {
    const { mine, other, sup } = await seedTwoClients();

    // The location picker's source — used to 403 for supervisors, which
    // dead-ended the Location → Team cascade on the scheduling grid.
    const ownLocations = await sup.get(`/clients/${mine.id}/locations`);
    expect(ownLocations.status).toBe(200);
    expect(ownLocations.body.locations.length).toBeGreaterThan(0);
    for (const l of ownLocations.body.locations) {
      expect(l.clientId).toBe(mine.id);
    }

    // Cross-tenant read 404s (scopeClients clamp — no existence leak).
    await sup.get(`/clients/${other.id}/locations`).expect(404);

    // Only the locations read is open — the clients admin area is not.
    await sup.get('/clients').expect(403);
    await sup.get(`/clients/${mine.id}`).expect(403);
    await sup
      .post(`/clients/${mine.id}/locations`)
      .send({ name: 'Sneaky new site' })
      .expect(403);
  });

  it('does not open the locations read to ASSOCIATE logins', async () => {
    const { mine } = await seedTwoClients();
    const a = await createAssociate({ firstName: 'Just', lastName: 'AWorker' });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: a.email,
      associateId: a.id,
      clientId: mine.id,
    });
    const agent = await loginAs(user.email);
    // ASSOCIATE is not clamped by scopeClients, so the gate must not admit
    // it — that would be an org-wide location read.
    await agent.get(`/clients/${mine.id}/locations`).expect(403);
  });

  it('reads shift positions clamped to own client, even when asking for another', async () => {
    const { mine, other, sup } = await seedTwoClients();
    await prisma.shiftPosition.create({
      data: { clientId: mine.id, name: 'Line Cook', sortOrder: 1 },
    });
    await prisma.shiftPosition.create({
      data: { clientId: other.id, name: 'Their Barista', sortOrder: 1 },
    });

    const res = await sup.get('/org/shift-positions');
    expect(res.status).toBe(200);
    expect(res.body.shiftPositions.map((p: { name: string }) => p.name)).toEqual([
      'Line Cook',
    ]);

    // Requesting another tenant's list is silently clamped to their own.
    const cross = await sup.get(`/org/shift-positions?clientId=${other.id}`);
    expect(cross.status).toBe(200);
    expect(cross.body.shiftPositions.map((p: { name: string }) => p.name)).toEqual([
      'Line Cook',
    ]);

    // Org-wide admins keep the unclamped behavior.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(hr.email);
    const all = await admin.get('/org/shift-positions');
    expect(all.status).toBe(200);
    expect(all.body.shiftPositions.length).toBe(2);
    const theirs = await admin.get(`/org/shift-positions?clientId=${other.id}`);
    expect(
      theirs.body.shiftPositions.map((p: { name: string }) => p.name),
    ).toEqual(['Their Barista']);
  });

  it('creates a shift team end-to-end for the own client, never across the boundary', async () => {
    const { mine, other, sup } = await seedTwoClients();
    const myLoc = await prisma.location.findFirstOrThrow({
      where: { clientId: mine.id },
    });
    const theirLoc = await prisma.location.findFirstOrThrow({
      where: { clientId: other.id },
    });

    const created = await sup
      .post('/scheduling/teams')
      .send({ clientId: mine.id, locationId: myLoc.id, name: 'Morning Crew' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Morning Crew');
    expect(created.body.clientId).toBe(mine.id);

    await sup
      .post('/scheduling/teams')
      .send({ clientId: other.id, locationId: theirLoc.id, name: 'Nope' })
      .expect(403);
    // Own client + someone else's location: rejected by the location check.
    await sup
      .post('/scheduling/teams')
      .send({ clientId: mine.id, locationId: theirLoc.id, name: 'Nope' })
      .expect(404);
  });

  it('lets CLIENT_PORTAL read its own client locations too', async () => {
    const { mine } = await seedTwoClients();
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: mine.id });
    const portal = await loginAs(user.email);
    const res = await portal.get(`/clients/${mine.id}/locations`);
    expect(res.status).toBe(200);
    for (const l of res.body.locations) {
      expect(l.clientId).toBe(mine.id);
    }
  });
});
