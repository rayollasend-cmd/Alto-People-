import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createStandardTemplate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { isNewHireForPay } from '../../lib/hirePay.js';

/**
 * The recruiter sets a new hire's starting wage and pay schedule (owner,
 * 2026-10-23), with least privilege: `set:hire-pay`, never view:comp,
 * manage:comp or process:payroll.
 *
 *   Today is Monday Oct 19, 2026. A new hire for pay is onboarding or hired
 *   in the last 30 days, never paid on a run, with no pay record but the
 *   starting one. Inside that window the recruiter sets and corrects the
 *   starting pay and reads it; at or below the position's ceiling (band
 *   max or rate card pay, the lower) it lands at once, above it a
 *   compensation approver decides (202). Outside the window: 403, in words.
 */

const NOW = new Date('2026-10-19T15:00:00.000Z');
const T2 = '22222222-2222-4222-8222-222222222222';
type Agent = TestAgent<Test>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await truncateAll();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const tag = () => Math.random().toString(36).slice(2, 8);
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

async function seed() {
  const coastal = await createClient('Coastal Resort');
  // Housekeepers at Coastal start at $16.50 (bill $24.00, which no one here reads).
  await prisma.shiftRateDefault.create({ data: { clientId: coastal.id, position: 'Housekeeper', payRate: 16.5, billRate: 24, effectiveFrom: d('2026-01-01') } });
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR', email: `hr-${tag()}@example.com` });
  const { user: recUser } = await createUser({ role: 'INTERNAL_RECRUITER', email: `rec-${tag()}@example.com` });
  const hr = await loginAs(agent(), hrUser.email);
  const rec = await loginAs(agent(), recUser.email);
  return { coastal, hrUser, recUser, hr, rec };
}

/** Someone onboarding: an application in review, starting Monday the 26th. */
async function onboardingHire(clientId: string, position = 'Housekeeper', firstName = 'Ana') {
  const p = await createAssociate({ firstName, lastName: 'Reyes' });
  await prisma.application.create({ data: { associateId: p.id, clientId, onboardingTrack: 'STANDARD', status: 'IN_REVIEW', position, startDate: d('2026-10-26') } });
  return p;
}

/** Someone approved and hired on `hiredOn`. */
async function hiredOn(clientId: string, hired: string, firstName = 'Bo') {
  const p = await createAssociate({ firstName, lastName: 'Hale' });
  await prisma.associate.update({ where: { id: p.id }, data: { hireDate: d(hired) } });
  await prisma.application.create({ data: { associateId: p.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: d(hired), position: 'Housekeeper', startDate: d(hired) } });
  await prisma.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: d(hired), payType: 'HOURLY', amount: 15, reason: 'HIRE' } });
  return p;
}

async function paidOnARun(associateId: string, clientId: string) {
  const run = await prisma.payrollRun.create({ data: { clientId, periodStart: d('2026-10-03'), periodEnd: d('2026-10-16'), status: 'DISBURSED', finalizedAt: NOW } });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId, hoursWorked: 30, hourlyRate: 15, grossPay: 450, federalWithholding: 0, netPay: 450 } });
}

const open = (associateId: string) => prisma.compensationRecord.findFirstOrThrow({ where: { associateId, effectiveTo: null } });

