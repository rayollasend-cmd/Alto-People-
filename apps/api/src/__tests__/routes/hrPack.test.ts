import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { sweepCaseSlas } from '../../lib/hrCaseSla.js';
import { remindCampaigns } from '../../lib/policyCampaigns.js';
import { purgeByRetention } from '../../lib/documentRetention.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The HR administrator / Manager pack (2026-10): case SLAs, policy
 * campaigns, verification letters, document retention, mass update, the
 * headcount plan, offboarding, report aggregates, the Manager's home and
 * compensation planning — each through its HTTP surface.
 */

const app = () => createApp();
const DAY = 86_400_000;

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

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: `hr-${Math.random().toString(36).slice(2, 7)}@example.com` });
  return { user, agent: await loginAs(user.email) };
}

async function worker(first = 'Ana', last = 'Lopez') {
  const associate = await createAssociate({ firstName: first, lastName: last });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id, email: `${first.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@example.com` });
  return { associate, user, agent: await loginAs(user.email) };
}

describe('HR case SLAs', () => {
  it('a filed case is due by its target; waiting on the person pauses the clock; a breach counts and escalates once', async () => {
    const desk = await hr();
    const ana = await worker();
    const filed = await ana.agent.post('/hr-cases').send({ category: 'PAYROLL', subject: 'Missing hours', description: 'Wednesday is missing', priority: 'HIGH' });
    expect(filed.status).toBe(201);
    const row = await prisma.hrCase.findUniqueOrThrow({ where: { id: filed.body.id } });
    // HIGH = 24h; PAYROLL caps at 48h, so 24h.
    expect(Math.round((row.dueAt!.getTime() - row.createdAt.getTime()) / 3_600_000)).toBe(24);

    const queue = await desk.agent.get('/hr-cases');
    expect(queue.body.cases[0].sla.state).toBe('ON_TRACK');

    await desk.agent.patch(`/hr-cases/${row.id}`).send({ status: 'WAITING_ASSOCIATE' });
    const paused = await prisma.hrCase.findUniqueOrThrow({ where: { id: row.id } });
    expect(paused.slaPausedAt).not.toBeNull();
    expect((await desk.agent.get(`/hr-cases/${row.id}`)).body.sla.state).toBe('PAUSED');

    // The person replies → the clock resumes and the due time moves out by the wait.
    await prisma.hrCase.update({ where: { id: row.id }, data: { slaPausedAt: new Date(Date.now() - 2 * 3_600_000) } });
    await ana.agent.post(`/hr-cases/${row.id}/comments`).send({ body: 'Here is my timesheet' });
    const resumed = await prisma.hrCase.findUniqueOrThrow({ where: { id: row.id } });
    expect(resumed.status).toBe('IN_PROGRESS');
    expect(resumed.slaPausedAt).toBeNull();
    expect(resumed.slaPausedMinutes).toBeGreaterThanOrEqual(119);
    expect(resumed.dueAt!.getTime() - paused.dueAt!.getTime()).toBeGreaterThanOrEqual(119 * 60_000);

    // Past due: the Inbox counts it, the summary says so, the sweep escalates once.
    await prisma.hrCase.update({ where: { id: row.id }, data: { dueAt: new Date(Date.now() - 60_000) } });
    const inbox = await desk.agent.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'hr-cases-sla')?.count).toBe(1);
    expect((await desk.agent.get('/hr-cases-summary')).body.sla.breached).toBe(1);
    expect((await desk.agent.get('/hr-cases?sla=breached')).body.cases).toHaveLength(1);
    expect((await sweepCaseSlas(prisma)).escalated).toBe(1);
    expect((await sweepCaseSlas(prisma)).escalated).toBe(0);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: desk.user.id, linkUrl: `/hr-cases?case=${row.id}`, subject: { contains: 'SLA' } } })).toBe(1);
  });

  it('targets are tenant-editable by an administrator; a new priority re-targets the clock', async () => {
    const desk = await hr();
    const grid = await desk.agent.get('/hr-cases-sla');
    expect(grid.body.targets).toHaveLength(32);
    const put = await desk.agent.put('/hr-cases-sla').send({ targets: [{ category: 'BENEFITS', priority: 'LOW', targetHours: 200 }] });
    expect(put.status).toBe(200);
    expect(put.body.targets.find((t: { category: string; priority: string }) => t.category === 'BENEFITS' && t.priority === 'LOW')).toMatchObject({ targetHours: 200, custom: true });
    const ana = await worker();
    const filed = await ana.agent.post('/hr-cases').send({ category: 'BENEFITS', subject: 'Dental', description: 'Question', priority: 'LOW' });
    const c = await prisma.hrCase.findUniqueOrThrow({ where: { id: filed.body.id } });
    expect(Math.round((c.dueAt!.getTime() - c.createdAt.getTime()) / 3_600_000)).toBe(200);
    await desk.agent.patch(`/hr-cases/${c.id}`).send({ priority: 'URGENT' });
    const after = await prisma.hrCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(Math.round((after.dueAt!.getTime() - after.createdAt.getTime()) / 3_600_000)).toBe(8);
    // An associate can't change the grid.
    expect((await ana.agent.put('/hr-cases-sla').send({ targets: [{ category: 'OTHER', priority: 'LOW', targetHours: 1 }] })).status).toBe(403);
  });
});

