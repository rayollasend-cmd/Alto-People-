import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushProductEventsForTests, resetProductEventsForTests } from '../../lib/productEvents.js';

/**
 * ux-upgrade §6: the three behaviour events reach the rollup by role and come
 * back as time to first decision, decisions per session by role, and settings
 * searches per hundred sessions. Nothing per person is stored.
 */

beforeEach(async () => {
  await truncateAll();
  resetProductEventsForTests();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('product events', () => {
  it('ingests by role, rolls up per day, and reads back the three measures', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR' });
    const h = await loginAs(agent(), hr.email);
    const s = await loginAs(agent(), sup.email);

    expect((await h.post('/telemetry/product-events').send({ events: [{ kind: 'session_start' }, { kind: 'decision' }, { kind: 'first_decision', value: 30_000 }, { kind: 'decision' }, { kind: 'settings_search' }] })).status).toBe(202);
    expect((await h.post('/telemetry/product-events').send({ events: [{ kind: 'session_start' }, { kind: 'decision' }, { kind: 'first_decision', value: 90_000 }] })).status).toBe(202);
    expect((await s.post('/telemetry/product-events').send({ events: [{ kind: 'session_start' }, { kind: 'settings_search' }] })).status).toBe(202);
    expect((await h.post('/telemetry/product-events').send({ events: [{ kind: 'nope' }] })).status).toBe(400);
    expect((await agent().post('/telemetry/product-events').send({ events: [{ kind: 'decision' }] })).status).toBe(401);

    await flushProductEventsForTests();
    const rows = await prisma.productEventDaily.findMany();
    expect(rows.find((r) => r.role === 'HR_ADMINISTRATOR' && r.kind === 'decision')?.count).toBe(3);
    expect(rows.find((r) => r.role === 'HR_ADMINISTRATOR' && r.kind === 'first_decision')).toMatchObject({ count: 2, sum: 120_000 });
    // No user id anywhere in the rollup.
    expect(Object.keys(rows[0]!)).not.toContain('userId');

    const read = await h.get('/product-analytics/product-events?days=7');
    expect(read.status).toBe(200);
    expect(read.body.firstDecision).toEqual({ sessions: 2, avgMs: 60_000 });
    expect(read.body.decisionsPerSession).toEqual([
      { role: 'HR_ADMINISTRATOR', sessions: 2, decisions: 3, perSession: 1.5 },
      { role: 'SHIFT_SUPERVISOR', sessions: 1, decisions: 0, perSession: 0 },
    ]);
    expect(read.body.settingsSearches).toEqual({ count: 2, sessions: 3, perHundredSessions: 66.67 });

    // Reading is the product-analytics capability, not every signed-in role.
    expect((await s.get('/product-analytics/product-events')).status).toBe(403);
  });
});
