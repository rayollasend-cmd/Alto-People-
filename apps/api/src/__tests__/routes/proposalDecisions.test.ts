import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { runShiftFill, SHIFT_FILL } from '../../lib/workforceAgent.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * "Agents propose, people decide" — the decision reaches the people it is
 * for, with evidence.
 *
 *   A shift-fill proposal carries why this person, who else was weighed and
 *   why not, the impact on their week, the rule that put it in front of a
 *   person, and who it touches. The site's supervisor (no view:org) finds it
 *   under Approvals → Proposals, in their inbox and on the phone badge, and
 *   decides it through one endpoint; a supervisor from another site cannot.
 *   A rejection says why, and the reason stays on the proposal and the
 *   trail. The control room lists only this site's proposals.
 */

const HOUR = 3_600_000;

// The world puts Ana's long week 24h after the open shift. Near a week
// boundary those land in different weeks and the ranking flips, so hold the
// clock at the coming Tuesday 08:00 (local): both shifts sit mid-week whatever
// day the week starts on. Only Date is faked; HTTP keeps its real timers.
function comingTuesdayAt8(): Date {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  d.setDate(d.getDate() + (((2 - d.getDay()) + 7) % 7 || 7));
  return d;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(comingTuesdayAt8());
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

/** A hotel with a site-bound property manager, three people on its bench (one busy), one elsewhere, an open shift; and another inn with its own manager. */
async function hotelWorld() {
  const now = new Date();
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const hotel = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, timezone: 'America/Chicago' } });
  const inn = await prisma.site.create({ data: { name: 'The Other Inn', clientId: null, timezone: 'America/Chicago' } });
  const place = (associateId: string, locationId: string) =>
    prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date(now.getTime() - 30 * 24 * HOUR) } });
  const tess = await createAssociate({ firstName: 'Tess', lastName: 'Free' });
  const omar = await createAssociate({ firstName: 'Omar', lastName: 'Busy' });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Second' });
  const far = await createAssociate({ firstName: 'Far', lastName: 'Away' });
  await place(tess.id, hotel.id);
  await place(omar.id, hotel.id);
  await place(ana.id, hotel.id);
  await place(far.id, inn.id);
  const startsAt = new Date(now.getTime() + 10 * HOUR);
  const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
  // Omar already works across the open shift's window; Ana has a long week already.
  await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt: new Date(startsAt.getTime() - HOUR), endsAt: new Date(endsAt.getTime() - HOUR), status: 'ASSIGNED', assignedAssociateId: omar.id, publishedAt: now } });
  await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt: new Date(startsAt.getTime() + 24 * HOUR), endsAt: new Date(endsAt.getTime() + 24 * HOUR), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: now } });
  const shift = await prisma.shift.create({
    data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt, endsAt, status: 'OPEN', publishedAt: new Date(now.getTime() - 3 * HOUR) },
  });
  const { user: manager } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: hotel.id } });
  const { user: stranger } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  await prisma.user.update({ where: { id: stranger.id }, data: { locationId: inn.id } });
  const run = await runShiftFill(prisma, now);
  expect(run).toMatchObject({ proposed: 1 });
  const proposal = await prisma.agentProposal.findFirstOrThrow({ where: { capabilityKey: SHIFT_FILL, subjectId: shift.id } });
  return { now, hr, workerId, hotel, inn, tess, omar, ana, far, shift, manager, stranger, proposal, approvalId: proposal.approvalId! };
}

type Evidence = { why: string; alternatives: Array<{ label: string; note: string }>; impact: Array<{ label: string; value: string }>; policy: string | null; affects: Array<{ kind: string; id: string; name: string }> };

