import { describe, expect, it } from 'vitest';
import type { Notification } from '@alto-people/shared';
import { bellBadge, groupNotifications, groupTitle, needsMe, notificationKind } from '@/components/NotificationsBell';

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

describe('the bell badge — one meaning (F500 2026-10-26: bell 98 vs "Needs me (88)" vs "50 of 105")', () => {
  it('counts only NEW notices that ask something of you', () => {
    const now = new Date().toISOString();
    const list = [
      note({}), // new, needs me
      note({ category: 'payroll_failed', linkUrl: null }), // new, urgent
      note({ category: 'schedule_digest' }), // new, FYI only
      note({ seenAt: now }), // seen already
      note({ readAt: now, seenAt: now }), // dealt with
    ];
    expect(bellBadge(list)).toEqual({ count: 2, text: '2' });
  });
  it('caps at "9+" and says nothing at zero', () => {
    expect(bellBadge(Array.from({ length: 12 }, () => note({}))).text).toBe('9+');
    expect(bellBadge([note({ seenAt: new Date().toISOString() })])).toEqual({ count: 0, text: null });
  });
});

describe('grouping by kind', () => {
  it('folds a family of reminders whose categories differ only by type and date', () => {
    expect(notificationKind('compliance.attestation.WORKERS_COMP.2026-01-01')).toBe('compliance.attestation');
    const rows = groupNotifications([
      note({ category: 'compliance.attestation.WORKERS_COMP.2026-01-01' }),
      note({ category: 'compliance.attestation.GENERAL_LIABILITY.2026-01-01' }),
      note({ category: 'compliance.attestation.OSHA_300A_POSTING.2026-01-01' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('group');
  });
  it('keeps acronyms in a group title ("workplace & HR updates", never "hr")', () => {
    expect(groupTitle(4, 'workplace', 'Workplace & HR updates')).toBe('4 workplace & HR updates');
    expect(groupTitle(13, 'relay.escalation', null)).toBe('13 relay escalation notifications');
  });
});
