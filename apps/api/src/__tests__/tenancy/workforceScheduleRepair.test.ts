import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { catalogFixture, resumeCapability, runCapabilityFixture, suspendCapability } from '../../lib/agentCapabilities.js';
import { executeDeactivation } from '../../lib/deactivation.js';
import { runScheduleRepair } from '../../lib/scheduleRepair.js';
import { runShiftFill, SCHEDULE_REPAIR, SHIFT_FILL } from '../../lib/workforceAgent.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Agent families step 2 — the Workforce agent's schedule.repair
 * (docs/agent-families-investigation.md §4).
 *
 *   The minute an event un-covers a shift (leave approved over it, a
 *   separation or deactivation releasing it, an emergency standing down
 *   with it open or held by someone who can no longer work it), the agent
 *   proposes one named person and names the overlap. Nothing changes until
 *   the desk approves; the shared executor then takes the shift over from
 *   the person it covers for. The autofill tick is the backstop. A
 *   capability added to an agent already certified arrives suspended.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

/** A hotel: Lena holds a shift three days out, Tess is free, Omar works across it; a site-bound property manager. */
async function hotelWorld() {
  const now = new Date();
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
  // It boots ONBOARDING; these cases exercise it as an owner would after certifying it.
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const hotel = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, timezone: 'America/Chicago' } });
  const place = (associateId: string) =>
    prisma.associateAssignment.create({ data: { associateId, locationId: hotel.id, startedAt: new Date(now.getTime() - 30 * DAY) } });
  const lena = await createAssociate({ firstName: 'Lena', lastName: 'Away' });
  const tess = await createAssociate({ firstName: 'Tess', lastName: 'Free' });
  const omar = await createAssociate({ firstName: 'Omar', lastName: 'Busy' });
  for (const p of [lena, tess, omar]) await place(p.id);
  const startsAt = new Date(now.getTime() + 3 * DAY);
  const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
  await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt: new Date(startsAt.getTime() - HOUR), endsAt: new Date(endsAt.getTime() - HOUR), status: 'ASSIGNED', assignedAssociateId: omar.id, publishedAt: now } });
  const shift = await prisma.shift.create({
    data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt, endsAt, status: 'ASSIGNED', assignedAssociateId: lena.id, publishedAt: now },
  });
  const { user: manager } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: hotel.id } });
  return { now, hr, workerId, hotel, lena, tess, omar, shift, manager };
}

type World = Awaited<ReturnType<typeof hotelWorld>>;

const repairsFor = (shiftId: string) => prisma.agentProposal.findMany({ where: { capabilityKey: SCHEDULE_REPAIR, subjectId: shiftId }, orderBy: { createdAt: 'asc' } });

