import { useLocation } from 'react-router-dom';

import type { Capability } from './roles';

export type ModuleKey =
  | 'onboarding'
  | 'time-attendance'
  | 'kiosk'
  | 'time-off'
  | 'scheduling'
  | 'labor-costs'
  | 'approvals'
  | 'payroll'
  | 'payroll-tax'
  | 'payroll-compliance'
  | 'documents'
  | 'doc-templates'
  | 'communications'
  | 'clients'
  | 'analytics'
  | 'compliance'
  | 'performance'
  | 'recruiting'
  | 'audit'
  | 'benefits'
  | 'people'
  | 'org'
  | 'org-chart'
  | 'celebrations'
  | 'assets'
  | 'pulse'
  | 'headcount'
  | 'skills'
  | 'mentorship'
  | 'expirations'
  | 'learning-paths'
  | 'succession'
  | 'probation'
  | 'holidays'
  | 'discipline'
  | 'separations'
  | 'internal-jobs'
  | 'vaccinations'
  | 'agreements'
  | 'hr-cases'
  | 'help-center'
  | 'ramp'
  | 'career'
  | 'tuition'
  | 'hotline'
  | 'equity'
  | 'volunteer'
  | 'team'
  | 'workflows'
  | 'me'
  | 'compensation'
  | 'reimbursements'
  | 'learning'
  | 'marketplace'
  | 'payrules'
  | 'dircomms'
  | 'integrations'
  | 'users'
  | 'branding'
  | 'billing'
  | 'reports';

/**
 * Phase 67 — sidebar groupings, F500-style. Modules with the same `group`
 * are rendered under a shared header in the sidebar. Order within a group
 * is the array order in `MODULES`. The "core" group is rendered without a
 * header (it's the always-on stuff: dashboard, onboarding, recruiting).
 */
export type ModuleGroup =
  | 'core'
  | 'workforce'
  | 'time-and-pay'
  | 'compliance'
  | 'insights';

export const GROUP_LABEL: Record<Exclude<ModuleGroup, 'core'>, string> = {
  workforce: 'Workforce',
  'time-and-pay': 'Time & Pay',
  compliance: 'Compliance',
  insights: 'Insights',
};

export interface ModuleNav {
  key: ModuleKey;
  path: string;
  label: string;
  description: string;
  requires: Capability;
  /** Phase 67 — sidebar grouping. */
  group: ModuleGroup;
}




