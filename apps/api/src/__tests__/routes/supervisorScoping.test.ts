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
 * badge counts, onboarding applications, the holiday calendar, and
 * time-off entitlements — and the labor-cost reads it is refused outright.
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

describe('time admin tenant boundary: clientId override', () => {
  // Spread-order bug class ("tenant clamp FIRST"): scopeTimeEntries clamps
  // SHIFT_SUPERVISOR via `clientId`, and spreading the raw query param after
  // it let a supervisor pass ?clientId=<other> to read any client's punches.
  it('supervisor asking for another client still gets only their own entries', async () => {
    const { mine, other, myAssoc, otherAssoc, sup } = await seedTwoClients();
    await prisma.timeEntry.create({
      data: {
        associateId: myAssoc.id,
        clientId: mine.id,
        clockInAt: new Date(Date.now() - 4 * 3600_000),
        clockOutAt: new Date(Date.now() - 1 * 3600_000),
        status: 'COMPLETED',
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: otherAssoc.id,
        clientId: other.id,
        clockInAt: new Date(Date.now() - 4 * 3600_000),
        clockOutAt: new Date(Date.now() - 1 * 3600_000),
        status: 'COMPLETED',
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: otherAssoc.id,
        clientId: other.id,
        clockInAt: new Date(Date.now() - 2 * 3600_000),
        status: 'ACTIVE',
      },
    });

    // Queue list: the override must be ignored, not honored.
    const list = await sup.get(`/time/admin/entries?clientId=${other.id}`);
    expect(list.status).toBe(200);
    for (const e of list.body.entries) {
      expect(e.clientId).toBe(mine.id);
    }
    expect(list.body.entries).toHaveLength(1);

    // Pending badge follows the same clamp.
    const count = await sup.get(
      `/time/admin/entries/count?status=COMPLETED&clientId=${other.id}`,
    );
    expect(count.status).toBe(200);
    expect(count.body.count).toBe(1);

    // Live board too — the other client's ACTIVE punch stays invisible.
    const active = await sup.get(`/time/admin/active?clientId=${other.id}`);
    expect(active.status).toBe(200);
    expect(active.body.entries).toHaveLength(0);
  });
});

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

