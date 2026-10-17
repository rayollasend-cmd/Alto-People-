import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { resumeTenantAgents, runCapabilityFixture, suspendCapability, resumeCapability, suspendTenantAgents, catalogFixture } from '../../lib/agentCapabilities.js';
import { runShiftFill, SHIFT_FILL } from '../../lib/workforceAgent.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Agent families step 1 — the Workforce agent's shift.fill
 * (docs/agent-families-investigation.md §4 and §7).
 *
 *   After the open-shift broadcast window, the agent proposes one named
 *   person from the shift's bench. Nothing is assigned until the desk
 *   approves; it then assigns under the supervisor's rules, records the
 *   outcome, tells the person and closes the loop with the approver. A
 *   shift filled another way supersedes the proposal; the capability's
 *   suspension and the tenant's switch stop it; the certification fixture
 *   runs through the real pick.
 */

const HOUR = 3_600_000;

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

/** A hotel property with a site-bound property manager, three people on its bench, one elsewhere, and an open shift. */
async function hotelWorld(opts: { publishedHoursAgo?: number } = {}) {
  const now = new Date();
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
  // It boots ONBOARDING; these cases exercise it as an owner would after certifying it.
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const hotel = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, timezone: 'America/Chicago' } });
  const inn = await prisma.site.create({ data: { name: 'The Other Inn', clientId: null, timezone: 'America/Chicago' } });
  const place = (associateId: string, locationId: string) =>
    prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date(now.getTime() - 30 * 24 * HOUR) } });
  const tess = await createAssociate({ firstName: 'Tess', lastName: 'Free' });
  const omar = await createAssociate({ firstName: 'Omar', lastName: 'Busy' });
  const far = await createAssociate({ firstName: 'Far', lastName: 'Away' });
  await place(tess.id, hotel.id);
  await place(omar.id, hotel.id);
  await place(far.id, inn.id);
  const startsAt = new Date(now.getTime() + 10 * HOUR);
  const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
  // Omar already works across the open shift's window.
  await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt: new Date(startsAt.getTime() - HOUR), endsAt: new Date(endsAt.getTime() - HOUR), status: 'ASSIGNED', assignedAssociateId: omar.id, publishedAt: now } });
  const shift = await prisma.shift.create({
    data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt, endsAt, status: 'OPEN', publishedAt: new Date(now.getTime() - (opts.publishedHoursAgo ?? 3) * HOUR) },
  });
  const { user: manager } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: hotel.id } });
  return { now, hr, workerId, hotel, inn, tess, omar, far, shift, manager };
}

const proposalsFor = (shiftId: string) => prisma.agentProposal.findMany({ where: { capabilityKey: SHIFT_FILL, subjectId: shiftId }, orderBy: { createdAt: 'asc' } });