export const MODULES: ModuleNav[] = [
  {
    key: 'me',
    path: '/me',
    label: 'My profile',
    description:
      'Personal info, emergency contacts, dependents, beneficiaries, life events, and tax documents — all the personal records you can manage yourself.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'onboarding',
    path: '/onboarding',
    label: 'Onboarding',
    description:
      'Digital application, document vault, e-signatures, background checks, and J-1 visa tracking.',
    requires: 'view:onboarding',
    group: 'workforce',
  },
  {
    key: 'recruiting',
    path: '/recruiting',
    label: 'Recruiting',
    description:
      'Candidate pipeline, interviews, offers, and hire-to-onboarding handoff.',
    requires: 'view:recruiting',
    group: 'workforce',
  },
  {
    key: 'people',
    path: '/people',
    label: 'People',
    description:
      'Directory of every associate — active, pending onboarding, and inactive — with workplace, pay rate, employment type, manager, and contact info in one row.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'org',
    path: '/org',
    label: 'Org structure',
    description:
      'Departments, cost centers, job profiles, and the manager chain that holds approvals + dimensional reporting together.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'org-chart',
    path: '/org/chart',
    label: 'Org chart',
    description:
      'Visual reporting tree across the company. Search by name, title, or department to focus a chain.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'celebrations',
    path: '/celebrations',
    label: 'Celebrations',
    description:
      'Upcoming birthdays and work anniversaries. Send a quick high-five from any row.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'assets',
    path: '/assets',
    label: 'Assets',
    description:
      'Physical items assigned to associates: laptops, phones, badges, keys, vehicles. Track who has what and when it came back.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'pulse',
    path: '/pulse',
    label: 'Pulse',
    description:
      'Anonymous one-question check-ins for engagement signal. Score distributions and verbatim comments — never the responder.',
    requires: 'view:dashboard',
    group: 'workforce',
  },
  {
    key: 'headcount',
    path: '/headcount',
    label: 'Headcount',
    description:
      'Active associates across the company, hires & separations over the last 30 / 90 / 365 days, annualized turnover.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'skills',
    path: '/skills',
    label: 'Skills',
    description:
      'Catalog of competencies and per-associate skill claims with proficiency level. Search the company by skill — useful for staffing and internal mobility.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'mentorship',
    path: '/mentorship',
    label: 'Mentorship',
    description:
      'Pair experienced associates with juniors. Suggestions use skills data to recommend ADVANCED+ mentors for a target growth skill.',
    requires: 'view:org',
    group: 'workforce',
  },
  {
    key: 'expirations',
    path: '/expirations',
    label: 'Expirations',
    description:
      'Qualifications and certifications expiring soon — chase renewals before they lapse. Bucketed expired / due soon / due later.',
    requires: 'view:org',
    group: 'compliance',
  },
  {
    key: 'learning-paths',
    path: '/learning-paths',
    label: 'Learning paths',
    description:
      'Sequence multiple courses into ordered tracks. Associates work through them in order; status reflects the next incomplete step.',
    requires: 'view:compliance',
    group: 'compliance',
  },
  {
    key: 'succession',
    path: '/succession',
    label: 'Succession',
    description:
      'Designate successors for each position with a readiness band — ready now, 1–2 years, 3+ years, or emergency cover.',
    requires: 'view:hr-admin',
    group: 'workforce',
  },
  {
    key: 'probation',
    path: '/probation',
    label: 'Probation',
    description:
      'New-hire probation periods. See who is active, ending soon, or overdue. Pass, extend, or fail before the end date.',
    requires: 'view:hr-admin',
    group: 'workforce',
  },
  {
    key: 'holidays',
    path: '/holidays',
    label: 'Holidays',
    description:
      'Federal, state, company, and client-specific holidays. Drives premium pay multipliers and shift planning.',
    requires: 'view:scheduling',
    group: 'time-and-pay',
  },
  {
    key: 'discipline',
    path: '/discipline',
    label: 'Discipline',
    description:
      'Formal warning ladder — verbal, written, final, suspension, termination. Associates can acknowledge; HR can rescind.',
    requires: 'view:hr-admin',
    group: 'compliance',
  },
  {
    key: 'separations',
    path: '/separations',
    label: 'Separations',
    description:
      'Plan, process, and complete associate departures. Capture exit-interview feedback — rating, what worked, what to change.',
    requires: 'view:hr-admin',
    group: 'workforce',
  },
  {
    key: 'internal-jobs',
    path: '/internal-jobs',
    label: 'Internal jobs',
    description:
      'Open positions across the company that current associates can apply to directly. Hiring managers review and decide.',
    requires: 'view:dashboard',
    group: 'workforce',
  },
  {
    key: 'vaccinations',
    path: '/vaccinations',
    label: 'Vaccinations',
    description:
      'Vaccination + TB-test records. Required by many client SLAs. Coverage % per kind, expiring-soon feed.',
    requires: 'view:compliance',
    group: 'compliance',
  },
  {
    key: 'agreements',
    path: '/agreements',
    label: 'Agreements',
    description:
      'NDAs, non-competes, IP assignments, equity grants — legal agreements with electronic signature. Associates see and sign their own; HR manages everyone’s.',
    // Lowered from view:hr-admin so associates can reach their own
    // agreements to e-sign; the page hides the org-wide "All" tab from
    // anyone without the admin capability.
    requires: 'view:dashboard',
    group: 'compliance',
  },
  {
    key: 'hr-cases',
    path: '/hr-cases',
    label: 'HR cases',
    description:
      'Ticketing for HR. File a question or concern, HR triages and replies. Internal notes stay hidden from the requester.',
    requires: 'view:dashboard',
    group: 'compliance',
  },
  {
    key: 'help-center',
    path: '/help-center',
    label: 'Help center',
    description:
      'Self-service knowledge base. Search articles by category and tag; vote helpful / not helpful. Deflects HR cases.',
    requires: 'view:dashboard',
    group: 'workforce',
  },
  {
    key: 'ramp',
    path: '/ramp',
    label: 'Ramp plans',
    description:
      'New-hire 30/60/90 day milestones. Manager updates status as they progress; achieve / miss is captured for the timeline.',
    requires: 'view:hr-admin',
    group: 'workforce',
  },
  {
    key: 'career',
    path: '/career',
    label: 'Career ladders',
    description:
      'Progression paths through your job family. Each rung links a job profile and lists required skills with a minimum proficiency.',
    requires: 'view:dashboard',
    group: 'workforce',
  },
  {
    key: 'learning',
    path: '/learning',
    label: 'My learning',
    description:
      'Courses assigned to you — work through required training and see what’s complete, due, or overdue.',
    requires: 'view:dashboard',
    group: 'workforce',
  },
  {
    key: 'tuition',
    path: '/tuition',
    label: 'Tuition',
    description:
      'Tuition reimbursement requests. Submit course-by-course with receipt and grade; HR approves and payroll pays out.',
    requires: 'view:dashboard',
    group: 'time-and-pay',
  },
  {
    key: 'hotline',
    path: '/hotline-admin',
    label: 'Hotline queue',
    description:
      'Anonymous reports filed via the public hotline. Triage, assign, and respond. Public reporters never see internal notes.',
    requires: 'manage:performance',
    group: 'compliance',
  },
  {
    key: 'equity',
    path: '/equity',
    label: 'Equity',
    description:
      'Stock and option grants with vesting schedules. Associates see their own grants; HR proposes, grants, cancels, exercises.',
    requires: 'view:dashboard',
    group: 'time-and-pay',
  },
  {
    key: 'volunteer',
    path: '/volunteer',
    label: 'Volunteer',
    description:
      'Log volunteer hours and request employer match payouts. Approved hours roll into the annual cap; HR triages, approves, and disburses match.',
    requires: 'view:dashboard',
    group: 'workforce',
  },
  {
    key: 'team',
    path: '/team',
    label: 'My team',
    description:
      'Direct reports, timesheet reviews, and time-off decisions. Visible to anyone with at least one direct report.',
    requires: 'view:my-team',
    group: 'workforce',
  },
  {
    key: 'workflows',
    path: '/workflows',
    label: 'Workflows',
    description:
      'Trigger-condition-action automation that fires on hires, time-off decisions, position changes, and other events.',
    requires: 'view:org',
    group: 'insights',
  },
  {
    key: 'clients',
    path: '/clients',
    label: 'Clients',
    description:
      'CRM, contracts, SOW renewals, and client portal access.',
    requires: 'view:clients',
    group: 'workforce',
  },
  {
    key: 'performance',
    path: '/performance',
    label: 'Performance',
    description:
      'Reviews, KPIs, PIPs, commendations, disciplinary log, and 360 feedback.',
    requires: 'view:performance',
    group: 'workforce',
  },
  {
    key: 'time-attendance',
    path: '/time-attendance',
    label: 'Time & attendance',
    description:
      'Geofenced clock-in, timesheet approvals, and attendance auditing.',
    requires: 'view:time',
    group: 'time-and-pay',
  },
  {
    key: 'kiosk',
    path: '/time-attendance/kiosk',
    label: 'Kiosk & PINs',
    description:
      'Manage kiosk devices, assign 4-digit clock-in PINs, and review punches.',
    requires: 'manage:time',
    group: 'time-and-pay',
  },
  {
    key: 'time-off',
    path: '/time-off',
    label: 'Time Off',
    description:
      'PTO requests, sick-leave balances, and HR approval queue.',
    requires: 'view:time',
    group: 'time-and-pay',
  },
  {
    key: 'scheduling',
    path: '/scheduling',
    label: 'Scheduling',
    description:
      'Shift planning, fill rate tracking, and assignment management.',
    requires: 'view:scheduling',
    group: 'time-and-pay',
  },
  {
    key: 'labor-costs',
    path: '/labor-costs',
    label: 'Labor costs',
    description:
      'Daily scheduled vs worked labor spend, broken down by client and store.',
    // Same audience as the scheduling KPI strip that already shows cost —
    // supervisors see their own client, org roles see everything.
    requires: 'manage:scheduling',
    group: 'time-and-pay',
  },
  {
    key: 'approvals',
    path: '/approvals',
    label: 'Approvals',
    description:
      'One inbox for every decision waiting on you — swap requests, open-shift pickups, unconfirmed shifts, time-off requests, and timesheets to review.',
    requires: 'manage:scheduling',
    group: 'time-and-pay',
  },
  {
    key: 'payroll',
    path: '/payroll',
    label: 'Payroll',
    description:
      'Multi-state payroll, anomaly detection, Branch cards, and Wise transfers.',
    requires: 'view:payroll',
    group: 'time-and-pay',
  },
  {
    key: 'payroll-tax',
    path: '/payroll/tax',
    label: 'Tax forms',
    description:
      'Garnishment orders, quarterly 941/940 builders, W-2 / 1099 generation and e-file exports, and the employer submitter profile.',
    requires: 'view:payroll',
    group: 'time-and-pay',
  },
  {
    key: 'payroll-compliance',
    path: '/payroll/compliance',
    label: 'Payroll compliance',
    description:
      'Federal tax deposit deadlines, garnishment remittances owed to agencies, and state new-hire reporting.',
    requires: 'process:payroll',
    group: 'time-and-pay',
  },
  {
    key: 'marketplace',
    path: '/marketplace',
    label: 'Open shifts',
    description:
      'Marketplace of open shifts qualified associates can pick up. Managers approve claims.',
    requires: 'view:scheduling',
    group: 'time-and-pay',
  },
  {
    key: 'payrules',
    path: '/payrules',
    label: 'Pay rules',
    description:
      'Project codes, premium-pay differentials (overtime, night, holiday), and tip pools.',
    // Pay rules are payroll configuration, not day-of-shift scheduling —
    // gated on view:payroll so client-scoped schedulers (SHIFT_SUPERVISOR
    // holds manage:scheduling) don't get a nav item that dead-ends.
    requires: 'view:payroll',
    group: 'time-and-pay',
  },
  {
    key: 'reimbursements',
    path: '/reimbursements',
    label: 'Reimbursements',
    description:
      'Submit expense reimbursements with receipts; managers approve and HR/Finance settles them into the next payroll run.',
    // Every associate can submit their own — the page scopes what each
    // role sees; approval/settlement actions stay capability-gated inside.
    requires: 'view:dashboard',
    group: 'time-and-pay',
  },
  {
    key: 'compensation',
    path: '/compensation',
    label: 'Compensation',
    description:
      'Pay bands, effective-dated comp history, and merit cycles — plan and apply pay changes for an entire population at once.',
    requires: 'view:comp',
    group: 'time-and-pay',
  },
  {
    key: 'benefits',
    path: '/benefits',
    label: 'Benefits',
    description:
      'Health, dental, vision, 401(k), HSA/FSA — pre-tax elections that come out of every paycheck.',
    requires: 'view:payroll',
    group: 'time-and-pay',
  },
  {
    key: 'documents',
    path: '/documents',
    label: 'Documents',
    description:
      'Centralized storage, e-signatures, expiration alerts, and audit trails.',
    requires: 'view:documents',
    group: 'compliance',
  },
  {
    key: 'doc-templates',
    path: '/templates',
    label: 'Document templates',
    description:
      'Mail-merge letter templates — offer letters, promotion and warning letters — rendered per associate and filed to their documents.',
    // Matches the /templates route gate in App.tsx. The page existed for a
    // while with NO nav entry (only a small link inside Documents), which
    // made the offer-letter workflow effectively undiscoverable.
    requires: 'view:hr-admin',
    group: 'compliance',
  },
  {
    key: 'compliance',
    path: '/compliance',
    label: 'Compliance',
    description:
      'OSHA, I-9, J-1, multi-state labor law, and certification tracking.',
    requires: 'view:compliance',
    group: 'compliance',
  },
  {
    key: 'audit',
    path: '/audit',
    label: 'Audit log',
    description:
      'Searchable, exportable feed of every auth, onboarding, payroll, and document event.',
    requires: 'view:audit',
    group: 'compliance',
  },
  {
    key: 'users',
    path: '/admin/users',
    label: 'Users & access',
    description:
      'List every account, change a role or status, and force a password reset (revokes active sessions).',
    requires: 'view:hr-admin',
    group: 'compliance',
  },
  {
    key: 'branding',
    path: '/admin/branding',
    label: 'Branding',
    description:
      'Org name, sender display, support email, primary colour, and logo applied to every outbound email.',
    requires: 'view:hr-admin',
    group: 'compliance',
  },
  {
    key: 'billing',
    path: '/admin/billing',
    label: 'Billing',
    description:
      'Plan, seat count, payment method, and invoice history. Manual contract today; self-serve billing on the roadmap.',
    requires: 'view:hr-admin',
    group: 'compliance',
  },
  {
    key: 'dircomms',
    path: '/directory',
    label: 'Directory & comms',
    description:
      'Search the people directory, send broadcasts, and run pulse / eNPS / open-ended surveys.',
    // Staff tool: the directory tab exposes every associate's email +
    // phone, so it's gated like the People directory (view:org) — NOT
    // view:dashboard, which every associate has.
    requires: 'view:org',
    group: 'insights',
  },
  {
    key: 'communications',
    path: '/communications',
    label: 'Communications',
    description:
      'SMS, push notifications, broadcast messaging, and templates.',
    requires: 'view:communications',
    group: 'insights',
  },
  {
    key: 'analytics',
    path: '/analytics',
    label: 'Analytics',
    description:
      'Executive dashboard, custom reports, and predictive analytics.',
    requires: 'view:analytics',
    group: 'insights',
  },
  {
    key: 'reports',
    path: '/reports',
    label: 'Reports',
    description:
      'Custom tabular reports — pick an entity (associates, time entries, payroll runs, applications…), choose columns and filters, save, run, and export.',
    requires: 'view:analytics',
    group: 'insights',
  },
  {
    key: 'integrations',
    path: '/integrations',
    label: 'Integrations',
    description:
      'Public API keys + outbound webhooks. Mint ASN bridge keys for AltoHR / ShiftReport Nexus and any other programmatic consumer.',
    requires: 'view:integrations',
    group: 'insights',
  },
];