describe('the starting pay, inside the new-hire window', () => {
  it('reads the card: new hire, start date, the rate card prefill and the ceiling — and nothing of the bill rate', async () => {
    const s = await seed();
    const ana = await onboardingHire(s.coastal.id);
    const r = await s.rec.get(`/comp/associates/${ana.id}/hire-pay`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      newHire: true,
      why: 'NEW_HIRE',
      message: null,
      canSet: true,
      compAccess: false,
      startDate: '2026-10-26',
      client: { id: s.coastal.id, name: 'Coastal Resort' },
      position: 'Housekeeper',
      current: null,
      suggested: { payType: 'HOURLY', amount: '16.50', source: 'RATE_CARD' },
      ceilings: { HOURLY: { amount: '16.50', source: 'RATE_CARD', label: "the rate card's pay for Housekeeper at Coastal Resort" }, SALARY: null },
      pending: null,
    });
    expect(JSON.stringify(r.body)).not.toContain('24.00');
    expect(await isNewHireForPay(ana.id)).toBe(true);
  });

  it('sets the starting pay from the start date (201), corrects it, and reads the records — every write audited', async () => {
    const s = await seed();
    const ana = await onboardingHire(s.coastal.id);
    const set = await s.rec.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'HIRE' });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    const first = await open(ana.id);
    expect({ amount: Number(first.amount), reason: first.reason, from: first.effectiveFrom.toISOString().slice(0, 10), by: first.actorUserId }).toEqual({
      amount: 16,
      reason: 'HIRE',
      from: '2026-10-26',
      by: s.recUser.id,
    });

    // A correction inside the window: the first figure stays as history.
    const fix = await s.rec.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 16.5, reason: 'HIRE', effectiveFrom: '2026-10-26' });
    expect(fix.status).toBe(201);
    expect(Number((await open(ana.id)).amount)).toBe(16.5);
    const all = await prisma.compensationRecord.findMany({ where: { associateId: ana.id } });
    expect(all.map((x) => x.reason)).toEqual(['HIRE', 'HIRE']);
    // Still a new hire: nothing but starting pay on file.
    expect(await isNewHireForPay(ana.id)).toBe(true);

    const records = await s.rec.get(`/comp/associates/${ana.id}/records`);
    expect(records.status).toBe(200);
    expect(records.body.records.map((x: { amount: string }) => x.amount).sort()).toEqual(['16.00', '16.50']);
    expect((await s.rec.get(`/comp/associates/${ana.id}/current`)).body.record).toMatchObject({ amount: '16.50', reason: 'HIRE' });

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { action: 'pay.rate_changed' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((x) => (x.metadata as { note: string | null }).note)).toEqual(['Starting pay set with hire access.', 'Starting pay corrected with hire access.']);
    expect(audits.every((x) => x.actorUserId === s.recUser.id)).toBe(true);
  });

  it('above the rate card the wage waits on a compensation approver (202); at the ceiling it lands at once', async () => {
    const s = await seed();
    const ana = await onboardingHire(s.coastal.id);
    expect((await s.rec.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 16.5, reason: 'HIRE' })).status).toBe(201);

    const above = await s.rec.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 18, reason: 'HIRE' });
    expect(above.status, JSON.stringify(above.body)).toBe(202);
    expect(above.body).toMatchObject({ pending: true, title: 'Ana Reyes: starting pay $18.00 per hour' });
    const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: above.body.approvalId } });
    expect(req).toMatchObject({ kind: 'PAY_RATE_CHANGE', status: 'PENDING', approverCapability: 'manage:comp', requesterUserId: s.recUser.id, associateId: ana.id });
    expect(req.summary).toContain("above the rate card's pay for Housekeeper at Coastal Resort ($16.50)");
    expect(Number((await open(ana.id)).amount)).toBe(16.5);
    // The card says it is waiting; a second try waits its turn.
    expect((await s.rec.get(`/comp/associates/${ana.id}/hire-pay`)).body.pending).toMatchObject({ id: req.id, amount: '18.00', payType: 'HOURLY', effectiveFrom: '2026-10-26' });
    expect((await s.rec.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 17, reason: 'HIRE' })).status).toBe(409);
    // The recruiter cannot decide it; HR can, and it lands under HR's name, still the starting pay.
    expect((await s.rec.post(`/approvals/requests/${req.id}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    expect((await s.hr.post(`/approvals/requests/${req.id}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const now = await open(ana.id);
    expect({ amount: Number(now.amount), reason: now.reason, by: now.actorUserId }).toEqual({ amount: 18, reason: 'HIRE', by: s.hrUser.id });
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'pay.hire_pay_requested', entityId: ana.id } })).toBe(1);
  });

  it('the ceiling is the band maximum where there is no card, the lower of the two where both exist, and nothing on file goes to a second person', async () => {
    const s = await seed();
    const bay = await createClient('Bay Group');
    await prisma.compBand.create({ data: { clientId: bay.id, name: 'Front desk', payType: 'HOURLY', minAmount: 13, midAmount: 14, maxAmount: 15, effectiveFrom: d('2026-01-01') } });
    await prisma.compBand.create({ data: { clientId: bay.id, name: 'Managers', payType: 'SALARY', minAmount: 40000, midAmount: 45000, maxAmount: 52000, effectiveFrom: d('2026-01-01') } });
    const cy = await onboardingHire(bay.id, 'Front desk', 'Cy');
    expect((await s.rec.get(`/comp/associates/${cy.id}/hire-pay`)).body.ceilings).toMatchObject({
      HOURLY: { amount: '15.00', source: 'BAND', label: 'the top of the Front desk pay band' },
      SALARY: { amount: '52000.00', source: 'BAND' },
    });
    expect((await s.rec.post(`/comp/associates/${cy.id}/records`).send({ payType: 'HOURLY', amount: 15, reason: 'HIRE' })).status).toBe(201);
    expect((await s.rec.post(`/comp/associates/${cy.id}/records`).send({ payType: 'HOURLY', amount: 15.01, reason: 'HIRE' })).status).toBe(202);

    // Both on file: Coastal's housekeeper band tops out at $17.25, the card pays $16.50 — the card holds.
    await prisma.compBand.create({ data: { clientId: s.coastal.id, name: 'Housekeeping', payType: 'HOURLY', minAmount: 14, midAmount: 15.5, maxAmount: 17.25, effectiveFrom: d('2026-01-01') } });
    const ana = await onboardingHire(s.coastal.id);
    expect((await s.rec.get(`/comp/associates/${ana.id}/hire-pay`)).body.ceilings.HOURLY).toMatchObject({ amount: '16.50', source: 'RATE_CARD' });
    expect((await s.rec.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 17, reason: 'HIRE' })).status).toBe(202);

    // Nothing to hold the wage against: a compensation approver decides.
    const harbor = await createClient('Harbor Grill');
    const dee = await onboardingHire(harbor.id, 'Line cook', 'Dee');
    const none = await s.rec.post(`/comp/associates/${dee.id}/records`).send({ payType: 'HOURLY', amount: 14, reason: 'HIRE' });
    expect(none.status).toBe(202);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: none.body.approvalId } })).summary).toContain('no pay band or rate card for Line cook');
  });

  it('a hire approved within 30 days and not yet paid is still a new hire', async () => {
    const s = await seed();
    const bo = await hiredOn(s.coastal.id, '2026-10-05');
    expect((await s.rec.get(`/comp/associates/${bo.id}/hire-pay`)).body).toMatchObject({ newHire: true, current: { amount: '15.00', reason: 'HIRE' } });
    expect((await s.rec.post(`/comp/associates/${bo.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'HIRE', effectiveFrom: '2026-10-05' })).status).toBe(201);
  });
});

describe('outside the window it is a pay change, and pay changes are not the recruiter’s', () => {
  it('a long-tenured associate: 403 in words on write and read, and the card carries no pay', async () => {
    const s = await seed();
    const old = await hiredOn(s.coastal.id, '2025-03-01', 'Eli');
    const w = await s.rec.post(`/comp/associates/${old.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'HIRE' });
    expect(w.status).toBe(403);
    expect(w.body.error).toMatchObject({ code: 'not_new_hire', message: 'Eli Hale was hired more than 30 days ago. This is a pay change now — someone with compensation access makes it.' });
    expect((await s.rec.get(`/comp/associates/${old.id}/records`)).status).toBe(403);
    expect((await s.rec.get(`/comp/associates/${old.id}/current`)).status).toBe(403);
    const card = await s.rec.get(`/comp/associates/${old.id}/hire-pay`);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ newHire: false, why: 'NOT_NEW_HIRE', canSet: false });
    expect('current' in card.body).toBe(false);
    expect(card.body.pending).toBeNull();
    expect(JSON.stringify(card.body)).not.toContain('15.00');
    expect(Number((await open(old.id)).amount)).toBe(15);
  });

  it('someone already paid on a run, or with a pay change since hire, is outside it', async () => {
    const s = await seed();
    const paid = await hiredOn(s.coastal.id, '2026-10-05', 'Fay');
    await paidOnARun(paid.id, s.coastal.id);
    const r = await s.rec.post(`/comp/associates/${paid.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'HIRE' });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('Fay Hale has been paid on a payroll run. This is a pay change now — someone with compensation access makes it.');
    expect((await s.rec.get(`/comp/associates/${paid.id}/records`)).status).toBe(403);

    const raised = await hiredOn(s.coastal.id, '2026-10-05', 'Gus');
    await prisma.compensationRecord.updateMany({ where: { associateId: raised.id }, data: { effectiveTo: d('2026-10-12') } });
    await prisma.compensationRecord.create({ data: { associateId: raised.id, effectiveFrom: d('2026-10-12'), payType: 'HOURLY', amount: 15.5, reason: 'MARKET_ADJUSTMENT' } });
    const g = await s.rec.post(`/comp/associates/${raised.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'HIRE' });
    expect(g.status).toBe(403);
    expect(g.body.error.message).toContain('pay has changed since their starting pay');
    expect(await isNewHireForPay(raised.id)).toBe(false);
  });

  it('only the starting pay: a merit or correction reason is refused even for a new hire', async () => {
    const s = await seed();
    const ana = await onboardingHire(s.coastal.id);
    const r = await s.rec.post(`/comp/associates/${ana.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'MERIT' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('hire_pay_only');
    expect(await prisma.compensationRecord.count()).toBe(0);
  });
});

describe('reach and tenancy', () => {
  it('another tenant’s new hire does not exist for the recruiter', async () => {
    const s = await seed();
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'hire-pay-two', name: 'Two' }, update: {} });
    const foreignClient = await createClient('Elsewhere');
    await prisma.client.update({ where: { id: foreignClient.id }, data: { tenantId: T2 } });
    const foreign = await onboardingHire(foreignClient.id, 'Housekeeper', 'Ivy');
    await prisma.associate.update({ where: { id: foreign.id }, data: { tenantId: T2 } });
    await prisma.application.updateMany({ where: { associateId: foreign.id }, data: { tenantId: T2 } });
    expect((await s.rec.get(`/comp/associates/${foreign.id}/hire-pay`)).status).toBe(404);
    expect((await s.rec.get(`/comp/associates/${foreign.id}/records`)).status).toBe(404);
    expect((await s.rec.post(`/comp/associates/${foreign.id}/records`).send({ payType: 'HOURLY', amount: 10, reason: 'HIRE' })).status).toBe(404);
    expect((await s.rec.get(`/associates/${foreign.id}/pay-schedule`)).status).toBe(404);
    expect((await s.rec.get(`/org/associates/${foreign.id}/employment`)).status).toBe(404);
    expect(await prisma.compensationRecord.count()).toBe(0);
  });

  it('a recruiter bound to one store reaches that store’s new hires only', async () => {
    const s = await seed();
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: s.coastal.id } });
    const south = await prisma.site.create({ data: { name: 'South', clientId: s.coastal.id, timezone: 'America/New_York' } });
    const atNorth = await hiredOn(s.coastal.id, '2026-10-05', 'Jo');
    const atSouth = await hiredOn(s.coastal.id, '2026-10-05', 'Kai');
    await prisma.associateAssignment.create({ data: { associateId: atNorth.id, locationId: north.id, startedAt: d('2026-10-05') } });
    await prisma.associateAssignment.create({ data: { associateId: atSouth.id, locationId: south.id, startedAt: d('2026-10-05') } });
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER', email: `north-${tag()}@example.com` });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [north.id] } });
    const bound = await loginAs(agent(), user.email);
    expect((await bound.get(`/comp/associates/${atNorth.id}/hire-pay`)).status).toBe(200);
    expect((await bound.post(`/comp/associates/${atNorth.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'HIRE' })).status).toBe(201);
    expect((await bound.get(`/comp/associates/${atSouth.id}/hire-pay`)).status).toBe(404);
    expect((await bound.post(`/comp/associates/${atSouth.id}/records`).send({ payType: 'HOURLY', amount: 16, reason: 'HIRE' })).status).toBe(404);
    expect((await bound.get(`/org/associates/${atSouth.id}/employment`)).status).toBe(404);
    expect((await bound.get(`/org/associates/${atNorth.id}/employment`)).status).toBe(200);
  });
});

