import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientListItem, ClientPerformanceResponse } from '@alto-people/shared';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';

/**
 * GET /clients with the account numbers (Clients rebuild): scoped exactly
 * as the list always was, money only for statements readers (omitted,
 * never 0, for everyone else), the billed range from ?from=&to=, and the
 * owner by name. GET /clients/:id/performance: the same scope, statements
 * with their real dates for money readers only, NPS for executives.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const H = 3_600_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
// Statements age on the company's calendar (orgDateKey), not UTC's: a due date
// seeded from the UTC day read 39 days late after 5 PM Pacific.
const orgDaysAgo = (n: number) => new Date(new Date(`${orgDateKey(new Date())}T00:00:00.000Z`).getTime() - n * DAY).toISOString().slice(0, 10);

async function seed() {
  const harbor = await createClient('Harbor Hotel');
  const north = await prisma.site.findFirstOrThrow({ where: { clientId: harbor.id } });
  const yard = await createClient('Yard Market');
  const south = await prisma.site.findFirstOrThrow({ where: { clientId: yard.id } });
  const owner = await createUser({ role: 'OPERATIONS_MANAGER', email: 'owner@clients-list.example' });
  await prisma.user.update({ where: { id: owner.user.id }, data: { displayName: 'Olivia Owner' } });
  await prisma.client.update({ where: { id: harbor.id }, data: { accountOwnerUserId: owner.user.id, contractEndDate: new Date(`${orgDaysAgo(-20)}T00:00:00.000Z`) } });

  const ana = await createAssociate({ firstName: 'Ana' });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: north.id, startedAt: new Date('2026-01-01') } });
  await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: harbor.id, locationId: north.id, clockInAt: daysAgo(2), clockOutAt: new Date(daysAgo(2).getTime() + 8 * H), status: 'APPROVED' } });

  // Harbor: $5,760 forty days late and a paid $1,500 statement that ended 3 days ago.
  const lateEnd = daysAgo(47);
  await prisma.clientStatement.create({ data: { clientId: harbor.id, periodStart: new Date(`${ymd(new Date(lateEnd.getTime() - 6 * DAY))}T00:00:00.000Z`), periodEnd: new Date(`${ymd(lateEnd)}T00:00:00.000Z`), status: 'FINAL', number: 101, finalizedAt: daysAgo(46), dueAt: new Date(`${orgDaysAgo(40)}T00:00:00.000Z`), snapshot: { totals: { amount: 5760, hours: 144 } } } });
  const paidEnd = daysAgo(3);
  await prisma.clientStatement.create({ data: { clientId: harbor.id, periodStart: new Date(`${ymd(new Date(paidEnd.getTime() - 6 * DAY))}T00:00:00.000Z`), periodEnd: new Date(`${ymd(paidEnd)}T00:00:00.000Z`), status: 'FINAL', number: 102, finalizedAt: daysAgo(2), dueAt: new Date(`${ymd(new Date(Date.now() + 10 * DAY))}T00:00:00.000Z`), paidAt: daysAgo(1), snapshot: { totals: { amount: 1500, hours: 37.5 } } } });
  await prisma.clientStatement.create({ data: { clientId: harbor.id, periodStart: new Date(`${ymd(daysAgo(2))}T00:00:00.000Z`), periodEnd: new Date(`${ymd(new Date(Date.now() + 4 * DAY))}T00:00:00.000Z`), status: 'DRAFT', snapshot: { totals: { amount: 640, hours: 16 } } } });
  return { harbor, yard, north, south, owner: owner.user, paidEnd };
}

async function noMoneyAgent() {
  const role = await prisma.tenantRole.create({ data: { name: 'Account desk', archetype: 'OPERATIONS_MANAGER', capabilities: ['view:dashboard', 'view:clients'] } });
  const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
  await prisma.user.update({ where: { id: user.id }, data: { tenantRoleId: role.id } });
  return loginAs(agent(), user.email);
}

const byName = (list: ClientListItem[], name: string) => list.find((c) => c.name === name)!;

describe('GET /clients — the account numbers', () => {
  it('gives a statements reader the money, health with its reasons, and the owner by name', async () => {
    const s = await seed();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    const r = await a.get(`/clients?include=metrics&from=${ymd(new Date(s.paidEnd.getTime() - DAY))}&to=${ymd(new Date(s.paidEnd.getTime() + DAY))}`);
    expect(r.status).toBe(200);
    const harbor = byName(r.body.clients, 'Harbor Hotel');
    expect(harbor.onAssignment).toBe(1);
    expect(harbor.activeAssociateCount).toBe(1);
    expect(harbor.hoursThisWeek === undefined).toBe(false);
    expect(harbor.outstanding).toBe(5760);
    expect(harbor.billedInRange).toBe(1500);
    expect(harbor.health).toBe('risk');
    expect(harbor.healthReasons).toContain('$5,760 is 40 days past due');
    expect(harbor.healthReasons!.some((x) => x.startsWith('Contract ends in 20 days'))).toBe(true);
    expect(harbor.accountOwner).toEqual({ id: s.owner.id, name: 'Olivia Owner' });
    expect(harbor.contractEndDate).toBe(orgDaysAgo(-20));
    const yard = byName(r.body.clients, 'Yard Market');
    expect(yard).toMatchObject({ onAssignment: 0, outstanding: 0, billedInRange: 0, fillRatePct: null, health: 'good', healthReasons: [], accountOwner: null });

    // Another range bills nothing; a malformed one is refused.
    const empty = await a.get('/clients?include=metrics&from=2020-01-01&to=2020-01-31');
    expect(byName(empty.body.clients, 'Harbor Hotel').billedInRange).toBe(0);
    expect((await a.get('/clients?include=metrics&from=2026-10-31&to=2026-10-01')).status).toBe(400);
    expect((await a.get('/clients?include=metrics&from=yesterday&to=today')).status).toBe(400);

    // Without include=metrics (the pickers across the app) the list stays lean, and still counts the people.
    const lean = byName((await a.get('/clients')).body.clients, 'Harbor Hotel');
    expect(lean.activeAssociateCount).toBe(1);
    expect(lean).not.toHaveProperty('health');
    expect(lean).not.toHaveProperty('outstanding');
  });

  it('omits every money field — never 0 — and money reasons for someone who reads clients without statements', async () => {
    await seed();
    const a = await noMoneyAgent();
    const r = await a.get('/clients?include=metrics');
    expect(r.status).toBe(200);
    const harbor = byName(r.body.clients, 'Harbor Hotel');
    expect(harbor).not.toHaveProperty('outstanding');
    expect(harbor).not.toHaveProperty('billedInRange');
    expect(harbor.onAssignment).toBe(1);
    expect(harbor.health).toBe('risk');
    expect(harbor.healthReasons!.join(' ')).not.toContain('$');
    expect(JSON.stringify(r.body)).not.toContain('5760');
  });

  it('leaves the internal-hires pseudo-client out of the accounts list, and keeps it for the pickers (F500 2026-10-26)', async () => {
    await createClient('Harbor Hotel');
    await createClient('Alto HR — Internal Hires');
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);
    const accounts = await a.get('/clients?include=metrics');
    expect(accounts.status).toBe(200);
    expect((accounts.body.clients as ClientListItem[]).map((c) => c.name)).toEqual(['Harbor Hotel']);
    // The new-applicant dialog's picker still offers it: internal staff are hired through it.
    const picker = await a.get('/clients');
    expect((picker.body.clients as ClientListItem[]).map((c) => c.name)).toContain('Alto HR — Internal Hires');
  });

  it('keeps a store-bound account to the clients in its reach', async () => {
    const s = await seed();
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [s.south.id] } });
    const r = await (await loginAs(agent(), user.email)).get('/clients?include=metrics');
    expect(r.status).toBe(200);
    expect(r.body.clients.map((c: ClientListItem) => c.name)).toEqual(['Yard Market']);
    expect(JSON.stringify(r.body)).not.toContain('Olivia');
  });
});

describe('GET /clients/:id/performance', () => {
  it('gives a statements reader 12 weeks and each statement with its period end and whether it is paid, waiting or a draft', async () => {
    const s = await seed();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const r = await (await loginAs(agent(), user.email)).get(`/clients/${s.harbor.id}/performance`);
    expect(r.status).toBe(200);
    const p = r.body as ClientPerformanceResponse;
    expect(p.weeks).toHaveLength(12);
    expect(p.canSeeMoney).toBe(true);
    expect(p.statements!.map((x) => [x.number, x.state, x.amount])).toEqual([
      [101, 'waiting', 5760],
      [102, 'paid', 1500],
      [null, 'draft', 640],
    ]);
    expect(p.statements![0]!.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.statements![0]!.daysPastDue).toBe(40);
    // NPS is the executive's and marketing's, as on the NPS page.
    expect(p).not.toHaveProperty('nps');
  });

  it('leaves statements out for someone without statements, and 404s a client outside the caller’s reach', async () => {
    const s = await seed();
    const a = await noMoneyAgent();
    const r = await a.get(`/clients/${s.harbor.id}/performance`);
    expect(r.status).toBe(200);
    expect(r.body.canSeeMoney).toBe(false);
    expect(r.body).not.toHaveProperty('statements');
    expect(r.body.weeks).toHaveLength(12);

    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [s.south.id] } });
    const scoped = await loginAs(agent(), user.email);
    expect((await scoped.get(`/clients/${s.harbor.id}/performance`)).status).toBe(404);
    expect((await scoped.get(`/clients/${s.yard.id}/performance`)).status).toBe(200);
  });

  it('gives an executive NPS wave by wave', async () => {
    const s = await seed();
    const wave = await prisma.clientNpsWave.create({ data: { quarter: '2026-Q3', closesAt: new Date(Date.now() + DAY) } });
    const scores = [10, 9, 7, 3];
    for (const [i, score] of scores.entries()) {
      await prisma.clientNpsInvite.create({ data: { waveId: wave.id, clientId: s.harbor.id, email: `m${i}@x.example`, tokenHash: `tok-${i}`, expiresAt: new Date(Date.now() + DAY), respondedAt: daysAgo(3), score } });
    }
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const r = await (await loginAs(agent(), user.email)).get(`/clients/${s.harbor.id}/performance`);
    expect(r.status).toBe(200);
    // (2 promoters − 1 detractor) / 4 answers = +25.
    expect(r.body.nps).toEqual([{ quarter: '2026-Q3', nps: 25, responses: 4 }]);
  });

  it('keeps the Fieldglass bill rate (client money) from someone who reads clients without statements', async () => {
    const client = await createClient('Rate Holdings');
    await prisma.client.update({ where: { id: client.id }, data: { fieldglassBillRate: 27.5, fieldglassSiteName: 'Site 1' } });
    const desk = await noMoneyAgent();
    const one = await desk.get(`/clients/${client.id}`);
    expect(one.status).toBe(200);
    expect(one.body.fieldglassSiteName).toBe('Site 1');
    expect(one.body).not.toHaveProperty('fieldglassBillRate');
    const list = await desk.get('/clients');
    expect(byName(list.body.clients, 'Rate Holdings')).not.toHaveProperty('fieldglassBillRate');

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const finance = await loginAs(agent(), user.email);
    expect((await finance.get(`/clients/${client.id}`)).body.fieldglassBillRate).toBe(27.5);
  });
});
