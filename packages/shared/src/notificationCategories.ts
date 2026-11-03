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
 *  Adding a new bucket: append to NOTIFICATION_CATEGORIES AND extend
 *  bucketForCategory() below so the raw category strings the routes pass
 *  map back to a user-facing key (and give it an icon and a translated
 *  name in the web bell: BUCKET_ICON, bell.cat.<key>).
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
    description:
      'Always on — password and sign-in alerts, bank account changes, access changes, and other required notices.',
    mandatory: true,
    audience: 'all',
  },
  {
    key: 'assistant',
    label: 'Assistant tasks and notes',
    description:
      'When a task you gave the assistant is done or needs you, and what it noticed for you. Which notes it raises is just below.',
    mandatory: false,
    // A client portal account has no assistant (the web never offers it one).
    audience: 'staff',
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
  // Every kind of notice can be switched off (owner, 2026-11-02). The raw
  // categories these hold had no bucket at all, which made their email
  // impossible to mute — the bulk of what the office called "bombarded".
  {
    key: 'transport',
    label: 'Rides and transport',
    description: 'Your ride and its pickup, run changes for drivers, and transport alerts for the desk.',
    mandatory: false,
    audience: 'all',
  },
  {
    key: 'finance',
    label: 'Finance and billing',
    description:
      'Payroll funding, returned deposits, the month-end close, Fieldglass worksheets, and financial changes to review.',
    mandatory: false,
    audience: 'office',
  },
  {
    key: 'recruiting',
    label: 'Recruiting',
    description: 'Candidates, interviews, offers, and applications in your pipeline.',
    mandatory: false,
    audience: 'office',
  },
  {
    key: 'approvals_tasks',
    label: 'Approvals and handoffs',
    description: 'Requests waiting for your approval, tasks and relay work handed to you, and AI agent alerts.',
    mandatory: false,
    audience: 'office',
  },
  {
    key: 'reports_digests',
    label: 'Reports and digests',
    description: 'The executive digest and alerts, and the weekly reliability and program digests.',
    mandatory: false,
    audience: 'office',
  },
  {
    key: 'emergency',
    label: 'Emergency alerts',
    description: 'Always on — emergencies at your site and what to do.',
    mandatory: true,
    audience: 'all',
  },
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['key'];
/** Who a bucket is for: Alto staff, the office alone (not the people on shift or driving), portal (store / market / region)
 *  accounts, or everyone. Settings lists only the buckets for the role. */
export type NotificationAudience = (typeof NOTIFICATION_CATEGORIES)[number]['audience'];

/** The buckets a role sees in Settings. */
export function notificationCategoriesFor(role: string) {
  const portal = role === 'CLIENT_PORTAL';
  // 'office' buckets (finance, recruiting, approvals, the executive digests)
  // are the office's work: someone on shift or driving never gets them, so
  // their Settings doesn't list a switch for them.
  const floor = role === 'ASSOCIATE' || role === 'DRIVER';
  return NOTIFICATION_CATEGORIES.filter(
    (c) => c.audience === 'all' || (portal ? c.audience === 'portal' : c.audience === 'staff' || (c.audience === 'office' && !floor)),
  );
}

/**
 * Map a raw call-site category string (e.g. 'shift_published',
 * 'payroll.payment_failed') to its user-facing NOTIFICATION_CATEGORIES
 * bucket. Single source of truth shared by the API's email-mute check and
 * the web bell's row labels/icons — previously two copies that drifted.
 * Null only for a notice with no category at all. An unknown string used to
 * be null too, which the API read as "always send, cannot be muted" — so
 * every category nobody had mapped was unmutable. It now falls to
 * 'workplace', a bucket anyone can switch off (owner, 2026-11-02).
 * `strict` keeps the old answer for display only: the bell names a pile of
 * an unnamed kind by the kind itself ("3 overdue timesheet reminders"),
 * not as "workplace & HR updates".
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
  opts: { strict?: boolean } = {},
): NotificationCategory | null {
  if (!raw) return null;
  // First, what must reach the person whatever their settings say: sign-in
  // and password mail, a changed bank account, the SSN re-collection, a
  // role grant, a required notice, a credential or a sign-up link (owner,
  // 2026-11-02 — everything else can be switched off).
  if (
    raw === 'security' ||
    raw.startsWith('security_') ||
    raw === 'access' ||
    raw === 'direct_deposit_change' ||
    raw === 'w4.ssn_recollection' ||
    raw === 'mandatory_notice' ||
    raw === 'password_reset' ||
    raw === 'forced_password_reset' ||
    raw.startsWith('email_change_') ||
    raw === 'kiosk_pin' ||
    raw === 'staff.invite' ||
    raw === 'portal.invite' ||
    raw === 'trust_download'
  )
    return 'security';
  if (raw === 'emergency' || raw.startsWith('emergency.')) return 'emergency';
  if (raw === 'broadcast') return 'broadcast';
  if (raw === 'message' || raw === 'crew-text') return 'messages';
  if (raw === 'portal.digest') return 'store_daily';
  if (raw === 'portal.coverage') return 'store_alerts';
  if (raw === 'client-request') return 'store_requests';
  if (
    raw === 'portal.service_report' ||
    raw === 'portal.statement' ||
    raw === 'portal.statement_reminder' ||
    raw === 'portal.ops_report' ||
    raw === 'client_nps'
  )
    return 'store_reports';
  // Staff-side operational sweeps. They resolved to no bucket at all, which
  // meant isEmailMuted() always answered false for them — so they were
  // unmutable, and a mute check added to their senders would have been a
  // no-op. 'workplace' is the staff bucket for operational alerts; the
  // portal.* buckets above are for CLIENT_PORTAL accounts, and these two go
  // to HR, Ops and the chairman.
  if (
    raw === 'portal.engagement_digest' ||
    raw === 'portal.engagement' ||
    raw === 'portal.readiness' ||
    raw === 'kiosk_device_alert'
  )
    return 'workplace';
  // The assistant's own notices (lib/hugoTasks, lib/hugoNotes) — named
  // hugo_*, never the audit action 'hugo.asked'.
  if (raw.startsWith('hugo_') || raw === 'assistant') return 'assistant';
  if (raw === 'discipline') return 'discipline';
  if (raw === 'probation') return 'probation';
  if (raw === 'transport' || raw.startsWith('transport.')) return 'transport';
  if (raw === 'finance' || raw.startsWith('finance.')) return 'finance';
  if (
    raw.startsWith('recruiting') ||
    raw === 'careers_application' ||
    raw === 'offer_letter' ||
    raw === 'candidate_portal'
  )
    return 'recruiting';
  // Something waiting on this person: an approval, a relay hand-off, a
  // workflow or task step, an AI agent asking or reporting.
  if (
    raw === 'approvals' ||
    raw.startsWith('relay.') ||
    raw === 'work-thread' ||
    raw === 'workflow' ||
    raw.startsWith('tasks.') ||
    raw.startsWith('agent_') ||
    raw === 'broadcast.review'
  )
    return 'approvals_tasks';
  if (
    raw === 'executive_digest' ||
    raw === 'executive_alert' ||
    raw === 'reliability_digest' ||
    raw === 'program_digest'
  )
    return 'reports_digests';
  if (raw === 'documents' || raw.startsWith('documents.')) return 'documents';
  if (raw === 'time-off' || raw === 'vto') return 'time_off';
  if (
    raw === 'scheduling' ||
    raw === 'schedule_digest' ||
    raw === 'week_ahead' ||
    raw === 'noshow_risk' ||
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
    raw === 'time' ||
    raw === 'tax_form' ||
    raw === 'paystub' ||
    raw.startsWith('pay.') ||
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
    raw === 'hr' ||
    raw === 'floor' ||
    raw === 'profile' ||
    raw === 'hotline_reply' ||
    raw === 'communications.test' ||
    raw.startsWith('ops.') ||
    raw.startsWith('decision_') ||
    raw.startsWith('compliance') ||
    raw.startsWith('reports')
  )
    return 'workplace';
  // Anything not named above — a category added later included — is a
  // workplace notice the person can switch off, never an unmutable one.
  return opts.strict ? null : 'workplace';
}

/** Raw categories that signal something went WRONG — the bell paints these
 *  rows in the alert tone so a failed payment never looks like a birthday. */
export function isUrgentCategory(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /failed|rejected|no_show|escalation|alert|voided|expired|coverage/.test(raw);
}

/* -------------------------------------------------------------------------- *
 *  HOW URGENT A NOTICE IS — which channels it earns (owner, 2026-11-02:
 *  27,059 emails in 30 days for 250 people, 99% of them repeating a bell row)
 *
 *    critical — safety, security, pay going wrong, required notices: every
 *               channel, now, quiet hours or not.
 *    action   — something waiting on this person: the bell, and a push now;
 *               the email follows their choice (the office: the morning
 *               summary; the floor: only if the bell copy is still unseen
 *               four hours on, or at once when no phone reaches them).
 *    info     — for their information: the bell (and the morning summary for
 *               those who take one). No push, no email of its own.
 *    digest   — a scheduled summary (the week ahead, the day's schedule, the
 *               ops digest): it IS the email. No push.
 * -------------------------------------------------------------------------- */
export type NotificationTier = 'critical' | 'action' | 'info' | 'digest';

const CRITICAL_BUCKETS: ReadonlySet<string> = new Set([
  'store_alerts',
  ...NOTIFICATION_CATEGORIES.filter((c) => c.mandatory).map((c) => c.key),
]);
const CRITICAL_RAW = /safety|emergency|incident|sos|panic|payroll|paystub|disburs|garnish|pay_|break_glass|security|hotline|osha/i;
const DIGEST_RAW: ReadonlySet<string> = new Set([
  'schedule_digest',
  'week_ahead',
  'ops.digest',
  'portal.digest',
  'portal.service_report',
  'portal.engagement_digest',
  'executive_digest',
  'reliability_digest',
  'program_digest',
  'digest',
]);
const INFO_RAW: ReadonlySet<string> = new Set(['earnings', 'attendance', 'birthday', 'anniversary', 'pulse', 'hugo_note']);

/** Raw categories that only inform (the info and digest tiers): the bell
 *  archives these once they are two weeks old (api lib/notificationRetention). */
export const INFO_ONLY_CATEGORIES: readonly string[] = [...INFO_RAW, ...DIGEST_RAW];

/** The tier a notice earns. A caller may name it (`tier`), and `urgent` always wins. */
export function notificationTier(
  raw: string | null | undefined,
  opts: { urgent?: boolean; tier?: NotificationTier } = {},
): NotificationTier {
  if (opts.urgent) return 'critical';
  if (opts.tier) return opts.tier;
  if (!raw) return 'action';
  const bucket = bucketForCategory(raw);
  if ((bucket && CRITICAL_BUCKETS.has(bucket)) || CRITICAL_RAW.test(raw)) return 'critical';
  if (DIGEST_RAW.has(raw)) return 'digest';
  if (INFO_RAW.has(raw) || raw.startsWith('hugo_note')) return 'info';
  return 'action';
}

/* -------------------------------------------------------------------------- *
 *  WHEN THINGS REACH A PERSON WHO NEVER CHOSE (owner, 2026-11-02)
 *
 *  Quiet from 9 PM to 7 AM in their own zone, for everyone. The office gets
 *  one summary each morning instead of an email per alert; the floor (the
 *  people on shift, their supervisors, drivers and the stores) gets only
 *  what needs them. Critical notices ignore all of it.
 * -------------------------------------------------------------------------- */
export type DeliveryModeKey = 'REALTIME' | 'DIGEST' | 'IMPORTANT' | 'DAILY' | 'OFF';
export const DEFAULT_QUIET_HOURS = { start: 21 * 60, end: 7 * 60 } as const;
/** The morning summary goes out at this hour, the person's own clock. */
export const SUMMARY_HOUR = 7;
const FLOOR_DELIVERY_ROLES: ReadonlySet<string> = new Set(['ASSOCIATE', 'DRIVER', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'CLIENT_PORTAL']);

export function defaultDeliveryFor(role: string): {
  quietHoursStart: number;
  quietHoursEnd: number;
  deliveryEmail: DeliveryModeKey;
  deliveryPush: DeliveryModeKey;
  deliverySms: DeliveryModeKey;
} {
  return {
    quietHoursStart: DEFAULT_QUIET_HOURS.start,
    quietHoursEnd: DEFAULT_QUIET_HOURS.end,
    deliveryEmail: FLOOR_DELIVERY_ROLES.has(role) ? 'IMPORTANT' : 'DAILY',
    deliveryPush: 'REALTIME',
    deliverySms: 'REALTIME',
  };
}
