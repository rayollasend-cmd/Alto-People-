import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TERM_KEYS, defaultModulesFor, defaultTenantProfile, termsIn } from '@alto-people/shared';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile, loadTenantProfile, moduleOn, setTenantProfile } from '../../lib/tenantProfile.js';
import { tenantJob } from '../../lib/tenantJobs.js';
import { WA_TEMPLATES } from '../../lib/whatsappContent.js';

/**
 * Brief 2-1b, step 1 — the tenant profile: business model, modules,
 * terminology. Alto HR is a WORKFORCE_PROVIDER with everything on and its
 * own words; a hotel is a DIRECT_EMPLOYER with housing, transportation,
 * programs, bill rates, the client portal, robotics and the agent builder
 * off, and team member / property / property manager words.
 */

beforeEach(async () => {
  await truncateAll();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

describe('defaults', () => {
  it('a workforce provider has every module on and Alto HR\'s words; a direct employer has the hotel switches and words', () => {
    expect(Object.values(defaultModulesFor('WORKFORCE_PROVIDER')).every(Boolean)).toBe(true);
    expect(defaultModulesFor('DIRECT_EMPLOYER')).toMatchObject({ scheduling: true, time: true, hrCases: true, compliance: true, payrollSync: true, housingLink: false, transportation: false, programs: false, billRates: false, clientPortal: false, robotics: false, agentBuilder: false });
    const hotel = defaultTenantProfile('DIRECT_EMPLOYER');
    expect(termsIn(hotel, 'en')).toMatchObject({ worker: 'Team member', site: 'Property', manager: 'Property manager' });
    expect(termsIn(hotel, 'es').worker).toBe('Miembro del equipo');
    expect(termsIn(hotel, 'tr').site).toBe('Tesis');
    const alto = defaultTenantProfile('WORKFORCE_PROVIDER');
    expect(termsIn(alto, 'en')).toMatchObject({ worker: 'Associate', site: 'Store', manager: 'Supervisor', 'label.client': 'Client' });
    expect(TERM_KEYS.length).toBeGreaterThanOrEqual(30);
    for (const k of TERM_KEYS) for (const l of ['en', 'es', 'tr'] as const) expect(alto.terminology[k][l], `${k}.${l}`).toBeTruthy();
  });

  it('Alto HR reads as a workforce provider with everything on, from the row the migration wrote', async () => {
    const p = await loadTenantProfile(ALTO_TENANT_ID);
    expect(p.businessModel).toBe('WORKFORCE_PROVIDER');
    expect(Object.values(p.modules).every(Boolean)).toBe(true);
    expect(p.terminology.worker.en).toBe('Associate');
  });
});

describe('the profile endpoints and the gates', () => {
  it('HR reads the profile; manage:org changes it; an off module answers 404 on its mount, is skipped by its jobs, and rides with the session', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const got = await admin.get('/admin/tenant/profile');
    expect(got.status).toBe(200);
    expect(got.body.profile.modules.transportation).toBe(true);
    expect(got.body.catalog.modules.length).toBe(14);

    const kim = await createAssociate({ firstName: 'Kim', lastName: 'Nguyen' });
    const { user: kimUser } = await createUser({ role: 'ASSOCIATE', associateId: kim.id });
    const rider = await loginAs(agent(), kimUser.email);
    expect((await rider.get('/transport/me')).status).toBe(200);
    expect((await admin.get('/programs')).status).not.toBe(404);

    const put = await admin.put('/admin/tenant/profile').send({ modules: { transportation: false, programs: false }, terminology: { worker: { en: 'Team member' } } });
    expect(put.status).toBe(200);
    expect(put.body.profile.modules).toMatchObject({ transportation: false, programs: false, scheduling: true });
    expect(put.body.profile.terminology.worker).toEqual({ en: 'Team member', es: 'Asociado', tr: 'Çalışan' });
    expect((await admin.put('/admin/tenant/profile').send({ modules: { nonsense: true } })).status).toBe(400);
    expect((await rider.put('/admin/tenant/profile').send({ modules: { transportation: true } })).status).toBe(403);

    // The mount is gone for everyone, the session says why, the job skips the tenant.
    expect((await rider.get('/transport/me')).status).toBe(404);
    expect((await admin.get('/programs')).status).toBe(404);
    const me = await rider.get('/auth/me');
    expect(me.body.tenant).toMatchObject({ id: ALTO_TENANT_ID, businessModel: 'WORKFORCE_PROVIDER', modules: { transportation: false } });
    expect(me.body.tenant.terminology.worker.en).toBe('Team member');
    let ran = 0;
    expect(await tenantJob('transportLive', () => (ran += 1), { module: 'transportation' })()).toEqual({ ran: 0, failed: 0, skipped: 1 });
    expect(await tenantJob('autoClockOut', () => (ran += 1), { module: 'time' })()).toEqual({ ran: 1, failed: 0, skipped: 0 });
    expect(ran).toBe(1);
    expect(await moduleOn('transportation')).toBe(false);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'tenant.profile_updated' } });
    expect(audit?.metadata).toMatchObject({ modules: { transportation: { from: true, to: false } }, termsChanged: ['worker'] });

    // Back to the model's defaults.
    const reset = await admin.put('/admin/tenant/profile').send({ resetToDefaults: true });
    expect(reset.body.profile.modules.transportation).toBe(true);
    expect(reset.body.profile.terminology.worker.en).toBe('Associate');
    expect((await rider.get('/transport/me')).status).toBe(200);
  });

  it('talent and perks are on by default; off, every path they own answers 404 while the rest of the app stands', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const kim = await createAssociate({ firstName: 'Kim', lastName: 'Nguyen' });
    const { user: kimUser } = await createUser({ role: 'ASSOCIATE', associateId: kim.id });
    const associate = await loginAs(agent(), kimUser.email);

    // The talent routers mount at '/', so the gate is by path prefix: each owned path, admin- and self-facing.
    const talent = ['/skills', '/associate-skills', '/career-ladders', '/mentorships', '/succession/positions', '/probations', '/ramp-plans', '/learning-paths', '/internal-jobs', '/pulse-surveys'];
    const talentSelf = ['/my/learning-paths', '/my/internal-applications', '/my/pulse-surveys'];
    const perks = ['/tuition-requests', '/tuition-summary', '/equity-grants', '/volunteer-entries', '/volunteer-summary', '/vto-policy'];
    const perksSelf = ['/my/tuition-requests', '/my/equity-grants', '/my/volunteer-entries'];
    expect((await loadTenantProfile(ALTO_TENANT_ID)).modules).toMatchObject({ talent: true, perks: true });
    for (const p of [...talent, ...perks]) expect((await admin.get(p)).status, p).not.toBe(404);
    for (const p of [...talentSelf, ...perksSelf]) expect((await associate.get(p)).status, p).not.toBe(404);

    // Talent off: its paths are gone for everyone; perks and the rest of the app are untouched.
    expect((await admin.put('/admin/tenant/profile').send({ modules: { talent: false } })).status).toBe(200);
    for (const p of talent) expect((await admin.get(p)).status, p).toBe(404);
    for (const p of talentSelf) expect((await associate.get(p)).status, p).toBe(404);
    expect((await admin.get('/skills/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    for (const p of perks) expect((await admin.get(p)).status, p).not.toBe(404);
    expect((await admin.get('/admin/tenant/profile')).status).toBe(200);
    expect((await admin.get('/programs')).status).not.toBe(404);
    expect((await associate.get('/auth/me')).body.tenant.modules).toMatchObject({ talent: false, perks: true });

    // Perks off too: now both long tails are gone; the gate never leaks onto neighbouring prefixes.
    expect((await admin.put('/admin/tenant/profile').send({ modules: { perks: false } })).status).toBe(200);
    for (const p of perks) expect((await admin.get(p)).status, p).toBe(404);
    for (const p of perksSelf) expect((await associate.get(p)).status, p).toBe(404);
    expect((await admin.get('/admin/tenant/profile')).status).toBe(200);
    expect((await admin.get('/programs')).status).not.toBe(404);
    expect(await moduleOn('talent')).toBe(false);
    expect(await moduleOn('perks')).toBe(false);

    // Back on: the paths return.
    expect((await admin.put('/admin/tenant/profile').send({ modules: { talent: true, perks: true } })).status).toBe(200);
    expect((await admin.get('/skills')).status).not.toBe(404);
    expect((await admin.get('/tuition-requests')).status).not.toBe(404);
  });

  it('a direct employer switches the hotel modules off by default', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const p = await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true }, hr.id);
    expect(p.modules).toMatchObject({ transportation: false, clientPortal: false, billRates: false, scheduling: true });
    expect(p.terminology.manager.en).toBe('Property manager');
    const admin = await loginAs(agent(), hr.email);
    expect((await admin.get('/clients')).status).toBe(404);
    expect((await admin.get('/regions')).status).toBe(404);
    await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'WORKFORCE_PROVIDER', resetToDefaults: true }, hr.id);
  });
});

describe('the WhatsApp templates', () => {
  it('name the tenant and the assistant through parameters, never a brand word, and every placeholder has a parameter', () => {
    for (const t of WA_TEMPLATES) {
      const count = t.params.length + (t.brandParams?.length ?? 0);
      for (const [lang, body] of Object.entries(t.body)) {
        const used = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
        expect([...used].sort((a, b) => a - b), `${t.metaName} ${lang}`).toEqual(Array.from({ length: used.size }, (_, i) => i + 1));
        expect(Math.max(0, ...used), `${t.metaName} ${lang} placeholders vs params`).toBeLessThanOrEqual(count);
        expect(body, `${t.metaName} ${lang} must not name the brand`).not.toMatch(/\bAlto\b/);
      }
    }
    expect(WA_TEMPLATES.find((t) => t.key === 'alto_notice')?.metaName).toBe('alto_notice_v2');
  });
});
