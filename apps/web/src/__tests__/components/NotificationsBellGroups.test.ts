import { describe, expect, it } from 'vitest';
import type { Notification } from '@alto-people/shared';
import { groupNotifications, needsMe } from '@/components/NotificationsBell';

/**
 * The bell's two reading aids: "Needs me" keeps what asks something of
 * the person, and three or more of a kind fold into one row.
 */

let seq = 0;
const note = (over: Partial<Notification>): Notification =>
  ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    channel: 'IN_APP',
    status: 'SENT',
    recipientUserId: null,
    recipientPhone: null,
    recipientEmail: null,
    subject: 'Subject',
    body: 'Body',
    category: 'scheduling',
    externalRef: null,
    failureReason: null,
    sentAt: null,
    readAt: null,
    seenAt: null,
    senderUserId: null,
    senderEmail: null,
    linkUrl: '/scheduling',
    createdAt: new Date().toISOString(),
    ...over,
  }) as Notification;

describe('needsMe', () => {
  it('keeps unread items with somewhere to go, and anything urgent — while unread', () => {
    expect(needsMe(note({}))).toBe(true);
    expect(needsMe(note({ readAt: new Date().toISOString() }))).toBe(false);
    expect(needsMe(note({ linkUrl: null }))).toBe(false);
    expect(needsMe(note({ category: 'payroll_failed', linkUrl: null }))).toBe(true);
    // Read is dealt with, urgent or not — the chip agrees with the badge after "Mark all read".
    expect(needsMe(note({ category: 'payroll_failed', readAt: new Date().toISOString() }))).toBe(false);
  });
  it('leaves out what only informs: digests, announcements, earnings', () => {
    expect(needsMe(note({ category: 'schedule_digest' }))).toBe(false);
    expect(needsMe(note({ category: 'broadcast' }))).toBe(false);
    expect(needsMe(note({ category: 'earnings' }))).toBe(false);
    expect(needsMe(note({ category: 'paystub' }))).toBe(false);
  });
});

describe('groupNotifications', () => {
  it('folds three or more of a kind into one row at the newest one, and leaves pairs alone', () => {
    const list = [
      note({ category: 'scheduling', subject: 'A' }),
      note({ category: 'time-off', subject: 'B' }),
      note({ category: 'scheduling', subject: 'C' }),
      note({ category: 'time-off', subject: 'D' }),
      note({ category: 'scheduling', subject: 'E' }),
    ];
    const rows = groupNotifications(list);
    expect(rows.map((r) => (r.kind === 'group' ? `group:${r.items.length}` : r.n.subject))).toEqual(['group:3', 'B', 'D']);
  });
});
