import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { createOrgUnit, regionSiteIds, siteIdsUnder, updateOrgUnit } from '../../lib/orgUnits.js';
import { scopeShifts, scopeTimeEntries, scopeAssociates } from '../../lib/scope.js';
import type { SessionUser } from '../../types/express.js';

/**
 * Brief 2-1b, step 5 — the organizational tree: a division over regions
 * over sites, permissions at any level by path, and Region mirrored into
 * it so the command center reads the tree (the owner's decisions 4 and 5).
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const sessionUser = (role: SessionUser['role'], overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: '00000000-0000-4000-8000-00000000aaaa',
  email: 'x@example.com',
  role,
  primaryRole: role,
  availableRoles: [role],
  status: 'ACTIVE',
  clientId: null,
  locationId: null,
  regionId: null,
  associateId: null,
  tokenVersion: 0,
  firstName: null,
  lastName: null,
  photoUrl: null,
  timezone: null,
  mfaEnabled: false,
  tenantId: ALTO_TENANT_ID,
  orgUnitId: null,
  orgUnitPath: null,
  ...overrides,
});

describe('the tree', () => {
  it('paths follow the parent, a move carries the subtree, a cycle is refused, "under" is one prefix', async () => {
    const division = await createOrgUnit(prisma, { type: 'DIVISION', name: 'Gulf Coast' });
    const east = await createOrgUnit(prisma, { type: 'REGION', name: 'Panhandle', parentId: division.id });
    const west = await createOrgUnit(prisma, { type: 'REGION', name: 'Emerald Coast', parentId: division.id });
    const cc = await createOrgUnit(prisma, { type: 'COST_CENTER', name: 'Housekeeping', parentId: east.id, glCode: '6100' });
    expect(division.path).toBe(`/${division.id}`);
    expect(east.path).toBe(`/${division.id}/${east.id}`);
    expect(cc.path).toBe(`/${division.id}/${east.id}/${cc.id}`);

    const moved = await updateOrgUnit(prisma, cc.id, { parentId: west.id });
    expect(moved.path).toBe(`/${division.id}/${west.id}/${cc.id}`);
    await expect(updateOrgUnit(prisma, division.id, { parentId: cc.id })).rejects.toMatchObject({ code: 'org_unit_cycle' });

    const client = await createClient('Coastal Resort');
    const a = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const b = await prisma.location.create({ data: { clientId: client.id, name: 'Pier Park', timezone: 'America/Chicago', orgUnitId: west.id } });
    await prisma.location.update({ where: { id: a.id }, data: { orgUnitId: east.id } });
    expect((await siteIdsUnder(prisma, division.id)).sort()).toEqual([a.id, b.id].sort());
    expect(await siteIdsUnder(prisma, east.id)).toEqual([a.id]);
    expect(await siteIdsUnder(prisma, cc.id)).toEqual([]);
  });

  it('the admin routes: create under a parent, pin sites, list the subtree\'s sites, delete moves children up and unpins', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const div = await admin.post('/admin/org-units').send({ type: 'DIVISION', name: 'Hotels' });
    expect(div.status).toBe(201);
    const reg = await admin.post('/admin/org-units').send({ type: 'REGION', name: 'Florida', parentId: div.body.unit.id, glCode: '5000' });
    expect(reg.body.unit.path).toBe(`/${div.body.unit.id}/${reg.body.unit.id}`);
    const client = await createClient('Coastal Resort');
    const site = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    expect((await admin.put(`/admin/org-units/${reg.body.unit.id}/sites`).send({ locationIds: [site.id] })).status).toBe(204);
    const under = await admin.get(`/admin/org-units/${div.body.unit.id}/sites`);
    expect(under.body.sites.map((s: { id: string }) => s.id)).toEqual([site.id]);
    const list = await admin.get('/admin/org-units');
    expect(list.body.units.map((u: { name: string; sites: number }) => [u.name, u.sites])).toEqual([['Hotels', 0], ['Florida', 1]]);

    expect((await admin.delete(`/admin/org-units/${div.body.unit.id}`)).status).toBe(204);
    const after = await admin.get('/admin/org-units');
    expect(after.body.units).toHaveLength(1);
    expect(after.body.units[0]).toMatchObject({ name: 'Florida', parentId: null, path: `/${reg.body.unit.id}` });
    expect((await prisma.location.findUniqueOrThrow({ where: { id: site.id } })).orgUnitId).toBe(reg.body.unit.id);
    // Nobody below manage:org writes the tree.
    const a = await createAssociate();
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    expect((await (await loginAs(agent(), assoc.email)).post('/admin/org-units').send({ type: 'DIVISION', name: 'X' })).status).toBe(403);
  });

  it('a site is edited in place: name, type, time zone, unit and active flag; a missing site or unit is refused', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const reg = await admin.post('/admin/org-units').send({ type: 'REGION', name: 'Gulf Coast' });
    const made = await admin.post('/admin/sites').send({ name: 'Grand Hotel', timezone: 'America/Chicago', state: 'FL' });
    expect(made.status).toBe(201);
    const id = made.body.site.id as string;
    const edited = await admin.patch(`/admin/sites/${id}`).send({ name: 'The Grand Hotel', type: 'OFFICE', timezone: 'America/New_York', orgUnitId: reg.body.unit.id, isActive: false });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.site).toMatchObject({ id, name: 'The Grand Hotel', type: 'OFFICE', timezone: 'America/New_York', orgUnitId: reg.body.unit.id, isActive: false, clientId: null });
    expect((await admin.get('/admin/sites')).body.sites).toEqual([expect.objectContaining({ id, orgUnitName: 'Gulf Coast', type: 'OFFICE', isActive: false })]);
    expect((await admin.patch(`/admin/sites/${id}`).send({ orgUnitId: null })).body.site.orgUnitId).toBeNull();
    expect((await admin.patch(`/admin/sites/${id}`).send({ orgUnitId: '00000000-0000-4000-8000-000000000099' })).body.error.code).toBe('org_unit_not_found');
    expect((await admin.patch('/admin/sites/00000000-0000-4000-8000-000000000098').send({ name: 'X' })).status).toBe(404);
    expect((await admin.patch(`/admin/sites/${id}`).send({ clientId: 'nope' })).status).toBe(400);
    const a = await createAssociate();
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    expect((await (await loginAs(agent(), assoc.email)).patch(`/admin/sites/${id}`).send({ name: 'X' })).status).toBe(403);
  });
});

describe('Region reads the tree', () => {
  it('a region made through its admin route is a REGION unit; its stores follow; the command center and its stores read the unit', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const client = await createClient('Coastal Resort');
    const a = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const b = await prisma.location.create({ data: { clientId: client.id, name: 'Pier Park', timezone: 'America/Chicago' } });
    const created = await admin.post('/regions').send({ name: 'Panhandle', locationIds: [a.id] });
    expect(created.status).toBe(201);
    const unit = await prisma.orgUnit.findUniqueOrThrow({ where: { legacyRegionId: created.body.id } });
    expect(unit).toMatchObject({ type: 'REGION', name: 'Panhandle' });
    expect(await regionSiteIds(prisma, created.body.id)).toEqual([a.id]);
    expect((await prisma.location.findUniqueOrThrow({ where: { id: a.id } })).orgUnitId).toBe(unit.id);

    expect((await admin.patch(`/regions/${created.body.id}`).send({ name: 'Florida Panhandle', locationIds: [a.id, b.id] })).status).toBe(204);
    expect((await regionSiteIds(prisma, created.body.id)).sort()).toEqual([a.id, b.id].sort());
    expect((await prisma.orgUnit.findUniqueOrThrow({ where: { legacyRegionId: created.body.id } })).name).toBe('Florida Panhandle');

    // The command center previews the region through the tree.
    const overview = await admin.get(`/region/overview?regionId=${created.body.id}`);
    expect(overview.status).toBe(200);
    expect(overview.body.totals.stores).toBe(2);

    expect((await admin.delete(`/regions/${created.body.id}`)).status).toBe(204);
    expect((await prisma.orgUnit.findUniqueOrThrow({ where: { legacyRegionId: created.body.id } })).deletedAt).not.toBeNull();
    expect((await prisma.location.findUniqueOrThrow({ where: { id: a.id } })).orgUnitId).toBeNull();
  });
});

describe('permission at any level', () => {
  it('an account pinned to a division sees the sites of every region under it, and nothing elsewhere', async () => {
    const division = await createOrgUnit(prisma, { type: 'DIVISION', name: 'Gulf Coast' });
    const east = await createOrgUnit(prisma, { type: 'REGION', name: 'Panhandle', parentId: division.id });
    const other = await createOrgUnit(prisma, { type: 'DIVISION', name: 'Mountain' });
    const client = await createClient('Coastal Resort');
    const a = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const b = await prisma.location.create({ data: { clientId: client.id, name: 'Elsewhere', timezone: 'America/Denver', orgUnitId: other.id } });
    await prisma.location.update({ where: { id: a.id }, data: { orgUnitId: east.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'East' });
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Mountain' });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: a.id, startedAt: new Date('2026-05-01') } });
    await prisma.associateAssignment.create({ data: { associateId: bo.id, locationId: b.id, startedAt: new Date('2026-05-01') } });
    const at = (h: number) => new Date(Date.now() + h * 3_600_000);
    const shiftA = await prisma.shift.create({ data: { clientId: client.id, locationId: a.id, position: 'Housekeeper', startsAt: at(24), endsAt: at(32), status: 'ASSIGNED', assignedAssociateId: ana.id } });
    await prisma.shift.create({ data: { clientId: client.id, locationId: b.id, position: 'Housekeeper', startsAt: at(24), endsAt: at(32), status: 'ASSIGNED', assignedAssociateId: bo.id } });
    const entryA = await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: null, locationId: a.id, clockInAt: at(-9), clockOutAt: at(-1), status: 'APPROVED' } });
    await prisma.timeEntry.create({ data: { associateId: bo.id, clientId: null, locationId: b.id, clockInAt: at(-9), clockOutAt: at(-1), status: 'APPROVED' } });

    const manager = sessionUser('SHIFT_SUPERVISOR', { orgUnitId: division.id, orgUnitPath: division.path });
    expect((await prisma.shift.findMany({ where: scopeShifts(manager), select: { id: true } })).map((s) => s.id)).toEqual([shiftA.id]);
    expect((await prisma.timeEntry.findMany({ where: scopeTimeEntries(manager), select: { id: true } })).map((s) => s.id)).toEqual([entryA.id]);
    expect((await prisma.associate.findMany({ where: scopeAssociates(manager), select: { id: true } })).map((s) => s.id)).toEqual([ana.id]);
    // A unit with nothing under it, or no unit at all, sees nothing.
    const empty = await createOrgUnit(prisma, { type: 'BUSINESS_UNIT', name: 'Nothing here' });
    expect(await prisma.shift.count({ where: scopeShifts(sessionUser('SHIFT_SUPERVISOR', { orgUnitId: empty.id, orgUnitPath: empty.path })) })).toBe(0);
    expect(await prisma.shift.count({ where: scopeShifts(sessionUser('SHIFT_SUPERVISOR')) })).toBe(0);
  });
});
