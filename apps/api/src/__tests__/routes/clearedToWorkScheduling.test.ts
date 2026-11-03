import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listEligibleOpenShifts } from '../../routes/qualifications.js';
import { rankBench } from '../../lib/workforceAgent.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { orgDateKey, utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';
import { addDaysToKey } from '../../lib/timezone.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Cleared to work — the HARD scheduling block (owner, 2026-11-03).
 *
 * Every path that puts a person on a shift refuses a shift on or after the
 * day their work authorization or J-1 program ended: assign (409
 * not_authorized_to_work, audited), bulk create (skipped with the reason),
 * the open-shift list and a pickup, and the fill agent. Only a user with
 * manage:compliance may assign anyway, with a reason of 10+ characters,
 * and the override is audited as work_authorization.override.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const TZ = 'America/New_York';
const today = () => orgDateKey(new Date());
/** A shift on the company day `offset` days from today, 10:00–18:00 New York. */
function shiftTimes(offset: number) {
  const midnight = utcInstantOfLocalMidnight(addDaysToKey(today(), offset), TZ);
  return { startsAt: new Date(midnight.getTime() + 10 * 3_600_000), endsAt: new Date(midnight.getTime() + 18 * 3_600_000) };
}
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function world() {
  const client = await createClient('Harbor Hotel');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { timezone: TZ } });
  const hire = async (first: string) => {
    const a = await createAssociate({ firstName: first, lastName: 'Worker' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: day('2026-01-05') } });
    return a;
  };
  // Maria's work authorization ends in 3 days: cleared through then, not after.
  const maria = await hire('Maria');
  await prisma.i9Verification.create({
    data: { associateId: maria.id, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: day(addDaysToKey(today(), 3)), section2CompletedAt: new Date() },
  });
  const shift = async (offset: number, status: 'OPEN' | 'DRAFT' = 'OPEN') =>
    prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Houseperson', ...shiftTimes(offset), status, publishedAt: status === 'OPEN' ? new Date() : null } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  // A shift supervisor schedules but does not hold manage:compliance.
  const { user: supervisor } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
  return { client, site, maria, hire, shift, hr, supervisor };
}

describe('assign', () => {
  it('refuses a shift after the authorization ends with not_authorized_to_work, audits the attempt, and allows the days before', async () => {
    const w = await world();
    const after = await w.shift(5);
    const before = await w.shift(2);
    const hr = await loginAs(agent(), w.hr.email);

    const blocked = await hr.post(`/scheduling/shifts/${after.id}/assign`).send({ associateId: w.maria.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('not_authorized_to_work');
    expect(blocked.body.error.message).toContain("Maria Worker's work authorization ends on");
    expect(blocked.body.error.message).toContain('Record the re-verification on the I-9 first.');
    expect(blocked.body.error.details).toMatchObject({ associateId: w.maria.id, canOverride: true });
    expect(blocked.body.error.details.blockers[0].kind).toBe('WORK_AUTH_ENDED');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: after.id } })).assignedAssociateId).toBeNull();

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'work_authorization.blocked', entityId: w.maria.id } });
    expect(audit.actorUserId).toBe(w.hr.id);
    expect(audit.metadata).toMatchObject({ via: 'assign', shiftId: after.id, day: addDaysToKey(today(), 5) });

    const ok = await hr.post(`/scheduling/shifts/${before.id}/assign`).send({ associateId: w.maria.id });
    expect(ok.status).toBe(200);
  });

  it('a scheduler without manage:compliance gets "Ask HR", and their override is not honoured', async () => {
    const w = await world();
    const after = await w.shift(5);
    const sup = await loginAs(agent(), w.supervisor.email);
    const r = await sup
      .post(`/scheduling/shifts/${after.id}/assign`)
      .send({ associateId: w.maria.id, overrideWorkAuthorization: { reason: 'Sponsor letter says it was extended' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_authorized_to_work');
    expect(r.body.error.message).toContain('Ask HR');
    expect(r.body.error.details.canOverride).toBe(false);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: after.id } })).assignedAssociateId).toBeNull();
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'work_authorization.override' } })).toBe(0);
  });

  it('HR assigns anyway with a reason, and the override is audited with the blocker and the reason; a short reason is refused', async () => {
    const w = await world();
    const after = await w.shift(5);
    const hr = await loginAs(agent(), w.hr.email);

    const short = await hr.post(`/scheduling/shifts/${after.id}/assign`).send({ associateId: w.maria.id, overrideWorkAuthorization: { reason: 'ok' } });
    expect(short.status).toBe(400);

    const reason = 'EAD renewal receipt on file, 180-day extension';
    const r = await hr.post(`/scheduling/shifts/${after.id}/assign`).send({ associateId: w.maria.id, overrideWorkAuthorization: { reason } });
    expect(r.status).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: after.id } })).assignedAssociateId).toBe(w.maria.id);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'work_authorization.override' } });
    expect(audit.actorUserId).toBe(w.hr.id);
    expect(audit.entityType).toBe('Shift');
    expect(audit.entityId).toBe(after.id);
    expect(audit.metadata).toMatchObject({ associateId: w.maria.id, shiftId: after.id, reason, via: 'assign', blockers: [{ kind: 'WORK_AUTH_ENDED', endsOn: addDaysToKey(today(), 3) }] });
  });
});

