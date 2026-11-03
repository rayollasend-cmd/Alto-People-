import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import type { NotifyOpts } from '../../lib/notify.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { batchedInviteMessage, invitedByEmailToday, runShiftAutofillSweep } from '../../lib/shiftAutofill.js';
import { formatTimeInZone } from '../../lib/timezone.js';
import { orgTimeZone } from '../../lib/siteDay.js';

/**
 * Open-shift invitations, calmer (owner, 2026-11-02): one message per open
 * shift was 2,683 emails in 14 days to 174 associates — five or more on 153
 * person-days. Now a sweep sends each person ONE message for every shift it
 * newly offers them, and at most one invitation email a day; past it, the
 * bell and the lock screen carry the news.
 */

// Every notifyUser call the sweep makes, passed through to the real one.
const calls = vi.hoisted(() => [] as Array<{ userId: string; opts: NotifyOpts }>);
vi.mock('../../lib/notify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notify.js')>();
  return {
    ...real,
    notifyUser: (userId: string, opts: NotifyOpts, client?: Parameters<typeof real.notifyUser>[2]) => {
      calls.push({ userId, opts });
      return real.notifyUser(userId, opts, client);
    },
  };
});

beforeEach(async () => {
  await truncateAll();
  calls.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const H = 3_600_000;
const SINCE = new Date('2026-06-01T00:00:00.000Z');

async function store() {
  const client = await createClient('Lakeside Hotels');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const person = async (firstName: string) => {
    const associate = await createAssociate({ firstName, lastName: 'Bench' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    await prisma.associateAssignment.create({ data: { associateId: associate.id, locationId: site.id, startedAt: SINCE } });
    return { associate, user };
  };
  const open = (startsAt: Date, position = 'Housekeeper') =>
    prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: site.id,
        position,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 4 * H),
        status: 'OPEN',
        publishedAt: new Date(startsAt.getTime() - 12 * H),
      },
    });
  return { client, site, person, open };
}

describe('one message per person per sweep', () => {
  it('lists the three soonest of five new shifts, says how many more, and links the marketplace', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    const ann = await s.person('Ann');
    const bo = await s.person('Bo');
    // Created out of order: the message lists them soonest first.
    const shifts = [];
    for (const h of [22, 6, 30, 14, 10]) shifts.push(await s.open(new Date(now.getTime() + h * H)));

    const result = await runShiftAutofillSweep(prisma, now);
    await flushPendingNotifications();
    expect(result).toEqual({ shiftsScanned: 5, invitesSent: 10, messagesSent: 2 });

    expect(calls.map((c) => c.userId).sort()).toEqual([ann.user.id, bo.user.id].sort());
    for (const c of calls) {
      expect(c.opts).toMatchObject({ subject: '5 open shifts you can pick up', linkUrl: '/marketplace', category: 'shift_autofill' });
      expect(c.opts.skipEmail).toBeUndefined();
    }
    const bells = await prisma.notification.findMany({ where: { recipientUserId: ann.user.id, category: 'shift_autofill', channel: 'IN_APP' } });
    expect(bells).toHaveLength(1);
    const lines = bells[0]!.body.split('\n');
    expect(lines.filter((l) => l.startsWith('• '))).toHaveLength(3);
    const tz = orgTimeZone();
    const soonest = formatTimeInZone(new Date(now.getTime() + 6 * H), tz);
    expect(lines[0]).toContain(soonest);
    expect(lines[0]).toContain('Housekeeper at Lakeside Hotels');
    expect(lines[1]).toContain(formatTimeInZone(new Date(now.getTime() + 10 * H), tz));
    expect(lines).toContain('and 2 more');

    // Recorded per shift, as before: everyone was asked about every shift once.
    expect(await prisma.openShiftInvite.count({ where: { sendCount: 1 } })).toBe(10);
    calls.length = 0;
    expect(await runShiftAutofillSweep(prisma, now)).toMatchObject({ invitesSent: 0, messagesSent: 0 });
    expect(calls).toHaveLength(0);
  });

  it('a single shift reads as it always has, linked to that shift', () => {
    const startsAt = new Date('2026-07-15T14:00:00.000Z');
    const shift = {
      id: '11111111-1111-4111-8111-111111111111',
      clientId: null,
      locationId: null,
      position: 'Cook',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 4 * H),
      location: null,
      client: { name: 'Lakeside Hotels' },
      locationRel: { name: 'Lakeside', timezone: 'America/Chicago' },
    };
    expect(batchedInviteMessage([shift])).toMatchObject({
      subject: 'Open shift: Cook at Lakeside Hotels',
      linkUrl: `/marketplace?shift=${shift.id}`,
    });
    expect(batchedInviteMessage([shift, { ...shift, id: '22222222-2222-4222-8222-222222222222' }])).toMatchObject({
      subject: '2 open shifts you can pick up',
      linkUrl: '/marketplace',
    });
  });
});

