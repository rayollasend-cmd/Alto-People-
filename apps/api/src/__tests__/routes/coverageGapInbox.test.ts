import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { computeRoleDecisions } from '../../lib/roleDecisions.js';
import { coverageAheadForUser, coverageGapsForUser } from '../../lib/coverageGaps.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The supervisor's coverage gap reaches the server: one definition
 * (lib/coverageGaps) feeds the Inbox source and the Needs-you queue, so
 * the bell and the phone badge agree with the notice on the home. And
 * the Needs-you open-shift count reads the shared open-shift rule.
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

const H = 3_600_000;

/** A store with an all-day "Swing" window (wraps, so it never ends) contracted for 2, led by Dana. */
async function seed() {
  const client = await createClient('Front Beach');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.staffingTarget.create({
    data: { locationId: store.id, targetCount: 2, effectiveFrom: new Date('2026-01-01'), label: 'Swing', startMinute: 0, endMinute: 0 },
  });
  const associate = await createAssociate({ firstName: 'Dana', lastName: 'Lead' });
  const { user: dana } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: associate.id });
  await prisma.supervisorShiftWindow.create({ data: { userId: dana.id, locationId: store.id, label: 'Swing' } });
  return { client, store, dana };
}

// Defaults to starting now: "in an hour" is tomorrow in the store's zone after 11 PM there.
const shift = (clientId: string, locationId: string, status: 'ASSIGNED' | 'OPEN', assignedAssociateId: string | null, startsAt = new Date()) =>
  prisma.shift.create({
    data: { clientId, locationId, position: 'Housekeeper', startsAt, endsAt: new Date(startsAt.getTime() + 4 * H), status, assignedAssociateId, publishedAt: new Date() },
  });

describe('coverage gaps on the server', () => {
  it('a short window counts in the Inbox and the Needs-you queue, and clears when the crew is scheduled', async () => {
    const { client, store, dana } = await seed();
    const a = await loginAs(dana.email);

    const gaps = await coverageGapsForUser(prisma, dana.id);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ scheduled: 0, openShiftIds: [], window: expect.objectContaining({ label: 'Swing', targetCount: 2 }) });

    const inbox = await a.get('/me/inbox');
    expect(inbox.status).toBe(200);
    const src = (inbox.body.sources as { key: string; count: number; path: string }[]).find((s) => s.key === 'coverage-gaps');
    // A same-day gap ranks with money (above routine timesheets), due when its window opens, named (F500 G5).
    expect(src).toMatchObject({ count: 1, urgency: 'money', preview: ["Today's Swing: 0 of 2 scheduled"] });
    expect((src as unknown as { dueAt: string }).dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(src!.path).toMatch(new RegExp(`^/scheduling\\?view=day&date=\\d{4}-\\d{2}-\\d{2}&locationId=${store.id}$`));

    const needs = await computeRoleDecisions(prisma, { id: dana.id, role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: null });
    const item = needs.find((d) => d.key === `coverage:${store.id}:Swing`);
    expect(item).toMatchObject({ severity: 'high', label: "Today's Swing: 0 of 2 scheduled", linkUrl: src!.path });

    // One person scheduled and one open shift: still short, the open one is named.
    const worker = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await shift(client.id, store.id, 'ASSIGNED', worker.id);
    const open = await shift(client.id, store.id, 'OPEN', null);
    const half = await coverageGapsForUser(prisma, dana.id);
    expect(half[0]).toMatchObject({ scheduled: 1, openShiftIds: [open.id] });
    expect((await computeRoleDecisions(prisma, { id: dana.id, role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: null })).find((d) => d.key === `coverage:${store.id}:Swing`)?.detail).toMatch(/1 open shift in the window/);

    // The second person fills the contract.
    const other = await createAssociate({ firstName: 'Omar', lastName: 'Diaz' });
    await shift(client.id, store.id, 'ASSIGNED', other.id);
    expect(await coverageGapsForUser(prisma, dana.id)).toEqual([]);
    const clear = await a.get('/me/inbox');
    expect((clear.body.sources as { key: string; count: number }[]).find((s) => s.key === 'coverage-gaps')?.count).toBe(0);
  });

  it('short vs contract over the next 7 days counts the contracted headcount nobody is scheduled as — not only posted open shifts (F500)', async () => {
    const { client, store, dana } = await seed();
    // Nothing scheduled, nothing posted: 2 short on each of 7 days. The old
    // tile counted posted OPEN shifts only, so it read "0 · Every shift covered".
    const none = await coverageAheadForUser(prisma, dana.id, new Date(), 7);
    expect(none).toMatchObject({ days: 7, shortOfContract: 14, windowsShort: 7, openPosted: 0, windows: 7 });
    expect(none.byDay[0]).toMatchObject({ locationId: store.id, label: 'Swing', target: 2, scheduled: 0, open: 0, short: 2 });

    // One person scheduled tomorrow, one open shift posted: 13 short, 1 posted open.
    const worker = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await shift(client.id, store.id, 'ASSIGNED', worker.id, new Date(Date.now() + 26 * H));
    await shift(client.id, store.id, 'OPEN', null, new Date(Date.now() + 50 * H));
    const a = await loginAs(dana.email);
    const res = await a.get('/floor/coverage-ahead?days=7');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 7, shortOfContract: 13, openPosted: 1 });
    // Counts and labels only — no person on the wire.
    expect(JSON.stringify(res.body)).not.toMatch(/Maria|Lopez/);

    // Only the caller's own windows: someone who leads none reads zeros, never Dana's.
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const theirs = await (await loginAs(assoc.email)).get('/floor/coverage-ahead');
    expect([200, 403]).toContain(theirs.status);
    if (theirs.status === 200) expect(theirs.body).toMatchObject({ shortOfContract: 0, windows: 0, byDay: [] });
  });

  it('the Needs-you open-shift count reads the shared rule: an open shift that ended is not open', async () => {
    const { client, store } = await seed();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    // Ended an hour ago, still OPEN: unfilled, not a decision.
    await shift(client.id, store.id, 'OPEN', null, new Date(Date.now() - 5 * H));
    const none = await computeRoleDecisions(prisma, { id: hr.id, role: 'HR_ADMINISTRATOR', clientId: null, associateId: null });
    expect(none.find((d) => d.key === 'shifts:open-24h')).toBeUndefined();
    await shift(client.id, store.id, 'OPEN', null, new Date(Date.now() + 2 * H));
    const one = await computeRoleDecisions(prisma, { id: hr.id, role: 'HR_ADMINISTRATOR', clientId: null, associateId: null });
    expect(one.find((d) => d.key === 'shifts:open-24h')?.label).toBe('1 shift in the next 24h still unassigned');
  });
});
