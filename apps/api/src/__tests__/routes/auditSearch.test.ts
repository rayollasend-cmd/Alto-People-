import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * F500 G4 — the audit log reads like a log, not a database dump: records
 * named instead of UUIDs, the API's own request trail hidden on request,
 * categories a reviewer understands, one search over the event, the record
 * and the actor, and a people-picker for the actor. All inside the caller's
 * tenant.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(truncateAll);
afterAll(async () => {
  await prisma.$disconnect();
});

type Entry = { id: string; action: string; entityType: string; entityLabel: string | null; entityHref: string | null; actorName: string | null };

async function seed() {
  // A fresh address each time: sign-ins are rate-limited per email.
  const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR', email: `auditor-${Math.random().toString(36).slice(2, 8)}@example.com` });
  await prisma.user.update({ where: { id: admin.id }, data: { displayName: 'Avery Auditor' } });
  const person = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const a = await loginAs(agent(), admin.email);
  await flushPendingAudits();
  const base = { tenantId: ALTO_TENANT_ID, actorUserId: admin.id };
  const rows = await Promise.all([
    prisma.auditLog.create({ data: { ...base, action: 'associate.pii_viewed', entityType: 'Associate', entityId: person.id } }),
    prisma.auditLog.create({ data: { ...base, action: 'client.updated', entityType: 'Client', entityId: client.id } }),
    prisma.auditLog.create({ data: { ...base, action: 'site.updated', entityType: 'Location', entityId: site.id } }),
    prisma.auditLog.create({ data: { ...base, action: 'ops.report_exported', entityType: 'Client', entityId: client.id } }),
    prisma.auditLog.create({ data: { tenantId: ALTO_TENANT_ID, action: 'http.post', entityType: 'HttpRequest', entityId: '/careers/view', metadata: { method: 'POST', route: '/careers/view' } } }),
    prisma.auditLog.create({ data: { tenantId: ALTO_TENANT_ID, action: 'http.patch', entityType: 'HttpRequest', entityId: '/auth/me/language', metadata: { method: 'PATCH' } } }),
    prisma.auditLog.create({ data: { ...base, action: 'tenant.profile_updated', entityType: 'Tenant', entityId: ALTO_TENANT_ID } }),
  ]);
  return { admin, person, client, site, a, rows };
}

describe('GET /audit/logs — named, filtered, searchable', () => {
  it('names each record and links the ones that have a page', async () => {
    const { a, person, client, admin } = await seed();
    const res = await a.get('/audit/logs');
    expect(res.status).toBe(200);
    const entries = res.body.entries as Entry[];
    const pii = entries.find((e) => e.action === 'associate.pii_viewed')!;
    expect(pii.entityLabel).toBe('Maria Lopez');
    expect(pii.entityHref).toBe(`/people/${person.id}`);
    expect(pii.actorName).toBe('Avery Auditor');
    const cl = entries.find((e) => e.action === 'client.updated')!;
    expect(cl.entityLabel).toBe('Coastal Resort');
    expect(cl.entityHref).toBe(`/clients/${client.id}`);
    expect(entries.find((e) => e.action === 'site.updated')!.entityLabel).toBe('Coastal Resort');
    expect(entries.find((e) => e.action === 'http.post')!.entityLabel).toBe('POST /careers/view');
    const own = await prisma.tenant.findUniqueOrThrow({ where: { id: ALTO_TENANT_ID } });
    expect(entries.find((e) => e.action === 'tenant.profile_updated')!.entityLabel).toBe(own.name);
    // The sign-in row names the account by its display name.
    const login = entries.find((e) => e.action === 'auth.login')!;
    expect(login.entityLabel).toBe('Avery Auditor');
    expect(login.entityType).toBe('User');
    void admin;
  });

  it('hides the API request trail when asked, and counts exactly what is left', async () => {
    const { a } = await seed();
    const all = (await a.get('/audit/logs')).body.entries as Entry[];
    const shown = (await a.get('/audit/logs?hideSystem=1')).body.entries as Entry[];
    expect(all.filter((e) => e.action.startsWith('http.'))).toHaveLength(2);
    expect(shown.some((e) => e.action.startsWith('http.') || e.entityType === 'HttpRequest')).toBe(false);
    expect(shown).toHaveLength(all.length - 2);
  });

  it('filters by category: sign-ins, exports, settings', async () => {
    const { a } = await seed();
    const signin = (await a.get('/audit/logs?category=signin')).body.entries as Entry[];
    expect(signin.length).toBeGreaterThan(0);
    expect(signin.every((e) => e.action.startsWith('auth.'))).toBe(true);
    const exports = (await a.get('/audit/logs?category=exports')).body.entries as Entry[];
    expect(exports.map((e) => e.action)).toEqual(['ops.report_exported']);
    const settings = (await a.get('/audit/logs?category=settings')).body.entries as Entry[];
    expect(settings.map((e) => e.action).sort()).toEqual(['site.updated', 'tenant.profile_updated']);
    expect((await a.get('/audit/logs?category=nonsense')).status).toBe(400);
  });

  it('one search finds the event, the record id or the actor', async () => {
    const { a, person, admin } = await seed();
    const byAction = (await a.get('/audit/logs?q=pii')).body.entries as Entry[];
    expect(byAction.map((e) => e.action)).toEqual(['associate.pii_viewed']);
    const byId = (await a.get(`/audit/logs?q=${person.id.slice(0, 8)}`)).body.entries as Entry[];
    expect(byId.map((e) => e.action)).toEqual(['associate.pii_viewed']);
    const byActor = (await a.get(`/audit/logs?q=${encodeURIComponent(admin.email)}&hideSystem=1`)).body.entries as Entry[];
    expect(byActor).toHaveLength(6); // the sign-in and the five seeded actions
  });

  it("never names a record from another tenant's data", async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { a } = await seed();
    const theirs = await prisma.associate.create({ data: { firstName: 'Secret', lastName: 'Person', email: 'secret@example.com', tenantId: T2 } });
    // A row in tenant one pointing at tenant two's person (a forged or stale id) stays unnamed.
    await prisma.auditLog.create({ data: { tenantId: ALTO_TENANT_ID, action: 'associate.pii_viewed', entityType: 'Associate', entityId: theirs.id } });
    const entries = (await a.get('/audit/logs?q=' + theirs.id)).body.entries as Entry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityLabel).toBeNull();
    expect(entries[0]!.entityHref).toBeNull();
  });
});

describe('GET /audit/actors — the Actor picker', () => {
  it("finds this tenant's accounts by name or email, never another tenant's", async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { a, admin } = await seed();
    const maria = await prisma.associate.findFirstOrThrow({ where: { firstName: 'Maria' } });
    const { user: mariaUser } = await createUser({ role: 'ASSOCIATE', email: 'maria@example.com', associateId: maria.id });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'maria.other@example.com' });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T2 } });

    const byName = await a.get('/audit/actors?q=lopez');
    expect(byName.status).toBe(200);
    expect(byName.body.actors).toEqual([{ id: mariaUser.id, email: 'maria@example.com', name: 'Maria Lopez' }]);
    const byEmail = (await a.get('/audit/actors?q=maria')).body.actors as Array<{ id: string }>;
    expect(byEmail.map((x) => x.id)).toEqual([mariaUser.id]);
    const one = (await a.get(`/audit/actors?id=${admin.id}`)).body.actors as Array<{ name: string }>;
    expect(one.map((x) => x.name)).toEqual(['Avery Auditor']);
  });

  it('is closed to people without view:audit', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), user.email);
    expect((await a.get('/audit/actors?q=a')).status).toBe(403);
  });
});