describe('at most one invitation email a day', () => {
  it('the day’s first invitation may email; later ones that day ride the bell and push; the next day may email again', async () => {
    const now = pinMidweekNoon();
    const s = await store();
    const ann = await s.person('Ann');

    const first = await s.open(new Date(now.getTime() + 6 * H));
    await runShiftAutofillSweep(prisma, now);
    await flushPendingNotifications();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toMatchObject({ subject: 'Open shift: Housekeeper at Lakeside Hotels', linkUrl: `/marketplace?shift=${first.id}` });
    expect(calls[0]!.opts.skipEmail).toBeUndefined();
    // Sent now or held for later today, it is today's email.
    expect((await invitedByEmailToday(prisma, [ann.user.id], now)).has(ann.user.id)).toBe(true);

    // Two hours on, another shift opens: bell and push only.
    const later = new Date(now.getTime() + 2 * H);
    vi.setSystemTime(later);
    const second = await s.open(new Date(later.getTime() + 6 * H), 'Cook');
    await runShiftAutofillSweep(prisma, later);
    await flushPendingNotifications();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.opts).toMatchObject({ subject: 'Open shift: Cook at Lakeside Hotels', linkUrl: `/marketplace?shift=${second.id}`, skipEmail: true });
    const emailed = await prisma.notification.count({ where: { recipientUserId: ann.user.id, category: 'shift_autofill', channel: 'EMAIL' } });
    const held = await prisma.deferredNotification.count({ where: { userId: ann.user.id, category: 'shift_autofill', channel: 'EMAIL' } });
    expect(emailed + held).toBe(1);
    expect(await prisma.notification.count({ where: { recipientUserId: ann.user.id, category: 'shift_autofill', channel: 'IN_APP' } })).toBe(2);

    // The next company day, the first invitation may email again.
    const tomorrow = new Date(now.getTime() + 24 * H);
    vi.setSystemTime(tomorrow);
    await s.open(new Date(tomorrow.getTime() + 6 * H), 'Server');
    await runShiftAutofillSweep(prisma, tomorrow);
    await flushPendingNotifications();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.opts.skipEmail).toBeUndefined();
  });

  it('counts an email sent today or held for later, never yesterday’s or one that failed', async () => {
    const now = pinMidweekNoon();
    const people = await Promise.all(['Sent', 'Held', 'Yesterday', 'Failed', 'Other'].map(async (n) => (await createUser({ role: 'ASSOCIATE', email: `${n.toLowerCase()}@invite.test` })).user));
    const [sent, held, yesterday, failed, other] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0], (typeof people)[0], (typeof people)[0]];
    const email = (userId: string, sentAt: Date | null, category = 'shift_autofill') =>
      prisma.notification.create({ data: { channel: 'EMAIL', status: sentAt ? 'SENT' : 'FAILED', recipientUserId: userId, body: 'x', category, sentAt } });
    await email(sent.id, new Date(now.getTime() - 2 * H));
    await email(yesterday.id, new Date(now.getTime() - 24 * H));
    await email(failed.id, null);
    await email(other.id, new Date(now.getTime() - H), 'shift_reminder');
    await prisma.deferredNotification.create({ data: { userId: held.id, channel: 'EMAIL', reason: 'QUIET_HOURS', body: 'x', category: 'shift_autofill', dueAt: new Date(now.getTime() + 19 * H) } });

    const got = await invitedByEmailToday(prisma, people.map((p) => p.id), now);
    expect([...got].sort()).toEqual([sent.id, held.id].sort());
  });
});
