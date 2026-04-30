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
};

export type Capability =
  | 'view:dashboard'
  | 'view:onboarding' | 'manage:onboarding'
  | 'view:time' | 'manage:time'
  | 'view:scheduling' | 'manage:scheduling'
  | 'view:payroll' | 'process:payroll'
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
  | 'asn:read:kpis';

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
const FULL_ADMIN: Capability[] = [...ALL_VIEWS, ...ALL_MANAGE, 'view:audit'];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  EXECUTIVE_CHAIRMAN: new Set<Capability>([...ALL_VIEWS, 'view:audit']),
  HR_ADMINISTRATOR: new Set<Capability>(FULL_ADMIN),
  OPERATIONS_MANAGER: new Set<Capability>(FULL_ADMIN),
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
  ]),
  INTERNAL_RECRUITER: new Set<Capability>(FULL_ADMIN),
  MANAGER: new Set<Capability>(FULL_ADMIN),
  WORKFORCE_MANAGER: new Set<Capability>(FULL_ADMIN),
  MARKETING_MANAGER: new Set<Capability>(FULL_ADMIN),
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
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
