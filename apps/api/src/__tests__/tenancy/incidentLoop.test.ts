import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { catalogFixture, runCapabilityFixture, suspendCapability } from '../../lib/agentCapabilities.js';
import { INCIDENT_LOOP, runIncidentLoop } from '../../lib/incidentLoop.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Agent families step 5 — the Compliance agent's incident.loop
 * (docs/agent-families-investigation.md §4).
 *
 *   The compliance desk owns open incidents: a dated item each, and the
 *   desk hears once at 3, 7 and 14 days with the client's 300A line. An
 *   incident that needs an HR case gets a CASE_OPEN proposal; on approval
 *   the agent opens the case and links it. A rejection stands; a resolved
 *   incident retires its proposal. Closing stays human.
 */

const DAY = 86_400_000;

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
  const workerId = (await builtInAgentId(prisma, 'compliance-agent', ALTO_TENANT_ID))!;
  // It boots ONBOARDING; these cases exercise it as an owner would after certifying it.
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const client = await createClient('Walmart 1234');
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  return { hr, workerId, client, ana };
}

type World = Awaited<ReturnType<typeof world>>;

function incident(w: World, opts: { openDays: number; severity: 'FIRST_AID' | 'MEDICAL_TREATMENT' | 'RESTRICTED_DUTY' | 'DAYS_AWAY' | 'FATAL'; recordable?: boolean; person?: boolean }) {
  const reportedAt = new Date(Date.now() - opts.openDays * DAY);
  return prisma.oshaIncident.create({
    data: {
      clientId: w.client.id,
      associateId: opts.person === false ? null : w.ana.id,
      occurredAt: reportedAt,
      reportedAt,
      description: 'Slipped on a wet floor in aisle 7.',
      severity: opts.severity,
      daysAway: opts.severity === 'DAYS_AWAY' ? 3 : 0,
      isRecordable: opts.recordable ?? opts.severity !== 'FIRST_AID',
    },
  });
}

async function decisions(email: string) {
  const res = await (await loginAs(agent(), email)).get('/me/decisions');
  expect(res.status).toBe(200);
  return (res.body.decisions ?? res.body.items ?? res.body) as Array<{ key: string; label: string; detail: string; severity: string; ageDays: number | null }>;
}

const proposalsFor = (incidentId: string) => prisma.agentProposal.findMany({ where: { capabilityKey: INCIDENT_LOOP, subjectId: incidentId }, orderBy: { createdAt: 'asc' } });