/** Lena asks for vacation over her shift; HR approves it through the API. */
async function approveLenaLeave(w: World) {
  await prisma.timeOffBalance.create({ data: { associateId: w.lena.id, category: 'VACATION', balanceMinutes: 9_600 } });
  const request = await prisma.timeOffRequest.create({
    data: {
      associateId: w.lena.id,
      category: 'VACATION',
      startDate: new Date(`${ymd(new Date(w.shift.startsAt.getTime() - DAY))}T00:00:00Z`),
      endDate: new Date(`${ymd(new Date(w.shift.startsAt.getTime() + DAY))}T00:00:00Z`),
      requestedMinutes: 1_440,
      status: 'PENDING',
    },
  });
  const hr = await loginAs(agent(), w.hr.email);
  const res = await hr.post(`/time-off/admin/requests/${request.id}/approve`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await flushPendingNotifications();
  return request;
}

describe('schedule.repair: approved leave, end to end', () => {
  it('proposes cover the minute leave is approved, naming the overlap; the property manager approves; the agent takes the shift over and tells both people', async () => {
    const w = await hotelWorld();
    await approveLenaLeave(w);

    // A proposal waiting on a person; Lena still holds the shift.
    const [p] = await repairsFor(w.shift.id);
    expect(p).toMatchObject({ status: 'PROPOSED', workerId: w.workerId });
    expect(p!.payload).toMatchObject({ associateId: w.tess.id, replacesAssociateId: w.lena.id, cause: 'time_off' });
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } });
    expect(approval.summary).toMatch(/^Cover Lena Away's Housekeeper shift at The Grand Hotel, .* with Tess Free\. Lena Away has approved vacation leave/);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBe(w.lena.id);

    // Neither the backstop nor shift.fill proposes again.
    expect((await runScheduleRepair(prisma, w.now)).proposed).toBe(0);
    await runShiftFill(prisma, w.now);
    expect(await prisma.agentProposal.count({ where: { subjectId: w.shift.id, capabilityKey: SHIFT_FILL } })).toBe(0);

    // The property manager's queue carries it with Approve and Reject.
    const manager = await loginAs(agent(), w.manager.email);
    const queue = await manager.get('/me/decisions');
    const item = (queue.body.decisions ?? queue.body.items ?? queue.body).find((d: { key: string }) => d.key === `agents:shift-fill:${approval.id}`);
    expect(item, JSON.stringify(queue.body)).toMatchObject({ quickAction: 'Approve', declineAction: 'Reject' });
    const approve = await manager.post('/me/decisions/quick').send({ key: item.key });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    expect(await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).toMatchObject({ assignedAssociateId: w.tess.id, status: 'ASSIGNED' });
    const done = await prisma.agentProposal.findUniqueOrThrow({ where: { id: p!.id } });
    expect(done.status).toBe('EXECUTED');
    expect(done.outcome).toMatchObject({ associateId: w.tess.id, replacesAssociateId: w.lena.id });

    await flushPendingAudits();
    const assigned = await prisma.auditLog.findFirst({ where: { action: 'shift.assigned', entityId: w.shift.id, workerId: w.workerId } });
    expect(assigned?.metadata).toMatchObject({ approvalId: approval.id, replacesAssociateId: w.lena.id, via: 'agent_schedule_repair' });

    await flushPendingNotifications();
    const closure = await prisma.notification.findFirst({ where: { recipientUserId: w.manager.id, category: 'agent_shift_fill', channel: 'IN_APP' } });
    expect(closure?.subject).toBe('Shift covered: Tess Free for Lena Away');

    // The scorecard counts the repair.
    const admin = await loginAs(agent(), w.hr.email);
    const sc = await admin.get(`/agents/${w.workerId}/capabilities/${SCHEDULE_REPAIR}/scorecard`);
    expect(sc.status, JSON.stringify(sc.body)).toBe(200);
    expect(sc.body.metrics).toMatchObject({ shiftsUncovered: 1, proposalsMade: 1, repairedBeforeStart: 1 });
  });

  it('leave withdrawn before anyone decides: the backstop retires the proposal, and approving it later changes nothing', async () => {
    const w = await hotelWorld();
    const request = await approveLenaLeave(w);
    const [p] = await repairsFor(w.shift.id);
    await prisma.timeOffRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
    const tick = await runScheduleRepair(prisma, w.now);
    expect(tick.superseded).toBe(1);
    const retired = await prisma.agentProposal.findUniqueOrThrow({ where: { id: p!.id } });
    expect(retired.status).toBe('SUPERSEDED');
    expect(retired.outcome).toMatchObject({ reason: 'the person it covered for can work it again' });
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } })).status).toBe('EXPIRED');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBe(w.lena.id);
  });

  it('the backstop finds approved leave no event reached, once', async () => {
    const w = await hotelWorld();
    await prisma.timeOffRequest.create({
      data: {
        associateId: w.lena.id,
        category: 'SICK',
        startDate: new Date(`${ymd(new Date(w.shift.startsAt.getTime() - DAY))}T00:00:00Z`),
        endDate: new Date(`${ymd(new Date(w.shift.startsAt.getTime() + DAY))}T00:00:00Z`),
        requestedMinutes: 480,
        status: 'APPROVED',
      },
    });
    expect(await runScheduleRepair(prisma, w.now)).toMatchObject({ uncovered: 1, proposed: 1 });
    expect(await runScheduleRepair(prisma, w.now)).toMatchObject({ proposed: 0 });
    const [p] = await repairsFor(w.shift.id);
    expect(p!.payload).toMatchObject({ associateId: w.tess.id, replacesAssociateId: w.lena.id });
  });
});

