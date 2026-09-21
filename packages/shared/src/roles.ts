export const ROLES = {
  EXECUTIVE_CHAIRMAN: 'EXECUTIVE_CHAIRMAN',
  HR_ADMINISTRATOR: 'HR_ADMINISTRATOR',
  OPERATIONS_MANAGER: 'OPERATIONS_MANAGER',
  LIVE_ASN: 'LIVE_ASN',
  ASSOCIATE: 'ASSOCIATE',
  CLIENT_PORTAL: 'CLIENT_PORTAL',
  FINANCE_ACCOUNTANT: 'FINANCE_ACCOUNTANT',
  INTERNAL_RECRUITER: 'INTERNAL_RECRUITER',
  MANAGER: 'MANAGER',
  WORKFORCE_MANAGER: 'WORKFORCE_MANAGER',
  MARKETING_MANAGER: 'MARKETING_MANAGER',
  SHIFT_SUPERVISOR: 'SHIFT_SUPERVISOR',
  FLOOR_SUPERVISOR: 'FLOOR_SUPERVISOR',
  TRANSPORTATION_DIRECTOR: 'TRANSPORTATION_DIRECTOR',
  DRIVER: 'DRIVER',
} as const;

export type Role = keyof typeof ROLES;

export const ROLE_LABELS: Record<Role, string> = {
  EXECUTIVE_CHAIRMAN: 'Executive / Chairman',
  HR_ADMINISTRATOR: 'HR Administrator',
  OPERATIONS_MANAGER: 'Operations Manager',
  LIVE_ASN: 'Live ASN (system)',
  ASSOCIATE: 'Associate',
  CLIENT_PORTAL: 'Client Portal',
  FINANCE_ACCOUNTANT: 'Finance / Accountant',
  INTERNAL_RECRUITER: 'Internal Recruiter',
  MANAGER: 'Manager',
  WORKFORCE_MANAGER: 'Workforce Manager',
  MARKETING_MANAGER: 'Marketing Manager',
  SHIFT_SUPERVISOR: 'Shift Supervisor',
  FLOOR_SUPERVISOR: 'Floor Supervisor',
  TRANSPORTATION_DIRECTOR: 'Transportation Director',
  DRIVER: 'Driver',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  EXECUTIVE_CHAIRMAN: 'Read-only access across all modules and clients',
  HR_ADMINISTRATOR:
    'Everything — including the two highest-risk actions: voiding payroll runs and exporting payroll PII. Reserve for one or two owners; daily admins belong on Operations Manager',
  OPERATIONS_MANAGER:
    'The everyday admin role: full org-wide access plus expense approval — everything except voiding payroll and exporting payroll PII',
  LIVE_ASN: 'System integration portal — not for human login',
  ASSOCIATE: 'Personal access to own profile, schedule, and pay',
  CLIENT_PORTAL: 'Read-only access scoped to one client account',
  FINANCE_ACCOUNTANT: 'Time, scheduling, and payroll only — runs pay cycles, no HR data',
  INTERNAL_RECRUITER:
    'Full org-wide access (no payroll void / PII export) — permissions identical to Workforce and Marketing Manager; the title is the only difference',
  MANAGER:
    'Full org-wide access (no payroll void / PII export); lands on the team dashboard — direct reports, approvals, timesheets',
  WORKFORCE_MANAGER:
    'Field leadership: coverage across all stores, the supervisor corps, scheduling, time & standards, safety, recruiting and onboarding — no payroll, billing, or org-admin surface',
  MARKETING_MANAGER:
    'Full org-wide access (no payroll void / PII export) — permissions identical to Internal Recruiter and Workforce Manager; the title is the only difference',
  SHIFT_SUPERVISOR:
    'Scheduling, time & attendance, and onboarding invites for one client only — assign the client in Users & access',
  FLOOR_SUPERVISOR:
    "Watches one client's floor and helps on their shift's SOP; reports to a shift supervisor and runs the SOP when covering for them. No time approvals, edits, or walk-in decisions — assign the client, shift and shift supervisor in Users & access",
  TRANSPORTATION_DIRECTOR:
    'Runs the Alto vans: the transportation command center — ride bookings, dispatching van runs, cancellations, vans, drivers, stops, fares, ride charges, and riders’ issues. No HR, payroll or scheduling surface',
  DRIVER: "Drives an Alto van: today's runs, the pickups in order, and each rider marked on board or no-show",
};