describe('the other paths', () => {
  it('bulk create skips the days after the end with the reason, and keeps the days before', async () => {
    const w = await world();
    const hr = await loginAs(agent(), w.hr.email);
    const d2 = shiftTimes(2);
    const d5 = shiftTimes(5);
    const r = await hr.post('/scheduling/shifts/bulk').send({
      clientId: w.client.id,
      locationId: w.site.id,
      position: 'Houseperson',
      startsAt: d2.startsAt.toISOString(),
      endsAt: d2.endsAt.toISOString(),
      extraOccurrences: [{ startsAt: d5.startsAt.toISOString(), endsAt: d5.endsAt.toISOString() }],
      status: 'DRAFT',
      associateIds: [w.maria.id],
    });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(1);
    expect(r.body.skipped).toEqual([expect.objectContaining({ associateId: w.maria.id, reason: 'not_authorized_to_work', startsAt: d5.startsAt.toISOString() })]);
    const mine = await prisma.shift.findMany({ where: { assignedAssociateId: w.maria.id } });
    expect(mine.map((s) => s.startsAt.toISOString())).toEqual([d2.startsAt.toISOString()]);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'work_authorization.blocked', entityId: w.maria.id } })).toBe(1);
  });

  it('the open-shift list leaves out shifts after the end, and a pickup there is refused', async () => {
    const w = await world();
    const before = await w.shift(2);
    const after = await w.shift(5);
    const eligible = await listEligibleOpenShifts(w.maria.id);
    expect(eligible.map((s) => s.id)).toEqual([before.id]);
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: w.maria.id });
    const maria = await loginAs(agent(), user.email);
    const claim = await maria.post(`/shifts/${after.id}/claim`).send({});
    expect(claim.status).toBe(409);
    expect(claim.body.error.code).toBe('not_authorized_to_work');
  });

  it('a pickup request approved after the end is refused', async () => {
    const w = await world();
    const after = await w.shift(5);
    const claim = await prisma.openShiftClaim.create({ data: { shiftId: after.id, associateId: w.maria.id, status: 'PENDING' } });
    const hr = await loginAs(agent(), w.hr.email);
    const r = await hr.post(`/scheduling/open-shift-claims/${claim.id}/approve`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_authorized_to_work');
    expect((await prisma.openShiftClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('PENDING');
  });

  it('a swap that hands a shift after the end to them is refused at approval', async () => {
    const w = await world();
    const ben = await w.hire('Ben');
    const bens = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.site.id, position: 'Houseperson', ...shiftTimes(5), status: 'ASSIGNED', assignedAssociateId: ben.id, publishedAt: new Date() } });
    const swap = await prisma.shiftSwapRequest.create({ data: { shiftId: bens.id, requesterAssociateId: ben.id, counterpartyAssociateId: w.maria.id, status: 'PEER_ACCEPTED' } });
    const hr = await loginAs(agent(), w.hr.email);
    const r = await hr.post(`/scheduling/swap-requests/${swap.id}/manager-approve`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_authorized_to_work');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: bens.id } })).assignedAssociateId).toBe(ben.id);
  });

  it('"Approve anyway" on a pickup: a supervisor cannot, a short reason is refused, HR with a reason assigns it and the override is audited (both routes)', async () => {
    const w = await world();
    const reason = 'Receipt notice on file, auto-extended 540 days';
    // The scheduling desk's route.
    const first = await w.shift(5);
    const claim = await prisma.openShiftClaim.create({ data: { shiftId: first.id, associateId: w.maria.id, status: 'PENDING' } });
    const sup = await loginAs(agent(), w.supervisor.email);
    const denied = await sup.post(`/scheduling/open-shift-claims/${claim.id}/approve`).send({ overrideWorkAuthorization: { reason } });
    expect(denied.status).toBe(409);
    expect(denied.body.error.details.canOverride).toBe(false);
    const hr = await loginAs(agent(), w.hr.email);
    const short = await hr.post(`/scheduling/open-shift-claims/${claim.id}/approve`).send({ overrideWorkAuthorization: { reason: 'ok' } });
    expect(short.status).toBe(400);
    const ok = await hr.post(`/scheduling/open-shift-claims/${claim.id}/approve`).send({ overrideWorkAuthorization: { reason } });
    expect(ok.status).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: first.id } })).assignedAssociateId).toBe(w.maria.id);

    // The marketplace's route.
    const second = await w.shift(6);
    const claim2 = await prisma.openShiftClaim.create({ data: { shiftId: second.id, associateId: w.maria.id, status: 'PENDING' } });
    const blocked = await hr.put(`/shifts/${second.id}/claims/${claim2.id}`).send({ status: 'APPROVED' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('not_authorized_to_work');
    const ok2 = await hr.put(`/shifts/${second.id}/claims/${claim2.id}`).send({ status: 'APPROVED', overrideWorkAuthorization: { reason } });
    expect(ok2.status).toBe(200);

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { action: 'work_authorization.override' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.entityId).sort()).toEqual([first.id, second.id].sort());
    for (const a of audits) {
      expect(a.actorUserId).toBe(w.hr.id);
      expect(a.metadata).toMatchObject({ associateId: w.maria.id, via: 'claim_approve', reason, blockers: [{ kind: 'WORK_AUTH_ENDED' }] });
    }
  });

  it('"Approve anyway" on a swap: HR with a reason moves the shift and the override is audited', async () => {
    const w = await world();
    const ben = await w.hire('Ben');
    const bens = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.site.id, position: 'Houseperson', ...shiftTimes(5), status: 'ASSIGNED', assignedAssociateId: ben.id, publishedAt: new Date() } });
    const swap = await prisma.shiftSwapRequest.create({ data: { shiftId: bens.id, requesterAssociateId: ben.id, counterpartyAssociateId: w.maria.id, status: 'PEER_ACCEPTED' } });
    const sup = await loginAs(agent(), w.supervisor.email);
    const reason = 'Sponsor extension letter on file today';
    const denied = await sup.post(`/scheduling/swap-requests/${swap.id}/manager-approve`).send({ overrideWorkAuthorization: { reason } });
    expect(denied.status).toBe(409);
    const hr = await loginAs(agent(), w.hr.email);
    const ok = await hr.post(`/scheduling/swap-requests/${swap.id}/manager-approve`).send({ overrideWorkAuthorization: { reason } });
    expect(ok.status).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: bens.id } })).assignedAssociateId).toBe(w.maria.id);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'work_authorization.override' } });
    expect(audit).toMatchObject({ actorUserId: w.hr.id, entityId: bens.id });
    expect(audit.metadata).toMatchObject({ associateId: w.maria.id, via: 'swap_approve', reason });
  });

  it('the fill agent skips someone not cleared for the shift day and says why; the suggestions leave them out', async () => {
    const w = await world();
    const ben = await w.hire('Ben');
    const after = await w.shift(5);
    const ranking = await rankBench(
      prisma,
      { id: after.id, clientId: w.client.id, locationId: w.site.id, position: after.position, startsAt: after.startsAt, endsAt: after.endsAt, locationRel: { timezone: TZ } },
      new Date(),
      { tenantId: ALTO_TENANT_ID },
    );
    expect(ranking.pick?.associateId).toBe(ben.id);
    expect(ranking.considered.find((c) => c.associateId === w.maria.id)?.whyNot).toContain('not cleared to work');

    const hr = await loginAs(agent(), w.hr.email);
    const suggestions = await hr.get(`/scheduling/shifts/${after.id}/auto-fill`);
    expect(suggestions.status).toBe(200);
    const ids = (suggestions.body.candidates as Array<{ associateId: string }>).map((c) => c.associateId);
    expect(ids).toContain(ben.id);
    expect(ids).not.toContain(w.maria.id);
  });
});
