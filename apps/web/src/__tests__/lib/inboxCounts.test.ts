import { describe, expect, it } from 'vitest';
import { inboxCountFor, inboxHomePath, inboxPagesOf, navBadgeFor } from '@/lib/inboxCounts';

/**
 * THE COUNT RULE (lib/inboxApi.ts; F500 audit 2026-10-26, "counts disagree"):
 * one inbox response, one meaning per number. The admin's numbers that day —
 * Inbox 42, "Time & scheduling 32", Approvals badge 1 over a page saying
 * "32 waiting" — are the fixture.
 */
const src = (key: string, count: number, path: string, watching = false) => ({ key, count, path, ...(watching ? { watching: true } : {}) });
const ADMIN = {
  total: 42,
  sources: [
    src('timesheets', 31, '/time-attendance?tab=queue&status=COMPLETED&from=2026-09-18&to=2026-10-26'),
    src('approval-requests', 1, '/approvals?tab=requests'),
    src('approvals', 0, '/approvals'),
    src('agent-proposals', 0, '/approvals?tab=proposals'),
    src('everify-mismatches', 1, '/compliance?tab=everify&status=issue'),
    src('provider-health', 1, '/integrations'),
    src('leave-desk', 2, '/leave'),
    src('ui-claims', 1, '/claims/unemployment'),
    src('wc-claims', 1, '/claims/workers-comp'),
    src('contract-duties', 4, '/compliance?tab=scorecard'),
    src('client-requests', 1, '/relay?tab=requests', true),
    src('fieldglass-setup', 25, '/fieldglass', true),
    src('my-availability', 1, '/scheduling#availability'),
  ],
};

describe('the count rule', () => {
  it('a source belongs to its page: the path without query or hash', () => {
    expect(inboxHomePath('/time-attendance?tab=queue&from=2026-09-18')).toBe('/time-attendance');
    expect(inboxHomePath('/scheduling#availability')).toBe('/scheduling');
  });

  it('a queue with an Approvals tab is listed on Approvals too (the registry’s approvalsTab)', () => {
    expect(inboxPagesOf({ key: 'timesheets', path: '/time-attendance?tab=queue' })).toEqual(['/time-attendance', '/approvals']);
    expect(inboxPagesOf({ key: 'approval-requests', path: '/approvals?tab=requests' })).toEqual(['/approvals']);
    expect(inboxPagesOf({ key: 'leave-desk', path: '/leave' })).toEqual(['/leave']);
  });

  it('the Approvals badge is what its page lists — the page header says the same number', () => {
    // 31 timesheets (worked on Approvals and on Time & attendance) + 1 pay & access change.
    expect(inboxCountFor(ADMIN, '/approvals')).toBe(32);
    expect(navBadgeFor(ADMIN, { key: 'approvals', path: '/approvals' })).toBe(32);
    expect(inboxCountFor(ADMIN, '/time-attendance')).toBe(31);
  });

  it('a door counts what waits behind it, each queue once (31 timesheets are 31, not 62)', () => {
    const timeAndScheduling = [
      { key: 'scheduling', path: '/scheduling' },
      { key: 'time', path: '/time-attendance' },
      { key: 'approvals', path: '/approvals' },
    ];
    expect(navBadgeFor(ADMIN, timeAndScheduling)).toBe(31 + 1 + 1);
  });

  it('another desk’s queue counts nowhere; the Inbox row is the total', () => {
    expect(inboxCountFor(ADMIN, '/fieldglass')).toBe(0);
    expect(inboxCountFor(ADMIN, '/relay')).toBe(0);
    expect(navBadgeFor(ADMIN, { key: 'inbox', path: '/inbox' })).toBe(42);
  });

  it('the unread-notices source is the bell’s number, never a badge', () => {
    const associate = { total: 3, sources: [src('my-notifications', 6, '/communications'), src('my-onboarding', 1, '/onboarding/me/x')] };
    expect(inboxCountFor(associate, '/communications')).toBe(0);
    expect(navBadgeFor(associate, [{ key: 'notices', path: '/communications' }, { key: 'onb', path: '/onboarding/me/x' }])).toBe(1);
  });

  it('says nothing until the inbox has loaded — never a wrong number', () => {
    expect(inboxCountFor(undefined, '/approvals')).toBeNull();
    expect(navBadgeFor(null, { key: 'inbox', path: '/inbox' })).toBeNull();
  });
});
