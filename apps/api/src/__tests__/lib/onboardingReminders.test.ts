import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplicationWithChecklist, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { runProgressReminderSweep } from '../../lib/inviteReminder.js';
import { runStaleNudgeSweep } from '../../lib/staleNudge.js';
import { REMINDER_ITEM_COOLDOWN_DAYS, dueReminderItems } from '../../lib/onboardingReminders.js';

/**
 * Repeat onboarding reminder emails (HR walk: "onboarding nags every 3
 * days"): the progress sweep and the stale-nudge sweep each mailed the
 * same person about the same tasks on their own clocks. Now every
 * automatic reminder answers to one rule — at most one reminder per task
 * per 3 days per person, never for a task that is done, and everything due
 * for a person goes out as one email.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date();
const at = (days: number) => new Date(T0.getTime() + days * DAY);

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** An accepted associate stalled on a 5-task checklist invited 10 days ago. */
async function stalled(email = `stalled-${Math.random().toString(36).slice(2, 8)}@example.com`, clientName?: string) {
  const client = await createClient(clientName);
  const assoc = await createAssociate({ firstName: 'Maria', email });
  const app = await createApplicationWithChecklist({ associateId: assoc.id, clientId: client.id });
  await prisma.application.update({ where: { id: app.id }, data: { invitedAt: at(-10) } });
  const { user } = await createUser({ role: 'ASSOCIATE', email: assoc.email, associateId: assoc.id });
  return { client, assoc, app, user };
}

async function reminderEmails(userId: string) {
  await flushPendingNotifications();
  return prisma.notification.findMany({
    where: { recipientUserId: userId, channel: 'EMAIL', category: { in: ['onboarding.progress_reminder', 'onboarding.nudge'] } },
    orderBy: { createdAt: 'asc' },
  });
}