async function publishedTemplate(body = 'Hello {{associate.firstName}}, please follow the code of conduct.') {
  const t = await prisma.documentTemplate.create({ data: { name: 'Code of conduct', kind: 'POLICY' } });
  const v = await prisma.documentTemplateVersion.create({ data: { templateId: t.id, version: 1, body, publishedAt: new Date() } });
  await prisma.documentTemplate.update({ where: { id: t.id }, data: { currentVersionId: v.id } });
  return t;
}

describe('policy campaigns', () => {
  it('draft → launch freezes the policy per person → they sign with an audit hash → completion, reminders and waivers', async () => {
    const desk = await hr();
    const ana = await worker('Ana', 'Lopez');
    const bo = await worker('Bo', 'Chen');
    const tmpl = await publishedTemplate();
    const size = await desk.agent.post('/policy-campaigns/audience-size').send({ audience: { kind: 'ALL' } });
    expect(size.body.count).toBe(2);
    const created = await desk.agent.post('/policy-campaigns').send({ name: 'Code of conduct 2027', templateId: tmpl.id, audience: { kind: 'ALL' }, dueOn: '2027-01-15', reminderEveryDays: 3 });
    expect(created.status).toBe(201);
    // Nothing reaches anyone until launch.
    expect((await ana.agent.get('/my/policies')).body.policies).toHaveLength(0);

    const launched = await desk.agent.post(`/policy-campaigns/${created.body.id}/launch`);
    expect(launched.body.recipients).toBe(2);
    const mine = (await ana.agent.get('/my/policies')).body.policies;
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toContain('Hello Ana');
    expect((await ana.agent.get('/me/inbox')).body.sources.find((s: { key: string }) => s.key === 'policies-to-sign')?.count).toBe(1);

    const signed = await ana.agent.post(`/my/policies/${mine[0].id}/sign`).send({ signature: 'Ana Lopez' });
    expect(signed.status).toBe(200);
    const rec = await prisma.policyCampaignRecipient.findUniqueOrThrow({ where: { id: mine[0].id } });
    expect(rec.status).toBe('SIGNED');
    expect(rec.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await ana.agent.post(`/my/policies/${mine[0].id}/sign`).send({ signature: 'Ana Lopez' })).status).toBe(409);
    // Someone else's policy is not theirs to sign.
    const boRow = await prisma.policyCampaignRecipient.findFirstOrThrow({ where: { associateId: bo.associate.id } });
    expect((await ana.agent.post(`/my/policies/${boRow.id}/sign`).send({ signature: 'Ana Lopez' })).status).toBe(404);

    // Reminders on the cadence: only Bo is still pending.
    await prisma.policyCampaignRecipient.update({ where: { id: boRow.id }, data: { createdAt: new Date(Date.now() - 4 * DAY) } });
    expect((await remindCampaigns(prisma)).reminded).toBe(1);
    expect((await remindCampaigns(prisma)).reminded).toBe(0);

    const detail = await desk.agent.get(`/policy-campaigns/${created.body.id}`);
    expect(detail.body.completion).toMatchObject({ total: 2, signed: 1, pending: 1, pct: 50 });
    expect((await desk.agent.post(`/policy-campaigns/${created.body.id}/recipients/${boRow.id}/waive`).send({ reason: 'On leave until March' })).status).toBe(200);
    expect((await desk.agent.get('/policy-campaigns')).body.campaigns[0].completion.pct).toBe(100);
  });

  it('an audience by department reaches only that department; an unpublished version is refused', async () => {
    const desk = await hr();
    const client = await createClient('Acme');
    const dept = await prisma.department.create({ data: { clientId: client.id, name: 'Front desk' } });
    const ana = await worker('Ana', 'Lopez');
    await worker('Bo', 'Chen');
    await prisma.associate.update({ where: { id: ana.associate.id }, data: { departmentId: dept.id } });
    expect((await desk.agent.post('/policy-campaigns/audience-size').send({ audience: { kind: 'DEPARTMENT', ids: [dept.id] } })).body.count).toBe(1);
    const t = await prisma.documentTemplate.create({ data: { name: 'Draft policy', kind: 'POLICY' } });
    const v = await prisma.documentTemplateVersion.create({ data: { templateId: t.id, version: 1, body: 'x' } });
    const r = await desk.agent.post('/policy-campaigns').send({ name: 'Draft', templateId: t.id, versionId: v.id, audience: { kind: 'ALL' }, dueOn: '2027-01-15' });
    expect(r.status).toBe(400);
  });
});

