import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

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

const today = () => new Date().toISOString().slice(0, 10);
const future = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000);

/** Client + its default Location (createClient seeds one). */
async function clientWithLocation(name?: string) {
  const client = await createClient(name);
  const location = await prisma.location.findFirstOrThrow({
    where: { clientId: client.id },
  });
  return { client, location };
}

/** Associate placed at `location` via an open assignment. */
async function placedAssociate(locationId: string) {
  const associate = await createAssociate();
  await prisma.associateAssignment.create({
    data: { associateId: associate.id, locationId, startedAt: new Date() },
  });
  return associate;
}

describe('POST /org/associates/:id/transfer', () => {
  it('intra-client transfer still works without confirmCrossClient', async () => {
    const { client, location } = await clientWithLocation('Walmart Front Beach');
    const second = await prisma.location.create({
      data: { clientId: client.id, name: 'Back of House' },
    });
    const associate = await placedAssociate(location.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/org/associates/${associate.id}/transfer`).send({
      locationId: second.id,
      startedAt: today(),
    });
    expect(res.status).toBe(201);
    expect(res.body.crossClient).toBe(false);
    expect(res.body.clientId).toBe(client.id);
    expect(res.body.releasedShifts).toBe(0);
  });

  it('cross-client transfer without confirmCrossClient is refused and changes nothing', async () => {
    const { location: oldLoc } = await clientWithLocation('Walmart Front Beach');
    const { location: newLoc } = await clientWithLocation('Pier Park');
    const associate = await placedAssociate(oldLoc.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/org/associates/${associate.id}/transfer`).send({
      locationId: newLoc.id,
      startedAt: today(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('cross_client_confirmation_required');

    const open = await prisma.associateAssignment.findFirst({
      where: { associateId: associate.id, endedAt: null },
    });
    expect(open?.locationId).toBe(oldLoc.id);
  });

  it('confirmed cross-client transfer moves the assignment and severs the old client', async () => {
    const { client: oldClient, location: oldLoc } =
      await clientWithLocation('Walmart Front Beach');
    const { client: newClient, location: newLoc } =
      await clientWithLocation('Pier Park');
    const associate = await placedAssociate(oldLoc.id);
    const manager = await createAssociate({ firstName: 'Mia', lastName: 'Boss' });
    await prisma.associate.update({
      where: { id: associate.id },
      data: { managerId: manager.id },
    });
    // Old-client entanglements the transfer must sever:
    const assignedShift = await prisma.shift.create({
      data: {
        clientId: oldClient.id,
        position: 'Server',
        startsAt: future(120),
        endsAt: future(600),
        status: 'ASSIGNED',
        assignedAssociateId: associate.id,
      },
    });
    const openShift = await prisma.shift.create({
      data: {
        clientId: oldClient.id,
        position: 'Server',
        startsAt: future(240),
        endsAt: future(720),
        status: 'OPEN',
      },
    });
    const claim = await prisma.openShiftClaim.create({
      data: { shiftId: openShift.id, associateId: associate.id, status: 'PENDING' },
    });
    const team = await prisma.shiftTeam.create({
      data: { clientId: oldClient.id, locationId: oldLoc.id, name: 'Morning' },
    });
    await prisma.shiftTeamMember.create({
      data: { teamId: team.id, associateId: associate.id },
    });
    const position = await prisma.position.create({
      data: {
        clientId: oldClient.id,
        code: 'SRV-1',
        title: 'Server',
        status: 'FILLED',
        filledByAssociateId: associate.id,
        filledAt: new Date(),
      },
    });
    const pin = await prisma.kioskPin.create({
      data: {
        associateId: associate.id,
        clientId: oldClient.id,
        pinHmac: Buffer.alloc(32, 7),
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/org/associates/${associate.id}/transfer`).send({
      locationId: newLoc.id,
      startedAt: today(),
      reason: 'Coverage need at Pier Park',
      confirmCrossClient: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      crossClient: true,
      clientId: newClient.id,
      clientName: newClient.name,
      locationId: newLoc.id,
      releasedShifts: 1,
      expiredClaims: 1,
      removedTeamMemberships: 1,
      vacatedPositions: 1,
      kioskPinMoved: true,
    });

    // Assignment timeline: old row closed, one open row at the new site.
    const assignments = await prisma.associateAssignment.findMany({
      where: { associateId: associate.id },
      orderBy: { startedAt: 'asc' },
    });
    const open = assignments.filter((x) => x.endedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].locationId).toBe(newLoc.id);

    // Old-client org tree cleared.
    const after = await prisma.associate.findUniqueOrThrow({
      where: { id: associate.id },
    });
    expect(after.managerId).toBeNull();
    expect(after.departmentId).toBeNull();
    expect(after.costCenterId).toBeNull();
    expect(after.jobProfileId).toBeNull();
    expect(after.payrollScheduleId).toBeNull();

    // Shift released, claim expired, team membership gone, position vacated.
    const shiftAfter = await prisma.shift.findUniqueOrThrow({
      where: { id: assignedShift.id },
    });
    expect(shiftAfter.status).toBe('OPEN');
    expect(shiftAfter.assignedAssociateId).toBeNull();
    const claimAfter = await prisma.openShiftClaim.findUniqueOrThrow({
      where: { id: claim.id },
    });
    expect(claimAfter.status).toBe('EXPIRED');
    expect(
      await prisma.shiftTeamMember.count({ where: { associateId: associate.id } }),
    ).toBe(0);
    const positionAfter = await prisma.position.findUniqueOrThrow({
      where: { id: position.id },
    });
    expect(positionAfter.status).toBe('OPEN');
    expect(positionAfter.filledByAssociateId).toBeNull();

    // Kiosk PIN follows: same employee number, new client's kiosks.
    const pinAfter = await prisma.kioskPin.findUniqueOrThrow({
      where: { id: pin.id },
    });
    expect(pinAfter.clientId).toBe(newClient.id);

    // Effective-dated history snapshot recorded the clearing.
    const history = await prisma.associateHistory.findFirst({
      where: { associateId: associate.id, reason: 'cross_client_transfer' },
    });
    expect(history).not.toBeNull();
    expect(history?.managerId).toBeNull();

    // Audit row carries the from/to clients and the cleanup tallies.
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'associate.transfer', entityId: associate.id },
    });
    expect(audit).not.toBeNull();
    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta.crossClient).toBe(true);
    expect(meta.fromClientId).toBe(oldClient.id);
    expect(meta.toClientId).toBe(newClient.id);
    expect(meta.releasedShifts).toBe(1);
  });

  it('application-derived client also counts as cross-client (never-placed associate)', async () => {
    const oldClient = await createClient('Other Corp');
    const { location: newLoc } = await clientWithLocation('Pier Park');
    const associate = await createAssociate();
    await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: oldClient.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const refused = await a.post(`/org/associates/${associate.id}/transfer`).send({
      locationId: newLoc.id,
      startedAt: today(),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('cross_client_confirmation_required');

    const confirmed = await a.post(`/org/associates/${associate.id}/transfer`).send({
      locationId: newLoc.id,
      startedAt: today(),
      confirmCrossClient: true,
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.crossClient).toBe(true);
  });
});
