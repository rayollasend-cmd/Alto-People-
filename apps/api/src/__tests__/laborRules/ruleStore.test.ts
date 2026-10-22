import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { loadRulePool, packsDifferingFromCode, rulesForSite } from '../../lib/laborRules/index.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-2 step 2 — the rule sets stored.
 *
 *   The migration's packs equal the code's; the partial unique indexes and
 *   checks refuse a second ACTIVE set for the same date, an ACTIVE set no one
 *   signed, and an override without its owner; a tenant's override never
 *   moves another tenant's resolution (acceptance line 3, the storage half);
 *   a site's override reaches that site only. The Rules routes read it.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const D = (s: string) => new Date(`${s}T00:00:00Z`);

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function siteIn(state: string, city: string | null = null, tenantId = ALTO_TENANT_ID) {
  const c = await createClient(`Client ${state} ${Math.random().toString(36).slice(2, 6)}`);
  const s = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  return prisma.site.update({ where: { id: s.id }, data: { state, city, tenantId }, select: { id: true, state: true, city: true } });
}

const override = (data: Partial<Prisma.LaborRuleSetUncheckedCreateInput>) =>
  prisma.laborRuleSet.create({
    data: { jurisdiction: 'TENANT', level: 'TENANT', effectiveFrom: D('2026-01-01'), version: 1, params: {}, source: 'Union contract §4', sourceDate: D('2026-01-01'), ...data } as Prisma.LaborRuleSetUncheckedCreateInput,
  });

describe('the stored packs', () => {
  it('equal the code, and are DRAFT until someone signs', async () => {
    expect(await packsDifferingFromCode(prisma)).toEqual([]);
    const packs = await prisma.laborRuleSet.findMany({ where: { tenantId: null } });
    expect(packs.length).toBeGreaterThanOrEqual(5);
    expect(packs.every((p) => p.status === 'DRAFT' && p.approvedAt === null)).toBe(true);
  });

  it('refuses an ACTIVE set no one signed, a second ACTIVE set for one date, and an override without its tenant', async () => {
    const fl = await prisma.laborRuleSet.findFirstOrThrow({ where: { tenantId: null, jurisdiction: 'US-FL', effectiveFrom: D('2026-09-30') } });
    await expect(prisma.laborRuleSet.update({ where: { id: fl.id }, data: { status: 'ACTIVE' } })).rejects.toThrow();

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.laborRuleSet.update({ where: { id: fl.id }, data: { status: 'ACTIVE', approvedAt: new Date(), approvedByUserId: user.id, approvalNote: 'Counsel memo 2026-10-15' } });
    await expect(
      prisma.laborRuleSet.create({ data: { tenantId: null, jurisdiction: 'US-FL', level: 'STATE', effectiveFrom: D('2026-09-30'), version: 2, params: {}, source: 'x', sourceDate: D('2026-10-15'), status: 'ACTIVE', approvedAt: new Date() } }),
    ).rejects.toThrow();
    await expect(
      prisma.laborRuleSet.create({ data: { tenantId: null, jurisdiction: 'US-FL', level: 'STATE', effectiveFrom: D('2026-09-30'), version: 1, params: {}, source: 'x', sourceDate: D('2026-10-15') } }),
    ).rejects.toThrow();

    await expect(override({ tenantId: null })).rejects.toThrow();
    await expect(override({ tenantId: ALTO_TENANT_ID, level: 'SITE' })).rejects.toThrow();

    const pool = await loadRulePool(prisma, ALTO_TENANT_ID);
    const site = await siteIn('FL');
    expect(rulesForSite(pool, site, '2026-10-15').payable).toBe(false); // federal still DRAFT
  });
});

describe('overrides', () => {
  it('a tenant’s override never moves another tenant’s rules; a site’s reaches that site only', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const alto = await siteIn('FL');
    const altoOther = await siteIn('FL');
    const two = await siteIn('FL', null, T2);
    await override({ tenantId: T2, params: { overtime: { weeklyThreshold: 37.5 } } });
    await override({ tenantId: ALTO_TENANT_ID, level: 'SITE', jurisdiction: 'SITE', siteId: altoOther.id, params: { restBetweenShifts: { minHours: 11, premiumHours: 1 } } });

    const altoPool = await loadRulePool(prisma, ALTO_TENANT_ID);
    const twoPool = await loadRulePool(prisma, T2);
    expect(rulesForSite(altoPool, alto, '2026-10-15').params.overtime?.weeklyThreshold).toBe(40);
    expect(rulesForSite(twoPool, two, '2026-10-15').params.overtime?.weeklyThreshold).toBe(37.5);
    expect(rulesForSite(altoPool, alto, '2026-10-15').params.restBetweenShifts?.minHours ?? null).toBeNull();
    expect(rulesForSite(altoPool, altoOther, '2026-10-15').params.restBetweenShifts?.minHours).toBe(11);
    expect(twoPool.some((s) => s.tenantId === ALTO_TENANT_ID)).toBe(false);
  });
});

describe('the Rules routes', () => {
  it('list each site with its jurisdictions and the rules in force, and one site with where each value came from', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), user.email);
    const fl = await siteIn('FL', 'Destin');
    await siteIn('AL');

    const list = await admin.get('/labor-rules/sites?date=2026-10-15');
    expect(list.status).toBe(200);
    const row = (list.body.sites as Array<{ id: string; jurisdictions: string[]; summary: { minimumWageCents: number; weeklyOvertimeHours: number }; payable: boolean }>).find((s) => s.id === fl.id)!;
    expect(row.jurisdictions).toEqual(['FEDERAL', 'US-FL', 'US-FL-DESTIN']);
    expect(row.summary).toMatchObject({ minimumWageCents: 1500, weeklyOvertimeHours: 40 });
    expect(row.payable).toBe(false);

    const one = await admin.get(`/labor-rules/sites/${fl.id}?date=2025-10-01`);
    expect(one.body.summary.minimumWageCents).toBe(1400);
    expect(one.body.origin['minimumWage.rateCents']).toBe('US-FL 2025-09-30 v1');
    expect(one.body.sets.map((s: { jurisdiction: string }) => s.jurisdiction)).toEqual(['FEDERAL', 'US-FL']);

    const sets = await admin.get('/labor-rules/sets');
    expect(sets.body.sets.every((s: { shipped: boolean; source: string }) => s.shipped && s.source.length > 10)).toBe(true);

    // Version 2 of the New York and California packs (audit 2026-10-21 #11): spread of hours and split shifts.
    const ny = await siteIn('NY', 'Albany');
    const ca = await siteIn('CA', 'Los Angeles');
    const nyOne = await admin.get(`/labor-rules/sites/${ny.id}?date=2026-10-15`);
    expect(nyOne.body.summary).toMatchObject({ spreadOfHoursHours: 10, splitShiftPremium: true });
    expect(nyOne.body.origin['spreadOfHours.thresholdHours']).toBe('US-NY 2026-01-01 v2');
    const caOne = await admin.get(`/labor-rules/sites/${ca.id}?date=2026-10-15`);
    expect(caOne.body.summary).toMatchObject({ spreadOfHoursHours: null, splitShiftPremium: true });
    expect(one.body.summary).toMatchObject({ spreadOfHoursHours: null, splitShiftPremium: false });
  });

  it('are not an associate’s to read (view:payroll reaches every associate; these need process:payroll, manage:org or view:executive)', async () => {
    const a = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const me = await loginAs(agent(), user.email);
    expect((await me.get('/labor-rules/sites')).status).toBe(403);
  });
});
