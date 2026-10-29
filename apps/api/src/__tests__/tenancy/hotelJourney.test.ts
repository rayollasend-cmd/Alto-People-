import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { hashPassword } from '../../lib/passwords.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile, loadTenantProfile } from '../../lib/tenantProfile.js';
import { defaultEmployerOrg } from '../../lib/employment.js';
import { WA_REPLY, WA_TEMPLATES } from '../../lib/whatsappContent.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { refreshBranding } from '../../lib/branding.js';
import { onStubbedEmail } from '../../lib/notifications.js';

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
afterEach(async () => {
  // A failed assertion must not leave the console mocked or the hotel's name in the branding cache.
  vi.restoreAllMocks();
  await prisma.orgSetting.deleteMany();
  await refreshBranding(prisma);
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

    // The journey runs under the hotel's own name: every notice it writes and
    // every email it sends is checked against the forbidden list at the end.
    expect((await admin.patch('/admin/org/settings').send({ orgName: 'The Grand Hotel' })).status).toBe(200);
    // Stubbed sends are heard through onStubbedEmail (lib/notifications.ts; the body never reaches the log): that is the email as it would leave.
    const sentEmails: string[] = [];
    const stopListening = onStubbedEmail((e) => sentEmails.push(`Subject: ${e.subject ?? '(none)'}\n  Body:\n${e.body}`));

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
    // HR waives the checklist the way the screen does: each open task skipped.
    const tasks = await prisma.onboardingTask.findMany({ where: { checklist: { applicationId: application.id } }, select: { id: true, status: true } });
    for (const t of tasks.filter((t) => t.status !== 'DONE' && t.status !== 'SKIPPED')) {
      const skip = await admin.post(`/onboarding/applications/${application.id}/tasks/${t.id}/skip`).send({});
      expect([200, 204], JSON.stringify(skip.body)).toContain(skip.status);
    }
    const hireDate = ymd(new Date());
    const approve = await admin.post(`/onboarding/applications/${application.id}/approve`).send({ hireDate, acknowledgeWarnings: true });
    expect([200, 204], JSON.stringify(approve.body)).toContain(approve.status);
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

    // Hugo speaks the hotel's words. The list lives here, not in prose; the
    // one exemption is the product name in his introduction (exempt by the owner's ruling, 2026-10-13).
    await loadTenantProfile(ALTO_TENANT_ID);
    const FORBIDDEN = /\b(clients?|bill rates?|housing|vans?|stores?|associates?|alto)\b/i;
    const exempt = (s: string) => s.replace(/Alto People/g, '');
    for (const lang of ['en', 'es', 'tr'] as const) {
      const lines = [
        WA_REPLY.intro(lang, 'Hugo'),
        WA_REPLY.whoAmI(lang, 'Hugo'),
        WA_REPLY.optedIn(lang, 'Hugo'),
        WA_REPLY.optedOut(lang),
        WA_REPLY.noPayday(lang),
        WA_REPLY.noShifts(lang),
        WA_REPLY.handoff(lang, null),
        WA_REPLY.unknownNumber(lang),
      ];
      for (const line of lines) expect(exempt(line), `${lang}: ${line}`).not.toMatch(FORBIDDEN);
    }
    expect(WA_REPLY.handoff('en', null)).toMatch(/property manager/);
    expect(WA_REPLY.noShifts('en')).toMatch(/The Grand Hotel app/);
    // The templates the hotel can be sent: every one that needs no module it has off.
    for (const t of WA_TEMPLATES.filter((t) => !t.requiresModule)) for (const body of Object.values(t.body)) expect(body, t.metaName).not.toMatch(FORBIDDEN);
    expect(WA_TEMPLATES.find((t) => t.key === 'alto_shift_reminder')?.fallbackKey).toBe('alto_shift_reminder_plain');

    // Every notice the journey wrote (bell, email record, push) and every
    // email it sent speaks the hotel's words too.
    await flushPendingNotifications();
    stopListening();
    const notices = await prisma.notification.findMany({ select: { channel: true, category: true, subject: true, body: true } });
    expect(notices.length, 'the journey writes notices (invite, approval, the HR desk)').toBeGreaterThan(0);
    const badNotices = notices.filter((n) => FORBIDDEN.test(exempt(`${n.subject ?? ''}\n${n.body}`)));
    expect(
      badNotices.map((n) => `${n.channel} ${n.category ?? ''}: ${n.subject ?? ''} — ${exempt(`${n.subject ?? ''}\n${n.body}`).match(FORBIDDEN)?.[0]}`),
      'notices carrying a forbidden word',
    ).toEqual([]);
    expect(sentEmails.length, 'the invite at least was emailed').toBeGreaterThan(0);
    const badEmails = sentEmails.filter((e) => FORBIDDEN.test(exempt(e)));
    expect(
      badEmails.map((e) => `${e.split('\n').find((l) => l.includes('Subject:'))?.trim()} — ${exempt(e).match(FORBIDDEN)?.[0]}`),
      'emails carrying a forbidden word',
    ).toEqual([]);
    expect(sentEmails.some((e) => e.includes('Complete your onboarding with The Grand Hotel')), 'the invite names the hotel').toBe(true);

    await admin.patch('/admin/org/settings').send({ orgName: 'Alto HR' });
  });
});
