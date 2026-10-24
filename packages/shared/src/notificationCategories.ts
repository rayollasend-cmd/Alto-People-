/**
 * Its own module, not part of contracts.ts, because the web app's
 * notification bell (in the signed-in shell, on every page) reads these:
 * importing them from contracts.ts pulled every schema, and zod, into the
 * shell. contracts.ts re-exports all of it, so imports are unchanged.
 */

/* -------------------------------------------------------------------------- *
 *  Notification preferences (per-user EMAIL opt-out by category)
 *
 *  IN_APP delivery is unaffected by these — the bell stays authoritative.
 *  Mandatory categories cannot be muted (formal HR notices and security
 *  alerts must reach the user no matter what).
 *
 *  Adding a new bucket: append to NOTIFICATION_CATEGORIES AND extend the
 *  bucketForRawCategory() resolver in apps/api/src/lib/notify.ts so the
 *  raw category strings the routes pass map back to a user-facing key.
 * -------------------------------------------------------------------------- */

export const NOTIFICATION_CATEGORIES = [
  {
    key: 'onboarding',
    label: 'Onboarding updates',
    description:
      'Application status, invite reminders, e-sign copies, and checklist nudges.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'documents',
    label: 'Document changes',
    description: 'Confirmations and rejections for documents you upload.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'time_off',
    label: 'Time-off decisions',
    description: 'Approvals, denials, and balance adjustments on PTO requests.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'scheduling',
    label: 'Schedule changes',
    description: 'Shifts you are added to, moved off of, or that get cancelled.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'shift_swaps',
    label: 'Shift swap requests',
    description: 'Peer swap offers, accepts, declines, and manager decisions.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'broadcast',
    label: 'Company announcements',
    description:
      'Broadcast messages from HR. The unsubscribe link in an announcement email turns off the email here; the bell and push keep their own switches.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'time_pay',
    label: 'Time & pay updates',
    description:
      'Time entry approvals and adjustments, payroll run notices, reimbursements, and benefits updates.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'growth',
    label: 'Career & growth',
    description:
      'Learning, mentorship, performance reviews, internal job postings, and development updates.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'workplace',
    label: 'Workplace & HR updates',
    description:
      'Org and team changes, HR cases, asset assignments, agreements, and operational alerts.',
    mandatory: false,
    audience: 'staff',
  },
  {
    key: 'discipline',
    label: 'Disciplinary actions',
    description: 'Always on — formal HR record required by policy.',
    mandatory: true,
    audience: 'staff',
  },
  {
    key: 'probation',
    label: 'Probation period',
    description: 'Always on — required HR notice.',
    mandatory: true,
    audience: 'staff',
  },
  {
    key: 'security',
    label: 'Account security',
    description: 'Always on — password resets and other security alerts.',
    mandatory: true,
    audience: 'all',
  },
  {
    key: 'messages',
    label: 'Messages',
    description: 'New messages in your conversations and store channels.',
    mandatory: false,
    audience: 'all',
  },
  {
    key: 'store_daily',
    label: 'Morning store note',
    description: "Today's headcount and open slots, and tomorrow's confirmations, each morning.",
    mandatory: false,
    audience: 'portal',
  },
  {
    key: 'store_alerts',
    label: 'Short-staffing alerts',
    description: 'A shift under way is meaningfully short of the people expected.',
    mandatory: false,
    audience: 'portal',
  },
  {
    key: 'store_requests',
    label: 'Request updates',
    description: 'Alto picked up or replied to a request raised for your store.',
    mandatory: false,
    audience: 'portal',
  },
  {
    key: 'store_reports',
    label: 'Reports and statements',
    description: "Saturday's service report and statements issued or paid.",
    mandatory: false,
    audience: 'portal',
  },
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['key'];
/** Who a bucket is for: Alto staff, portal (store / market / region)
 *  accounts, or everyone. Settings lists only the buckets for the role. */
export type NotificationAudience = (typeof NOTIFICATION_CATEGORIES)[number]['audience'];

/** The buckets a role sees in Settings. */
export function notificationCategoriesFor(role: string) {
  const portal = role === 'CLIENT_PORTAL';
  return NOTIFICATION_CATEGORIES.filter((c) => c.audience === 'all' || (portal ? c.audience === 'portal' : c.audience === 'staff'));
}

/**
 * Map a raw call-site category string (e.g. 'shift_published',
 * 'payroll.payment_failed') to its user-facing NOTIFICATION_CATEGORIES
 * bucket. Single source of truth shared by the API's email-mute check and
 * the web bell's row labels/icons — previously two copies that drifted.
 * Null = unknown string: the API treats it as "always send" (defensive
 * over-delivery) and the bell renders a neutral row.
 */
/* -------------------------------------------------------------------------- *
 *  WHO A SYSTEM NOTIFICATION IS ACTUALLY FOR
 *
 *  The admin fan-out (notifyAllAdmins) picks recipients by CAPABILITY —
 *  every ACTIVE user holding manage:onboarding, which is six roles. That
 *  answers "who is allowed to see this", which is not the same question as
 *  "whose job is this". The result was a MARKETING_MANAGER being told about
 *  every OSHA incident, every no-show and every separation in the company.
 *
 *  This table answers the second question. It is keyed on the RAW category
 *  the call site passes (not the settings bucket, which is deliberately
 *  coarse — 'workplace' covers HR cases, asset assignments AND floor
 *  alerts, so routing on it would lump a temperature alarm in with an
 *  agreement). Prefix entries ending in '.' match a namespace.
 *
 *  Two rules hold it together:
 *    - HR_ADMINISTRATOR is on every line. It is the one role guaranteed to
 *      exist, so it is the backstop that keeps any event from reaching
 *      nobody at all.
 *    - An unlisted category delivers to everyone, exactly as before. This
 *      table only ever NARROWS, and only where a decision was actually
 *      made, so a new category added elsewhere can never silently vanish.
 * -------------------------------------------------------------------------- */

const HR = 'HR_ADMINISTRATOR';
const OPS = 'OPERATIONS_MANAGER';
const WFM = 'WORKFORCE_MANAGER';
const REC = 'INTERNAL_RECRUITER';

export const CATEGORY_ROLE_ROUTING: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Hiring — the recruiter's pipeline, and the workforce manager's charter
  // covers the supervisor corps and seasonal cohorts.
  ['onboarding', [HR, REC, WFM]],
  ['internal-jobs', [HR, REC]],
  // People records — HR's own desk.
  // A document arriving mid-onboarding is the recruiter's pipeline too.
  ['documents', [HR, REC]],
  ['hr-cases', [HR]],
  ['benefits', [HR]],
  ['reimbursements', [HR]],
  ['separation', [HR, OPS]],
  ['dormancy', [HR, WFM]],
  // The floor. Store Ops is the workforce manager's manual and the
  // operations manager's day; neither is HR's, but HR stays as backstop.
  ['ops.', [HR, OPS, WFM]],
  ['scheduling', [HR, OPS, WFM]],
  ['shift_no_show', [HR, OPS, WFM]],
  ['ot_radar', [HR, OPS, WFM]],
  ['time-off', [HR, WFM]],
  // Safety and certifications.
  ['compliance', [HR, OPS]],
];