describe('schedule.repair: separation, deactivation, emergency stand-down', () => {
  it('a completed separation reopens the shift and cover is proposed at once, not after the broadcast window', async () => {
    const w = await hotelWorld();
    const sep = await prisma.separation.create({ data: { associateId: w.lena.id, reason: 'VOLUNTARY_PERSONAL', status: 'IN_PROGRESS', lastDayWorked: w.now } });
    const hr = await loginAs(agent(), w.hr.email);
    const res = await hr.post(`/separations/${sep.id}/advance`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await flushPendingNotifications();
    expect(await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).toMatchObject({ status: 'OPEN', assignedAssociateId: null });
    const [p] = await repairsFor(w.shift.id);
    expect(p!.payload).toMatchObject({ associateId: w.tess.id, replacesAssociateId: null, cause: 'separation' });
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } });
    expect(approval.summary).toMatch(/^Assign Tess Free to Housekeeper at The Grand Hotel, .*\. Lena Away separated and was released from it\.$/);
  });

  it('a deactivation does the same', async () => {
    const w = await hotelWorld();
    const r = await executeDeactivation(prisma, { associateId: w.lena.id, byUserId: w.hr.id, reason: 'No longer with us', now: w.now });
    expect(r.releasedShiftIds).toEqual([w.shift.id]);
    await flushPendingNotifications();
    const [p] = await repairsFor(w.shift.id);
    expect(p!.payload).toMatchObject({ associateId: w.tess.id, cause: 'deactivation' });
  });

  it('an emergency stands down with the shift held by someone who separated meanwhile: cover is proposed for them', async () => {
    const w = await hotelWorld();
    const hr = await loginAs(agent(), w.hr.email);
    const declared = await hr.post('/emergency').send({ title: 'Hurricane Delta', message: 'Stay home.', allSites: false, locationIds: [w.hotel.id], escalationMinutes: 30 });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).status).toBe('CANCELLED');
    // Lena leaves during the storm; a suspended shift is not released, so it comes back hers.
    await prisma.associate.update({ where: { id: w.lena.id }, data: { separatedAt: new Date() } });
    const stood = await hr.post(`/emergency/${declared.body.id}/stand-down`);
    expect(stood.status, JSON.stringify(stood.body)).toBe(200);
    await flushPendingNotifications();
    expect(await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).toMatchObject({ status: 'ASSIGNED', assignedAssociateId: w.lena.id });
    const [p] = await repairsFor(w.shift.id);
    expect(p!.payload).toMatchObject({ associateId: w.tess.id, replacesAssociateId: w.lena.id, cause: 'emergency_stand_down' });
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } });
    expect(approval.summary).toContain('Back on the schedule after "Hurricane Delta" stood down; Lena Away separated');
  });
});

describe('schedule.repair: when it does not act', () => {
  it('suspended: nothing proposed; resumed, the backstop catches up', async () => {
    const w = await hotelWorld();
    await suspendCapability(prisma, w.workerId, SCHEDULE_REPAIR, ALTO_TENANT_ID, w.hr.id, 'Checking the picks');
    await approveLenaLeave(w);
    expect(await repairsFor(w.shift.id)).toHaveLength(0);
    expect(await runScheduleRepair(prisma, w.now)).toMatchObject({ proposed: 0, skipped: 'capability_off' });
    await resumeCapability(prisma, w.workerId, SCHEDULE_REPAIR, ALTO_TENANT_ID, w.hr.id);
    expect(await runScheduleRepair(prisma, w.now)).toMatchObject({ proposed: 1 });
  });

  it('nobody free on the bench: no proposal, one note on the trail a day, counted as uncovered', async () => {
    const w = await hotelWorld();
    await prisma.shift.create({ data: { clientId: null, locationId: w.hotel.id, position: 'Housekeeper', startsAt: w.shift.startsAt, endsAt: w.shift.endsAt, status: 'ASSIGNED', assignedAssociateId: w.tess.id, publishedAt: w.now } });
    await approveLenaLeave(w);
    await flushPendingAudits();
    await runScheduleRepair(prisma, w.now);
    expect(await repairsFor(w.shift.id)).toHaveLength(0);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { workerId: w.workerId, action: 'agent.schedule_repair.no_candidate', entityId: w.shift.id } })).toBe(1);
    const admin = await loginAs(agent(), w.hr.email);
    const sc = await admin.get(`/agents/${w.workerId}/capabilities/${SCHEDULE_REPAIR}/scorecard`);
    expect(sc.body.metrics).toMatchObject({ shiftsUncovered: 1, proposalsMade: 0 });
  });

  it('added to a Workforce agent already certified and running, the capability arrives suspended for its owner to resume', async () => {
    const w = await hotelWorld();
    await prisma.agentCapability.deleteMany({ where: { workerId: w.workerId, key: SCHEDULE_REPAIR } });
    await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
    const cap = await prisma.agentCapability.findFirstOrThrow({ where: { workerId: w.workerId, key: SCHEDULE_REPAIR } });
    expect(cap.suspendedAt).toBeTruthy();
    expect(cap.suspendReason).toMatch(/run its scenario/);
    // shift.fill, held before, is untouched.
    expect((await prisma.agentCapability.findFirstOrThrow({ where: { workerId: w.workerId, key: SHIFT_FILL } })).suspendedAt).toBeNull();
    await approveLenaLeave(w);
    expect(await repairsFor(w.shift.id)).toHaveLength(0);
  });
});

describe('schedule.repair: certification', () => {
  it('the catalog fixture runs through the real pick and passes', async () => {
    const fixture = catalogFixture(SCHEDULE_REPAIR, 'A shift its holder can no longer work: the free person is proposed to cover it, never the holder or the busy one')!;
    expect(fixture).toBeTruthy();
    const direct = await runCapabilityFixture(SCHEDULE_REPAIR, fixture, new Date('2026-10-14T12:00:00.000Z'));
    expect(direct, JSON.stringify(direct)).toMatchObject({ passed: true, reason: null });
    expect(direct.refAnswer?.output).toEqual({ proposedRef: 'tess' });
  });
});
