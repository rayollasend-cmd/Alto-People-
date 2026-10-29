import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { ensurePersonWorkers } from '../../lib/workers.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { createOrgUnit } from '../../lib/orgUnits.js';

/**
 * The fix wave's "who may do what" (builder SEC, 2026-10-29): never grant
 * more than you hold (PEOPLE-1, PEOPLE-2), the HR case desk is HR's
 * (PEOPLE-5), maker ≠ checker on expenses (CODE-8), an approval request is
 * read only by its parties (CODE-6), a person's task cost is pay (FLOOR-6),
 * a supervisor's reach on tasks and photo rules (FLOOR-7, FLOOR-9), the
 * merit seed (CODE-17), and the small input holes (CODE-19, CODE-24, CODE-30).
 */

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function as(role: Parameters<typeof createUser>[0]['role'], extra: Partial<Parameters<typeof createUser>[0]> = {}) {
  const { user } = await createUser({ role, ...extra });
  return { user, api: await loginAs(user.email) };
}

describe('PEOPLE-1 — onboarding never mints a role above the person hiring', () => {
  it('recruiter and workforce manager are refused a staff role above theirs, on create and on re-invite; HR may; associates are everyday hires', async () => {
    const client = await createClient('Seaside');
    const template = await createStandardTemplate(client.id);
    const base = { associateFirstName: 'New', associateLastName: 'Hire', clientId: client.id, templateId: template.id };
    const recruiter = await as('INTERNAL_RECRUITER');
    const workforce = await as('WORKFORCE_MANAGER');
    const hr = await as('HR_ADMINISTRATOR');

    for (const [who, role] of [
      [recruiter, 'MANAGER'],
      [recruiter, 'FINANCE_ACCOUNTANT'],
      [recruiter, 'OPERATIONS_MANAGER'],
      [workforce, 'OPERATIONS_MANAGER'],
      [workforce, 'MANAGER'],
    ] as const) {
      const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@second.example`;
      const res = await who.api.post('/onboarding/applications').send({ ...base, associateEmail: email, hireRole: role });
      expect(res.status, `${who.user.role} → ${role}`).toBe(403);
      expect(res.body.error?.code).toBe('role_escalation_forbidden');
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    }

    // The everyday hire still works for the desk.
    const assoc = await recruiter.api.post('/onboarding/applications').send({ ...base, associateEmail: 'worker@second.example' });
    expect(assoc.status, JSON.stringify(assoc.body)).toBeLessThan(300);

    // HR may hire a Manager…
    const mgr = await hr.api.post('/onboarding/applications').send({ ...base, associateEmail: 'pending.manager@second.example', hireRole: 'MANAGER' });
    expect(mgr.status, JSON.stringify(mgr.body)).toBeLessThan(300);
    expect((await prisma.user.findFirstOrThrow({ where: { email: 'pending.manager@second.example' } })).role).toBe('MANAGER');
    // …and the recruiter cannot re-route that pending Manager by re-inviting the email.
    const reroute = await recruiter.api.post('/onboarding/applications').send({ ...base, associateEmail: 'pending.manager@second.example' });
    expect(reroute.status).toBe(403);
    expect(reroute.body.error?.code).toBe('target_more_privileged');
    expect((await prisma.user.findFirstOrThrow({ where: { email: 'pending.manager@second.example' } })).role).toBe('MANAGER');
    // Re-invite promotion answers to the same rule as a fresh invite.
    const promote = await recruiter.api.post('/onboarding/applications').send({ ...base, associateEmail: 'worker@second.example', hireRole: 'FINANCE_ACCOUNTANT' });
    expect(promote.status).toBe(403);
    expect((await prisma.user.findFirstOrThrow({ where: { email: 'worker@second.example' } })).role).toBe('ASSOCIATE');
  }, 600_000);
});

describe('PEOPLE-2 — sign-in, SCIM and group mappings are the org administrator’s', () => {
  it('the workforce manager (manage:org, no HR admin) changes nothing on the identity desk; HR does', async () => {
    const workforce = await as('WORKFORCE_MANAGER');
    expect((await workforce.api.get('/identity')).status).toBe(403);
    expect((await workforce.api.get('/identity/security-policy')).status).toBe(403);
    expect((await workforce.api.post('/identity/scim-tokens').send({ name: 'Okta' })).status).toBe(403);
    expect((await workforce.api.post('/tenant-roles/scim-groups').send({ groupName: 'Leads', archetype: 'HR_ADMINISTRATOR' })).status).toBe(403);
    expect((await workforce.api.post('/tenant-roles').send({ name: 'x', archetype: 'WORKFORCE_MANAGER', capabilities: [] })).status).toBe(403);
    const mfa = await workforce.api.patch('/admin/org/settings').send({ mfaRequirement: 'OFF' });
    expect(mfa.status).toBe(403);

    const hr = await as('HR_ADMINISTRATOR');
    expect((await hr.api.get('/identity')).status).toBe(200);
    expect((await hr.api.patch('/admin/org/settings').send({ mfaRequirement: 'ADMINS' })).status).toBe(200);
  }, 300_000);

  it('a directory group maps only to a role the mapper could grant themselves', async () => {
    const ops = await as('OPERATIONS_MANAGER');
    // HR administrator holds void:payroll and export:payroll-pii, which Operations does not.
    const up = await ops.api.post('/tenant-roles/scim-groups').send({ groupName: 'Alto Owners', archetype: 'HR_ADMINISTRATOR' });
    expect(up.status).toBe(403);
    expect(up.body.error?.code).toBe('role_escalation_forbidden');
    expect(await prisma.scimGroupRoleMap.count()).toBe(0);
    const ok = await ops.api.post('/tenant-roles/scim-groups').send({ groupName: 'Store Leads', archetype: 'MANAGER' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  }, 300_000);
});

describe('PEOPLE-5 — the HR case desk is HR’s', () => {
  it('the recruiter and workforce manager neither list nor open nor work cases; they still file and follow their own; HR works them', async () => {
    const victim = await createAssociate({ firstName: 'Val', lastName: 'Victim' });
    const { user: victimUser } = await createUser({ role: 'ASSOCIATE', associateId: victim.id, email: victim.email });
    const filed = await (await loginAs(victimUser.email)).post('/hr-cases').send({ category: 'HARASSMENT', subject: 'Comments at the dock', description: 'Repeated remarks.' });
    expect(filed.status).toBe(201);
    const caseId = filed.body.id as string;

    const recAssoc = await createAssociate({ firstName: 'Rae', lastName: 'Recruiter' });
    const recruiter = await as('INTERNAL_RECRUITER', { associateId: recAssoc.id });
    const workforce = await as('WORKFORCE_MANAGER');
    for (const who of [recruiter, workforce]) {
      expect((await who.api.get('/hr-cases?state=open')).status, who.user.role).toBe(403);
      expect((await who.api.get('/hr-cases-summary')).status, who.user.role).toBe(403);
      expect((await who.api.get(`/hr-cases/${caseId}`)).status, who.user.role).toBe(403);
      expect((await who.api.patch(`/hr-cases/${caseId}`).send({ status: 'IN_PROGRESS' })).status, who.user.role).toBe(403);
      expect((await who.api.post('/hr-cases/on-behalf').send({ associateId: victim.id, category: 'OTHER', subject: 'Phone call', description: 'x', channel: 'PHONE' })).status).toBe(403);
    }
    expect((await workforce.api.put('/hr-cases-sla').send({ targets: [{ category: 'HARASSMENT', priority: 'HIGH', targetHours: 1 }] })).status).toBe(403);

    // Their own case is still theirs.
    const own = await recruiter.api.post('/hr-cases').send({ category: 'PAYROLL', subject: 'Missing overtime', description: 'Week of the 12th.' });
    expect(own.status).toBe(201);
    const mine = await recruiter.api.get('/my/hr-cases');
    expect(mine.body.cases.map((c: { id: string }) => c.id)).toEqual([own.body.id]);

    const hr = await as('HR_ADMINISTRATOR');
    const queue = await hr.api.get('/hr-cases?state=open');
    expect(queue.status).toBe(200);
    expect(queue.body.cases.map((c: { id: string }) => c.id)).toContain(caseId);
    // A case goes only to someone whose desk works it.
    expect((await hr.api.patch(`/hr-cases/${caseId}`).send({ assignedToId: recruiter.user.id })).status).toBe(400);
    const { user: hr2 } = await createUser({ role: 'HR_ADMINISTRATOR' });
    expect((await hr.api.patch(`/hr-cases/${caseId}`).send({ assignedToId: hr2.id })).status).toBe(200);

    // Finance works the PAYROLL desk only.
    const finance = await as('FINANCE_ACCOUNTANT');
    const fq = await finance.api.get('/hr-cases?state=open');
    expect(fq.status).toBe(200);
    expect(fq.body.cases.map((c: { id: string }) => c.id)).toEqual([own.body.id]);
  }, 600_000);
});

describe('CODE-6 — an approval request is read by its parties only', () => {
  it('an associate with a request id from a link learns nothing; the requester and the record’s readers do', async () => {
    const person = await createAssociate({ firstName: 'Pia', lastName: 'Pay' });
    const { user: boss } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const req = await prisma.approvalRequest.create({
      data: {
        kind: 'PAY_RATE_CHANGE', subjectType: 'Associate', subjectId: person.id, title: 'Raise for Pia',
        proposed: { associateId: person.id, effectiveFrom: '2026-11-01', payType: 'HOURLY', amount: 30, reason: 'MERIT' },
        before: { amount: 18 }, requesterUserId: boss.id, approverCapability: 'manage:comp', associateId: person.id,
      },
    });
    const other = await createAssociate({ firstName: 'Ozzy', lastName: 'Other' });
    const outsider = await as('ASSOCIATE', { associateId: other.id, email: other.email });
    expect((await outsider.api.get(`/approvals/requests/${req.id}`)).status).toBe(404);
    expect((await (await loginAs(boss.email)).get(`/approvals/requests/${req.id}`)).status).toBe(200);
    const finance = await as('FINANCE_ACCOUNTANT');
    expect((await finance.api.get(`/approvals/requests/${req.id}`)).status).toBe(200);
  }, 300_000);
});

describe('CODE-8 — expenses: filer, approver and settler are three people', () => {
  it('nobody approves or settles their own report, and the approver never settles it', async () => {
    const filerPerson = await createAssociate({ firstName: 'Hal', lastName: 'Filer' });
    const filer = await as('HR_ADMINISTRATOR', { associateId: filerPerson.id });
    const created = await filer.api.post('/reimbursements').send({ title: 'Client visit' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await filer.api.post(`/reimbursements/${id}/lines`).send({ kind: 'OTHER', description: 'Parking', incurredOn: '2026-10-01', amount: 12 })).status).toBe(201);
    // Someone else (not the filer) cannot add lines to it.
    const ops = await as('OPERATIONS_MANAGER');
    expect((await ops.api.post(`/reimbursements/${id}/lines`).send({ kind: 'OTHER', description: 'Extra', incurredOn: '2026-10-01', amount: 500 })).status).toBe(403);
    expect((await filer.api.post(`/reimbursements/${id}/submit`)).status).toBe(200);

    const self = await filer.api.post(`/reimbursements/${id}/manager-approve`).send({});
    expect(self.status).toBe(403);
    expect(self.body.error?.code).toBe('maker_checker');

    const approver = await as('HR_ADMINISTRATOR');
    expect((await approver.api.post(`/reimbursements/${id}/manager-approve`).send({})).status).toBe(200);
    const approverSettles = await approver.api.post(`/reimbursements/${id}/settle`).send({});
    expect(approverSettles.status).toBe(403);
    expect(approverSettles.body.error?.code).toBe('maker_checker');
    expect((await filer.api.post(`/reimbursements/${id}/settle`).send({})).status).toBe(403);

    const finance = await as('FINANCE_ACCOUNTANT');
    expect((await finance.api.post(`/reimbursements/${id}/settle`).send({})).status).toBe(200);
    expect((await prisma.reimbursement.findUniqueOrThrow({ where: { id } })).status).toBe('SETTLED');
  }, 600_000);
});

/** One client, a store with a person on shift at $17/h, and a supervisor of that client. */
async function floor() {
  const client = await createClient('Alpha Foods');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const other = await createClient('Beta Hotels');
  const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
  // An administrator first: every person-worker is created with an owner.
  const hr = await as('HR_ADMINISTRATOR');
  const ty = await createAssociate({ firstName: 'Tyler', lastName: 'Alvarez' });
  const startsAt = new Date(Date.now() + 3_600_000);
  await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Stocker', startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: ty.id, payRate: 17 } });
  await runWithTenant(ALTO_TENANT_ID, 'script', () => ensurePersonWorkers(prisma));
  await prisma.worker.update({ where: { associateId: ty.id }, data: { capabilities: ['food-service'], status: 'ACTIVE' } });
  const sup = await as('SHIFT_SUPERVISOR', { clientId: client.id });
  return { client, site, other, otherSite, ty, startsAt, hr, sup };
}

describe('FLOOR-6 — a person’s task cost is their pay', () => {
  it('a shift supervisor sees the ranking without a person’s dollar cost; a pay role sees it', async () => {
    const f = await floor();
    // A cap so the 2-hour task queues with "Best option costs $34.00, above the $25.00…".
    await prisma.workTaskPolicy.create({ data: { locationId: null, maxAutoAssignCents: 2500 } });
    const win = { windowStart: new Date(f.startsAt.getTime() + 600_000).toISOString(), windowEnd: new Date(f.startsAt.getTime() + 3 * 3_600_000).toISOString() };
    const small = await f.hr.api.post('/tasks').send({ type: 'Face the aisle', locationId: f.site.id, ...win, capability: 'food-service', risk: 'LOW', estimatedMinutes: 30 });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(small.body.assignment.workerType).toBe('PERSON');
    expect(small.body.assignment.costCents).toBe(850);

    const supView = await f.sup.api.get(`/tasks/${small.body.id}`);
    expect(supView.status).toBe(200);
    expect(supView.body.assignment.costCents).toBe(0);
    const text = JSON.stringify(supView.body);
    expect(text).not.toContain('$8.50');
    expect(text).not.toContain('850');

    const big = await f.hr.api.post('/tasks').send({ type: 'Unload the truck', locationId: f.site.id, ...win, capability: 'food-service', risk: 'LOW', estimatedMinutes: 120 });
    expect(big.body.status).toBe('QUEUED');
    expect(big.body.queuedReason).toContain('$34.00');
    const supBig = await f.sup.api.get(`/tasks/${big.body.id}`);
    expect(JSON.stringify(supBig.body)).not.toContain('$34.00');
    const list = await f.sup.api.get('/tasks');
    expect(JSON.stringify(list.body)).not.toContain('$34.00');
    expect(JSON.stringify(list.body)).not.toContain('$8.50');
  }, 600_000);
});

describe('FLOOR-9 — a supervisor’s tasks are her client’s', () => {
  it('the board, its summary, a task by id and the Inbox count stop at her client — and the count matches the board', async () => {
    const f = await floor();
    const mk = (locationId: string, status: 'QUEUED' | 'STALLED' | 'FAILED' | 'OPEN') =>
      prisma.workTask.create({ data: { type: `t-${status}`, locationId, windowStart: new Date(Date.now() - 3_600_000), windowEnd: new Date(Date.now() + 3_600_000), capability: 'food-service', estimatedMinutes: 30, status } });
    const mine = [await mk(f.site.id, 'QUEUED'), await mk(f.site.id, 'STALLED')];
    const theirs = [await mk(f.otherSite.id, 'QUEUED'), await mk(f.otherSite.id, 'FAILED'), await mk(f.otherSite.id, 'QUEUED')];

    const board = await f.sup.api.get('/tasks');
    const ids = board.body.tasks.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(mine.map((t) => t.id)));
    for (const t of theirs) expect(ids).not.toContain(t.id);
    const summary = await f.sup.api.get('/tasks/summary');
    expect(summary.body.queued).toBe(1);
    expect((await f.sup.api.get(`/tasks/${theirs[0]!.id}`)).status).toBe(404);

    // The Inbox's "Tasks needing a person" and the board's needs view (one status per call) agree.
    const needs = (await Promise.all(['QUEUED', 'STALLED', 'FAILED'].map((s) => f.sup.api.get(`/tasks?status=${s}`)))).flatMap((r) => r.body.tasks);
    expect(needs).toHaveLength(2);
    const piped = await f.sup.api.get('/tasks?status=QUEUED|STALLED|FAILED');
    expect(piped.body.tasks).toHaveLength(2);
    const inbox = await f.sup.api.get('/me/inbox');
    const source = (inbox.body.sources as Array<{ key: string; count: number }>).find((s) => s.key === 'tasks');
    expect(source?.count ?? 0).toBe(2);
    // HR, company-wide, sees all five.
    const all = await f.hr.api.get('/tasks?status=QUEUED|STALLED|FAILED');
    expect(all.body.tasks).toHaveLength(5);
  }, 600_000);
});

describe('FLOOR-7 — a one-client supervisor sets photo rules for her own client and stores only', () => {
  it('no company-wide rule, no other client’s, no other client’s store; her own are fine', async () => {
    const f = await floor();
    const theirRule = await prisma.punchPhotoRule.create({ data: { scope: 'SITE', siteId: f.otherSite.id, required: true, startsOn: new Date('2026-01-01') } });
    const company = await f.sup.api.put('/time/punch-photos/rules').send({ scope: 'COMPANY', required: true });
    expect(company.status).toBe(403);
    expect((await f.sup.api.put('/time/punch-photos/rules').send({ scope: 'CLIENT', clientId: f.other.id, required: true })).status).toBe(404);
    expect((await f.sup.api.put('/time/punch-photos/rules').send({ scope: 'SITE', siteId: f.otherSite.id, required: false })).status).toBe(404);
    expect((await f.sup.api.delete(`/time/punch-photos/rules/${theirRule.id}`).send({ reason: 'Not needed' })).status).toBe(404);
    expect((await f.sup.api.put('/time/punch-photos/rules').send({ scope: 'SITE', siteId: f.site.id, required: true })).status).toBe(200);
    expect((await f.sup.api.put('/time/punch-photos/rules').send({ scope: 'CLIENT', clientId: f.client.id, required: true })).status).toBe(200);
    expect(await prisma.punchPhotoRule.count({ where: { scope: 'COMPANY' } })).toBe(0);

    const overview = await f.sup.api.get('/time/punch-photos');
    expect(overview.status).toBe(200);
    expect(overview.body.canSetCompanyRule).toBe(false);
    expect(JSON.stringify(overview.body)).not.toContain(theirRule.id);
    expect((overview.body.places as Array<{ id: string }>).map((p) => p.id)).toEqual([f.site.id]);
    // HR, company-wide, may.
    expect((await f.hr.api.put('/time/punch-photos/rules').send({ scope: 'COMPANY', required: true })).status).toBe(200);
    expect((await f.hr.api.get('/time/punch-photos')).body.canSetCompanyRule).toBe(true);
  }, 600_000);
});

describe('CODE-17 — the merit seed', () => {
  it('seeds the cycle client’s active people in reach, every one, and re-seeding is harmless', async () => {
    const client = await createClient('Merit Co');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const other = await createClient('Elsewhere');
    const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const place = async (siteId: string, first: string, opts: { deactivated?: boolean; comp?: boolean } = {}) => {
      const a = await createAssociate({ firstName: first, lastName: 'Merit' });
      await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date('2025-01-01') } });
      if (opts.comp !== false) await prisma.compensationRecord.create({ data: { associateId: a.id, effectiveFrom: new Date('2025-01-01'), payType: 'HOURLY', amount: 18, reason: 'HIRE' } });
      if (opts.deactivated) await prisma.associate.update({ where: { id: a.id }, data: { deactivatedAt: new Date() } });
      return a;
    };
    const keep = await place(site.id, 'Kim');
    await place(site.id, 'Dee', { deactivated: true });
    await place(site.id, 'Nora', { comp: false });
    await place(otherSite.id, 'Otto');
    const hr = await as('HR_ADMINISTRATOR');
    const cycle = await hr.api.post('/comp/cycles').send({ clientId: client.id, name: 'FY27', reviewPeriodStart: '2026-01-01', reviewPeriodEnd: '2026-12-31', effectiveDate: '2027-01-01' });
    expect(cycle.status).toBe(201);
    const seeded = await hr.api.post(`/comp/cycles/${cycle.body.id}/proposals/seed`).send({});
    expect(seeded.status).toBe(200);
    expect(seeded.body.created).toBe(1);
    const rows = await prisma.meritProposal.findMany({ where: { cycleId: cycle.body.id } });
    expect(rows.map((r) => r.associateId)).toEqual([keep.id]);
    const again = await hr.api.post(`/comp/cycles/${cycle.body.id}/proposals/seed`).send({});
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(0);
  }, 300_000);
});

describe('org catalogs — a company-wide row (no client)', () => {
  it('departments, job profiles and shift positions list a client-less row with clientId null, not a 400', async () => {
    await prisma.department.create({ data: { name: 'Company-wide dept' } });
    await prisma.jobProfile.create({ data: { code: 'CW-1', title: 'Company-wide profile' } });
    await prisma.shiftPosition.create({ data: { name: 'Company-wide position' } });
    const hr = await as('HR_ADMINISTRATOR');
    const depts = await hr.api.get('/org/departments');
    expect(depts.status, JSON.stringify(depts.body)).toBe(200);
    expect(depts.body.departments[0].clientId).toBeNull();
    const profiles = await hr.api.get('/org/job-profiles');
    expect(profiles.status, JSON.stringify(profiles.body)).toBe(200);
    expect(profiles.body.jobProfiles[0].clientId).toBeNull();
    const positions = await hr.api.get('/org/shift-positions');
    expect(positions.status, JSON.stringify(positions.body)).toBe(200);
    expect(positions.body.shiftPositions[0].clientId).toBeNull();
  }, 300_000);
});

describe('CODE-19 / CODE-24 / CODE-30 — the small holes', () => {
  it('document paging takes whole numbers; the I-9 expiry must be a real date', async () => {
    const hr = await as('HR_ADMINISTRATOR');
    for (const page of ['1.5', '1e20', '-3', 'abc']) {
      const res = await hr.api.get(`/documents/admin?page=${page}&pageSize=2.7`);
      expect(res.status, page).toBe(200);
      expect(Number.isInteger(res.body.page)).toBe(true);
      expect(Number.isInteger(res.body.pageSize)).toBe(true);
    }
    const client = await createClient();
    const person = await createAssociate({ firstName: 'Ida', lastName: 'Nine' });
    const application = await createApplicationWithChecklist({ associateId: person.id, clientId: client.id });
    const me = await as('ASSOCIATE', { associateId: person.id, email: person.email });
    const bad = await me.api.post(`/onboarding/applications/${application.id}/i9/section1`).send({ citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', typedName: 'Ida Nine', alienRegistrationNumber: 'A123456789', workAuthExpiresAt: '12/31/2027' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('invalid_work_auth_expiry');
    const notADay = await me.api.post(`/onboarding/applications/${application.id}/i9/section1`).send({ citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', typedName: 'Ida Nine', alienRegistrationNumber: 'A123456789', workAuthExpiresAt: '2027-02-30' });
    expect(notADay.status).toBe(400);
    const ok = await me.api.post(`/onboarding/applications/${application.id}/i9/section1`).send({ citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', typedName: 'Ida Nine', alienRegistrationNumber: 'A123456789', workAuthExpiresAt: '2027-12-31' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  }, 300_000);

  it('the pending-time buckets sum to the count beside them', async () => {
    const client = await createClient();
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const person = await createAssociate();
    for (let d = 1; d <= 6; d++) {
      await prisma.timeEntry.create({ data: { associateId: person.id, clientId: client.id, locationId: site.id, clockInAt: new Date(Date.now() - d * 86_400_000), clockOutAt: new Date(Date.now() - d * 86_400_000 + 4 * 3_600_000), status: 'COMPLETED' } });
    }
    const hr = await as('HR_ADMINISTRATOR');
    const res = await hr.api.get('/time/admin/entries/count?status=COMPLETED&groupBy=payPeriod');
    expect(res.status).toBe(200);
    const sum = (res.body.byPeriod as Array<{ count: number }>).reduce((t, b) => t + b.count, 0);
    expect(sum).toBe(res.body.count);
    expect(res.body.count).toBe(6);
  }, 300_000);

  it('a performance review is audited as a PerformanceReview; an org unit names only this tenant’s client', async () => {
    const person = await createAssociate({ firstName: 'Rae', lastName: 'Review' });
    const hr = await as('HR_ADMINISTRATOR');
    const created = await hr.api.post('/performance/reviews').send({ associateId: person.id, periodStart: '2026-01-01', periodEnd: '2026-06-30', overallRating: 4, summary: 'Strong half.' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await flushPendingAudits();
    const row = await prisma.auditLog.findFirst({ where: { action: 'performance.review_created' } });
    expect(row?.entityType).toBe('PerformanceReview');
    expect(row?.entityId).toBe(created.body.id);

    await expect(
      runWithTenant(ALTO_TENANT_ID, 'script', () => createOrgUnit(prisma, { type: 'REGION', name: 'Ghost region', clientId: '9b6f2c1e-0000-4000-8000-00000000abcd' })),
    ).rejects.toMatchObject({ status: 400, code: 'client_not_found' });
  }, 300_000);
});
