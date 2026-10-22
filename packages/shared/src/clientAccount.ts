import { z } from 'zod';

/* -------------------------------------------------------------------------- *
 *  The client's account page (CL-A, 2026-10-22): the people at the client,
 *  and the overview that says how the account is doing and what needs you.
 *  Money fields are present only for callers who can read statements
 *  (process:payroll or view:executive); everyone else gets them omitted,
 *  never zero.
 * -------------------------------------------------------------------------- */

export const ClientContactRoleSchema = /* @__PURE__ */ (() => z.enum(['PRIMARY', 'BILLING', 'SITE', 'OPERATIONS', 'OTHER']))();
export type ClientContactRole = z.infer<typeof ClientContactRoleSchema>;

export const CLIENT_CONTACT_ROLE_LABELS: Record<ClientContactRole, string> = {
  PRIMARY: 'Decision maker',
  BILLING: 'Billing',
  SITE: 'Site manager',
  OPERATIONS: 'Operations',
  OTHER: 'Other',
};

export const ClientContactSchema = /* @__PURE__ */ (() => z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  name: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  role: ClientContactRoleSchema,
  isPrimary: z.boolean(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}))();
export type ClientContact = z.infer<typeof ClientContactSchema>;

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const ClientContactInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(1, 'A contact needs a name.').max(120),
  title: z.preprocess(blankToNull, z.string().trim().max(120).nullable()).optional(),
  email: z.preprocess(blankToNull, z.string().trim().email('That email address is not valid.').max(254).nullable()).optional(),
  phone: z.preprocess(blankToNull, z.string().trim().max(40).regex(/^[0-9+().\-\s x]+$/i, 'A phone number holds digits, spaces and + ( ) - only.').nullable()).optional(),
  role: ClientContactRoleSchema.optional(),
  isPrimary: z.boolean().optional(),
  notes: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).optional(),
}))();
export type ClientContactInput = z.infer<typeof ClientContactInputSchema>;

export const ClientContactUpdateInputSchema = /* @__PURE__ */ (() => ClientContactInputSchema.partial())();
export type ClientContactUpdateInput = z.infer<typeof ClientContactUpdateInputSchema>;

/* ----- Overview ------------------------------------------------------------ */

export type ClientHealth = 'good' | 'watch' | 'risk';

export interface ClientOverviewMoney {
  /** Everything finalized and unpaid, net of partial payments. */
  outstanding: number;
  /** Outstanding by days past due (books/aging, the one definition). */
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
  /** Finalized statements dated this calendar month. */
  billedThisMonth: number;
  lastStatementTotal: number | null;
  lastStatementAt: string | null;
  /** Null when it cannot be computed truthfully. */
  marginPct: number | null;
  /** The margin its bill rates are priced to (Client.targetMarginPct). */
  targetMarginPct: number | null;
}

export interface ClientOverviewKpis {
  onAssignment: number;
  hoursThisWeek: number;
  hoursLastWeek: number;
  /** This week so far against the same days of last week; null with nothing to compare. */
  hoursChangePct: number | null;
  /** Hours last week up to the same moment of the week (what hoursChangePct compares against). */
  hoursLastWeekToDate: number | null;
  shiftsNext7: { total: number; filled: number };
  fillRatePct: number | null;
  overtimePct: number | null;
  health: ClientHealth;
  healthReasons: string[];
  money?: ClientOverviewMoney;
}

export type ClientNeedsYouKind =
  | 'unfilled_shifts'
  | 'overdue_statements'
  | 'contract_ended'
  | 'contract_ending'
  | 'nps_detractors'
  | 'client_requests'
  | 'portal_readiness'
  | 'no_primary_contact'
  | 'no_account_owner';

export interface ClientNeedsYouItem {
  kind: ClientNeedsYouKind;
  severity: 'risk' | 'watch';
  title: string;
  detail: string;
  count?: number;
  /** An in-app path to the list behind it. */
  href: string;
}

export interface ClientActivityItem {
  id: string;
  kind:
    | 'statement_finalized'
    | 'statement_paid'
    | 'request_opened'
    | 'request_answered'
    | 'collection_note'
    | 'portal_user_added'
    | 'portal_user_disabled'
    | 'bill_rate_changed'
    | 'billing_terms_changed'
    | 'contact_added'
    | 'owner_changed'
    | 'contract_changed';
  at: string;
  /** Who did it, by name; null when the system did. */
  actor: string | null;
  text: string;
  href: string | null;
}

export interface ClientOverviewLocation {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  onAssignment: number;
}

export interface ClientOverview {
  clientId: string;
  asOf: string;
  /** True when the money fields are present (statements readers). */
  canSeeMoney: boolean;
  /** Null when the numbers could not be computed. */
  kpis: ClientOverviewKpis | null;
  needsYou: ClientNeedsYouItem[];
  contacts: ClientContact[];
  locations: { count: number; items: ClientOverviewLocation[] };
  owner: { id: string; name: string; email: string } | null;
  contract: { start: string | null; end: string | null; daysLeft: number | null };
  paymentTermsDays: number;
  recentActivity: ClientActivityItem[];
}

/** An internal user who may own an account (the owner picker). */
export interface ClientOwnerOption {
  id: string;
  name: string;
  email: string;
  role: string;
}