/**
 * True when this role should be told about this raw category. Unlisted
 * categories return true for everyone — see the fail-open rule above.
 */
export function roleWantsCategory(role: string, raw: string | null | undefined): boolean {
  if (!raw) return true;
  const hit = CATEGORY_ROLE_ROUTING.find(([key]) =>
    key.endsWith('.') ? raw.startsWith(key) : raw === key || raw.startsWith(`${key}.`),
  );
  return hit ? hit[1].includes(role) : true;
}

export function bucketForCategory(
  raw: string | null | undefined,
): NotificationCategory | null {
  if (!raw) return null;
  if (raw === 'broadcast') return 'broadcast';
  if (raw === 'message') return 'messages';
  if (raw === 'portal.digest') return 'store_daily';
  if (raw === 'portal.coverage') return 'store_alerts';
  if (raw === 'client-request') return 'store_requests';
  if (raw === 'portal.service_report' || raw === 'portal.statement' || raw === 'portal.ops_report')
    return 'store_reports';
  // Staff-side operational sweeps. They resolved to no bucket at all, which
  // meant isEmailMuted() always answered false for them — so they were
  // unmutable, and a mute check added to their senders would have been a
  // no-op. 'workplace' is the staff bucket for operational alerts; the
  // portal.* buckets above are for CLIENT_PORTAL accounts, and these two go
  // to HR, Ops and the chairman.
  if (raw === 'portal.engagement_digest' || raw === 'kiosk_device_alert') return 'workplace';
  if (raw === 'discipline') return 'discipline';
  if (raw === 'probation') return 'probation';
  if (raw === 'security') return 'security';
  if (raw === 'documents' || raw.startsWith('documents.')) return 'documents';
  if (raw === 'time-off' || raw === 'vto') return 'time_off';
  if (
    raw === 'scheduling' ||
    raw === 'schedule_digest' ||
    raw === 'week_ahead' ||
    raw.startsWith('shift_')
  )
    return 'scheduling';
  if (raw.startsWith('swap_')) return 'shift_swaps';
  if (raw.startsWith('onboarding')) return 'onboarding';
  if (
    raw === 'time_entry' ||
    raw === 'attendance' ||
    raw === 'earnings' ||
    raw === 'run' ||
    raw === 'reimbursements' ||
    raw === 'compensation' ||
    raw === 'equity' ||
    raw === 'benefits' ||
    raw === 'ot_radar' ||
    raw.startsWith('payroll')
  )
    return 'time_pay';
  if (
    raw === 'develop' ||
    raw === 'learning' ||
    raw === 'mentorship' ||
    raw === 'ramp' ||
    raw === 'performance' ||
    raw === 'tuition' ||
    raw === 'internal-jobs' ||
    raw === 'move' ||
    raw === 'marketplace' ||
    raw === 'pulse'
  )
    return 'growth';
  if (
    raw === 'org' ||
    raw === 'team' ||
    raw === 'asc' ||
    raw === 'assets' ||
    raw === 'agreements' ||
    raw === 'separation' ||
    raw === 'hr-cases' ||
    raw === 'dormancy' ||
    raw === 'executive_delegation' ||
    raw === 'birthday' ||
    raw === 'anniversary' ||
    raw.startsWith('ops.') ||
    raw.startsWith('decision_') ||
    raw.startsWith('compliance') ||
    raw.startsWith('reports')
  )
    return 'workplace';
  return null;
}

/** Raw categories that signal something went WRONG — the bell paints these
 *  rows in the alert tone so a failed payment never looks like a birthday. */
export function isUrgentCategory(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /failed|rejected|no_show|escalation|alert|voided|expired|coverage/.test(raw);
}
