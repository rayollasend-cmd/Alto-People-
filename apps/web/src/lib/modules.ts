import { useLocation } from 'react-router-dom';

import type { Capability } from './roles';
import type { Role, TenantModule, TenantModules, TermKey } from '@alto-people/shared';
import { PLATFORM_OPERATOR_TENANT_ID, ROLE_MODULE } from '@alto-people/shared';
import { groupPayMenu, type PayMenuGroupView } from './payMenu';

export type ModuleKey =
  | 'inbox'
  | 'payroll-go-live'
  | 'books'
  | 'books-reports'
  | 'books-journal'
  | 'books-accounts'
  | 'books-receivables'
  | 'books-bills'
  | 'books-vendors'
  | 'books-bank'
  | 'books-close'
  | 'books-budgets'
  | 'books-assets'
  | 'books-quickbooks'
  | 'settings'
  | 'tenant-profile'
  | 'sign-in'
  | 'access-certifications'
  | 'employers'
  | 'org-units'
  | 'sites'
  | 'product-analytics'
  | 'design-system'
  | 'trust-center'
  | 'reliability'
  | 'tasks'
  | 'compliance-evidence'
  | 'emergency'
  | 'programs'
  | 'season-planner'
  | 'supervisor-corps'
  | 'wallet'
  | 'forecast'
  | 'workers'
  | 'agents'
  | 'portal'
  | 'region'
  | 'messages'
  | 'portal-today'
  | 'portal-schedule'
  | 'portal-history'
  | 'portal-ops'
  | 'portal-requests'
  | 'portal-candidates'
  | 'floor-today'
  | 'call-outs'
  | 'relay'
  | 'statements'
  | 'timesheets'
  | 'fieldglass'
  | 'fieldglass-setup'
  | 'onboarding'
  | 'time-attendance'
  | 'kiosk'
  | 'time-off'
  | 'rides'
  | 'transport'
  | 'scheduling'
  | 'ops'
  | 'robots'
  | 'control-room'
  | 'labor-costs'
  | 'approvals'
  | 'payroll'
  | 'payroll-tax'
  | 'payroll-taxes'
  | 'certified-payroll'
  | 'garnishments'
  | 'retirement'
  | 'carrier-feeds'
  | 'contractors'
  | 'payroll-banking'
  | 'pay-schedules'
  | 'payroll-compliance'
  | 'cash-forecast'
  | 'pay-bill'
  | 'market-rates'
  | 'earned-wage'
  | 'daily-pay'
  | 'manual-checks'
  | 'state-tax'
  | 'tax-jurisdictions'
  | 'wotc'
  | 'aca'
  | 'documents'
  | 'doc-templates'
  | 'communications'
  | 'clients'
  | 'analytics'
  | 'compliance'
  | 'performance'
  | 'recruiting'
  | 'audit'
  | 'approval-record'
  | 'benefits'
  | 'people'
  | 'org'
  | 'org-chart'
  | 'celebrations'
  | 'assets'
  | 'pulse'
  | 'headcount'
  | 'headcount-plan'
  | 'retention'
  | 'policy-campaigns'
  | 'document-retention'
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
  | 'leave'
  | 'unemployment-claims'
  | 'workers-comp'
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
  | 'reports'
  // The office pack (2026-10-17): marketing's hub and the client NPS results.
  | 'marketing'
  | 'client-nps'
  // The Clients rebuild (2026-10-22): the new-business pipeline.
  | 'client-pipeline';

/**
 * Phase 67 — sidebar groupings, F500-style. Modules with the same `group`
 * are rendered under a shared header in the sidebar. Order within a group
 * is the array order in `MODULES`. The "core" group is rendered without a
 * header (it's the always-on stuff: dashboard, onboarding, recruiting).
 */
/**
 * The Products layer of the product taxonomy (docs/product-taxonomy.md):
 * Workforce Management · Operations · Compliance · Payroll and Finance ·
 * Client Services · Platform. "core" is the always-on set rendered without
 * a header.
 */
export type ModuleGroup =
  | 'core'
  | 'workforce-management'
  | 'operations'
  | 'compliance'
  | 'payroll-finance'
  | 'client-services'
  | 'platform';

export const GROUP_LABEL: Record<Exclude<ModuleGroup, 'core'>, string> = {
  'workforce-management': 'Workforce management',
  operations: 'Operations',
  compliance: 'Compliance',
  'payroll-finance': 'Payroll and finance',
  'client-services': 'Client services',
  platform: 'Platform',
};

export interface ModuleNav {
  key: ModuleKey;
  path: string;
  label: string;
  description: string;
  /** Brief 2-1b: the same description for a tenant that has no clients (client portal off). */
  descriptionNoClients?: string;
  requires: Capability;
  /** When set, ANY of these capabilities also reveals the module —
   *  used where two audiences share a page (e.g. Labor costs is both a
   *  scheduling-ops and an executive surface). */
  requiresAny?: Capability[];
  /** Brief 2-5: shown only to the tenant that operates the platform (its evidence is the platform's). */
  platformOnly?: boolean;
  /** Phase 67 — sidebar grouping. */
  group: ModuleGroup;
}

/**
 * The Executive/Chairman's curated sidebar. The role holds every view
 * capability, which used to render an HR clerk's 56-row sidebar with the
 * buttons greyed out. Executives get the strategic surfaces only —
 * everything else stays reachable by URL (capability-gated as always),
 * just not in their nav.
 */
export const EXEC_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'me',
  'messages',
  'inbox',
  'relay',
  'people',
  'org-chart',
  'headcount',
  'headcount-plan',
  'succession',
  'separations',
  'pulse',
  'clients',
  'labor-costs',
  'ops',
  'compensation',
  'compliance',
  'audit',
  'analytics',
  'reports',
  // The board numbers that were missing from the exec nav (2026-10-17).
  'client-nps',
  'client-pipeline',
  'trust-center',
  'season-planner',
  // Pay against the local market, for rate negotiations.
  'market-rates',
  // The company's books, read (2027-01).
  'books',
  'books-reports',
  'books-budgets',
]);

/** The floor supervisor's sidebar: their floor, the faces on it, the live
 *  board, their shift's SOP, messages and their profile — the shift
 *  supervisor's grammar without the decisions. */
const FLOOR_SUPERVISOR_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'me',
  'inbox', // what's happening on their floor, as counts — the watch, not decisions
  'messages',
  'floor-today',
  'time-attendance',
  'ops',
  'rides', // they ride the vans too
]);

/**
 * The associate's curated nav: the daily loop plus genuinely
 * self-service surfaces, in worker language. The uncurated capability
 * slice produced 25 entries of HR taxonomy (career ladders, pulse,
 * equity, holidays config…) that read like a back-office console, not
 * an employee app. Everything trimmed here stays reachable by URL and
 * by deep links from notifications — it's out of the NAV, not the app.
 */
export const ASSOCIATE_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'me',
  'messages', // their supervisors and the desks reach them here, and they reply (field roles, 2026-10)
  'wallet', // what they've earned, carried with them
  'benefits', // their own elections — open enrollment, life events
  'scheduling',
  'marketplace', // open shifts to pick up
  'time-attendance', // my timesheet + kiosk explainer
  'rides', // the Alto vans — book a seat to or from work
  'time-off',
  'payroll',
  'documents',
  'communications', // inbox
  'reimbursements',
  'learning',
  'internal-jobs',
  'agreements', // pending e-signatures land here from the to-do card
  'hr-cases', // "talk to HR" — the escape valve stays one tap away
  'leave', // request leave, send the certification, read the notices
  'help-center',
]);

/** The client contact's curated nav: their store view and the read-only
 *  schedule — a partner surface, not an HR console. */
const CLIENT_PORTAL_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'portal',
  'portal-today',
  'portal-ops',
  'portal-schedule',
  'portal-history',
  'messages',
  'portal-requests',
  'portal-candidates',
]);

/** Finance's curated nav: the money cycle end-to-end — pay, tax, billing,
 *  settlement, and the time/scheduling inputs that feed them. The
 *  uncurated slice buried these under Pulse/Equity/Volunteer/Career noise. */
const FINANCE_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'inbox',
  'me',
  'messages',
  'relay',
  'payroll',
  'payroll-tax',
  'payroll-taxes',
  'certified-payroll',
  'garnishments',
  'retirement',
  'carrier-feeds',
  'contractors',
  'payroll-banking',
  'pay-schedules',
  'payroll-compliance',
  'payroll-go-live',
  'cash-forecast',
  'pay-bill',
  'books',
  'books-reports',
  'books-journal',
  'books-accounts',
  'books-receivables',
  'books-bills',
  'books-vendors',
  'books-bank',
  'books-close',
  'books-budgets',
  'books-assets',
  'books-quickbooks',
  'market-rates',
  'earned-wage',
  'daily-pay',
  'manual-checks',
  'state-tax',
  'tax-jurisdictions',
  'wotc',
  'aca',
  'payrules',
  'benefits',
  'compensation',
  'reimbursements',
  'statements',
  'clients',
  'labor-costs',
  'billing',
  'people',
  'timesheets',
  'fieldglass',
  'fieldglass-setup',
  'time-off',
  'scheduling',
  // Comes with full scheduling authority: swap requests, pickup claims,
  // and unconfirmed-shift decisions land here.
  'approvals',
  // The payroll case desk: PAYROLL-category HR cases (missing paychecks,
  // deduction questions) are Finance's tickets — the API scopes their
  // queue to that category.
  'hr-cases',
  'holidays',
  'analytics',
  'reports',
]);

