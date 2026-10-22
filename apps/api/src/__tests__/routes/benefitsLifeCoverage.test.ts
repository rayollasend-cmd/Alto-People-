import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { encryptString } from '../../lib/crypto.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Group-term life (wave 2): the enrollment route and screen take the
 * coverage face amount, validated, and the next payroll run imputes the
 * Table I cost of the part over $50,000.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const job = <T>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

async function world() {
  const client = await createClient('Life Co');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state: 'TX', city: 'Austin', timezone: 'America/Chicago' } });
  const p = await createAssociate({ firstName: 'Lee', lastName: 'Park' });
  await prisma.associate.update({ where: { id: p.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'TX', dob: new Date('1981-06-01') } });
  await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString('123456789') } });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: p.id });
  const life = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'LIFE_INSURANCE', name: 'Group life' } });
  const dental = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'DENTAL', name: 'Dental', employeeContributionDefaultCentsPerPeriod: 500 } });
  return { client, site, p, user, life, dental };
}

describe('group-term life coverage on the enrollment', () => {
  it('a $100,000 election is validated, saved, and imputed on the next run', async () => {
    const { client, site, p, user, life, dental } = await world();
    const a = await loginAs(agent(), user.email);

    // A life election without the face amount is refused; so is one on a non-life plan.
    const missing = await a.post('/benefits/me/enrollments').send({ planId: life.id, electedAmountCentsPerPeriod: 0, effectiveDate: '2026-01-01' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('coverage_required');
    const wrongPlan = await a.post('/benefits/me/enrollments').send({ planId: dental.id, electedAmountCentsPerPeriod: 500, effectiveDate: '2026-01-01', lifeCoverageCents: 10_000_000 });
    expect(wrongPlan.status).toBe(400);
    expect(wrongPlan.body.error.code).toBe('coverage_not_life');
    const tooBig = await a.post('/benefits/me/enrollments').send({ planId: life.id, electedAmountCentsPerPeriod: 0, effectiveDate: '2026-01-01', lifeCoverageCents: 900_000_000 });
    expect(tooBig.status).toBe(400);

    // Employer-paid: $0 per check, $100,000 of coverage.
    const ok = await a.post('/benefits/me/enrollments').send({ planId: life.id, electedAmountCentsPerPeriod: 0, effectiveDate: '2026-01-01', lifeCoverageCents: 10_000_000 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ planKind: 'LIFE_INSURANCE', lifeCoverageCents: 10_000_000 });
    expect((await a.get('/benefits/me/enrollments')).body.enrollments[0]).toMatchObject({ lifeCoverageCents: 10_000_000 });

    const start = new Date('2026-09-14T14:00:00Z');
    await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, locationId: site.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * 3_600_000), status: 'APPROVED', approvedAt: new Date() } });
    const r = await job(() => aggregatePayrollProjection(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 25 }));
    const item = r.items.find((i) => i.associateId === p.id)!;
    // Age 45 at year end: 50 thousands over × $0.15 × 12 = $90 a year; biweekly = $3.46.
    expect(item.earnings.find((e) => e.kind === 'IMPUTED_INCOME')?.amount).toBe(3.46);
    expect(item.grossPay).toBe(203.46);
  });

});
