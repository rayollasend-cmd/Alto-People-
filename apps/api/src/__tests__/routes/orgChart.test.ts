import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The org chart, two ways: Company (the office and every reporting line,
 * open seats under their manager) and Field (region → client → store →
 * leads → crew, today's coverage, the unplaced in one group) — both inside
 * the caller's reach.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

type N = { id: string; parentId: string | null; kind: string; name: string; subtitle: string | null; role: string | null; reports: number; shiftsToday: number | null; filledToday: number | null; positionStatus: string | null };
const byName = (nodes: N[], name: string) => nodes.find((n) => n.name === name);

describe('company view', () => {
  it('draws the office and every reporting line; field-only people are counted, not drawn', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'fin@example.com' });
    await createUser({ role: 'SHIFT_SUPERVISOR', email: 'lead@example.com' });
    const boss = await createAssociate({ firstName: 'Ada', lastName: 'Boss' });
    const report = await createAssociate({ firstName: 'Ben', lastName: 'Report' });
    await prisma.associate.update({ where: { id: report.id }, data: { managerId: boss.id } });
    await createAssociate({ firstName: 'Fay', lastName: 'Field' });
    const gone = await createAssociate({ firstName: 'Gil', lastName: 'Gone' });
    await prisma.associate.update({ where: { id: gone.id }, data: { managerId: boss.id, deactivatedAt: new Date() } });
    await prisma.position.create({ data: { code: 'P-1', title: 'Payroll analyst', status: 'OPEN', managerAssociateId: boss.id } });
    await prisma.position.create({ data: { code: 'P-2', title: 'Recruiter', status: 'PLANNED' } });

    const a = await loginAs(hr.email);
    const res = await a.get('/org/chart?view=company');
    expect(res.status).toBe(200);
    const nodes = res.body.nodes as N[];

    // Office accounts with no person record, named by role; field leads are not office.
    expect(byName(nodes, 'hr@example.com')).toMatchObject({ kind: 'staff', role: 'HR_ADMINISTRATOR', parentId: null });
    expect(byName(nodes, 'fin@example.com')).toBeTruthy();
    expect(byName(nodes, 'lead@example.com')).toBeUndefined();
    // The reporting line, with the seat the manager is hiring for.
    const ada = byName(nodes, 'Ada Boss')!;
    expect(byName(nodes, 'Ben Report')!.parentId).toBe(ada.id);
    expect(byName(nodes, 'Payroll analyst')).toMatchObject({ kind: 'vacancy', parentId: ada.id, positionStatus: 'OPEN' });
    expect(byName(nodes, 'Recruiter')).toMatchObject({ kind: 'vacancy', parentId: 'group:open-seats', positionStatus: 'PLANNED' });
    // Former people only when asked; field-only people left to Field.
    expect(byName(nodes, 'Gil Gone')).toBeUndefined();
    expect(byName(nodes, 'Fay Field')).toBeUndefined();
    expect(res.body.fieldOnly).toBe(1);
    expect(ada.reports).toBe(1); // people only — the open seat is drawn beside them

    const withFormer = await a.get('/org/chart?view=company&former=1');
    expect(byName(withFormer.body.nodes, 'Gil Gone')).toBeTruthy();
  });

  it('records who an office account reports to, and refuses a loop', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
    const a = await loginAs(hr.email);

    expect((await a.put(`/org/staff/${ops.id}/reports-to`).send({ managerUserId: ops.id })).status).toBe(400);
    expect((await a.put(`/org/staff/${ops.id}/reports-to`).send({ managerUserId: hr.id })).status).toBe(200);
    expect((await a.put(`/org/staff/${hr.id}/reports-to`).send({ managerUserId: ops.id })).status).toBe(409);

    const nodes = (await a.get('/org/chart?view=company')).body.nodes as N[];
    expect(byName(nodes, 'ops@example.com')!.parentId).toBe(byName(nodes, 'hr@example.com')!.id);
    expect(byName(nodes, 'hr@example.com')!.reports).toBe(1);

    // Only those who manage the org can move people.
    const { user: rec } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'rec@example.com' });
    const recAgent = await loginAs(rec.email);
    expect((await recAgent.put(`/org/staff/${hr.id}/reports-to`).send({ managerUserId: null })).status).toBe(403);
  });
});