/** The field-leadership nav: the people-supply chain plus the floor —
 *  coverage, standards, safety, the supervisor pipeline. No money pages. */
const WORKFORCE_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'inbox',
  'call-outs',
  'retention',
  'me',
  'messages',
  'relay',
  'people',
  'org-chart',
  'recruiting',
  'onboarding',
  'scheduling',
  'approvals',
  'marketplace',
  // The FULL time & scheduling families, same as the HR administrator
  // sees them (owner decision 2026-09-06): the kiosk devices and PINs
  // are Time & Attendance hardware, and the holiday calendar drives
  // shift planning. The payroll-PII sheet is NOT part of either family
  // and stays HR-admin-only.
  'time-attendance',
  'fieldglass',
  'kiosk',
  'time-off',
  'holidays',
  // Field roles (2026-10): the role held these capabilities all along; the
  // nav hid them. Coverage planning, the storm switch, the engine room,
  // the supervisor corps — and labor dollars, the charter's one change.
  'forecast',
  'season-planner',
  'emergency',
  'control-room',
  'tasks',
  'labor-costs',
  'supervisor-corps',
  'ops',
  'transport',
  'performance',
  'compliance',
  'skills',
  'expirations',
  'learning-paths',
  'headcount',
  'headcount-plan',
  'communications',
  'dircomms',
  'analytics',
  'reports',
]);

/**
 * The internal recruiter's curated nav: the hire-to-file pipeline plus the
 * people + compliance surfaces the role owns — Recruiting, Onboarding, the
 * People directory, Documents, Compliance, and the HR case desk. Per product
 * policy the role carries the FULL admin capability surface (identical to
 * Marketing / Workforce Manager — see ROLE_CAPABILITIES), so without this
 * curation `visibleModules` fell through to `base` and dumped the entire
 * ~50-row console into their sidebar. Everything trimmed here stays reachable
 * by URL and by deep links from notifications — it's out of the NAV, not the
 * app (same contract as the Exec / Finance / Associate curations above).
 * `me` + `messages` are the personal baseline every curated role keeps.
 */
const RECRUITER_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'me',
  'messages',
  'inbox',
  // Recruiting is one of the relay's four desks — batons are handed to
  // the recruiter there, so they need the way in like HR, Workforce and
  // Finance have it.
  'relay',
  'recruiting',
  'onboarding',
  'people',
  'documents',
  'compliance',
  // Headcount (the requisitions they hire against), the report builder and
  // the internal job board were reachable only by URL (2026-10-17).
  'headcount',
  'headcount-plan',
  'reports',
  'internal-jobs',
  // The kiosk code that puts a hire on the floor is the last step of the
  // recruiter's onboarding desk (owner 2026-10-22); it was URL-only.
  'kiosk',
]);

/**
 * The shift supervisor's curated nav: running one store's floor — the
 * schedule, the decisions inbox, the live board and timesheets, the SOP
 * shift, open-shift claims, time-off requests, new-hire invites, and the
 * store's kiosk PINs — plus the personal baseline. The uncurated slice was
 * 24 rows: employee perks the associate nav already dropped (Pulse,
 * Career, Equity, Tuition, Volunteer, Internal jobs, Help center), a
 * Reimbursements page that 403s for this role (no view:payroll /
 * submit:reimbursement), company config (the holiday calendar) and money
 * (Labor costs — pay AND bill rates), and a Communications inbox the bell
 * and Messages already cover. Everything trimmed stays reachable by URL —
 * out of the NAV, not the app.
 */
const SHIFT_SUPERVISOR_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'me',
  'messages',
  'inbox',
  'floor-today', // the face wall — the store manager's Today page, their client
  'scheduling',
  'approvals',
  'time-attendance',
  'fieldglass', // their store's weekly sheet — statuses, never the money
  'ops',
  'marketplace', // pending claims + the qualifications catalog
  'time-off',
  'onboarding', // invites + checklist progress for their client
  'kiosk',
  'hr-cases',
  'agreements',
  'learning',
  'rides', // they ride the vans too
  'celebrations', // their crew's birthdays and anniversaries
  'call-outs', // who can't make it today, and how cover is going
  'retention', // who on their crew might leave, and what to do
]);

/** The Transportation Director's nav: the command center, and the
 *  personal baseline. Their day is dispatch — nothing else competes. */
const TRANSPORT_DIRECTOR_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'me',
  'messages',
  'transport',
]);

/** The driver's nav: their runs live on Home; messages and their profile. */
const DRIVER_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  'me',
  'messages',
]);

/** Capability-filtered module list, with per-role curation applied.
 *  `scope.regionId` marks a CLIENT_PORTAL command-center account, whose nav
 *  is the region and messages — never the single-store pages. */
/**
 * Brief 2-1b: which tenant module each navigation entry belongs to. An
 * entry with no gate is always on (the core of the product). The table
 * follows docs/tenant-profiles-investigation.md §5.2.
 */
export const MODULE_GATE: Partial<Record<ModuleKey, TenantModule>> = {
  scheduling: 'scheduling',
  'call-outs': 'scheduling',
  marketplace: 'scheduling',
  approvals: 'scheduling',
  holidays: 'scheduling',
  'time-attendance': 'time',
  timesheets: 'time',
  kiosk: 'time',
  'time-off': 'time',
  'hr-cases': 'hrCases',
  discipline: 'hrCases',
  hotline: 'hrCases',
  compliance: 'compliance',
  documents: 'compliance',
  'doc-templates': 'compliance',
  expirations: 'compliance',
  vaccinations: 'compliance',
  agreements: 'compliance',
  audit: 'compliance',
  'payroll-compliance': 'compliance',
  'earned-wage': 'earnedWage',
  // Fieldglass is a client's vendor system: a tenant with no clients never sees it.
  fieldglass: 'clientPortal',
  'fieldglass-setup': 'clientPortal',
  integrations: 'payrollSync',
  rides: 'transportation',
  transport: 'transportation',
  robots: 'robotics',
  programs: 'programs',
  'season-planner': 'programs',
  forecast: 'scheduling',
  statements: 'billRates',
  'pay-bill': 'clientPortal',
  portal: 'clientPortal',
  'client-nps': 'clientPortal',
  'client-pipeline': 'clientPortal',
  'market-rates': 'clientPortal',
  'portal-today': 'clientPortal',
  'portal-ops': 'clientPortal',
  'portal-schedule': 'clientPortal',
  'portal-history': 'clientPortal',
  'portal-requests': 'clientPortal',
  'portal-candidates': 'clientPortal',
  // The talent and perks long tail — corporate-HR surfaces a frontline or
  // seasonal operator may switch off (Organization profile).
  skills: 'talent',
  career: 'talent',
  mentorship: 'talent',
  succession: 'talent',
  probation: 'talent',
  ramp: 'talent',
  'learning-paths': 'talent',
  'internal-jobs': 'talent',
  pulse: 'talent',
  tuition: 'perks',
  equity: 'perks',
  volunteer: 'perks',
  region: 'clientPortal',
  clients: 'clientPortal',
  dircomms: 'clientPortal',
  // The messenger is the portal's store channels; the agent registry is the agent builder's (the API 404s both the same way).
  messages: 'clientPortal',
  agents: 'agentBuilder',
};

/** The roles that exist only with a module on (shared: the API refuses them too). */
export { ROLE_MODULE };

export function roleOfferedFor(role: Role, modules: TenantModules | undefined): boolean {
  const gate = ROLE_MODULE[role];
  return !gate || !modules || modules[gate];
}

/** The navigation labels the terminology table renames. */
export const NAV_TERM: Partial<Record<ModuleKey, TermKey>> = {
  people: 'nav.people',
  scheduling: 'nav.scheduling',
  'time-attendance': 'nav.time',
  // Finance's alias opens the same page, under the same name.
  timesheets: 'nav.time',
  kiosk: 'nav.kiosk',
  'hr-cases': 'nav.hrCases',
  compliance: 'nav.compliance',
  documents: 'nav.documents',
  payroll: 'nav.payroll',
  transport: 'nav.transport',
  clients: 'nav.clients',
  programs: 'nav.programs',
  headcount: 'nav.headcount',
};

/** Labels built from a noun rather than read from one key. */
const NAV_LABEL: Partial<Record<ModuleKey, (term: (key: TermKey) => string) => string>> = {
  ops: (term) => `${term('site')} operations`,
  'portal-ops': (term) => `${term('site')} operations`,
  sites: (term) => term('sites'),
  'supervisor-corps': (term) => `${term('site')} leads`,
};