describe('the evidence on a proposal', () => {
  it('a shift-fill proposal says why this person, who else was weighed and why not, the impact, the rule and who it touches', async () => {
    const w = await hotelWorld();
    const stored = w.proposal.evidence as Evidence;
    expect(stored.why).toMatch(/Tess Free is placed at The Grand Hotel/);
    expect(stored.why).toMatch(/broadcast/);
    // Omar: an overlapping shift. Ana: free, but more hours this week. Leaving it open is the last alternative.
    expect(stored.alternatives.find((a) => a.label === 'Omar Busy')?.note).toMatch(/overlaps/);
    expect(stored.alternatives.find((a) => a.label === 'Ana Second')?.note).toMatch(/more hours/);
    expect(stored.alternatives.at(-1)?.label).toBe('Leave it open');
    expect(stored.impact.map((m) => m.label)).toEqual(expect.arrayContaining(['Shift', 'Overtime', 'Bench']));
    expect(stored.impact.find((m) => m.label === 'Overtime')?.value).toBe('None expected');
    expect(stored.affects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'person', id: w.tess.id, name: 'Tess Free' }),
        expect.objectContaining({ kind: 'site', id: w.hotel.id, name: 'The Grand Hotel' }),
        expect.objectContaining({ kind: 'shift', id: w.shift.id }),
      ]),
    );

    // The row the pages read carries it, with the policy line, the agent's family and owner.
    const manager = await loginAs(agent(), w.manager.email);
    const res = await manager.get('/approvals/proposals');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.approvals).toHaveLength(1);
    const row = res.body.approvals[0];
    expect(row).toMatchObject({ id: w.approvalId, action: 'SHIFT_ASSIGN', status: 'PENDING', mayDecide: true, agentFamily: 'workforce', capabilityKey: SHIFT_FILL, proposalId: w.proposal.id });
    expect(row.agentOwner).toMatchObject({ id: w.hr.id });
    expect(row.evidence.why).toBe(stored.why);
    expect(row.evidence.policy).toMatch(/Shift assignment always needs a person's approval/);

    // The registry's own list (view:org) carries the same evidence and marks it decidable for an admin.
    const admin = await loginAs(agent(), w.hr.email);
    const reg = await admin.get('/agents/approvals?status=PENDING');
    expect(reg.status).toBe(200);
    expect(reg.body.approvals[0]).toMatchObject({ id: w.approvalId, mayDecide: true });
    expect(reg.body.approvals[0].evidence.alternatives.length).toBeGreaterThan(1);
  });
});

