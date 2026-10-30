import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { addDaysToKey } from '../../lib/timezone.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Leave of absence and claims: FMLA eligibility from the record, the case
 * from request to return (notices, certification, shifts released), medical
 * documents only for leave admins; unemployment claims argued from the
 * record; workers' comp from the incident to the carrier and modified duty.
 */

const app = () => createApp();
const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n%test certification\n');

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

/** A worker with two years' service and ~1,300 hours in the last year. */
async function veteranWorker(siteId: string) {
  const a = await createAssociate({ firstName: 'Vera', lastName: 'Long' });
  await prisma.associate.update({ where: { id: a.id }, data: { hireDate: new Date(Date.now() - 730 * DAY), state: 'CA' } });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date(Date.now() - 700 * DAY) } });
  const rows = Array.from({ length: 165 }, (_, i) => {
    const start = new Date(Date.now() - (i * 2 + 2) * DAY);
    return { associateId: a.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * 3_600_000), status: 'APPROVED' as const };
  });
  await prisma.timeEntry.createMany({ data: rows });
  return a;
}

describe('leave of absence', () => {
  it('checks FMLA eligibility from the record — both ways, with plain reasons', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const vera = await veteranWorker(site.id);
    const newbie = await createAssociate({ firstName: 'Nico', lastName: 'New' });
    await prisma.associate.update({ where: { id: newbie.id }, data: { hireDate: new Date(Date.now() - 90 * DAY) } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const yes = await a.get(`/leave/eligibility/${vera.id}`);
    expect(yes.status).toBe(200);
    expect(yes.body.eligibility.eligible).toBe(true);
    expect(yes.body.eligibility.hoursLast12Months).toBeGreaterThanOrEqual(1250);
    expect(yes.body.balance.entitlementHours).toBeGreaterThan(0);

    const no = await a.get(`/leave/eligibility/${newbie.id}`);
    expect(no.body.eligibility.eligible).toBe(false);
    expect(no.body.eligibility.reasons.join(' ')).toMatch(/months with the employer — FMLA needs 12/);
    expect(no.body.eligibility.reasons.join(' ')).toMatch(/1,250/);
  });

  it('runs a case end to end: notice, certification, approval releases shifts, return needs fitness-for-duty', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const vera = await veteranWorker(site.id);
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: vera.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    // The company's today: the case's dates and the certification clock run on its calendar
    // (UTC's day is tomorrow after 8 PM Eastern).
    const start = orgDateKey(new Date());
    const end = addDaysToKey(start, 28);
    const future = new Date(Date.now() + 3 * DAY);
    const shift = await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt: future, endsAt: new Date(future.getTime() + 8 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: vera.id } });

    const opened = await a.post('/leave/cases').send({ associateId: vera.id, type: 'FMLA', reason: 'OWN_HEALTH', schedule: 'CONTINUOUS', startDate: start, endDate: end });
    expect(opened.status).toBe(201);
    const id = opened.body.case.id as string;
    expect(opened.body.case.eligibility.eligible).toBe(true);
    expect(opened.body.case.next.key).toBe('notice');

    const notice = await a.post(`/leave/cases/${id}/notice`);
    expect(notice.body.case.status).toBe('PENDING_CERTIFICATION');
    expect(notice.body.case.certificationDueAt).toBe(addDaysToKey(start, 15));
    const pdf = await a.get(`/leave/cases/${id}/notices/eligibility`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);

    // The worker returns the certification from their phone.
    const w = await loginAs(worker.email);
    const mine = await w.get('/me/leave');
    expect(mine.body.cases[0]).toMatchObject({ id, certificationRequired: true, certificationReceived: false, noticeAvailable: true });
    const up = await w.post(`/me/leave/${id}/documents`).field('kind', 'MEDICAL_CERTIFICATION').attach('file', PDF, { filename: 'cert.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.case.certificationReceived).toBe(true);

    // Deny needs a reason; approval releases the shift and tells the leads.
    expect((await a.post(`/leave/cases/${id}/decide`).send({ decision: 'DENY' })).status).toBe(400);
    const ok = await a.post(`/leave/cases/${id}/decide`).send({ decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.case).toMatchObject({ status: 'APPROVED', designatedFmla: true, fitnessForDutyRequired: true, shiftsReleased: 1, jobProtected: true });
    expect(await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).toMatchObject({ status: 'OPEN', assignedAssociateId: null });

    // The person record carries the job-protection flag.
    const status = await a.get(`/leave/people/${vera.id}/status`);
    expect(status.body.protectedLeave).toMatchObject({ caseId: id, type: 'FMLA' });

    // Return: refused without fitness-for-duty unless a reason is recorded.
    expect((await a.post(`/leave/cases/${id}/return`).send({ actualReturnDate: end })).body.error.code).toBe('fitness_for_duty_missing');
    const back = await a.post(`/leave/cases/${id}/return`).send({ actualReturnDate: end, overrideReason: 'Provider note read by phone; copy to follow.' });
    expect(back.body.case.status).toBe('RETURNED');
    const detail = await a.get(`/leave/cases/${id}`);
    expect(detail.body.balance.usedHours).toBeGreaterThan(0);
  });

  it('medical documents: leave admins only, every read audited; the worker never sees HR’s uploads', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const vera = await veteranWorker(site.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: vera.id });
    const a = await loginAs(hr.email);
    const id = (await a.post('/leave/cases').send({ associateId: vera.id, type: 'ADA_ACCOMMODATION', reason: 'ACCOMMODATION', schedule: 'REDUCED', startDate: ymd(new Date()), reducedHoursPerWeek: 20 })).body.case.id;
    const up = await a.post(`/leave/cases/${id}/documents`).field('kind', 'MEDICAL_CERTIFICATION').attach('file', PDF, { filename: 'doctor.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const docId = up.body.id as string;

    const o = await loginAs(ops.email);
    expect((await o.get(`/leave/documents/${docId}`)).status).toBe(403);
    expect((await o.get('/leave/cases')).status).toBe(403);
    const read = await a.get(`/leave/documents/${docId}`);
    expect(read.status).toBe(200);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'leave.document_read', entityId: docId } })).toBe(1);

    const w = await loginAs(worker.email);
    expect((await w.get('/me/leave')).body.cases[0].documents).toEqual([]);
  });

  it('the worker requests their own leave; intermittent usage counts against FMLA', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const vera = await veteranWorker(site.id);
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: vera.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const w = await loginAs(worker.email);
    const req = await w.post('/me/leave').send({ type: 'FMLA', reason: 'FAMILY_CARE', schedule: 'INTERMITTENT', startDate: ymd(new Date(Date.now() - 2 * DAY)), endDate: ymd(new Date(Date.now() + 90 * DAY)), intermittentPattern: 'Up to 2 days a month' });
    expect(req.status).toBe(201);
    const a = await loginAs(hr.email);
    const list = await a.get('/leave/cases');
    expect(list.body.cases[0]).toMatchObject({ requestedBySelf: true, schedule: 'INTERMITTENT' });
    const id = list.body.cases[0].id;
    await a.post(`/leave/cases/${id}/decide`).send({ decision: 'APPROVE' });
    const used = await a.post(`/leave/cases/${id}/usage`).send({ date: ymd(new Date(Date.now() - DAY)), hours: 8 });
    expect(used.status).toBe(201);
    expect(used.body.case.usedHours).toBe(8);
    expect((await a.get(`/leave/cases/${id}`)).body.balance.usedHours).toBe(8);
    expect((await a.get('/me/inbox')).body.sources.map((s: { key: string }) => s.key)).toContain('leave-desk');
  });

  it('a site-bound leave admin can’t open a case at another site', async () => {
    const north = await createClient('North');
    const south = await createClient('South');
    const northSite = await prisma.site.findFirstOrThrow({ where: { clientId: north.id } });
    const southSite = await prisma.site.findFirstOrThrow({ where: { clientId: south.id } });
    const sam = await veteranWorker(southSite.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: hr.id }, data: { scopeSiteIds: [northSite.id] } });
    const a = await loginAs(hr.email);
    expect((await a.post('/leave/cases').send({ associateId: sam.id, type: 'PERSONAL', reason: 'OTHER', startDate: ymd(new Date()) })).status).toBe(404);
  });
});

