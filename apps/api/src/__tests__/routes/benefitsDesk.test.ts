import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Benefits for both sides (F500 G6):
 *   - GET /benefits/plans/mine: the plans an associate can elect, from where
 *     they work — the page no longer needs /scheduling/clients (a 403 for
 *     associates, so they never saw a plan).
 *   - GET /benefits/overview: the desk for HR and finance — plans by client,
 *     who's enrolled, per-pay-period contributions, life events and COBRA
 *     waiting, carrier feeds — in the caller's reach, never an associate's.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const coastal = await createClient('Coastal Resort');
  const harbor = await createClient('Harbor Grill');
  const coastalSite = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
  const harborSite = await prisma.site.findFirstOrThrow({ where: { clientId: harbor.id } });
  const ppo = await prisma.benefitsPlan.create({ data: { clientId: coastal.id, kind: 'HEALTH_MEDICAL', name: 'PPO 500', employeeContributionDefaultCentsPerPeriod: 4500, employerContributionCentsPerPeriod: 12000 } });
  const dental = await prisma.benefitsPlan.create({ data: { clientId: coastal.id, kind: 'DENTAL', name: 'Dental basic', employeeContributionDefaultCentsPerPeriod: 800 } });
  await prisma.benefitsPlan.create({ data: { clientId: coastal.id, kind: 'VISION', name: 'Old vision', isActive: false } });
  const harborPlan = await prisma.benefitsPlan.create({ data: { clientId: harbor.id, kind: 'HEALTH_MEDICAL', name: 'Harbor HMO', employerContributionCentsPerPeriod: 5000 } });
  const person = async (first: string, clientId: string, siteId: string) => {
    const a = await createAssociate({ firstName: first, lastName: 'Lee' });
    await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date('2025-01-02'), startDate: new Date('2025-01-02') } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date('2025-01-02') } });
    return a;
  };
  const ana = await person('Ana', coastal.id, coastalSite.id);
  const ben = await person('Ben', coastal.id, coastalSite.id);
  const cal = await person('Cal', harbor.id, harborSite.id);
  const enroll = (associateId: string, planId: string, cents: number, terminationDate: Date | null = null) =>
    prisma.benefitsEnrollment.create({ data: { associateId, planId, electedAmountCentsPerPeriod: cents, effectiveDate: new Date('2026-01-01'), terminationDate } });
  await enroll(ana.id, ppo.id, 4500);
  await enroll(ben.id, ppo.id, 6000);
  await enroll(ana.id, dental.id, 800);
  // Ended last year: not enrolled now.
  await prisma.benefitsEnrollment.create({ data: { associateId: ben.id, planId: dental.id, electedAmountCentsPerPeriod: 800, effectiveDate: new Date('2025-01-01'), terminationDate: new Date('2025-12-31') } });
  await enroll(cal.id, harborPlan.id, 2500);
  await prisma.qualifyingLifeEvent.create({ data: { associateId: ana.id, kind: 'BIRTH', eventDate: new Date('2026-10-01'), allowedUntil: new Date('2099-10-31') } });
  await prisma.qualifyingLifeEvent.create({ data: { associateId: cal.id, kind: 'MARRIAGE', eventDate: new Date('2026-10-01'), allowedUntil: new Date('2099-10-31') } });
  await prisma.qualifyingLifeEvent.create({ data: { associateId: ben.id, kind: 'MARRIAGE', eventDate: new Date('2026-09-01'), allowedUntil: new Date('2099-10-31'), status: 'APPROVED' } });
  await prisma.cobraOffer.create({ data: { associateId: ben.id, qualifyingEvent: 'TERMINATION', qeDate: new Date('2026-10-01'), electionDeadline: new Date('2099-12-01'), coverageEndsOn: new Date('2099-04-01') } });
  return { coastal, harbor, coastalSite, harborSite, ppo, dental, harborPlan, ana, ben, cal };
}

describe('GET /benefits/plans/mine', () => {
  it('offers the active plans of the client the associate works at now — an open assignment beats an older application', async () => {
    const w = await world();
    // Cal applied to Coastal long ago but works at Harbor today.
    await prisma.application.create({ data: { associateId: w.cal.id, clientId: w.coastal.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date('2024-01-02'), startDate: new Date('2024-01-02') } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: w.cal.id });
    const a = await loginAs(agent(), user.email);
    const r = await a.get('/benefits/plans/mine');
    expect(r.status).toBe(200);
    expect(r.body.client).toEqual({ id: w.harbor.id, name: 'Harbor Grill' });
    expect(r.body.plans.map((p: { name: string }) => p.name)).toEqual(['Harbor HMO']);
    // Enrolling follows the same rule: Coastal's plan isn't his to elect.
    const wrong = await a.post('/benefits/me/enrollments').send({ planId: w.ppo.id, electedAmountCentsPerPeriod: 4500, effectiveDate: '2026-11-01' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('plan_not_offered');
  });

  it('an associate placed nowhere gets no client and no plans; inactive plans are never offered', async () => {
    const w = await world();
    const lone = await createAssociate({ firstName: 'Dee' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: lone.id });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/benefits/plans/mine')).body).toEqual({ client: null, plans: [] });
    const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: w.ana.id });
    const b = await loginAs(agent(), anaUser.email);
    expect((await b.get('/benefits/plans/mine')).body.plans.map((p: { name: string }) => p.name).sort()).toEqual(['Dental basic', 'PPO 500']);
  });
});

describe('GET /benefits/overview', () => {
  it('counts who is enrolled and what goes in each pay period, by client, with life events and COBRA waiting', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    const r = await a.get('/benefits/overview');
    expect(r.status).toBe(200);
    // Active plans: PPO, dental, Harbor HMO (the retired vision plan isn't one).
    // Enrolled people: Ana, Ben, Cal. Employees put in 45 + 60 + 8 + 25 = $138.00 a period;
    // the company 2 × $120 (PPO) + 1 × $50 (HMO) = $290.00.
    expect(r.body.totals).toEqual({ activePlans: 3, enrolledPeople: 3, employeeCentsPerPeriod: 13800, employerCentsPerPeriod: 29000, lifeEventsWaiting: 2, cobraPending: 1 });
    const coastal = r.body.clients.find((c: { clientId: string }) => c.clientId === w.coastal.id);
    expect(coastal.plans.find((p: { id: string }) => p.id === w.ppo.id)).toMatchObject({ enrolled: 2, employeeCentsPerPeriod: 10500, employerCentsPerPeriod: 24000 });
    // Ben's dental ended last year: one enrolled, not two.
    expect(coastal.plans.find((p: { id: string }) => p.id === w.dental.id)).toMatchObject({ enrolled: 1, employeeCentsPerPeriod: 800 });
    expect(r.body.carriers).toEqual([]);
  });

  it('a finance account narrowed to one store sees that client only', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [w.harborSite.id] } });
    const a = await loginAs(agent(), user.email);
    const r = await a.get('/benefits/overview');
    expect(r.status).toBe(200);
    expect(r.body.clients.map((c: { clientName: string }) => c.clientName)).toEqual(['Harbor Grill']);
    expect(r.body.totals).toMatchObject({ activePlans: 1, enrolledPeople: 1, employeeCentsPerPeriod: 2500, lifeEventsWaiting: 1, cobraPending: 0 });
    expect(JSON.stringify(r.body)).not.toContain('PPO 500');
  });

  it('is the desk’s, not an associate’s', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: w.ana.id });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/benefits/overview')).status).toBe(403);
  });
});
