import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-2 step 6 — the organization's and each site's own rules.
 *
 *   An override is created DRAFT, signed with a note, retired, never
 *   deleted; only a draft is edited; every change is audited with before
 *   and after. Changing a rule for one tenant leaves another's unchanged
 *   (acceptance line 3, through the routes). The executive reads and cannot
 *   write; a pack is signed only by the operator tenant.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function flSite(tenantId = ALTO_TENANT_ID) {
  const c = await createClient(`FL ${Math.random().toString(36).slice(2, 6)}`);
  const s = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  return prisma.site.update({ where: { id: s.id }, data: { state: 'FL', tenantId }, select: { id: true } });
}

async function adminOf(tenantId = ALTO_TENANT_ID, role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR') {
  const { user } = await createUser({ role });
  if (tenantId !== ALTO_TENANT_ID) await prisma.user.update({ where: { id: user.id }, data: { tenantId } });
  return { user, a: await loginAs(agent(), user.email) };
}

const summaryOf = async (a: Awaited<ReturnType<typeof adminOf>>['a'], siteId: string) => (await a.get(`/labor-rules/sites/${siteId}?date=2026-10-15`)).body.summary;

describe('overrides', () => {
  it('draft, edit, sign with a note, retire; audited with before and after', async () => {
    const site = await flSite();
    const { a } = await adminOf();

    const made = await a.post('/labor-rules/overrides').send({ level: 'SITE', siteId: site.id, effectiveFrom: '2026-10-01', params: { restBetweenShifts: { minHours: 10, premiumHours: 1 } }, source: 'Union contract §7, 2026' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ status: 'DRAFT', version: 1 });

    expect((await a.patch(`/labor-rules/sets/${made.body.id}`).send({ params: { restBetweenShifts: { minHours: 11, premiumHours: 1 } } })).status).toBe(200);
    expect((await summaryOf(a, site.id)).restBetweenShiftsHours).toBe(11);

    expect((await a.post(`/labor-rules/sets/${made.body.id}/activate`).send({})).status).toBe(400);
    const signed = await a.post(`/labor-rules/sets/${made.body.id}/activate`).send({ note: 'Approved by ops director 2026-10-15' });
    expect(signed.body.status).toBe('ACTIVE');
    expect((await a.patch(`/labor-rules/sets/${made.body.id}`).send({ source: 'changed' })).status).toBe(409);

    // A second version signed for the same date steps the first down.
    const v2 = await a.post('/labor-rules/overrides').send({ level: 'SITE', siteId: site.id, effectiveFrom: '2026-10-01', params: { restBetweenShifts: { minHours: 12, premiumHours: 1 } }, source: 'Union contract §7, amended' });
    expect(v2.body.version).toBe(2);
    await a.post(`/labor-rules/sets/${v2.body.id}/activate`).send({ note: 'Amendment signed' });
    expect((await prisma.laborRuleSet.findUniqueOrThrow({ where: { id: made.body.id } })).status).toBe('RETIRED');
    expect((await summaryOf(a, site.id)).restBetweenShiftsHours).toBe(12);

    expect((await a.post(`/labor-rules/sets/${v2.body.id}/retire`).send({})).body.status).toBe('RETIRED');
    expect((await summaryOf(a, site.id)).restBetweenShiftsHours).toBeNull();
    expect(await prisma.laborRuleSet.count({ where: { siteId: site.id } })).toBe(2);

    await flushPendingAudits();
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'LaborRuleSet' }, orderBy: { createdAt: 'asc' }, select: { action: true, metadata: true } })).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['labor_rules.override_created', 'labor_rules.override_updated', 'labor_rules.override_signed', 'labor_rules.retired']));
    const updated = await prisma.auditLog.findFirstOrThrow({ where: { action: 'labor_rules.override_updated' } });
    expect(updated.metadata).toMatchObject({ before: { restBetweenShifts: { minHours: 10 } }, after: { restBetweenShifts: { minHours: 11 } } });
  });

  it('refuses what an override cannot be: a site of another tenant, a tenant override naming a site, minors not blocking', async () => {
    const { a } = await adminOf();
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const theirs = await flSite(T2);
    expect((await a.post('/labor-rules/overrides').send({ level: 'SITE', siteId: theirs.id, effectiveFrom: '2026-10-01', params: { custom: { x: 1 } }, source: 'Contract' })).status).toBe(404);
    expect((await a.post('/labor-rules/overrides').send({ level: 'TENANT', siteId: theirs.id, effectiveFrom: '2026-10-01', params: { custom: { x: 1 } }, source: 'Contract' })).status).toBe(400);
    expect((await a.post('/labor-rules/overrides').send({ level: 'TENANT', effectiveFrom: '2026-10-01', params: {}, source: 'Contract' })).status).toBe(400);
  });

  it('a rule changed for one tenant leaves another’s unchanged', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const altoSite = await flSite();
    const twoSite = await flSite(T2);
    const alto = await adminOf();
    const two = await adminOf(T2);
    const made = await two.a.post('/labor-rules/overrides').send({ level: 'TENANT', effectiveFrom: '2026-01-01', params: { overtime: { weeklyThreshold: 37.5 } }, source: 'Hotel union contract' });
    expect(made.status).toBe(201);
    await two.a.post(`/labor-rules/sets/${made.body.id}/activate`).send({ note: 'Signed by the hotel GM' });
    expect((await summaryOf(two.a, twoSite.id)).weeklyOvertimeHours).toBe(37.5);
    expect((await summaryOf(alto.a, altoSite.id)).weeklyOvertimeHours).toBe(40);
    // Neither sees, edits or signs the other's rows.
    expect((await alto.a.post(`/labor-rules/sets/${made.body.id}/retire`).send({})).status).toBe(404);
    expect((await alto.a.get('/labor-rules/sets')).body.sets.some((s: { id: string }) => s.id === made.body.id)).toBe(false);
  });

  it('the executive reads and cannot write; a pack is signed by the operator tenant only', async () => {
    const site = await flSite();
    const exec = await adminOf(ALTO_TENANT_ID, 'EXECUTIVE_CHAIRMAN');
    expect((await exec.a.get(`/labor-rules/sites/${site.id}`)).status).toBe(200);
    expect((await exec.a.post('/labor-rules/overrides').send({ level: 'TENANT', effectiveFrom: '2026-10-01', params: { custom: { x: 1 } }, source: 'Contract' })).status).toBe(403);

    const pack = await prisma.laborRuleSet.findFirstOrThrow({ where: { tenantId: null, jurisdiction: 'US-FL', effectiveFrom: new Date('2026-09-30T00:00:00Z') } });
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const two = await adminOf(T2);
    expect((await two.a.post(`/labor-rules/sets/${pack.id}/activate`).send({ note: 'We say so' })).status).toBe(403);
    expect((await two.a.patch(`/labor-rules/sets/${pack.id}`).send({ source: 'Our own reading' })).status).toBe(403);
    const alto = await adminOf();
    const signed = await alto.a.post(`/labor-rules/sets/${pack.id}/activate`).send({ note: 'Counsel memo CM-2026-14, 2026-10-15' });
    expect(signed.body.status).toBe('ACTIVE');
  });
});