describe('unemployment claims', () => {
  it('argues from the record: separation, warnings, declined work; the response, the outcome, the tax impact', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const kai = await createAssociate({ firstName: 'Kai', lastName: 'Gone' });
    const last = new Date(Date.now() - 20 * DAY);
    await prisma.associateAssignment.create({ data: { associateId: kai.id, locationId: site.id, startedAt: new Date(Date.now() - 200 * DAY), endedAt: last, reason: 'Assignment ended' } });
    await prisma.separation.create({ data: { associateId: kai.id, reason: 'INVOLUNTARY_MISCONDUCT', lastDayWorked: last, status: 'COMPLETE' } });
    await prisma.disciplinaryAction.create({ data: { associateId: kai.id, kind: 'WRITTEN_WARNING', incidentDate: new Date(Date.now() - 60 * DAY), effectiveDate: new Date(Date.now() - 60 * DAY), description: 'Left the register unattended.' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    expect((await a.post('/claims/work-offers').send({ associateId: kai.id, offeredAt: new Date(Date.now() - 10 * DAY).toISOString(), description: 'Stocker, nights', response: 'DECLINED' })).status).toBe(400);
    expect((await a.post('/claims/work-offers').send({ associateId: kai.id, offeredAt: new Date(Date.now() - 10 * DAY).toISOString(), description: 'Stocker, nights', payRate: 16, response: 'DECLINED', declineReason: 'Wants days only' })).status).toBe(201);

    const notice = ymd(new Date(Date.now() - 2 * DAY));
    const opened = await a.post('/claims/unemployment').send({ associateId: kai.id, state: 'fl', claimDate: notice, noticeReceivedAt: notice });
    expect(opened.status).toBe(201);
    expect(opened.body.claim).toMatchObject({ state: 'FL', clientName: 'Coastal', status: 'NEW', responseDueAt: ymd(new Date(new Date(`${notice}T00:00:00Z`).getTime() + 10 * DAY)) });
    const id = opened.body.claim.id;

    const detail = await a.get(`/claims/unemployment/${id}`);
    expect(detail.body.evidence.separation.reasonLabel).toBe('Discharged — misconduct');
    expect(detail.body.evidence.discipline).toHaveLength(1);
    expect(detail.body.evidence.workOffers[0]).toMatchObject({ response: 'DECLINED', declineReason: 'Wants days only' });
    expect(detail.body.evidence.posture.kind).toBe('strong');

    const pdf = await a.get(`/claims/unemployment/${id}/packet.pdf`);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect((await a.post(`/claims/unemployment/${id}/respond`).send({ decision: 'CONTEST', reason: 'Discharged after a written warning; declined suitable work.' })).body.claim.status).toBe('RESPONDED');
    expect((await a.patch(`/claims/unemployment/${id}`).send({ determination: 'DENIED', determinationAt: ymd(new Date()) })).body.claim).toMatchObject({ status: 'DETERMINED', outcome: 'DENIED' });

    // A second claim the state allowed, with charges.
    const lee = await createAssociate({ firstName: 'Lee', lastName: 'Laid' });
    const c2 = (await a.post('/claims/unemployment').send({ associateId: lee.id, state: 'FL', claimDate: notice, noticeReceivedAt: notice })).body.claim.id;
    await a.post(`/claims/unemployment/${c2}/respond`).send({ decision: 'DO_NOT_CONTEST', reason: 'Laid off for lack of work.' });
    await a.patch(`/claims/unemployment/${c2}`).send({ determination: 'ALLOWED', chargesAmount: 1000 });

    const summary = await a.get('/claims/unemployment/summary');
    expect(summary.body).toMatchObject({ winRate: 100, contestedDecided: 1, estimatedSuiImpact: 1000 });
    expect(summary.body.byClient[0]).toMatchObject({ clientName: 'Coastal' });
  });

  it('is HR’s alone', async () => {
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(fin.email);
    expect((await f.get('/claims/unemployment')).status).toBe(403);
    expect((await f.get('/claims/workers-comp')).status).toBe(403);
  });
});

describe('workers’ comp claims', () => {
  it('from the incident: FROI prefilled and due by the state window, days synced to OSHA, modified duty matched and taken', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { state: 'CA' } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Hurt' });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date(Date.now() - 100 * DAY) } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const occurred = new Date(Date.now() - DAY);
    const incident = await prisma.oshaIncident.create({ data: { clientId: client.id, locationId: site.id, associateId: ana.id, occurredAt: occurred, description: 'Strained back lifting a case.', bodyPart: 'Lower back', severity: 'MEDICAL_TREATMENT' } });
    const a = await loginAs(hr.email);

    const pending = await a.get('/claims/workers-comp/incidents');
    expect(pending.body.incidents.map((i: { id: string }) => i.id)).toContain(incident.id);

    const opened = await a.post('/claims/workers-comp').send({ oshaIncidentId: incident.id });
    expect(opened.status).toBe(201);
    const claim = opened.body.claim;
    expect(claim).toMatchObject({ jurisdiction: 'CA', status: 'OPEN', next: { key: 'froi' } });
    expect(claim.froi.employee.name).toBe('Ana Hurt');
    expect(claim.froi.injury.bodyPart).toBe('Lower back');
    const reported = new Date(`${claim.reportedToEmployerAt}T00:00:00Z`);
    expect(claim.froiDueAt).toBe(ymd(new Date(reported.getTime() + 5 * DAY)));
    expect((await a.post('/claims/workers-comp').send({ oshaIncidentId: incident.id })).status).toBe(409);

    const patched = await a.patch(`/claims/workers-comp/${claim.id}`).send({ lostTimeDays: 4, restrictedDays: 6, restrictionRules: { maxHoursPerShift: 4, positions: ['Greeter'] }, froi: { injury: { witnesses: 'Dana Reyes' } } });
    expect(patched.body.claim).toMatchObject({ lostTimeDays: 4, claimType: 'INDEMNITY' });
    expect(patched.body.claim.froi.injury.witnesses).toBe('Dana Reyes');
    expect(await prisma.oshaIncident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({ daysAway: 4, daysRestricted: 6, severity: 'DAYS_AWAY' });

    const pdf = await a.get(`/claims/workers-comp/${claim.id}/froi.pdf`);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect((await a.post(`/claims/workers-comp/${claim.id}/submit`).send({ carrierName: 'Acme Mutual', carrierClaimNumber: 'WC-123' })).body.claim).toMatchObject({ status: 'SUBMITTED', carrierClaimNumber: 'WC-123' });

    const soon = new Date(Date.now() + 2 * DAY);
    const fits = await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Greeter', startsAt: soon, endsAt: new Date(soon.getTime() + 4 * 3_600_000), status: 'OPEN' } });
    await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Greeter', startsAt: soon, endsAt: new Date(soon.getTime() + 8 * 3_600_000), status: 'OPEN' } });
    await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Stocker', startsAt: soon, endsAt: new Date(soon.getTime() + 4 * 3_600_000), status: 'OPEN' } });
    const matches = await a.get(`/claims/workers-comp/${claim.id}/duty-matches`);
    expect(matches.body.shifts.map((s: { id: string }) => s.id)).toEqual([fits.id]);

    const offered = await a.post(`/claims/workers-comp/${claim.id}/duty-offers`).send({ shiftId: fits.id, description: 'Greeter, 4 hours, seated.' });
    expect(offered.status).toBe(201);
    const offerId = offered.body.claim.dutyOffers[0].id;
    const took = await a.patch(`/claims/workers-comp/${claim.id}/duty-offers/${offerId}`).send({ response: 'ACCEPTED' });
    expect(took.status).toBe(200);
    expect(await prisma.shift.findUniqueOrThrow({ where: { id: fits.id } })).toMatchObject({ status: 'ASSIGNED', assignedAssociateId: ana.id });
    await flushPendingNotifications();

    const summary = await a.get('/claims/workers-comp/summary');
    expect(summary.body).toMatchObject({ open: 1, froiDue: 0, lostTimeDaysOpen: 4 });
  });
});