export type Capability =
  | 'view:dashboard'
  | 'view:onboarding' | 'manage:onboarding'
  // Split out of manage:onboarding so the floor supervisor who actually
  // meets the new hire can send/resend the invite and nudge a stalled
  // applicant, without inheriting the HR review powers that ride on
  // manage:onboarding (approve/reject, I-9 Section 2, templates) or any
  // access to the applicant's personal record. Every manage:onboarding
  // holder also holds this — see ALL_MANAGE — so it is a strict superset
  // and UI can gate invite-shaped affordances on it alone.
  | 'invite:onboarding'
  | 'view:time' | 'manage:time'
  // The live clocked-in board (GET /time/admin/active) as a READ, split
  // from manage:time so the watch-only FLOOR_SUPERVISOR can see who is
  // on the floor without inheriting approvals, edits, or walk-in
  // decisions. Every manage:time holder also holds this.
  | 'view:time-live'
  | 'view:scheduling' | 'manage:scheduling'
  // Gap 3 — `void:payroll` is intentionally NOT part of FULL_ADMIN.
  // Voiding a disbursed run reverses a QBO journal entry and marks
  // associate paystubs as VOIDED. Granted to HR_ADMINISTRATOR only.
  // FINANCE_ACCOUNTANT and OPERATIONS_MANAGER both have process:payroll
  // but cannot void or amend disbursed runs.
  | 'view:payroll' | 'process:payroll' | 'void:payroll'
  // The external payroll sheet — the handoff file for an outside payroll
  // bureau. One row carries full SSN, full bank account + routing number,
  // DOB and home address: everything needed to open credit or drain an
  // account, for every worker in the range, in a single downloadable file.
  //
  // Deliberately NOT in FULL_ADMIN, same reasoning as void:payroll. Note
  // especially that the Time routes' usual guard is manage:time, which
  // SHIFT_SUPERVISOR holds — reusing it here would have handed floor
  // supervisors their whole client's identity documents.
  | 'export:payroll-pii'
  // Gap 10 — Reimbursement workflow caps (three-step split mirrors the
  // time-entry pattern). submit:reimbursement is the associate-side cap
  // for creating + submitting drafts. approve:reimbursement is the manager
  // step. settle:reimbursement is the HR/Finance step that flips a row
  // to SETTLED so it gets folded into the next REGULAR payroll run.
  | 'submit:reimbursement' | 'approve:reimbursement' | 'settle:reimbursement'
  | 'view:documents' | 'manage:documents'
  | 'view:communications' | 'manage:communications'
  | 'view:clients' | 'manage:clients'
  | 'view:analytics'
  | 'view:compliance' | 'manage:compliance'
  | 'view:performance' | 'manage:performance'
  | 'view:recruiting' | 'manage:recruiting'
  | 'view:audit'
  // Org-wide HR admin lists (probation, separation, ramp, succession,
  // discipline, agreements, document templates, goals/PIPs/360s).
  // Distinct from view:onboarding/performance/documents — those let an
  // associate see their *own* records via /me routes, this one unlocks
  // the cross-org HR dashboards.
  | 'view:hr-admin'
  // Phase 76 — manager-scoped + org-hierarchy capabilities.
  | 'view:my-team'
  | 'manage:team-time'
  | 'manage:team-time-off'
  | 'view:org' | 'manage:org'
  // Executive read-only surfaces: the executive dashboard, board pack,
  // live labor/margin board, client statements (read), and pulse results
  // (read). Held by EXECUTIVE_CHAIRMAN and the FULL_ADMIN family — never
  // by client-scoped or self-service roles.
  | 'view:executive'
  // Product telemetry — DAU/WAU, traffic, error rates, what the software
  // is actually used for. Deliberately NOT view:analytics: that one is
  // workforce reporting (retention, onboarding funnels) and is held by
  // finance and field roles who have no business reading org-wide usage.
  | 'view:product-analytics'
  // The audit packet — I-9 images, SSN cards and pay data for a whole
  // roster in one archive, the largest single PII export in the product.
  // It sat on view:hr-admin, a READ-tier capability in ALL_VIEWS, so six
  // roles could pull every worker's identity documents. Its own header
  // said it took "the same posture as the SSN reveal"; it did not.
  | 'export:audit-packet'
  // Phase 83 — compensation: history, bands, merit cycles.
  | 'view:comp' | 'manage:comp'
  // Phase 93 — public API keys + outbound webhooks.
  | 'view:integrations' | 'manage:integrations'
  // ASN integration — read-only capabilities issued *only* via API keys
  // (never granted to a human role). Power the AltoHR / ShiftReport Nexus
  // bridge so supervisors and command desks see Alto People schedule +
  // clock-in data inside their ops tooling. clientId on the issuing
  // ApiKey scopes per-store; clientId=null on the key = global view.
  | 'asn:read:schedule'
  | 'asn:read:roster'
  | 'asn:read:clocked-in'
  | 'asn:read:kpis'
  // Store Operations (SOP checklists, ops shifts, handover):
  //  - run:ops-shifts     open/run/close an operational shift — the shift
  //    supervisor's tool on the floor (client-clamped for bounded roles).
  //  - view:ops           the oversight board + scorecards (regional ops,
  //    HR admin, the chairman).
  //  - manage:ops-library edit the SOP standard itself. Per the owner's
  //    explicit call this is the ONE write the Executive/Chairman holds —
  //    the exec portal stays read-only everywhere else.
  //  - assist:ops-shifts  the floor supervisor's part: check items off on
  //    their shift's SOP, and — only while covering for their shift
  //    supervisor — run it, hand over, and submit it. Never opens a shift
  //    by hand. Every run:ops-shifts holder also holds it (a strict
  //    subset), so granting FLOOR_SUPERVISOR is never an escalation.
  | 'run:ops-shifts'
  | 'assist:ops-shifts'
  | 'view:ops'
  | 'manage:ops-library'
  // Transportation — the Alto vans:
  //  - ride:transport     book my own seat on a van (to or from work)
  //  - drive:transport    run my van runs: pickups, on board / no-show
  //  - view:transport     read the transportation command center
  //  - manage:transport   dispatch runs, cancel rides, vans, drivers,
  //    stops, fares, waive charges, work riders' issues
  | 'ride:transport'
  | 'drive:transport'
  | 'view:transport'
  | 'manage:transport';

