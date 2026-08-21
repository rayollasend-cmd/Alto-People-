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
    expect(items.some((d) => d.key.startsWith('receivable'))).toBe(false);
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

  it('role affinity: recruiter never sees money, marketing runs quiet, manager is team-clamped', async () => {
    const client = await createClient('Walmart Destin');
    // A finance condition + a hiring condition exist simultaneously.
    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        periodEnd: new Date('2026-05-31T00:00:00Z'),
        status: 'FINAL',
        number: 30,
        finalizedAt: new Date(Date.now() - 70 * 86_400_000),
        snapshot: { totals: { amount: 3000 } },
      },
    });
    const candidate = await createAssociate({ firstName: 'Stuck', lastName: 'InReview' });
    await prisma.application.create({
      data: {
        associateId: candidate.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'SUBMITTED',
      },
    });
    await prisma.$executeRaw`UPDATE "Application" SET "updatedAt" = NOW() - INTERVAL '10 days' WHERE "associateId" = ${candidate.id}::uuid`;

    // Recruiter: hiring items yes, money items never (despite full-admin caps).
    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const rq = await (await loginAs(recruiter.email)).get('/me/decisions');
    const rKeys = (rq.body.decisions as Item[]).map((d) => d.key);
    expect(rKeys.some((k) => k === 'onboarding:stuck')).toBe(true);
    expect(rKeys.some((k) => k.startsWith('receivable:'))).toBe(false);

    // Marketing: none of the ops/finance items at all.
    const { user: mkt } = await createUser({ role: 'MARKETING_MANAGER' });
    const mq = await (await loginAs(mkt.email)).get('/me/decisions');
    expect(
      (mq.body.decisions as Item[]).filter((d) => !d.key.startsWith('me:')),
    ).toHaveLength(0);

    // Manager: time-off counts only their direct reports.
    const mgrAssoc = await createAssociate({ firstName: 'Team', lastName: 'Lead' });
    const report = await createAssociate({ firstName: 'Direct', lastName: 'Report' });
    await prisma.associate.update({
      where: { id: report.id },
      data: { managerId: mgrAssoc.id },
    });
    const stranger = await createAssociate({ firstName: 'Other', lastName: 'Team' });
    await prisma.timeOffRequest.createMany({
      data: [
        {
          associateId: report.id,
          category: 'PTO',
          startDate: new Date('2026-10-01T00:00:00Z'),
          endDate: new Date('2026-10-02T00:00:00Z'),
          requestedMinutes: 960,
        },
        {
          associateId: stranger.id,
          category: 'PTO',
          startDate: new Date('2026-10-01T00:00:00Z'),
          endDate: new Date('2026-10-02T00:00:00Z'),
          requestedMinutes: 960,
        },
      ],
    });
    const { user: mgr } = await createUser({
      role: 'MANAGER',
      associateId: mgrAssoc.id,
      email: mgrAssoc.email,
    });
    const gq = await (await loginAs(mgr.email)).get('/me/decisions');
    const timeOff = (gq.body.decisions as Item[]).find((d) => d.key === 'timeoff:pending');
    expect(timeOff).toBeDefined();
    expect(timeOff!.label).toContain('1 time-off request');
  });

  it('one-tap quick actions: approve-all walk-ins clocks people in; reactivate revives a paused associate', async () => {
    const client = await createClient('Walmart Destin');
    const a1 = await createAssociate({ firstName: 'One', lastName: 'Waiting' });
    const a2 = await createAssociate({ firstName: 'Two', lastName: 'Waiting' });
    await prisma.clockInRequest.createMany({
      data: [
        { associateId: a1.id, clientId: client.id, requestedAt: new Date(Date.now() - 10 * 60_000) },
        { associateId: a2.id, clientId: client.id, requestedAt: new Date(Date.now() - 5 * 60_000) },
      ],
    });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(sup.email);

    const quick = await agent
      .post('/me/decisions/quick')
      .send({ key: `walkins:pending:${client.id}` });
    expect(quick.status).toBe(200);
    expect(quick.body.summary).toContain('Approved 2');
    // Both are genuinely on the clock, backdated to their punch.
    const entries = await prisma.timeEntry.findMany({
      where: { associateId: { in: [a1.id, a2.id] }, status: 'ACTIVE' },
    });
    expect(entries).toHaveLength(2);
    expect(
      await prisma.clockInRequest.count({ where: { status: 'PENDING', clientId: client.id } }),
    ).toBe(0);

    // Reactivate quick action (admin queue).
    const paused = await createAssociate({ firstName: 'Long', lastName: 'Paused' });
    await prisma.associate.update({
      where: { id: paused.id },
      data: { deactivatedAt: new Date(Date.now() - 50 * 86_400_000) },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const re = await hrAgent
      .post('/me/decisions/quick')
      .send({ key: `associate:paused:${paused.id}` });
    expect(re.status).toBe(200);
    const after = await prisma.associate.findUniqueOrThrow({ where: { id: paused.id } });
    expect(after.deactivatedAt).toBeNull();
  });

  it('one item, one room: Finance claim shows on the chairman queue; the thread is shared both ways', async () => {
    const client = await createClient('Walmart Destin');
    const stmt = await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        periodEnd: new Date('2026-05-31T00:00:00Z'),
        status: 'FINAL',
        number: 21,
        finalizedAt: new Date(Date.now() - 50 * 86_400_000),
        snapshot: { totals: { amount: 2500 } },
      },
    });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const finAgent = await loginAs(fin.email);
    const execAgent = await loginAs(exec.email);
    const key = `receivable:${stmt.id}`;

    // Finance claims it in THEIR queue…
    expect(
      (await finAgent.post('/me/decisions/act').send({ key, action: 'claim' })).status,
    ).toBe(200);
    // …and the CHAIRMAN's executive queue shows who's on it.
    const brief = await execAgent.get('/executive/briefing');
    const item = (
      brief.body.decisions as Array<{ key: string; claimedBy: { name: string } | null }>
    ).find((d) => d.key === key);
    expect(item).toBeDefined();
    expect(item!.claimedBy).not.toBeNull();

    // Finance writes to the room; the chairman reads the same thread and
    // replies — his comment notifies the claimer.
    expect(
      (
        await finAgent
          .post('/me/decisions/comment')
          .send({ key, body: 'Walmart AP says the check went out Tuesday.' })
      ).status,
    ).toBe(201);
    const room = await execAgent.get(`/me/decisions/item?key=${key}`);
    expect(room.status).toBe(200);
    expect(room.body.thread).toHaveLength(1);
    expect(room.body.thread[0].body).toContain('check went out Tuesday');
    expect(room.body.claimedBy).not.toBeNull();
    expect(
      (
        await execAgent
          .post('/me/decisions/comment')
          .send({ key, body: "Good. If it's not cleared Friday, I call their VP." })
      ).status,
    ).toBe(201);
    const ping = await prisma.notification.findFirst({
      where: { recipientUserId: fin.id, category: 'decision_comment' },
    });
    expect(ping).not.toBeNull();
    // Timeline carries the claim event.
    const room2 = await finAgent.get(`/me/decisions/item?key=${key}`);
    expect(room2.body.thread).toHaveLength(2);
    expect(
      (room2.body.timeline as Array<{ action: string }>).some((t) =>
        t.action.includes('took the item'),
      ),
    ).toBe(true);

    // Room 2.0: the facts panel carries the statement's own evidence…
    expect(
      (room2.body.facts as Array<{ label: string; value: string }>).some(
        (f) => f.label === 'Statement' && f.value === '#21',
      ),
    ).toBe(true);
    expect(
      (room2.body.facts as Array<{ label: string; value: string }>).some(
        (f) => f.label === 'Amount' && f.value === '$2500.00',
      ),
    ).toBe(true);
    // …and the pinned next step: the chairman sets it, Finance owns it,
    // and it echoes onto Finance's queue row.
    expect(
      (
        await execAgent.post('/me/decisions/next-step').send({
          key,
          text: 'Call Walmart AP about the missing check',
          ownerUserId: fin.id,
          dueDay: '2026-09-05',
        })
      ).status,
    ).toBe(200);
    const stepNotif = await prisma.notification.findFirst({
      where: { recipientUserId: fin.id, category: 'decision_next_step' },
    });
    expect(stepNotif).not.toBeNull();
    const room3 = await finAgent.get(`/me/decisions/item?key=${key}`);
    expect(room3.body.nextStep.text).toContain('Call Walmart AP');
    expect(room3.body.nextStep.dueDay).toBe('2026-09-05');
    const q = await finAgent.get('/me/decisions');
    const row = (
      q.body.decisions as Array<{ key: string; nextStep: { text: string } | null }>
    ).find((d) => d.key === key);
    expect(row?.nextStep?.text).toContain('Call Walmart AP');
  });

  it('assign moves the item to a colleague, postpone hides it, tag notifies, planner CRUDs', async () => {
    const client = await createClient('Walmart Destin');
    const a = await createAssociate({ firstName: 'Kiosk', lastName: 'Waiter' });
    await prisma.clockInRequest.create({
      data: { associateId: a.id, clientId: client.id, requestedAt: new Date() },
    });
    const { user: sup1 } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: sup2 } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent1 = await loginAs(sup1.email);
    const agent2 = await loginAs(sup2.email);
    const key = `walkins:pending:${client.id}`;

    // Colleagues list includes the same-site teammate.
    const col = await agent1.get('/me/colleagues');
    expect(col.status).toBe(200);
    expect(
      (col.body.colleagues as Array<{ id: string }>).some((c) => c.id === sup2.id),
    ).toBe(true);

    // Assign to sup2: they get the notification AND the ownership chip.
    const assign = await agent1
      .post('/me/decisions/act')
      .send({ key, action: 'assign', targetUserId: sup2.id, note: 'Take this while I cover GM.' });
    expect(assign.status).toBe(200);
    const assignNotif = await prisma.notification.findFirst({
      where: { recipientUserId: sup2.id, category: 'decision_assignment' },
    });
    expect(assignNotif).not.toBeNull();
    expect(assignNotif!.body).toContain('Take this while I cover GM.');
    const q2 = await agent2.get('/me/decisions');
    const mine = (
      q2.body.decisions as Array<Item & { claimedByMe: boolean; assigned: boolean }>
    ).find((d) => d.key === key);
    expect(mine?.claimedByMe).toBe(true);
    expect(mine?.assigned).toBe(true);

    // The assigner can reassign back to themselves.
    expect(
      (
        await agent1
          .post('/me/decisions/act')
          .send({ key, action: 'assign', targetUserId: sup1.id })
      ).status,
    ).toBe(400); // can't target yourself — not in your own colleague list
    // Tag notifies without changing hands.
    const tag = await agent2
      .post('/me/decisions/act')
      .send({ key, action: 'tag', targetUserId: sup1.id, note: 'FYI still working it.' });
    expect(tag.status).toBe(200);
    const tagNotif = await prisma.notification.findFirst({
      where: { recipientUserId: sup1.id, category: 'decision_tag' },
    });
    expect(tagNotif).not.toBeNull();

    // Postpone hides the item from everyone until the day comes.
    const post = await agent2
      .post('/me/decisions/act')
      .send({ key, action: 'postpone', days: 3 });
    expect(post.status).toBe(200);
    const q1 = await agent1.get('/me/decisions');
    expect((q1.body.decisions as Item[]).some((d) => d.key === key)).toBe(false);

    // Planner: add, list, check off, delete.
    const today = new Date().toISOString().slice(0, 10);
    const created = await agent1
      .post('/me/plan')
      .send({ day: today, title: 'Walk the floor at 2pm' });
    expect(created.status).toBe(201);
    const list = await agent1.get(`/me/plan?from=${today}&to=${today}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].done).toBe(false);
    expect(
      (
        await agent1.patch(`/me/plan/${created.body.id}`).send({ done: true })
      ).status,
    ).toBe(200);
    const list2 = await agent1.get(`/me/plan?from=${today}&to=${today}`);
    expect(list2.body.items[0].done).toBe(true);
    // Another user cannot touch it.
    expect(
      (await agent2.patch(`/me/plan/${created.body.id}`).send({ done: false })).status,
    ).toBe(404);
    expect((await agent1.delete(`/me/plan/${created.body.id}`)).status).toBe(200);
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
    const ar = hrItems.find((d) => d.key.startsWith('receivable:'));
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