/** The staffing nouns in a description, replaced by the tenant's words with the original casing. */
export function termizeText(text: string, term: (key: TermKey) => string): string {
  const swap: Array<[RegExp, TermKey]> = [
    [/\bassociates\b/gi, 'workers'],
    [/\bassociate\b/gi, 'worker'],
    [/\bstores\b/gi, 'sites'],
    [/\bstore\b/gi, 'site'],
    [/\bsupervisors\b/gi, 'managers'],
    [/\bsupervisor\b/gi, 'manager'],
    [/\bclients\b/gi, 'label.clients'],
    [/\bclient\b/gi, 'label.client'],
  ];
  let out = text;
  for (const [re, key] of swap) {
    out = out.replace(re, (m) => {
      const word = term(key);
      return m.charAt(0) === m.charAt(0).toUpperCase() ? word : word.charAt(0).toLowerCase() + word.slice(1);
    });
  }
  return out;
}

/** The same entries with the tenant's words on them: labels by key, descriptions by noun. */
export function applyTerms(modules: ModuleNav[], term: (key: TermKey) => string, tenantModules?: TenantModules | null): ModuleNav[] {
  const clients = hasClients(tenantModules);
  return modules.map((m) => {
    const key = NAV_TERM[m.key];
    const build = NAV_LABEL[m.key];
    const label = key ? term(key) : build ? build(term) : m.label;
    const description = termizeText(!clients && m.descriptionNoClients ? m.descriptionNoClients : m.description, term);
    return label === m.label && description === m.description ? m : { ...m, label, description };
  });
}

/** A tenant has clients when it runs the client portal; with no module set known, assume it does (Alto HR's words). */
export function hasClients(tenantModules?: TenantModules | null): boolean {
  return !tenantModules || tenantModules.clientPortal;
}

/** The sidebar group's heading in the tenant's words: with no clients, the group holds communications and insights. */
export function groupLabel(group: Exclude<ModuleGroup, 'core'>, term: (key: TermKey) => string, tenantModules?: TenantModules | null): string {
  if (group === 'client-services' && !hasClients(tenantModules)) return 'Communications and Insights';
  return termizeText(GROUP_LABEL[group], term);
}

export function visibleModules(
  role: string | undefined,
  can: (c: Capability) => boolean,
  scope: { regionId?: string | null; modules?: TenantModules; tenantId?: string | null } = {},
): ModuleNav[] {
  const base = MODULES.filter(
    (m) => can(m.requires) || (m.requiresAny?.some(can) ?? false),
  ).filter(
    // Brief 2-5: the platform's own pages are the operator tenant's alone.
    (m) => !m.platformOnly || scope.tenantId === PLATFORM_OPERATOR_TENANT_ID,
  ).filter(
    // Brief 2-1b: a module the tenant has off is not on the nav for anyone.
    (m) => {
      const gate = MODULE_GATE[m.key];
      return !gate || !scope.modules || scope.modules[gate];
    },
  ).filter(
    // "My store" only makes sense for a client account — internal roles
    // preview portals from the Clients page instead.
    (m) =>
      (!m.key.startsWith('portal') || role === 'CLIENT_PORTAL') &&
      (m.key !== 'region' || role === 'CLIENT_PORTAL') &&
      // The supervisor's Today is the portal's Day page opened on their
      // own client (/client-portal/day opts the role in). Nobody else has
      // a client to open it on without a preview id.
      (m.key !== 'floor-today' || role === 'SHIFT_SUPERVISOR' || role === 'FLOOR_SUPERVISOR') &&
      (m.key !== 'messages' || role !== 'LIVE_ASN'),
  ).filter(
    // "Timesheets" is Finance's name for the T&A surface — everyone else
    // already has Time & attendance; two entries would double-list it.
    (m) => m.key !== 'timesheets' || role === 'FINANCE_ACCOUNTANT',
  );
  if (role === 'CLIENT_PORTAL') {
    if (scope.regionId) return base.filter((m) => m.key === 'region' || m.key === 'messages');
    return base.filter((m) => CLIENT_PORTAL_MODULE_KEYS.has(m.key));
  }
  if (role === 'FINANCE_ACCOUNTANT') {
    return base.filter((m) => FINANCE_MODULE_KEYS.has(m.key));
  }
  if (role === 'WORKFORCE_MANAGER') {
    return base.filter((m) => WORKFORCE_MODULE_KEYS.has(m.key));
  }
  if (role === 'INTERNAL_RECRUITER') {
    return base.filter((m) => RECRUITER_MODULE_KEYS.has(m.key));
  }
  if (role === 'EXECUTIVE_CHAIRMAN') return base.filter((m) => EXEC_MODULE_KEYS.has(m.key));
  if (role === 'SHIFT_SUPERVISOR') {
    return base.filter((m) => SHIFT_SUPERVISOR_MODULE_KEYS.has(m.key));
  }
  if (role === 'FLOOR_SUPERVISOR') {
    return base.filter((m) => FLOOR_SUPERVISOR_MODULE_KEYS.has(m.key));
  }
  if (role === 'ASSOCIATE') {
    return base.filter((m) => ASSOCIATE_MODULE_KEYS.has(m.key));
  }
  if (role === 'TRANSPORTATION_DIRECTOR') {
    return base.filter((m) => TRANSPORT_DIRECTOR_MODULE_KEYS.has(m.key));
  }
  if (role === 'DRIVER') return base.filter((m) => DRIVER_MODULE_KEYS.has(m.key));
  return base;
}