/** Sidebar entry for the home dashboard (not a module). */
export const DASHBOARD_NAV = {
  path: '/',
  label: 'Dashboard',
} as const;

/**
 * The nav path that should be highlighted for the current location:
 * the module whose path is the LONGEST prefix of the pathname (same
 * longest-prefix rule as the route prefetcher).
 *
 * Plain NavLink prefix matching can't do this — some modules are nested
 * under others (Kiosk & PINs at /time-attendance/kiosk sits under Time &
 * Attendance at /time-attendance), and with prefix matching BOTH light
 * up. Longest-prefix keeps exactly one active: the deepest module that
 * owns the URL, while detail pages (/clients/:id) still highlight their
 * parent module.
 */
/** Module that owns a pathname — same longest-prefix rule as
 *  useActiveNavPath, returning the key instead of the path. Null for
 *  the dashboard and non-module routes. */
export function moduleKeyForPath(pathname: string): ModuleKey | null {
  let best: ModuleNav | null = null;
  for (const m of MODULES) {
    const hit = pathname === m.path || pathname.startsWith(`${m.path}/`);
    if (hit && (!best || m.path.length > best.path.length)) best = m;
  }
  return best?.key ?? null;
}

export function useActiveNavPath(): string | null {
  const { pathname } = useLocation();
  let best: string | null = null;
  for (const m of [DASHBOARD_NAV, ...MODULES]) {
    const p = m.path;
    // Dashboard ('/') is exact-only — as a prefix it would match every URL.
    const hit =
      p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`);
    if (hit && (best === null || p.length > best.length)) best = p;
  }
  return best;
}
