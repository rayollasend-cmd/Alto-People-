import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { issueScimToken } from '../../lib/identity.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Brief 2-3 step 3 — custom roles over archetypes, the permission matrix,
 * module-hidden roles refused by the API, and SCIM groups mapped to roles.
 */

beforeEach(truncateAll);
afterAll(async () => {
  await prisma.$disconnect();
});

async function admin() {
  const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
  return { user, a: await loginAs(agent(), user.email) };
}

describe('the permission matrix', () => {
  it('lists every capability, the built-in roles read-only, and custom roles', async () => {
    const { a } = await admin();
    const made = await a.post('/tenant-roles').send({ name: 'Team lead (no audit)', archetype: 'MANAGER', capabilities: ['view:dashboard', 'view:my-team'] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const res = await a.get('/tenant-roles');
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toContain('view:audit');
    const sys = res.body.roles.find((r: { id: string }) => r.id === 'system:MANAGER');
    expect(sys.system).toBe(true);
    expect(sys.capabilities).toContain('view:audit');
    const custom = res.body.roles.find((r: { id: string }) => r.id === made.body.id);
    expect(custom).toMatchObject({ system: false, archetype: 'MANAGER', capabilities: ['view:dashboard', 'view:my-team'], holders: 0 });
  });

  it('a custom role can only narrow its archetype, and nobody grants what they lack', async () => {
    const { a } = await admin();
    const outside = await a.post('/tenant-roles').send({ name: 'Wide', archetype: 'ASSOCIATE', capabilities: ['manage:org'] });
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe('outside_archetype');
    // Operations Manager lacks export:payroll-pii; HR Administrator holds it.
    const over = await a.post('/tenant-roles').send({ name: 'PII', archetype: 'HR_ADMINISTRATOR', capabilities: ['export:payroll-pii'] });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('role_escalation_forbidden');
  });

  it('the executive reads the matrix and changes nothing', async () => {
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/tenant-roles')).status).toBe(200);
    expect((await a.post('/tenant-roles').send({ name: 'x', archetype: 'MANAGER', capabilities: [] })).status).toBe(403);
  });
});

describe('holding a custom role', () => {
  it('narrows the gates on the next request, shows on /auth/me, and is audited before/after', async () => {
    const { a, user: actor } = await admin();
    const { user: lead } = await createUser({ role: 'MANAGER' });
    const la = await loginAs(agent(), lead.email);
    expect((await la.get('/audit/logs')).status).toBe(200);

    const made = await a.post('/tenant-roles').send({ name: 'Team lead (no audit)', archetype: 'MANAGER', capabilities: ['view:dashboard', 'view:my-team'] });
    const assigned = await a.put(`/tenant-roles/assign/${lead.id}`).send({ tenantRoleId: made.body.id });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    expect((await la.get('/audit/logs')).status).toBe(403);
    const me = await la.get('/auth/me');
    expect(me.body.user.capabilities).toEqual(['view:dashboard', 'view:my-team']);
    expect(me.body.user.tenantRoleName).toBe('Team lead (no audit)');

    // Widening the role reaches the holder at once.
    const widened = await a.patch(`/tenant-roles/${made.body.id}`).send({ capabilities: ['view:dashboard', 'view:my-team', 'view:audit'] });
    expect(widened.status).toBe(200);
    expect((await la.get('/audit/logs')).status).toBe(200);

    await flushPendingAudits();
    const rows = await prisma.auditLog.findMany({ where: { action: 'permission.changed' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => (r.metadata as { change: string }).change)).toEqual(['role.created', 'user.role_assigned', 'role.updated']);
    expect(rows.every((r) => r.actorUserId === actor.id && r.tenantId === ALTO_TENANT_ID)).toBe(true);
    expect(rows[2]!.metadata).toMatchObject({ added: ['view:audit'], removed: [], before: { capabilities: ['view:dashboard', 'view:my-team'] } });
  });

  it('refuses a role made for another archetype, and a delete that would widen its holders', async () => {
    const { a } = await admin();
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const { user: lead } = await createUser({ role: 'MANAGER' });
    const made = await a.post('/tenant-roles').send({ name: 'Lead', archetype: 'MANAGER', capabilities: ['view:dashboard'] });
    const mismatch = await a.put(`/tenant-roles/assign/${assoc.id}`).send({ tenantRoleId: made.body.id });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('archetype_mismatch');

    await a.put(`/tenant-roles/assign/${lead.id}`).send({ tenantRoleId: made.body.id });
    const inUse = await a.delete(`/tenant-roles/${made.body.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('role_in_use');

    expect((await a.put(`/tenant-roles/assign/${lead.id}`).send({ tenantRoleId: null })).status).toBe(200);
    expect((await a.delete(`/tenant-roles/${made.body.id}`)).status).toBe(204);
  });

  it('a change of base role drops the custom role (it narrowed the old one)', async () => {
    const { a } = await admin();
    const { user: lead } = await createUser({ role: 'MANAGER' });
    const made = await a.post('/tenant-roles').send({ name: 'Lead', archetype: 'MANAGER', capabilities: ['view:dashboard'] });
    await a.put(`/tenant-roles/assign/${lead.id}`).send({ tenantRoleId: made.body.id });
    const res = await a.patch(`/admin/users/${lead.id}`).send({ role: 'WORKFORCE_MANAGER' });
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: lead.id } })).tenantRoleId).toBeNull();
  });

  it('a narrowed admin cannot hand out the powers it was narrowed out of', async () => {
    const { a } = await admin();
    const { user: narrow } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const made = await a.post('/tenant-roles').send({ name: 'Ops (people only)', archetype: 'OPERATIONS_MANAGER', capabilities: ['view:dashboard', 'manage:org'] });
    await a.put(`/tenant-roles/assign/${narrow.id}`).send({ tenantRoleId: made.body.id });
    const na = await loginAs(agent(), narrow.email);
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const res = await na.patch(`/admin/users/${target.id}`).send({ role: 'MANAGER' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('role_escalation_forbidden');
  });
});

describe('module-hidden roles (gap 7)', () => {
  it('the API refuses a role whose module is off', async () => {
    const { a } = await admin();
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    await prisma.tenant.update({ where: { id: ALTO_TENANT_ID }, data: { modules: { transportation: false } } });
    const res = await a.patch(`/admin/users/${target.id}`).send({ role: 'DRIVER' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('role_module_off');
    const custom = await a.post('/tenant-roles').send({ name: 'Van', archetype: 'DRIVER', capabilities: ['view:dashboard'] });
    expect(custom.status).toBe(400);
    await prisma.tenant.update({ where: { id: ALTO_TENANT_ID }, data: { modules: {} } });
    expect((await a.patch(`/admin/users/${target.id}`).send({ role: 'DRIVER' })).status).toBe(204);
  });
});

describe('SCIM groups → roles', () => {
  it('a member of a mapped group holds the mapped role; leaving it demotes nobody', async () => {
    const { a, user: actor } = await admin();
    const { token } = await issueScimToken(prisma, ALTO_TENANT_ID, 'Okta', actor.id);
    const scim = (req: ReturnType<ReturnType<typeof agent>['post']>) => req.set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/scim+json');
    const { user: person } = await createUser({ role: 'ASSOCIATE' });

    const made = await a.post('/tenant-roles').send({ name: 'Store lead', archetype: 'MANAGER', capabilities: ['view:dashboard', 'view:my-team'] });
    const mapped = await a.post('/tenant-roles/scim-groups').send({ groupName: 'Alto Store Leads', archetype: 'MANAGER', tenantRoleId: made.body.id });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(201);
    expect((await a.post('/tenant-roles/scim-groups').send({ groupName: 'Portal', archetype: 'CLIENT_PORTAL' })).status).toBe(400);

    const g = await scim(agent().post('/scim/v2/Groups')).send({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Alto Store Leads', members: [{ value: person.id }] });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    let row = await prisma.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(row.role).toBe('MANAGER');
    expect(row.tenantRoleId).toBe(made.body.id);
    expect(row.tokenVersion).toBe(person.tokenVersion + 1);

    const listed = await agent().get('/scim/v2/Groups').query({ filter: 'displayName eq "Alto Store Leads"' }).set('Authorization', `Bearer ${token}`);
    expect(listed.body.totalResults).toBe(1);
    expect(listed.body.Resources[0].members).toEqual([expect.objectContaining({ value: person.id })]);

    const removed = await agent()
      .patch(`/scim/v2/Groups/${g.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/scim+json')
      .send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: `members[value eq "${person.id}"]` }] });
    expect(removed.status).toBe(200);
    expect(removed.body.members).toEqual([]);
    row = await prisma.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(row.role).toBe('MANAGER');

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'permission.changed', entityId: person.id } });
    expect(audit?.metadata).toMatchObject({ actor: 'scim', group: 'Alto Store Leads', before: { role: 'ASSOCIATE' }, after: { role: 'MANAGER' } });
  });

  it('a group in another tenant is invisible to this token', async () => {
    const { user: actor } = await admin();
    const T2 = '33333333-3333-4333-8333-333333333333';
    await prisma.tenant.create({ data: { id: T2, slug: 'other', name: 'Other' } });
    await prisma.scimGroup.create({ data: { tenantId: T2, displayName: 'Theirs', memberUserIds: [] } });
    const { token } = await issueScimToken(prisma, ALTO_TENANT_ID, 'Okta', actor.id);
    const listed = await agent().get('/scim/v2/Groups').set('Authorization', `Bearer ${token}`);
    expect(listed.body.totalResults).toBe(0);
  });
});
