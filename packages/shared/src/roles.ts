export const ROLES = {
  EXECUTIVE_CHAIRMAN: 'EXECUTIVE_CHAIRMAN',
  HR_ADMINISTRATOR: 'HR_ADMINISTRATOR',
  OPERATIONS_MANAGER: 'OPERATIONS_MANAGER',
  LIVE_ASN: 'LIVE_ASN',
  ASSOCIATE: 'ASSOCIATE',
  CLIENT_PORTAL: 'CLIENT_PORTAL',
  FINANCE_ACCOUNTANT: 'FINANCE_ACCOUNTANT',
  INTERNAL_RECRUITER: 'INTERNAL_RECRUITER',
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
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  EXECUTIVE_CHAIRMAN: 'Read-only access across all modules and clients',
  HR_ADMINISTRATOR: 'Full access to every module and client',
  OPERATIONS_MANAGER: 'Full operational access; cannot process payroll',
  LIVE_ASN: 'System integration portal — not for human login',
  ASSOCIATE: 'Personal access to own profile, schedule, and pay',
  CLIENT_PORTAL: 'Read-only access scoped to one client account',
  FINANCE_ACCOUNTANT: 'Read-only access to financial modules',
  INTERNAL_RECRUITER: 'Full access to recruiting pipeline',
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
  | 'view:audit';

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
];

const ALL_MANAGE: Capability[] = [
  'manage:onboarding',
  'manage:time',
  'manage:scheduling',
  'process:payroll',
  'manage:documents',
  'manage:communications',
  'manage:clients',
  'manage:compliance',
  'manage:performance',
  'manage:recruiting',
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  EXECUTIVE_CHAIRMAN: new Set<Capability>([...ALL_VIEWS, 'view:audit']),
  HR_ADMINISTRATOR: new Set<Capability>([...ALL_VIEWS, ...ALL_MANAGE, 'view:audit']),
  OPERATIONS_MANAGER: new Set<Capability>([
    ...ALL_VIEWS,
    'manage:onboarding',
    'manage:time',
    'manage:scheduling',
    'manage:documents',
    'manage:communications',
    'manage:clients',
    'manage:compliance',
    'manage:performance',
    'manage:recruiting',
  ]),
  LIVE_ASN: new Set<Capability>(),
  ASSOCIATE: new Set<Capability>([
    'view:dashboard',
    'view:onboarding',
    'view:time',
    'view:scheduling',
    'view:payroll',
    'view:documents',
    'view:communications',
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
  ]),
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export const HUMAN_ROLES: Role[] = (Object.keys(ROLES) as Role[]).filter(
  (r) => r !== 'LIVE_ASN'
);