describe('clientId params cannot override the supervisor tenant clamp', () => {
  // All five scheduling endpoints that accept a clientId used to spread it
  // AFTER scopeShifts, so the caller's key overwrote the clamp — the same
  // bug /kpis had already fixed. These pin the clamp on each one.
  const WEEK_START = new Date('2026-09-07T00:00:00.000Z');
  const at = (dayOffset: number, hour: number) =>
    new Date(WEEK_START.getTime() + (dayOffset * 24 + hour) * 3_600_000);

  async function seedShifts() {
    const seeded = await seedTwoClients();
    const myShift = await prisma.shift.create({
      data: {
        clientId: seeded.mine.id,
        position: 'Server',
        startsAt: at(1, 9),
        endsAt: at(1, 17),
        status: 'DRAFT',
      },
    });
    const theirDraft = await prisma.shift.create({
      data: {
        clientId: seeded.other.id,
        position: 'Their Secret Role',
        startsAt: at(1, 9),
        endsAt: at(1, 17),
        status: 'DRAFT',
      },
    });
    const theirOpen = await prisma.shift.create({
      data: {
        clientId: seeded.other.id,
        position: 'Their Open Slot',
        startsAt: at(2, 9),
        endsAt: at(2, 17),
        status: 'OPEN',
        publishedAt: new Date(),
      },
    });
    return { ...seeded, myShift, theirDraft, theirOpen };
  }

  it('GET /shifts?clientId=<other> returns only own-client shifts', async () => {
    const { sup, other, myShift, theirDraft, theirOpen } = await seedShifts();
    const res = await sup.get(`/scheduling/shifts?clientId=${other.id}`);
    expect(res.status).toBe(200);
    const ids = res.body.shifts.map((s: { id: string }) => s.id);
    expect(ids).toContain(myShift.id);
    expect(ids).not.toContain(theirDraft.id);
    expect(ids).not.toContain(theirOpen.id);
  });

  it('publish-week with clientId=<other> publishes nothing across the boundary', async () => {
    const { sup, other, theirDraft } = await seedShifts();
    const res = await sup.post('/scheduling/publish-week').send({
      weekStart: WEEK_START.toISOString(),
      clientId: other.id,
    });
    expect(res.status).toBe(200);
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: theirDraft.id } });
    expect(after.status).toBe('DRAFT');
    expect(after.publishedAt).toBeNull();
  });

  it('copy-week with clientId=<other> writes nothing into the other tenant', async () => {
    const { sup, other } = await seedShifts();
    const before = await prisma.shift.count({ where: { clientId: other.id } });
    const target = new Date(WEEK_START.getTime() + 7 * 86_400_000);
    const res = await sup.post('/scheduling/copy-week').send({
      sourceWeekStart: WEEK_START.toISOString(),
      targetWeekStart: target.toISOString(),
      clientId: other.id,
    });
    expect(res.status).toBe(200);
    expect(await prisma.shift.count({ where: { clientId: other.id } })).toBe(before);
  });

  it('auto-schedule with clientId=<other> assigns nothing across the boundary', async () => {
    const { sup, other, theirOpen } = await seedShifts();
    const res = await sup.post('/scheduling/auto-schedule-week').send({
      weekStart: WEEK_START.toISOString(),
      clientId: other.id,
    });
    expect(res.status).toBe(200);
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: theirOpen.id } });
    expect(after.assignedAssociateId).toBeNull();
  });

  it('export.pdf with clientId=<other> still succeeds (clamped to own client)', async () => {
    const { sup, other } = await seedShifts();
    const res = await sup.post('/scheduling/export.pdf').send({
      from: WEEK_START.toISOString(),
      to: new Date(WEEK_START.getTime() + 7 * 86_400_000).toISOString(),
      clientId: other.id,
    });
    // Content is a binary PDF; the where-clause clamp is pinned by the
    // sibling tests above — this one just proves the clamp doesn't break
    // the export for a bounded caller.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});

describe('holiday calendar tenant boundary', () => {
  // The writes were gated on manage:scheduling alone, which the supervisor
  // holds — so they could add company-wide holidays (premium pay for every
  // client), edit or delete any client's, and run the federal import.
  async function seedHolidays(mineId: string, otherId: string) {
    const [company, mineHol, theirsHol] = await Promise.all([
      prisma.holiday.create({
        data: { clientId: null, name: 'Founders Day', date: new Date('2026-03-02'), type: 'COMPANY' },
      }),
      prisma.holiday.create({
        data: { clientId: mineId, name: 'Store Day', date: new Date('2026-04-06'), type: 'CLIENT_SPECIFIC' },
      }),
      prisma.holiday.create({
        data: { clientId: otherId, name: 'Their Day', date: new Date('2026-05-04'), type: 'CLIENT_SPECIFIC' },
      }),
    ]);
    return { company, mineHol, theirsHol };
  }

  it('supervisor cannot create a company-wide holiday', async () => {
    const { sup } = await seedTwoClients();
    for (const type of ['COMPANY', 'FEDERAL'] as const) {
      const res = await sup
        .post('/holidays')
        .send({ name: 'Day off', date: '2026-06-01', type });
      expect(res.status).toBe(403);
    }
    const state = await sup
      .post('/holidays')
      .send({ name: 'Day off', date: '2026-06-01', type: 'STATE', state: 'CA' });
    expect(state.status).toBe(403);
    expect(await prisma.holiday.count()).toBe(0);
  });

  it("supervisor's client-specific holiday is pinned to their own client", async () => {
    const { mine, other, sup } = await seedTwoClients();
    const res = await sup
      .post('/holidays')
      .send({ name: 'Inventory', date: '2026-06-01', type: 'CLIENT_SPECIFIC', clientId: other.id });
    expect(res.status).toBe(201);
    const row = await prisma.holiday.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.clientId).toBe(mine.id);
  });

  it('supervisor edits and deletes only their own client’s holidays', async () => {
    const { mine, other, sup } = await seedTwoClients();
    const { company, mineHol, theirsHol } = await seedHolidays(mine.id, other.id);

    expect((await sup.patch(`/holidays/${company.id}`).send({ paid: false })).status).toBe(403);
    expect((await sup.delete(`/holidays/${company.id}`)).status).toBe(403);
    expect((await sup.patch(`/holidays/${theirsHol.id}`).send({ paid: false })).status).toBe(404);
    expect((await sup.delete(`/holidays/${theirsHol.id}`)).status).toBe(404);
    expect(
      await prisma.holiday.count({ where: { id: { in: [company.id, theirsHol.id] }, paid: true } }),
    ).toBe(2);

    expect((await sup.patch(`/holidays/${mineHol.id}`).send({ paid: false })).status).toBe(200);
    expect((await sup.delete(`/holidays/${mineHol.id}`)).status).toBe(204);
    expect(await prisma.holiday.findUnique({ where: { id: mineHol.id } })).toBeNull();
  });

  it('supervisor cannot run either federal import', async () => {
    const { sup } = await seedTwoClients();
    expect((await sup.post('/holidays/import-us-federal').send({ year: 2027 })).status).toBe(403);
    expect((await sup.post('/holidays/import-us-federal-2026')).status).toBe(403);
    expect(await prisma.holiday.count()).toBe(0);
  });

  it('HR admin keeps the company calendar', async () => {
    const { mine, other } = await seedTwoClients();
    const { company, theirsHol } = await seedHolidays(mine.id, other.id);
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);

    const created = await hr
      .post('/holidays')
      .send({ name: 'Company picnic', date: '2026-07-10', type: 'COMPANY' });
    expect(created.status).toBe(201);
    expect((await hr.patch(`/holidays/${company.id}`).send({ paid: false })).status).toBe(200);
    expect((await hr.delete(`/holidays/${theirsHol.id}`)).status).toBe(204);
    const imported = await hr.post('/holidays/import-us-federal').send({ year: 2027 });
    expect(imported.status).toBe(200);
    expect(imported.body.inserted).toBe(11);
  });
});