export const MODULES: ModuleNav[] = [
  {
    key: 'inbox',
    path: '/inbox',
    label: 'Inbox',
    description:
      'Every decision waiting on you, across the product — approvals, reviews, cases, expiring credentials — counted and linked.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'settings',
    path: '/admin',
    label: 'Settings & trust',
    description:
      'The organization, its sites and accounts, sign-in, integrations, billing, and the trust evidence — one place.',
    requires: 'view:hr-admin',
    requiresAny: ['manage:org', 'view:integrations', 'view:product-analytics'],
    group: 'platform',
  },
  {
    key: 'portal',
    path: '/portal',
    label: 'My store',
    description:
      'Live floor coverage, today’s roster, this week’s fill, statements, and the coverage record for your store.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'portal-today',
    path: '/portal/today',
    label: 'Today',
    description:
      'Who is on your floor right now, wave by wave — clocked in, not in yet, unfilled — with finished shifts folded to their proof line.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'portal-ops',
    path: '/portal/ops',
    label: 'Store operations',
    description:
      'Every department’s SOP, shift by shift — what’s late, temperatures out of range, freight worked, and what each shift handed the next.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'portal-schedule',
    path: '/portal/schedule',
    label: 'Schedule',
    description:
      'Your store’s published week, day by day — print it, or download the weekly service report.',
    requires: 'view:scheduling',
    group: 'core',
  },
  {
    key: 'portal-history',
    path: '/portal/history',
    label: 'History',
    description:
      'How Alto delivered over any period — last week, last month, or a custom range: showed-up grade, fill and hours per day, incidents, checklist evidence, safety, statements and service reports.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'portal-requests',
    path: '/portal/requests',
    label: 'Requests',
    description:
      'Ask for coverage, flag an issue, or question a statement — and watch each request move to a named owner with a reply-by date.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'portal-candidates',
    path: '/portal/candidates',
    label: 'Candidates',
    description:
      'People Alto is putting forward for your team — who, for which store, why, and how Alto’s interviews went. Approve, or pass with a reason.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'region',
    path: '/region',
    label: 'Command center',
    description:
      'Every store in your region at a glance — on the floor vs contracted, today, tomorrow, the grade, open requests — with each store one tap away.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'floor-today',
    path: '/today',
    label: 'Today',
    description:
      'Who is on your floor right now, shift by shift, as faces — clocked in, not in yet, unfilled — with any past day one tap back.',
    requires: 'manage:scheduling',
    // The floor supervisor watches the same wall (no scheduling powers).
    requiresAny: ['manage:scheduling', 'assist:ops-shifts'],
    group: 'core',
  },
  {
    key: 'messages',
    path: '/messages',
    label: 'Messages',
    description:
      'Text the people who run the floor — store managers, supervisors, the desks — with every thread kept as a record.',
    requires: 'view:dashboard',
    group: 'core',
  },
  {
    key: 'relay',
    path: '/relay',
    label: 'Relay',
    description:
      'The one shared operating picture: first-paycheck lanes through HR, Workforce, and Finance; every cross-department baton with its holder, age, and due date; the Monday pack that writes itself.',
    requires: 'view:org',
    group: 'core',
  },
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
    key: 'wallet',
    path: '/me/wallet',
    label: 'My credentials',
    description:
      'Every qualification, training and verified credential you hold, with its expiry — and a link to show them to another employer for a while.',
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
    group: 'workforce-management',
  },
  {
    key: 'recruiting',
    path: '/recruiting',
    label: 'Recruiting',
    description:
      'Candidate pipeline, interviews, offers, and hire-to-onboarding handoff.',
    requires: 'view:recruiting',
    group: 'workforce-management',
  },
  {
    key: 'people',
    path: '/people',
    label: 'People',
    description:
      'Directory of every associate — active, pending onboarding, and inactive — with workplace, pay rate, employment type, manager, and contact info in one row.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'workers',
    path: '/workers',
    label: 'Workforce roster',
    description:
      'People, agents and robots in one roster: who each one answers to, what it can do, where it is in its lifecycle, and the record behind it.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'control-room',
    path: '/control-room',
    label: 'Control room',
    description: 'One live screen per site: every person, agent and robot on shift, the exceptions, what waits for a person, the safety zones and the span of control.',
    requires: 'view:time-live',
    group: 'operations',
  },
  {
    key: 'tasks',
    path: '/tasks',
    label: 'Tasks',
    description: 'Every unit of work at a site in a time window, who holds it (a person, an agent or a robot) and why; a machine that stalls hands its task to a person.',
    requires: 'view:time-live',
    group: 'operations',
  },
  {
    key: 'agents',
    path: '/agents',
    label: 'Agents',
    description:
      'Every agent the organization runs, by family: who owns it, what it may do, its limits, spend and the trail of what it did. Its proposals wait here for a person.',
    requires: 'view:org',
    group: 'platform',
  },
  {
    key: 'org',
    path: '/org',
    label: 'Departments & job profiles',
    description:
      'Departments, cost centers, job profiles, and the manager chain that holds approvals + dimensional reporting together.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'org-chart',
    path: '/org/chart',
    label: 'Org chart',
    description:
      'Who runs the company and who reports to whom, and every place and crew with who leads them.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'marketing',
    path: '/marketing',
    label: 'Marketing',
    description:
      'The careers site’s funnel by source, the employer brand page, referral campaigns, and source of hire.',
    requires: 'view:marketing',
    group: 'workforce-management',
  },
  {
    key: 'celebrations',
    path: '/celebrations',
    label: 'Celebrations',
    description:
      'Upcoming birthdays and work anniversaries. Send a quick high-five from any row.',
    requires: 'view:org',
    // A shift supervisor sees their own crew's.
    requiresAny: ['message:crew'],
    group: 'workforce-management',
  },
  {
    key: 'assets',
    path: '/assets',
    label: 'Assets',
    description:
      'Physical items assigned to associates: laptops, phones, badges, keys, vehicles. Track who has what and when it came back.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'pulse',
    path: '/pulse',
    label: 'Pulse',
    description:
      'Anonymous one-question check-ins for engagement signal. Score distributions and verbatim comments — never the responder.',
    requires: 'view:dashboard',
    group: 'workforce-management',
  },
  {
    key: 'headcount',
    path: '/headcount',
    label: 'Headcount',
    description:
      'Active associates across the company, hires & separations over the last 30 / 90 / 365 days, annualized turnover — and the headcount plan: every seat’s budget against what it costs.',
    requires: 'view:org',
    group: 'payroll-finance',
  },
  {
    key: 'headcount-plan',
    path: '/headcount/plan',
    label: 'Headcount plan',
    description:
      'Heads required against heads in place, place by place and week by week, priced at today’s rates — and the office seats against their budgets.',
    requires: 'view:org',
    group: 'payroll-finance',
  },
  {
    key: 'retention',
    path: '/retention',
    label: 'Retention',
    description:
      'Who might leave soon and why — hours, attendance, pay against the local market, rides — with the plays that keep people, and which ones work.',
    requires: 'view:org',
    requiresAny: ['view:org', 'manage:scheduling'],
    group: 'workforce-management',
  },
  {
    key: 'policy-campaigns',
    path: '/policy-campaigns',
    label: 'Policy campaigns',
    description:
      'Send one policy to everyone it applies to, remind on a cadence until it is signed, and see who has not.',
    requires: 'view:hr-admin',
    group: 'compliance',
  },
  {
    key: 'skills',
    path: '/skills',
    label: 'Skills',
    description:
      'Catalog of competencies and per-associate skill claims with proficiency level. Search the company by skill — useful for staffing and internal mobility.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'mentorship',
    path: '/mentorship',
    label: 'Mentorship',
    description:
      'Pair experienced people with newer ones. Suggestions use skills data to recommend ADVANCED+ mentors for a target growth skill.',
    requires: 'view:org',
    group: 'workforce-management',
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
      'Sequence multiple courses into ordered tracks. People work through them in order; status reflects the next incomplete step.',
    requires: 'view:compliance',
    group: 'workforce-management',
  },
  {
    key: 'succession',
    path: '/succession',
    label: 'Succession',
    description:
      'Designate successors for each position with a readiness band — ready now, 1–2 years, 3+ years, or emergency cover.',
    requires: 'view:hr-admin',
    group: 'workforce-management',
  },
  {
    key: 'probation',
    path: '/probation',
    label: 'Probation',
    description:
      'New-hire probation periods. See who is active, ending soon, or overdue. Pass, extend, or fail before the end date.',
    requires: 'view:hr-admin',
    group: 'workforce-management',
  },
  {
    key: 'holidays',
    path: '/holidays',
    label: 'Holidays',
    description:
      'Federal, state, company, and site-specific holidays. Drives premium pay multipliers and shift planning.',
    descriptionNoClients:
      'Federal, state, and company holidays. Drives premium pay multipliers and shift planning.',
    requires: 'view:scheduling',
    group: 'workforce-management',
  },
  {
    key: 'discipline',
    path: '/discipline',
    label: 'Disciplinary actions',
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
      'Plan, process, and complete departures. Capture exit-interview feedback — rating, what worked, what to change.',
    requires: 'view:hr-admin',
    group: 'workforce-management',
  },
  {
    key: 'internal-jobs',
    path: '/internal-jobs',
    label: 'Internal jobs',
    description:
      'Open positions across the company that current associates can apply to directly. Hiring managers review and decide.',
    requires: 'view:dashboard',
    group: 'workforce-management',
  },
  {
    key: 'vaccinations',
    path: '/vaccinations',
    label: 'Vaccinations',
    description:
      'Vaccination + TB-test records. Required by many sites and contracts. Coverage % per kind, expiring-soon feed.',
    descriptionNoClients:
      'Vaccination + TB-test records. Coverage % per kind, expiring-soon feed.',
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
    key: 'leave',
    path: '/leave',
    label: 'Leave of absence',
    description:
      'FMLA, state paid leave, military and accommodation leave: eligibility, notices, certifications, approvals and the return to work.',
    requires: 'view:dashboard',
    group: 'compliance',
  },
  {
    key: 'unemployment-claims',
    path: '/claims/unemployment',
    label: 'Unemployment claims',
    description:
      'State notices answered on time, argued from the record — the separation, warnings, attendance and offers of suitable work.',
    requires: 'manage:claims',
    group: 'compliance',
  },
  {
    key: 'workers-comp',
    path: '/claims/workers-comp',
    label: 'Workers’ comp claims',
    description:
      'From the injury to the carrier: the first report, lost and restricted days, restrictions and modified-duty shifts.',
    requires: 'manage:claims',
    group: 'compliance',
  },
  {
    key: 'help-center',
    path: '/help-center',
    label: 'Help center',
    description:
      'Self-service knowledge base. Search articles by category and tag; vote helpful / not helpful. Deflects HR cases.',
    requires: 'view:dashboard',
    group: 'workforce-management',
  },
  {
    key: 'ramp',
    path: '/ramp',
    label: '30/60/90 plans',
    description:
      'New-hire 30/60/90 day milestones. Manager updates status as they progress; achieve / miss is captured for the timeline.',
    requires: 'view:hr-admin',
    group: 'workforce-management',
  },
  {
    key: 'career',
    path: '/career',
    label: 'Career ladders',
    description:
      'Progression paths through your job family. Each rung links a job profile and lists required skills with a minimum proficiency.',
    requires: 'view:dashboard',
    group: 'workforce-management',
  },
  {
    key: 'learning',
    path: '/learning',
    label: 'Learning',
    description:
      'Courses assigned to you — work through required training and see what’s complete, due, or overdue.',
    requires: 'view:dashboard',
    group: 'workforce-management',
  },
  {
    key: 'tuition',
    path: '/tuition',
    label: 'Tuition',
    description:
      'Tuition reimbursement requests. Submit course-by-course with receipt and grade; HR approves and payroll pays out.',
    requires: 'view:dashboard',
    group: 'payroll-finance',
  },
  {
    key: 'hotline',
    path: '/hotline-admin',
    label: 'Hotline reports',
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
    group: 'payroll-finance',
  },
  {
    key: 'volunteer',
    path: '/volunteer',
    label: 'Volunteer',
    description:
      'Log volunteer hours and request employer match payouts. Approved hours roll into the annual cap; HR triages, approves, and disburses match.',
    requires: 'view:dashboard',
    group: 'workforce-management',
  },
  {
    key: 'team',
    path: '/team',
    label: 'My team',
    description:
      'Direct reports, timesheet reviews, and time-off decisions. Visible to anyone with at least one direct report.',
    requires: 'view:my-team',
    group: 'workforce-management',
  },
  {
    key: 'workflows',
    path: '/workflows',
    label: 'Workflows',
    description:
      'Trigger-condition-action automation that fires on hires, time-off decisions, position changes, and other events.',
    requires: 'view:org',
    group: 'platform',
  },
  {
    key: 'clients',
    path: '/clients',
    label: 'Clients',
    description:
      'CRM, contracts, SOW renewals, and client portal access.',
    requires: 'view:clients',
    group: 'client-services',
  },
  {
    key: 'client-nps',
    path: '/clients/nps',
    label: 'Client NPS',
    description: 'How likely each store is to recommend you — one question a quarter, per client and over time.',
    requires: 'view:executive',
    requiresAny: ['view:executive', 'view:marketing'],
    group: 'client-services',
  },
  {
    key: 'client-pipeline',
    path: '/clients/pipeline',
    label: 'Pipeline',
    description: 'New business from first call to signed client: owners, expected starts, and the value weighted by stage.',
    requires: 'manage:clients',
    requiresAny: ['manage:clients', 'view:executive'],
    group: 'client-services',
  },
  {
    key: 'performance',
    path: '/performance',
    label: 'Performance',
    description:
      'Reviews, KPIs, PIPs, commendations, disciplinary log, and 360 feedback.',
    requires: 'view:performance',
    group: 'workforce-management',
  },
  {
    key: 'time-attendance',
    path: '/time-attendance',
    label: 'Time & attendance',
    description:
      'Geofenced clock-in, timesheet approvals, and attendance auditing.',
    requires: 'view:time',
    group: 'workforce-management',
  },
  {
    key: 'kiosk',
    path: '/time-attendance/kiosk',
    label: 'Kiosk',
    description:
      'Manage kiosk devices, assign 4-digit clock-in PINs, and review punches.',
    requires: 'manage:time',
    group: 'operations',
  },
  {
    key: 'time-off',
    path: '/time-off',
    label: 'Time off',
    description:
      'PTO requests, sick-leave balances, and HR approval queue.',
    requires: 'view:time',
    group: 'workforce-management',
  },
  {
    key: 'rides',
    path: '/rides',
    label: 'Ride',
    description:
      'Book a seat on an Alto van to or from work — your rides, pickups, and what comes out of pay.',
    requires: 'ride:transport',
    group: 'workforce-management',
  },
  {
    key: 'transport',
    path: '/transport',
    label: 'Transportation',
    description:
      'The van command center — bookings, dispatch, drivers, vans, stops, issues, and ride charges.',
    requires: 'view:transport',
    group: 'workforce-management',
  },
  {
    key: 'season-planner',
    path: '/season-planner',
    label: 'Season planner',
    description:
      'Demand by store, shift and week becomes associates, beds, van seats and recruiting targets by channel — scenarios saved and compared side by side.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'supervisor-corps',
    path: '/scheduling/supervisors',
    // Plain words for "who leads each store" (was the jargon "Supervisor
    // corps"); the tenant's word for a site is applied (NAV_LABEL).
    label: 'Store leads',
    description:
      'Who leads which store and shift: place a shift or floor supervisor at a store and shift without opening Users & access.',
    requires: 'manage:org',
    group: 'workforce-management',
  },
  {
    key: 'forecast',
    path: '/forecast',
    label: 'Demand forecast',
    description:
      'Verified hours per site and week, forecast twenty-six weeks ahead with a confidence band from its own back-test; the season planner starts from it in one click.',
    requires: 'view:org',
    group: 'workforce-management',
  },
  {
    key: 'emergency',
    path: '/emergency',
    label: 'Emergency mode',
    description:
      'One switch for a storm: suspend shifts without penalty, tell every associate in their language, see who checked in safe, book evacuation rides, and stand down.',
    requires: 'view:emergency',
    group: 'workforce-management',
  },
  {
    key: 'scheduling',
    path: '/scheduling',
    label: 'Scheduling',
    description:
      'Shift planning, fill rate tracking, and assignment management.',
    requires: 'view:scheduling',
    group: 'workforce-management',
  },
  {
    key: 'call-outs',
    path: '/call-outs',
    label: 'Call-outs',
    description:
      'Who can’t make their shift — by phone, text, WhatsApp or the app — the reason, and how cover is going. Cover starts on its own.',
    requires: 'view:scheduling',
    requiresAny: ['view:scheduling', 'manage:scheduling'],
    group: 'workforce-management',
  },
  {
    key: 'robots',
    path: '/robots',
    label: 'Robots',
    description:
      'The robot fleet: every robot with its live reading, its site commissioning, the pre-shift checklist, safety zones, incidents and maintenance.',
    requires: 'view:org',
    group: 'operations',
  },
  {
    key: 'ops',
    path: '/ops',
    label: 'Store Ops',
    description:
      'SOP checklists, live operational shifts, shift-to-shift handover, and the standards library.',
    requires: 'run:ops-shifts',
    requiresAny: ['run:ops-shifts', 'view:ops', 'assist:ops-shifts'],
    group: 'operations',
  },
  {
    key: 'labor-costs',
    path: '/labor-costs',
    label: 'Labor costs',
    description:
      'Daily scheduled vs worked labor spend, broken down by client and store.',
    descriptionNoClients:
      'Daily scheduled vs worked labor spend, broken down by site.',
    // Same audience as the scheduling KPI strip that already shows cost —
    // supervisors see their own client, org roles see everything. Also an
    // executive read (live margin board).
    requires: 'manage:scheduling',
    // Finance reads spend too — labor cost IS the payroll-funding input.
    requiresAny: ['manage:scheduling', 'view:executive', 'process:payroll'],
    group: 'payroll-finance',
  },
  {
    key: 'approvals',
    path: '/approvals',
    label: 'Approvals',
    description:
      'One inbox for every decision waiting on you — swap requests, open-shift pickups, unconfirmed shifts, time-off requests, and timesheets to review.',
    requires: 'manage:scheduling',
    group: 'workforce-management',
  },
  {
    key: 'payroll',
    path: '/payroll',
    label: 'Payroll',
    description:
      'Multi-state payroll, anomaly detection, Branch cards, and Wise transfers.',
    requires: 'view:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'payroll-go-live',
    path: '/payroll/go-live',
    label: 'Run payroll in-house',
    description:
      'Everything the company needs on file to run payroll itself — the EIN, federal and state tax accounts, filing, how paychecks go out, schedules and controls — checked, with where to fix each.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'cash-forecast',
    path: '/finance/cash-forecast',
    label: 'Cash forecast',
    description:
      'The next weeks of cash: payroll and deposits going out, statements coming in on their terms, week by week with every line behind it.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'pay-bill',
    path: '/finance/pay-bill',
    label: 'Pay and bill',
    description:
      'Every paycheck against the bill it should reach: margin per check, billable pay that is on no statement and why, premiums and retro pay rebilled by each client’s contract, and this week’s running payroll cost per store.',
    requires: 'process:payroll',
    requiresAny: ['process:payroll', 'view:executive'],
    group: 'payroll-finance',
  },
  {
    key: 'books',
    path: '/books',
    label: 'Books',
    description:
      'The company’s own books at a glance: cash in the bank, what clients owe and what you owe, profit this month, the month-end close and the QuickBooks sync.',
    descriptionNoClients:
      'The company’s own books at a glance: cash in the bank, what you are owed and what you owe, profit this month, the month-end close and the QuickBooks sync.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-reports',
    path: '/books/reports',
    label: 'Financial statements',
    description:
      'Profit and loss, balance sheet, cash flow and trial balance — for the company, a client, a site or a department, by month, with every number opening to the entries behind it.',
    descriptionNoClients:
      'Profit and loss, balance sheet, cash flow and trial balance — for the company, a site or a department, by month, with every number opening to the entries behind it.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-journal',
    path: '/books/journal',
    label: 'Journal',
    description:
      'Every entry in the books — posted on their own by payroll, statements, bills and the bank, or by hand — with where each came from.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-accounts',
    path: '/books/accounts',
    label: 'Chart of accounts',
    description:
      'The accounts the books keep, their balances, and each one’s detail.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-receivables',
    path: '/books/receivables',
    label: 'Receivables',
    description:
      'What clients owe: statements by age, payments received and applied, and who is late.',
    descriptionNoClients:
      'What you are owed: invoices by age, payments received and applied, and what is late.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-bills',
    path: '/books/bills',
    label: 'Bills',
    description:
      'Vendor bills: entered, approved by a second person, scheduled and paid by ACH or check.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-vendors',
    path: '/books/vendors',
    label: 'Vendors',
    description:
      'The people and companies you pay — their terms, bank details and 1099s.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-bank',
    path: '/books/bank',
    label: 'Bank and cards',
    description:
      'Bank and card activity matched to the books, categorized by rule, and reconciled to each statement.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-close',
    path: '/books/close',
    label: 'Month-end close',
    description:
      'Each month’s close: the checklist, accruals, the lock, and a second person’s sign-off.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-budgets',
    path: '/books/budgets',
    label: 'Budgets',
    description:
      'Budget against actual by account, month, client and department, with the forecast to year end.',
    descriptionNoClients:
      'Budget against actual by account, month and department, with the forecast to year end.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-assets',
    path: '/books/assets',
    label: 'Fixed assets',
    description:
      'Vans, equipment and build-outs on the books, depreciated each month.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'books-quickbooks',
    path: '/books/quickbooks',
    label: 'QuickBooks sync',
    description:
      'The company’s QuickBooks kept in step both ways: what went over, what came back, and anything waiting for a decision.',
    requires: 'view:books',
    group: 'payroll-finance',
  },
  {
    key: 'market-rates',
    path: '/market-rates',
    label: 'Market rates',
    description:
      'Every role at every store against its local market: where pay sits among the metro’s wages, what fill looks like at each pay level, and the bill rate that keeps the margin.',
    requires: 'view:clients',
    group: 'payroll-finance',
  },
  {
    key: 'earned-wage',
    path: '/payroll/earned-wage',
    label: 'Earned-wage access',
    description:
      'Pay before payday: every advance drawn, the exposure until the next check, and the cap, fee and limit the organization offers.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'daily-pay',
    path: '/payroll/daily-pay',
    label: 'Daily pay',
    description:
      'Pay people each night for the day’s approved time, to their card or bank, with the regular check truing up overtime and deductions. Who is paid daily, the cap, the fee.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'manual-checks',
    path: '/payroll/manual-checks',
    label: 'Manual checks',
    description:
      'Handwritten checks and insurer-paid sick pay, recorded into payroll history, year-to-date, the tax ledger and the W-2. Void or replace a check.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'state-tax',
    path: '/payroll/state-tax',
    label: 'State tax coverage',
    description:
      'Where payroll can withhold state income tax, the states waiting on a review with your tax adviser, and a calculator to check them.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'tax-jurisdictions',
    path: '/payroll/tax-jurisdictions',
    label: 'Tax jurisdictions',
    description:
      'The city, county, school and transit taxes payroll withholds where people live and work, each one’s review with your tax adviser, and a paycheck calculator.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'wotc',
    path: '/payroll/wotc',
    label: 'WOTC tax credits',
    description:
      'Work Opportunity Tax Credit screening, the 28-day state filing deadline, certifications and the credit earned by hours worked.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'aca',
    path: '/benefits/aca',
    label: 'ACA hours',
    description:
      'Variable-hour work measured against 130 hours a month: who is full-time, who is close, offers of coverage owed and the 1095-C months.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'payroll-taxes',
    path: '/payroll/taxes',
    label: 'Payroll taxes',
    description:
      'What payroll owes each tax agency and when, deposits, quarterly and annual returns, agency notices and the accounts behind them.',
    // Company-wide tax liabilities and SSN-bearing wage reports.
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'pay-schedules',
    path: '/payroll/schedules',
    label: 'Pay schedules',
    description:
      'Who is paid when: each schedule, the clients, sites and people on it, the pay calendar with holiday moves, and everyone not yet on one.',
    descriptionNoClients:
      'Who is paid when: each schedule, the sites and people on it, the pay calendar with holiday moves, and everyone not yet on one.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'payroll-banking',
    path: '/payroll/banking',
    label: 'Payroll banking',
    description:
      'The money behind each run: what to fund and by when, the operating account it comes from, NACHA files, returns, prenotes and the payroll calendar.',
    // The company's bank account and every employee's deposit file.
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'certified-payroll',
    path: '/payroll/certified',
    label: 'Certified payroll',
    description:
      'Public-works projects paid at prevailing wage: rates from the wage determination, the weekly WH-347 with its signed Statement of Compliance, and the California eCPR file.',
    // Company payroll records with wages, deductions and the last four of each SSN.
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'garnishments',
    path: '/payroll/garnishments',
    label: 'Garnishments',
    description:
      'Income withholding orders from e-IWO, state allocation rules and IRS levy tables, each order’s balance and next remittance, and electronic payment to State Disbursement Units.',
    // Court and agency orders with SSNs and payee bank details: company-wide payroll PII.
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'retirement',
    path: '/payroll/retirement',
    label: 'Retirement plans',
    description:
      '401(k) plans per employer: eligibility and auto-enrollment, match and safe harbor, loans, and the contribution, census and true-up files for the recordkeeper.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'carrier-feeds',
    path: '/benefits/carriers',
    label: 'Carrier feeds',
    description:
      'Each insurance carrier’s connection and the EDI 834 enrollment files sent to it — full and change files from enrollments, dependents and life events.',
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'contractors',
    path: '/payroll/contractors',
    label: 'Contractors',
    description:
      'W-9s, IRS name and TIN checks, B-notices and 24% backup withholding, contractor payment runs, state 1099 filing and the year-end summary.',
    // TINs, backup withholding and company-wide contractor payments.
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'payroll-tax',
    // The Payroll taxes desk's Returns tab (the old /payroll/tax redirects there);
    // garnishment orders are on the garnishment desk.
    path: '/payroll/taxes?tab=returns',
    label: 'Tax forms',
    description:
      'Quarterly 941/940 builders, W-2 / 1099 generation, e-file and the forms an agency rejected, and the employer submitter profile.',
    // Employer-side tax operations with company-wide garnishment PII —
    // process:payroll, never the view:payroll every associate holds for
    // their own paystubs. (An associate's own W-2s live at /me?tab=tax-docs.)
    requires: 'process:payroll',
    group: 'payroll-finance',
  },
  {
    key: 'payroll-compliance',
    path: '/payroll/compliance',
    label: 'Payroll compliance',
    description:
      'State new-hire reporting, state pay notices, the 2026 Roth catch-up rule and paystub rules.',
    requires: 'process:payroll',
    group: 'compliance',
  },
  {
    key: 'marketplace',
    path: '/marketplace',
    label: 'Open shifts',
    description:
      'Marketplace of open shifts qualified associates can pick up. Managers approve claims.',
    requires: 'view:scheduling',
    group: 'workforce-management',
  },
  {
    key: 'timesheets',
    path: '/timesheets',
    // The page it opens is Time & attendance, so that is its name in
    // Finance's nav too ("Timesheets" meant three things — F500 G2).
    label: 'Time & attendance',
    // Finance's name for the same full T&A surface (approve hours, work
    // the corrections window, pull the Fieldglass hours sheet). Rendered
    // only in the FINANCE_ACCOUNTANT nav — see visibleModules.
    description:
      'Review and approve worked hours, run the corrections window, and export the payroll hours sheets.',
    requires: 'view:time',
    group: 'workforce-management',
  },
  {
    key: 'fieldglass',
    path: '/time-attendance/timesheets',
    // The client's weekly hours, named for what they are; the vendor is
    // in the page's subtitle, not its name.
    label: 'Client hours',
    // The weekly sheet that gets Alto paid — its own entry, not a button
    // inside Time & attendance. Store-bound roles see the statuses; the
    // money is finance's (the API nulls it for them).
    description:
      'Fieldglass-ready weekly hours (Saturday → Friday): enter each worker’s week before Monday 2 PM Pacific, import what the buyer approved, and open any associate’s timesheet history across pay periods.',
    requires: 'manage:time',
    group: 'workforce-management',
  },
  {
    key: 'fieldglass-setup',
    path: '/fieldglass',
    label: 'Fieldglass setup',
    // Registration is finance's: the packet carries date of birth and the
    // SSN's last 4, so the page is process:payroll — never a supervisor's.
    description:
      'Register new associates in Fieldglass with everything the buyer’s form asks, move transfers, close out separations, and keep every Worker ID on file.',
    requires: 'process:payroll',
    group: 'workforce-management',
  },
  {
    key: 'statements',
    path: '/clients/statements',
    label: 'Client statements',
    description:
      'Weekly billing statements per client — generate due periods, finalize, and record payments. The client side of the money cycle.',
    // The operator's surface: payroll finalizes and records payment;
    // executives read. Finance lacked ANY nav path to this page before
    // (it hid behind the Clients module, gated view:clients).
    requires: 'process:payroll',
    requiresAny: ['process:payroll', 'view:executive'],
    group: 'payroll-finance',
  },
  {
    key: 'payrules',
    path: '/payrules',
    label: 'Pay rules',
    description:
      'Project codes, premium-pay differentials (overtime, night, holiday), and tip pools.',
    // Pay rules are payroll CONFIGURATION. view:payroll is what every
    // associate holds for their own paystubs, so gating on it put this
    // page in every hourly worker's nav. process:payroll = the payroll
    // operators (HR, Finance, the admin roles).
    requires: 'process:payroll',
    group: 'payroll-finance',
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
    group: 'payroll-finance',
  },
  {
    key: 'compensation',
    path: '/compensation',
    label: 'Compensation',
    description:
      'Pay bands, effective-dated comp history, and merit cycles — plan and apply pay changes for an entire population at once.',
    requires: 'view:comp',
    group: 'payroll-finance',
  },
  {
    key: 'benefits',
    path: '/benefits',
    label: 'Benefits',
    description:
      'Health, dental, vision, 401(k), HSA/FSA — pre-tax elections that come out of every paycheck.',
    requires: 'view:payroll',
    group: 'payroll-finance',
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
    key: 'programs',
    path: '/programs',
    label: 'Programs',
    description:
      'J-1 and H-2B lifecycle — sponsors, DS-2019 and petition dates, expiry and check-in alerts, the H-2B client rule, and the season transition calendar.',
    requires: 'view:compliance',
    group: 'workforce-management',
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
    // A page of the Settings & trust rail with a path under /audit: its own
    // entry so the sidebar lights Settings & trust here, not "Audit log"
    // (two items looked active on /audit/approvals — F500 G4).
    key: 'approval-record',
    path: '/audit/approvals',
    label: 'Approval record',
    description:
      'Every change that went to a second person: who asked, who decided, the before and after, and the reason.',
    requires: 'view:audit',
    requiresAny: ['manage:org', 'process:payroll'],
    group: 'platform',
  },
  {
    key: 'users',
    path: '/admin/users',
    label: 'Users & access',
    description:
      'List every account, change a role or status, and force a password reset (revokes active sessions).',
    requires: 'view:hr-admin',
    group: 'platform',
  },
  {
    key: 'sign-in',
    path: '/admin/sign-in',
    label: 'Sign-in',
    description: 'Your identity provider, the email domains that lead to it, and SCIM provisioning.',
    requires: 'manage:org',
    group: 'platform',
  },
  {
    key: 'access-certifications',
    path: '/admin/access-certifications',
    label: 'Access certifications',
    description: 'Every account reviewed by its manager on a campaign with a due date — keep, revoke or change, on the record.',
    requires: 'manage:org',
    group: 'platform',
  },
  {
    key: 'tenant-profile',
    path: '/admin/organization',
    label: 'Organization',
    description: 'Business model, the modules this organization runs, and what it calls things.',
    requires: 'view:hr-admin',
    group: 'platform',
  },
  {
    key: 'document-retention',
    path: '/admin/document-retention',
    label: 'Document retention',
    description: 'How many years after a person leaves each kind of document is kept, and what the next sweep would purge.',
    requires: 'view:hr-admin',
    group: 'platform',
  },
  {
    key: 'employers',
    path: '/admin/employers',
    label: 'Employers of record',
    description: 'Who legally employs each person: the legal name, EIN and address the W-2, 1099 and pay statement print.',
    requires: 'view:org',
    group: 'platform',
  },
  {
    key: 'org-units',
    path: '/admin/org-units',
    label: 'Cost centers & ledger codes',
    description: 'The ledger code labor posts to, and which places map to each. Regions and places are arranged in the Org chart.',
    requires: 'view:org',
    group: 'platform',
  },
  {
    key: 'sites',
    path: '/admin/sites',
    label: 'Sites',
    description: 'Every place work happens: time zone, state, and the unit of the tree it belongs to.',
    requires: 'view:org',
    group: 'platform',
  },
  {
    key: 'branding',
    path: '/admin/branding',
    label: 'Branding',
    description:
      'Org name, sender display, support email, primary colour, and logo applied to every outbound email.',
    requires: 'view:hr-admin',
    group: 'platform',
  },
  {
    key: 'billing',
    path: '/admin/billing',
    label: 'Billing',
    description: 'Your plan, this month’s active people, agents and robots, and your invoices.',
    // Brief 2-6 (decision 11): the org's admins and Finance; no longer tied to the bill-rates module.
    requires: 'manage:org',
    requiresAny: ['manage:org', 'process:payroll'],
    group: 'payroll-finance',
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
    group: 'client-services',
  },
  {
    key: 'communications',
    path: '/communications',
    // "Notifications", not "Broadcasts": an associate's own notification
    // inbox sat under My records as "Broadcasts" (F500 G4). "Inbox" stays
    // the decisions row.
    label: 'Notifications',
    description:
      'SMS, push notifications, broadcast messaging, and templates.',
    requires: 'view:communications',
    group: 'client-services',
  },
  {
    key: 'analytics',
    path: '/analytics',
    label: 'Analytics',
    description:
      'Executive dashboard, custom reports, and predictive analytics.',
    requires: 'view:analytics',
    group: 'payroll-finance',
  },
  {
    key: 'product-analytics',
    path: '/product-analytics',
    label: 'Product usage',
    description:
      'Who signs in, what they open, and what breaks — daily and monthly active users, traffic, error rates, and adoption.',
    requires: 'view:product-analytics',
    group: 'platform',
  },
  {
    key: 'design-system',
    path: '/design-system',
    label: 'Design system',
    description: 'The written standard the product follows: tokens, type, components and their states, the five page templates, and the design debt the sweep pays down.',
    requires: 'view:product-analytics',
    group: 'platform',
  },
  {
    key: 'trust-center',
    path: '/trust',
    label: 'Trust Center',
    description: 'How the platform is run, with the evidence: controls, the audit chain, agents and their governance, and your own numbers; the public page for prospects.',
    requires: 'view:audit',
    requiresAny: ['manage:org', 'view:executive', 'view:audit'],
    group: 'platform',
  },
  {
    key: 'compliance-evidence',
    path: '/admin/compliance-evidence',
    label: 'Compliance evidence',
    description:
      'Every SOC 2 control with its latest evidence and how old it is, and the sign-offs a person owes.',
    requires: 'view:org',
    group: 'platform',
    platformOnly: true,
  },
  {
    key: 'reliability',
    path: '/reliability',
    label: 'Reliability',
    description:
      'Errors against the weekly budget, p95 by route, kiosk punch success, ride completion, and API restarts — with a Saturday summary by email.',
    requires: 'view:product-analytics',
    group: 'platform',
  },
  {
    key: 'reports',
    path: '/reports',
    label: 'Reports',
    description:
      'Custom tabular reports — pick an entity (associates, time entries, payroll runs, applications…), choose columns and filters, save, run, and export.',
    requires: 'view:analytics',
    group: 'payroll-finance',
  },
  {
    key: 'integrations',
    path: '/integrations',
    label: 'Integrations',
    description:
      'Public API keys + outbound webhooks. Mint ASN bridge keys for AltoHR / ShiftReport Nexus and any other programmatic consumer.',
    requires: 'view:integrations',
    group: 'platform',
  },
];

