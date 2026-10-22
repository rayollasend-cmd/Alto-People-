import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { ClientOverview } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { createAssociate, createClient, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * The client's account page (CL-A): contacts CRUD and who may touch them,
 * the account fields on PATCH /clients/:id, and the overview — its numbers
 * from seeded rows, exact; the needs-you list and its links; money only
 * for statements readers.
 */

const app = createApp();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
/** Down to the quarter hour, so no punch-rounding rule moves the hours. */
const quarter = (ms: number) => new Date(Math.floor(ms / (15 * 60_000)) * 15 * 60_000);

describe('contacts', () => {
  it('adds, edits, makes primary and removes contacts; the first one is the primary; every write is audited', async () => {
    const client = await createClient('Coastal Resort');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const first = await a.post(`/clients/${client.id}/contacts`).send({ name: 'Dana Reyes', title: 'GM', email: 'dana@coastal.example', phone: '(850) 555-0100', role: 'PRIMARY' });
    expect(first.status).toBe(201);
    expect(first.body.contact).toMatchObject({ name: 'Dana Reyes', title: 'GM', email: 'dana@coastal.example', phone: '(850) 555-0100', role: 'PRIMARY', isPrimary: true });

    const second = await a.post(`/clients/${client.id}/contacts`).send({ name: 'Ben Ortiz', role: 'BILLING', email: '' });
    expect(second.status).toBe(201);
    expect(second.body.contact).toMatchObject({ name: 'Ben Ortiz', email: null, role: 'BILLING', isPrimary: false });

    const bad = await a.post(`/clients/${client.id}/contacts`).send({ name: 'X', email: 'not-an-email' });
    expect(bad.status).toBe(400);
    const nameless = await a.post(`/clients/${client.id}/contacts`).send({ name: '  ' });
    expect(nameless.status).toBe(400);

    // Making Ben the primary moves the flag: one primary per client.
    const promoted = await a.patch(`/clients/${client.id}/contacts/${second.body.contact.id}`).send({ isPrimary: true, title: 'AP lead' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.contact).toMatchObject({ isPrimary: true, title: 'AP lead' });
    let list = await a.get(`/clients/${client.id}/contacts`);
    expect(list.body.contacts.map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary])).toEqual([
      ['Ben Ortiz', true],
      ['Dana Reyes', false],
    ]);

    // Removing the primary leaves no primary (soft delete).
    expect((await a.delete(`/clients/${client.id}/contacts/${second.body.contact.id}`)).status).toBe(204);
    list = await a.get(`/clients/${client.id}/contacts`);
    expect(list.body.contacts.map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary])).toEqual([['Dana Reyes', false]]);
    const removed = await prisma.clientContact.findUniqueOrThrow({ where: { id: second.body.contact.id } });
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.isPrimary).toBe(false);
    expect((await a.delete(`/clients/${client.id}/contacts/${second.body.contact.id}`)).status).toBe(404);

    // A contact of another client is not reachable through this one.
    const other = await createClient('Other Co');
    expect((await a.patch(`/clients/${other.id}/contacts/${first.body.contact.id}`).send({ name: 'Nope' })).status).toBe(404);

    await flushPendingAudits();
    const actions = (await prisma.auditLog.findMany({ where: { clientId: client.id, entityType: 'ClientContact' }, select: { action: true }, orderBy: { createdAt: 'asc' } })).map((r) => r.action);
    expect(actions).toEqual(['client.contact_added', 'client.contact_added', 'client.contact_made_primary', 'client.contact_removed']);
  });

  it('reads are scoped: a portal login is refused, a site-limited office account reads only clients with a site in reach, and writes need manage:clients', async () => {
    const a = await createClient('Account A');
    const b = await createClient('Account B');
    const siteB = await prisma.site.findFirstOrThrow({ where: { clientId: b.id } });
    await prisma.clientContact.create({ data: { clientId: a.id, name: 'Secret Person', email: 'secret@a.example', isPrimary: true } });

    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: b.id });
    const portalAgent = await loginAs(portal.email);
    const refused = await portalAgent.get(`/clients/${a.id}/contacts`);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain('Secret Person');
    expect((await portalAgent.get(`/clients/${a.id}/overview`)).status).toBe(403);

    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [siteB.id] } });
    const opsAgent = await loginAs(ops.email);
    for (const path of [`/clients/${a.id}/contacts`, `/clients/${a.id}/overview`, `/clients/${a.id}/owner-options`]) {
      const r = await opsAgent.get(path);
      expect(r.status, path).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain('Secret Person');
    }
    expect((await opsAgent.post(`/clients/${a.id}/contacts`).send({ name: 'Sneaky' })).status).toBe(404);
    expect((await opsAgent.get(`/clients/${b.id}/contacts`)).status).toBe(200);
    expect((await opsAgent.get(`/clients/${b.id}/overview`)).status).toBe(200);

    // Finance reads clients but does not manage them.
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const finAgent = await loginAs(fin.email);
    expect((await finAgent.get(`/clients/${a.id}/contacts`)).body.contacts).toHaveLength(1);
    expect((await finAgent.post(`/clients/${a.id}/contacts`).send({ name: 'No' })).status).toBe(403);
    expect((await finAgent.get(`/clients/${a.id}/owner-options`)).status).toBe(403);
  });
});