describe('time-off entitlements tenant boundary', () => {
  // GET/PUT /time-off/admin/entitlements ran unscoped under manage:time, so
  // a supervisor listed every client's PTO policy and could rewrite any
  // associate's annual allowance.
  it("supervisor lists and edits only their own client's entitlements", async () => {
    const { myAssoc, otherAssoc, sup } = await seedTwoClients();
    await prisma.timeOffEntitlement.createMany({
      data: [
        { associateId: myAssoc.id, category: 'PTO', annualMinutes: 2400 },
        { associateId: otherAssoc.id, category: 'PTO', annualMinutes: 4800 },
      ],
    });

    const list = await sup.get('/time-off/admin/entitlements');
    expect(list.status).toBe(200);
    expect(list.body.entitlements.map((e: { associateId: string }) => e.associateId)).toEqual([
      myAssoc.id,
    ]);

    const probe = await sup.get(`/time-off/admin/entitlements?associateId=${otherAssoc.id}`);
    expect(probe.status).toBe(200);
    expect(probe.body.entitlements).toHaveLength(0);

    const theirs = await sup.put('/time-off/admin/entitlements').send({
      associateId: otherAssoc.id,
      category: 'PTO',
      annualMinutes: 0,
      carryoverMaxMinutes: 0,
    });
    expect(theirs.status).toBe(404);
    const untouched = await prisma.timeOffEntitlement.findUniqueOrThrow({
      where: { associateId_category: { associateId: otherAssoc.id, category: 'PTO' } },
    });
    expect(untouched.annualMinutes).toBe(4800);

    const mineRes = await sup.put('/time-off/admin/entitlements').send({
      associateId: myAssoc.id,
      category: 'PTO',
      annualMinutes: 3000,
      carryoverMaxMinutes: 0,
    });
    expect(mineRes.status).toBe(200);
    expect(mineRes.body.annualMinutes).toBe(3000);
  });

  it('HR admin still sees and edits every client’s entitlements', async () => {
    const { myAssoc, otherAssoc } = await seedTwoClients();
    await prisma.timeOffEntitlement.createMany({
      data: [
        { associateId: myAssoc.id, category: 'PTO', annualMinutes: 2400 },
        { associateId: otherAssoc.id, category: 'PTO', annualMinutes: 4800 },
      ],
    });
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);

    const list = await hr.get('/time-off/admin/entitlements');
    expect(list.status).toBe(200);
    expect(list.body.entitlements).toHaveLength(2);

    const res = await hr.put('/time-off/admin/entitlements').send({
      associateId: otherAssoc.id,
      category: 'PTO',
      annualMinutes: 0,
      carryoverMaxMinutes: 0,
    });
    expect(res.status).toBe(200);
  });
});

