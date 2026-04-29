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
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  EXECUTIVE_CHAIRMAN: 'Read-only access across all modules and clients',
  HR_ADMINISTRATOR: 'Full access to every module and client',
  OPERATIONS_MANAGER: 'Full operational access; cannot process payroll',
  LIVE_ASN: 'System integration portal — not for human login',
  ASSOCIATE: 'Personal access to own profile, schedule, and pay',
  CLIENT_PORTAL: 'Read-only access scoped to one client account',
  FINANCE_ACCOUNTANT: 'Runs payroll and reads financial modules; cannot change HR/comp data',
  INTERNAL_RECRUITER: 'Full access to recruiting pipeline',
  MANAGER:
    'Approves time, time-off, and schedule changes for direct reports; sees a "my team" view',
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

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  EXECUTIVE_CHAIRMAN: new Set<Capability>([...ALL_VIEWS, 'view:audit']),
  HR_ADMINISTRATOR: new Set<Capability>([...ALL_VIEWS, ...ALL_MANAGE, 'view:audit']),
  OPERATIONS_MANAGER: new Set<Capability>([
    ...ALL_VIEWS,
    'manage:onboarding',
    'manage:time',
    'manage:team-time',
    'manage:team-time-off',
    'manage:scheduling',
    'manage:documents',
    'manage:communications',
    'manage:clients',
    'manage:compliance',
    'manage:performance',
    'manage:recruiting',
    'manage:org',
    'manage:comp',
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
  ]),
  CLIENT_PORTAL: new Set<Capability>([
    'view:dashboard',
    'view:scheduling',
    'view:analytics',
    'view:performance',
  ]),
  FINANCE_ACCOUNTANT: new Set<Capability>([
    'view:dashboard',
    'view:payroll',
    'process:payroll',
    'view:analytics',
  ]),
  INTERNAL_RECRUITER: new Set<Capability>([
    'view:dashboard',
    'view:onboarding',
    'manage:onboarding',
    'view:recruiting',
    'manage:recruiting',
    'view:communications',
    'manage:communications',
    'view:hr-admin',
  ]),
  // Phase 76 — line manager: a small subset of HR power, scoped at
  // the call site to the manager's direct reports.
  MANAGER: new Set<Capability>([
    'view:dashboard',
    'view:my-team',
    'view:time',
    'manage:team-time',
    'view:scheduling',
    'view:performance',
    'manage:team-time-off',
    'view:onboarding',
    'view:communications',
    'view:org',
    'view:comp',
    'view:hr-admin',
  ]),
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
