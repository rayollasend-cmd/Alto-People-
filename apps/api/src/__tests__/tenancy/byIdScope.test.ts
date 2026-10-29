import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { createAssociate, createClient, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * The by-id half of the site-scope suite (fix wave 2026-10-29, CODE-5…9,
 * 16, 17, 30, FLOOR-7/9). siteScope.test.ts calls every parameterless GET
 * list; this one calls the routes that take an id — GET, PATCH, POST,
 * DELETE — with ANOTHER STORE's id for every model a store-bound office
 * account must not reach: the person (SSN, bank, W-4, history,
 * deactivation, erasure, transfer, TIN, vault, punches), an approval
 * request, a garnishment, a tax form, a reimbursement, a document, a work
 * task, a shift, a time entry, a clock-in request, an attendance event, a
 * merit proposal, a goal / key result / 1:1 / review, a punch-photo rule.
 * Every one must answer 404 (or 403) — never act, never read. A handful of
 * the same routes with the caller's OWN store's ids must work, so the
 * suite cannot pass vacuously.
 */

const app = createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

type Store = Awaited<ReturnType<typeof seedStore>>;

async function seedStore(clientId: string, siteId: string, tag: 'North' | 'South', bossId: string, cycleId: string) {
  const person = await createAssociate({ firstName: `Ann${tag}`, lastName: `${tag}sider`, email: `ann.${tag.toLowerCase()}@by-id.example` });
  await prisma.application.create({ data: { associateId: person.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(), startDate: new Date('2024-01-02') } });
  await prisma.associateAssignment.create({ data: { associateId: person.id, locationId: siteId, startedAt: new Date('2024-01-02') } });
  await prisma.compensationRecord.create({ data: { associateId: person.id, effectiveFrom: new Date('2024-01-02'), payType: 'HOURLY', amount: 18, reason: 'HIRE' } });
  const shift = await prisma.shift.create({
    data: { clientId, locationId: siteId, position: 'Associate', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), status: 'ASSIGNED', assignedAssociateId: person.id, publishedAt: new Date() },
  });
  const entry = await prisma.timeEntry.create({
    data: { associateId: person.id, clientId, locationId: siteId, clockInAt: new Date(Date.now() - 8 * 3_600_000), clockOutAt: new Date(Date.now() - 3_600_000), status: 'COMPLETED' },
  });
  const clockIn = await prisma.clockInRequest.create({ data: { associateId: person.id, clientId, locationId: siteId, requestedAt: new Date(Date.now() - 600_000) } });
  const attendance = await prisma.attendanceEvent.create({ data: { associateId: person.id, clientId, kind: 'LATE', points: 0.5, occurredOn: new Date(Date.now() - 2 * 86_400_000), source: 'MANUAL' } });
  const document = await prisma.documentRecord.create({ data: { associateId: person.id, clientId, kind: 'ID', filename: `${tag}.pdf`, mimeType: 'application/pdf', size: 10, status: 'UPLOADED' } });
  const garnishment = await prisma.garnishment.create({ data: { associateId: person.id, kind: 'CHILD_SUPPORT', caseNumber: `${tag}-CASE`, amountPerRun: 50, startDate: new Date('2026-01-01') } });
  const taxForm = await prisma.taxForm.create({ data: { kind: 'W2', taxYear: 2025, associateId: person.id, amounts: { box1: 1000 } } });
  const reimb = await prisma.reimbursement.create({ data: { associateId: person.id, title: `${tag} mileage`, status: 'SUBMITTED', submittedAt: new Date(), totalAmount: 12 } });
  const line = await prisma.expenseLine.create({ data: { reimbursementId: reimb.id, kind: 'OTHER', description: 'Parking', incurredOn: new Date('2026-10-01'), amount: 12 } });
  const approval = await prisma.approvalRequest.create({
    data: {
      kind: 'PAY_RATE_CHANGE', subjectType: 'Associate', subjectId: person.id, title: `${tag} raise`,
      proposed: { associateId: person.id, effectiveFrom: '2026-11-01', payType: 'HOURLY', amount: 25, reason: 'MERIT' },
      requesterUserId: bossId, approverCapability: 'manage:comp', associateId: person.id, clientId,
    },
  });
  const task = await prisma.workTask.create({ data: { type: `${tag} restock`, locationId: siteId, windowStart: new Date(Date.now() + 3_600_000), windowEnd: new Date(Date.now() + 7_200_000), capability: 'food-service', estimatedMinutes: 30 } });
  const goal = await prisma.goal.create({ data: { associateId: person.id, title: `${tag} goal`, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-12-31') } });
  const kr = await prisma.keyResult.create({ data: { goalId: goal.id, title: `${tag} KR` } });
  const oneOnOne = await prisma.oneOnOne.create({ data: { associateId: person.id, managerUserId: bossId, scheduledFor: new Date(Date.now() + 86_400_000) } });
  const actionItem = await prisma.oneOnOneActionItem.create({ data: { oneOnOneId: oneOnOne.id, text: `${tag} follow-up` } });
  const review = await prisma.performanceReview.create({ data: { associateId: person.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'), overallRating: 3, summary: `${tag} review`, status: 'DRAFT' } });
  const proposal = await prisma.meritProposal.create({ data: { cycleId, associateId: person.id, currentAmount: 18, currentPayType: 'HOURLY', proposedAmount: 18 } });
  const photoRule = await prisma.punchPhotoRule.create({ data: { scope: 'SITE', siteId, required: true, startsOn: new Date('2026-01-01') } });
  const hrCase = await prisma.hrCase.create({ data: { associateId: person.id, category: 'OTHER', subject: `${tag} case`, description: 'x' } });
  const separation = await prisma.separation.create({ data: { associateId: person.id, reason: 'VOLUNTARY_PERSONAL', lastDayWorked: new Date('2026-12-31') } });
  return { siteId, person, shift, entry, clockIn, attendance, document, garnishment, taxForm, reimb, line, approval, task, goal, kr, oneOnOne, actionItem, review, proposal, photoRule, hrCase, separation };
}

describe.skipIf(process.env.SITE_SCOPE_SUITE === 'off')('by-id site-scope suite', () => {
  let hr: TestAgent<Test>;
  let N: Store;
  let S: Store;
  let clientId: string;
  let cycleId: string;

  beforeAll(async () => {
    await truncateAll();
    const client = await createClient('Two Store Client');
    clientId = client.id;
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const south = await prisma.site.create({ data: { name: 'South Store', clientId: client.id, timezone: 'America/New_York' } });
    const { user: boss } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'boss@by-id.example' });
    const cycle = await prisma.meritCycle.create({ data: { clientId: client.id, name: 'FY27 merit', reviewPeriodStart: new Date('2026-01-01'), reviewPeriodEnd: new Date('2026-12-31'), effectiveDate: new Date('2027-01-01'), status: 'OPEN' } });
    cycleId = cycle.id;
    N = await seedStore(client.id, north.id, 'North', boss.id, cycle.id);
    S = await seedStore(client.id, south.id, 'South', boss.id, cycle.id);
    // HR administrator — every capability these routes ask for — bound to the north store.
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr.north@by-id.example' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [north.id] } });
    hr = await loginAs(user.email);
  }, 300_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  type Call = [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: Record<string, unknown>];
  const soon = () => new Date(Date.now() - 4 * 3_600_000).toISOString();
  const later = () => new Date(Date.now() - 3_600_000).toISOString();

  function foreignCalls(): Call[] {
    const p = S.person.id;
    return [
      // CODE-5 — the person record.
      ['get', `/org/associates/${p}/history`],
      ['get', `/org/associates/${p}/as-of`],
      ['patch', `/org/associates/${p}`, { phone: '5555550100' }],
      ['post', `/org/associates/${p}/deactivate`, { reason: 'Leave of absence' }],
      ['post', `/org/associates/${p}/reactivate`, {}],
      ['get', `/org/associates/${p}/payout-method`],
      ['post', `/org/associates/${p}/payout-method/reveal`, { reason: 'Payment dispute review' }],
      ['patch', `/org/associates/${p}/payout-method`, { bankName: 'First Bank' }],
      ['get', `/org/associates/${p}/ssn`],
      ['post', `/org/associates/${p}/ssn/reveal`, { reason: 'E-Verify correction' }],
      ['get', `/org/associates/${p}/personal-info`],
      ['get', `/org/associates/${p}/w4`],
      ['patch', `/org/associates/${p}/w4`, { filingStatus: 'SINGLE' }],
      ['post', `/org/associates/${p}/erase`, { reason: 'Data subject erasure request', confirmName: 'Southsider' }],
      ['post', `/org/associates/${p}/transfer`, { locationId: N.siteId, startedAt: '2026-11-01' }],
      // …and the transfer TARGET: an own-store person moved into the other store.
      ['post', `/org/associates/${N.person.id}/transfer`, { locationId: S.siteId, startedAt: '2026-11-01' }],
      // CODE-7 — TIN; CODE-16 — the vault.
      ['get', `/associates/${p}/tin`],
      ['post', `/associates/${p}/tin`, { tin: '123456789' }],
      ['delete', `/associates/${p}/tin`],
      ['get', `/documents/admin/vault/${p}`],
      // CODE-9 — time.
      ['post', '/time/admin/entries', { associateId: p, clockInAt: soon(), clockOutAt: later() }],
      ['post', `/time/admin/attendance/${S.attendance.id}/excuse`, { note: 'Doctor' }],
      ['post', `/time/admin/clock-in-requests/${S.clockIn.id}/approve`, {}],
      ['post', `/time/admin/clock-in-requests/${S.clockIn.id}/deny`, { reason: 'Not scheduled' }],
      ['patch', `/time/admin/entries/${S.entry.id}`, { notes: 'Edited' }],
      ['post', `/time/admin/entries/${S.entry.id}/approve`, {}],
      ['post', `/time/admin/entries/${S.entry.id}/reject`, { reason: 'Wrong day' }],
      ['post', '/scheduling/shifts', { clientId, locationId: S.siteId, position: 'Associate', startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 5 * 86_400_000 + 4 * 3_600_000).toISOString() }],
      // …and the bulk create (several copies of one shift) checks the site the same way.
      ['post', '/scheduling/shifts/bulk', { clientId, locationId: S.siteId, position: 'Associate', associateIds: [], openCount: 2, startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 5 * 86_400_000 + 4 * 3_600_000).toISOString() }],
      // Separations: the offboarding sheet (last pay, PTO, assets out) by id.
      ['get', `/separations/${S.separation.id}/offboarding`],
      // CODE-6 — approvals.
      ['get', `/approvals/requests/${S.approval.id}`],
      ['post', `/approvals/requests/${S.approval.id}/decide`, { decision: 'APPROVE' }],
      ['post', `/approvals/requests/${S.approval.id}/cancel`, {}],
      // CODE-7 — garnishments and tax forms.
      ['get', `/garnishments/${S.garnishment.id}/deductions`],
      ['get', `/garnishments/${S.garnishment.id}/letter.pdf`],
      ['get', `/tax-forms/${S.taxForm.id}/mef.xml`],
      // CODE-8 — reimbursements.
      ['get', `/reimbursements/${S.reimb.id}`],
      ['post', `/reimbursements/${S.reimb.id}/lines`, { kind: 'OTHER', description: 'Tolls', incurredOn: '2026-10-02', amount: 3 }],
      ['post', `/reimbursements/${S.reimb.id}/submit`, {}],
      ['post', `/reimbursements/${S.reimb.id}/manager-approve`, {}],
      ['post', `/reimbursements/${S.reimb.id}/settle`, {}],
      ['post', `/reimbursements/${S.reimb.id}/reject`, { reason: 'Missing receipt' }],
      ['delete', `/expense-lines/${S.line.id}`],
      // CODE-16 — documents.
      ['post', `/documents/admin/${S.document.id}/verify`, {}],
      ['post', `/documents/admin/${S.document.id}/reclassify`, { kind: 'OTHER' }],
      ['post', `/documents/admin/${S.document.id}/reject`, { reason: 'Blurry photo' }],
      ['post', `/documents/admin/${S.document.id}/request-reupload`, {}],
      // FLOOR-9 — tasks.
      ['get', `/tasks/${S.task.id}`],
      ['post', `/tasks/${S.task.id}/auto`, {}],
      ['post', `/tasks/${S.task.id}/handoff`, {}],
      ['post', `/tasks/${S.task.id}/events`, { kind: 'DONE' }],
      ['post', `/tasks/${S.task.id}/assign`, { workerId: S.task.id }],
      // CODE-17 — merit proposals.
      ['put', `/comp/cycles/${cycleId}/proposals/${S.proposal.id}`, { proposedAmount: 25 }],
      // CODE-30 — goals, key results, 1:1s, reviews.
      ['put', `/performance/goals/${S.goal.id}`, { title: 'Renamed' }],
      ['delete', `/performance/goals/${S.goal.id}`],
      ['post', `/performance/goals/${S.goal.id}/key-results`, { title: 'New KR' }],
      ['put', `/performance/key-results/${S.kr.id}`, { title: 'Renamed KR' }],
      ['put', `/performance/one-on-ones/${S.oneOnOne.id}`, { agenda: 'Agenda' }],
      ['post', `/performance/one-on-ones/${S.oneOnOne.id}/action-items`, { text: 'Follow up' }],
      ['patch', `/performance/one-on-one-action-items/${S.actionItem.id}`, { done: true }],
      ['delete', `/performance/one-on-one-action-items/${S.actionItem.id}`],
      ['patch', `/performance/reviews/${S.review.id}`, { summary: 'Rewritten' }],
      ['post', `/performance/reviews/${S.review.id}/submit`, {}],
      // FLOOR-7 — punch-photo rules.
      ['put', '/time/punch-photos/rules', { scope: 'SITE', siteId: S.siteId, required: true }],
      ['delete', `/time/punch-photos/rules/${S.photoRule.id}`, { reason: 'No longer needed' }],
      // Already scoped before the wave — kept so they stay that way.
      ['get', `/hr-cases/${S.hrCase.id}`],
    ];
  }

  it('every by-id route answers another store’s id with 404 or 403, and changes nothing', async () => {
    const reached: string[] = [];
    for (const [method, path, body] of foreignCalls()) {
      const req = hr[method](path);
      const res = body ? await req.send(body) : await req;
      if (res.status !== 404 && res.status !== 403) reached.push(`${method.toUpperCase()} ${path} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    }
    expect(reached, 'routes that reached another store’s row').toEqual([]);
    // Nothing at store B moved.
    const p = await prisma.associate.findUniqueOrThrow({ where: { id: S.person.id } });
    expect(p.deactivatedAt).toBeNull();
    expect(p.erasedAt ?? null).toBeNull();
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: S.approval.id } })).status).toBe('PENDING');
    expect((await prisma.reimbursement.findUniqueOrThrow({ where: { id: S.reimb.id } })).status).toBe('SUBMITTED');
    expect((await prisma.documentRecord.findUniqueOrThrow({ where: { id: S.document.id } })).status).toBe('UPLOADED');
    expect((await prisma.clockInRequest.findUniqueOrThrow({ where: { id: S.clockIn.id } })).status).toBe('PENDING');
    expect((await prisma.punchPhotoRule.findUniqueOrThrow({ where: { id: S.photoRule.id } })).endedAt).toBeNull();
    expect(await prisma.shift.count({ where: { locationId: S.siteId } })).toBe(1);
    expect(await prisma.associateAssignment.count({ where: { associateId: N.person.id, locationId: S.siteId } })).toBe(0);
  }, 900_000);

  it('the same routes with the caller’s own store’s ids still work (the suite is not vacuous)', async () => {
    const own: Call[] = [
      ['get', `/org/associates/${N.person.id}/history`],
      ['get', `/org/associates/${N.person.id}/ssn`],
      ['get', `/associates/${N.person.id}/tin`],
      ['get', `/documents/admin/vault/${N.person.id}`],
      ['get', `/time/admin/attendance?associateId=${N.person.id}`],
      ['get', `/approvals/requests/${N.approval.id}`],
      ['get', `/reimbursements/${N.reimb.id}`],
      ['get', `/tasks/${N.task.id}`],
      ['put', `/performance/key-results/${N.kr.id}`, { title: 'Renamed KR' }],
      ['put', `/comp/cycles/${cycleId}/proposals/${N.proposal.id}`, { proposedAmount: 19 }],
    ];
    const refused: string[] = [];
    for (const [method, path, body] of own) {
      const req = hr[method](path);
      const res = body ? await req.send(body) : await req;
      if (res.status >= 400) refused.push(`${method.toUpperCase()} ${path} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    }
    expect(refused, 'own-store routes that were refused').toEqual([]);
  }, 300_000);

  it('the lists the by-id routes come from stop at the store too', async () => {
    const has = (body: unknown, id: string) => JSON.stringify(body).includes(id);
    // The garnishment and filing desks carry payroll amounts: a store-bound
    // account is refused outright (lib/payrollMoney's gate), never shown the
    // company's orders or forms. The list's own reach (CODE-7) stands behind it.
    expect((await hr.get('/garnishments')).status).toBe(403);
    expect((await hr.get('/tax-forms')).status).toBe(403);
    const decide = await hr.get('/approvals/requests?scope=decide');
    expect(has(decide.body, N.approval.id)).toBe(true);
    expect(has(decide.body, S.approval.id)).toBe(false);
    expect((await hr.get('/approvals/requests/count')).body.count).toBe(1);
    const record = await hr.get('/approvals/requests?scope=all');
    expect(record.status).toBe(200);
    expect(has(record.body, S.approval.id)).toBe(false);
    const tasks = await hr.get('/tasks');
    expect(has(tasks.body, N.task.id)).toBe(true);
    expect(has(tasks.body, S.task.id)).toBe(false);
    const goals = await hr.get('/performance/goals');
    expect(has(goals.body, N.goal.id)).toBe(true);
    expect(has(goals.body, S.goal.id)).toBe(false);
    const meetings = await hr.get('/performance/one-on-ones');
    expect(has(meetings.body, S.oneOnOne.id)).toBe(false);
    // Another store's person's attendance reads as empty, not as theirs.
    const att = await hr.get(`/time/admin/attendance?associateId=${S.person.id}`);
    expect(att.status).toBe(200);
    expect(att.body.events).toHaveLength(0);
    const requests = await hr.get('/time/admin/clock-in-requests');
    expect(has(requests.body, N.clockIn.id)).toBe(true);
    expect(has(requests.body, S.clockIn.id)).toBe(false);
    const photos = await hr.get('/time/punch-photos');
    expect(has(photos.body, N.photoRule.id)).toBe(true);
    expect(has(photos.body, S.photoRule.id)).toBe(false);
  }, 300_000);
});
