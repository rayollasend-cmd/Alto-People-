import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Brief 2-1b — the scheduling routes a direct employer's schedule page
 * calls, with a site and no client: bulk create, template apply and the
 * roster order. Each succeeds at the tenant's own site and fails closed
 * everywhere else. The client paths are covered where they always were:
 * schedulingBulkAssign.test.ts (bulk), scheduling.test.ts "site-timezone
 * times" (template apply) and rosterOrder.test.ts (roster order). The
 * duplicate tenant-wide roster row is refused by the partial index
 * (optionalClient.test.ts, "roster order: the same associate twice with no
 * client").
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

async function hotel() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const admin = await loginAs(agent(), hr.email);
  const site = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, type: 'PROPERTY', timezone: 'America/Chicago', state: 'FL' } });
  const place = async (firstName: string, lastName: string, locationId = site.id) => {
    const a = await createAssociate({ firstName, lastName });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId, startedAt: new Date('2026-05-01') } });
    return a;
  };
  return { admin, site, place };
}

const startsAt = '2026-11-20T14:00:00.000Z';
const endsAt = '2026-11-20T22:00:00.000Z';

describe('bulk create with a site and no client', () => {
  it('stamps the copies at the site with no client, and fails closed without a usable site', async () => {
    const { admin, site, place } = await hotel();
    const tess = await place('Tess', 'Member');

    const res = await admin.post('/scheduling/shifts/bulk').send({ locationId: site.id, position: 'Housekeeper', startsAt, endsAt, status: 'DRAFT', associateIds: [tess.id], openCount: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.created).toBe(2);
    const made = await prisma.shift.findMany({ where: { position: 'Housekeeper' }, select: { clientId: true, locationId: true, assignedAssociateId: true } });
    expect(made).toHaveLength(2);
    for (const s of made) expect(s).toMatchObject({ clientId: null, locationId: site.id });
    expect(made.map((s) => s.assignedAssociateId).sort()).toEqual([null, tess.id].sort());

    const body = { position: 'Housekeeper', startsAt, endsAt, status: 'DRAFT', associateIds: [], openCount: 1 };
    // Neither client nor site.
    expect((await admin.post('/scheduling/shifts/bulk').send(body)).body.error.code).toBe('site_required');
    // A deleted site.
    const gone = await prisma.site.create({ data: { name: 'Closed wing', clientId: null, deletedAt: new Date() } });
    expect((await admin.post('/scheduling/shifts/bulk').send({ ...body, locationId: gone.id })).status).toBe(404);
    // Another tenant's site.
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const theirs = await prisma.site.create({ data: { name: 'Their hotel', clientId: null, tenantId: T2 } });
    expect((await admin.post('/scheduling/shifts/bulk').send({ ...body, locationId: theirs.id })).status).toBe(404);
    // A client's site without its client.
    const client = await createClient('Coastal Resort');
    const clientSite = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    expect((await admin.post('/scheduling/shifts/bulk').send({ ...body, locationId: clientSite.id })).body.error.code).toBe('client_required');
    expect(await prisma.shift.count({ where: { position: 'Housekeeper' } })).toBe(2);
  });

  it('a client-bound supervisor cannot use it to land a shift at a client-less site', async () => {
    const { site } = await hotel();
    const client = await createClient('Coastal Resort');
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(agent(), sup.email);
    const res = await a.post('/scheduling/shifts/bulk').send({ locationId: site.id, position: 'Housekeeper', startsAt, endsAt, status: 'DRAFT', associateIds: [], openCount: 1 });
    expect(res.status).toBe(403);
  });
});

describe('template apply with a site and no client', () => {
  it('lands a global template at the site in the site\'s zone, refuses a double apply, and needs a client or a site', async () => {
    const { admin, site } = await hotel();
    const tpl = await prisma.shiftTemplate.create({ data: { clientId: null, name: 'Wed housekeeping', position: 'Housekeeper', dayOfWeek: 3, startMinute: 540, endMinute: 1020 } });

    const res = await admin.post(`/scheduling/templates/${tpl.id}/apply`).send({ weekStart: '2026-06-08T00:00:00Z', locationId: site.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Site-local week of Sun Jun 7 (Chicago); Wednesday Jun 10, 9:00 CDT = 14:00Z.
    expect(new Date(res.body.startsAt).toISOString()).toBe('2026-06-10T14:00:00.000Z');
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(shift).toMatchObject({ clientId: null, locationId: site.id, status: 'DRAFT' });

    expect((await admin.post(`/scheduling/templates/${tpl.id}/apply`).send({ weekStart: '2026-06-08T00:00:00Z', locationId: site.id })).body.error.code).toBe('duplicate_shift');
    expect((await admin.post(`/scheduling/templates/${tpl.id}/apply`).send({ weekStart: '2026-06-08T00:00:00Z' })).body.error.code).toBe('site_required');
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const theirs = await prisma.site.create({ data: { name: 'Their hotel', clientId: null, tenantId: T2 } });
    expect((await admin.post(`/scheduling/templates/${tpl.id}/apply`).send({ weekStart: '2026-06-15T00:00:00Z', locationId: theirs.id })).status).toBe(404);
  });
});

describe('the tenant-wide roster order', () => {
  it('a tenant without the client portal saves one order, and the by-site roster reads it', async () => {
    const { admin, site, place } = await hotel();
    expect((await admin.put('/admin/tenant/profile').send({ businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true })).status).toBe(200);
    const ana = await place('Ana', 'Alpha');
    const bo = await place('Bo', 'Beta');
    const cy = await place('Cy', 'Gamma');

    const before = await admin.get(`/scheduling/associates?locationId=${site.id}`);
    expect(before.body.associates.map((a: { id: string }) => a.id)).toEqual([ana.id, bo.id, cy.id]);

    const saved = await admin.post('/scheduling/roster-order').send({ orderedIds: [cy.id, ana.id] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const rows = await prisma.schedulingRosterOrder.findMany({ orderBy: { position: 'asc' } });
    expect(rows.map((r) => [r.associateId, r.clientId])).toEqual([[cy.id, null], [ana.id, null]]);
    const after = await admin.get(`/scheduling/associates?locationId=${site.id}`);
    expect(after.body.associates.map((a: { id: string }) => a.id)).toEqual([cy.id, ana.id, bo.id]);

    // An anchor move on the site's roster: Bo above Cy.
    const moved = await admin.post('/scheduling/roster-order').send({ locationId: site.id, moveId: bo.id, beforeId: cy.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const last = await admin.get(`/scheduling/associates?locationId=${site.id}`);
    expect(last.body.associates.map((a: { id: string }) => a.id)).toEqual([bo.id, cy.id, ana.id]);
  });

  it('fails closed: a bounded account cannot write it, and a tenant with the client portal must name the client', async () => {
    const { admin, place } = await hotel();
    const ana = await place('Ana', 'Alpha');
    // Alto HR's profile: the client portal is on.
    expect((await admin.post('/scheduling/roster-order').send({ orderedIds: [ana.id] })).body.error.code).toBe('client_required');

    expect((await admin.put('/admin/tenant/profile').send({ businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true })).status).toBe(200);
    const client = await createClient('Coastal Resort');
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(agent(), sup.email);
    expect((await a.post('/scheduling/roster-order').send({ orderedIds: [ana.id] })).status).toBe(403);
    expect(await prisma.schedulingRosterOrder.count()).toBe(0);
  });
});