const ALL_VIEWS: Capability[] = [
  'view:dashboard',
  'view:onboarding',
  'view:time',
  'view:scheduling',
  'view:payroll',
  'view:documents',
  'view:communications',
  'view:clients',
  'view:analytics',
  'view:compliance',
  'view:performance',
  'view:recruiting',
  'view:my-team',
  'view:org',
  'view:comp',
  'view:integrations',
  'view:hr-admin',
];

const ALL_MANAGE: Capability[] = [
  'manage:onboarding',
  'invite:onboarding',
  'manage:time',
  'manage:team-time',
  'manage:team-time-off',
  'manage:scheduling',
  'process:payroll',
  'manage:documents',
  'manage:communications',
  'manage:clients',
  'manage:compliance',
  'manage:performance',
  'manage:recruiting',
  'manage:org',
  'manage:comp',
  'manage:integrations',
];

// Org-wide admin: identical capability surface to HR_ADMINISTRATOR. Granted
// to OPERATIONS_MANAGER, MANAGER, INTERNAL_RECRUITER, WORKFORCE_MANAGER per
// product policy — the role label still differs so audit logs show who
// acted in which functional capacity.
const FULL_ADMIN: Capability[] = [
  ...ALL_VIEWS,
  ...ALL_MANAGE,
  'view:audit',
  'view:executive',
  'view:time-live',
  'view:ops',
  'run:ops-shifts',
  'assist:ops-shifts',
  'manage:ops-library',
  // The admin roles hold every transport capability, so they can staff
  // the Transportation Director and drivers (a role can only be granted
  // by someone who holds all of its capabilities).
  'ride:transport',
  'drive:transport',
  'view:transport',
  'manage:transport',
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  EXECUTIVE_CHAIRMAN: new Set<Capability>([
    ...ALL_VIEWS,
    'view:audit',
    'view:executive',
    'view:product-analytics',
    // The owner's copy of the audit packet. Note this is the ONE export
    // capability a read-only role holds — deliberate, and narrow.
    'export:audit-packet',
    'view:time-live',
    // Store-ops oversight + the chairman's ONE write: the SOP standard.
    'view:ops',
    'manage:ops-library',
    'view:transport',
  ]),
  // Gap 10 — HR Admin holds all three reimbursement caps so they can act
  // as the manager fallback when an associate has no direct manager and
  // perform the HR/Finance settle step.
  HR_ADMINISTRATOR: new Set<Capability>([
    ...FULL_ADMIN,
    // Granted here rather than in FULL_ADMIN: product telemetry starts with
    // the two roles accountable for the platform, and widens deliberately.
    'view:product-analytics',
    // HR runs the audit: they are the ones handing the packet to a DOL or
    // ICE auditor, so restricting it to the chairman would lock the tool
    // away from its actual user.
    'export:audit-packet',
    'void:payroll',
    'export:payroll-pii',
    'submit:reimbursement',
    'approve:reimbursement',
    'settle:reimbursement',
  ]),
  OPERATIONS_MANAGER: new Set<Capability>([
    ...FULL_ADMIN,
    'submit:reimbursement',
    'approve:reimbursement',
  ]),
  LIVE_ASN: new Set<Capability>(),
  ASSOCIATE: new Set<Capability>([
    'view:dashboard',
    'view:onboarding',
    'view:time',
    'view:scheduling',
    'view:payroll',
    'view:documents',
    'view:performance',
    // Required so associates can read their own IN_APP notifications via
    // /communications/me/inbox. Send/broadcast paths still gated on
    // manage:communications.
    'view:communications',
    // Gap 10 — submit own reimbursement requests.
    'submit:reimbursement',
    // Book a seat on an Alto van, to or from work.
    'ride:transport',
  ]),
  CLIENT_PORTAL: new Set<Capability>([
    'view:dashboard',
    'view:scheduling',
    'view:analytics',
    'view:performance',
  ]),
  // Time + pay only. Runs payroll cycles, sees scheduling/time as inputs
  // and analytics for financial reports. Deliberately *not* granted any
  // HR/onboarding/recruiting surface area.
  FINANCE_ACCOUNTANT: new Set<Capability>([
    'view:dashboard',
    'view:time',
    // Payroll is finance's end-to-end (owner decision, 2026-09-05):
    // approving timesheets and working the corrections window ARE the
    // input side of the pay cycle, so finance holds the full time &
    // attendance base — not just read access.
    'manage:time',
    'view:time-live',
    'view:scheduling',
    // Full scheduling authority (owner decision 2026-09-06, reversing the
    // earlier read-only stance): finance runs the whole hours→pay cycle,
    // including building and correcting the schedule that feeds it.
    'manage:scheduling',
    'view:payroll',
    'process:payroll',
    'view:comp',
    'view:analytics',
    // The client side of the money cycle: SOW bill rates, contracts, and
    // per-client statements live under Clients — the role that finalizes
    // statements and owns rate-card economics reads them (writes stay on
    // manage:clients, which finance does not hold).
    'view:clients',
    // Associate lookup: pay questions, garnishments, and Fieldglass worker
    // onboarding all start from the person record. Read-only — People
    // WRITES stay on manage:org.
    'view:org',
    // Gap 10 — Finance settles approved reimbursements into the next
    // REGULAR run. Cannot approve at the manager step.
    'settle:reimbursement',
    // The payroll census and the new-hire report carry full SSNs, bank
    // routing and account numbers, DOBs and home addresses for every
    // associate. Both sat on process:payroll, which SIX roles hold —
    // including MARKETING_MANAGER and INTERNAL_RECRUITER. The audience
    // org.ts names in its own comment is "Owner + Payroll admin + HR
    // admin", and finance IS the payroll admin here: it runs the whole
    // hours→pay cycle. So the capability widens by exactly one role
    // rather than the export staying open to four who have no use for it.
    'export:payroll-pii',
    // Inbox READ access. payrollFailureNotify writes payment-failure
    // alerts to this role's bell — without this capability the inbox API
    // 403'd and the bell silently rendered empty, so the most urgent
    // alert in the system was undeliverable. Sending/broadcast stays
    // gated behind manage:communications, which finance does not have.
    'view:communications',
  ]),
  INTERNAL_RECRUITER: new Set<Capability>(FULL_ADMIN),
  MANAGER: new Set<Capability>([
    ...FULL_ADMIN,
    // Gap 10 — Managers approve their direct reports' reimbursements.
    // Settlement stays with HR / Finance.
    'submit:reimbursement',
    'approve:reimbursement',
  ]),
  // The field-leadership role (owner charter 2026-09-06): the corporate
  // connection to the store floor — coverage, the supervisor corps,
  // standards, safety, and the people-supply chain end to end. Holds
  // NO money-cycle powers (payroll/comp/statements are Finance's) and
  // NO org-admin surface (users/branding/audit stay with HR Admin).
  WORKFORCE_MANAGER: new Set<Capability>([
    'view:dashboard',
    // Hire and land the supervisor corps + seasonal cohorts.
    'view:recruiting', 'manage:recruiting',
    'view:onboarding', 'manage:onboarding', 'invite:onboarding',
    // People + field org (assignments, managers, transfers).
    'view:org', 'manage:org',
    // Coverage across all stores and shifts.
    'view:scheduling', 'manage:scheduling',
    // Binder disciplines: sign-in/out, meal compliance, the points system.
    'view:time', 'manage:time', 'view:time-live',
    'view:my-team', 'manage:team-time', 'manage:team-time-off',
    // Coaching, the five standards, discipline applied fairly.
    'view:performance', 'manage:performance',
    // Safety + incident response on every floor; certifications.
    'view:compliance', 'manage:compliance',
    'view:documents',
    // Field broadcasts + dispatch communications.
    'view:communications', 'manage:communications',
    'view:analytics',
    // Store Ops: shift plans, checklists, handover; the Site Playbook
    // (SOP standards library) is THIS role's manual.
    'view:ops', 'run:ops-shifts', 'assist:ops-shifts', 'manage:ops-library',
    // Field leadership covers the vans too — and staffs the drivers.
    'ride:transport', 'drive:transport', 'view:transport', 'manage:transport',
  ]),
  MARKETING_MANAGER: new Set<Capability>(FULL_ADMIN),
  // Client-scoped floor supervisor: full manage of Scheduling + Time for
  // their one client (the scope* helpers enforce the client boundary), plus
  // onboarding invites and progress monitoring for that same client. No
  // payroll/HR/clients surface, and deliberately no manage:onboarding —
  // approving applications, verifying I-9s, and reading applicant PII stay
  // with HR (assertCanModifyApplication enforces the PII half).
  SHIFT_SUPERVISOR: new Set<Capability>([
    'view:dashboard',
    'view:time',
    'manage:time',
    'view:time-live',
    'view:scheduling',
    'manage:scheduling',
    'view:onboarding',
    'invite:onboarding',
    // Run their store's operational shifts (SOP checklist, tasks,
    // handover). Client-clamped; the library and board stay above them.
    'run:ops-shifts',
    'assist:ops-shifts',
    // They ride the vans too.
    'ride:transport',
    // The in-app inbox/bell. Without it, notifications routed to
    // supervisors (shift claims, swaps, no-shows at their site) land in a
    // mailbox they can't open — associates hold this for the same reason.
    'view:communications',
  ]),
  // Step-down from SHIFT_SUPERVISOR: watches the live floor for one
  // client, decides nothing. Deliberately NO manage:time — walk-in
  // approvals, manual entries, and timesheet approval all stay with the
  // shift supervisor and above. Reports to one shift supervisor; helps
  // on their shift's SOP, and runs it only while covering for them.
  FLOOR_SUPERVISOR: new Set<Capability>([
    'view:dashboard',
    'view:time',
    'view:time-live',
    'view:communications',
    'assist:ops-shifts',
    'ride:transport',
  ]),
  // Runs the Alto vans end to end — the transportation command center.
  // Org-wide (every client and store); no HR, payroll or scheduling.
  TRANSPORTATION_DIRECTOR: new Set<Capability>([
    'view:dashboard',
    'view:communications',
    'view:transport',
    'manage:transport',
    // Can take a run themselves in a pinch.
    'drive:transport',
    'ride:transport',
  ]),
  // Drives an Alto van: their own runs only.
  DRIVER: new Set<Capability>([
    'view:dashboard',
    'view:communications',
    'drive:transport',
  ]),
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

/**
 * Every Role that has the given capability. Used by the API's notification
 * fan-out to target "all admins who can manage X" without hardcoding role
 * lists that drift when ROLE_CAPABILITIES changes.
 */
export function rolesWithCapability(capability: Capability): Role[] {
  return (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((r) =>
    ROLE_CAPABILITIES[r].has(capability),
  );
}

/**
 * The roles whose tenancy is ONE client — the only roles a UI or query
 * may clamp by the account's clientId. Boundedness is a property of the
 * ROLE, never of the account: an org-wide role (HR admin, Workforce
 * Manager) provisioned with an incidental clientId must NOT self-clamp
 * — that bug emptied the WFM's live board and pinned every filter to
 * one store (reported 2026-09-06).
 */
const CLIENT_BOUNDED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'SHIFT_SUPERVISOR',
  'FLOOR_SUPERVISOR',
  'CLIENT_PORTAL',
]);