describe('verification letters', () => {
  it('asked by the person, approved by HR with the facts frozen, downloadable by them; declined with a reason', async () => {
    const desk = await hr();
    const ana = await worker();
    await prisma.associate.update({ where: { id: ana.associate.id }, data: { hireDate: new Date('2024-03-01') } });
    await prisma.compensationRecord.create({ data: { associateId: ana.associate.id, effectiveFrom: new Date('2024-03-01'), payType: 'HOURLY', amount: 18.5, reason: 'HIRE' } });
    const asked = await ana.agent.post('/my/verification-letters').send({ kind: 'INCOME', addressedTo: 'Sunrise Apartments', purpose: 'Lease' });
    expect(asked.status).toBe(201);
    expect((await ana.agent.post('/my/verification-letters').send({ kind: 'INCOME' })).status).toBe(409);
    expect((await desk.agent.get('/me/inbox')).body.sources.find((s: { key: string }) => s.key === 'verification-letters')?.count).toBe(1);
    // Not approved yet → no PDF.
    expect((await ana.agent.get(`/verification-letters/${asked.body.id}/pdf`)).status).toBe(409);
    expect((await desk.agent.post(`/verification-letters/${asked.body.id}/approve`)).status).toBe(200);
    const row = await prisma.verificationLetter.findUniqueOrThrow({ where: { id: asked.body.id } });
    expect(row.snapshot).toMatchObject({ person: { name: 'Ana Lopez', hireDate: '2024-03-01', status: 'current' }, pay: { payType: 'HOURLY', amount: '18.50' } });
    const pdf = await ana.agent.get(`/verification-letters/${asked.body.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    // Another worker cannot read it.
    const bo = await worker('Bo', 'Chen');
    expect((await bo.agent.get(`/verification-letters/${asked.body.id}/pdf`)).status).toBe(404);

    const second = await ana.agent.post('/my/verification-letters').send({ kind: 'EMPLOYMENT' });
    expect((await desk.agent.post(`/verification-letters/${second.body.id}/decline`).send({ reason: 'Use the work number' })).status).toBe(200);
    const mine = (await ana.agent.get('/my/verification-letters')).body.letters;
    expect(mine.find((l: { id: string }) => l.id === second.body.id)).toMatchObject({ status: 'DECLINED', declineReason: 'Use the work number' });
  });
});

describe('document retention', () => {
  it('a policy below the legal floor is refused; the preview names what the sweep purges; the sweep keeps the row and audits', async () => {
    const desk = await hr();
    expect((await desk.agent.put('/document-retention').send({ policies: [{ kind: 'I9_SUPPORTING', retainYearsAfterSeparation: 1 }] })).status).toBe(400);
    expect((await desk.agent.put('/document-retention').send({ policies: [{ kind: 'ID', retainYearsAfterSeparation: 2 }] })).status).toBe(200);
    const gone = await createAssociate({ firstName: 'Old', lastName: 'Timer' });
    await prisma.associate.update({ where: { id: gone.id }, data: { separatedAt: new Date(Date.now() - 3 * 365 * DAY) } });
    const recent = await createAssociate({ firstName: 'New', lastName: 'Leaver' });
    await prisma.associate.update({ where: { id: recent.id }, data: { separatedAt: new Date(Date.now() - 30 * DAY) } });
    const old = await prisma.documentRecord.create({ data: { associateId: gone.id, kind: 'ID', s3Key: 'test/old-id.png', filename: 'id.png', mimeType: 'image/png', size: 10 } });
    await prisma.documentRecord.create({ data: { associateId: recent.id, kind: 'ID', s3Key: 'test/new-id.png', filename: 'id.png', mimeType: 'image/png', size: 10 } });
    const preview = await desk.agent.get('/document-retention/preview');
    expect(preview.body.count).toBe(1);
    expect(preview.body.candidates[0].id).toBe(old.id);
    expect((await purgeByRetention(prisma)).purged).toBe(1);
    const after = await prisma.documentRecord.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.s3Key).toBeNull();
    expect(after.purgedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(await prisma.auditLog.count({ where: { action: 'document.purged_by_retention', entityId: old.id } })).toBe(1);
  });
});

describe('mass update', () => {
  it('preview names each change; apply is one batch; undo restores the before', async () => {
    const desk = await hr();
    const client = await createClient('Acme');
    const front = await prisma.department.create({ data: { clientId: client.id, name: 'Front desk' } });
    const back = await prisma.department.create({ data: { clientId: client.id, name: 'Back office' } });
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const b = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
    await prisma.associate.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { departmentId: front.id } });
    const body = { filter: { departmentIds: [front.id] }, changes: { departmentId: back.id } };
    const preview = await desk.agent.post('/people/mass-update/preview').send(body);
    expect(preview.body).toMatchObject({ matched: 2, willChange: 2 });
    expect(preview.body.rows[0].changes[0]).toMatchObject({ field: 'department', from: 'Front desk', to: 'Back office' });
    const applied = await desk.agent.post('/people/mass-update').send(body);
    expect(applied.status).toBe(201);
    expect(await prisma.associate.count({ where: { departmentId: back.id } })).toBe(2);
    expect(await prisma.massUpdateBatch.count()).toBe(1);
    const undo = await desk.agent.post(`/people/mass-update/${applied.body.batchId}/undo`);
    expect(undo.body.restored).toBe(2);
    expect(await prisma.associate.count({ where: { departmentId: front.id } })).toBe(2);
    expect((await desk.agent.post(`/people/mass-update/${applied.body.batchId}/undo`)).status).toBe(409);
    // A filter is required — never "everyone" by accident.
    expect((await desk.agent.post('/people/mass-update/preview').send({ filter: {}, changes: {} })).status).toBe(400);
  });
});

describe('headcount plan', () => {
  it('budget against the filled person\'s annualized pay, rolled up by department', async () => {
    const desk = await hr();
    const client = await createClient('Acme');
    const dept = await prisma.department.create({ data: { clientId: client.id, name: 'Housekeeping' } });
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.compensationRecord.create({ data: { associateId: a.id, effectiveFrom: new Date('2025-01-01'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
    const created = await desk.agent.post('/positions').send({ clientId: client.id, code: 'HK-1', title: 'Room attendant', departmentId: dept.id, budgetAmount: 40000, budgetPeriod: 'ANNUAL' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ budgetAmount: '40000', budgetPeriod: 'ANNUAL' });
    await prisma.position.update({ where: { id: created.body.id }, data: { status: 'FILLED', filledByAssociateId: a.id, filledAt: new Date() } });
    const plan = await desk.agent.get(`/positions/plan?clientId=${client.id}`);
    expect(plan.status).toBe(200);
    expect(plan.body.positions[0]).toMatchObject({ annualBudget: 40000, projectedAnnualCost: 41600, variance: -1600 });
    expect(plan.body.departments[0]).toMatchObject({ departmentName: 'Housekeeping', budget: 40000, projected: 41600 });
  });
});

describe('offboarding', () => {
  it('completion is refused while property is out; a waiver with a reason lets it through; the preview names the state deadline', async () => {
    const desk = await hr();
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.associate.update({ where: { id: a.id }, data: { state: 'CA' } });
    const asset = await prisma.asset.create({ data: { kind: 'LAPTOP', label: 'MacBook 14', status: 'ASSIGNED' } });
    await prisma.assetAssignment.create({ data: { assetId: asset.id, associateId: a.id } });
    const sep = await desk.agent.post('/separations').send({ associateId: a.id, reason: 'INVOLUNTARY_PERFORMANCE', lastDayWorked: '2026-10-10' });
    expect(sep.status).toBe(201);
    const off = await desk.agent.get(`/separations/${sep.body.id}/offboarding`);
    expect(off.body.assets.outstanding).toHaveLength(1);
    expect(off.body.finalPay.deadline.date).toBe('2026-10-10');
    expect(off.body.finalPay.deadline.note).toMatch(/California/);
    await desk.agent.post(`/separations/${sep.body.id}/advance`);
    const blocked = await desk.agent.post(`/separations/${sep.body.id}/advance`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('assets_outstanding');
    expect((await desk.agent.post(`/separations/${sep.body.id}/assets/waive`).send({ reason: 'Laptop reported stolen, police report filed' })).status).toBe(200);
    const done = await desk.agent.post(`/separations/${sep.body.id}/advance`);
    expect([200, 202]).toContain(done.status);
  });
});

describe('report aggregates and people analytics', () => {
  it('group-by with count and sum, under the caller\'s scope', async () => {
    const desk = await hr();
    await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const b = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
    const c = await createAssociate({ firstName: 'Cy', lastName: 'Diaz' });
    await prisma.associate.updateMany({ where: { id: { in: [b.id, c.id] } }, data: { state: 'FL' } });
    const r = await desk.agent.post('/reports/preview').send({ name: 'By state', entity: 'ASSOCIATE', spec: { columns: ['state'], groupBy: ['state'], aggregates: [{ fn: 'count' }] } });
    expect(r.status).toBe(200);
    expect(r.body.columns).toEqual(['state', 'count']);
    expect(r.body.rows).toEqual(expect.arrayContaining([{ state: 'FL', count: 2 }]));
    // sum on a non-number column is refused.
    expect((await desk.agent.post('/reports/preview').send({ name: 'x', entity: 'ASSOCIATE', spec: { columns: ['state'], groupBy: ['state'], aggregates: [{ fn: 'sum', column: 'firstName' }] } })).status).toBe(400);
    const pa = await desk.agent.get('/people-analytics?months=6');
    expect(pa.status).toBe(200);
    expect(pa.body.headcount).toHaveLength(6);
    expect(pa.body.turnover.byTenure).toHaveLength(4);
  });
});

describe('the Manager\'s home and compensation planning', () => {
  it('what is due on the team and today on the team, scoped to direct reports', async () => {
    const mgrA = await createAssociate({ firstName: 'Mia', lastName: 'Grant' });
    const { user: mgr } = await createUser({ role: 'MANAGER', associateId: mgrA.id });
    const report = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const stranger = await createAssociate({ firstName: 'Zed', lastName: 'Quinn' });
    await prisma.associate.update({ where: { id: report.id }, data: { managerId: mgrA.id, hireDate: new Date('2023-01-01') } });
    await prisma.probationPeriod.create({ data: { associateId: report.id, startDate: new Date(Date.now() - 80 * DAY), endDate: new Date(Date.now() + 5 * DAY) } });
    await prisma.probationPeriod.create({ data: { associateId: stranger.id, startDate: new Date(Date.now() - 80 * DAY), endDate: new Date(Date.now() + 5 * DAY) } });
    const agent = await loginAs(mgr.email);
    const home = await agent.get('/team/home');
    expect(home.status).toBe(200);
    expect(home.body.due.probations).toHaveLength(1);
    expect(home.body.due.probations[0].associateName).toBe('Ana Lopez');
    // Never reviewed and hired years ago → a review is due.
    expect(home.body.due.reviews.map((r: { associateId: string }) => r.associateId)).toEqual([report.id]);
    expect(home.body.suggestions.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['reviews', 'probations']));
  });

  it('the worksheet shows a manager only their reports with band position; calibration is HR\'s', async () => {
    const desk = await hr();
    const client = await createClient('Acme');
    const mgrA = await createAssociate({ firstName: 'Mia', lastName: 'Grant' });
    const { user: mgr } = await createUser({ role: 'MANAGER', associateId: mgrA.id });
    const mine = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const other = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
    await prisma.associate.update({ where: { id: mine.id }, data: { managerId: mgrA.id } });
    await prisma.compBand.create({ data: { clientId: client.id, name: 'Hourly', payType: 'HOURLY', minAmount: 15, midAmount: 20, maxAmount: 25, effectiveFrom: new Date('2025-01-01') } });
    const cycle = await prisma.meritCycle.create({ data: { clientId: client.id, name: 'FY27', status: 'OPEN', reviewPeriodStart: new Date('2026-01-01'), reviewPeriodEnd: new Date('2026-12-31'), effectiveDate: new Date('2027-01-01'), budget: 10000 } });
    await prisma.meritProposal.createMany({
      data: [
        { cycleId: cycle.id, associateId: mine.id, currentAmount: 20, currentPayType: 'HOURLY', proposedAmount: 21 },
        { cycleId: cycle.id, associateId: other.id, currentAmount: 20, currentPayType: 'HOURLY', proposedAmount: 30 },
      ],
    });
    const m = await loginAs(mgr.email);
    const ws = await m.get(`/comp/cycles/${cycle.id}/worksheet`);
    expect(ws.status).toBe(200);
    expect(ws.body.rows).toHaveLength(1);
    expect(ws.body.rows[0]).toMatchObject({ associateName: 'Ana Lopez', increasePct: 5, bandPositionNow: 50, bandPositionProposed: 60 });
    expect(Number(ws.body.budget.share)).toBe(5000);
    const cal = await desk.agent.get(`/comp/cycles/${cycle.id}/calibration`);
    expect(cal.status).toBe(200);
    expect(cal.body.outliers.map((o: { associateName: string; reason: string }) => [o.associateName, o.reason])).toEqual(expect.arrayContaining([['Bo Chen', 'Above the band']]));
  });
});

describe('the assistant reads the help center', () => {
  it('a policy question is answered from a published article, with the link; a plain problem is still a hand-off', async () => {
    const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
    const { ensureBuiltInAgents } = await import('../../lib/agents.js');
    const { ALTO_TENANT_ID } = await import('../../lib/tenant.js');
    await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
    await prisma.kbArticle.create({ data: { title: 'Sick leave policy', slug: 'sick-leave', body: 'Every associate earns one hour of sick leave for every thirty hours worked.', category: 'Time off', status: 'PUBLISHED', publishedAt: new Date(), authorId: owner.id } });
    await prisma.kbArticle.create({ data: { title: 'Draft secret', slug: 'draft', body: 'sick leave draft', category: 'Time off', status: 'DRAFT' } });
    const ana = await worker();
    const asked = await ana.agent.post('/hugo/ask').send({ text: 'What is the sick leave policy?' });
    expect(asked.status).toBe(200);
    expect(asked.body.intent).toBe('HELP_CENTER');
    expect(asked.body.reply).toContain('Sick leave policy');
    expect(asked.body.linkUrl).toBe('/help-center?article=sick-leave');
    const problem = await ana.agent.post('/hugo/ask').send({ text: 'my badge broke' });
    expect(problem.body.intent).toBe('HANDOFF');
  });
});
