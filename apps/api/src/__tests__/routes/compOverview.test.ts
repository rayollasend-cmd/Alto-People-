import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * GET /comp/overview (F500 2026-10-22): Compensation opens on who is paid
 * outside their band, pay changes waiting on a second person, and the live
 * merit cycle against its budget — instead of a band editor.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hire(clientId: string, first: string, rate: { payType: 'HOURLY' | 'SALARY'; amount: number } | null, jobProfileId: string | null = null) {
  const a = await createAssociate({ firstName: first, lastName: 'Test' });
  await prisma.associate.update({ where: { id: a.id }, data: { jobProfileId } });
  await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
  if (rate) await prisma.compensationRecord.create({ data: { associateId: a.id, effectiveFrom: new Date('2026-01-01'), payType: rate.payType, amount: rate.amount, reason: 'HIRE' } });
  return a;
}

describe('GET /comp/overview', () => {
  it('counts who sits below and above their band, pending pay changes and the live cycle’s budget', async () => {
    const harbor = await createClient('Harbor Inn');
    const other = await createClient('Ocean Club');
    const lead = await prisma.jobProfile.create({ data: { code: 'LEAD', title: 'Shift lead' } });
    // Client-wide hourly band $16–$22; a shift-lead band $20–$26 wins for leads.
    await prisma.compBand.create({ data: { clientId: harbor.id, name: 'Housekeeping', payType: 'HOURLY', minAmount: 16, midAmount: 19, maxAmount: 22 } });
    await prisma.compBand.create({ data: { clientId: harbor.id, jobProfileId: lead.id, name: 'Leads', payType: 'HOURLY', minAmount: 20, midAmount: 23, maxAmount: 26 } });

    const ana = await hire(harbor.id, 'Ana', { payType: 'HOURLY', amount: 15 }); // below 16
    await hire(harbor.id, 'Ben', { payType: 'HOURLY', amount: 18 }); // in band
    const cy = await hire(harbor.id, 'Cy', { payType: 'HOURLY', amount: 24 }); // above 22
    await hire(harbor.id, 'Dee', { payType: 'HOURLY', amount: 24 }, lead.id); // in the leads band
    await hire(harbor.id, 'Eli', { payType: 'SALARY', amount: 52000 }); // no salary band
    await hire(harbor.id, 'Fay', null); // no rate on file
    await hire(other.id, 'Gus', { payType: 'HOURLY', amount: 30 }); // no band at Ocean Club
    // Separated: not counted.
    const gone = await hire(harbor.id, 'Hal', { payType: 'HOURLY', amount: 10 });
    await prisma.associate.update({ where: { id: gone.id }, data: { separatedAt: new Date() } });

    // Two pay changes waiting, one already decided.
    await prisma.approvalRequest.createMany({
      data: [
        { kind: 'PAY_RATE_CHANGE', subjectType: 'Associate', subjectId: ana.id, associateId: ana.id, title: 'Ana: $15 → $16', proposed: {}, approverCapability: 'manage:comp' },
        { kind: 'PROMOTION', subjectType: 'Associate', subjectId: cy.id, associateId: cy.id, title: 'Cy to lead', proposed: {}, approverCapability: 'manage:comp' },
        { kind: 'PAY_RATE_CHANGE', subjectType: 'Associate', subjectId: cy.id, associateId: cy.id, title: 'old', proposed: {}, approverCapability: 'manage:comp', status: 'APPROVED' },
      ],
    });

    // The open cycle: $10,000 budget; Ana +$1/h (2,080 h → $2,080), Cy +$0.50/h ($1,040), a rejected one not counted.
    const day = new Date('2026-12-01');
    const cycle = await prisma.meritCycle.create({ data: { clientId: harbor.id, name: 'FY27 merit', status: 'OPEN', reviewPeriodStart: day, reviewPeriodEnd: day, effectiveDate: day, budget: 10000 } });
    await prisma.meritCycle.create({ data: { clientId: harbor.id, name: 'Draft cycle', status: 'DRAFT', reviewPeriodStart: day, reviewPeriodEnd: day, effectiveDate: day } });
    await prisma.meritProposal.createMany({
      data: [
        { cycleId: cycle.id, associateId: ana.id, currentPayType: 'HOURLY', currentAmount: 15, proposedAmount: 16, status: 'SUBMITTED' },
        { cycleId: cycle.id, associateId: cy.id, currentPayType: 'HOURLY', currentAmount: 24, proposedAmount: 24.5, status: 'APPROVED' },
        { cycleId: cycle.id, associateId: gone.id, currentPayType: 'HOURLY', currentAmount: 10, proposedAmount: 20, status: 'REJECTED' },
      ],
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const http = await loginAs(agent(), user.email);
    const res = await http.get('/comp/overview');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ people: 7, belowMin: 1, aboveMax: 1, inBand: 2, noBand: 2, noRate: 1, pendingPayChanges: 2, outsideTruncated: false });
    expect(res.body.outsideBand).toEqual([
      { associateId: ana.id, name: 'Ana Test', payType: 'HOURLY', amount: '15.00', band: 'Housekeeping', min: '16.00', max: '22.00', where: 'BELOW' },
      { associateId: cy.id, name: 'Cy Test', payType: 'HOURLY', amount: '24.00', band: 'Housekeeping', min: '16.00', max: '22.00', where: 'ABOVE' },
    ]);
    expect(res.body.cycle).toMatchObject({ name: 'FY27 merit', status: 'OPEN', budget: '10000.00', spent: '3120.00', people: 2, pending: 1 });

    // One client: Ocean Club has no bands and no cycle.
    const ocean = await http.get(`/comp/overview?clientId=${other.id}`);
    expect(ocean.body).toMatchObject({ people: 1, belowMin: 0, aboveMax: 0, noBand: 1, pendingPayChanges: 0, cycle: null });
  });

  it('shows a line manager their own reports only', async () => {
    const harbor = await createClient('Harbor Inn');
    await prisma.compBand.create({ data: { clientId: harbor.id, name: 'Housekeeping', payType: 'HOURLY', minAmount: 16, midAmount: 19, maxAmount: 22 } });
    const boss = await createAssociate({ firstName: 'Mia', lastName: 'Boss' });
    const mine = await hire(harbor.id, 'Ana', { payType: 'HOURLY', amount: 15 });
    await hire(harbor.id, 'Zed', { payType: 'HOURLY', amount: 30 });
    await prisma.associate.update({ where: { id: mine.id }, data: { managerId: boss.id } });
    const { user } = await createUser({ role: 'MANAGER', associateId: boss.id });
    const res = await (await loginAs(agent(), user.email)).get('/comp/overview');
    expect(res.body).toMatchObject({ people: 1, belowMin: 1, aboveMax: 0 });
  });

  it('is not for people without compensation access', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(agent(), user.email)).get('/comp/overview')).status).toBe(403);
  });
});