/** Sidebar entry for the home dashboard (not a module). */
export const DASHBOARD_NAV = {
  path: '/',
  label: 'Home',
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


/* ---------------------------------------------------------------------- */
/* Doors — the sidebar's shape                                              */
/* ---------------------------------------------------------------------- */

/**
 * The sidebar is a dozen rows for every role, not a hundred: a few always-on
 * rows (Inbox, Messages, Relay), then DOORS — one row each, which open to the
 * modules behind them. The six Products of the taxonomy survive as the doors
 * (People, Hiring, Time & scheduling, Pay & finance, Compliance, Operations,
 * Clients, Communications, Insights, Settings & trust); what changed is the
 * depth. Every module stays a destination: inside its door, in the palette,
 * and by URL. A module in no door for a role falls into a trailing "More"
 * door rather than off the nav — the orphan-route test in
 * __tests__/lib/navCoverage.test.ts makes that a failing build, not a
 * silent gap.
 *
 * Visibility stays `visibleModules` (capability, tenant module, role
 * curation). Doors only arrange what is already visible, so a door with
 * nothing behind it is not drawn.
 */
export type DoorKey =
  | 'me'
  | 'team'
  | 'people'
  | 'hire'
  | 'time'
  | 'pay'
  | 'books'
  | 'compliance'
  | 'operations'
  | 'transport'
  | 'clients'
  | 'comms'
  | 'insights'
  | 'marketing'
  | 'settings'
  | 'my-schedule'
  | 'my-pay'
  | 'my-records'
  | 'more';

export interface NavDoor {
  key: DoorKey;
  label: string | ((term: (key: TermKey) => string) => string);
  /** The door's own page when it has one; otherwise the first visible child. */
  hub?: ModuleKey;
  children: ModuleKey[];
  /** Drawn as one link to its hub: the pages behind it have their own rail
   *  (Settings & trust), so the sidebar doesn't list them a second time,
   *  under different names. The children still count as covered. */
  flat?: boolean;
}

/** Always-on rows above the doors, one row each, in this order. */
export const RAIL_ROWS: readonly ModuleKey[] = ['inbox', 'messages', 'relay', 'floor-today'];

export const DOORS: Record<DoorKey, NavDoor> = {
  me: { key: 'me', label: 'Me', children: ['me', 'wallet', 'learning', 'help-center', 'career', 'internal-jobs', 'volunteer', 'rides'] },
  team: { key: 'team', label: 'My team', children: ['team'] },
  people: {
    key: 'people',
    label: (term) => term('nav.people'),
    children: ['people', 'workers', 'agents', 'org', 'org-chart', 'headcount', 'headcount-plan', 'retention', 'skills', 'celebrations', 'assets', 'performance', 'probation', 'ramp', 'succession', 'mentorship', 'learning-paths', 'separations'],
  },
  // Marketing sits under Hiring for the admins (the top of the same funnel);
  // the marketing manager's own rail opens its Marketing door first.
  hire: { key: 'hire', label: 'Hiring', children: ['recruiting', 'onboarding', 'marketing'] },
  time: {
    key: 'time',
    label: 'Time & scheduling',
    children: ['scheduling', 'call-outs', 'approvals', 'marketplace', 'time-attendance', 'timesheets', 'kiosk', 'time-off', 'holidays', 'fieldglass', 'labor-costs', 'forecast', 'season-planner', 'supervisor-corps', 'emergency'],
  },
  pay: {
    key: 'pay',
    label: 'Pay & finance',
    children: ['payroll', 'payroll-go-live', 'pay-schedules', 'payroll-banking', 'cash-forecast', 'pay-bill', 'market-rates', 'payroll-taxes', 'payroll-tax', 'garnishments', 'retirement', 'certified-payroll', 'contractors', 'state-tax', 'tax-jurisdictions', 'wotc', 'earned-wage', 'daily-pay', 'manual-checks', 'payrules', 'compensation', 'benefits', 'carrier-feeds', 'aca', 'reimbursements', 'tuition', 'equity', 'statements', 'fieldglass-setup'],
  },
  // The company's own books (2027-01): its hub is the overview.
  books: {
    key: 'books',
    label: 'Books',
    hub: 'books',
    children: ['books-reports', 'books-journal', 'books-accounts', 'books-receivables', 'books-bills', 'books-vendors', 'books-bank', 'books-close', 'books-budgets', 'books-assets', 'books-quickbooks'],
  },
  compliance: {
    key: 'compliance',
    label: (term) => term('nav.compliance'),
    children: ['compliance', 'documents', 'doc-templates', 'policy-campaigns', 'expirations', 'vaccinations', 'agreements', 'hr-cases', 'leave', 'unemployment-claims', 'workers-comp', 'discipline', 'hotline', 'payroll-compliance', 'programs', 'audit'],
  },
  operations: { key: 'operations', label: 'Operations', children: ['control-room', 'tasks', 'ops', 'robots'] },
  transport: { key: 'transport', label: (term) => term('nav.transport'), children: ['transport'] },
  clients: { key: 'clients', label: (term) => term('nav.clients'), children: ['clients', 'client-pipeline', 'client-nps'] },
  comms: { key: 'comms', label: 'Communications', children: ['communications', 'dircomms', 'pulse'] },
  marketing: { key: 'marketing', label: 'Marketing', children: ['marketing'] },
  insights: { key: 'insights', label: 'Insights', children: ['analytics', 'reports'] },
  settings: {
    key: 'settings',
    label: 'Settings & trust',
    hub: 'settings',
    flat: true,
    children: ['tenant-profile', 'employers', 'document-retention', 'org-units', 'sites', 'branding', 'users', 'sign-in', 'access-certifications', 'approval-record', 'workflows', 'integrations', 'billing', 'trust-center', 'compliance-evidence', 'reliability', 'product-analytics', 'design-system'],
  },
  // The associate's doors — the same modules, in the first person.
  'my-schedule': { key: 'my-schedule', label: 'My schedule', children: ['scheduling', 'marketplace', 'time-off', 'time-attendance'] },
  'my-pay': { key: 'my-pay', label: 'My pay', children: ['payroll', 'benefits', 'reimbursements'] },
  'my-records': { key: 'my-records', label: 'My records', children: ['documents', 'agreements', 'hr-cases', 'leave', 'communications'] },
  more: { key: 'more', label: 'More', children: [] },
};

const DEFAULT_RAIL: readonly DoorKey[] = ['me', 'team', 'people', 'hire', 'time', 'pay', 'books', 'compliance', 'operations', 'transport', 'clients', 'comms', 'insights', 'settings'];

/**
 * Which doors a role gets, in order. Most roles take the default and let
 * module visibility empty the doors they don't use. A role with its own
 * rail is one whose capabilities say "everything" but whose job doesn't: a
 * marketing manager holds the admin surface by product policy and does not
 * need Pay, Compliance or Settings in their menu. With an explicit rail,
 * what the doors don't name is left out of the menu (reachable by URL and
 * the palette, as always) instead of piling into "More".
 */
const ROLE_RAIL: Partial<Record<Role, readonly DoorKey[]>> = {
  ASSOCIATE: ['me', 'my-schedule', 'my-pay', 'my-records'],
  // Marketing's own job first (2026-10-17): the funnel, then the pipeline it
  // feeds and the people it reaches.
  MARKETING_MANAGER: ['me', 'marketing', 'hire', 'people', 'comms', 'insights'],
};

/**
 * Roles whose capabilities say "everything" but whose job is a team: the
 * doors they work from stay on top, and every other door is kept — whole,
 * still a door — under one folded group (role walk ops 21: a people
 * manager saw 135 links, Garnishments and Branding among them). Nothing
 * is dropped, so every page keeps its way in.
 */
const ROLE_FOLD: Partial<Record<Role, { keep: readonly DoorKey[]; label: string }>> = {
  MANAGER: { keep: ['me', 'team', 'time', 'people'], label: 'Company admin' },
};

export interface NavDoorView {
  key: DoorKey;
  label: string;
  /** Where the door row goes: its hub page, else its first child. */
  target: ModuleNav;
  children: ModuleNav[];
  /** One link to the target — see NavDoor.flat. */
  flat?: boolean;
  /** Sub-headings inside the door (the Pay door's five jobs, lib/payMenu). */
  groups?: PayMenuGroupView[];
}

export interface NavShape {
  /** Always-on single rows, in order. */
  rows: ModuleNav[];
  doors: NavDoorView[];
  /** Visible modules an explicit rail chose to leave out of the menu. */
  dropped: ModuleNav[];
  /** Doors kept but folded under one group (ROLE_FOLD) — still doors, one tap further. */
  folded?: { label: string; doors: NavDoorView[] };
}

/**
 * Arrange the visible modules into the role's rail. The client portal keeps
 * its flat store menu — a partner surface with its own grammar. Its home
 * page IS "My store" (or the region's "Command center"), so those are not
 * listed a second time under Home (F500 G5: Home and My store, one page).
 */
export const PORTAL_HOME_KEYS: ReadonlySet<ModuleKey> = new Set<ModuleKey>(['portal', 'region']);

export function navShapeFor(
  visible: ModuleNav[],
  role: string | undefined,
  term: (key: TermKey) => string,
): NavShape {
  if (role === 'CLIENT_PORTAL') {
    return { rows: visible.filter((m) => !PORTAL_HOME_KEYS.has(m.key)), doors: [], dropped: visible.filter((m) => PORTAL_HOME_KEYS.has(m.key)) };
  }
  const byKey = new Map(visible.map((m) => [m.key, m]));
  const used = new Set<ModuleKey>();
  const rows: ModuleNav[] = [];
  for (const key of RAIL_ROWS) {
    const m = byKey.get(key);
    if (m) {
      rows.push(m);
      used.add(key);
    }
  }
  const own = ROLE_RAIL[role as Role];
  const rail = own ?? DEFAULT_RAIL;
  const doors: NavDoorView[] = [];
  for (const doorKey of rail) {
    const door = DOORS[doorKey];
    const hub = door.hub ? byKey.get(door.hub) : undefined;
    if (hub) used.add(hub.key);
    const children = door.children.map((k) => byKey.get(k)).filter((m): m is ModuleNav => !!m && !used.has(m.key));
    for (const c of children) used.add(c.key);
    const target = hub ?? children[0];
    if (!target) continue;
    doors.push({
      key: doorKey,
      label: typeof door.label === 'function' ? door.label(term) : door.label,
      target,
      children,
      ...(door.flat && hub ? { flat: true } : {}),
      ...(doorKey === 'pay' ? { groups: groupPayMenu(children) } : {}),
    });
  }
  const left = visible.filter((m) => !used.has(m.key));
  // An explicit rail leaves the rest out on purpose. The default rail has
  // a safety net: anything visible that no door named still gets a row.
  if (own) return { rows, doors, dropped: left };
  if (left.length > 0) doors.push({ key: 'more', label: 'More', target: left[0]!, children: left });
  const fold = ROLE_FOLD[role as Role];
  if (fold) {
    const kept = doors.filter((d) => fold.keep.includes(d.key));
    const rest = doors.filter((d) => !fold.keep.includes(d.key));
    return { rows, doors: kept, dropped: [], ...(rest.length > 0 ? { folded: { label: fold.label, doors: rest } } : {}) };
  }
  return { rows, doors, dropped: [] };
}

/** The door that owns a path, for opening it when the page inside is active. */
export function doorKeyForPath(shape: NavShape, pathname: string): DoorKey | null {
  const key = moduleKeyForPath(pathname);
  if (!key) return null;
  for (const d of [...shape.doors, ...(shape.folded?.doors ?? [])]) {
    if (d.target.key === key || d.children.some((c) => c.key === key)) return d.key;
  }
  return null;
}

/** Every door of a shape, the folded ones included — for coverage checks and search. */
export function allDoors(shape: NavShape): NavDoorView[] {
  return [...shape.doors, ...(shape.folded?.doors ?? [])];
}

/**
 * Names that depend on who is reading: under an associate's "My pay", their
 * pay page is their paystubs, not "Payroll" (the office's word). Applied
 * after applyTerms by every nav surface (Sidebar, phone menu).
 */
export function roleNavLabels(modules: ModuleNav[], role: string | undefined, t: (key: 'nav.paystubs') => string): ModuleNav[] {
  if (role !== 'ASSOCIATE') return modules;
  return modules.map((m) => (m.key === 'payroll' ? { ...m, label: t('nav.paystubs') } : m));
}
