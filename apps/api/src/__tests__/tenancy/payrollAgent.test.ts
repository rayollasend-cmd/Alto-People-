import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilityScenarios } from '@alto-people/shared';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, decideApproval, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { catalogFixture, runCapabilityFixture } from '../../lib/agentCapabilities.js';
import { PAYROLL_PREP, planPayrollPrep, runPayrollPrep } from '../../lib/payrollAgent.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * BEYOND — the Payroll agent's payroll.prep: before each payroll, a proposed
 * fix for every exception, with its evidence, through the PAY_CHANGE gate.
 * Nothing about pay moves until a person decides.
 */

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'payroll-agent', ALTO_TENANT_ID))!;
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const client = await createClient('Coastal');
  await prisma.shiftRateDefault.create({ data: { clientId: client.id, position: 'Picker', payRate: 18.5, billRate: 27, effectiveFrom: d('2026-01-01') } });
  // Ana: no W-4. Ben: W-4 but no pay record, worked as a Picker. Both in a draft run.
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const ben = await createAssociate({ firstName: 'Ben', lastName: 'Okafor' });
  await prisma.associate.updateMany({ where: { id: { in: [ana.id, ben.id] } }, data: { state: 'FL' } });
  await prisma.w4Submission.create({ data: { associateId: ben.id, filingStatus: 'SINGLE' } });
  await prisma.compensationRecord.create({ data: { associateId: ana.id, effectiveFrom: d('2026-01-01'), payType: 'HOURLY', amount: 17, reason: 'HIRE' } });
  for (const p of [ana, ben]) {
    const start = new Date('2026-09-15T13:00:00Z');
    const shift = await prisma.shift.create({ data: { clientId: client.id, position: 'Picker', startsAt: start, endsAt: new Date(start.getTime() + 8 * 3_600_000), status: 'COMPLETED', assignedAssociateId: p.id } });
    await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, shiftId: shift.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * 3_600_000), status: 'APPROVED' } });
  }
  const run = await prisma.payrollRun.create({ data: { clientId: client.id, periodStart: d('2026-09-12'), periodEnd: d('2026-09-25'), status: 'DRAFT', kind: 'REGULAR', totalGross: 0, totalTax: 0, totalNet: 0 } });
  return { hr, workerId, client, ana, ben, run };
}

describe('payroll.prep: the plan', () => {
  it('one fix per exception it can fix; no rate without a rate card; one review per state', () => {
    const plan = planPayrollPrep(
      [
        { associateId: 'a', associateName: 'A', kind: 'MISSING_W4' },
        { associateId: 'b', associateName: 'B', kind: 'MISSING_COMP_RECORD' },
        { associateId: 'c', associateName: 'C', kind: 'MISSING_COMP_RECORD' },
        { associateId: 'e', associateName: 'E', kind: 'MISSING_BANK_ACCOUNT' },
        { associateId: 'f', associateName: 'F', kind: 'UNSUPPORTED_STATE', detail: { state: 'AR' } },
        { associateId: 'g', associateName: 'G', kind: 'UNSUPPORTED_STATE', detail: { state: 'AR' } },
        { associateId: 'h', associateName: 'H', kind: 'OT_SPIKE' },
      ],
      new Map([['b', { amount: 18.5, position: 'Picker', clientId: null, clientName: null, effectiveFrom: '2026-09-12' }], ['c', null]]),
    );
    expect(plan.map((p) => `${p.action}:${p.associateId ?? p.state}`)).toEqual(['NUDGE_W4:a', 'SET_RATE:b', 'PAY_CARD:e', 'STATE_REVIEW:AR']);
  });

  it('certification: the catalog scenario passes', async () => {
    const [scenario] = capabilityScenarios(PAYROLL_PREP);
    expect(catalogFixture(PAYROLL_PREP, scenario.name)).not.toBeNull();
    const r = await runCapabilityFixture(PAYROLL_PREP, scenario, new Date());
    expect(r.reason).toBeNull();
    expect(r.passed).toBe(true);
  });
});

