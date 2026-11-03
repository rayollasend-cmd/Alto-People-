import { describe, expect, it } from 'vitest';
import { NOTIFICATION_CATEGORIES, bucketForCategory, notificationCategoriesFor } from '../contracts.js';

/**
 * Every kind of notice can be switched off (owner, 2026-11-02). A raw
 * category the mapper did not know used to come back null, which the API
 * read as "always send, cannot be muted" — so approvals, transport, the
 * executive digests and dozens more reached people with no way to stop
 * them. Each raw value the API passes is named here with its bucket.
 */

const MANDATORY: ReadonlySet<string> = new Set(NOTIFICATION_CATEGORIES.filter((c) => c.mandatory).map((c) => c.key));

// Raw category → bucket, for every value the API passes today (grep
// `category: '` and the *_CATEGORY constants across apps/api/src).
const EXPECTED: Record<string, string> = {
  // Must reach the person whatever they chose.
  security: 'security',
  security_alert: 'security',
  access: 'security',
  direct_deposit_change: 'security',
  'w4.ssn_recollection': 'security',
  mandatory_notice: 'security',
  password_reset: 'security',
  forced_password_reset: 'security',
  email_change_verify: 'security',
  email_change_notice: 'security',
  kiosk_pin: 'security',
  'staff.invite': 'security',
  'portal.invite': 'security',
  trust_download: 'security',
  emergency: 'emergency',
  discipline: 'discipline',
  probation: 'probation',
  // New buckets.
  transport: 'transport',
  'finance.returned_deposit': 'finance',
  'finance.close_nudge': 'finance',
  'finance.reimbursement': 'finance',
  'finance.payroll_funding': 'finance',
  'finance.ewa': 'finance',
  'finance.fieldglass_add': 'finance',
  'finance.fieldglass_close': 'finance',
  'finance.changes': 'finance',
  'finance.packet': 'finance',
  recruiting: 'recruiting',
  recruiting_interview: 'recruiting',
  careers_application: 'recruiting',
  offer_letter: 'recruiting',
  candidate_portal: 'recruiting',
  approvals: 'approvals_tasks',
  'relay.escalation': 'approvals_tasks',
  'relay.request': 'approvals_tasks',
  'work-thread': 'approvals_tasks',
  workflow: 'approvals_tasks',
  'tasks.handoff': 'approvals_tasks',
  agent_approval: 'approvals_tasks',
  agent_drift: 'approvals_tasks',
  agent_kill: 'approvals_tasks',
  agent_shift_fill: 'approvals_tasks',
  'broadcast.review': 'approvals_tasks',
  executive_digest: 'reports_digests',
  executive_alert: 'reports_digests',
  reliability_digest: 'reports_digests',
  program_digest: 'reports_digests',
  // Existing buckets, newly reached.
  'pay.returned': 'time_pay',
  'pay.ewa': 'time_pay',
  time: 'time_pay',
  tax_form: 'time_pay',
  'payroll.prep': 'time_pay',
  'payroll.payment_failed': 'time_pay',
  noshow_risk: 'scheduling',
  shift_autofill: 'scheduling',
  'crew-text': 'messages',
  message: 'messages',
  assistant: 'assistant',
  hugo_task_done: 'assistant',
  'portal.statement_reminder': 'store_reports',
  client_nps: 'store_reports',
  'portal.engagement': 'workplace',
  'portal.engagement_digest': 'workplace',
  'portal.readiness': 'workplace',
  hr: 'workplace',
  floor: 'workplace',
  profile: 'workplace',
  hotline_reply: 'workplace',
  'communications.test': 'workplace',
  'compliance.i9': 'workplace',
  'compliance.attestation.digest': 'workplace',
  'documents.chase': 'documents',
  'onboarding.invite': 'onboarding',
  broadcast: 'broadcast',
};

describe('every raw category has a bucket', () => {
  it.each(Object.entries(EXPECTED))('%s → %s', (raw, bucket) => {
    expect(bucketForCategory(raw)).toBe(bucket);
  });

  it('only names buckets that exist', () => {
    const keys = new Set<string>(NOTIFICATION_CATEGORIES.map((c) => c.key));
    for (const bucket of new Set(Object.values(EXPECTED))) expect(keys, bucket).toContain(bucket);
  });

  it('an unknown category falls to a bucket the person can switch off — never to an unmutable one', () => {
    for (const raw of ['some-brand-new-thing', 'digest', 'status_updates', 'operations']) {
      const bucket = bucketForCategory(raw);
      expect(bucket).toBe('workplace');
      expect(MANDATORY.has(bucket!)).toBe(false);
    }
  });

  it('strict (the bell\'s display) still says "no bucket" for an unnamed kind, and agrees on every named one', () => {
    expect(bucketForCategory('overdue_timesheet_reminder', { strict: true })).toBeNull();
    for (const [raw, bucket] of Object.entries(EXPECTED)) expect(bucketForCategory(raw, { strict: true }), raw).toBe(bucket);
  });

  it('a notice with no category at all has no bucket', () => {
    expect(bucketForCategory(null)).toBeNull();
    expect(bucketForCategory(undefined)).toBeNull();
    expect(bucketForCategory('')).toBeNull();
  });

  it('keeps only security, safety and formal HR notices unmutable', () => {
    expect([...MANDATORY].sort()).toEqual(['discipline', 'emergency', 'probation', 'security']);
    for (const [raw, bucket] of Object.entries(EXPECTED)) {
      if (MANDATORY.has(bucket)) continue;
      expect(MANDATORY.has(bucketForCategory(raw)!), raw).toBe(false);
    }
  });
});

describe('the new buckets in Settings', () => {
  it('each has a label and a one-line description', () => {
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(c.label.length, c.key).toBeGreaterThan(3);
      expect(c.description.length, c.key).toBeGreaterThan(10);
    }
    expect(new Set(NOTIFICATION_CATEGORIES.map((c) => c.key)).size).toBe(NOTIFICATION_CATEGORIES.length);
  });

  it('shows the office buckets to staff, and transport and emergencies to everyone', () => {
    const staff = notificationCategoriesFor('HR_ADMINISTRATOR').map((c) => c.key);
    const portal = notificationCategoriesFor('CLIENT_PORTAL').map((c) => c.key);
    for (const k of ['transport', 'finance', 'recruiting', 'approvals_tasks', 'reports_digests', 'emergency']) expect(staff).toContain(k);
    expect(portal).toContain('emergency');
    expect(portal).toContain('transport');
    expect(portal).not.toContain('finance');
  });
});