describe('field view', () => {
  it('region → client → store → leads → crew, with today’s coverage and the unplaced', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const region = await prisma.region.create({ data: { name: 'Panhandle' } });
    const client = await createClient('Coastal Resorts');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: store.id }, data: { regionId: region.id, name: 'Front Beach' } });
    const lead = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'lead@example.com', clientId: client.id });
    await prisma.user.update({ where: { id: lead.user.id }, data: { locationId: store.id, displayName: 'Lee Lead' } });
    const crew = await createAssociate({ firstName: 'Cal', lastName: 'Crew' });
    await prisma.associateAssignment.create({ data: { associateId: crew.id, locationId: store.id, startedAt: new Date() } });
    await createAssociate({ firstName: 'Una', lastName: 'Placed' });
    const now = new Date();
    await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Cashier', startsAt: now, endsAt: new Date(now.getTime() + 3_600_000), status: 'ASSIGNED', assignedAssociateId: crew.id } });
    await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Cashier', startsAt: now, endsAt: new Date(now.getTime() + 3_600_000), status: 'OPEN' } });

    const a = await loginAs(hr.email);
    const res = await a.get('/org/chart?view=field');
    expect(res.status).toBe(200);
    const nodes = res.body.nodes as N[];
    const r = byName(nodes, 'Panhandle')!;
    const c = byName(nodes, 'Coastal Resorts')!;
    const s = byName(nodes, 'Front Beach')!;
    expect(r.kind).toBe('region');
    expect(c.parentId).toBe(r.id);
    expect(s).toMatchObject({ kind: 'store', parentId: c.id, shiftsToday: 2, filledToday: 1, reports: 1 });
    expect(byName(nodes, 'Lee Lead')).toMatchObject({ kind: 'lead', parentId: s.id });
    expect(byName(nodes, 'Cal Crew')).toMatchObject({ kind: 'person', parentId: s.id });
    expect(byName(nodes, 'Not yet placed')).toMatchObject({ kind: 'group', reports: 1 });
    expect(byName(nodes, 'Una Placed')!.parentId).toBe('group:unplaced');
    expect(res.body.unplaced).toBe(1);
  });

  it('a site-bound lead of the office sees only their sites and their people — here and in the old list', async () => {
    const north = await createClient('North Co');
    const south = await createClient('South Co');
    const northStore = await prisma.site.findFirstOrThrow({ where: { clientId: north.id } });
    const southStore = await prisma.site.findFirstOrThrow({ where: { clientId: south.id } });
    const n1 = await createAssociate({ firstName: 'Nia', lastName: 'North' });
    const s1 = await createAssociate({ firstName: 'Sam', lastName: 'South' });
    await prisma.associateAssignment.create({ data: { associateId: n1.id, locationId: northStore.id, startedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: s1.id, locationId: southStore.id, startedAt: new Date() } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [northStore.id] } });

    const a = await loginAs(ops.email);
    const field = (await a.get('/org/chart?view=field')).body.nodes as N[];
    expect(byName(field, 'Nia North')).toBeTruthy();
    expect(byName(field, 'Sam South')).toBeUndefined();
    expect(byName(field, 'South Co')).toBeUndefined();

    const old = await a.get('/org/associates');
    const names = (old.body.associates as Array<{ firstName: string }>).map((x) => x.firstName);
    expect(names).toContain('Nia');
    expect(names).not.toContain('Sam');
  });

  it('a direct employer’s property (no client) hangs straight off its region', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const region = await prisma.region.create({ data: { name: 'Gulf' } });
    const hotel = await prisma.site.create({ data: { name: 'The Grand', type: 'PROPERTY', timezone: 'America/Chicago', regionId: region.id } });
    const a1 = await createAssociate({ firstName: 'Rio', lastName: 'Room' });
    await prisma.associateAssignment.create({ data: { associateId: a1.id, locationId: hotel.id, startedAt: new Date() } });
    const a = await loginAs(hr.email);
    const nodes = (await a.get('/org/chart?view=field')).body.nodes as N[];
    const r = byName(nodes, 'Gulf')!;
    expect(byName(nodes, 'The Grand')).toMatchObject({ kind: 'store', parentId: r.id, reports: 1 });
    expect(nodes.some((n) => n.kind === 'client')).toBe(false);
  });

  it('narrows to one client', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const one = await createClient('One Co');
    await createClient('Two Co');
    const a = await loginAs(hr.email);
    const nodes = (await a.get(`/org/chart?view=field&clientId=${one.id}`)).body.nodes as N[];
    expect(byName(nodes, 'One Co')).toBeTruthy();
    expect(byName(nodes, 'Two Co')).toBeUndefined();
  });
});

describe('field view at enterprise size', () => {
  it('sends structure and counts, loads a store’s crew on request, searches on the server — all within reach', async () => {
    const { buildOrgChart } = await import('../../lib/orgChart.js');
    const { runWithTenant, ALTO_TENANT_ID } = await import('../../lib/tenant.js');
    const north = await createClient('North Co');
    const south = await createClient('South Co');
    const a = await prisma.site.findFirstOrThrow({ where: { clientId: north.id } });
    const b = await prisma.site.findFirstOrThrow({ where: { clientId: south.id } });
    const cal = await createAssociate({ firstName: 'Cal', lastName: 'Crew' });
    const sam = await createAssociate({ firstName: 'Sam', lastName: 'South' });
    await prisma.associateAssignment.create({ data: { associateId: cal.id, locationId: a.id, startedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: sam.id, locationId: b.id, startedAt: new Date() } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr-scale@example.com' });

    // Past the inline threshold the chart carries no crew names, only counts.
    const sessionUser = { id: hr.id, role: 'HR_ADMINISTRATOR', clientId: null, associateId: null, tenantId: ALTO_TENANT_ID, scopeSiteIds: [], scopeRegionIds: [] } as never;
    const deferred = await runWithTenant(ALTO_TENANT_ID, 'session', () => buildOrgChart(sessionUser, { view: 'field', crewInline: 0 }));
    expect(deferred.crewDeferred).toBe(true);
    expect(deferred.nodes.some((n) => n.kind === 'person' && n.parentId === `s:${a.id}`)).toBe(false);
    expect(deferred.nodes.find((n) => n.id === `s:${a.id}`)?.reports).toBe(1);

    const h = await loginAs(hr.email);
    const crew = await h.get(`/org/chart/crew?siteId=${a.id}`);
    expect(crew.status).toBe(200);
    expect(crew.body.nodes.map((n: { name: string }) => n.name)).toEqual(['Cal Crew']);
    const found = await h.get('/org/chart/search?q=sam');
    expect(found.body.nodes).toEqual([expect.objectContaining({ name: 'Sam South', parentId: `s:${b.id}` })]);

    // A store-bound office account gets nothing from a store outside its reach.
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops-scale@example.com' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [a.id] } });
    const o = await loginAs(ops.email);
    expect((await o.get(`/org/chart/crew?siteId=${b.id}`)).body.nodes).toEqual([]);
    expect((await o.get('/org/chart/search?q=sam')).body.nodes).toEqual([]);
  });
});