describe('one decision endpoint, under the server rule', () => {
  it('the site supervisor approves; the agent assigns and the request is consumed', async () => {
    const w = await hotelWorld();
    const manager = await loginAs(agent(), w.manager.email);
    const res = await manager.post(`/agents/approvals/${w.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: w.approvalId, status: 'APPROVED', mayDecide: false });
    expect(res.body.decidedBy).toMatchObject({ id: w.manager.id });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } });
    expect(shift).toMatchObject({ assignedAssociateId: w.tess.id, status: 'ASSIGNED' });
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: w.proposal.id } })).status).toBe('EXECUTED');
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: w.approvalId } })).status).toBe('CONSUMED');
    // Decided: gone from the queue, and a second decision is refused.
    expect((await manager.get('/approvals/proposals')).body.approvals).toEqual([]);
    const again = await manager.post(`/agents/approvals/${w.approvalId}/decide`).send({ decision: 'REJECT', reason: 'changed my mind' });
    expect(again.status).toBe(409);
  });

  it('a supervisor from another site sees nothing and gets 403; an associate gets 403', async () => {
    const w = await hotelWorld();
    const stranger = await loginAs(agent(), w.stranger.email);
    expect((await stranger.get('/approvals/proposals')).body.approvals).toEqual([]);
    const res = await stranger.post(`/agents/approvals/${w.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(res.status).toBe(403);
    const { user: associate } = await createUser({ role: 'ASSOCIATE', associateId: w.far.id });
    const a = await loginAs(agent(), associate.email);
    expect((await a.post(`/agents/approvals/${w.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: w.approvalId } })).status).toBe('PENDING');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBeNull();
  });

  it('a rejection needs a reason, which stays on the proposal and the trail; the old routes still work', async () => {
    const w = await hotelWorld();
    const manager = await loginAs(agent(), w.manager.email);
    const bare = await manager.post(`/agents/approvals/${w.approvalId}/decide`).send({ decision: 'REJECT' });
    expect(bare.status).toBe(400);
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: w.approvalId } })).status).toBe('PENDING');

    const res = await manager.post(`/agents/approvals/${w.approvalId}/decide`).send({ decision: 'REJECT', reason: 'Tess asked for a lighter week.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', decisionNote: 'Tess asked for a lighter week.' });
    const p = await prisma.agentProposal.findUniqueOrThrow({ where: { id: w.proposal.id } });
    expect(p.status).toBe('REJECTED');
    expect((p.outcome as Record<string, unknown>).reason).toBe('Tess asked for a lighter week.');
    await flushPendingAudits();
    const trail = await prisma.auditLog.findFirst({ where: { action: 'agent.approval.rejected', entityId: w.approvalId } });
    expect(trail?.actorUserId).toBe(w.manager.id);
    expect((trail!.metadata as Record<string, unknown>).reason).toBe('Tess asked for a lighter week.');

    // The next tick proposes the next person (Ana), with Tess among the alternatives as turned down.
    await runShiftFill(prisma, w.now);
    const second = await prisma.agentProposal.findFirstOrThrow({ where: { capabilityKey: SHIFT_FILL, subjectId: w.shift.id, status: 'PROPOSED' } });
    expect((second.payload as Record<string, unknown>).associateId).toBe(w.ana.id);
    expect((second.evidence as Evidence).alternatives.find((a) => a.label === 'Tess Free')?.note).toMatch(/turned down/);
    // The legacy approve route, same rule.
    const legacy = await manager.post(`/agents/approvals/${second.approvalId}/approve`).send({});
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBe(w.ana.id);
  });
});

describe('where decisions live', () => {
  it('the inbox, the Approvals count and the decision queue carry the proposal for the site supervisor and link to it', async () => {
    const w = await hotelWorld();
    const manager = await loginAs(agent(), w.manager.email);
    const inbox = await manager.get('/me/inbox');
    expect(inbox.status).toBe(200);
    const source = inbox.body.sources.find((s: { key: string }) => s.key === 'agent-proposals');
    expect(source).toMatchObject({ count: 1, path: '/approvals?tab=proposals' });
    const count = await manager.get('/approvals/count');
    expect(count.status).toBe(200);
    expect(count.body.proposals).toBe(1);
    expect(count.body.total).toBeGreaterThanOrEqual(1);
    const queue = await manager.get('/me/decisions');
    const item = (queue.body.decisions ?? queue.body).find((d: { key: string }) => d.key === `agents:shift-fill:${w.approvalId}`);
    expect(item.linkUrl).toBe(`/approvals?tab=proposals&proposal=${w.approvalId}`);
    // The notice to the owner opens the same place.
    await flushPendingNotifications();
    const notice = await prisma.notification.findFirst({ where: { category: 'agent_approval', channel: 'IN_APP' } });
    expect(notice?.linkUrl).toBe(`/approvals?tab=proposals&proposal=${w.approvalId}`);

    // Another site's supervisor: nothing.
    const stranger = await loginAs(agent(), w.stranger.email);
    const theirs = await stranger.get('/me/inbox');
    expect(theirs.body.sources.find((s: { key: string }) => s.key === 'agent-proposals')?.count ?? 0).toBe(0);
    expect((await stranger.get('/approvals/count')).body.proposals).toBe(0);
  });

  it('the control room lists only this site’s proposals, with the expiry in the site’s zone and the link to the decision', async () => {
    const w = await hotelWorld();
    const admin = await loginAs(agent(), w.hr.email);
    const hotel = await admin.get(`/control-room?locationId=${w.hotel.id}`);
    expect(hotel.status, JSON.stringify(hotel.body)).toBe(200);
    const waiting = hotel.body.waiting.filter((x: { kind: string }) => x.kind === 'AGENT_APPROVAL');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ id: `approval:${w.approvalId}`, link: `/approvals?tab=proposals&proposal=${w.approvalId}` });
    expect(waiting[0].detail).toMatch(/^Expires [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M$/);
    expect(waiting[0].detail).not.toMatch(/T\d\d:\d\d/);
    const inn = await admin.get(`/control-room?locationId=${w.inn.id}`);
    expect(inn.status).toBe(200);
    expect(inn.body.waiting.filter((x: { kind: string }) => x.kind === 'AGENT_APPROVAL')).toEqual([]);
  });
});
