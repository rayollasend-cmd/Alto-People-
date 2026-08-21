import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * GET /me/decisions — every seat's "Needs your decision" queue, generated
 * by capability and clamped to client scope for site-bound roles.
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
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

interface Item {
  key: string;
  label: string;
  severity: string;
  stakes: number | null;
}

describe('GET /me/decisions', () => {
  it('supervisor sees their own site walk-ins as critical — not the other client, not finance items', async () => {
    const mine = await createClient('Walmart Destin');
    const other = await createClient('Walmart Pier Park');
    const a1 = await createAssociate({ firstName: 'Here', lastName: 'Waiting' });
    const a2 = await createAssociate({ firstName: 'Else', lastName: 'Where' });
    await prisma.clockInRequest.create({
      data: { associateId: a1.id, clientId: mine.id, requestedAt: new Date(Date.now() - 20 * 60_000) },
    });
    await prisma.clockInRequest.create({
      data: { associateId: a2.id, clientId: other.id, requestedAt: new Date() },
    });
    // A finance item exists org-wide — supervisors must never see it.
    await prisma.clientStatement.create({
      data: {
        clientId: mine.id,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        periodEnd: new Date('2026-05-31T00:00:00Z'),
        status: 'FINAL',
        number: 9,
        finalizedAt: new Date(Date.now() - 70 * 86_400_000),
        snapshot: { totals: { amount: 5000 } },
      },
    });

    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const agent = await loginAs(sup.email);
    const res = await agent.get('/me/decisions');
    expect(res.status).toBe(200);
    const items = res.body.decisions as Item[];
    const walkins = items.find((d) => d.key.startsWith('walkins:pending'));
    expect(walkins).toBeDefined();
    expect(walkins!.severity).toBe('critical');
    expect(walkins!.label).toContain('1 walk-in');
    expect(items.some((d) => d.key === 'receivables:overdue')).toBe(false);
  });

  it('collaboration: same-site supervisors see claims, conflicting claims 409, escalation pings admins', async () => {
    const client = await createClient('Walmart Destin');
    const a = await createAssociate({ firstName: 'Kiosk', lastName: 'Waiter' });
    await prisma.clockInRequest.create({
      data: { associateId: a.id, clientId: client.id, requestedAt: new Date() },
    });
    const { user: sup1 } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: sup2 } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent1 = await loginAs(sup1.email);
    const agent2 = await loginAs(sup2.email);

    const key = `walkins:pending:${client.id}`;
    const claim = await agent1.post('/me/decisions/act').send({ key, action: 'claim' });
    expect(claim.status).toBe(200);

    // Teammate at the same site sees who has it, and can't double-claim.
    const q2 = await agent2.get('/me/decisions');
    const seen = (q2.body.decisions as Array<Item & { claimedBy: { name: string } | null; claimedByMe: boolean }>).find(
      (d) => d.key === key,
    );
    expect(seen).toBeDefined();
    expect(seen!.claimedBy).not.toBeNull();
    expect(seen!.claimedByMe).toBe(false);
    const conflict = await agent2.post('/me/decisions/act').send({ key, action: 'claim' });
    expect(conflict.status).toBe(409);
    // Only the claimer can release.
    expect(
      (await agent2.post('/me/decisions/act').send({ key, action: 'release' })).status,
    ).toBe(403);
    expect(
      (await agent1.post('/me/decisions/act').send({ key, action: 'release' })).status,
    ).toBe(200);

    // Escalation notifies the org admins with the note.
    const esc = await agent2
      .post('/me/decisions/act')
      .send({ key, action: 'escalate', note: 'Nobody free to cover the kiosk.' });
    expect(esc.status).toBe(200);
    const notif = await prisma.notification.findFirst({
      where: { recipientUserId: admin.id, category: 'decision_escalation' },
    });
    expect(notif).not.toBeNull();
    expect(notif!.body).toContain('Nobody free to cover the kiosk.');
  });

  it('HR admin sees finance + compliance items; an associate login gets a personal (or empty) queue', async () => {
    const client = await createClient();
    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        periodEnd: new Date('2026-05-31T00:00:00Z'),
        status: 'FINAL',
        number: 10,
        finalizedAt: new Date(Date.now() - 70 * 86_400_000),
        snapshot: { totals: { amount: 4321.5 } },
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const hrRes = await hrAgent.get('/me/decisions');
    expect(hrRes.status).toBe(200);
    const hrItems = hrRes.body.decisions as Item[];
    const ar = hrItems.find((d) => d.key === 'receivables:overdue');
    expect(ar).toBeDefined();
    expect(ar!.stakes).toBeCloseTo(4321.5, 2);
    expect(ar!.severity).toBe('critical');

    const assoc = await createAssociate({ firstName: 'Solo', lastName: 'Worker' });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: assoc.email,
      associateId: assoc.id,
    });
    const aAgent = await loginAs(user.email);
    const aRes = await aAgent.get('/me/decisions');
    expect(aRes.status).toBe(200);
    const aItems = aRes.body.decisions as Item[];
    // No finance/compliance leakage into the associate's personal queue.
    expect(aItems.every((d) => d.key.startsWith('me:'))).toBe(true);
  });
});
