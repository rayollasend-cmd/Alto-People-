import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { activeBreakdown, activeHeadcount } from '../../lib/activeDefinition.js';
import { computeExecutiveSummary } from '../../lib/executiveSummary.js';

/**
 * Brief 2-1 — totals never mix tenants.
 *
 *   The cross-tenant suite catches another tenant's ids in a response; a
 *   count carries no ids, so this test checks the numbers themselves: each
 *   tenant's active headcount, headcount overview and executive summary
 *   count its own people only. Called without a tenant, the lib still
 *   counts everyone (crons and scripts that predate tenants).
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** One active person: placed at the site, with an assigned shift ahead. */
async function activePerson(siteId: string, clientId: string | null, tenantId: string, first: string) {
  const a = await createAssociate({ firstName: first, lastName: 'Active', email: `${first.toLowerCase()}@example.com` });
  await prisma.associate.update({ where: { id: a.id }, data: { tenantId } });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date('2026-01-01'), tenantId } });
  const startsAt = new Date(Date.now() + 2 * DAY);
  await prisma.shift.create({
    data: { tenantId, clientId, locationId: siteId, position: 'Housekeeper', startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: a.id },
  });
  return a;
}

describe('tenant totals', () => {
  it('each tenant counts its own active people: the active rule, the headcount overview and the executive summary', async () => {
    // Tenant one (Alto HR): a client store with one active person.
    const client = await createClient('Coastal Resort');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await activePerson(store.id, client.id, ALTO_TENANT_ID, 'Ana');

    // Tenant two: a client-less property with two active people.
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const property = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, type: 'PROPERTY', tenantId: T2 } });
    await activePerson(property.id, null, T2, 'Tess');
    await activePerson(property.id, null, T2, 'Omar');

    // The rule: scoped, each tenant's own; unscoped, everyone (unchanged).
    expect(await activeHeadcount({ tenantId: ALTO_TENANT_ID })).toBe(1);
    expect(await activeHeadcount({ tenantId: T2 })).toBe(2);
    expect(await activeHeadcount()).toBe(3);
    expect((await activeBreakdown(new Date(), prisma, undefined, { tenantId: T2 })).total).toBe(2);

    // The executive summary reads one tenant.
    expect((await computeExecutiveSummary(prisma, new Date(), { tenantId: ALTO_TENANT_ID })).workforce.active).toBe(1);
    expect((await computeExecutiveSummary(prisma, new Date(), { tenantId: T2 })).workforce.active).toBe(2);

    // The headcount overview, as each tenant's HR administrator.
    const { user: altoAdmin } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'admin@alto.example' });
    const { user: twoAdmin } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'admin@tenant-two.example' });
    await prisma.user.update({ where: { id: twoAdmin.id }, data: { tenantId: T2 } });
    const alto = await loginAs(agent(), altoAdmin.email);
    const two = await loginAs(agent(), twoAdmin.email);

    const altoOverview = await alto.get('/headcount/overview');
    expect(altoOverview.status, JSON.stringify(altoOverview.body)).toBe(200);
    expect(altoOverview.body.active).toBe(1);
    const twoOverview = await two.get('/headcount/overview');
    expect(twoOverview.status, JSON.stringify(twoOverview.body)).toBe(200);
    expect(twoOverview.body.active).toBe(2);

    const altoTurnover = await alto.get('/headcount/turnover?days=90');
    expect(altoTurnover.body.currentActive).toBe(1);
    const twoTurnover = await two.get('/headcount/turnover?days=90');
    expect(twoTurnover.body.currentActive).toBe(2);
  });
});