describe('PATCH /clients/:id — the account fields', () => {
  it('takes an internal owner of the same tenant only, and a contract that does not end before it starts', async () => {
    const client = await createClient('Owner Co');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: rep } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.associate.create({ data: { firstName: 'Riley', lastName: 'Shore', email: 'riley.rep@example.com', user: { connect: { id: rep.id } } } });
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const { user: worker } = await createUser({ role: 'ASSOCIATE' });
    const { user: gone } = await createUser({ role: 'MANAGER', status: 'DISABLED' });
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'acct-two', name: 'Acct Two' }, update: {} });
    const { user: foreign } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: foreign.id }, data: { tenantId: T2 } });
    const a = await loginAs(hr.email);

    for (const id of [portal.id, worker.id, gone.id, foreign.id, '00000000-0000-4000-8000-00000000abcd']) {
      const r = await a.patch(`/clients/${client.id}`).send({ accountOwnerUserId: id });
      expect(r.status, id).toBe(400);
      expect(r.body.error.code).toBe('owner_not_internal');
    }

    const ok = await a.patch(`/clients/${client.id}`).send({ accountOwnerUserId: rep.id, contractStartDate: '2026-01-01', contractEndDate: '2026-12-31', legalName: 'Owner Company LLC', city: 'Destin' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accountOwnerUserId: rep.id, contractStartDate: '2026-01-01', contractEndDate: '2026-12-31', legalName: 'Owner Company LLC', city: 'Destin', paymentTermsDays: 30 });
    expect((await a.get(`/clients/${client.id}`)).body).toMatchObject({ accountOwnerUserId: rep.id, contractEndDate: '2026-12-31' });

    // The end cannot fall before the start, sent together or alone.
    const both = await a.patch(`/clients/${client.id}`).send({ contractStartDate: '2027-02-01', contractEndDate: '2027-01-01' });
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe('contract_dates');
    const alone = await a.patch(`/clients/${client.id}`).send({ contractEndDate: '2025-12-31' });
    expect(alone.status).toBe(400);
    expect(alone.body.error.code).toBe('contract_dates');
    expect((await a.patch(`/clients/${client.id}`).send({ contractEndDate: '2026-01-01' })).status).toBe(200);
    expect((await a.patch(`/clients/${client.id}`).send({ contractStartDate: '2026-13-45' })).status).toBe(400);

    // Clearing works.
    const cleared = await a.patch(`/clients/${client.id}`).send({ accountOwnerUserId: null, contractStartDate: null, contractEndDate: null });
    expect(cleared.body).toMatchObject({ accountOwnerUserId: null, contractStartDate: null, contractEndDate: null });

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { clientId: client.id, action: { in: ['client.owner_changed', 'client.contract_changed'] } }, orderBy: { createdAt: 'asc' }, select: { action: true, metadata: true } });
    expect(audits.find((x) => x.action === 'client.owner_changed')).toMatchObject({ metadata: { to: rep.id, toName: 'Riley Shore' } });
    expect(audits.find((x) => x.action === 'client.contract_changed')).toMatchObject({ metadata: { start: '2026-01-01', end: '2026-12-31' } });
  });

  it('lists the people who may own an account: internal, active, able to open clients', async () => {
    const client = await createClient('Pick Co');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr.owner@example.com' });
    await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'fin.owner@example.com' });
    await createUser({ role: 'MARKETING_MANAGER', email: 'mkt.owner@example.com' });
    await createUser({ role: 'CLIENT_PORTAL', clientId: client.id, email: 'portal.owner@example.com' });
    await createUser({ role: 'ASSOCIATE', email: 'assoc.owner@example.com' });
    await createUser({ role: 'MANAGER', status: 'DISABLED', email: 'gone.owner@example.com' });
    const r = await (await loginAs(hr.email)).get(`/clients/${client.id}/owner-options`);
    expect(r.status).toBe(200);
    expect(r.body.options.map((o: { email: string }) => o.email).sort()).toEqual(['fin.owner@example.com', 'hr.owner@example.com']);
  });
});

