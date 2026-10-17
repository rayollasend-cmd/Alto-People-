import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '@alto-people/shared';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { __resetBrandingCacheForTests, ensureBrandingLoaded, getBrandingSync, orgSettingIdFor } from '../../lib/branding.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { WA_REPLY } from '../../lib/whatsappContent.js';

/**
 * The assistant's name is each tenant's own: OrgSetting is one row per
 * tenant (tenantId unique; Alto HR keeps id 'singleton'), the branding
 * cache is keyed by tenant, the session carries the name, and the registry
 * record and the WhatsApp introduction read it at read time.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
  __resetBrandingCacheForTests();
});
afterAll(async () => {
  invalidateTenantProfile();
  __resetBrandingCacheForTests();
  await prisma.$disconnect();
});

async function twoTenants() {
  const { user: altoHr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
  const { user: twoHr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@tenant-two.test' });
  await prisma.user.update({ where: { id: twoHr.id }, data: { tenantId: T2 } });
  return { altoHr, twoHr, alto: await loginAs(agent(), altoHr.email), two: await loginAs(agent(), twoHr.email) };
}

describe('one name per tenant', () => {
  it('each tenant reads and writes its own row; the cache, the session and the defaults are per tenant', async () => {
    const w = await twoTenants();
    // Before any write: Alto HR's defaults, and the other tenant's own name as its org name.
    expect((await w.alto.get('/admin/org/settings')).body).toMatchObject({ orgName: 'Alto HR', assistantName: 'Hugo' });
    expect((await w.two.get('/admin/org/settings')).body).toMatchObject({ orgName: 'Tenant Two', assistantName: 'Hugo' });

    expect((await w.two.patch('/admin/org/settings').send({ assistantName: 'Coco' })).status).toBe(200);
    expect((await w.alto.patch('/admin/org/settings').send({ assistantName: 'Max' })).status).toBe(200);
    expect((await w.two.get('/admin/org/settings')).body.assistantName).toBe('Coco');
    expect((await w.alto.get('/admin/org/settings')).body.assistantName).toBe('Max');

    // Two rows: the historical singleton for Alto HR, a derived id for the other tenant.
    const rows = await prisma.orgSetting.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id, r.tenantId, r.assistantName])).toEqual([
      [orgSettingIdFor(T2), T2, 'Coco'],
      ['singleton', ALTO_TENANT_ID, 'Max'],
    ]);
    expect(orgSettingIdFor(T2)).toHaveLength(16);

    // The cache is keyed by tenant, and the tenant in context picks the entry.
    expect(getBrandingSync(ALTO_TENANT_ID).assistantName).toBe('Max');
    expect(getBrandingSync(T2).assistantName).toBe('Coco');
    expect(await runWithTenant(T2, 'job', async () => getBrandingSync().assistantName)).toBe('Coco');
    expect(await runWithTenant(ALTO_TENANT_ID, 'job', async () => getBrandingSync().assistantName)).toBe('Max');
    // The other tenant's first write kept its own name as the org name, not Alto HR's.
    expect((await ensureBrandingLoaded(prisma, T2)).orgName).toBe('Tenant Two');
    expect(getBrandingSync(ALTO_TENANT_ID).orgName).toBe('Alto HR');

    // The session carries the name, so the screens can read it at once.
    expect((await w.two.get('/auth/me')).body.tenant).toMatchObject({ id: T2, assistantName: 'Coco' });
    expect((await w.alto.get('/auth/me')).body.tenant).toMatchObject({ id: ALTO_TENANT_ID, assistantName: 'Max' });

    // Renaming one tenant leaves the other's cache alone.
    expect((await w.two.patch('/admin/org/settings').send({ assistantName: 'Nova' })).status).toBe(200);
    expect(getBrandingSync(T2).assistantName).toBe('Nova');
    expect(getBrandingSync(ALTO_TENANT_ID).assistantName).toBe('Max');
  });

  it('the registry record and the WhatsApp introduction use the tenant\'s name', async () => {
    const w = await twoTenants();
    await w.two.patch('/admin/org/settings').send({ assistantName: 'Coco' });
    await w.alto.patch('/admin/org/settings').send({ assistantName: 'Max' });
    await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
    await ensureBuiltInAgents(prisma, T2);

    const name = async (a: typeof w.alto) => {
      const res = await a.get('/agents');
      expect(res.status).toBe(200);
      return (res.body.agents as Array<{ name: string; profile: { builtInKey: string | null } }>).find((x) => x.profile.builtInKey === 'whatsapp-assistant')?.name;
    };
    expect(await name(w.two)).toBe('Coco on WhatsApp');
    expect(await name(w.alto)).toBe('Max on WhatsApp');

    // The introduction: the tenant's name, the product name once.
    const intro = await runWithTenant(T2, 'job', async () => WA_REPLY.intro('en', getBrandingSync().assistantName));
    expect(intro).toMatch(/^I'm Coco, the AI assistant in Alto People\. I'm not a person\./);
    for (const lang of ['en', 'es', 'tr'] as const) {
      for (const line of [WA_REPLY.intro(lang, 'Coco'), WA_REPLY.whoAmI(lang, 'Coco'), WA_REPLY.appIntro(lang, 'Coco', [])]) {
        expect(line.split(PRODUCT_NAME).length - 1, `${lang}: ${line}`).toBe(1);
        expect(line).toContain('Coco');
      }
    }
  });
});
