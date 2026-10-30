import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { revertExpiredGrants } from '../../lib/accessChanges.js';
import { runWithTenant } from '../../lib/tenant.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Maker-checker, end to end: the change that needs a second person waits
 * as an ApprovalRequest (202), the requester cannot decide it, the second
 * person can, and the change lands under the decider's name with its own
 * audit row. Where no second person exists, the change lands at once and
 * the audit says so.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

// Fresh addresses per test: the sign-in limiter counts attempts per email across the file.
const tag = () => Math.random().toString(36).slice(2, 8);
async function twoAdmins() {
  const { user: a } = await createUser({ role: 'HR_ADMINISTRATOR', email: `a-${tag()}@example.com` });
  const { user: b } = await createUser({ role: 'HR_ADMINISTRATOR', email: `b-${tag()}@example.com` });
  return { a, b, A: await loginAs(a.email), B: await loginAs(b.email) };
}

/** A fire-and-forget emit lands a beat after the response. */
async function until(check: () => Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function withComp(amount: number) {
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  await prisma.compensationRecord.create({ data: { associateId: ana.id, effectiveFrom: new Date('2026-01-01'), payType: 'HOURLY', amount, reason: 'HIRE' } });
  return ana;
}

describe('pay-rate changes', () => {
  it('past the threshold: waits for a second person, who applies it under their own name with an audit row', async () => {
    const { a, b, A, B } = await twoAdmins();
    const ana = await withComp(20);

    const asked = await A.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 25, reason: 'MERIT', effectiveFrom: '2026-11-01' });
    expect(asked.status).toBe(202);
    expect(asked.body.pending).toBe(true);
    const id = asked.body.approvalId as string;
    expect(await prisma.compensationRecord.count({ where: { associateId: ana.id } })).toBe(1);

    // The requester sees it under "mine", never under "decide".
    const mine = await A.get('/approvals/requests?scope=mine');
    expect(mine.body.requests.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await A.get('/approvals/requests?scope=decide')).body.requests).toEqual([]);
    const refused = await A.post(`/approvals/requests/${id}/decide`).send({ decision: 'APPROVE' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('maker_checker');

    // The second person: it is on their desk, in the Inbox, and they decide it.
    const inbox = await B.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'approval-requests').count).toBe(1);
    const decide = await B.get('/approvals/requests?scope=decide');
    expect(decide.body.requests[0]).toMatchObject({ id, kind: 'PAY_RATE_CHANGE', mayDecide: true, requester: { id: a.id } });
    // What a person reads: a date and a reason in words, never "2026-11-01" or "merit".
    expect(decide.body.requests[0].summary).toBe('Merit increase, effective Nov 1, 2026');
    expect(decide.body.requests[0].display.proposed).toMatchObject({ effectiveFrom: 'Nov 1, 2026', reason: 'Merit increase', payType: 'Hourly' });
    expect(decide.body.requests[0].display.before).toMatchObject({ payType: 'Hourly' });
    const rejectNoReason = await B.post(`/approvals/requests/${id}/decide`).send({ decision: 'REJECT' });
    expect(rejectNoReason.status).toBe(400);
    const approved = await B.post(`/approvals/requests/${id}/decide`).send({ decision: 'APPROVE' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', decidedBy: { id: b.id }, applyError: null });
    expect(approved.body.appliedAt).not.toBeNull();

    const current = await prisma.compensationRecord.findFirstOrThrow({ where: { associateId: ana.id, effectiveTo: null } });
    expect(Number(current.amount)).toBe(25);
    expect(current.actorUserId).toBe(b.id);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pay.rate_changed', entityId: current.id } });
    expect(audit.metadata).toMatchObject({ before: { amount: 20 }, after: { amount: 25 }, approvalRequestId: id, requestedByUserId: a.id });
    const changes = await B.get(`/comp/changes?associateId=${ana.id}`);
    expect(changes.body.changes[0]).toMatchObject({ kind: 'pay', associateName: 'Ana Lopez', actor: { id: b.id } });
    // Decided once.
    expect((await B.post(`/approvals/requests/${id}/decide`).send({ decision: 'APPROVE' })).status).toBe(409);
  });

  it('within the threshold lands at once; with no second person the change lands and the audit says so', async () => {
    const { A } = await twoAdmins();
    const ana = await withComp(20);
    expect((await A.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 21, reason: 'MERIT' })).status).toBe(201);

    await prisma.user.updateMany({ where: { email: { startsWith: 'b-' } }, data: { status: 'DISABLED' } });
    const big = await A.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 40, reason: 'MARKET_ADJUSTMENT' });
    expect(big.status).toBe(201);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'pay.rate_changed' }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata).toMatchObject({ after: { amount: 40 }, note: 'No second approver was available.' });
  });

  it('a delegate decides for the person who named them', async () => {
    const { A, B } = await twoAdmins();
    const { user: c } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: `c-${tag()}@example.com` });
    const C = await loginAs(c.email);
    const ana = await withComp(20);
    const id = (await A.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 30, reason: 'MERIT' })).body.approvalId as string;
    // Finance holds no manage:comp: not theirs to decide…
    expect((await C.post(`/approvals/requests/${id}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    // …until the second admin hands them their approvals for the week.
    // The company's today: delegations run by its calendar (the UTC day is tomorrow after 8 PM Eastern).
    const today = orgDateKey(new Date());
    const given = await B.post('/approvals/delegations').send({ toUserId: c.id, startsOn: today, endsOn: today, note: 'Out' });
    expect(given.status).toBe(201);
    expect((await C.get('/approvals/delegations/mine')).body.covering).toHaveLength(1);
    expect((await C.get('/approvals/requests?scope=decide')).body.requests.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await C.post(`/approvals/requests/${id}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    expect(Number((await prisma.compensationRecord.findFirstOrThrow({ where: { associateId: ana.id, effectiveTo: null } })).amount)).toBe(30);
  });
});