describe('labor cost is withheld from the supervisor', () => {
  // manage:scheduling opened every money read on the scheduling router to
  // the supervisor (clamped to their client). Labor cost is org economics
  // — owner decision 2026-09-17: bounded roles never see it.
  it('refuses the money-only reads', async () => {
    const { sup } = await seedTwoClients();
    for (const path of [
      '/scheduling/labor-costs',
      '/scheduling/store-trends',
      '/scheduling/floor-now',
      '/scheduling/ot-outlook',
    ]) {
      expect((await sup.get(path)).status, path).toBe(403);
    }
  });

  it('keeps the KPI counts but nulls the cost fields', async () => {
    const { mine, sup } = await seedTwoClients();
    const startsAt = new Date(Date.now() + 2 * 3_600_000);
    await prisma.shift.create({
      data: {
        clientId: mine.id,
        position: 'Server',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 4 * 3_600_000),
        status: 'OPEN',
        payRate: 20,
      },
    });
    const window = `from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(
      Date.now() + 48 * 3_600_000,
    ).toISOString()}`;

    const res = await sup.get(`/scheduling/kpis?${window}`);
    expect(res.status).toBe(200);
    expect(res.body.openShifts).toBe(1);
    expect(res.body.totalScheduledMinutes).toBe(240);
    expect(res.body.projectedLaborCost).toBeNull();
    expect(res.body.shiftsWithoutRate).toBeNull();

    // An org-wide role still gets the money.
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);
    const hrRes = await hr.get(`/scheduling/kpis?${window}`);
    expect(hrRes.status).toBe(200);
    expect(hrRes.body.projectedLaborCost).toBe(80);
    expect((await hr.get(`/scheduling/labor-costs?${window}`)).status).toBe(200);
  });
});