export function isClientBoundedRole(role: Role): boolean {
  return CLIENT_BOUNDED_ROLES.has(role);
}

/** The client pin for a bounded-role user, or null for org-wide roles
 *  regardless of what clientId the account happens to carry. */
export function boundedClientOf(
  user:
    | { role: Role; clientId?: string | null; clientName?: string | null }
    | null
    | undefined,
): { id: string; name: string } | null {
  if (!user || !CLIENT_BOUNDED_ROLES.has(user.role)) return null;
  if (!user.clientId) return null;
  return { id: user.clientId, name: user.clientName ?? 'Your client' };
}

/**
 * The full set of ASN-namespaced capabilities. Useful when an admin UI
 * mints an "ASN Supervisor" or "ASN Command Desk" key — preselect from
 * this list rather than free-typing strings.
 */
export const ASN_CAPABILITIES: readonly Capability[] = [
  'asn:read:schedule',
  'asn:read:roster',
  'asn:read:clocked-in',
  'asn:read:kpis',
] as const;

export const HUMAN_ROLES: Role[] = (Object.keys(ROLES) as Role[]).filter(
  (r) => r !== 'LIVE_ASN'
);

/* ===== Org-enforced MFA policy ========================================== */

export const MFA_REQUIREMENT_VALUES = ['OFF', 'ADMINS', 'ALL'] as const;
export type MfaRequirement = (typeof MFA_REQUIREMENT_VALUES)[number];

