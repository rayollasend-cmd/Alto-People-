/**
 * The audit log's words (F500 G4, 2026-10-22): the categories a reviewer
 * filters by, the plain name of each event, and which rows are the API's
 * own request trail. One list, read by the API's filter and the page, so
 * "Pay & money" means the same rows in both.
 */

export const AUDIT_CATEGORIES = [
  'signin',
  'security',
  'data',
  'exports',
  'people',
  'pay',
  'time',
  'clients',
  'compliance',
  'settings',
  'requests',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export interface AuditCategoryDef {
  label: string;
  /** Action prefixes ("auth." matches auth.login). */
  prefixes: readonly string[];
  /** Actions containing this text, whatever their prefix ("export"). */
  contains?: string;
}

export const AUDIT_CATEGORY_DEFS: Record<AuditCategory, AuditCategoryDef> = {
  signin: { label: 'Sign-ins & accounts', prefixes: ['auth.', 'user.', 'scim.', 'mfa.', 'session.', 'sso.', 'webauthn.'] },
  security: { label: 'Security & access', prefixes: ['permission.', 'admin.', 'role.', 'tenant_role.', 'audit.', 'platform.', 'agent.', 'access.'] },
  data: { label: 'Data changes', prefixes: ['data.'] },
  exports: { label: 'Exports', prefixes: [], contains: 'export' },
  people: { label: 'People & onboarding', prefixes: ['associate.', 'onboarding.', 'application.', 'document.', 'i9.', 'separation.', 'discipline.'] },
  pay: { label: 'Pay & money', prefixes: ['payroll.', 'banking.', 'garnishment.', 'retirement.', 'wallet.', 'benefits.', 'payout.', 'compensation.', 'tax.', 'earned_wage.', 'books.'] },
  time: { label: 'Time & scheduling', prefixes: ['shift.', 'time.', 'ops.', 'leave.', 'transport.', 'schedule.', 'task.', 'season_plan.', 'work_offer.'] },
  clients: { label: 'Clients', prefixes: ['client.', 'clients.', 'client_prospect.', 'market.'] },
  compliance: { label: 'Compliance', prefixes: ['compliance.', 'wc_claim.', 'ui_claim.', 'osha.', 'hotline.'] },
  settings: { label: 'Settings', prefixes: ['org.', 'org_unit.', 'site.', 'tenant.', 'provider.', 'branding.', 'integration.'] },
  requests: { label: 'API requests', prefixes: ['http.'] },
};

/** The API's own request trail (http.post on HttpRequest): hidden by default, it drowns the people's actions. */
export const AUDIT_SYSTEM_PREFIX = 'http.';
export const AUDIT_SYSTEM_ENTITY = 'HttpRequest';

/** The category an action belongs to, or null when none claims it. */
export function auditCategoryOf(action: string): AuditCategory | null {
  for (const key of AUDIT_CATEGORIES) {
    const def = AUDIT_CATEGORY_DEFS[key];
    if (def.contains && action.includes(def.contains)) return key;
  }
  for (const key of AUDIT_CATEGORIES) {
    if (AUDIT_CATEGORY_DEFS[key].prefixes.some((p) => action.startsWith(p))) return key;
  }
  return null;
}

/** The events people look for most, in plain words. Everything else is said from its key. */
const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out',
  'auth.locked': 'Account locked',
  'auth.password_reset': 'Password reset',
  'auth.password_changed': 'Password changed',
  'auth.mfa_enabled': 'Two-step sign-in turned on',
  'auth.mfa_disabled': 'Two-step sign-in turned off',
  'platform.scope_opened': 'Operator opened this organization',
  'data.changed': 'Record changed',
  'permission.changed': 'Permissions changed',
  'admin.user_updated': 'Account changed',
  'associate.pii_viewed': 'Personal details viewed',
  'associate.deactivated': 'Person deactivated',
  'compliance.everify_case_viewed': 'E-Verify case viewed',
  'onboarding.task_skipped': 'Onboarding task skipped',
  'onboarding.application_created': 'Onboarding started',
  'onboarding.nudge_sent': 'Onboarding reminder sent',
  'application.approved': 'Application approved',
  'site.created': 'Site added',
  'site.updated': 'Site changed',
  'org.branding_updated': 'Branding changed',
  'tenant.profile_updated': 'Organization profile changed',
  'org_unit.created': 'Cost center added',
  'org_unit.updated': 'Cost center changed',
  'payroll.run_created': 'Payroll run started',
  'payroll.run_deleted': 'Payroll run deleted',
  'payroll.schedule.move': 'Moved between pay schedules',
  'payroll.schedule.create': 'Pay schedule created',
  'shift.created': 'Shift created',
  'shift.call_out': 'Call-out recorded',
  'time.clock_in': 'Clocked in',
  'time.clock_out': 'Clocked out',
  'banking.account_added': 'Bank account added',
  'audit.retention_changed': 'Audit retention changed',
  'audit.sink_configured': 'SIEM stream set up',
  'audit.sink_disabled': 'SIEM stream stopped',
  'scim.user_created': 'Account created by the directory',
  'scim.user_deprovisioned': 'Account removed by the directory',
  'http.export': 'Export downloaded',
};

const HTTP_METHOD: Record<string, string> = { post: 'API request (POST)', patch: 'API request (PATCH)', put: 'API request (PUT)', delete: 'API request (DELETE)' };

/** "auth.login" → "Signed in"; an unlisted key reads as a sentence ("payroll.schedule.rule_add" → "Payroll schedule rule add"). */
export function auditActionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  if (action.startsWith(AUDIT_SYSTEM_PREFIX)) return HTTP_METHOD[action.slice(AUDIT_SYSTEM_PREFIX.length)] ?? 'API request';
  const words = action.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

/** "PayrollRun" → "Payroll run": an entity type as people say it. */
export function auditEntityTypeLabel(entityType: string): string {
  if (entityType === 'HttpRequest') return 'API request';
  if (entityType === 'User') return 'Account';
  if (entityType === 'Associate') return 'Person';
  if (entityType === 'Location') return 'Site';
  if (entityType === 'OrgUnit') return 'Cost center';
  if (entityType === 'Tenant') return 'Organization';
  const words = entityType.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
