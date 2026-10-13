import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { hashPassword } from '../../lib/passwords.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { defaultEmployerOrg } from '../../lib/employment.js';

/**
 * Brief 2-1b — the hotel's journey through the API, with no client
 * anywhere: a property, a hire, a shift, approved time, an HR case and a
 * payroll export. The screens' forbidden-word test lives in apps/web; this
 * is the data path it stands on.
 */

beforeEach(async () => {
  await truncateAll();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe('a direct employer with no clients', () => {
  it('onboards, schedules, approves time, files a case and exports payroll on sites alone', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);

    // The tenant is a hotel.
    const profile = await admin.put('/admin/tenant/profile').send({ businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true });
    expect(profile.status).toBe(200);
    expect(profile.body.profile.modules).toMatchObject({ clientPortal: false, transportation: false, billRates: false });
    const employer = await defaultEmployerOrg(prisma, ALTO_TENANT_ID);
    await prisma.employerOrganization.update({ where: { id: employer.id }, data: { legalName: 'The Grand Hotel LLC', ein: '12-3456789' } });

    // A property, under a region of the hotel's own tree.
    const region = await admin.post('/admin/org-units').send({ type: 'REGION', name: 'Gulf Coast' });
    expect(region.status).toBe(201);
    const site = await admin.post('/admin/sites').send({ name: 'The Grand Hotel', timezone: 'America/Chicago', state: 'FL', orgUnitId: region.body.unit.id });
    expect(site.status).toBe(201);
    expect(site.body.site.orgUnitId).toBe(region.body.unit.id);
    expect((await admin.get('/admin/sites')).body.sites).toEqual([expect.objectContaining({ id: site.body.site.id, clientId: null, orgUnitName: 'Gulf Coast' })]);

    // A hire: invited with no client, placed by the property, approved.
    const template = await prisma.onboardingTemplate.create({ data: { clientId: null, track: 'STANDARD', name: 'Hotel standard' } });
    const invite = await admin.post('/onboarding/applications').send({
      associateEmail: 'tess.member@example.com',
      associateFirstName: 'Tess',
      associateLastName: 'Member',
      templateId: template.id,
      locationId: site.body.site.id,
      position: 'Housekeeper',
    });
    expect(invite.status).toBe(201);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: invite.body.id } });
    expect(application.clientId).toBeNull();
    expect(application.locationId).toBe(site.body.site.id);
    const hireDate = ymd(new Date());
    const approve = await admin.post(`/onboarding/applications/${application.id}/approve`).send({ hireDate, acknowledgeWarnings: true });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    const employment = await prisma.employment.findUniqueOrThrow({ where: { applicationId: application.id }, include: { employer: true } });
    expect(employment.employer).toMatchObject({ kind: 'TENANT', legalName: 'The Grand Hotel LLC' });
    expect(employment.siteId).toBe(site.body.site.id);
    const placed = await prisma.associateAssignment.findFirst({ where: { associateId: application.associateId, endedAt: null } });
    expect(placed?.locationId).toBe(site.body.site.id);

    // A shift at the property, no client named.
    const startsAt = new Date(Date.now() + 2 * 86_400_000);
    const shift = await admin.post('/scheduling/shifts').send({
      locationId: site.body.site.id,
      position: 'Housekeeper',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * 3_600_000).toISOString(),
      status: 'OPEN',
    });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.body.id } })).clientId).toBeNull();
    expect((await admin.post('/scheduling/shifts').send({ position: 'Housekeeper', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 8 * 3_600_000).toISOString() })).body.error.code).toBe('site_required');

    // Time worked at the property, approved.
    const entry = await prisma.timeEntry.create({
      data: { associateId: application.associateId, clientId: null, locationId: site.body.site.id, clockInAt: new Date('2026-04-14T13:00:00.000Z'), clockOutAt: new Date('2026-04-14T21:00:00.000Z'), status: 'COMPLETED' },
    });
    const approved = await admin.post(`/time/admin/entries/${entry.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('APPROVED');

    // The team member files an HR case.
    await prisma.user.update({ where: { email: 'tess.member@example.com' }, data: { passwordHash: await hashPassword(DEFAULT_TEST_PASSWORD), status: 'ACTIVE' } });
    const tess = await loginAs(agent(), 'tess.member@example.com');
    const hrCase = await tess.post('/hr-cases').send({ category: 'BENEFITS', subject: 'Question about my schedule', description: 'Can I move to the morning shift?' });
    expect(hrCase.status, JSON.stringify(hrCase.body)).toBe(201);

    // Payroll for the period, and the export the bureau gets.
    const run = await admin.post('/payroll/runs').send({ periodStart: '2026-04-13', periodEnd: '2026-04-19', defaultHourlyRate: 18 });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.items).toHaveLength(1);
    expect(run.body.items[0].grossPay).toBe(144);
    const sheet = await admin.get('/external-payments/period-prefill?from=2026-04-13&to=2026-04-19');
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    expect(sheet.body.rows).toEqual([expect.objectContaining({ associateId: application.associateId, regularHours: 8 })]);

    // The modules that are off are gone, not forbidden.
    expect((await admin.get('/transport/settings')).status).toBe(404);
    expect((await admin.get('/clients')).status).toBe(404);
  });
});