/** One client with everything the overview reads, at known values. */
async function seedAccount() {
  const now = new Date();
  const today = orgDateKey(now);
  const client = await createClient('Gulf Front Hotels');
  // The week started yesterday on the store's clock, so the punches below sit in it.
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  await prisma.client.update({ where: { id: client.id }, data: { weekStartsOn: (dow + 6) % 7, contractStartDate: new Date(`${addDays(today, -300)}T00:00:00Z`), contractEndDate: new Date(`${addDays(today, 20)}T00:00:00Z`), targetMarginPct: 25 } });
  const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: north.id }, data: { name: 'North Tower', city: 'Destin', state: 'FL' } });
  const south = await prisma.site.create({ data: { clientId: client.id, name: 'South Tower', city: 'Miramar Beach', state: 'FL' } });

  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr.gulf@example.com' });
  await prisma.associate.create({ data: { firstName: 'Harper', lastName: 'Lane', email: 'harper.hr@example.com', user: { connect: { id: hr.id } } } });

  // Two people at North work this week; one placed at South has not worked in the window.
  const ann = await createAssociate({ firstName: 'Ann', lastName: 'North', email: 'ann.gulf@example.com' });
  const bo = await createAssociate({ firstName: 'Bo', lastName: 'North', email: 'bo.gulf@example.com' });
  const cy = await createAssociate({ firstName: 'Cy', lastName: 'South', email: 'cy.gulf@example.com' });
  for (const [who, site] of [[ann, north], [bo, north], [cy, south]] as const) {
    await prisma.associateAssignment.create({ data: { associateId: who.id, locationId: site.id, startedAt: new Date('2026-01-05') } });
  }
  const punch = (associateId: string, startMs: number, hours: number) =>
    prisma.timeEntry.create({ data: { associateId, clientId: client.id, locationId: north.id, clockInAt: quarter(startMs), clockOutAt: new Date(quarter(startMs).getTime() + hours * HOUR), status: 'COMPLETED' } });
  await punch(ann.id, now.getTime() - 3 * HOUR, 2); // this week: 2h
  await punch(bo.id, now.getTime() - 4 * HOUR, 3); // this week: 3h
  await punch(ann.id, now.getTime() - 7 * DAY - 3 * HOUR, 2); // last week, before this moment of it: 2h

  // Next 7 days: four published shifts, two filled; one open one starts within 48 hours.
  const shift = (offsetH: number, assignee: string | null) =>
    prisma.shift.create({
      data: { clientId: client.id, locationId: north.id, position: 'Housekeeper', startsAt: new Date(now.getTime() + offsetH * HOUR), endsAt: new Date(now.getTime() + (offsetH + 8) * HOUR), status: assignee ? 'ASSIGNED' : 'OPEN', assignedAssociateId: assignee, publishedAt: now },
    });
  await shift(24, null);
  await shift(72, null);
  await shift(48, ann.id);
  await shift(50, bo.id);

  // Money: one statement 40 days past due, one finalized this month and not yet due.
  await prisma.clientStatement.create({
    data: { clientId: client.id, periodStart: new Date(`${addDays(today, -56)}T00:00:00Z`), periodEnd: new Date(`${addDays(today, -50)}T00:00:00Z`), status: 'FINAL', number: 12, finalizedAt: new Date(now.getTime() - 50 * DAY), finalizedById: hr.id, dueAt: new Date(`${addDays(today, -40)}T00:00:00Z`), snapshot: { totals: { amount: 5760, hours: 240, regularHours: 240, otHours: 0 }, lines: [], stores: [] } },
  });
  await prisma.clientStatement.create({
    data: { clientId: client.id, periodStart: new Date(`${addDays(today, -6)}T00:00:00Z`), periodEnd: new Date(`${today}T00:00:00Z`), status: 'FINAL', number: 13, finalizedAt: now, finalizedById: hr.id, dueAt: new Date(`${addDays(today, 30)}T00:00:00Z`), snapshot: { totals: { amount: 1200.5, hours: 50, regularHours: 50, otHours: 0 }, lines: [], stores: [] } },
  });

  // A detractor 10 days ago, a promoter (not counted), and a request past its promised time.
  const wave = await prisma.clientNpsWave.create({ data: { quarter: '2026-Q4', closesAt: new Date(now.getTime() + 20 * DAY) } });
  await prisma.clientNpsInvite.create({ data: { waveId: wave.id, clientId: client.id, email: 'gm@gulf.example', tokenHash: 'a'.repeat(64), expiresAt: new Date(now.getTime() + 20 * DAY), respondedAt: new Date(now.getTime() - 10 * DAY), score: 4, comment: 'Two no-shows on the Saturday turn.' } });
  await prisma.clientNpsInvite.create({ data: { waveId: wave.id, clientId: client.id, email: 'ops@gulf.example', tokenHash: 'b'.repeat(64), expiresAt: new Date(now.getTime() + 20 * DAY), respondedAt: new Date(now.getTime() - 9 * DAY), score: 9 } });
  const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id, email: 'store.gulf@example.com' });
  await prisma.clientRequest.create({ data: { clientId: client.id, kind: 'STAFFING', subject: 'Four more for Friday', body: 'Truck day', createdByUserId: portal.id, createdAt: new Date(now.getTime() - 2 * DAY), dueAt: new Date(now.getTime() - DAY) } });

  return { client, hr, north, south, now, today };
}

