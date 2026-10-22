import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * A posting opened from a staffing gap starts at the client's rate-card pay
 * (role walk HR 5, wave 2): a recruiter-readable view of the cards in force
 * today — pay only, never the bill rate — scoped to the caller's reach.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function cards() {
  const coastal = await createClient('Coastal Resort');
  const other = await createClient('Bay Group');
  const day = new Date('2026-01-01T00:00:00Z');
  await prisma.shiftRateDefault.create({ data: { clientId: coastal.id, position: 'Housekeeper', payRate: 15, billRate: 24, effectiveFrom: day } });
  await prisma.shiftRateDefault.create({ data: { clientId: coastal.id, position: 'Houseman', payRate: 16.5, billRate: 26, effectiveFrom: day } });
  // An ended card is not today's pay.
  await prisma.shiftRateDefault.create({ data: { clientId: coastal.id, position: 'Laundry', payRate: 9, billRate: 12, effectiveFrom: new Date('2025-01-01T00:00:00Z'), effectiveTo: new Date('2025-06-30T00:00:00Z') } });
  return { coastal, other };
}

describe('pay from the rate card', () => {
  it('a recruiter reads the client’s pay range (no bill rates), or one role’s rate', async () => {
    const { coastal, other } = await cards();
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(agent(), user.email);
    const r = await a.get(`/job-postings/pay-from-rate-card?clientId=${coastal.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ clientName: 'Coastal Resort', suggested: { minPay: 15, maxPay: 16.5, payUnit: 'HOUR', position: null } });
    expect(r.body.rates.map((x: { position: string }) => x.position)).toEqual(['Housekeeper', 'Houseman']);
    expect(JSON.stringify(r.body)).not.toContain('billRate');
    const one = await a.get(`/job-postings/pay-from-rate-card?clientId=${coastal.id}&position=houseman`);
    expect(one.body.suggested).toMatchObject({ minPay: 16.5, maxPay: 16.5, position: 'Houseman' });
    // A client with no card: nothing suggested, said plainly.
    const none = await a.get(`/job-postings/pay-from-rate-card?clientId=${other.id}`);
    expect(none.body).toMatchObject({ rates: [], suggested: null });
  });

  it('is scoped: a store-bound office account reads only clients with a store in its reach; the portal and associates never', async () => {
    const { coastal, other } = await cards();
    const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [otherSite.id] } });
    const o = await loginAs(agent(), ops.email);
    expect((await o.get(`/job-postings/pay-from-rate-card?clientId=${coastal.id}`)).status).toBe(404);
    expect((await o.get(`/job-postings/pay-from-rate-card?clientId=${other.id}`)).status).toBe(200);

    const { user: worker } = await createUser({ role: 'ASSOCIATE' });
    const w = await loginAs(agent(), worker.email);
    expect((await w.get(`/job-postings/pay-from-rate-card?clientId=${coastal.id}`)).status).toBe(403);
    expect((await o.get('/job-postings/pay-from-rate-card')).status).toBe(400);
  });
});
