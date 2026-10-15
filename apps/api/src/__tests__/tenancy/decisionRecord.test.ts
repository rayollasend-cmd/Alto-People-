import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { resetAgentRateLimits } from '../../lib/agents.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Brief 2-6 step 3 — the automated-decision record (acceptance: "a tagged
 * decision produces a record it can see").
 *
 *   A scheduling capability's approved proposal writes one append-only row
 *   per person it touches (favorable for the person proposed, adverse for
 *   the person replaced) with the human who decided; the rows refuse edits
 *   and deletes, and each lifecycle date is set once. A capability tagged
 *   as deciding about people is always gated (the floor), and screening,
 *   hiring or promotion in New York City is held until a bias audit is in
 *   force and notices began 10 business days ago.
 */

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const admin = await loginAs(agent(), hr.email);
  const reg = await admin.post('/agents').send({
    name: 'Scheduler',
    ownerUserId: hr.id,
    purpose: 'Fills and forecasts',
    vendor: 'Anthropic',
    model: 'claude',
    modelVersion: '1',
    status: 'ACTIVE',
    family: 'workforce',
    scopes: ['view:scheduling', 'view:org', 'manage:scheduling', 'view:analytics'],
    catalogCapabilities: ['shift.fill', 'coverage.forecast'],
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const cred = await admin.post(`/agents/${reg.body.id}/credentials`).send({ ttlHours: 24 });
  const c = await createClient('Record Hotel');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  const shift = await prisma.shift.create({ data: { clientId: c.id, locationId: site.id, position: 'Houseman', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 86_400_000 + 8 * 3_600_000), status: 'OPEN' } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Proposed' });
  const ben = await createAssociate({ firstName: 'Ben', lastName: 'Replaced' });
  return { admin, workerId: reg.body.id as string, token: cred.body.plaintext as string, shift, ana, ben };
}

const propose = (token: string, body: Record<string, unknown>) => agent().post('/agent/v1/proposals').set(bearer(token)).send(body);

describe('the record', () => {
  it('an approved scheduling proposal records the person proposed and the person replaced, with who decided', async () => {
    const { admin, workerId, token, shift, ana, ben } = await world();
    const filed = await propose(token, { capability: 'shift.fill', subjectType: 'Shift', subjectId: shift.id, summary: 'Ana covers for Ben', payload: { associateId: ana.id, replacesAssociateId: ben.id } });
    expect(filed.status).toBe(202);
    expect((await admin.post(`/agents/approvals/${filed.body.approvalId}/approve`).send({ note: 'Fine' })).status).toBe(200);

    const record = await admin.get(`/agents/${workerId}/decision-record`);
    expect(record.status).toBe(200);
    expect(record.body.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ capabilityKey: 'shift.fill', decisionTypes: ['SCHEDULING'], isDefault: true })]));
    const byName = Object.fromEntries((record.body.decisions as Array<{ subject: string; outcome: string; decisionType: string; humanDecidedAt: string | null }>).map((d) => [d.subject, d]));
    expect(byName['Ana Proposed']).toMatchObject({ outcome: 'FAVORABLE', decisionType: 'SCHEDULING' });
    expect(byName['Ben Replaced']).toMatchObject({ outcome: 'ADVERSE', decisionType: 'SCHEDULING' });
    expect(byName['Ana Proposed']!.humanDecidedAt).toBeTruthy();

    const csv = await admin.get(`/agents/${workerId}/decision-record.csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.trim().split('\n')).toHaveLength(3);
  });

  it('refuses edits and deletes; each lifecycle date is set once', async () => {
    const { admin, token, shift, ana } = await world();
    const filed = await propose(token, { capability: 'shift.fill', subjectType: 'Shift', subjectId: shift.id, summary: 'Ana covers', payload: { associateId: ana.id } });
    await admin.post(`/agents/approvals/${filed.body.approvalId}/reject`).send({ note: 'No' });
    const row = await prisma.automatedDecisionRecord.findFirstOrThrow({ where: { subjectAssociateId: ana.id } });
    expect(row.outcome).toBe('NONE');

    await expect(prisma.automatedDecisionRecord.update({ where: { id: row.id }, data: { outcome: 'FAVORABLE' } })).rejects.toThrow();
    await expect(prisma.automatedDecisionRecord.delete({ where: { id: row.id } })).rejects.toThrow();

    expect((await admin.post(`/agents/decisions/${row.id}/events`).send({ event: 'notice_given', channel: 'EMAIL' })).status).toBe(200);
    expect((await admin.post(`/agents/decisions/${row.id}/events`).send({ event: 'notice_given' })).status).toBe(409);
    await expect(prisma.automatedDecisionRecord.update({ where: { id: row.id }, data: { noticeGivenAt: new Date(0) } })).rejects.toThrow();
    expect((await admin.post(`/agents/decisions/${row.id}/events`).send({ event: 'review_requested' })).status).toBe(200);
  });
});

describe('the floor and the hold', () => {
  it('a capability tagged as deciding about people always waits for a person', async () => {
    const { admin, workerId, token } = await world();
    const before = await propose(token, { capability: 'coverage.forecast', subjectType: 'Run', payload: {} });
    expect(before.body.approvalId).toBeNull();
    expect((await admin.put(`/agents/${workerId}/decision-profiles/coverage.forecast`).send({ decisionTypes: ['OTHER'], assesses: 'Hours per site', dataSources: 'Schedules', retentionPolicy: 'Three years' })).status).toBe(200);
    const after = await propose(token, { capability: 'coverage.forecast', subjectType: 'Run', payload: {} });
    expect(after.status).toBe(202);
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: after.body.approvalId } })).action).toBe('POLICY_GATE');
  });

  it('hiring in New York City is held until a bias audit is in force and notices began 10 business days ago', async () => {
    const { admin, workerId, token } = await world();
    await admin.put(`/agents/${workerId}/decision-profiles/coverage.forecast`).send({ decisionTypes: ['HIRING'], jurisdictions: ['NYC_LL144'], assesses: 'Availability', dataSources: 'Applications', retentionPolicy: 'Three years' });
    const held = await propose(token, { capability: 'coverage.forecast', subjectType: 'Applicant', payload: {} });
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe('compliance_hold');
    expect(held.body.error.message).toMatch(/bias audit/);
    expect(held.body.error.message).toMatch(/10 business days/);

    const noReason = await admin.post(`/agents/${workerId}/bias-audits`).send({ auditorName: 'Fair Audits LLC', independenceAttested: true, independenceText: 'No financial interest in the vendor or the employer.', conductedAt: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), results: { impactRatios: {} }, dataKind: 'TEST' });
    expect(noReason.status).toBe(400);
    const audit = await admin.post(`/agents/${workerId}/bias-audits`).send({ auditorName: 'Fair Audits LLC', independenceAttested: true, independenceText: 'No financial interest in the vendor or the employer.', conductedAt: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), results: { impactRatios: { female: 0.94 } }, dataKind: 'HISTORICAL' });
    expect(audit.status).toBe(201);
    await admin.put(`/agents/${workerId}/decision-profiles/coverage.forecast`).send({ decisionTypes: ['HIRING'], jurisdictions: ['NYC_LL144'], assesses: 'Availability', dataSources: 'Applications', retentionPolicy: 'Three years', noticeStartedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    const ok = await propose(token, { capability: 'coverage.forecast', subjectType: 'Applicant', payload: {} });
    expect(ok.status).toBe(202);
    const record = await admin.get(`/agents/${workerId}/decision-record`);
    expect(record.body.audits[0]).toMatchObject({ auditorName: 'Fair Audits LLC', inForce: true });
  });
});