describe('payroll.prep: proposals, and no pay change without a decision', () => {
  it('proposes with evidence through the PAY_CHANGE gate; the rate is set only on approval, in the approver’s name; a rejection stands', async () => {
    const w = await world();
    const out = await runPayrollPrep(prisma, { runId: w.run.id });
    expect(out).toMatchObject({ runs: 1, proposed: 4 }); // W-4 for Ana, the rate for Ben, a pay card for each
    const proposals = await prisma.agentProposal.findMany({ where: { capabilityKey: PAYROLL_PREP }, orderBy: { createdAt: 'asc' } });
    const byAction = Object.fromEntries(proposals.map((p) => [(p.payload as { action: string }).action, p]));
    expect(Object.keys(byAction).sort()).toEqual(['NUDGE_W4', 'PAY_CARD', 'SET_RATE']);
    expect(byAction.NUDGE_W4.subjectId).toBe(w.ana.id);
    const rate = byAction.SET_RATE;
    expect(rate.payload).toMatchObject({ associateId: w.ben.id, rate: 18.5, position: 'Picker', runId: w.run.id });
    expect((rate.evidence as { why: string }).why).toContain('$18.50 an hour');
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: rate.approvalId! } });
    expect(approval).toMatchObject({ action: 'PAY_CHANGE', status: 'PENDING' });

    // Proposing changed nobody's pay.
    expect(await prisma.compensationRecord.count({ where: { associateId: w.ben.id } })).toBe(0);
    // Running again proposes nothing new.
    expect((await runPayrollPrep(prisma, { runId: w.run.id })).proposed).toBe(0);

    // A person approves the rate: it is set in their name.
    await decideApproval(prisma, approval.id, 'APPROVED', w.hr.id, null);
    const comp = await prisma.compensationRecord.findFirstOrThrow({ where: { associateId: w.ben.id } });
    expect(Number(comp.amount)).toBe(18.5);
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: rate.id } })).status).toBe('EXECUTED');
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('CONSUMED');

    // The W-4 nudge is rejected: nothing is sent, and the next pass does not ask again.
    await decideApproval(prisma, byAction.NUDGE_W4.approvalId!, 'REJECTED', w.hr.id, 'Talked to her in person');
    await flushPendingNotifications();
    expect((await runPayrollPrep(prisma, { runId: w.run.id })).proposed).toBe(0);
  });

  it('approved nudges go out from the agent; a fix that became moot leaves the queue', async () => {
    const w = await world();
    const { user: anaLogin } = await createUser({ role: 'ASSOCIATE', associateId: w.ana.id });
    await runPayrollPrep(prisma, { runId: w.run.id });
    const nudge = await prisma.agentProposal.findFirstOrThrow({ where: { capabilityKey: PAYROLL_PREP, payload: { path: ['action'], equals: 'NUDGE_W4' } } });
    await decideApproval(prisma, nudge.approvalId!, 'APPROVED', w.hr.id, null);
    await flushPendingNotifications();
    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: anaLogin.id, category: 'payroll.prep' } });
    expect(n.subject).toBe('Your W-4 is missing');

    // Ben's pay record is set by hand: the rate proposal is superseded on the next pass.
    await prisma.compensationRecord.create({ data: { associateId: w.ben.id, effectiveFrom: d('2026-09-01'), payType: 'HOURLY', amount: 19, reason: 'HIRE' } });
    const r = await runPayrollPrep(prisma, { runId: w.run.id });
    expect(r.superseded).toBeGreaterThanOrEqual(1);
    const rate = await prisma.agentProposal.findFirstOrThrow({ where: { capabilityKey: PAYROLL_PREP, payload: { path: ['action'], equals: 'SET_RATE' } } });
    expect(rate.status).toBe('SUPERSEDED');
  });

  it('does nothing while the agent is not switched on', async () => {
    const w = await world();
    await prisma.worker.update({ where: { id: w.workerId }, data: { status: 'ONBOARDING' } });
    expect(await runPayrollPrep(prisma, { runId: w.run.id })).toMatchObject({ skipped: 'agent_stopped', proposed: 0 });
  });
});
