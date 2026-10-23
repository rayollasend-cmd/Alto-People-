import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * GET /pay-rules/summary — the "All clients" view of Pay rules (F500 G6):
 * each client in the caller's reach with its active project codes, active
 * premium-pay rules and open tip pools.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /pay-rules/summary', () => {
  it('counts active projects, active premium rules and open tip pools per client — and only the clients in reach', async () => {
    const coastal = await createClient('Coastal Resort');
    const harbor = await createClient('Harbor Grill');
    const harborSite = await prisma.site.findFirstOrThrow({ where: { clientId: harbor.id } });
    await prisma.project.createMany({ data: [
      { clientId: coastal.id, code: 'BQ', name: 'Banquets' },
      { clientId: coastal.id, code: 'HK', name: 'Housekeeping' },
      { clientId: coastal.id, code: 'OLD', name: 'Retired', isActive: false },
      { clientId: harbor.id, code: 'KIT', name: 'Kitchen' },
    ] });
    await prisma.premiumPayRule.createMany({ data: [
      { clientId: coastal.id, name: 'Night shift', kind: 'NIGHT_DIFFERENTIAL', addPerHour: 1.5 },
      { clientId: coastal.id, name: 'Old holiday', kind: 'HOLIDAY', multiplier: 1.5, isActive: false },
    ] });
    await prisma.tipPool.createMany({ data: [
      { clientId: coastal.id, name: 'Sat banquet', shiftDate: new Date('2026-10-17'), totalAmount: 400 },
      { clientId: coastal.id, name: 'Fri banquet', shiftDate: new Date('2026-10-16'), totalAmount: 300, status: 'PAID_OUT' },
      { clientId: harbor.id, name: 'Brunch', shiftDate: new Date('2026-10-18'), totalAmount: 120 },
    ] });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), fin.email);
    const r = await a.get('/pay-rules/summary');
    expect(r.status).toBe(200);
    expect(r.body.clients).toEqual([
      { clientId: coastal.id, clientName: 'Coastal Resort', projects: 2, premiumRules: 1, openTipPools: 1 },
      { clientId: harbor.id, clientName: 'Harbor Grill', projects: 1, premiumRules: 0, openTipPools: 1 },
    ]);
    // A finance account narrowed to Harbor's store sees Harbor only.
    const { user: narrow } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await prisma.user.update({ where: { id: narrow.id }, data: { scopeSiteIds: [harborSite.id] } });
    const n = await loginAs(agent(), narrow.email);
    expect((await n.get('/pay-rules/summary')).body.clients.map((c: { clientName: string }) => c.clientName)).toEqual(['Harbor Grill']);
    // Pay configuration isn't an associate's.
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(agent(), assoc.email)).get('/pay-rules/summary')).status).toBe(403);
  });
});