describe('incident.loop: the desk', () => {
  it('a dated item per open incident, and the desk hears once at 3, 7 and 14 days with the 300A line', async () => {
    const w = await world();
    const inc = await incident(w, { openDays: 4, severity: 'MEDICAL_TREATMENT' });
    expect(await runIncidentLoop(prisma, new Date())).toMatchObject({ open: 1, told: 1 });
    expect((await runIncidentLoop(prisma, new Date())).told).toBe(0);
    expect(await runIncidentLoop(prisma, new Date(Date.now() + 3 * DAY))).toMatchObject({ told: 1 });
    expect((await prisma.oshaIncident.findUniqueOrThrow({ where: { id: inc.id } })).chaseStage).toBe(2);
    await flushPendingNotifications();
    const told = await prisma.notification.findMany({ where: { recipientUserId: w.hr.id, category: 'compliance.incidents', channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });
    expect(told).toHaveLength(2);
    expect(told[0]!.subject).toBe('Safety incident open 4 days: Medical treatment at Walmart 1234');
    expect(told[0]!.body).toContain(`Walmart 1234, ${new Date().getUTCFullYear()} so far: 1 recordable case`);

    const item = (await decisions(w.hr.email)).find((d) => d.key === `safety:incident:${inc.id}`);
    expect(item).toMatchObject({ label: 'Medical treatment incident at Walmart 1234, open 4 days', severity: 'high', ageDays: 4 });
  });

  it('a non-recordable one open a week says it can close; nothing is closed for the desk', async () => {
    const w = await world();
    const inc = await incident(w, { openDays: 8, severity: 'FIRST_AID' });
    await runIncidentLoop(prisma, new Date());
    const item = (await decisions(w.hr.email)).find((d) => d.key === `safety:incident:${inc.id}`);
    expect(item?.detail).toBe('Nothing recordable here: close it if the reporter has nothing to add.');
    expect((await prisma.oshaIncident.findUniqueOrThrow({ where: { id: inc.id } })).status).toBe('REPORTED');
  });

  it('suspended: no items from it and no chase', async () => {
    const w = await world();
    const inc = await incident(w, { openDays: 4, severity: 'MEDICAL_TREATMENT' });
    await suspendCapability(prisma, w.workerId, INCIDENT_LOOP, ALTO_TENANT_ID, w.hr.id, 'Checking the rules');
    expect(await runIncidentLoop(prisma, new Date())).toMatchObject({ told: 0, skipped: 'capability_off' });
    expect((await decisions(w.hr.email)).some((d) => d.key === `safety:incident:${inc.id}`)).toBe(false);
  });
});

describe('incident.loop: an HR case through an approval', () => {
  it('proposes a case for a recordable days-away incident with a person; on approval the agent opens it and links it', async () => {
    const w = await world();
    const inc = await incident(w, { openDays: 4, severity: 'DAYS_AWAY' });
    await incident(w, { openDays: 4, severity: 'DAYS_AWAY', person: false });
    expect(await runIncidentLoop(prisma, new Date())).toMatchObject({ proposed: 1 });
    const [p] = await proposalsFor(inc.id);
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } });
    expect(approval).toMatchObject({ action: 'CASE_OPEN', status: 'PENDING' });
    expect(approval.summary).toMatch(/^Open an HR case for Ana Lopez: days away incident at Walmart 1234 on .* \(3 days away, 0 restricted\), open 4 days with no case\.$/);
    expect(await prisma.hrCase.count()).toBe(0);

    const hr = await loginAs(agent(), w.hr.email);
    const approved = await hr.post(`/agents/approvals/${approval.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const linked = await prisma.oshaIncident.findUniqueOrThrow({ where: { id: inc.id } });
    expect(linked.hrCaseId).toBeTruthy();
    const hrCase = await prisma.hrCase.findUniqueOrThrow({ where: { id: linked.hrCaseId! } });
    expect(hrCase).toMatchObject({ associateId: w.ana.id, category: 'WORKPLACE_CONCERN', priority: 'HIGH', status: 'OPEN' });
    expect(hrCase.description).toContain('Slipped on a wet floor in aisle 7.');
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: p!.id } })).status).toBe('EXECUTED');

    await flushPendingAudits();
    const opened = await prisma.auditLog.findFirst({ where: { action: 'hr_case.opened', entityId: hrCase.id, workerId: w.workerId } });
    // On the trail under the agent, citing the approval.
    expect(opened).toBeTruthy();
    expect((opened!.metadata as Record<string, unknown>).approvalId).toBe(approval.id);
    expect((await runIncidentLoop(prisma, new Date())).proposed).toBe(0);
  });

  it('a rejection stands, and resolving the incident retires a waiting proposal', async () => {
    const w = await world();
    const a = await incident(w, { openDays: 4, severity: 'RESTRICTED_DUTY' });
    const b = await incident(w, { openDays: 5, severity: 'DAYS_AWAY' });
    await runIncidentLoop(prisma, new Date());
    const [pa] = await proposalsFor(a.id);
    const [pb] = await proposalsFor(b.id);
    const hr = await loginAs(agent(), w.hr.email);
    expect((await hr.post(`/agents/approvals/${pa!.approvalId}/reject`).send({ note: 'Handled off the platform.' })).status).toBe(200);
    await prisma.oshaIncident.update({ where: { id: b.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    const tick = await runIncidentLoop(prisma, new Date());
    expect(tick).toMatchObject({ proposed: 0, superseded: 1 });
    expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: pb!.id } })).status).toBe('SUPERSEDED');
    expect(await proposalsFor(a.id)).toHaveLength(1);
  });
});

describe('incident.loop: certification', () => {
  it('the catalog fixture runs through the real rules and passes', async () => {
    const fixture = catalogFixture(INCIDENT_LOOP, 'Five open incidents: a case for the recordable days-away one with a person; the week-old first-aid one can close')!;
    const r = await runCapabilityFixture(INCIDENT_LOOP, fixture, new Date());
    expect(r, JSON.stringify(r)).toMatchObject({ passed: true, reason: null });
  });
});