describe('shift.fill: the gated path, end to end', () => {
  it('proposes the free person from the property after the broadcast window; the property manager approves from the queue; the agent assigns, tells the person and closes the loop', async () => {
    const w = await hotelWorld();
    const run = await runShiftFill(prisma, w.now);
    expect(run).toMatchObject({ proposed: 1 });

    // A proposal waiting on a person, and nothing assigned.
    const [p] = await proposalsFor(w.shift.id);
    expect(p).toMatchObject({ status: 'PROPOSED', workerId: w.workerId });
    expect((p!.payload as Record<string, unknown>).associateId).toBe(w.tess.id);
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } });
    expect(approval).toMatchObject({ status: 'PENDING', action: 'SHIFT_ASSIGN' });
    expect(approval.summary).toMatch(/Tess Free.*Housekeeper.*The Grand Hotel/);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBeNull();
    // A second tick does not propose again.
    expect((await runShiftFill(prisma, w.now)).proposed).toBe(0);

    // The property manager's queue: one item, deep-linked to the shift, Approve and Reject.
    const manager = await loginAs(agent(), w.manager.email);
    const queue = await manager.get('/me/decisions');
    expect(queue.status).toBe(200);
    const item = (queue.body.decisions ?? queue.body.items ?? queue.body).find((d: { key: string }) => d.key === `agents:shift-fill:${approval.id}`);
    expect(item, JSON.stringify(queue.body)).toMatchObject({ quickAction: 'Approve', declineAction: 'Reject' });
    // The item opens the proposal itself, with its evidence, on the Approvals page.
    expect(item.linkUrl).toBe(`/approvals?tab=proposals&proposal=${approval.id}`);

    const approve = await manager.post('/me/decisions/quick').send({ key: item.key });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.summary).toMatch(/assigned/i);

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } });
    expect(shift).toMatchObject({ assignedAssociateId: w.tess.id, status: 'ASSIGNED' });
    const done = await prisma.agentProposal.findUniqueOrThrow({ where: { id: p!.id } });
    expect(done.status).toBe('EXECUTED');
    expect((done.outcome as Record<string, unknown>).associateId).toBe(w.tess.id);
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('CONSUMED');

    // The trail: the person approved, the agent assigned citing the approval.
    await flushPendingAudits();
    const approved = await prisma.auditLog.findFirst({ where: { action: 'agent.approval.approved', entityId: approval.id } });
    expect(approved?.actorUserId).toBe(w.manager.id);
    const assigned = await prisma.auditLog.findFirst({ where: { action: 'shift.assigned', entityId: w.shift.id, workerId: w.workerId } });
    expect(assigned).toBeTruthy();
    expect((assigned!.metadata as Record<string, unknown>).approvalId).toBe(approval.id);

    // Closure to the approver, linked to the shift.
    await flushPendingNotifications();
    const closure = await prisma.notification.findFirst({ where: { recipientUserId: w.manager.id, category: 'agent_shift_fill', channel: 'IN_APP' } });
    expect(closure?.subject).toMatch(/Shift filled: Tess Free/);
    expect(closure?.linkUrl).toContain(`location=${w.hotel.id}`);

    // The capability's scorecard reads the outcome.
    const admin = await loginAs(agent(), w.hr.email);
    const sc = await admin.get(`/agents/${w.workerId}/capabilities/${SHIFT_FILL}/scorecard`);
    expect(sc.status, JSON.stringify(sc.body)).toBe(200);
    expect(sc.body).toMatchObject({ proposed: 1, approved: 1, executed: 1 });
    expect(sc.body.metrics).toMatchObject({ proposalsMade: 1, proposalsApproved: 1, filledBeforeStart: 1 });
  });

  it('a rejected person is not proposed again for that shift', async () => {
    const w = await hotelWorld();
    const extra = await createAssociate({ firstName: 'Ana', lastName: 'Second' });
    await prisma.associateAssignment.create({ data: { associateId: extra.id, locationId: w.hotel.id, startedAt: new Date(w.now.getTime() - 30 * 24 * HOUR) } });
    await runShiftFill(prisma, w.now);
    const [first] = await proposalsFor(w.shift.id);
    const firstPick = (first!.payload as Record<string, unknown>).associateId;
    const manager = await loginAs(agent(), w.manager.email);
    const reject = await manager.post('/me/decisions/quick').send({ key: `agents:shift-fill:${first!.approvalId}`, decline: true });
    expect(reject.status, JSON.stringify(reject.body)).toBe(200);
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('REJECTED');
    await runShiftFill(prisma, w.now);
    const all = await proposalsFor(w.shift.id);
    expect(all).toHaveLength(2);
    expect((all[1]!.payload as Record<string, unknown>).associateId).not.toBe(firstPick);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBeNull();
  });
});