describe('the day roster (the supervisor Today page)', () => {
  // /client-portal/day opts the supervisor in, clamped to their client —
  // the roster and punches only. The portal's money/report routes never
  // take the opt-in.
  it('serves their own client only, and nothing else of the portal', async () => {
    const { mine, other, myAssoc, otherAssoc, sup } = await seedTwoClients();
    const startsAt = new Date(Date.now() - 2 * 3_600_000);
    const endsAt = new Date(Date.now() + 6 * 3_600_000);
    await prisma.shift.createMany({
      data: [
        { clientId: mine.id, position: 'Server', startsAt, endsAt, status: 'ASSIGNED', assignedAssociateId: myAssoc.id, publishedAt: new Date() },
        { clientId: other.id, position: 'Server', startsAt, endsAt, status: 'ASSIGNED', assignedAssociateId: otherAssoc.id, publishedAt: new Date() },
      ],
    });

    const day = await sup.get(`/client-portal/day?clientId=${other.id}`);
    expect(day.status).toBe(200);
    expect(day.body.client.id).toBe(mine.id);
    const ids = (day.body.roster as Array<{ associateId: string }>).map((r) => r.associateId);
    expect(ids).toEqual([myAssoc.id]);

    for (const path of ['/client-portal/overview', '/client-portal/history', '/client-portal/schedule']) {
      expect((await sup.get(path)).status, path).toBe(403);
    }
    // The floor supervisor watches the same wall — their own client only,
    // and still none of the rest of the portal.
    const { user: floor } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: mine.id });
    const fa = await loginAs(floor.email);
    const theirs = await fa.get(`/client-portal/day?clientId=${other.id}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.client.id).toBe(mine.id);
    for (const path of ['/client-portal/overview', '/client-portal/history', '/client-portal/schedule']) {
      expect((await fa.get(path)).status, path).toBe(403);
    }
  });
});

describe('the client bill rate is never the supervisor’s', () => {
  // Shift.hourlyRate (and the template / rate-default bill rates) is the
  // revenue side of the contract — owner decision 2026-09-17. Responses
  // null it for the supervisor; their writes ignore it, so an edit can't
  // clear a rate they can't see. Pay rates stay theirs.
  const inDays = (d: number, h = 0) => new Date(Date.now() + (d * 24 + h) * 3_600_000);

  it('shifts: hidden in reads, ignored on create, preserved on edit', async () => {
    const { mine, sup } = await seedTwoClients();
    const office = await prisma.shift.create({
      data: {
        clientId: mine.id,
        position: 'Server',
        startsAt: inDays(3),
        endsAt: inDays(3, 8),
        status: 'OPEN',
        hourlyRate: 30,
        payRate: 17,
        publishedAt: new Date(),
      },
    });

    const list = await sup.get(`/scheduling/shifts?from=${inDays(2).toISOString()}&to=${inDays(4).toISOString()}`);
    expect(list.status).toBe(200);
    const seen = list.body.shifts.find((s: { id: string }) => s.id === office.id);
    expect(seen.hourlyRate).toBeNull();
    expect(seen.payRate).toBe(17);

    const edit = await sup.patch(`/scheduling/shifts/${office.id}`).send({ hourlyRate: null, notes: 'bring aprons' });
    expect(edit.status).toBe(200);
    expect(edit.body.hourlyRate).toBeNull();
    const kept = await prisma.shift.findUniqueOrThrow({ where: { id: office.id } });
    expect(Number(kept.hourlyRate)).toBe(30);
    expect(kept.notes).toBe('bring aprons');

    const created = await sup.post('/scheduling/shifts').send({
      clientId: mine.id,
      position: 'Server',
      startsAt: inDays(5).toISOString(),
      endsAt: inDays(5, 8).toISOString(),
      hourlyRate: 99,
      payRate: 18,
    });
    expect(created.status).toBe(201);
    expect(created.body.hourlyRate).toBeNull();
    expect(created.body.payRate).toBe(18);
    const row = await prisma.shift.findUniqueOrThrow({ where: { id: created.body.id } });
    // Null → the statement prices it at the client's per-position default.
    expect(row.hourlyRate).toBeNull();

    // The office still sees and owns it.
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);
    const hrList = await hr.get(`/scheduling/shifts?clientId=${mine.id}&from=${inDays(2).toISOString()}&to=${inDays(4).toISOString()}`);
    expect(hrList.body.shifts.find((s: { id: string }) => s.id === office.id).hourlyRate).toBe(30);
  });

  it('templates and rate defaults: the bill side stays the office’s', async () => {
    const { mine, sup } = await seedTwoClients();
    await prisma.shiftTemplate.create({
      data: { clientId: mine.id, name: 'AM', position: 'Server', dayOfWeek: 1, startMinute: 360, endMinute: 840, hourlyRate: 30 },
    });
    const templates = await sup.get('/scheduling/templates');
    expect(templates.status).toBe(200);
    expect(templates.body.templates[0].hourlyRate).toBeNull();
    const tpl = await sup.post('/scheduling/templates').send({
      clientId: mine.id, name: 'PM', position: 'Server', dayOfWeek: 2, startMinute: 840, endMinute: 1320, hourlyRate: 45,
    });
    expect(tpl.status).toBe(201);
    expect((await prisma.shiftTemplate.findUniqueOrThrow({ where: { id: tpl.body.id } })).hourlyRate).toBeNull();

    await prisma.shiftRateDefault.create({
      data: { clientId: mine.id, position: 'Server', payRate: 17, billRate: 28 },
    });
    const defaults = await sup.get(`/scheduling/rate-defaults?clientId=${mine.id}`);
    expect(defaults.body.rateDefaults[0]).toMatchObject({ payRate: 17, billRate: null });
    const put = await sup.put('/scheduling/rate-defaults').send({
      clientId: mine.id, position: 'Server', payRate: 19, billRate: 0,
    });
    expect(put.status).toBe(200);
    expect(put.body.billRate).toBeNull();
    const saved = await prisma.shiftRateDefault.findFirstOrThrow({ where: { clientId: mine.id, position: 'Server' } });
    expect(Number(saved.payRate)).toBe(19);
    expect(Number(saved.billRate)).toBe(28);
  });

  it('the timesheet drill-down carries no bill rate or billed amount', async () => {
    const { mine, myAssoc, sup } = await seedTwoClients();
    await prisma.client.update({ where: { id: mine.id }, data: { fieldglassBillRate: 30 } });
    const mon = new Date('2026-06-15T13:00:00.000Z');
    await prisma.timeEntry.create({
      data: {
        associateId: myAssoc.id,
        clientId: mine.id,
        clockInAt: mon,
        clockOutAt: new Date(mon.getTime() + 4 * 3_600_000),
        status: 'APPROVED',
      },
    });
    const body = { associateId: myAssoc.id, weekStart: '2026-06-15T12:00:00.000Z' };

    const supRes = await sup.post('/time/admin/timesheets/associate').send(body);
    expect(supRes.status).toBe(200);
    expect(supRes.body.totalHours).toBe(4);
    expect(supRes.body.billRate).toBeNull();
    expect(supRes.body.amount).toBeNull();

    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);
    const hrRes = await hr.post('/time/admin/timesheets/associate').send(body);
    expect(hrRes.body.billRate).toBe(30);
    expect(hrRes.body.amount).toBe(120);
  });
});
