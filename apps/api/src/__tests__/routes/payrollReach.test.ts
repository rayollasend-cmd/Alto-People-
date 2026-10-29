import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Deep audit 2026-10-29, CODE-5 / CODE-9 (payroll's part): a store-bound
 * office account (Operations manager, holds process:payroll) acts on its own
 * store's people only. Where someone's pay goes (the Branch card) and a
 * bonus on a run were checked against the tenant, not the caller's stores.
 */

const app = () => createApp();
async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function twoStores() {
  const client = await createClient('Two Store Client');
  const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const south = await prisma.site.create({ data: { name: 'South Store', clientId: client.id, timezone: 'America/New_York' } });
  const person = async (first: string, siteId: string) => {
    const p = await createAssociate({ firstName: first, lastName: 'Store' });
    await prisma.associate.update({ where: { id: p.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'FL' } });
    await prisma.application.create({ data: { associateId: p.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: siteId, startedAt: new Date('2024-01-02') } });
    return p;
  };
  const nora = await person('Nora', north.id);
  const sam = await person('Sam', south.id);
  const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
  await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [north.id] } });
  const ops = await loginAs(user.email);
  const run = await prisma.payrollRun.create({ data: { clientId: client.id, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'DRAFT' } });
  return { client, north, south, nora, sam, ops, run };
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('payroll reach for a store-bound account', () => {
  it('reads and changes the Branch card only for its own store’s people (CODE-5)', async () => {
    const w = await twoStores();
    expect((await w.ops.get(`/payroll/associates/${w.nora.id}/branch-enrollment`)).status).toBe(200);
    expect((await w.ops.get(`/payroll/associates/${w.sam.id}/branch-enrollment`)).status).toBe(404);
    const patch = await w.ops.patch(`/payroll/associates/${w.sam.id}/branch-enrollment`).send({ branchCardId: 'card_attacker' });
    expect(patch.status).toBe(404);
    expect(await prisma.payoutMethod.count({ where: { associateId: w.sam.id } })).toBe(0);
    expect((await w.ops.patch(`/payroll/associates/${w.nora.id}/branch-enrollment`).send({ branchCardId: 'card_nora' })).status).toBe(200);
  });

  it('never adds a bonus for another store’s person to a run (CODE-9)', async () => {
    const w = await twoStores();
    // Runs are company-wide money: a store-bound account is refused at the run…
    const other = await w.ops.post(`/payroll/runs/${w.run.id}/add-ons`).send({ associateId: w.sam.id, kind: 'BONUS', amount: 500 });
    expect([403, 404]).toContain(other.status);
    expect(await prisma.payrollRunAddOn.count({ where: { associateId: w.sam.id } })).toBe(0);
    // …and a company-wide account adds one for anyone (the person is loaded through its reach, which is everyone).
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const fin = await loginAs(user.email);
    expect((await fin.post(`/payroll/runs/${w.run.id}/add-ons`).send({ associateId: w.sam.id, kind: 'BONUS', amount: 100 })).status).toBe(201);
    // A person who isn't anyone's (another tenant's id, a typo) is a 404, never an add-on.
    const stranger = await fin.post(`/payroll/runs/${w.run.id}/add-ons`).send({ associateId: '00000000-0000-4000-8000-00000000abcd', kind: 'BONUS', amount: 100 });
    expect(stranger.status).toBe(404);
  });

  it('garnishments: another store’s person is out of reach — no new order, no status change, no deduction', async () => {
    const w = await twoStores();
    const g = await prisma.garnishment.create({ data: { associateId: w.sam.id, kind: 'CREDITOR', amountPerRun: 50, startDate: new Date('2026-01-01'), remitTo: 'Acme' } });
    const create = await w.ops.post('/garnishments').send({ associateId: w.sam.id, kind: 'CREDITOR', amountPerRun: 25, startDate: '2026-01-01', remitTo: 'Other' });
    expect([403, 404]).toContain(create.status);
    expect([403, 404]).toContain((await w.ops.post(`/garnishments/${g.id}/status`).send({ status: 'TERMINATED' })).status);
    expect([403, 404]).toContain((await w.ops.post(`/garnishments/${g.id}/deduct`).send({ amount: 50 })).status);
    const after = await prisma.garnishment.findUniqueOrThrow({ where: { id: g.id } });
    expect(after.status).toBe('ACTIVE');
    expect(Number(after.amountWithheld)).toBe(0);
    expect(await prisma.garnishment.count()).toBe(1);
  });

  it('tax forms are written company-wide only', async () => {
    const w = await twoStores();
    const r = await w.ops.post('/tax-forms/w2/generate').send({ taxYear: 2025 });
    expect(r.status).toBe(403);
  });

  it('two deductions at once on one order: both land, nothing lost', async () => {
    const w = await twoStores();
    const g = await prisma.garnishment.create({ data: { associateId: w.nora.id, kind: 'CREDITOR', amountPerRun: 50, startDate: new Date('2026-01-01'), remitTo: 'Acme' } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const fin = await loginAs(user.email);
    const [x, y] = await Promise.all([fin.post(`/garnishments/${g.id}/deduct`).send({ amount: 30 }), fin.post(`/garnishments/${g.id}/deduct`).send({ amount: 20 })]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(Number((await prisma.garnishment.findUniqueOrThrow({ where: { id: g.id } })).amountWithheld)).toBe(50);
  });

  it('a company-wide payroll account still reaches everyone', async () => {
    const w = await twoStores();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const fin = await loginAs(user.email);
    expect((await fin.get(`/payroll/associates/${w.sam.id}/branch-enrollment`)).status).toBe(200);
  });
});
