import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rankInboxSources, type InboxSource } from '@alto-people/shared';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * GET /me/inbox ranks by what it costs to be late (role walk HR 4): every
 * source carries an urgency band and, when its items have one, the soonest
 * deadline — so the Inbox can put an E-Verify mismatch and a three-day
 * claim notice above "Fieldglass setup (3)", however big that queue is.
 *
 * And the associate's rows are tasks (floor 24): "Finish onboarding, 2 of
 * 5 done" with the link into the checklist, "Upload leave certification"
 * with the day it is due — not just an unread count.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function inboxFor(email: string) {
  const a = agent();
  await loginAs(a, email, DEFAULT_TEST_PASSWORD);
  const res = await a.get('/me/inbox');
  expect(res.status).toBe(200);
  const body = res.body as { total: number; sources: InboxSource[] };
  return { body, byKey: new Map(body.sources.map((s) => [s.key, s])) };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

describe('GET /me/inbox — urgency and deadlines', () => {
  it('every source names its band; legal clocks are legal, payroll money is money, a punch to review is routine', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { body, byKey } = await inboxFor(user.email);

    for (const s of body.sources) expect(['legal', 'money', 'routine']).toContain(s.urgency);
    expect(byKey.get('everify-mismatches')?.urgency).toBe('legal');
    expect(byKey.get('ui-claims')?.urgency).toBe('legal');
    expect(byKey.get('leave-desk')?.urgency).toBe('legal');
    expect(byKey.get('payroll-review')?.urgency).toBe('money');
    expect(byKey.get('kiosk-review')?.urgency).toBe('routine');
  });

  it('a queue with a deadline carries the soonest one; an empty queue carries none', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const soon = new Date(Date.now() + 2 * 86_400_000);
    const later = new Date(Date.now() + 3 * 86_400_000);
    const a = await createAssociate({ firstName: 'Lena', lastName: 'Ortiz' });
    const b = await createAssociate({ firstName: 'Omar', lastName: 'Diaz' });
    for (const [who, due] of [
      [a, later],
      [b, soon],
    ] as const) {
      await prisma.leaveCase.create({
        data: {
          associateId: who.id,
          type: 'FMLA',
          reason: 'OWN_HEALTH',
          status: 'PENDING_CERTIFICATION',
          startDate: new Date(),
          certificationDueAt: new Date(dayKey(due) + 'T00:00:00.000Z'),
        },
      });
    }

    const { byKey } = await inboxFor(user.email);
    const leave = byKey.get('leave-desk')!;
    expect(leave.count).toBe(2);
    expect(leave.dueAt && dayKey(new Date(leave.dueAt))).toBe(dayKey(soon));
    // Nothing waiting: no deadline to show, whatever the band.
    const claims = byKey.get('ui-claims')!;
    expect(claims.count).toBe(0);
    expect(claims.dueAt ?? null).toBeNull();
  });

  it('the shared ranking puts legal before money before routine, then the soonest deadline, then the biggest count', () => {
    const src = (key: string, over: Partial<InboxSource>): InboxSource => ({ key, label: key, description: '', count: 1, path: `/${key}`, ...over });
    const ranked = rankInboxSources([
      src('fieldglass', { count: 3 }),
      src('bills', { urgency: 'money', count: 1, dueAt: '2026-10-30T00:00:00.000Z' }),
      src('claim', { urgency: 'legal', count: 1, dueAt: '2026-10-24T00:00:00.000Z' }),
      src('everify', { urgency: 'legal', count: 1 }),
      src('leave', { urgency: 'legal', count: 2, dueAt: '2026-10-25T00:00:00.000Z' }),
      src('punches', { count: 9 }),
    ]).map((s) => s.key);
    expect(ranked).toEqual(['claim', 'leave', 'everify', 'bills', 'punches', 'fieldglass']);
  });
});

describe('GET /me/inbox — the associate’s tasks', () => {
  it('an unfinished onboarding is one task with its progress and the link into the checklist', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const app = await createApplicationWithChecklist({ associateId: associate.id, clientId: client.id });
    const first = await prisma.onboardingTask.findFirstOrThrow({ where: { checklist: { applicationId: app.id } }, orderBy: { order: 'asc' } });
    await prisma.onboardingTask.update({ where: { id: first.id }, data: { status: 'DONE', completedAt: new Date() } });
    const { user } = await createUser({ role: 'ASSOCIATE', email: associate.email, associateId: associate.id });

    const { byKey } = await inboxFor(user.email);
    expect(byKey.get('my-onboarding')).toMatchObject({
      count: 1,
      description: '1 of 5 tasks done.',
      path: `/onboarding/me/${app.id}`,
      urgency: 'routine',
      progress: { done: 1, total: 5 },
    });
  });

  it('a finished checklist is no task at all', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    const app = await createApplicationWithChecklist({ associateId: associate.id, clientId: client.id });
    await prisma.onboardingTask.updateMany({ where: { checklist: { applicationId: app.id } }, data: { status: 'DONE', completedAt: new Date() } });
    const { user } = await createUser({ role: 'ASSOCIATE', email: associate.email, associateId: associate.id });

    const { byKey } = await inboxFor(user.email);
    expect(byKey.get('my-onboarding')?.count).toBe(0);
  });

  it('a leave waiting on their certification is a task with the day it is due; a personal leave needs none', async () => {
    const associate = await createAssociate();
    const due = new Date(Date.now() + 5 * 86_400_000);
    await prisma.leaveCase.create({
      data: { associateId: associate.id, type: 'FMLA', reason: 'OWN_HEALTH', status: 'PENDING_CERTIFICATION', startDate: new Date(), certificationDueAt: new Date(dayKey(due) + 'T00:00:00.000Z') },
    });
    await prisma.leaveCase.create({
      data: { associateId: associate.id, type: 'PERSONAL', reason: 'OTHER', status: 'REQUESTED', startDate: new Date() },
    });
    const { user } = await createUser({ role: 'ASSOCIATE', email: associate.email, associateId: associate.id });

    const { byKey } = await inboxFor(user.email);
    const cert = byKey.get('my-leave-certification')!;
    expect(cert.count).toBe(1);
    expect(cert.path).toBe('/leave');
    // A calendar day (dueDate), so it never reads a day early west of UTC.
    expect(cert.dueDate).toBe(dayKey(due));
  });
});