describe('the per-task rule (pure)', () => {
  it('a task is due when open and not reminded in 3 days', () => {
    const now = at(0);
    const tasks = [
      { id: 'a', status: 'PENDING', remindedAt: null },
      { id: 'b', status: 'IN_PROGRESS', remindedAt: at(-REMINDER_ITEM_COOLDOWN_DAYS) },
      { id: 'c', status: 'PENDING', remindedAt: at(-2) },
      { id: 'd', status: 'DONE', remindedAt: null },
      { id: 'e', status: 'SKIPPED', remindedAt: at(-30) },
    ];
    expect(dueReminderItems(tasks, now).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('progress reminders: one email per person, one reminder per task per 3 days', () => {
  it('folds every due task into one email; a second run inside 3 days sends nothing; after 3 days it reminds again', async () => {
    const { user, app } = await stalled();

    const first = await runProgressReminderSweep(prisma, at(0));
    expect(first).toMatchObject({ reminded: 1, items: 5, errors: [] });
    let emails = await reminderEmails(user.id);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toMatch(/^\[Reminder\] 5 onboarding tasks still open/);
    for (const title of ['Profile', 'Documents', 'W-4', 'Payout', 'Policies']) expect(emails[0]!.body).toContain(`• ${title}`);
    const stamped = await prisma.onboardingTask.findMany({ where: { checklist: { applicationId: app.id } } });
    expect(stamped.every((t) => t.remindedAt?.getTime() === at(0).getTime())).toBe(true);

    // Twice more inside the 3 days: nothing.
    expect(await runProgressReminderSweep(prisma, at(1))).toMatchObject({ reminded: 0, items: 0 });
    expect(await runProgressReminderSweep(prisma, at(2.9))).toMatchObject({ reminded: 0, items: 0 });
    expect(await reminderEmails(user.id)).toHaveLength(1);

    // Three days on, the still-open tasks are due again — one email.
    expect(await runProgressReminderSweep(prisma, at(3))).toMatchObject({ reminded: 1, items: 5 });
    emails = await reminderEmails(user.id);
    expect(emails).toHaveLength(2);
  });

  it('a done task is never reminded; once everything is done the reminders stop', async () => {
    const { user, app } = await stalled();
    const tasks = await prisma.onboardingTask.findMany({ where: { checklist: { applicationId: app.id } }, orderBy: { order: 'asc' } });
    // Profile and W-4 done long ago (the person is still idle).
    await prisma.onboardingTask.updateMany({ where: { id: { in: [tasks[0]!.id, tasks[2]!.id] } }, data: { status: 'DONE', completedAt: at(-9) } });

    expect(await runProgressReminderSweep(prisma, at(0))).toMatchObject({ reminded: 1, items: 3 });
    const [email] = await reminderEmails(user.id);
    expect(email!.body).not.toContain('• Profile');
    expect(email!.body).not.toContain('• W-4');
    expect(email!.body).toContain('• Documents');
    const profile = await prisma.onboardingTask.findUniqueOrThrow({ where: { id: tasks[0]!.id } });
    expect(profile.remindedAt).toBeNull();

    // Everything done → no more reminders, however long it waits.
    await prisma.onboardingTask.updateMany({ where: { checklist: { applicationId: app.id } }, data: { status: 'DONE', completedAt: at(-9) } });
    expect(await runProgressReminderSweep(prisma, at(30))).toMatchObject({ reminded: 0, items: 0 });
    expect(await reminderEmails(user.id)).toHaveLength(1);
  });

  it('a person with three applications gets one email naming every due task', async () => {
    const { user, assoc } = await stalled(undefined, 'Coastal');
    for (const name of ['Harbor', 'Summit']) {
      const c = await createClient(name);
      const app = await createApplicationWithChecklist({ associateId: assoc.id, clientId: c.id });
      await prisma.application.update({ where: { id: app.id }, data: { invitedAt: at(-10) } });
    }
    expect(await runProgressReminderSweep(prisma, at(0))).toMatchObject({ reminded: 1, items: 15 });
    const emails = await reminderEmails(user.id);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe('[Reminder] 15 onboarding tasks still open');
    for (const place of ['Coastal', 'Harbor', 'Summit']) expect(emails[0]!.body).toContain(`Your onboarding for ${place}`);
  });
});

describe('the stale nudge answers to the same rule', () => {
  it('after a progress reminder, the automatic stale nudge sends nothing for 3 days', async () => {
    const { user } = await stalled();
    await runProgressReminderSweep(prisma, at(0));
    // The nudge's own 72h clock has never run for this person — only the per-task rule holds it.
    expect(await runStaleNudgeSweep({ now: at(1) })).toEqual({ nudged: 0, skipped: 1 });
    expect(await reminderEmails(user.id)).toHaveLength(1);
  });

  it('an automatic nudge stamps its tasks, so the progress sweep stays quiet; several due tasks are listed in the one nudge', async () => {
    const { user, app } = await stalled();
    expect(await runStaleNudgeSweep({ now: at(0) })).toEqual({ nudged: 1, skipped: 0 });
    const emails = await reminderEmails(user.id);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe('Quick nudge: Profile');
    expect(emails[0]!.body).toContain('Still open:');
    expect(emails[0]!.body).toContain('• Policies');
    const tasks = await prisma.onboardingTask.findMany({ where: { checklist: { applicationId: app.id } } });
    expect(tasks.every((t) => t.remindedAt !== null)).toBe(true);

    expect(await runProgressReminderSweep(prisma, at(1))).toMatchObject({ reminded: 0 });
    expect(await reminderEmails(user.id)).toHaveLength(1);
  });

  it('a person with two stale applications gets one automatic nudge, not two', async () => {
    const { user, assoc } = await stalled();
    const c = await createClient('Harbor');
    const second = await createApplicationWithChecklist({ associateId: assoc.id, clientId: c.id });
    await prisma.application.update({ where: { id: second.id }, data: { invitedAt: at(-9) } });
    expect(await runStaleNudgeSweep({ now: at(0) })).toEqual({ nudged: 1, skipped: 0 });
    expect(await reminderEmails(user.id)).toHaveLength(1);
    const secondTasks = await prisma.onboardingTask.findMany({ where: { checklist: { applicationId: second.id } } });
    expect(secondTasks.every((t) => t.remindedAt !== null)).toBe(true);
  });
});