describe('GET /clients/:id/overview', () => {
  it('computes the numbers, the needs-you list (risk first, exact links) and the activity from the rows', async () => {
    const { client, hr, north, south, today } = await seedAccount();
    const a = await loginAs(hr.email);
    const r = await a.get(`/clients/${client.id}/overview`);
    expect(r.status).toBe(200);
    const o = r.body as ClientOverview;

    expect(o.canSeeMoney).toBe(true);
    expect(o.kpis).toMatchObject({
      onAssignment: 2,
      hoursThisWeek: 5,
      hoursLastWeek: 2,
      hoursLastWeekToDate: 2,
      hoursChangePct: 150,
      shiftsNext7: { total: 4, filled: 2 },
      fillRatePct: 50,
      overtimePct: 0,
      health: 'risk',
    });
    expect(o.kpis!.money).toEqual({
      outstanding: 6960.5,
      aging: { current: 1200.5, d1_30: 0, d31_60: 5760, d61_90: 0, d90plus: 0 },
      billedThisMonth: 1200.5,
      lastStatementTotal: 1200.5,
      lastStatementAt: expect.any(String),
      marginPct: null,
      targetMarginPct: 25,
    });

    expect(o.locations).toEqual({
      count: 2,
      items: [
        { id: north.id, name: 'North Tower', city: 'Destin', state: 'FL', onAssignment: 2 },
        { id: south.id, name: 'South Tower', city: 'Miramar Beach', state: 'FL', onAssignment: 0 },
      ],
    });
    expect(o.contract).toEqual({ start: addDays(today, -300), end: addDays(today, 20), daysLeft: 20 });
    expect(o.owner).toBeNull();
    expect(o.paymentTermsDays).toBe(30);

    expect(o.needsYou.map((n) => [n.kind, n.severity, n.count ?? null])).toEqual([
      ['overdue_statements', 'risk', 1],
      ['unfilled_shifts', 'risk', 2],
      ['contract_ending', 'risk', null],
      ['client_requests', 'risk', 1],
      ['nps_detractors', 'risk', 1],
      ['portal_readiness', 'watch', expect.any(Number)],
      ['no_account_owner', 'watch', null],
      ['no_primary_contact', 'watch', null],
    ]);
    const by = Object.fromEntries(o.needsYou.map((n) => [n.kind, n]));
    expect(by.overdue_statements).toMatchObject({ title: '$5,760.00 past due on 1 statement', detail: 'The oldest, No. 0012, is 40 days past due.', href: `/clients/${client.id}?section=statements` });
    expect(by.unfilled_shifts).toMatchObject({ title: '2 shifts with no one on them', detail: '1 starts in the next 48 hours.', href: `/scheduling?client=${client.id}&open=1` });
    expect(by.contract_ending).toMatchObject({ detail: '20 days left.', href: `/clients/${client.id}?section=overview#account` });
    expect(by.client_requests).toMatchObject({ title: '1 request from the client waiting on us', detail: '1 is past the time promised.', href: '/relay#client-requests' });
    expect(by.nps_detractors).toMatchObject({ title: '1 detractor in the last 90 days', href: '/clients/nps' });
    expect(by.nps_detractors!.detail).toContain('4/10');
    expect(by.portal_readiness!.href).toBe(`/clients/${client.id}?section=portal`);

    // Activity: the two finalized statements and the client's request, newest first, named.
    expect(o.recentActivity.map((x) => x.kind)).toEqual(['statement_finalized', 'request_opened', 'statement_finalized']);
    expect(o.recentActivity[0]).toMatchObject({ actor: 'Harper Lane', text: 'Statement No. 0013 finalized: $1,200.50', href: `/clients/${client.id}?section=statements` });
    expect(o.recentActivity[1]).toMatchObject({ actor: 'store.gulf@example.com', text: 'Request from the client: Four more for Friday' });
  });

  it('a primary contact and an owner clear their nudges, and the feed names who did them', async () => {
    const { client, hr } = await seedAccount();
    const a = await loginAs(hr.email);
    await a.post(`/clients/${client.id}/contacts`).send({ name: 'Dana Reyes', title: 'GM' });
    await a.patch(`/clients/${client.id}`).send({ accountOwnerUserId: hr.id });
    await flushPendingAudits();
    const o = (await a.get(`/clients/${client.id}/overview`)).body as ClientOverview;
    expect(o.needsYou.map((n) => n.kind)).not.toContain('no_account_owner');
    expect(o.needsYou.map((n) => n.kind)).not.toContain('no_primary_contact');
    expect(o.owner).toEqual({ id: hr.id, name: 'Harper Lane', email: 'hr.gulf@example.com' });
    expect(o.contacts.map((c) => [c.name, c.isPrimary])).toEqual([['Dana Reyes', true]]);
    const kinds = o.recentActivity.map((x) => x.kind);
    expect(kinds.slice(0, 2).sort()).toEqual(['contact_added', 'owner_changed']);
    expect(o.recentActivity.find((x) => x.kind === 'owner_changed')).toMatchObject({ actor: 'Harper Lane', text: 'Account owner set to Harper Lane' });
    expect(o.recentActivity.find((x) => x.kind === 'contact_added')).toMatchObject({ text: 'Contact added: Dana Reyes, GM' });
  });

  it('omits money — never zero — for someone who reads clients without statements, and drops the money lines and links', async () => {
    const { client } = await seedAccount();
    const role = await prisma.tenantRole.create({ data: { name: 'Account desk', archetype: 'OPERATIONS_MANAGER', capabilities: ['view:dashboard', 'view:clients', 'manage:clients'] } });
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantRoleId: role.id } });
    const r = await (await loginAs(user.email)).get(`/clients/${client.id}/overview`);
    expect(r.status).toBe(200);
    const o = r.body as ClientOverview;
    expect(o.canSeeMoney).toBe(false);
    expect(o.kpis).not.toHaveProperty('money');
    expect(o.kpis!.onAssignment).toBe(2);
    const text = JSON.stringify(o);
    expect(text).not.toContain('5,760');
    expect(text).not.toContain('1,200');
    expect(o.needsYou.map((n) => n.kind)).not.toContain('overdue_statements');
    expect(o.recentActivity.map((x) => x.kind)).toEqual(['request_opened']);
    // Without the Relay board or the NPS page, the links stay on the client.
    const by = Object.fromEntries(o.needsYou.map((n) => [n.kind, n]));
    expect(by.client_requests!.href).toBe(`/clients/${client.id}?section=portal`);
    expect(by.nps_detractors!.href).toBe(`/clients/${client.id}?section=performance`);
    expect(o.recentActivity[0]!.href).toBeNull();
  });

  it('says plainly when there is nothing: no hours, no shifts, no money owed, nothing that needs you', async () => {
    const client = await createClient('Quiet Co');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    await a.post(`/clients/${client.id}/contacts`).send({ name: 'Sam Quiet' });
    await a.patch(`/clients/${client.id}`).send({ accountOwnerUserId: hr.id });
    const o = (await a.get(`/clients/${client.id}/overview`)).body as ClientOverview;
    expect(o.kpis).toMatchObject({ onAssignment: 0, hoursThisWeek: 0, hoursChangePct: null, shiftsNext7: { total: 0, filled: 0 }, fillRatePct: null, overtimePct: null, health: 'good' });
    expect(o.kpis!.money).toMatchObject({ outstanding: 0, billedThisMonth: 0, lastStatementTotal: null, marginPct: null });
    expect(o.needsYou).toEqual([]);
    expect(o.contract).toEqual({ start: null, end: null, daysLeft: null });
  });
});