describe('bill rates as dated, approved records', () => {
  it('a rate-defaults write with a new bill rate waits; approval writes the card; /jobs reads the card', async () => {
    const { A, B } = await twoAdmins();
    const client = await createClient('Store 7');
    const job = await prisma.job.create({ data: { clientId: client.id, name: 'Stocker', payRate: 18, billRate: 28 } });

    const asked = await A.put('/scheduling/rate-defaults').send({ clientId: client.id, position: 'Stocker', payRate: 19, billRate: 31 });
    expect(asked.status).toBe(202);
    expect(await prisma.shiftRateDefault.count()).toBe(0);
    const id = asked.body.approvalId as string;
    // A second request for the same role waits its turn.
    expect((await A.put('/scheduling/rate-defaults').send({ clientId: client.id, position: 'Stocker', payRate: 19, billRate: 32 })).status).toBe(409);

    expect((await B.post(`/approvals/requests/${id}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const card = await prisma.shiftRateDefault.findFirstOrThrow({ where: { clientId: client.id, position: 'Stocker' } });
    expect(Number(card.billRate)).toBe(31);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'pay.bill_rate_changed', entityId: card.id } })).toBe(1);

    // The job no longer carries the instant rate: it reads the card in force.
    const jobs = await B.get(`/jobs?clientId=${client.id}`);
    expect(jobs.body.jobs.find((j: { id: string }) => j.id === job.id)).toMatchObject({ billRate: 31, payRate: 19 });
    // Writing a rate on the job becomes a card request too.
    const patched = await A.patch(`/jobs/${job.id}`).send({ billRate: 33 });
    expect(patched.status).toBe(202);
    expect(Number((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).billRate)).toBe(28);
    // The pay rate alone (bill unchanged) lands at once as a dated card.
    expect((await A.post(`/approvals/requests/${patched.body.approvalId}/cancel`)).status).toBe(200);
    expect((await A.patch(`/jobs/${job.id}`).send({ payRate: 20 })).status).toBe(200);
    expect(Number((await prisma.shiftRateDefault.findFirstOrThrow({ where: { clientId: client.id, position: 'Stocker', effectiveTo: null } })).payRate)).toBe(20);
  });
});

describe('separations take a second person', () => {
  it('completing waits; approval completes it under the decider; a lone admin completes at once', async () => {
    const { a, b, A, B } = await twoAdmins();
    const ana = await createAssociate();
    const { user: login } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const created = await A.post('/separations').send({ associateId: ana.id, reason: 'VOLUNTARY_PERSONAL', lastDayWorked: '2026-10-30' });
    expect(created.status).toBe(201);
    expect((await A.post(`/separations/${created.body.id}/advance`)).body.status).toBe('IN_PROGRESS');
    const asked = await A.post(`/separations/${created.body.id}/advance`);
    expect(asked.status).toBe(202);
    expect((await prisma.separation.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe('IN_PROGRESS');
    expect((await A.post(`/separations/${created.body.id}/advance`)).status).toBe(409);

    const pending = (await B.get(`/approvals/requests/${asked.body.approvalId}`)).body;
    expect(pending.summary).toMatch(/^Voluntary — personal · last day Oct 30, 2026\./);
    expect(pending.display.before).toMatchObject({ status: 'In progress' });
    expect((await A.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    expect((await B.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const sep = await prisma.separation.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(sep.status).toBe('COMPLETE');
    expect(sep.completedById).toBe(b.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: login.id } })).status).toBe('DISABLED');
    expect(a.id).not.toBe(b.id);

    // With the switch off, one person completes it.
    await prisma.orgSetting.upsert({ where: { tenantId: ALTO_TENANT_ID }, create: { id: 'singleton', tenantId: ALTO_TENANT_ID, separationSecondPerson: false }, update: { separationSecondPerson: false } });
    const bob = await createAssociate();
    const second = await A.post('/separations').send({ associateId: bob.id, reason: 'END_OF_CONTRACT', lastDayWorked: '2026-10-30' });
    await A.post(`/separations/${second.body.id}/advance`);
    expect((await A.post(`/separations/${second.body.id}/advance`)).body).toEqual({ ok: true, status: 'COMPLETE' });
  });
});

describe('access', () => {
  it('a role elevation waits for a second administrator; a demotion lands at once', async () => {
    const { A, B } = await twoAdmins();
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const asked = await A.patch(`/admin/users/${target.id}`).send({ role: 'INTERNAL_RECRUITER' });
    expect(asked.status).toBe(202);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('ASSOCIATE');
    expect((await B.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('INTERNAL_RECRUITER');
    expect((await A.patch(`/admin/users/${target.id}`).send({ role: 'ASSOCIATE' })).status).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('ASSOCIATE');
  });

  it('a temporary grant rides as a second role and reverts when it expires', async () => {
    const { A } = await twoAdmins();
    const { user: target } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const bad = await A.post('/admin/access-grants').send({ userId: target.id, role: 'HR_ADMINISTRATOR', until: new Date(Date.now() + 40 * 86_400_000).toISOString(), reason: 'Year-end close' });
    expect(bad.status).toBe(400);
    const granted = await A.post('/admin/access-grants').send({ userId: target.id, role: 'HR_ADMINISTRATOR', until, reason: 'Year-end close' });
    expect(granted.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).additionalRoles).toEqual(['HR_ADMINISTRATOR']);
    expect((await A.get('/admin/access-grants?open=true')).body.grants).toHaveLength(1);
    expect(await runWithTenant(ALTO_TENANT_ID, 'job', () => revertExpiredGrants(prisma, new Date(Date.now() + 2 * 3_600_000)))).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.additionalRoles).toEqual([]);
    expect((await prisma.accessGrant.findFirstOrThrow()).revertedWhy).toBe('expired');
  });
});

describe('promotions and requisitions', () => {
  it('a promotion is approved, then lands as comp, seat and letter', async () => {
    const { B, A } = await twoAdmins();
    const client = await createClient('Store 9');
    const profile = await prisma.jobProfile.create({ data: { clientId: client.id, code: 'LEAD', title: 'Shift lead' } });
    const ana = await withComp(20);
    const asked = await A.post('/promotions').send({ associateId: ana.id, jobProfileId: profile.id, level: 'L2', amount: 24, effectiveFrom: '2026-11-01', notes: 'Earned it.' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING', currentAmount: '20.00', amount: '24.00', jobProfileTitle: 'Shift lead' });
    expect((await A.post('/promotions').send({ associateId: ana.id, amount: 25, effectiveFrom: '2026-11-01' })).status).toBe(409);
    expect((await B.post(`/approvals/requests/${asked.body.approvalRequestId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const promo = await prisma.promotion.findUniqueOrThrow({ where: { id: asked.body.id } });
    expect(promo.status).toBe('APPLIED');
    expect(promo.letterDocumentId).not.toBeNull();
    const comp = await prisma.compensationRecord.findFirstOrThrow({ where: { associateId: ana.id, effectiveTo: null } });
    expect(comp).toMatchObject({ reason: 'PROMOTION' });
    expect(Number(comp.amount)).toBe(24);
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: ana.id } })).jobProfileId).toBe(profile.id);
    expect((await prisma.documentRecord.findUniqueOrThrow({ where: { id: promo.letterDocumentId! } })).filename).toContain('promotion-letter');
    expect((await B.get(`/promotions?associateId=${ana.id}`)).body.promotions[0].status).toBe('APPLIED');
  });

  it('a seat opens only after its requisition is approved', async () => {
    const { A, B } = await twoAdmins();
    const client = await createClient('Store 3');
    const created = await A.post('/positions').send({ clientId: client.id, code: 'STK-1', title: 'Stocker', budgetAmount: 42000, budgetPeriod: 'ANNUAL' });
    expect(created.status).toBe(201);
    const asked = await A.post(`/positions/${created.body.id}/status`).send({ status: 'OPEN' });
    expect(asked.status).toBe(202);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe('PLANNED');
    const listed = await A.get(`/positions?clientId=${client.id}`);
    expect(listed.body.positions[0].requisition).toEqual({ approvalId: asked.body.approvalId, status: 'PENDING' });
    const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: asked.body.approvalId } });
    expect(req.summary).toContain('$42,000.00 per year');
    expect((await B.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe('OPEN');
    expect((await A.get(`/positions?clientId=${client.id}`)).body.positions[0].requisition.status).toBe('APPROVED');
  });
});