describe('shift.fill: when it does not act', () => {
  it('waits for the broadcast window, and never proposes someone placed at another property', async () => {
    const early = await hotelWorld({ publishedHoursAgo: 0.25 });
    expect((await runShiftFill(prisma, early.now)).proposed).toBe(0);
    // Window passed: only the hotel's bench is considered (Far is at the other inn and free).
    await prisma.shift.update({ where: { id: early.shift.id }, data: { publishedAt: new Date(early.now.getTime() - 3 * HOUR) } });
    await runShiftFill(prisma, early.now);
    const [p] = await proposalsFor(early.shift.id);
    expect((p!.payload as Record<string, unknown>).associateId).toBe(early.tess.id);
    // Nobody free at the property: no proposal (Tess is now busy too).
    await truncateAll();
    const w = await hotelWorld();
    await prisma.shift.create({ data: { clientId: null, locationId: w.hotel.id, position: 'Housekeeper', startsAt: w.shift.startsAt, endsAt: w.shift.endsAt, status: 'ASSIGNED', assignedAssociateId: w.tess.id, publishedAt: w.now } });
    expect((await runShiftFill(prisma, w.now)).proposed).toBe(0);
  });

  it('a shift filled another way supersedes the proposal and takes it off the desk; approving a moot proposal assigns nothing', async () => {
    const w = await hotelWorld();
    await runShiftFill(prisma, w.now);
    const [p] = await proposalsFor(w.shift.id);
    // The property manager fills it by hand with someone else.
    const zed = await createAssociate({ firstName: 'Zed', lastName: 'Hand' });
    await prisma.associateAssignment.create({ data: { associateId: zed.id, locationId: w.hotel.id, startedAt: new Date(w.now.getTime() - 30 * 24 * HOUR) } });
    const manager = await loginAs(agent(), w.manager.email);
    const byHand = await manager.post(`/scheduling/shifts/${w.shift.id}/assign`).send({ associateId: zed.id });
    expect(byHand.status, JSON.stringify(byHand.body)).toBe(200);
    const tick = await runShiftFill(prisma, w.now);
    expect(tick.superseded).toBe(1);
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: p!.id } })).status).toBe('SUPERSEDED');
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } })).status).toBe('EXPIRED');
    const queue = await manager.get('/me/decisions');
    expect(JSON.stringify(queue.body)).not.toContain(`agents:shift-fill:${p!.approvalId}`);

    // Approved before the sweep noticed: the executor supersedes instead of assigning.
    await truncateAll();
    const v = await hotelWorld();
    await runShiftFill(prisma, v.now);
    const [q] = await proposalsFor(v.shift.id);
    const other = await createAssociate({ firstName: 'Other', lastName: 'Hand' });
    await prisma.shift.update({ where: { id: v.shift.id }, data: { assignedAssociateId: other.id, status: 'ASSIGNED' } });
    const admin = await loginAs(agent(), v.hr.email);
    expect((await admin.post(`/agents/approvals/${q!.approvalId}/approve`).send({})).status).toBe(200);
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: q!.id } })).status).toBe('SUPERSEDED');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: v.shift.id } })).assignedAssociateId).toBe(other.id);
  });

  it('the capability suspended or the tenant switch on: no proposals, and an approved one waits until the switch lifts', async () => {
    const w = await hotelWorld();
    await suspendCapability(prisma, w.workerId, SHIFT_FILL, ALTO_TENANT_ID, w.hr.id, 'Checking the picks');
    expect(await runShiftFill(prisma, w.now)).toMatchObject({ proposed: 0, skipped: 'capability_off' });
    await resumeCapability(prisma, w.workerId, SHIFT_FILL, ALTO_TENANT_ID, w.hr.id);
    await suspendTenantAgents(prisma, ALTO_TENANT_ID, w.hr.id, 'Pause all agents');
    expect(await runShiftFill(prisma, w.now)).toMatchObject({ proposed: 0, skipped: 'agent_stopped' });
    expect(await proposalsFor(w.shift.id)).toHaveLength(0);

    // Proposed while running, approved while stopped: held, then carried out when the switch lifts.
    await resumeTenantAgents(prisma, ALTO_TENANT_ID, w.hr.id);
    await runShiftFill(prisma, w.now);
    const [p] = await proposalsFor(w.shift.id);
    await suspendTenantAgents(prisma, ALTO_TENANT_ID, w.hr.id, 'Pause again');
    const admin = await loginAs(agent(), w.hr.email);
    expect((await admin.post(`/agents/approvals/${p!.approvalId}/approve`).send({})).status).toBe(200);
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: p!.id } })).status).toBe('APPROVED');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBeNull();
    await resumeTenantAgents(prisma, ALTO_TENANT_ID, w.hr.id);
    expect((await runShiftFill(prisma, w.now)).executed).toBe(1);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBe(w.tess.id);
  });

  it('a tenant with scheduling off is skipped', async () => {
    const w = await hotelWorld();
    await prisma.tenant.update({ where: { id: ALTO_TENANT_ID }, data: { modules: { scheduling: false } } });
    invalidateTenantProfile();
    expect(await runShiftFill(prisma, w.now)).toMatchObject({ proposed: 0, skipped: 'module_off' });
  });
});

describe('shift.fill: certification', () => {
  it('the catalog fixture runs through the real pick and passes; the agent certifies from the page', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
    const workerId = (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
    const fixture = catalogFixture(SHIFT_FILL, 'Two open shifts, three on the bench, one already working: the free person is proposed')!;
    expect(fixture).toBeTruthy();
    const direct = await runCapabilityFixture(SHIFT_FILL, fixture, new Date('2026-10-14T12:00:00.000Z'));
    expect(direct, JSON.stringify(direct)).toMatchObject({ passed: true, reason: null });
    expect(direct.refAnswer?.output).toEqual({ proposedRef: 'tess' });

    const admin = await loginAs(agent(), hr.email);
    const run = await admin.post(`/agents/${workerId}/scenarios/run`).send({});
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    // Each of the Workforce agent's capabilities carries a fixture (shift.fill, schedule.repair, attendance.confirm, coverage.forecast).
    expect(run.body).toMatchObject({ ran: 4, passed: 4 });
    // Nothing of the fixture's world is left behind.
    expect(await prisma.associate.count({ where: { email: { endsWith: '@fixture.invalid' } } })).toBe(0);
  });
});
