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
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  EXECUTIVE_CHAIRMAN: 'Read-only access across all modules and clients',
  HR_ADMINISTRATOR: 'Full access to every module and client',
  OPERATIONS_MANAGER: 'Full org-wide access (mirrors HR Administrator)',
  LIVE_ASN: 'System integration portal — not for human login',
  ASSOCIATE: 'Personal access to own profile, schedule, and pay',
  CLIENT_PORTAL: 'Read-only access scoped to one client account',
  FINANCE_ACCOUNTANT: 'Time, scheduling, and payroll only — runs pay cycles, no HR data',
  INTERNAL_RECRUITER: 'Full org-wide access (mirrors HR Administrator)',
  MANAGER: 'Full org-wide access (mirrors HR Administrator)',
  WORKFORCE_MANAGER: 'Full org-wide access (mirrors HR Administrator)',
  MARKETING_MANAGER: 'Full org-wide access (mirrors HR Administrator)',
  SHIFT_SUPERVISOR:
    'Scheduling, time & attendance, and onboarding invites for one client only — assign the client in Users & access',
  FLOOR_SUPERVISOR:
    'Watch-only: the live clocked-in board for one client. No time approvals, edits, or walk-in decisions — assign the client in Users & access',
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
  | 'run:ops-shifts'
  | 'view:ops'
  | 'manage:ops-library';

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
  'manage:ops-library',
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  EXECUTIVE_CHAIRMAN: new Set<Capability>([
    ...ALL_VIEWS,
    'view:audit',
    'view:executive',
    'view:time-live',
    // Store-ops oversight + the chairman's ONE write: the SOP standard.
    'view:ops',
    'manage:ops-library',
  ]),
  // Gap 10 — HR Admin holds all three reimbursement caps so they can act
  // as the manager fallback when an associate has no direct manager and
  // perform the HR/Finance settle step.
  HR_ADMINISTRATOR: new Set<Capability>([
    ...FULL_ADMIN,
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
  ]),
  CLIENT_PORTAL: new Set<Capability>([
    'view:dashboard',
    'view:scheduling',
    'view:analytics',
    'view:performance',
  ]),
  // Time + pay only. Runs payroll cycles, sees scheduling/time as inputs
  // and analytics for financial reports. Deliberately *not* granted any
  // HR/onboarding/recruiting/comms surface area.
  FINANCE_ACCOUNTANT: new Set<Capability>([
    'view:dashboard',
    'view:time',
    'view:scheduling',
    'view:payroll',
    'process:payroll',
    'view:comp',
    'view:analytics',
    // Gap 10 — Finance settles approved reimbursements into the next
    // REGULAR run. Cannot approve at the manager step.
    'settle:reimbursement',
  ]),
  INTERNAL_RECRUITER: new Set<Capability>(FULL_ADMIN),
  MANAGER: new Set<Capability>([
    ...FULL_ADMIN,
    // Gap 10 — Managers approve their direct reports' reimbursements.
    // Settlement stays with HR / Finance.
    'submit:reimbursement',
    'approve:reimbursement',
  ]),
  WORKFORCE_MANAGER: new Set<Capability>(FULL_ADMIN),
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
    // The in-app inbox/bell. Without it, notifications routed to
    // supervisors (shift claims, swaps, no-shows at their site) land in a
    // mailbox they can't open — associates hold this for the same reason.
    'view:communications',
  ]),
  // Step-down from SHIFT_SUPERVISOR: watches the live floor for one
  // client, decides nothing. Deliberately NO manage:time — walk-in
  // approvals, manual entries, and timesheet approval all stay with the
  // shift supervisor and above.
  FLOOR_SUPERVISOR: new Set<Capability>([
    'view:dashboard',
    'view:time',
    'view:time-live',
    'view:communications',
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