describe('self-service changes behind the switch', () => {
  it('an address change waits for HR when the tenant asks for it', async () => {
    const { B } = await twoAdmins();
    await prisma.orgSetting.upsert({ where: { tenantId: ALTO_TENANT_ID }, create: { id: 'singleton', tenantId: ALTO_TENANT_ID, selfServiceApproval: true }, update: { selfServiceApproval: true } });
    const ana = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const me = await loginAs(user.email);
    const asked = await me.put('/self/me/profile').send({ addressLine1: '9 Palm Ave', city: 'Tampa', state: 'FL', zip: '33601' });
    expect(asked.status).toBe(202);
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: ana.id } })).addressLine1).toBeNull();
    expect((await B.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: ana.id } })).addressLine1).toBe('9 Palm Ave');
    expect(await prisma.financialChange.count({ where: { associateId: ana.id, kind: 'HOME_ADDRESS' } })).toBe(1);
  });
});

describe('the dead triggers fire', () => {
  it('a time-off request queues a TIME_OFF_REQUESTED run', async () => {
    await prisma.workflowDefinition.create({ data: { name: 'leave', trigger: 'TIME_OFF_REQUESTED', actions: [{ kind: 'CREATE_AUDIT_LOG', params: { action: 'leave.asked' } }] } });
    const ana = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const me = await loginAs(user.email);
    const r = await me.post('/time-off/me/requests').send({ category: 'PTO', startDate: '2026-12-01', endDate: '2026-12-01', hours: 8 });
    expect(r.status).toBe(201);
    const queued = () => prisma.workflowRun.count({ where: { trigger: 'TIME_OFF_REQUESTED', entityId: r.body.request.id } });
    await until(async () => (await queued()) === 1);
    expect(await queued()).toBe(1);
  });
});