describe('the pay schedule and the employment record', () => {
  async function schedules(hr: Agent) {
    const weekly = await hr.post('/payroll/pay-schedules').send({ name: 'Weekly', frequency: 'WEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 7 });
    expect(weekly.status).toBe(201);
    const off = await hr.post('/payroll/pay-schedules').send({ name: 'Retired', frequency: 'BIWEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 7 });
    await hr.patch(`/payroll/pay-schedules/${off.body.schedule.id}`).send({ isActive: false });
    return weekly.body.schedule as { id: string };
  }

  it('the recruiter lists the choices, sets a new hire’s schedule on the existing path, and sees who is a new hire', async () => {
    const s = await seed();
    const weekly = await schedules(s.hr);
    const ana = await onboardingHire(s.coastal.id);
    const old = await hiredOn(s.coastal.id, '2025-03-01', 'Eli');

    // The schedule list itself is payroll's.
    expect((await s.rec.get('/payroll/pay-schedules')).status).toBe(403);
    const choices = await s.rec.get(`/associates/${ana.id}/pay-schedule/choices`);
    expect(choices.status, JSON.stringify(choices.body)).toBe(200);
    expect(choices.body.schedules).toEqual([
      {
        id: weekly.id,
        name: 'Weekly',
        pattern: expect.any(String),
        isActive: true,
        isDefault: false,
        nextPeriod: { periodStart: '2026-10-10', periodEnd: '2026-10-16', payDate: '2026-10-23' },
        firstStart: '2026-10-24',
      },
    ]);

    const before = await s.rec.get(`/associates/${ana.id}/pay-schedule`);
    expect(before.status).toBe(200);
    expect(before.body.newHire).toBe(true);
    expect((await s.rec.get(`/associates/${old.id}/pay-schedule`)).body.newHire).toBe(false);

    const put = await s.rec.put(`/associates/${ana.id}/pay-schedule`).send({ scheduleId: weekly.id });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.newHire).toBe(true);
    // Through the rules engine: an INDIVIDUAL rule and its assignment, never Associate.payrollScheduleId by hand.
    const rule = await prisma.payrollScheduleRule.findFirstOrThrow({ where: { associateId: ana.id } });
    expect(rule).toMatchObject({ kind: 'INDIVIDUAL', scheduleId: weekly.id });
    expect(await prisma.payrollScheduleAssignment.count({ where: { associateId: ana.id, scheduleId: weekly.id } })).toBe(1);
    expect(put.body.current?.scheduleId ?? put.body.pending?.scheduleId).toBe(weekly.id);

    // Anyone else's schedule is payroll's, on the server too — not only the screen.
    const moved = await s.rec.put(`/associates/${old.id}/pay-schedule`).send({ scheduleId: weekly.id });
    expect(moved.status).toBe(403);
    expect(moved.body.error).toMatchObject({ code: 'not_a_new_hire' });
    expect(await prisma.payrollScheduleRule.count({ where: { associateId: old.id } })).toBe(0);
  });

  it('the recruiter reads a person’s employment record', async () => {
    const s = await seed();
    const bo = await hiredOn(s.coastal.id, '2026-10-05');
    const r = await s.rec.get(`/org/associates/${bo.id}/employment`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.employment)).toBe(true);
  });
});

describe('a hire from recruiting carries the accepted offer’s pay', () => {
  it('the recruiter hires a candidate on an accepted offer and the starting pay is recorded', async () => {
    const s = await seed();
    const template = await createStandardTemplate();
    const c = await s.rec.post('/recruiting/candidates').send({ firstName: 'Lu', lastName: 'Park', email: `lu-${tag()}@example.com` });
    expect(c.status).toBe(201);
    const offer = await s.rec.post('/offers').send({ candidateId: c.body.id, clientId: s.coastal.id, jobTitle: 'Housekeeper', startDate: '2026-10-26', hourlyRate: 16.25 });
    expect(offer.status, JSON.stringify(offer.body)).toBe(201);
    expect((await s.rec.post(`/offers/${offer.body.id}/send`)).status).toBe(200);
    expect((await s.rec.post(`/offers/${offer.body.id}/decision`).send({ decision: 'ACCEPTED' })).status).toBe(200);
    const hire = await s.rec.post(`/recruiting/candidates/${c.body.id}/hire`).send({ clientId: s.coastal.id, templateId: template.id, offerId: offer.body.id, position: 'Housekeeper', startDate: '2026-10-26T00:00:00.000Z' });
    expect(hire.status, JSON.stringify(hire.body)).toBe(200);
    expect(hire.body.payRecorded).toBe(true);
    const pay = await open(hire.body.hiredAssociateId);
    expect({ amount: Number(pay.amount), reason: pay.reason }).toEqual({ amount: 16.25, reason: 'HIRE' });
    // And the card prefills from the offer.
    expect((await s.rec.get(`/comp/associates/${hire.body.hiredAssociateId}/hire-pay`)).body.suggested).toMatchObject({ source: 'OFFER', amount: '16.25', payType: 'HOURLY' });
  });
});