/**
 * "Admin-class" for the org MFA policy (`mfaRequirement = 'ADMINS'`),
 * derived from the capability matrix rather than a hardcoded role list so
 * new roles inherit the right treatment automatically.
 *
 * A role is admin-class when it can act on OTHER people's data or money:
 * any `manage:*` capability, running/voiding payroll, exporting payroll
 * PII, or the org-wide HR admin / audit surfaces. That currently captures
 * every FULL_ADMIN role, EXECUTIVE_CHAIRMAN (view:hr-admin + view:audit),
 * FINANCE_ACCOUNTANT (process:payroll), and SHIFT_SUPERVISOR
 * (manage:time / manage:scheduling) — and deliberately excludes
 * ASSOCIATE and CLIENT_PORTAL (self/read-only surfaces) and LIVE_ASN
 * (non-human integration role that can't log in).
 */
export function isMfaAdminRole(role: Role): boolean {
  const caps = ROLE_CAPABILITIES[role];
  for (const c of caps) {
    if (
      c.startsWith('manage:') ||
      c === 'process:payroll' ||
      c === 'void:payroll' ||
      c === 'export:payroll-pii' ||
      c === 'view:hr-admin' ||
      c === 'view:audit'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Does the org's MFA requirement apply to this role?
 * NOTE: this describes the TOTP-at-password-login requirement only —
 * passkey sign-in already proves possession + user verification, so
 * users who sign in with a passkey are exempt regardless of policy.
 */
export function mfaPolicyAppliesTo(
  requirement: MfaRequirement,
  role: Role,
): boolean {
  if (requirement === 'OFF') return false;
  if (!HUMAN_ROLES.includes(role)) return false;
  if (requirement === 'ALL') return true;
  return isMfaAdminRole(role);
}
