import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { currentEmployment, defaultEmployerOrg, dropEmploymentOfApplication, employerByEin, employerFor, employersForYear, endEmployment, openEmployment } from '../../lib/employment.js';
import { buildPaystubDataFromItem, paystubItemInclude } from '../../lib/paystubData.js';

/**
 * Brief 2-1b, step 4 — the employer of record.
 *
 *   An employment spell opens at approval with the employer the facts
 *   point to (a client's own row when the client carries legal facts, the
 *   tenant's own row otherwise), ends at separation, and is what the tax
 *   forms and the paystub read — never a Client row.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the employer organizations', () => {
  it('the tenant has one default row, made on first use; a client with legal facts gets its own row; a client without does not', async () => {
    const d1 = await defaultEmployerOrg(prisma, ALTO_TENANT_ID);
    const d2 = await defaultEmployerOrg(prisma, ALTO_TENANT_ID);
    expect(d2.id).toBe(d1.id);
    expect(d1).toMatchObject({ kind: 'TENANT', clientId: null });

    const walmart = await createClient('Walmart');
    await prisma.client.update({ where: { id: walmart.id }, data: { legalName: 'Walmart Inc.', ein: '71-0415188', city: 'Bentonville', state: 'AR' } });
    const bare = await createClient('Pier Park');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const appW = await prisma.application.create({ data: { associateId: ana.id, clientId: walmart.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    const e1 = await openEmployment(prisma, { associateId: ana.id, applicationId: appW.id, clientId: walmart.id, siteId: null, hireDate: '2026-06-01' });
    const employer = await prisma.employerOrganization.findUniqueOrThrow({ where: { id: e1.employerOrgId } });
    expect(employer).toMatchObject({ kind: 'CLIENT', clientId: walmart.id, legalName: 'Walmart Inc.', ein: '71-0415188' });
    // Idempotent on the application.
    expect((await openEmployment(prisma, { associateId: ana.id, applicationId: appW.id, clientId: walmart.id, siteId: null, hireDate: '2026-06-01' })).id).toBe(e1.id);

    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Lee' });
    const appP = await prisma.application.create({ data: { associateId: bo.id, clientId: bare.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    const e2 = await openEmployment(prisma, { associateId: bo.id, applicationId: appP.id, clientId: bare.id, siteId: null, hireDate: '2026-06-01' });
    expect(e2.employerOrgId).toBe(d1.id);
    expect(await prisma.employerOrganization.count({ where: { clientId: bare.id } })).toBe(0);

    // A direct employer's hire: no client at all.
    const cy = await createAssociate({ firstName: 'Cy', lastName: 'Team' });
    const e3 = await openEmployment(prisma, { associateId: cy.id, applicationId: null, clientId: null, siteId: null, hireDate: '2026-07-01' });
    expect(e3.employerOrgId).toBe(d1.id);
  });

  it('employerFor reads the spell in force, falls back to the default, finds an employer by EIN, and lists the year\'s employers', async () => {
    const walmart = await createClient('Walmart');
    await prisma.client.update({ where: { id: walmart.id }, data: { legalName: 'Walmart Inc.', ein: '71-0415188' } });
    const ana = await createAssociate();
    const app = await prisma.application.create({ data: { associateId: ana.id, clientId: walmart.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await openEmployment(prisma, { associateId: ana.id, applicationId: app.id, clientId: walmart.id, siteId: null, hireDate: '2026-03-01' });
    expect((await employerFor(prisma, ana.id, new Date('2026-06-15'))).ein).toBe('71-0415188');
    expect((await employerFor(prisma, ana.id, new Date('2026-01-15'))).kind).toBe('TENANT');
    expect(await endEmployment(prisma, ana.id, '2026-09-30')).toBe(1);
    expect((await employerFor(prisma, ana.id, new Date('2026-12-31'))).kind).toBe('TENANT');
    expect((await employerFor(prisma, ana.id, new Date('2026-09-30'))).ein).toBe('71-0415188');
    expect(await currentEmployment(prisma, ana.id, new Date('2026-10-01'))).toBeNull();
    expect((await employerByEin(prisma, '71-0415188'))?.clientId).toBe(walmart.id);
    expect((await employersForYear(prisma, ana.id, 2026)).map((e) => e.kind)).toEqual(['CLIENT']);
    expect((await employersForYear(prisma, ana.id, 2027)).map((e) => e.kind)).toEqual(['TENANT']);
    await dropEmploymentOfApplication(prisma, app.id);
    expect(await prisma.employment.count({ where: { associateId: ana.id } })).toBe(0);
  });
});

describe('what the forms read', () => {
  it('the paystub company block is the employer of record: the tenant for a client-less run', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const team = await createAssociate({ firstName: 'Tess', lastName: 'Member' });
    await openEmployment(prisma, { associateId: team.id, applicationId: null, clientId: null, siteId: null, hireDate: '2026-01-05' });
    const d = await defaultEmployerOrg(prisma, ALTO_TENANT_ID);
    await prisma.employerOrganization.update({ where: { id: d.id }, data: { legalName: 'The Grand Hotel LLC', ein: '12-3456789', city: 'Destin', state: 'FL', zip: '32541' } });
    await prisma.timeEntry.create({ data: { associateId: team.id, clientId: null, clockInAt: new Date('2026-04-14T13:00:00.000Z'), clockOutAt: new Date('2026-04-14T17:00:00.000Z'), status: 'APPROVED' } });
    const a = await loginAs(agent(), hr.email);
    const run = await a.post('/payroll/runs').send({ periodStart: '2026-04-13', periodEnd: '2026-04-19', defaultHourlyRate: 20 });
    expect(run.status).toBe(201);
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.body.id }, include: paystubItemInclude() });
    const data = await buildPaystubDataFromItem(prisma, item);
    expect(data.company).toMatchObject({ name: 'The Grand Hotel LLC', ein: '12-3456789', city: 'Destin', state: 'FL' });

    const employers = await a.get('/admin/employers');
    expect(employers.status).toBe(200);
    expect(employers.body.employers[0]).toMatchObject({ isDefault: true, legalName: 'The Grand Hotel LLC', employments: 1 });
    const history = await a.get(`/org/associates/${team.id}/employment`);
    expect(history.body.employment).toEqual([expect.objectContaining({ hireDate: '2026-01-05', endDate: null, employer: expect.objectContaining({ kind: 'TENANT' }) })]);
  });
});