describe('the approval record and the workflow builder', () => {
  it('the full record filters by kind, status, who asked, who decided and date, and is closed to a supervisor', async () => {
    const { a, b, A, B } = await twoAdmins();
    const ana = await withComp(20);
    const pay = (await A.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 30, reason: 'MERIT' })).body.approvalId as string;
    const client = await createClient('Store 11');
    const bill = (await B.put('/scheduling/rate-defaults').send({ clientId: client.id, position: 'Picker', payRate: 18, billRate: 29 })).body.approvalId as string;
    await B.post(`/approvals/requests/${pay}/decide`).send({ decision: 'APPROVE' });

    const all = await A.get('/approvals/requests?scope=all');
    expect(all.status).toBe(200);
    expect(all.body.requests.map((r: { id: string }) => r.id).sort()).toEqual([pay, bill].sort());
    const byKind = await A.get('/approvals/requests?scope=all&kind=BILL_RATE_CHANGE');
    expect(byKind.body.requests.map((r: { id: string }) => r.id)).toEqual([bill]);
    expect((await A.get('/approvals/requests?scope=all&status=APPROVED')).body.requests.map((r: { id: string }) => r.id)).toEqual([pay]);
    expect((await A.get(`/approvals/requests?scope=all&requesterUserId=${b.id}`)).body.requests.map((r: { id: string }) => r.id)).toEqual([bill]);
    expect((await A.get(`/approvals/requests?scope=all&approverUserId=${b.id}`)).body.requests.map((r: { id: string }) => r.id)).toEqual([pay]);
    expect((await A.get('/approvals/requests?scope=all&to=2000-01-01')).body.requests).toEqual([]);
    // A day on the company's calendar, as the record's filter reads it.
    const today = orgDateKey(new Date());
    expect((await A.get(`/approvals/requests?scope=all&from=${today}&to=${today}`)).body.requests).toHaveLength(2);

    const people = await A.get('/approvals/requests/people');
    expect(people.body.requesters.map((p: { id: string }) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(people.body.approvers.map((p: { id: string }) => p.id)).toEqual([b.id]);

    const sup = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: `sup-${tag()}@example.com` });
    const S = await loginAs(sup.user.email);
    expect((await S.get('/approvals/requests?scope=all')).status).toBe(403);
    expect((await S.get('/approvals/requests/people')).status).toBe(403);
  });

  it('a gate step must name exactly one decider; a WAITING run names the approval it waits on', async () => {
    const { a, A } = await twoAdmins();
    const base = { name: 'Confirm hires', trigger: 'ASSOCIATE_HIRED' };
    expect((await A.post('/workflows').send({ ...base, actions: [{ kind: 'REQUIRE_APPROVAL', params: {} }] })).status).toBe(400);
    expect((await A.post('/workflows').send({ ...base, actions: [{ kind: 'REQUIRE_APPROVAL', params: { role: 'HR_ADMINISTRATOR', capability: 'manage:org' } }] })).status).toBe(400);
    expect((await A.post('/workflows').send({ ...base, actions: [{ kind: 'REQUIRE_APPROVAL', params: { capability: 'view:org' } }] })).body.error.code).toBe('invalid_gate');
    const ok = await A.post('/workflows').send({ ...base, actions: [{ kind: 'REQUIRE_APPROVAL', params: { userId: a.id, title: 'Confirm {{ associate.firstName }}' } }, { kind: 'CREATE_AUDIT_LOG', params: { action: 'hire.ok' } }] });
    expect(ok.status).toBe(201);

    const ana = await createAssociate({ firstName: 'Ana' });
    const { emit, runWorkflowQueue } = await import('../../lib/workflow.js');
    const { runs } = await runWithTenant(ALTO_TENANT_ID, 'job', () => emit({ trigger: 'ASSOCIATE_HIRED', entityType: 'Associate', entityId: ana.id, context: { associateId: ana.id, associate: { firstName: 'Ana' } } }));
    await runWithTenant(ALTO_TENANT_ID, 'job', () => runWorkflowQueue());
    const listed = await A.get('/workflows/runs?status=WAITING');
    expect(listed.body.runs).toHaveLength(1);
    expect(listed.body.runs[0].waitingOn).toMatchObject({ title: 'Confirm Ana', status: 'PENDING' });
    const detail = await A.get(`/workflows/runs/${runs[0]}`);
    expect(detail.body.run.waitingOn.approvalId).toBe(listed.body.runs[0].waitingOn.approvalId);

    // The approver picker can name the person choosing.
    const withMe = await A.get('/approvals/delegations/candidates?includeMe=1');
    expect(withMe.body.candidates.map((c: { id: string }) => c.id)).toContain(a.id);
    expect((await A.get('/approvals/delegations/candidates')).body.candidates.map((c: { id: string }) => c.id)).not.toContain(a.id);
  });
});
