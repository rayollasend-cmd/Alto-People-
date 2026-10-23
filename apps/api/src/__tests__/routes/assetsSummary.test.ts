import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * F500 G2 — /assets says the numbers that matter: assigned, available, in
 * repair, lost, and kit still held by people who have left (the asset-
 * recovery view), each row marking a holder who left.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

describe('GET /assets summary', () => {
  it('counts by status over everything in reach, and the kit held by leavers', async () => {
    const stays = await createAssociate({ firstName: 'Stays', lastName: 'On' });
    const left = await createAssociate({ firstName: 'Has', lastName: 'Left' });
    await prisma.associate.update({ where: { id: left.id }, data: { separatedAt: new Date('2026-09-01') } });
    const mk = (label: string, status: 'AVAILABLE' | 'ASSIGNED' | 'IN_REPAIR' | 'LOST' | 'RETIRED') =>
      prisma.asset.create({ data: { kind: 'BADGE', label, status } });
    const a1 = await mk('Badge 1', 'ASSIGNED');
    const a2 = await mk('Badge 2', 'ASSIGNED');
    const a3 = await mk('Laptop 3', 'ASSIGNED');
    await mk('Spare 4', 'AVAILABLE');
    await mk('Spare 5', 'AVAILABLE');
    await mk('Scanner 6', 'IN_REPAIR');
    await mk('Key 7', 'LOST');
    await mk('Old 8', 'RETIRED');
    await prisma.assetAssignment.create({ data: { assetId: a1.id, associateId: stays.id } });
    await prisma.assetAssignment.create({ data: { assetId: a2.id, associateId: left.id } });
    await prisma.assetAssignment.create({ data: { assetId: a3.id, associateId: left.id } });
    // Returned kit doesn't count against a leaver.
    const returned = await mk('Vest 9', 'AVAILABLE');
    await prisma.assetAssignment.create({ data: { assetId: returned.id, associateId: left.id, returnedAt: new Date('2026-09-02') } });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/assets');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ assigned: 3, available: 3, inRepair: 1, lost: 1, heldByLeavers: 2 });
    const byLabel = Object.fromEntries(res.body.assets.map((a: { label: string; currentAssignment: { holderLeft: boolean } | null }) => [a.label, a.currentAssignment?.holderLeft ?? null]));
    expect(byLabel).toMatchObject({ 'Badge 1': false, 'Badge 2': true, 'Laptop 3': true, 'Vest 9': null });

    // The summary is over everything in reach, not the page's filter.
    const filtered = await agent.get('/assets?status=LOST');
    expect(filtered.body.assets).toHaveLength(1);
    expect(filtered.body.summary.assigned).toBe(3);

    // An associate has no view:org.
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: stays.id });
    expect((await (await loginAs(assoc.email)).get('/assets')).status).toBe(403);
  });
});
