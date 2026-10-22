import type { SeasonWeekMix } from './tasks.js';
import { z } from 'zod';
import { TenantProfileSchema } from './tenantProfile.js';
import { WorkStatusSchema, type WorkStatusCounts } from './peopleStatus.js';
import { httpUrl } from './safeUrl.js';

/* -------------------------------------------------------------------------- *
 *  Common
 * -------------------------------------------------------------------------- */

export const UuidSchema = /* @__PURE__ */ (() => z.string().uuid())();
export type Uuid = z.infer<typeof UuidSchema>;

export const ApiErrorSchema = /* @__PURE__ */ (() => z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
}))();
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* -------------------------------------------------------------------------- *
 *  Domain enums (mirror Prisma enums in apps/api/prisma/schema.prisma).
 *  Kept as Zod literals so the wire contract stays string-based.
 * -------------------------------------------------------------------------- */

export const ClientStatusSchema = /* @__PURE__ */ (() => z.enum(['ACTIVE', 'INACTIVE', 'PROSPECT']))();
export type ClientStatus = z.infer<typeof ClientStatusSchema>;

export const OnboardingTrackSchema = /* @__PURE__ */ (() => z.enum([
  'STANDARD',
  'J1',
  'CLIENT_SPECIFIC',
]))();
export type OnboardingTrack = z.infer<typeof OnboardingTrackSchema>;

export const ApplicationStatusSchema = /* @__PURE__ */ (() => z.enum([
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  // Called off by us — sent by mistake, a hire undone, an invite expired.
  'CANCELLED',
]))();
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;
/** Every status value — for seeding total Record<ApplicationStatus, T> maps. */
export const APPLICATION_STATUSES = ApplicationStatusSchema.options;

export const TaskKindSchema = /* @__PURE__ */ (() => z.enum([
  'PROFILE_INFO',
  'DOCUMENT_UPLOAD',
  'E_SIGN',
  'BACKGROUND_CHECK',
  'W4',
  'DIRECT_DEPOSIT',
  'POLICY_ACK',
  'J1_DOCS',
  'I9_VERIFICATION',
  // Live headshot taken during onboarding (camera-only in the associate flow).
  'PROFILE_PHOTO',
  // WOTC pre-screening (Form 8850 / ETA 9061) — voluntary for the applicant.
  'WOTC_SCREENING',
]))();
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskStatusSchema = /* @__PURE__ */ (() => z.enum([
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'SKIPPED',
]))();
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/* -------------------------------------------------------------------------- *
 *  Clients
 * -------------------------------------------------------------------------- */

export const ClientSummarySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  name: z.string(),
  industry: z.string().nullable(),
  status: ClientStatusSchema,
  contactEmail: z.string().email().nullable(),
  // Two-letter USPS code; drives Phase 23 OT/break policy and Phase 25
  // predictive-scheduling enforcement. Null = federal default.
  state: z.string().length(2).nullable(),
  /** This client's scheduling week start, 0=Sunday … 6=Saturday. Drives
   *  the associate week-ahead digest (sent the evening before) and any
   *  future per-client week math. Optional for old clients of the API. */
  weekStartsOn: z.number().int().min(0).max(6).optional(),
  /** Verbatim Fieldglass "Site" label (e.g. "1 - Onsite - FL - Destin")
   *  used on the Timesheets export. Optional/nullable for backward compat. */
  fieldglassSiteName: z.string().nullable().optional(),
  /** Fieldglass client bill rate ($/hr) — the "Rate" on the timesheet
   *  accounting block (Amount = rate × hours). Not the associate pay rate. */
  fieldglassBillRate: z.number().nullable().optional(),
  /** Who at the company owns the account (an internal user), and the
   *  contract's term (YYYY-MM-DD). Optional for old clients of the API. */
  accountOwnerUserId: UuidSchema.nullable().optional(),
  contractStartDate: z.string().nullable().optional(),
  contractEndDate: z.string().nullable().optional(),
  /** The account's legal facts and invoicing terms, read on Basics. */
  legalName: z.string().nullable().optional(),
  addressLine1: z.string().nullable().optional(),
  addressLine2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  poNumber: z.string().nullable().optional(),
  paymentTermsDays: z.number().int().optional(),
}))();
export type ClientSummary = z.infer<typeof ClientSummarySchema>;

// Phase 47 — richer shape returned only by the list endpoint. Detail /
// create / update routes still return the lean ClientSummary so they
// don't pay for the count queries on every write.
//
// openApplications counts every Application that hasn't been REJECTED.
// lastPayrollDisbursedAt is the most recent PayrollRun that actually
// settled for this client; null when no run has ever disbursed.
//
// activeAssociateCount — the associates working at the client now: an open
// assignment there, else (none open) their approved application there;
// separated / deactivated people excluded. A cross-client transfer moves
// them (lib/associateClients.activeAssociateCountsByClient).
/** good / watch / risk (the type is ClientHealth, in clientAccount.ts). */
export const ClientHealthLevelSchema = /* @__PURE__ */ (() => z.enum(['good', 'watch', 'risk']))();

// Clients rebuild (2026-10-22): how the account is doing, from
// lib/clientMetrics — the same numbers the client's overview shows. Present
// only with ?include=metrics (the clients list); pickers stay lean.
// onAssignment is activeAssociateCount by its plain name (people working
// there by the one definition of active). fillRatePct is null when no
// shift starts in the next 7 days. Money fields (outstanding, billedInRange
// for the list's ?from=&to=, this month by default) are present only for
// callers who can read statements; omitted, never 0, for everyone else.
export const ClientListItemSchema = /* @__PURE__ */ (() => ClientSummarySchema.extend({
  openApplications: z.number().int().nonnegative(),
  activeAssociateCount: z.number().int().nonnegative(),
  lastPayrollDisbursedAt: z.string().datetime().nullable(),
  onAssignment: z.number().int().nonnegative().optional(),
  shiftsNext7: z.object({ total: z.number().int().nonnegative(), filled: z.number().int().nonnegative() }).optional(),
  fillRatePct: z.number().nullable().optional(),
  hoursThisWeek: z.number().optional(),
  health: ClientHealthLevelSchema.optional(),
  healthReasons: z.array(z.string()).optional(),
  accountOwner: z.object({ id: UuidSchema, name: z.string() }).nullable().optional(),
  outstanding: z.number().optional(),
  billedInRange: z.number().optional(),
}))();
export type ClientListItem = z.infer<typeof ClientListItemSchema>;

/** GET /clients/:id/performance — a client's Performance tab (lib/clientMetrics.clientWeeks). */
export interface ClientPerformanceWeek {
  /** The week's first day (YYYY-MM-DD) on the client's week, site clock. */
  start: string;
  hours: number;
  overtimeHours: number;
  overtimePct: number | null;
  shifts: number;
  filled: number;
  fillRatePct: number | null;
}
export interface ClientPerformanceStatement {
  id: string;
  number: number | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  hours: number;
  /** Still owed on a FINAL statement, net of payments. */
  open: number;
  state: 'paid' | 'waiting' | 'draft';
  dueOn: string | null;
  daysPastDue: number | null;
}
export interface ClientPerformanceResponse {
  clientId: string;
  asOf: string;
  weekStartsOn: number;
  timezone: string;
  /** The last 12 complete weeks, oldest first. */
  weeks: ClientPerformanceWeek[];
  canSeeMoney: boolean;
  /** Statements readers only; oldest first. */
  statements?: ClientPerformanceStatement[];
  /** Executive and marketing only; wave by wave, oldest first. */
  nps?: Array<{ quarter: string; nps: number | null; responses: number }>;
}

export const ClientStateInputSchema = /* @__PURE__ */ (() => z.object({
  state: z.string().length(2).nullable(),
}))();
export type ClientStateInput = z.infer<typeof ClientStateInputSchema>;

// Phase 46 — HR-managed client CRUD. `name` is required and unique-ish at
// the UI level (the API does not enforce uniqueness — two clients named
// "Acme" are legal because of distinct UUIDs). Industry / contact email
// stay optional. Status defaults to PROSPECT for new records so the
// roster doesn't auto-populate active counts before HR confirms.
export const ClientCreateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(1).max(120),
  industry: z.string().trim().max(80).nullable().optional(),
  status: ClientStatusSchema.optional(),
  contactEmail: z.string().trim().email().max(254).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  fieldglassSiteName: z.string().trim().max(255).nullable().optional(),
  fieldglassBillRate: z.number().nonnegative().max(100000).nullable().optional(),
}))();
export type ClientCreateInput = z.infer<typeof ClientCreateInputSchema>;

// Partial update — every field is optional; sending null clears the
// nullable ones. Use the dedicated /:id/state and /:id/geofence routes
// for state and geofence (they have side-effects on policy enforcement).
export const ClientUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(1).max(120).optional(),
  industry: z.string().trim().max(80).nullable().optional(),
  status: ClientStatusSchema.optional(),
  contactEmail: z.string().trim().email().max(254).nullable().optional(),
  weekStartsOn: z.number().int().min(0).max(6).optional(),
  fieldglassSiteName: z.string().trim().max(255).nullable().optional(),
  fieldglassBillRate: z.number().nonnegative().max(100000).nullable().optional(),
  /** Invoicing: the standing purchase order and net-days terms every statement takes. */
  poNumber: z.string().trim().max(60).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  /** Sales tax on this client's statements: taxable, and the rate (percent). */
  salesTaxable: z.boolean().optional(),
  salesTaxRatePct: z.number().min(0).max(100).nullable().optional(),
  /** The account's owner: an internal user of the same tenant (null clears). */
  accountOwnerUserId: UuidSchema.nullable().optional(),
  /** The contract's term, YYYY-MM-DD (null clears); end on or after start. */
  contractStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  contractEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** Legal name and billing address (W-2 employer block, statements). */
  legalName: z.string().trim().max(255).nullable().optional(),
  addressLine1: z.string().trim().max(255).nullable().optional(),
  addressLine2: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  zip: z.string().trim().max(10).nullable().optional(),
}))();
export type ClientUpdateInput = z.infer<typeof ClientUpdateInputSchema>;

export const ClientListResponseSchema = /* @__PURE__ */ (() => z.object({
  clients: z.array(ClientListItemSchema),
  // When pagination is in use, the id of the last item in this page so
  // the caller can request the next page via ?cursor=<id>. Null means
  // there are no more rows. Optional for backwards compatibility with
  // callers that haven't adopted cursor pagination yet.
  nextCursor: z.string().uuid().nullable().optional(),
}))();
export type ClientListResponse = z.infer<typeof ClientListResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Onboarding
 * -------------------------------------------------------------------------- */

export const ChecklistTaskSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  kind: TaskKindSchema,
  status: TaskStatusSchema,
  title: z.string(),
  description: z.string().nullable(),
  order: z.number().int(),
  documentId: UuidSchema.nullable(),
  completedAt: z.string().datetime().nullable(),
  /** Days before the application's start date this task is due. */
  dueOffsetDays: z.number().int().nullable().optional(),
}))();
export type ChecklistTask = z.infer<typeof ChecklistTaskSchema>;

// Phase 41 — drives W-4 onboarding task inclusion + payroll tax math.
// W2_EMPLOYEE is the default for back-compat with every prior application.
export const EmploymentTypeSchema = /* @__PURE__ */ (() => z.enum([
  'W2_EMPLOYEE',
  'CONTRACTOR_1099_INDIVIDUAL',
  'CONTRACTOR_1099_BUSINESS',
]))();
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

// Phase 60 — last invite/nudge email delivery status, surfaced on the
// inbox + detail page so HR sees bounces before the associate fails to
// log in. null = no email ever attempted (shouldn't happen in practice
// after Phase 16, but legacy rows + tests can produce it).
export const InviteDeliveryStatusSchema = /* @__PURE__ */ (() => z.enum(['QUEUED', 'SENT', 'FAILED']))();
export type InviteDeliveryStatus = z.infer<typeof InviteDeliveryStatusSchema>;

export const InviteDeliveryInfoSchema = /* @__PURE__ */ (() => z.object({
  status: InviteDeliveryStatusSchema,
  // ISO when the row was created (≈ when the send was attempted).
  attemptedAt: z.string().datetime(),
  // ISO of successful send, null if FAILED or still QUEUED.
  sentAt: z.string().datetime().nullable(),
  // Provider error message, null when SENT.
  failureReason: z.string().nullable(),
  // What triggered this row: "onboarding.invite" or "onboarding.nudge".
  category: z.string(),
}))();
export type InviteDeliveryInfo = z.infer<typeof InviteDeliveryInfoSchema>;

export const ApplicationSummarySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateName: z.string(),
  clientName: z.string(),
  onboardingTrack: OnboardingTrackSchema,
  status: ApplicationStatusSchema,
  position: z.string().nullable(),
  // Calendar date (@db.Date) — YYYY-MM-DD, never a timestamp. Encoding
  // a zone onto a date can only introduce error (it rendered a day early
  // west of UTC).
  startDate: z.string().date().nullable(),
  invitedAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
  /** Set when the applicant edited anything after submission — the
   *  reviewer must re-check before approving. */
  updatedAfterSubmitAt: z.string().datetime().nullable().optional(),
  percentComplete: z.number().min(0).max(100),
  // Phase 60 — most recent EMAIL Notification on this associate's user
  // tagged onboarding.invite or onboarding.nudge. null when there's no
  // such row yet (test fixtures, legacy data).
  lastInviteDelivery: InviteDeliveryInfoSchema.nullable().optional(),
  /** Title of the first incomplete task — what the hire is stuck on. */
  blockedOnTitle: z.string().nullable().optional(),
  /** Most recent movement: latest task completion, else the invite. */
  lastActivityAt: z.string().datetime().nullable().optional(),
  /** Stuck by the one rule (apps/api/src/lib/applicationFilters.ts): in flight, unfinished, nothing moved in 7 days. */
  stuck: z.boolean().optional(),
  /** The hire's headshot (cache-busted); null when none is on file. */
  photoUrl: z.string().nullable().optional(),
}))();
export type ApplicationSummary = z.infer<typeof ApplicationSummarySchema>;

export const ApplicationDetailSchema = /* @__PURE__ */ (() => ApplicationSummarySchema.extend({
  associateId: UuidSchema,
  clientId: UuidSchema,
  tasks: z.array(ChecklistTaskSchema),
  // Phase 41 — surfaced on the detail header so HR can see at a glance
  // whether this is a W-2 or 1099 onboarding flow (no W-4 task on 1099s).
  employmentType: EmploymentTypeSchema,
  // HR review outcome. approvedAt is set when HR clicks Approve and
  // assigns a hire date; rejectedAt + rejectionReason are set on Reject.
  // hireDate mirrors the Associate.hireDate set at approval time so the
  // detail page can render it without a second join.
  approvedAt: z.string().datetime().nullable(),
  rejectedAt: z.string().datetime().nullable(),
  rejectionReason: z.string().nullable(),
  /** Called off (sent in error, a hire undone, an invite that expired): when and why. */
  cancelledAt: z.string().datetime().nullable().optional(),
  cancelReason: z.string().nullable().optional(),
  cancelNote: z.string().nullable().optional(),
  hireDate: z.string().date().nullable(),
  /** The store the application names (the approve dialog asks for one when
   *  this is null and the client has several). */
  locationId: UuidSchema.nullable().optional(),
  locationName: z.string().nullable().optional(),
}))();
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

// HR review actions — used by /onboarding/applications/:id/approve and
// /reject. hireDate is a YYYY-MM-DD date string the HR user picks in the
// approve dialog.
export const ApproveApplicationInputSchema = /* @__PURE__ */ (() => z.object({
  hireDate: z.string().date(),
  /** The store the hire will work at. Required (409 `store_required`) when
   *  the application names none and the client has more than one store —
   *  the ready-to-work handoff pages that store's supervisors. */
  locationId: UuidSchema.optional(),
  /** Verification gaps (skipped tasks, unreviewed documents, incomplete
   *  I-9) make approval return 409 `approval_warnings` with the list —
   *  pass true to approve anyway. Forces a human to SEE what was never
   *  verified instead of activating a hire on a skipped checklist. */
  acknowledgeWarnings: z.boolean().optional(),
}))();
export type ApproveApplicationInput = z.infer<
  typeof ApproveApplicationInputSchema
>;

export const RejectApplicationInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().trim().min(1).max(500),
}))();
export type RejectApplicationInput = z.infer<
  typeof RejectApplicationInputSchema
>;

export const ApplicationListResponseSchema = /* @__PURE__ */ (() => z.object({
  applications: z.array(ApplicationSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
}))();
export type ApplicationListResponse = z.infer<
  typeof ApplicationListResponseSchema
>;

// Roll-up counts + sample rows for the Onboarding sidebar tiles. Decouples
// the stats panel from the paginated list so the client doesn't have to
// pull every row just to count statuses.
export const ApplicationStatsResponseSchema = /* @__PURE__ */ (() => z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(ApplicationStatusSchema, z.number().int().nonnegative()),
  inFlight: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  bounced: z.number().int().nonnegative(),
  avgPercent: z.number().min(0).max(100),
  staleSamples: z.array(ApplicationSummarySchema),
  bouncedSamples: z.array(ApplicationSummarySchema),
  /** Drafts nobody has moved in 7 days — the "Idle drafts" filter and the Inbox's "drafts gone quiet". */
  idleDrafts: z.number().int().nonnegative().optional(),
}))();
export type ApplicationStatsResponse = z.infer<
  typeof ApplicationStatsResponseSchema
>;

export const TemplateTaskSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  kind: TaskKindSchema,
  title: z.string(),
  description: z.string().nullable(),
  order: z.number().int(),
  /** Days before the application's start date this task should be done
   *  (0 = by the start date; null = no deadline). */
  dueOffsetDays: z.number().int().min(0).max(365).nullable().optional(),
}))();
export type TemplateTask = z.infer<typeof TemplateTaskSchema>;

export const OnboardingTemplateSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema.nullable(),
  track: OnboardingTrackSchema,
  name: z.string(),
  tasks: z.array(TemplateTaskSchema),
}))();
export type OnboardingTemplate = z.infer<typeof OnboardingTemplateSchema>;

export const TemplateListResponseSchema = /* @__PURE__ */ (() => z.object({
  templates: z.array(OnboardingTemplateSchema),
}))();
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;

/* ===== Phase 61 — template editor (HR CRUD) ============================ */

// Tasks come without ids (server generates) and the order field is
// optional — server normalizes by array index so HR can just reorder
// in the array and let the API assign 0..N-1.
export const TemplateTaskInputSchema = /* @__PURE__ */ (() => z.object({
  kind: TaskKindSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  order: z.number().int().nonnegative().optional(),
  dueOffsetDays: z.number().int().min(0).max(365).nullable().optional(),
}))();
export type TemplateTaskInput = z.infer<typeof TemplateTaskInputSchema>;

export const TemplateUpsertInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().min(1).max(80),
  track: OnboardingTrackSchema,
  // null = global template (applies to any client). UUID = client-scoped.
  clientId: UuidSchema.nullable(),
  // Full-replace semantics: this list IS the new task list. Empty
  // arrays are rejected (a checklist with no tasks is meaningless).
  tasks: z.array(TemplateTaskInputSchema).min(1).max(30),
}))();
export type TemplateUpsertInput = z.infer<typeof TemplateUpsertInputSchema>;

/* ===== Phase 62 — onboarding analytics ================================= */

// Distribution of completion days for the chosen population (whole org,
// one client, one track). Days are floats since hours matter at the low end
// of the curve. `sample` = how many completed applications fed the math
// (medianDays/p90Days are null when sample = 0).
export const OnboardingCompletionStatsSchema = /* @__PURE__ */ (() => z.object({
  medianDays: z.number().nullable(),
  p90Days: z.number().nullable(),
  sample: z.number().int().nonnegative(),
}))();
export type OnboardingCompletionStats = z.infer<
  typeof OnboardingCompletionStatsSchema
>;

export const OnboardingTrackBreakdownSchema = /* @__PURE__ */ (() => z.object({
  track: OnboardingTrackSchema,
  count: z.number().int().nonnegative(),
  medianDays: z.number().nullable(),
}))();
export type OnboardingTrackBreakdown = z.infer<
  typeof OnboardingTrackBreakdownSchema
>;

export const OnboardingClientBreakdownSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  clientName: z.string(),
  count: z.number().int().nonnegative(),
  medianDays: z.number().nullable(),
}))();
export type OnboardingClientBreakdown = z.infer<
  typeof OnboardingClientBreakdownSchema
>;

export const OnboardingMonthlyPointSchema = /* @__PURE__ */ (() => z.object({
  // YYYY-MM (UTC, inclusive of the whole month)
  month: z.string(),
  invited: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  /** Of the people invited this month, how many have finished (whenever they did) — a cohort rate that never passes 100%. */
  invitedCompleted: z.number().int().nonnegative().optional(),
}))();
export type OnboardingMonthlyPoint = z.infer<typeof OnboardingMonthlyPointSchema>;

export const OnboardingAnalyticsResponseSchema = /* @__PURE__ */ (() => z.object({
  // Lookback window in days for medianDays / p90Days / breakdown stats.
  windowDays: z.number().int().positive(),
  // Snapshot of all non-deleted applications by status.
  byStatus: z.record(z.number().int().nonnegative()),
  // Org-wide completion stats over the lookback window.
  completion: OnboardingCompletionStatsSchema,
  byTrack: z.array(OnboardingTrackBreakdownSchema),
  // Top N clients by application count over the lookback window.
  byClient: z.array(OnboardingClientBreakdownSchema),
  // Last 6 months of invited vs completed counts, oldest-first.
  monthly: z.array(OnboardingMonthlyPointSchema),
}))();
export type OnboardingAnalyticsResponse = z.infer<
  typeof OnboardingAnalyticsResponseSchema
>;

/* -------------------------------------------------------------------------- *
 *  Health
 * -------------------------------------------------------------------------- */

export const HealthResponseSchema = /* @__PURE__ */ (() => z.object({
  ok: z.boolean(),
  ts: z.string().datetime(),
}))();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Auth
 * -------------------------------------------------------------------------- */

// Keep in lockstep with ROLES in roles.ts — AuthUserSchema.role validates
// every /auth/me and login response against this enum.
export const RoleSchema = /* @__PURE__ */ (() => z.enum([
  'EXECUTIVE_CHAIRMAN',
  'HR_ADMINISTRATOR',
  'OPERATIONS_MANAGER',
  'LIVE_ASN',
  'ASSOCIATE',
  'CLIENT_PORTAL',
  'FINANCE_ACCOUNTANT',
  'INTERNAL_RECRUITER',
  'MANAGER',
  'WORKFORCE_MANAGER',
  'MARKETING_MANAGER',
  'SHIFT_SUPERVISOR',
  'FLOOR_SUPERVISOR',
  'TRANSPORTATION_DIRECTOR',
  'DRIVER',
]))();

export const UserStatusSchema = /* @__PURE__ */ (() => z.enum(['ACTIVE', 'DISABLED', 'INVITED']))();

export const EMAIL_LANGUAGES = ['en', 'es', 'tr'] as const;
export const EmailLanguageSchema = /* @__PURE__ */ (() => z.enum(EMAIL_LANGUAGES))();
export type EmailLanguage = z.infer<typeof EmailLanguageSchema>;
export const EMAIL_LANGUAGE_LABELS: Record<EmailLanguage, string> = {
  en: 'English',
  es: 'Español',
  tr: 'Türkçe',
};

export const AuthUserSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  email: z.string().email(),
  /** The role this account is WEARING right now. Everything downstream —
   *  capabilities, navigation, scope — keys off this and nothing else. */
  role: RoleSchema,
  /** The account's home role. Equal to `role` unless the person has
   *  switched hats (a shift supervisor driving a van today). */
  primaryRole: RoleSchema.optional(),
  /** Every role this account may switch to, primary first. Length 1 for
   *  almost everyone; the switcher only appears above that. */
  availableRoles: z.array(RoleSchema).optional(),
  status: UserStatusSchema,
  clientId: UuidSchema.nullable(),
  /** Display name of the bound client for client-scoped roles
   *  (SHIFT_SUPERVISOR, CLIENT_PORTAL) — the web pins pickers/scope bars
   *  to it instead of fetching a client list those roles can't read. */
  clientName: z.string().nullable().optional(),
  /** CLIENT_PORTAL store scope: one Location under clientId (a store
   *  manager) or null for the whole client (a market manager). */
  locationId: UuidSchema.nullable().optional(),
  locationName: z.string().nullable().optional(),
  /** CLIENT_PORTAL region scope: the command center for every store in the region. */
  regionId: UuidSchema.nullable().optional(),
  regionName: z.string().nullable().optional(),
  associateId: UuidSchema.nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  // Phase 39 — IANA timezone preference. Null means "use the browser's
  // locale" on the web side and "fall back to UTC" in email layout.
  timezone: z.string().nullable(),
  // Preferred language for the emails Alto sends this person. Null means
  // English. The app's language toggle and Settings both write it.
  language: EmailLanguageSchema.nullable().optional(),
  // Phase 47 — TOTP MFA. True iff the user has confirmed enrollment with
  // a valid 6-digit code. Drives the Settings card and (in a follow-up
  // PR) the login challenge step.
  mfaEnabled: z.boolean(),
  /** Brief 2-3 step 3: a custom role's capabilities (null = the built-in role's). */
  capabilities: z.array(z.string()).nullable().optional(),
  tenantRoleName: z.string().nullable().optional(),
}))();
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const LoginRequestSchema = /* @__PURE__ */ (() => z.object({
  email: z.string().email(),
  password: z.string().min(12),
}))();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Discriminated on `mfaRequired` so the client can branch without hunting
 * through optional fields. The MFA path returns no user — completing
 * sign-in requires a follow-up POST /auth/mfa-challenge with a code.
 */
export const LoginSuccessResponseSchema = /* @__PURE__ */ (() => z.object({
  mfaRequired: z.literal(false).optional(),
  user: AuthUserSchema,
}))();
export type LoginSuccessResponse = z.infer<typeof LoginSuccessResponseSchema>;

export const LoginMfaRequiredResponseSchema = /* @__PURE__ */ (() => z.object({
  mfaRequired: z.literal(true),
}))();
export type LoginMfaRequiredResponse = z.infer<typeof LoginMfaRequiredResponseSchema>;

/**
 * Org policy (OrgSetting.mfaRequirement) applies to this user's role but
 * they have no TOTP enrolled. The server issued a short-lived mfa_enroll
 * cookie accepted ONLY by the /auth/me/mfa/enroll/* endpoints; the client
 * drives the QR + confirm flow and receives a real session on confirm.
 */
export const LoginMfaEnrollRequiredResponseSchema = /* @__PURE__ */ (() => z.object({
  mfaEnrollmentRequired: z.literal(true),
}))();
export type LoginMfaEnrollRequiredResponse = z.infer<
  typeof LoginMfaEnrollRequiredResponseSchema
>;

export const LoginResponseSchema = /* @__PURE__ */ (() => z.union([
  LoginSuccessResponseSchema,
  LoginMfaRequiredResponseSchema,
  LoginMfaEnrollRequiredResponseSchema,
]))();
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Phase 32 — accept-invite returns the same shape as login PLUS a hint
 * for the client about where to send the freshly-activated user. For
 * new associates with an open onboarding application, this is their
 * checklist URL so they don't dead-end on the dashboard.
 */
export const AcceptInviteResponseSchema = /* @__PURE__ */ (() => z.object({
  user: AuthUserSchema,
  nextPath: z.string(),
}))();
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

export const MeResponseSchema = /* @__PURE__ */ (() => z.object({
  user: AuthUserSchema.nullable(),
  /** Brief 2-1b: the signed-in user's tenant profile (modules, terminology); null when anonymous. */
  tenant: TenantProfileSchema.extend({
    id: UuidSchema,
    /** What this tenant's team calls the assistant (OrgSetting.assistantName), so every screen can name it at once. */
    assistantName: z.string().min(1).max(60).optional(),
  }).nullable().optional(),
}))();
export type MeResponse = z.infer<typeof MeResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Onboarding — Phase 4 inputs and read-extras
 * -------------------------------------------------------------------------- */

// Roles HR can hire someone into via the onboarding flow. ASSOCIATE is the
// default. Management roles let HR onboard a new Operations / Workforce /
// Marketing manager etc. through the same magic-link + checklist pipeline.
// LIVE_ASN is excluded (system integration only) and CLIENT_PORTAL is
// excluded (provisioned through the client-admin path, not onboarding).
export const HIREABLE_ROLES = [
  'ASSOCIATE',
  'OPERATIONS_MANAGER',
  'MANAGER',
  'INTERNAL_RECRUITER',
  'WORKFORCE_MANAGER',
  'MARKETING_MANAGER',
  'FINANCE_ACCOUNTANT',
] as const;
export const HireableRoleSchema = /* @__PURE__ */ (() => z.enum(HIREABLE_ROLES))();
export type HireableRole = z.infer<typeof HireableRoleSchema>;

export const ApplicationCreateInputSchema = /* @__PURE__ */ (() => z.object({
  associateEmail: z.string().email(),
  associateFirstName: z.string().min(1).max(80),
  associateLastName: z.string().min(1).max(80),
  /** Brief 2-1b: optional — a direct employer hires with no client; the site (locationId) places them. */
  clientId: UuidSchema.optional(),
  // Phase 131 — physical site under the chosen client. Optional; when
  // set, becomes the starting Location of the AssociateAssignment row
  // opened at approval time. When omitted, HR will need to use the
  // Transfer button on the associate's profile after approval.
  locationId: UuidSchema.optional(),
  templateId: UuidSchema,
  position: z.string().min(1).max(120).optional(),
  startDate: z.string().datetime().optional(),
  employmentType: EmploymentTypeSchema.optional(),
  // Defaults to ASSOCIATE on the server when omitted. Set to a management
  // role to onboard a new manager / recruiter / accountant via the same
  // invite + checklist pipeline. Their User row is created with this role
  // so on first login they land in the correct sidebar / capability set.
  hireRole: HireableRoleSchema.optional(),
}))();
export type ApplicationCreateInput = z.infer<typeof ApplicationCreateInputSchema>;

/* ===== Phase 58 — bulk invite, bulk resend, nudge ====================== */

// One row in a bulk-invite batch. firstName/lastName fall back to email if HR
// pasted only addresses (parser will split on the local-part). The shared
// clientId/templateId/employmentType apply to every row in the batch.
export const BulkInviteApplicantSchema = /* @__PURE__ */ (() => z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  position: z.string().min(1).max(120).optional(),
  startDate: z.string().datetime().optional(),
}))();
export type BulkInviteApplicant = z.infer<typeof BulkInviteApplicantSchema>;

export const BulkInviteInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  templateId: UuidSchema,
  employmentType: EmploymentTypeSchema.optional(),
  /** Starting work site for the whole batch. Required (server-enforced)
   *  when the client has locations configured — a location-less invite
   *  leaves the associate's site unrecorded forever. */
  locationId: UuidSchema.optional(),
  applicants: z.array(BulkInviteApplicantSchema).min(1).max(200),
}))();
export type BulkInviteInput = z.infer<typeof BulkInviteInputSchema>;

// Per-applicant outcome — succeeded rows include an applicationId; failed
// rows include a stable error code + message so the UI can show why.
export const BulkInviteResultRowSchema = /* @__PURE__ */ (() => z.object({
  email: z.string().email(),
  ok: z.boolean(),
  applicationId: UuidSchema.nullable(),
  invitedUserId: UuidSchema.nullable(),
  inviteUrl: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}))();
export type BulkInviteResultRow = z.infer<typeof BulkInviteResultRowSchema>;

export const BulkInviteResponseSchema = /* @__PURE__ */ (() => z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkInviteResultRowSchema),
}))();
export type BulkInviteResponse = z.infer<typeof BulkInviteResponseSchema>;

export const BulkResendInputSchema = /* @__PURE__ */ (() => z.object({
  applicationIds: z.array(UuidSchema).min(1).max(200),
}))();
export type BulkResendInput = z.infer<typeof BulkResendInputSchema>;

export const BulkResendResultRowSchema = /* @__PURE__ */ (() => z.object({
  applicationId: UuidSchema,
  ok: z.boolean(),
  invitedUserId: UuidSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}))();
export type BulkResendResultRow = z.infer<typeof BulkResendResultRowSchema>;

export const BulkResendResponseSchema = /* @__PURE__ */ (() => z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkResendResultRowSchema),
}))();
export type BulkResendResponse = z.infer<typeof BulkResendResponseSchema>;

// Bulk approve — one shared hireDate for the whole batch. Deliberately NO
// acknowledgeWarnings passthrough: rows with verification gaps fail with
// `approval_warnings` so a human reviews each one individually — a bulk
// action must never blanket-acknowledge unverified hires.
export const BulkApproveInputSchema = /* @__PURE__ */ (() => z.object({
  applicationIds: z.array(UuidSchema).min(1).max(200),
  /** YYYY-MM-DD — same shape as the single-approve hireDate. */
  hireDate: z.string().date(),
}))();
export type BulkApproveInput = z.infer<typeof BulkApproveInputSchema>;

export const BulkApproveResultRowSchema = /* @__PURE__ */ (() => z.object({
  applicationId: UuidSchema,
  ok: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}))();
export type BulkApproveResultRow = z.infer<typeof BulkApproveResultRowSchema>;

export const BulkApproveResponseSchema = /* @__PURE__ */ (() => z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkApproveResultRowSchema),
}))();
export type BulkApproveResponse = z.infer<typeof BulkApproveResponseSchema>;

// HR-composed nudge email. Sent through the same Notification pipe as
// invites, but flagged with category = "onboarding.nudge" for filtering.
export const NudgeInputSchema = /* @__PURE__ */ (() => z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
}))();
export type NudgeInput = z.infer<typeof NudgeInputSchema>;

export const NudgeResponseSchema = /* @__PURE__ */ (() => z.object({
  ok: z.literal(true),
  recipientEmail: z.string().email(),
  notificationId: UuidSchema,
  emailSent: z.boolean(),
}))();
export type NudgeResponse = z.infer<typeof NudgeResponseSchema>;

export const ProfileSubmissionSchema = /* @__PURE__ */ (() => z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  // Both optional on Form I-9 but asked for by E-Verify. Collected here so
  // new hires arrive complete; people onboarded before these existed get
  // filled in from the E-Verify screen instead.
  middleInitial: z.string().trim().max(1).nullable().optional(),
  otherLastNames: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  dob: z.string().date().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  zip: z.string().max(10).nullable().optional(),
}))();
export type ProfileSubmission = z.infer<typeof ProfileSubmissionSchema>;

export const W4FilingStatusSchema = /* @__PURE__ */ (() => z.enum([
  'SINGLE',
  'MARRIED_FILING_JOINTLY',
  'HEAD_OF_HOUSEHOLD',
]))();

export const W4SubmissionInputSchema = /* @__PURE__ */ (() => z.object({
  filingStatus: W4FilingStatusSchema,
  multipleJobs: z.boolean().default(false),
  dependentsAmount: z.number().nonnegative().default(0),
  otherIncome: z.number().nonnegative().default(0),
  deductions: z.number().nonnegative().default(0),
  extraWithholding: z.number().nonnegative().default(0),
  ssn: z
    .string()
    .regex(/^\d{3}-?\d{2}-?\d{4}$/, 'SSN must be 9 digits (formatted ###-##-#### accepted)')
    .optional(),
}))();
export type W4SubmissionInput = z.infer<typeof W4SubmissionInputSchema>;

export const DirectDepositInputSchema = /* @__PURE__ */ (() => z.discriminatedUnion('type', [
  z.object({
    type: z.literal('BANK_ACCOUNT'),
    routingNumber: z.string().regex(/^\d{9}$/, 'Routing number must be 9 digits'),
    accountNumber: z.string().regex(/^\d{4,17}$/, 'Account number must be 4–17 digits'),
    accountType: z.enum(['CHECKING', 'SAVINGS']),
    // Institution name for the external payroll file. Optional so existing
    // clients and the Branch-card path keep working; the form asks for it
    // but an associate who leaves it blank still gets paid.
    bankName: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({
    type: z.literal('BRANCH_CARD'),
    branchCardId: z.string().min(1).max(80),
  }),
]))();
export type DirectDepositInput = z.infer<typeof DirectDepositInputSchema>;

export const PolicyAckInputSchema = /* @__PURE__ */ (() => z.object({
  policyId: UuidSchema,
}))();
export type PolicyAckInput = z.infer<typeof PolicyAckInputSchema>;

/* ===== Phase 63 — DOCUMENT_UPLOAD / BACKGROUND_CHECK / J1_DOCS ========= */

// Associate clicks "I'm done uploading" — server validates that at least
// one DocumentRecord exists for the associate in an ID-class kind, then
// marks the DOCUMENT_UPLOAD checklist task DONE. The actual file uploads
// go through the existing /documents/me/upload endpoint.
export const DocumentUploadCompleteResponseSchema = /* @__PURE__ */ (() => z.object({
  ok: z.literal(true),
  documentCount: z.number().int().nonnegative(),
}))();
export type DocumentUploadCompleteResponse = z.infer<
  typeof DocumentUploadCompleteResponseSchema
>;

// Associate authorizes the background check by typing their full legal
// name (acts as a wet-signature equivalent). Provider stays "stub" until
// Phase 64+ wires Checkr; status flips to PASSED immediately so the
// checklist can flow without a real third-party round-trip.
export const BackgroundCheckAuthorizeInputSchema = /* @__PURE__ */ (() => z.object({
  typedName: z.string().min(1).max(120),
  authorize: z.literal(true),
}))();
export type BackgroundCheckAuthorizeInput = z.infer<
  typeof BackgroundCheckAuthorizeInputSchema
>;

// Final marker: associate has filled out the J1 profile AND uploaded at
// least one J1_DS2019 / J1_VISA document. Server checks both before
// flipping the task DONE. The profile upsert itself reuses the existing
// J1UpsertInputSchema (Phase 10 compliance route) so HR + associate
// write the same shape.
export const J1DocsCompleteResponseSchema = /* @__PURE__ */ (() => z.object({
  ok: z.literal(true),
  hasProfile: z.boolean(),
  documentCount: z.number().int().nonnegative(),
}))();
export type J1DocsCompleteResponse = z.infer<typeof J1DocsCompleteResponseSchema>;

export const PolicyForApplicationSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  title: z.string(),
  version: z.string(),
  industry: z.string().nullable(),
  bodyUrl: z.string().nullable(),
  // Inline policy body (markdown). Renders in PolicyAckTask so the associate
  // actually reads what they're acknowledging.
  body: z.string().nullable(),
  acknowledged: z.boolean(),
  acknowledgedAt: z.string().datetime().nullable(),
}))();
export type PolicyForApplication = z.infer<typeof PolicyForApplicationSchema>;

export const ApplicationPoliciesResponseSchema = /* @__PURE__ */ (() => z.object({
  policies: z.array(PolicyForApplicationSchema),
}))();
export type ApplicationPoliciesResponse = z.infer<typeof ApplicationPoliciesResponseSchema>;

export const AuditLogEntrySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  action: z.string(),
  actorUserId: UuidSchema.nullable(),
  actorEmail: z.string().email().nullable(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).nullable(),
}))();
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogListResponseSchema = /* @__PURE__ */ (() => z.object({
  entries: z.array(AuditLogEntrySchema),
}))();
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 43 — Time-off entitlements (annual lump-sum + carryover cap)
 * -------------------------------------------------------------------------- */

export const TimeOffEntitlementSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  category: z.enum(['SICK', 'VACATION', 'PTO', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER']),
  annualMinutes: z.number().int().nonnegative(),
  carryoverMaxMinutes: z.number().int().nonnegative(),
  policyAnchorMonth: z.number().int().min(1).max(12),
  policyAnchorDay: z.number().int().min(1).max(31),
  lastGrantedAt: z.string().datetime().nullable(),
}))();
export type TimeOffEntitlement = z.infer<typeof TimeOffEntitlementSchema>;

export const TimeOffEntitlementListResponseSchema = /* @__PURE__ */ (() => z.object({
  entitlements: z.array(TimeOffEntitlementSchema),
}))();
export type TimeOffEntitlementListResponse = z.infer<typeof TimeOffEntitlementListResponseSchema>;

export const TimeOffEntitlementUpsertInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  category: z.enum(['SICK', 'VACATION', 'PTO', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER']),
  annualMinutes: z.number().int().nonnegative(),
  carryoverMaxMinutes: z.number().int().nonnegative(),
  policyAnchorMonth: z.number().int().min(1).max(12).default(1),
  policyAnchorDay: z.number().int().min(1).max(31).default(1),
}))();
export type TimeOffEntitlementUpsertInput = z.infer<typeof TimeOffEntitlementUpsertInputSchema>;

/**
 * The same policy, applied to a roster in one go.
 *
 * Entitlements are the only way most categories ever get a balance, and
 * they were created one associate at a time — so a client with two
 * hundred people meant two hundred trips through the form, and until
 * someone made all of them, those associates' time off could be
 * requested but never approved.
 */
export const TimeOffEntitlementBulkInputSchema = /* @__PURE__ */ (() => TimeOffEntitlementUpsertInputSchema.omit({
  associateId: true,
}).extend({
  associateIds: z.array(UuidSchema).min(1).max(500),
  /**
   * Leave an existing entitlement alone rather than rewriting it. On by
   * default: applying a company policy shouldn't silently overwrite the
   * negotiated exception someone set up for one person.
   */
  skipExisting: z.boolean().default(true),
}))();
export type TimeOffEntitlementBulkInput = z.infer<typeof TimeOffEntitlementBulkInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 42 — Benefits enrollment
 * -------------------------------------------------------------------------- */

export const BenefitsPlanKindSchema = /* @__PURE__ */ (() => z.enum([
  'HEALTH_MEDICAL',
  'DENTAL',
  'VISION',
  'HSA',
  'FSA_HEALTHCARE',
  'FSA_DEPENDENT_CARE',
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'LIFE_INSURANCE',
  'DISABILITY',
  'TRUMP_ACCOUNT',       // IRC §128 employer contribution — W-2 box 12 TA (2026+)
]))();
export type BenefitsPlanKind = z.infer<typeof BenefitsPlanKindSchema>;

export const BenefitsPlanSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  kind: BenefitsPlanKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  employerContributionCentsPerPeriod: z.number().int().nonnegative(),
  employeeContributionDefaultCentsPerPeriod: z.number().int().nonnegative(),
  isActive: z.boolean(),
  /** 401(k)/403(b): a higher earner's catch-up is made Roth automatically (SECURE 2.0 §603). */
  allowsDeemedRoth: z.boolean().optional(),
}))();
export type BenefitsPlan = z.infer<typeof BenefitsPlanSchema>;

export const BenefitsPlanListResponseSchema = /* @__PURE__ */ (() => z.object({
  plans: z.array(BenefitsPlanSchema),
}))();
export type BenefitsPlanListResponse = z.infer<typeof BenefitsPlanListResponseSchema>;

export const BenefitsPlanCreateInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  kind: BenefitsPlanKindSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  employerContributionCentsPerPeriod: z.number().int().nonnegative().default(0),
  employeeContributionDefaultCentsPerPeriod: z.number().int().nonnegative().default(0),
  allowsDeemedRoth: z.boolean().optional(),
}))();
export type BenefitsPlanCreateInput = z.infer<typeof BenefitsPlanCreateInputSchema>;

export const BenefitsPlanUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  employerContributionCentsPerPeriod: z.number().int().nonnegative().optional(),
  employeeContributionDefaultCentsPerPeriod: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
  allowsDeemedRoth: z.boolean().optional(),
}))();
export type BenefitsPlanUpdateInput = z.infer<typeof BenefitsPlanUpdateInputSchema>;

export const BenefitsEnrollmentSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  planId: UuidSchema,
  electedAmountCentsPerPeriod: z.number().int().nonnegative(),
  effectiveDate: z.string().date(),
  terminationDate: z.string().date().nullable(),
  // Joined plan summary so the UI can render without a second fetch.
  planKind: BenefitsPlanKindSchema,
  planName: z.string(),
  /** 401(k)/403(b): deferrals taken as designated Roth (after tax). */
  rothElection: z.boolean().optional(),
  /** Group-term life: the face amount, in cents. Over $50,000 the cost is imputed income (IRS Pub 15-B). */
  lifeCoverageCents: z.number().int().nonnegative().nullable().optional(),
}))();
export type BenefitsEnrollment = z.infer<typeof BenefitsEnrollmentSchema>;

/** The most group-term life coverage an election may carry: $5,000,000. */
export const MAX_LIFE_COVERAGE_CENTS = 500_000_000;

export const BenefitsEnrollmentListResponseSchema = /* @__PURE__ */ (() => z.object({
  enrollments: z.array(BenefitsEnrollmentSchema),
}))();
export type BenefitsEnrollmentListResponse = z.infer<typeof BenefitsEnrollmentListResponseSchema>;

export const BenefitsEnrollInputSchema = /* @__PURE__ */ (() => z.object({
  planId: UuidSchema,
  electedAmountCentsPerPeriod: z.number().int().nonnegative(),
  effectiveDate: z.string().date(),
  rothElection: z.boolean().optional(),
  /** LIFE_INSURANCE only (required there): the coverage face amount, in whole dollars' cents, $1,000 to $5,000,000. */
  lifeCoverageCents: z.number().int().min(100_000).max(MAX_LIFE_COVERAGE_CENTS).optional(),
}))();
export type BenefitsEnrollInput = z.infer<typeof BenefitsEnrollInputSchema>;

export const BenefitsTerminateInputSchema = /* @__PURE__ */ (() => z.object({
  terminationDate: z.string().date(),
}))();
export type BenefitsTerminateInput = z.infer<typeof BenefitsTerminateInputSchema>;

/* ----- Phase 40 — global audit search (with entity context) ------------ */

export const AuditSearchEntrySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  action: z.string(),
  actorUserId: UuidSchema.nullable(),
  actorEmail: z.string().email().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  clientId: UuidSchema.nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
}))();
export type AuditSearchEntry = z.infer<typeof AuditSearchEntrySchema>;

export const AuditSearchResponseSchema = /* @__PURE__ */ (() => z.object({
  entries: z.array(AuditSearchEntrySchema),
  /** Cursor — pass back via `before` to fetch the next page. Null = end. */
  nextBefore: z.string().datetime().nullable(),
}))();
export type AuditSearchResponse = z.infer<typeof AuditSearchResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Time & Attendance — Phase 6
 * -------------------------------------------------------------------------- */

export const TimeEntryStatusSchema = /* @__PURE__ */ (() => z.enum([
  'ACTIVE',
  'COMPLETED',
  'APPROVED',
  'REJECTED',
]))();
export type TimeEntryStatus = z.infer<typeof TimeEntryStatusSchema>;

export const TimeEntrySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string().nullable(),
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  clockInAt: z.string().datetime(),
  clockOutAt: z.string().datetime().nullable(),
  status: TimeEntryStatusSchema,
  notes: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  approvedById: UuidSchema.nullable(),
  approverEmail: z.string().email().nullable(),
  approvedAt: z.string().datetime().nullable(),
  /** Server-computed convenience: minutes between clockInAt and clockOutAt (or now() if ACTIVE). */
  minutesElapsed: z.number().int().nonnegative(),
  // Phase 15 additions — all nullable so older entries serialize cleanly.
  jobId: UuidSchema.nullable().optional(),
  jobName: z.string().nullable().optional(),
  payRate: z.number().nullable().optional(),
  clockInLat: z.number().nullable().optional(),
  clockInLng: z.number().nullable().optional(),
  clockOutLat: z.number().nullable().optional(),
  clockOutLng: z.number().nullable().optional(),
  anomalies: z.array(z.string()).optional(),
  /** IANA timezone of the entry's worksite (Location.timezone). Lets the
   *  review queue render punch times on the SITE's wall clock instead of
   *  the reviewer's browser clock — the two disagreeing (and the timesheet
   *  using a third, hardcoded zone) is exactly what users reported as
   *  'the clock-in times don't match'. Null for entries with no location. */
  locationTimezone: z.string().nullable().optional(),
  /** True while the entry is ACTIVE and a break row is open. Server-derived;
   *  lets the clock widget survive a page refresh mid-break instead of
   *  guessing from client-local state. */
  onBreak: z.boolean().optional(),
  /** Worked minutes NET of breaks — the figure payroll, OT detection, and
   *  sick accrual actually use. minutesElapsed stays gross
   *  (clock-in → clock-out); showing only gross made approvals disagree
   *  with what payroll pays. */
  netMinutes: z.number().int().nonnegative().optional(),
  /** Break rows, so reviewers can SEE why net ≠ gross (and spot a bogus
   *  3-hour "meal" before approving it). */
  breaks: z
    .array(
      z.object({
        id: UuidSchema,
        type: z.string(),
        startedAt: z.string().datetime(),
        endedAt: z.string().datetime().nullable(),
        minutes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  /** Punch↔shift link — the scheduled shift this entry fulfills, matched
   *  automatically at clock-in (nearest assigned shift whose window covers
   *  the punch). Null on unscheduled punches and entries that pre-date the
   *  link. shiftStartsAt/shiftPosition are denormalized so reviewers can
   *  compare actual vs scheduled without another fetch. */
  shiftId: UuidSchema.nullable().optional(),
  shiftStartsAt: z.string().datetime().nullable().optional(),
  shiftEndsAt: z.string().datetime().nullable().optional(),
  shiftPosition: z.string().nullable().optional(),
  /**
   * This entry's share of the labor-rules engine's split — the same split
   * the paycheck pays (server lib/laborRules/hours): regular, overtime and
   * double-time minutes, over the person's whole workweek at every client
   * and site (overtime is the latest hours). Counts COMPLETED and ACTIVE
   * time as if approved. Absent on REJECTED entries and older servers.
   */
  hours: z
    .object({
      regularMinutes: z.number().nonnegative(),
      overtimeMinutes: z.number().nonnegative(),
      doubleTimeMinutes: z.number().nonnegative(),
      overtimeMultiplier: z.number().positive(),
      doubleMultiplier: z.number().positive(),
    })
    .optional(),
}))();
export type TimeEntry = z.infer<typeof TimeEntrySchema>;

export const TimeEntryListResponseSchema = /* @__PURE__ */ (() => z.object({
  entries: z.array(TimeEntrySchema),
  /** True when the server's row cap cut the result — the UI should say so
   *  instead of letting a partial list masquerade as the whole window. */
  truncated: z.boolean().optional(),
}))();
export type TimeEntryListResponse = z.infer<typeof TimeEntryListResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Walk-in clock-in requests — kiosk punches the schedule gate refused,
 *  parked for a supervisor to approve (backdated ACTIVE entry) or deny.
 * -------------------------------------------------------------------------- */

export const ClockInRequestStatusSchema = /* @__PURE__ */ (() => z.enum(['PENDING', 'APPROVED', 'DENIED']))();
export type ClockInRequestStatus = z.infer<typeof ClockInRequestStatusSchema>;

export const ClockInRequestRowSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  clientId: UuidSchema,
  clientName: z.string().nullable(),
  locationId: UuidSchema.nullable(),
  locationName: z.string().nullable(),
  /** The refused punch instant — what an approval backdates the entry to. */
  requestedAt: z.string().datetime(),
  status: ClockInRequestStatusSchema,
  decidedAt: z.string().datetime().nullable(),
  deciderEmail: z.string().nullable(),
  denyReason: z.string().nullable(),
}))();
export type ClockInRequestRow = z.infer<typeof ClockInRequestRowSchema>;

export const ClockInRequestListResponseSchema = /* @__PURE__ */ (() => z.object({
  requests: z.array(ClockInRequestRowSchema),
}))();
export type ClockInRequestListResponse = z.infer<
  typeof ClockInRequestListResponseSchema
>;

export const ClockInRequestDenyInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().trim().max(300).optional(),
}))();
export type ClockInRequestDenyInput = z.infer<typeof ClockInRequestDenyInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Attendance points — rolling 90-day reliability score from late/early/
 *  no-show signals. Excused events stay visible but score zero.
 * -------------------------------------------------------------------------- */

export const AttendanceKindSchema = /* @__PURE__ */ (() => z.enum([
  'LATE',
  'EARLY_OUT',
  'CALL_OUT',
  'NO_CALL_NO_SHOW',
]))();
export type AttendanceKind = z.infer<typeof AttendanceKindSchema>;

export const AttendanceEventSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  shiftId: UuidSchema.nullable(),
  kind: AttendanceKindSchema,
  points: z.number(),
  occurredOn: z.string(),
  source: z.string(),
  note: z.string().nullable(),
  excused: z.boolean(),
  excusedByEmail: z.string().nullable(),
}))();
export type AttendanceEvent = z.infer<typeof AttendanceEventSchema>;

export const AttendanceListResponseSchema = /* @__PURE__ */ (() => z.object({
  events: z.array(AttendanceEventSchema),
  /** Unexcused points inside the rolling 90-day window. */
  score: z.number(),
  windowDays: z.number().int(),
}))();
export type AttendanceListResponse = z.infer<typeof AttendanceListResponseSchema>;

export const ClockInInputSchema = /* @__PURE__ */ (() => z.object({
  notes: z.string().max(500).optional(),
}))();
export type ClockInInput = z.infer<typeof ClockInInputSchema>;

export const ClockOutInputSchema = /* @__PURE__ */ (() => z.object({
  notes: z.string().max(500).optional(),
}))();
export type ClockOutInput = z.infer<typeof ClockOutInputSchema>;

export const TimeApproveInputSchema = /* @__PURE__ */ (() => z.object({
  /** Optional override of clockInAt/clockOutAt during approval (e.g., HR fixes a forgotten clock-out). */
  clockInAt: z.string().datetime().optional(),
  clockOutAt: z.string().datetime().optional(),
}))();
export type TimeApproveInput = z.infer<typeof TimeApproveInputSchema>;

export const TimeRejectInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().min(1).max(500),
}))();
export type TimeRejectInput = z.infer<typeof TimeRejectInputSchema>;

/* ===== Admin clock-in/out + edit on behalf of an associate ============== */

/**
 * Create a time entry for an associate (HR fixes a missed kiosk punch, or
 * logs a shift after the fact). Omit clockOutAt to "clock them in" — an
 * ACTIVE entry; supply it to log a completed shift. Admin-only.
 */
export const AdminCreateTimeEntryInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  jobId: UuidSchema.nullable().optional(),
  clockInAt: z.string().datetime(),
  clockOutAt: z.string().datetime().nullable().optional(),
  /** Recorded hourly rate on the entry (display/reporting). Overrides the
   *  job-derived rate when supplied. Does NOT drive payroll — that pays from
   *  the scheduled shift / compensation record. */
  payRate: z.number().nonnegative().max(100000).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
}))();
export type AdminCreateTimeEntryInput = z.infer<
  typeof AdminCreateTimeEntryInputSchema
>;

/**
 * Edit a time entry before it's approved (fix clock times, attach notes,
 * re-tag a job, or clock someone out by supplying clockOutAt on an ACTIVE
 * entry). Rejected once the entry is APPROVED. Admin-only.
 */
export const AdminEditTimeEntryInputSchema = /* @__PURE__ */ (() => z
  .object({
    clockInAt: z.string().datetime().optional(),
    clockOutAt: z.string().datetime().nullable().optional(),
    jobId: UuidSchema.nullable().optional(),
    /** Recorded hourly rate on the entry (display/reporting). null clears it.
     *  Does NOT drive payroll. */
    payRate: z.number().nonnegative().max(100000).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to change.',
  }))();
export type AdminEditTimeEntryInput = z.infer<
  typeof AdminEditTimeEntryInputSchema
>;

export const ActiveTimeEntryResponseSchema = /* @__PURE__ */ (() => z.object({
  active: TimeEntrySchema.nullable(),
}))();
export type ActiveTimeEntryResponse = z.infer<typeof ActiveTimeEntryResponseSchema>;

/* ===== Phase 64 — bulk approve/reject for time entries ================= */

export const BulkTimeApproveInputSchema = /* @__PURE__ */ (() => z.object({
  entryIds: z.array(UuidSchema).min(1).max(200),
}))();
export type BulkTimeApproveInput = z.infer<typeof BulkTimeApproveInputSchema>;

export const BulkTimeRejectInputSchema = /* @__PURE__ */ (() => z.object({
  entryIds: z.array(UuidSchema).min(1).max(200),
  reason: z.string().min(1).max(500),
}))();
export type BulkTimeRejectInput = z.infer<typeof BulkTimeRejectInputSchema>;

export const BulkTimeResultRowSchema = /* @__PURE__ */ (() => z.object({
  entryId: UuidSchema,
  ok: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}))();
export type BulkTimeResultRow = z.infer<typeof BulkTimeResultRowSchema>;

export const BulkTimeResponseSchema = /* @__PURE__ */ (() => z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkTimeResultRowSchema),
}))();
export type BulkTimeResponse = z.infer<typeof BulkTimeResponseSchema>;

/* Phase 65 — time entry exports (CSV + PDF) ================================ */
// Mirrors ScheduleExportInputSchema. `to` is end-EXCLUSIVE so the same range
// helpers can be reused on the front end.

export const TimeExportInputSchema = /* @__PURE__ */ (() => z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  status: TimeEntryStatusSchema.optional(),
  clientId: UuidSchema.optional(),
  /** Facility scope — filter to a single worksite Location. */
  locationId: UuidSchema.optional(),
  associateId: UuidSchema.optional(),
  /**
   * Free-text associate-name filter, same semantics as the admin queue's
   * `search`. Without it the queue could be narrowed on screen while the
   * download still returned every associate in the range.
   */
  search: z.string().trim().min(1).max(100).optional(),
  /**
   * Restrict to entries carrying at least one anomaly flag, matching the
   * queue's "Anomalies only" toggle. Applied server-side across the whole
   * range, so the file isn't limited to the page the screen had loaded.
   */
  anomaliesOnly: z.boolean().optional(),
  /**
   * Shift-window lens, mirroring the queue's "Shift" filter. Either "none"
   * (entries with no matched shift) or "<startMin>-<endMin>" — the matched
   * shift's start/end as minutes-from-midnight in the SITE's timezone (UTC
   * when the location has none), so Monday's and Tuesday's 6–2 are one
   * window and DST weeks don't split into two.
   */
  shiftWindow: z
    .string()
    .regex(/^(none|\d{1,4}-\d{1,4})$/)
    .optional(),
}))();
export type TimeExportInput = z.infer<typeof TimeExportInputSchema>;

/* -------------------------------------------------------------------------- *
 *  External payroll sheet — the handoff file for an outside payroll bureau.
 *
 *  Deliberately a narrower input than TimeExportInput: no `search`, no
 *  `anomaliesOnly`, no status filter. This sheet is always "approved time in
 *  a date range", because a bureau file that quietly omitted people or
 *  included unapproved hours would be paid out wrong. Scope is client /
 *  location / associate only.
 * -------------------------------------------------------------------------- */

export const ExternalPayrollSheetInputSchema = /* @__PURE__ */ (() => z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  clientId: UuidSchema.optional(),
  locationId: UuidSchema.optional(),
  associateId: UuidSchema.optional(),
  // Unverified financial changes block the packet until the person
  // downloading it acknowledges each one by id; the acknowledgment is
  // recorded on the change and on the download.
  acknowledgeChangeIds: z.array(UuidSchema).max(500).optional(),
}))();

/* -------------------------------------------------------------------------- *
 *  Financial changes — the Finance queue.
 * -------------------------------------------------------------------------- */

export const FinancialChangeKindSchema = /* @__PURE__ */ (() => z.enum([
  'BANK_ACCOUNT',
  'PAY_CARD',
  'PAY_METHOD',
  'W4',
  'LEGAL_NAME',
  'SSN',
  'HOME_ADDRESS',
]))();
export type FinancialChangeKind = z.infer<typeof FinancialChangeKindSchema>;
export const FinancialChangeStatusSchema = /* @__PURE__ */ (() => z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'HELD']))();
export type FinancialChangeStatus = z.infer<typeof FinancialChangeStatusSchema>;

export const FinancialChangeRowSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associate: z.object({ id: UuidSchema, name: z.string() }),
  kind: FinancialChangeKindSchema,
  kindLabel: z.string(),
  source: z.enum(['SELF', 'ADMIN', 'ONBOARDING']),
  onBehalf: z.boolean(),
  actor: z.object({ id: UuidSchema, name: z.string().nullable(), role: z.string().nullable() }).nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  authStrength: z.string(),
  oldSummary: z.string().nullable(),
  newSummary: z.string().nullable(),
  riskFlags: z.array(z.string()),
  riskLabels: z.array(z.string()),
  riskScore: z.number(),
  highRisk: z.boolean(),
  status: FinancialChangeStatusSchema,
  verifyPhoneLast4: z.string().nullable(),
  verifiedBy: z.object({ id: UuidSchema, name: z.string().nullable() }).nullable(),
  verifiedAt: z.string().nullable(),
  verifiedVia: z.string().nullable(),
  verificationNote: z.string().nullable(),
  financeNotifiedAt: z.string().nullable(),
  associateNotifiedAt: z.string().nullable(),
  priorContactNotifiedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  createdAt: z.string(),
}))();
export type FinancialChangeRow = z.infer<typeof FinancialChangeRowSchema>;

export const VerifyFinancialChangeInputSchema = /* @__PURE__ */ (() => z.object({
  via: z.enum(['PHONE_CALL', 'IN_PERSON', 'OTHER']),
  note: z.string().trim().max(1000).optional().nullable(),
  reachedOnNumberOnFile: z.literal(true),
}))();
export type VerifyFinancialChangeInput = z.infer<typeof VerifyFinancialChangeInputSchema>;

export const UnverifiedPayoutPolicySchema = /* @__PURE__ */ (() => z.enum(['PREVIOUS_VERIFIED', 'HOLD']))();
export type UnverifiedPayoutPolicy = z.infer<typeof UnverifiedPayoutPolicySchema>;
export const UNVERIFIED_PAYOUT_POLICY_LABELS: Record<UnverifiedPayoutPolicy, string> = {
  PREVIOUS_VERIFIED: 'Pay the previous verified account',
  HOLD: 'Hold the pay until Finance verifies',
};
export type ExternalPayrollSheetInput = z.infer<
  typeof ExternalPayrollSheetInputSchema
>;

/**
 * Counts of what couldn't be filled in, returned as response headers so the
 * UI can warn BEFORE the file is sent to a bureau. A blank SSN or routing
 * number in a payroll file is a rejected submission or an unpaid worker, and
 * the failure is invisible in a spreadsheet with hundreds of rows.
 */
export const ExternalPayrollSheetGapsSchema = /* @__PURE__ */ (() => z.object({
  /** Rows with no W-4 on file at all. */
  missingW4: z.number().int().nonnegative(),
  /** W-4 exists but the SSN ciphertext won't decrypt under the current key. */
  unreadableSsn: z.number().int().nonnegative(),
  /** No payout method, or a card rather than a bank account. */
  missingBankDetails: z.number().int().nonnegative(),
  /** No current compensation record — pay rate is blank. */
  missingPayRate: z.number().int().nonnegative(),
}))();
export type ExternalPayrollSheetGaps = z.infer<
  typeof ExternalPayrollSheetGapsSchema
>;

/* -------------------------------------------------------------------------- *
 *  Timesheets — Fieldglass-shaped weekly export (Saturday → Friday)
 *
 *  Mirrors the SAP Fieldglass group timesheet list a buyer sees: one row per
 *  worker per week, keyed by the week-ending Friday, hours split across the
 *  ST / OT / DT / Others / NB buckets. Per the current SOW every worked hour
 *  lands in "Others" with no overtime split; the other buckets are 0. Hours
 *  are NET of unpaid breaks and approved-only.
 * -------------------------------------------------------------------------- */

export const TimesheetWeekInputSchema = /* @__PURE__ */ (() => z.object({
  /** Any ISO instant inside the desired Sat–Fri week; the server snaps to it. */
  weekStart: z.string().datetime(),
  /** Restrict to one client for per-Fieldglass filing. Omit for all clients. */
  clientId: UuidSchema.optional(),
}))();
export type TimesheetWeekInput = z.infer<typeof TimesheetWeekInputSchema>;

export const TimesheetRowStatusSchema = /* @__PURE__ */ (() => z.enum(['READY', 'PENDING']))();
export type TimesheetRowStatus = z.infer<typeof TimesheetRowStatusSchema>;

/** A worker's timesheet as Fieldglass has it — the desk's tracking. */
export const FieldglassStatusSchema = /* @__PURE__ */ (() => z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'INVOICED']))();
export type FieldglassStatus = z.infer<typeof FieldglassStatusSchema>;

export const TimesheetFieldglassSchema = /* @__PURE__ */ (() => z.object({
  /** Registered in Fieldglass under this row's client. */
  registered: z.boolean(),
  /** The Fieldglass Worker ID, when finance recorded it. */
  workerId: z.string().nullable(),
  /** Alto entered this week into Fieldglass — when, by whom, at how many hours. */
  enteredAt: z.string().nullable(),
  enteredBy: z.string().nullable(),
  enteredHours: z.number().nullable(),
  /** From the imported Fieldglass list: its status, timesheet ID, revision, hours. */
  status: FieldglassStatusSchema.nullable(),
  timesheetId: z.string().nullable(),
  revision: z.number().int().nullable(),
  hours: z.number().nullable(),
  syncedAt: z.string().nullable(),
  /** The buyer's comment on it (a rejection reason), from the import. */
  comment: z.string().nullable().optional(),
  /** A rejected timesheet fixed and sent back — when. */
  resubmittedAt: z.string().nullable().optional(),
  /** Finance's own note on this week. */
  note: z.string().nullable().optional(),
}))();
export type TimesheetFieldglass = z.infer<typeof TimesheetFieldglassSchema>;

export const TimesheetRowSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  /** The client (Fieldglass SOW) this row bills to; null for client-less time. */
  clientId: UuidSchema.nullable().optional(),
  /** "Last, First" — matches the Fieldglass Worker column. */
  worker: z.string(),
  /** Worksite / client label, shown in the Fieldglass Site column. */
  site: z.string(),
  st: z.number().nonnegative(),
  ot: z.number().nonnegative(),
  dt: z.number().nonnegative(),
  others: z.number().nonnegative(),
  nb: z.number().nonnegative(),
  total: z.number().nonnegative(),
  /** READY = all of this worker's week is approved; PENDING = some awaits review. */
  status: TimesheetRowStatusSchema,
  /** Where this worker's week stands in Fieldglass (null: no client). */
  fieldglass: TimesheetFieldglassSchema.nullable().optional(),
  /**
   * How the paycheck splits these approved hours (server lib/laborRules/hours,
   * over the worker's whole week at every client): regular, overtime and
   * double time. Informational — the ST/OT/DT/Others buckets above follow the
   * buyer's SOW (flat "Others" today), the way a statement bills overtime by
   * the client's contract.
   */
  payHours: z
    .object({ regular: z.number().nonnegative(), overtime: z.number().nonnegative(), doubleTime: z.number().nonnegative() })
    .optional(),
}))();
export type TimesheetRow = z.infer<typeof TimesheetRowSchema>;

/* Per-associate day detail — the "Time in / time out" grid a Fieldglass
 * individual timesheet shows when you click a worker: one column per day
 * (Sat→Fri) with the clock-in, meal breaks, clock-out, and net total. */
export const TimesheetAssociateDetailInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  weekStart: z.string().datetime(),
  clientId: UuidSchema.optional(),
}))();
export type TimesheetAssociateDetailInput = z.infer<
  typeof TimesheetAssociateDetailInputSchema
>;

export const TimesheetDaySchema = /* @__PURE__ */ (() => z.object({
  /** YYYY-MM-DD (store-local). */
  date: z.string(),
  /** "Sat", "Sun", … */
  weekday: z.string(),
  /** "7/11" — month/day, no leading zeros. */
  monthDay: z.string(),
  /** Earliest clock-in that day, store-local ("10:00 PM"); null = no work. */
  timeIn: z.string().nullable(),
  /** Latest clock-out that day, store-local ("7:00 AM"); null = still open/none. */
  timeOut: z.string().nullable(),
  /** Meal/rest breaks, pre-formatted ("3:00 AM – 4:00 AM (1h)"). */
  breaks: z.array(z.string()),
  /** Net worked hours for the day (breaks excluded). */
  netHours: z.number().nonnegative(),
  /** The shift name each approved entry fulfilled, in clock-in order —
   *  null = the punch matched no scheduled shift (walk-in / manual). */
  shifts: z.array(z.string().nullable()).optional(),
  /** True when any entry crossed midnight — the "in Fri 10 PM, out Sat
   *  7 AM under Friday" convention, made explicit for reviewers. */
  overnight: z.boolean().optional(),
}))();
export type TimesheetDay = z.infer<typeof TimesheetDaySchema>;

export const TimesheetAssociateDetailResponseSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  worker: z.string(),
  site: z.string(),
  weekStart: z.string(),
  weekEndIso: z.string(),
  weekEnding: z.string(),
  /** "07/11/2026 to 07/17/2026" — matches the Fieldglass Period field. */
  periodLabel: z.string(),
  days: z.array(TimesheetDaySchema).length(7),
  totalHours: z.number().nonnegative(),
  status: TimesheetRowStatusSchema,
  pendingCount: z.number().int().nonnegative(),
  /* Accounting block (Fieldglass "Accounting (USD)"). */
  /** Rate label, e.g. "Standard Hourly Rate /Hr". */
  rateLabel: z.string(),
  /** Associate's hourly pay rate from their open comp record. Null when
   *  none exists — rendered as a dash. (Used to silently default to $15,
   *  a fabricated figure on a billing-adjacent document.) */
  payRate: z.number().nonnegative().nullable(),
  /** Client bill rate ($/hr); null when the client has none set. */
  billRate: z.number().nonnegative().nullable(),
  /** billRate × totalHours; null when no bill rate is set. */
  amount: z.number().nonnegative().nullable(),
  timeZone: z.string(),
  generatedAt: z.string(),
}))();
export type TimesheetAssociateDetailResponse = z.infer<
  typeof TimesheetAssociateDetailResponseSchema
>;

/* Pre-file validation — problems worth fixing before a week is filed into
 * Fieldglass. Surfaced on the grid so bad/incomplete data never ships. */
export const TimesheetIssueKindSchema = /* @__PURE__ */ (() => z.enum([
  'MISSING_CLOCKOUT', // an entry never clocked out (still ACTIVE)
  'PENDING_APPROVAL', // approved-only hours ship; these await approval
  'OVER_HOURS', // implausibly high weekly total — review before filing
  'NOT_IN_FIELDGLASS', // hours for a worker not registered under that client — unbillable until added
]))();
export type TimesheetIssueKind = z.infer<typeof TimesheetIssueKindSchema>;

export const TimesheetIssueSchema = /* @__PURE__ */ (() => z.object({
  kind: TimesheetIssueKindSchema,
  associateId: z.string().nullable(),
  worker: z.string(),
  detail: z.string(),
}))();
export type TimesheetIssue = z.infer<typeof TimesheetIssueSchema>;

/* Scheduled-vs-actual — published assigned-shift hours next to hours actually
 * worked, so no-shows and big overages surface before they hit the bill. */
export const TimesheetScheduleRowSchema = /* @__PURE__ */ (() => z.object({
  associateId: z.string(),
  worker: z.string(),
  scheduledHours: z.number().nonnegative(),
  actualHours: z.number().nonnegative(),
  /** actualHours − scheduledHours (negative = under-worked / no-show). */
  delta: z.number(),
}))();
export type TimesheetScheduleRow = z.infer<typeof TimesheetScheduleRowSchema>;

/* Lock + drift — a recorded filing snapshots per-worker hours; if the
 * underlying time changes afterward, the difference surfaces as drift. */
export const TimesheetDriftRowSchema = /* @__PURE__ */ (() => z.object({
  associateId: z.string(),
  worker: z.string(),
  filedHours: z.number().nonnegative(),
  currentHours: z.number().nonnegative(),
  /** currentHours − filedHours. */
  delta: z.number(),
}))();
export type TimesheetDriftRow = z.infer<typeof TimesheetDriftRowSchema>;

export const TimesheetFilingInfoSchema = /* @__PURE__ */ (() => z.object({
  filedAt: z.string(),
  /** Who filed it (email/name); null if the user record is gone. */
  filedBy: z.string().nullable(),
  /** Total hours captured at filing time. */
  filedTotalHours: z.number().nonnegative(),
  /** Workers whose hours changed since filing (empty = still in sync). */
  drift: z.array(TimesheetDriftRowSchema),
}))();
export type TimesheetFilingInfo = z.infer<typeof TimesheetFilingInfoSchema>;

export const TimesheetWeekResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Saturday that starts the week, YYYY-MM-DD (store-local). */
  weekStart: z.string(),
  /** Friday that ends the week, YYYY-MM-DD (store-local) — the Fieldglass "End". */
  weekEndIso: z.string(),
  /** Same Friday, MM/DD/YYYY for display/paste. */
  weekEnding: z.string(),
  rows: z.array(TimesheetRowSchema),
  /** Approved rows total; how many worked hours across the week. */
  totalHours: z.number().nonnegative(),
  /** COMPLETED-but-unapproved entries in the week — the sheet is provisional. */
  pendingCount: z.number().int().nonnegative(),
  /** Pre-file problems (missing clock-out, pending approval, over-hours). */
  issues: z.array(TimesheetIssueSchema),
  /** Published-schedule vs actual-worked hours per worker (union of both). */
  scheduleComparison: z.array(TimesheetScheduleRowSchema),
  /** Filing record for this week, with drift since — null if never filed. */
  filing: TimesheetFilingInfoSchema.nullable(),
  /** The week in Fieldglass: the deadline, entry progress, buyer statuses,
   *  and — scoped to one client with a bill rate — the money. */
  fieldglass: z
    .object({
      /** When the week's timesheets are due in Fieldglass. */
      dueAt: z.string(),
      /** Rows that bill to a client. */
      workers: z.number().int().nonnegative(),
      entered: z.number().int().nonnegative(),
      notRegistered: z.number().int().nonnegative(),
      submitted: z.number().int().nonnegative(),
      approved: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      /** Rows whose Fieldglass hours differ from Alto's. */
      variances: z.number().int().nonnegative(),
      /** When the buyer's list was last imported. */
      syncedAt: z.string().nullable(),
      /** One client with a bill rate: approved (billable now), awaiting
       *  (entered or submitted, not approved), at risk (not registered,
       *  rejected, or not entered). Null otherwise, and never for a
       *  store-bound role. */
      money: z
        .object({
          billRate: z.number().nonnegative(),
          approved: z.number().nonnegative(),
          awaiting: z.number().nonnegative(),
          atRisk: z.number().nonnegative(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  timeZone: z.string(),
  generatedAt: z.string(),
}))();
export type TimesheetWeekResponse = z.infer<typeof TimesheetWeekResponseSchema>;

/* One associate's whole timesheet, across pay periods — every Sat→Fri week
 * they worked, grouped into the pay periods that paid them, each with its
 * day grid and where it stands in Fieldglass. */
export const TimesheetHistoryWeekSchema = /* @__PURE__ */ (() => z.object({
  /** Saturday, YYYY-MM-DD (store-local). */
  weekStart: z.string(),
  /** Friday, YYYY-MM-DD. */
  weekEnd: z.string(),
  /** MM/DD/YYYY — the Fieldglass End. */
  weekEnding: z.string(),
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  site: z.string(),
  days: z.array(TimesheetDaySchema).length(7),
  /** Approved hours — what's billed. */
  total: z.number().nonnegative(),
  /** Worked but not approved yet — not in `total`. */
  pendingHours: z.number().nonnegative(),
  /** The week isn't over yet. */
  inProgress: z.boolean(),
  /** When it's due in Fieldglass, and whether that passed with it not entered. */
  dueAt: z.string(),
  overdue: z.boolean(),
  fieldglass: TimesheetFieldglassSchema.nullable(),
  /** total × bill rate; null for a store-bound viewer or no rate. */
  amount: z.number().nonnegative().nullable(),
}))();
export type TimesheetHistoryWeek = z.infer<typeof TimesheetHistoryWeekSchema>;

export const TimesheetHistoryPeriodSchema = /* @__PURE__ */ (() => z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  /** Null when no pay schedule is set up (the period is then the week). */
  payDate: z.string().nullable(),
  weeks: z.array(TimesheetHistoryWeekSchema),
  total: z.number().nonnegative(),
  pendingHours: z.number().nonnegative(),
  amount: z.number().nonnegative().nullable(),
}))();
export type TimesheetHistoryPeriod = z.infer<typeof TimesheetHistoryPeriodSchema>;

export const TimesheetHistoryResponseSchema = /* @__PURE__ */ (() => z.object({
  associate: z.object({
    id: UuidSchema,
    name: z.string(),
    /** "Last, First" — the Fieldglass Worker column. */
    worker: z.string(),
    photoUrl: z.string().nullable(),
    clientName: z.string().nullable(),
    position: z.string().nullable(),
    workerId: z.string().nullable(),
    registeredAt: z.string().nullable(),
    firstClockIn: z.object({ date: z.string(), time: z.string() }).nullable(),
    lastWorked: z.string().nullable(),
    /** Finance only — built from PII, and audited. */
    securityId: z.string().nullable(),
  }),
  schedule: z.object({ name: z.string(), frequency: z.string() }).nullable(),
  /** Newest first. */
  periods: z.array(TimesheetHistoryPeriodSchema),
  totals: z.object({
    hours: z.number().nonnegative(),
    weeks: z.number().int().nonnegative(),
    avgWeekHours: z.number().nonnegative(),
    year: z.number().int(),
    yearHours: z.number().nonnegative(),
    pendingHours: z.number().nonnegative(),
    fieldglass: z.object({
      approved: z.number().int().nonnegative(),
      awaiting: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      toEnter: z.number().int().nonnegative(),
      overdue: z.number().int().nonnegative(),
      notRegistered: z.number().int().nonnegative(),
      variances: z.number().int().nonnegative(),
    }),
    /** Billed dollars — never a store-bound viewer's. */
    money: z
      .object({ approved: z.number(), awaiting: z.number(), atRisk: z.number() })
      .nullable(),
  }),
  /** Years with hours, newest first. */
  years: z.array(z.number().int()),
  /** Only the newest weeks came back (see `from`). */
  truncated: z.boolean(),
  from: z.string().nullable(),
  generatedAt: z.string(),
}))();
export type TimesheetHistoryResponse = z.infer<typeof TimesheetHistoryResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Scheduling — Phase 7
 * -------------------------------------------------------------------------- */

export const ShiftStatusSchema = /* @__PURE__ */ (() => z.enum([
  'DRAFT',
  'OPEN',
  'ASSIGNED',
  'COMPLETED',
  'CANCELLED',
]))();
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>;

export const ShiftSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  /** Null for a shift at a location with no client (a direct employer, the company's own staff). */
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  position: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  location: z.string().nullable(),
  // Phase 131 — the structured work-site this shift belongs to. locationId
  // is the FK; locationName is denormalized for display + the cascading
  // client→location filter on the schedule page. Null until a shift is
  // tied to a Location (legacy rows used the free-text `location` above).
  locationId: UuidSchema.nullable(),
  locationName: z.string().nullable(),
  // IANA timezone of the work site (from the shift's Location). The
  // calendar renders startsAt/endsAt in THIS zone so a manager viewing the
  // store from another timezone still sees the store's wall-clock times.
  timezone: z.string(),
  /** Fair-workweek notice window at the shift's site, in days, when its
   *  jurisdiction owes predictability pay for schedule changes
   *  (lib/laborRules predictive.noticeDays); null elsewhere. The web
   *  requires a `changeReason` on every change to such a shift. */
  fairWorkweekNoticeDays: z.number().nullable().optional(),
  hourlyRate: z.number().nullable(),
  /** Cost-side rate set explicitly ON this shift (null = none entered). */
  payRate: z.number().nullable(),
  /**
   * Resolved cost rate used for labor numbers: the shift's own payRate when
   * set, otherwise the (client, position) ShiftRateDefault. Null when
   * neither exists. The calendar footer + KPIs read THIS so they light up
   * from defaults. Nulled (like payRate) in associate-facing responses.
   */
  effectivePayRate: z.number().nullable(),
  status: ShiftStatusSchema,
  notes: z.string().nullable(),
  assignedAssociateId: UuidSchema.nullable(),
  assignedAssociateName: z.string().nullable(),
  assignedAt: z.string().datetime().nullable(),
  cancellationReason: z.string().nullable(),
  /** Server-computed convenience: minutes between startsAt and endsAt. */
  scheduledMinutes: z.number().int().nonnegative(),
  // Phase 25 — predictive scheduling. publishedAt is stamped when the
  // shift first transitions out of DRAFT (= "the schedule was posted").
  // lateNoticeReason is required and recorded when a fair-workweek state
  // shift is published inside the 14-day notice window.
  publishedAt: z.string().datetime().nullable(),
  lateNoticeReason: z.string().nullable(),
  /** When the assigned associate tapped "I'll be there". Null = unconfirmed. */
  acknowledgedAt: z.string().datetime().nullable(),
  /**
   * Agent families step 2: the Workforce agent asked the holder whether they
   * are coming (attendance.confirm). Null when nobody asked. The associate app
   * offers "I can't make it" only on an asked shift still unanswered.
   */
  confirmationAsk: z
    .object({
      askedAt: z.string().datetime(),
      cutoffAt: z.string().datetime(),
      answer: z.enum(['YES', 'NO']).nullable(),
    })
    .nullable()
    .optional(),
}))();
export type Shift = z.infer<typeof ShiftSchema>;

export const ShiftListResponseSchema = /* @__PURE__ */ (() => z.object({
  shifts: z.array(ShiftSchema),
  // True when the result hit the server's row cap and more shifts match the
  // filter than were returned. The UI surfaces a "narrow your range" banner so
  // a truncated list never silently reads as complete. Optional for back-compat.
  truncated: z.boolean().optional(),
  // /me only: the caller's login has no linked Associate record, so their
  // schedule CANNOT be resolved — this is a provisioning problem, not "no
  // shifts". The UI must say so instead of showing the ordinary empty state
  // (which reads as "nothing scheduled" and hides the real fault from HR).
  unlinked: z.boolean().optional(),
}))();
export type ShiftListResponse = z.infer<typeof ShiftListResponseSchema>;

/* Associate-facing shift detail — the tap-to-expand card on My Schedule. */

/** A coworker whose published shift overlaps yours at the same work site.
 *  Names are already associate-visible via /directory; times/position let
 *  the associate see who they're working with, Sling-style. Deliberately
 *  NO rates, contact info, or notes — those stay on each person's own shift. */
export const ShiftTeammateSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  name: z.string(),
  position: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  /** Their shift's free-text sub-zone ("Bar", "Produce"), if any. */
  location: z.string().nullable(),
}))();
export type ShiftTeammate = z.infer<typeof ShiftTeammateSchema>;

/** The shift supervisor who leads the store shift window a shift starts in
 *  — "your shift supervisor" on the associate's shift. */
export const ShiftSupervisorSchema = /* @__PURE__ */ (() => z.object({
  userId: UuidSchema,
  name: z.string(),
  associateId: UuidSchema.nullable(),
  /** Their associate headshot, else the staff account's own photo. */
  photoUrl: z.string().nullable().optional(),
}))();
export type ShiftSupervisor = z.infer<typeof ShiftSupervisorSchema>;

export const MyShiftDetailResponseSchema = /* @__PURE__ */ (() => z.object({
  shift: ShiftSchema,
  teammates: z.array(ShiftTeammateSchema),
  /** Who leads the store shift it starts in (empty when nobody does). */
  supervisors: z.array(ShiftSupervisorSchema).default([]),
}))();
export type MyShiftDetailResponse = z.infer<typeof MyShiftDetailResponseSchema>;

/** Older shifts, newest-first. `nextBefore` = cursor for the next page;
 *  null when history is exhausted. */
export const MyShiftHistoryResponseSchema = /* @__PURE__ */ (() => z.object({
  shifts: z.array(ShiftSchema),
  nextBefore: z.string().datetime().nullable(),
}))();
export type MyShiftHistoryResponse = z.infer<typeof MyShiftHistoryResponseSchema>;

/* Open-shift pickup (Phase 85 claims table, finally wired) */

export const OpenShiftClaimStatusSchema = /* @__PURE__ */ (() => z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
]))();
export type OpenShiftClaimStatus = z.infer<typeof OpenShiftClaimStatusSchema>;

/** Open shifts the caller is eligible to pick up, each carrying the
 *  caller's own claim state so the UI can show "Requested" instead of a
 *  second button. */
export const OpenShiftsResponseSchema = /* @__PURE__ */ (() => z.object({
  shifts: z.array(
    ShiftSchema.extend({
      myClaimStatus: OpenShiftClaimStatusSchema.nullable(),
      myClaimId: UuidSchema.nullable(),
    }),
  ),
}))();
export type OpenShiftsResponse = z.infer<typeof OpenShiftsResponseSchema>;

export const OpenShiftClaimSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  shiftId: UuidSchema,
  status: OpenShiftClaimStatusSchema,
  createdAt: z.string().datetime(),
}))();
export type OpenShiftClaim = z.infer<typeof OpenShiftClaimSchema>;

/** Admin review row — who wants which open shift. */
export const AdminOpenShiftClaimSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  status: OpenShiftClaimStatusSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  shiftId: UuidSchema,
  shiftPosition: z.string(),
  shiftClientName: z.string().nullable(),
  shiftStartsAt: z.string().datetime(),
  shiftEndsAt: z.string().datetime(),
  shiftTimezone: z.string(),
  /** Approving would push this associate past 40h scheduled that week.
   *  Advisory chip — the manager can still approve. */
  wouldExceed40h: z.boolean().default(false),
  /** Minutes they'd be scheduled that week AFTER approval — the ranking
   *  signal for "approve best" (fewest hours first). */
  weeklyMinutes: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
}))();
export type AdminOpenShiftClaim = z.infer<typeof AdminOpenShiftClaimSchema>;

export const AdminOpenShiftClaimListResponseSchema = /* @__PURE__ */ (() => z.object({
  claims: z.array(AdminOpenShiftClaimSchema),
}))();
export type AdminOpenShiftClaimListResponse = z.infer<
  typeof AdminOpenShiftClaimListResponseSchema
>;

/* One-off availability exceptions ("can't work July 15") */

export const AvailabilityExceptionSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  /** Calendar date, YYYY-MM-DD. Day-granular by design, like time off. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().nullable(),
}))();
export type AvailabilityException = z.infer<typeof AvailabilityExceptionSchema>;

export const AvailabilityExceptionListResponseSchema = /* @__PURE__ */ (() => z.object({
  exceptions: z.array(AvailabilityExceptionSchema),
}))();
export type AvailabilityExceptionListResponse = z.infer<
  typeof AvailabilityExceptionListResponseSchema
>;

export const AvailabilityExceptionCreateInputSchema = /* @__PURE__ */ (() => z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(200).optional(),
}))();
export type AvailabilityExceptionCreateInput = z.infer<
  typeof AvailabilityExceptionCreateInputSchema
>;

/** A counterparty shift the requester could take in exchange (trades). */
export const TradeOptionSchema = /* @__PURE__ */ (() => z.object({
  shiftId: UuidSchema,
  position: z.string(),
  clientName: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string(),
}))();
export type TradeOption = z.infer<typeof TradeOptionSchema>;

export const TradeOptionsResponseSchema = /* @__PURE__ */ (() => z.object({
  options: z.array(TradeOptionSchema),
}))();
export type TradeOptionsResponse = z.infer<typeof TradeOptionsResponseSchema>;

/** Someone the associate can offer a shift to. `busy` flags an overlapping
 *  assignment so the picker can steer away from people who can't take it —
 *  advisory only; the swap POST and manager approval stay the real gates. */
export const SwapCandidateSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  name: z.string(),
  busy: z.boolean(),
}))();
export type SwapCandidate = z.infer<typeof SwapCandidateSchema>;

export const SwapCandidateListResponseSchema = /* @__PURE__ */ (() => z.object({
  candidates: z.array(SwapCandidateSchema),
}))();
export type SwapCandidateListResponse = z.infer<typeof SwapCandidateListResponseSchema>;

export const ShiftCreateInputSchema = /* @__PURE__ */ (() => z
  .object({
    /** Brief 2-1b: optional — a direct employer's shift names its site instead. */
    clientId: UuidSchema.optional(),
    // Phase 131 — physical work site for the shift. Optional in the
    // wire schema; the server falls back to the client's first
    // active Location when omitted (firstLocationForClient).
    locationId: UuidSchema.optional(),
    position: z.string().min(1).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    /** Optional free-text sub-zone label ("Bar", "Patio", "Floor 2").
     *  Separate from the Location FK above, which is the site. */
    location: z.string().max(200).optional(),
    hourlyRate: z.number().nonnegative().optional(),
    /** Cost-side rate (associate pay). Drives projected labor cost. */
    payRate: z.number().nonnegative().optional(),
    notes: z.string().max(1000).optional(),
    status: ShiftStatusSchema.optional(),
    // Phase 25 — required by the server when publishing a shift inside
    // the 14-day fair-workweek notice window in covered states.
    lateNoticeReason: z.string().min(1).max(500).optional(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  }))();
export type ShiftCreateInput = z.infer<typeof ShiftCreateInputSchema>;

/**
 * Bulk create-and-assign: define one shift (time + role + site) and stamp a
 * copy of it onto many employees at once — each gets their own shift in
 * their row, the way a retail week grid works ("F&D Overnight 10pm–7am"
 * assigned to 20 people). `openCount` adds that many UNASSIGNED copies so a
 * manager can post "need 3 more" open slots alongside the named ones.
 * At least one assignee OR one open slot is required.
 */
export const BulkCreateShiftsInputSchema = /* @__PURE__ */ (() => z
  .object({
    /** Brief 2-1b: optional — a direct employer names the site alone (`locationId`). */
    clientId: UuidSchema.optional(),
    locationId: UuidSchema.optional(),
    position: z.string().min(1).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    location: z.string().max(200).optional(),
    hourlyRate: z.number().nonnegative().optional(),
    payRate: z.number().nonnegative().optional(),
    notes: z.string().max(1000).optional(),
    status: ShiftStatusSchema.optional(),
    lateNoticeReason: z.string().min(1).max(500).optional(),
    /** Employees to assign — one shift instance created per id. */
    associateIds: z.array(UuidSchema).max(200),
    /** Extra unassigned copies (open slots) to create. */
    openCount: z.number().int().min(0).max(100).optional(),
    /**
     * Additional day copies of the SAME shift definition (the create
     * dialog's "also on Tue/Wed/Thu" chips): every employee + open slot
     * is stamped once per occurrence, each conflict-checked per day.
     * Max 6 — the rest of the org week beyond the primary date.
     */
    extraOccurrences: z
      .array(
        z
          .object({
            startsAt: z.string().datetime(),
            endsAt: z.string().datetime(),
          })
          .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
            message: 'endsAt must be after startsAt',
            path: ['endsAt'],
          }),
      )
      .max(6)
      .optional(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })
  .refine((v) => v.associateIds.length + (v.openCount ?? 0) >= 1, {
    message: 'Select at least one employee or add an open slot.',
    path: ['associateIds'],
  }))();
export type BulkCreateShiftsInput = z.infer<typeof BulkCreateShiftsInputSchema>;

export const BulkCreateShiftsResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Total shift rows created (assigned + open). */
  created: z.number().int().nonnegative(),
  /** Employees skipped because the shift overlaps one they already have. */
  skipped: z.array(
    z.object({
      associateId: UuidSchema,
      associateName: z.string(),
      reason: z.string(),
      /** Which day copy the skip applies to (multi-day creates). Absent =
       *  the primary date (single-day creates, pre-multi-day clients). */
      startsAt: z.string().datetime().optional(),
    }),
  ),
}))();
export type BulkCreateShiftsResponse = z.infer<typeof BulkCreateShiftsResponseSchema>;

/* ----- Pay-rate defaults per (client, position) -------------------------- */

export const ShiftRateDefaultSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  position: z.string(),
  payRate: z.number(),
  billRate: z.number().nullable(),
  /** Brief 1A-2: in force from this date to effectiveTo (inclusive); null = open-ended. */
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
}))();
export type ShiftRateDefault = z.infer<typeof ShiftRateDefaultSchema>;

/** List response also carries the client's position catalog so the rate
 *  editor can offer a row per known position without a second capability-
 *  gated fetch. */
export const ShiftRateDefaultListResponseSchema = /* @__PURE__ */ (() => z.object({
  rateDefaults: z.array(ShiftRateDefaultSchema),
  positions: z.array(z.string()),
}))();
export type ShiftRateDefaultListResponse = z.infer<
  typeof ShiftRateDefaultListResponseSchema
>;

/** Upsert a default rate for a (client, position). */
export const ShiftRateDefaultInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  position: z.string().min(1).max(120),
  payRate: z.number().nonnegative().max(100000),
  billRate: z.number().nonnegative().max(100000).nullable().optional(),
  /** Brief 1A-2: the date the new rate takes effect (today when absent). History is never rewritten. */
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}))();
export type ShiftRateDefaultInput = z.infer<typeof ShiftRateDefaultInputSchema>;

/** The reasons a fair-workweek law excuses a late schedule change (no
 *  predictability pay owed): the worker asked, a mutual swap, a voluntary
 *  pick-up, or an emergency. Any change to a published, assigned shift in
 *  a predictability-pay jurisdiction carries one or owes the premium. */
export const SCHEDULE_CHANGE_REASONS = ['EMPLOYEE_REQUESTED', 'MUTUAL_SWAP', 'VOLUNTARY_PICKUP', 'EMERGENCY'] as const;
export const ScheduleChangeReasonSchema = /* @__PURE__ */ (() => z.enum(SCHEDULE_CHANGE_REASONS))();
export type ScheduleChangeReason = z.infer<typeof ScheduleChangeReasonSchema>;

export const ShiftUpdateInputSchema = /* @__PURE__ */ (() => z
  .object({
    position: z.string().min(1).max(120).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    location: z.string().max(200).nullable().optional(),
    hourlyRate: z.number().nonnegative().nullable().optional(),
    payRate: z.number().nonnegative().nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    status: ShiftStatusSchema.optional(),
    lateNoticeReason: z.string().min(1).max(500).optional(),
    /** Why the change is excused from predictability pay (lib/predictabilityPay). */
    changeReason: ScheduleChangeReasonSchema.optional(),
  })
  .refine(
    (v) =>
      v.startsAt === undefined ||
      v.endsAt === undefined ||
      new Date(v.endsAt) > new Date(v.startsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] }
  ))();
export type ShiftUpdateInput = z.infer<typeof ShiftUpdateInputSchema>;

export const ShiftAssignInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  /** Assign even though the associate has approved time off or a declared
   *  day off covering the shift. Without it, /assign 409s with
   *  `associate_unavailable`. Overrides are audit-logged. */
  overrideUnavailability: z.boolean().optional(),
  /** Assign even though it leaves under 10h rest against an adjacent
   *  shift (a "clopen"). Without it, /assign 409s with `rest_gap`.
   *  Advisory guard — the override is audit-logged, never silent. */
  overrideRestGap: z.boolean().optional(),
  /** Assign only if the shift is still unassigned — a one-tap pick from a
   *  list that may be a minute old (the call-outs desk). If someone else
   *  (a lead, the bench, the agent) filled it meanwhile, /assign 409s with
   *  `shift_taken` instead of silently replacing their pick. */
  expectUnassigned: z.boolean().optional(),
  /** Why the change is excused from predictability pay (lib/predictabilityPay). */
  changeReason: ScheduleChangeReasonSchema.optional(),
}))();
export type ShiftAssignInput = z.infer<typeof ShiftAssignInputSchema>;

/* ----- Publish preflight -------------------------------------------------- */

/** Pre-publish health report for a week window: what a manager is about
 *  to ship, with the problems named BEFORE the notifications go out. */
export const PublishPreflightResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Draft shifts in the window (what publish would flip live). */
  drafts: z.number().int().nonnegative(),
  /** Drafts inside a fair-workweek 14-day notice window that still lack a
   *  late-notice reason — publish skips these unless the publish call
   *  carries a batch `lateNoticeReason`. */
  noticeWindowDrafts: z.number().int().nonnegative().optional(),
  /** OPEN (unassigned, non-draft) shifts still needing a person. */
  open: z.number().int().nonnegative(),
  /** People projected past 40h scheduled in the window's week. */
  otProjected: z.array(
    z.object({
      name: z.string(),
      hours: z.number().nonnegative(),
      /** Who, so the review sheet opens that person's row. */
      associateId: UuidSchema.optional(),
      /** Their shifts in the window, so a row can land on one. */
      shiftIds: z.array(UuidSchema).optional(),
      /** The week's projected cost at their rate, premium included. */
      projectedCostCents: z.number().int().nonnegative().optional(),
    }),
  ),
  /** Short turnarounds (<10h between consecutive shifts). */
  restGaps: z.array(
    z.object({
      name: z.string(),
      gapHours: z.number().nonnegative(),
      /** ISO start of the SECOND (short-rested) shift. */
      startsAt: z.string().datetime(),
      /** That shift's store zone (one shift, one time). */
      timezone: z.string().optional(),
      associateId: UuidSchema.optional(),
      /** [first, second] — the two shifts the gap sits between. */
      shiftIds: z.array(UuidSchema).optional(),
    }),
  ),
  /** What the labor-rules engine (lib/laborRules evaluateSchedule) says
   *  about each draft: minors' limits and rest periods block, the rest
   *  warn. Publish refuses while a `block` finding stands. */
  laborFindings: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(['warn', 'block']),
      reason: z.string(),
      shiftId: UuidSchema,
      associateId: UuidSchema.nullable(),
      associateName: z.string().nullable(),
    }),
  ).optional(),
  /** The review sheet's totals for the window. */
  totals: z.object({
    shifts: z.number().int().nonnegative(),
    hours: z.number().nonnegative(),
    costCents: z.number().int().nonnegative(),
    /** Change vs the same-length window one week earlier; null when there was nothing then. */
    deltaHoursVsLastWeek: z.number().nullable(),
    deltaCostCentsVsLastWeek: z.number().int().nullable(),
  }).optional(),
  /** Distinct people a publish would notify. */
  notifyCount: z.number().int().nonnegative().optional(),
  /** Unfilled drafts/opens by id, so the sheet can open Assign on one. */
  openShiftIds: z.array(UuidSchema).optional(),
}))();
export type PublishPreflightResponse = z.infer<typeof PublishPreflightResponseSchema>;
export type PublishLaborFinding = NonNullable<PublishPreflightResponse['laborFindings']>[number];

export const ShiftCancelInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().min(1).max(500),
  /** Why the cancellation is excused from predictability pay (lib/predictabilityPay). */
  changeReason: ScheduleChangeReasonSchema.optional(),
}))();

/** Body of POST /scheduling/shifts/:id/unassign — nothing required. */
export const ShiftUnassignInputSchema = /* @__PURE__ */ (() => z.object({
  changeReason: ScheduleChangeReasonSchema.optional(),
}))();
export type ShiftUnassignInput = z.infer<typeof ShiftUnassignInputSchema>;
export type ShiftCancelInput = z.infer<typeof ShiftCancelInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 51 — shift templates + copy-week
 * -------------------------------------------------------------------------- */

export const ShiftTemplateSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  name: z.string(),
  position: z.string(),
  dayOfWeek: z.number().int().min(0).max(6), // 0 = Sun
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  location: z.string().nullable(),
  hourlyRate: z.number().nullable(),
  payRate: z.number().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
}))();
export type ShiftTemplate = z.infer<typeof ShiftTemplateSchema>;

export const ShiftTemplateListResponseSchema = /* @__PURE__ */ (() => z.object({
  templates: z.array(ShiftTemplateSchema),
}))();
export type ShiftTemplateListResponse = z.infer<typeof ShiftTemplateListResponseSchema>;

export const ShiftTemplateCreateInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema.nullable(),
  name: z.string().trim().min(1).max(80),
  position: z.string().trim().min(1).max(120),
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  location: z.string().trim().max(200).nullable().optional(),
  hourlyRate: z.number().nonnegative().nullable().optional(),
  payRate: z.number().nonnegative().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}))();
export type ShiftTemplateCreateInput = z.infer<typeof ShiftTemplateCreateInputSchema>;

export const ShiftTemplateApplyInputSchema = /* @__PURE__ */ (() => z.object({
  /** ISO date that anchors the target week — server snaps to local Sunday. */
  weekStart: z.string().datetime(),
  /** Override the template's clientId (required if template is global). */
  clientId: UuidSchema.optional(),
  /** Brief 2-1b: the site a global template lands on when there is no client (a direct employer). */
  locationId: UuidSchema.optional(),
  /** Applying onto a week that already has an identical draft 409s
   *  (duplicate_shift) unless this is set — a deliberate second slot at
   *  the same time is legitimate, an accidental double-apply is not. */
  allowDuplicate: z.boolean().optional(),
}))();
export type ShiftTemplateApplyInput = z.infer<typeof ShiftTemplateApplyInputSchema>;

export const CopyWeekInputSchema = /* @__PURE__ */ (() => z.object({
  /**
   * ISO instant of the first day of the visible week (local midnight on the
   * client). Used VERBATIM — the copy window is [sourceWeekStart, +7 days),
   * so it always matches exactly what the manager is looking at, whatever
   * weekday their week is anchored on.
   */
  sourceWeekStart: z.string().datetime(),
  targetWeekStart: z.string().datetime(),
  /** When set, only shifts for this client are copied. */
  clientId: UuidSchema.optional(),
  /** When set, only shifts at this location are copied. */
  locationId: UuidSchema.optional(),
  /**
   * When true (the default), each copied shift keeps the associate it was
   * assigned to in the source week, so the whole roster lands pre-assigned
   * in the target week. Copies still land in DRAFT — publish-week remains the
   * double-booking gate. Pass false for the old behaviour: blank, unassigned
   * drafts.
   */
  preserveAssignments: z.boolean().optional(),
}))();
export type CopyWeekInput = z.infer<typeof CopyWeekInputSchema>;

export const CopyWeekResponseSchema = /* @__PURE__ */ (() => z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** How many of the copied shifts carried their associate assignment. */
  assigned: z.number().int().nonnegative().optional(),
  /** Source shifts whose exact twin already sat in the target week —
   *  skipped instead of duplicated, which makes copy-week idempotent
   *  (re-clicks, timeout retries, and two-admin races no longer double
   *  the week). Multiset-matched, so N legitimate identical slots still
   *  copy as N. */
  alreadyThere: z.number().int().nonnegative().optional(),
}))();
export type CopyWeekResponse = z.infer<typeof CopyWeekResponseSchema>;

/* Labor cost report =======================================================
 * Day-by-day scheduled + worked labor cost, grouped client → store. The
 * scheduled side prices each shift at its explicit payRate, else the
 * (client, position) ShiftRateDefault — the same resolution the KPI strip
 * uses. The worked side prices each COMPLETED/APPROVED time entry at the
 * payRate snapshotted at clock-in. Rows with no resolvable rate are
 * counted (noRate) instead of silently contributing $0-and-invisible.
 */

export const LaborCostRowSchema = /* @__PURE__ */ (() => z.object({
  /** Site-local calendar day (YYYY-MM-DD). */
  date: z.string(),
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  locationId: UuidSchema.nullable(),
  locationName: z.string().nullable(),
  scheduledShifts: z.number().int().nonnegative(),
  scheduledMinutes: z.number().int().nonnegative(),
  scheduledCost: z.number().nonnegative(),
  /** Shifts with neither an explicit payRate nor a rate default. */
  scheduledNoRate: z.number().int().nonnegative(),
  workedPunches: z.number().int().nonnegative(),
  workedMinutes: z.number().int().nonnegative(),
  workedCost: z.number().nonnegative(),
  /** Punches without a snapshotted payRate. */
  workedNoRate: z.number().int().nonnegative(),
  /** The APPROVED subset of worked time — the in-system record of
   *  Fieldglass-approved (billable) hours. workedMinutes −
   *  approvedMinutes is the billed-vs-worked gap: hours worked but not
   *  yet approved, where margin leaks. Optional for back-compat. */
  approvedMinutes: z.number().int().nonnegative().optional(),
  approvedCost: z.number().nonnegative().optional(),
  /** Distinct assigned associates among the bucket's shifts — "heads on
   *  the floor". Open (unassigned) slots cost money but aren't heads. */
  scheduledHeads: z.number().int().nonnegative(),
  /** The store's effective-dated staffing target for this day; null when
   *  the store has none set (or the bucket has no store). */
  targetHeads: z.number().int().nonnegative().nullable(),
  /** Lead-vs-associate split, classified by the shift position's isLead
   *  flag. A person is a lead head if ANY of their day's shifts is a lead
   *  shift; minutes/cost split per shift. */
  leadHeads: z.number().int().nonnegative(),
  leadMinutes: z.number().int().nonnegative(),
  leadCost: z.number().nonnegative(),
  associateHeads: z.number().int().nonnegative(),
  associateMinutes: z.number().int().nonnegative(),
  associateCost: z.number().nonnegative(),
  /** Billable value: shift minutes × (the shift's own bill rate, else the
   *  (client, position) default billRate). The revenue side of the SOW. */
  scheduledRevenue: z.number().nonnegative(),
  /** Shifts with no resolvable bill rate — unbillable until rates are set. */
  revenueNoRate: z.number().int().nonnegative(),
  /** Per-shift-window breakdown of this store's day, when the store has
   *  staffing windows defined. A shift/punch belongs to the window
   *  containing its site-local start time; the catch-all "Other times"
   *  row (null minutes) collects the rest. Optional for back-compat. */
  windows: z
    .array(
      z.object({
        label: z.string(),
        startMinute: z.number().int().nullable(),
        endMinute: z.number().int().nullable(),
        targetHeads: z.number().int().nonnegative().nullable(),
        scheduledShifts: z.number().int().nonnegative(),
        scheduledHeads: z.number().int().nonnegative(),
        scheduledMinutes: z.number().int().nonnegative(),
        scheduledCost: z.number().nonnegative(),
        scheduledRevenue: z.number().nonnegative(),
        workedPunches: z.number().int().nonnegative(),
        workedMinutes: z.number().int().nonnegative(),
        workedCost: z.number().nonnegative(),
      }),
    )
    .optional(),
}))();
export type LaborCostRow = z.infer<typeof LaborCostRowSchema>;

/* Staffing targets ======================================================== */

export const StaffingWindowTargetSchema = /* @__PURE__ */ (() => z.object({
  label: z.string(),
  /** Site-local wall-clock minutes; end <= start wraps past midnight. */
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  targetCount: z.number().int().nonnegative(),
  effectiveFrom: z.string(),
}))();
export type StaffingWindowTarget = z.infer<typeof StaffingWindowTargetSchema>;

export const StaffingTargetLocationSchema = /* @__PURE__ */ (() => z.object({
  locationId: UuidSchema,
  locationName: z.string(),
  clientId: UuidSchema,
  clientName: z.string(),
  /** Current effective TOTAL floor target, null when never set. */
  targetCount: z.number().int().nonnegative().nullable(),
  /** When the current total target took effect (YYYY-MM-DD). */
  effectiveFrom: z.string().nullable(),
  /** Current per-shift window targets (latest per label). */
  windows: z.array(StaffingWindowTargetSchema),
}))();
export type StaffingTargetLocation = z.infer<typeof StaffingTargetLocationSchema>;

export const StaffingTargetsResponseSchema = /* @__PURE__ */ (() => z.object({
  locations: z.array(StaffingTargetLocationSchema),
}))();
export type StaffingTargetsResponse = z.infer<typeof StaffingTargetsResponseSchema>;

export const StaffingTargetInputSchema = /* @__PURE__ */ (() => z
  .object({
    locationId: UuidSchema,
    targetCount: z.number().int().min(0).max(999),
    /** YYYY-MM-DD; defaults to today on the server when omitted. */
    effectiveFrom: z.string().date().optional(),
    note: z.string().max(300).optional(),
    /** Omit all three for the TOTAL floor target; provide all three for a
     *  per-shift window target ("Morning", 360, 840). */
    label: z.string().trim().min(1).max(60).optional(),
    startMinute: z.number().int().min(0).max(1439).optional(),
    endMinute: z.number().int().min(0).max(1439).optional(),
  })
  .refine(
    (v) =>
      (v.label === undefined && v.startMinute === undefined && v.endMinute === undefined) ||
      (v.label !== undefined && v.startMinute !== undefined && v.endMinute !== undefined),
    { message: 'label, startMinute, and endMinute must be provided together.' },
  ))();
export type StaffingTargetInput = z.infer<typeof StaffingTargetInputSchema>;

/* Live floor board: clocked-in right now vs the expected headcount. */

export const FloorNowRowSchema = /* @__PURE__ */ (() => z.object({
  locationId: UuidSchema,
  locationName: z.string(),
  clientId: UuidSchema,
  clientName: z.string(),
  /** ACTIVE (clocked-in, not out) time entries at this store right now. */
  clockedIn: z.number().int().nonnegative(),
  /** The expectation being compared against: the shift window covering the
   *  store's local time right now, else the total floor target. */
  expected: z.number().int().nonnegative().nullable(),
  /** Which window matched ("Morning"), or null when the total applies. */
  windowLabel: z.string().nullable(),
  totalTarget: z.number().int().nonnegative().nullable(),
  /* Live labor cost — accrues per clocked-in person from their punch-in
   * (net of breaks), at the snapshotted pay rate else the org standard,
   * with OT (past 40h this week, ALL clients combined) at 1.5×. All
   * optional for back-compat. */
  /** Current burn rate: direct wages, $/hr. */
  wagePerHour: z.number().nonnegative().optional(),
  /** Burn rate fully loaded (burden % + overhead per hour), $/hr. */
  loadedPerHour: z.number().nonnegative().optional(),
  /** Current billing rate at the applicable bill rates, $/hr. */
  billedPerHour: z.number().nonnegative().optional(),
  /** Accrued this shift so far (everyone currently on the floor). */
  wageSoFar: z.number().nonnegative().optional(),
  loadedSoFar: z.number().nonnegative().optional(),
  billedSoFar: z.number().nonnegative().optional(),
  /** Clocked-in people currently past 40 weekly hours (paying 1.5×). */
  otHeads: z.number().int().nonnegative().optional(),
  /** Not over yet, but worked + remaining scheduled this week crosses 40h —
   *  the window where trimming a shift still avoids the 1.5× bill. */
  projectedOtHeads: z.number().int().nonnegative().optional(),
}))();
export type FloorNowRow = z.infer<typeof FloorNowRowSchema>;

export const FloorNowResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(FloorNowRowSchema),
  generatedAt: z.string().datetime(),
  /** The loaded-cost knobs in force, for honest labeling. */
  burden: z
    .object({
      percent: z.number().nonnegative(),
      overheadPerHour: z.number().nonnegative(),
    })
    .optional(),
}))();
export type FloorNowResponse = z.infer<typeof FloorNowResponseSchema>;

export const LaborCostReportResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(LaborCostRowSchema),
  /** True when the shift or punch caps were hit — totals are a floor. */
  truncated: z.boolean(),
  /** Org-wide rates applied when neither the shift nor the (client,
   *  position) default sets one; null = disabled. Surfaced so the UI can
   *  state pricing sources. */
  fallbacks: z
    .object({
      associatePayRate: z.number().nullable(),
      leadPayRate: z.number().nullable().optional(),
      associateBillRate: z.number().nullable(),
      leadBillRate: z.number().nullable(),
    })
    .optional(),
}))();
export type LaborCostReportResponse = z.infer<typeof LaborCostReportResponseSchema>;

/* Draft dedupe ============================================================
 * Cleanup for the duplicate-draft plague: exact-twin DRAFT shifts (same
 * client, location, position, times, assignee-or-open) created by the
 * pre-idempotency copy-week / double-applies. Removes all but the oldest
 * of each group; DRAFTs only — published shifts are never touched.
 */

export const DedupeDraftsInputSchema = /* @__PURE__ */ (() => z.object({
  from: z.string().datetime(),
  /** Exclusive upper bound, like every other range endpoint. */
  to: z.string().datetime(),
  clientId: UuidSchema.optional(),
}))();
export type DedupeDraftsInput = z.infer<typeof DedupeDraftsInputSchema>;

export const DedupeDraftsResponseSchema = /* @__PURE__ */ (() => z.object({
  /** DRAFT shifts examined in the window. */
  scanned: z.number().int().nonnegative(),
  /** Twin groups that had extras. */
  groups: z.number().int().nonnegative(),
  /** Extra copies deleted (the oldest of each group is kept). */
  removed: z.number().int().nonnegative(),
}))();
export type DedupeDraftsResponse = z.infer<typeof DedupeDraftsResponseSchema>;

/* Shift teams ==============================================================
 * A standing crew at a work site ("Front Beach Morning"). Scheduling
 * filters its roster to a team's members so a manager building the week
 * sees only the people who work that shift. Optional default start/end
 * minutes prefill the create-shift dialog.
 */

export const ShiftTeamSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  locationId: UuidSchema,
  locationName: z.string().nullable(),
  name: z.string(),
  /** Wall-clock minutes since site-local midnight; null = no default. */
  startMinute: z.number().int().min(0).max(1439).nullable(),
  endMinute: z.number().int().min(0).max(1439).nullable(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}))();
export type ShiftTeam = z.infer<typeof ShiftTeamSchema>;

export const ShiftTeamListResponseSchema = /* @__PURE__ */ (() => z.object({
  teams: z.array(ShiftTeamSchema),
}))();
export type ShiftTeamListResponse = z.infer<typeof ShiftTeamListResponseSchema>;

export const ShiftTeamCreateInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  locationId: UuidSchema,
  name: z.string().min(1).max(80),
  startMinute: z.number().int().min(0).max(1439).nullable().optional(),
  endMinute: z.number().int().min(0).max(1439).nullable().optional(),
}))();
export type ShiftTeamCreateInput = z.infer<typeof ShiftTeamCreateInputSchema>;

export const ShiftTeamUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().min(1).max(80).optional(),
  startMinute: z.number().int().min(0).max(1439).nullable().optional(),
  endMinute: z.number().int().min(0).max(1439).nullable().optional(),
}))();
export type ShiftTeamUpdateInput = z.infer<typeof ShiftTeamUpdateInputSchema>;

export const ShiftTeamDetailResponseSchema = /* @__PURE__ */ (() => z.object({
  team: ShiftTeamSchema,
  members: z.array(
    z.object({
      associateId: UuidSchema,
      firstName: z.string(),
      lastName: z.string(),
      email: z.string(),
      /** False when the associate has no open assignment/approved
       *  application at the team's location — membership likely stale. */
      atLocation: z.boolean(),
      /** False when their portal account is INVITED/DISABLED or absent.
       *  Informational only — login state never gates scheduling. */
      portalActive: z.boolean().optional(),
    }),
  ),
}))();
export type ShiftTeamDetailResponse = z.infer<typeof ShiftTeamDetailResponseSchema>;

/** Response of the "assign to this site" quick action on a team member. */
export const ShiftTeamAssignHereResponseSchema = /* @__PURE__ */ (() => z.object({
  assignmentId: UuidSchema,
}))();
export type ShiftTeamAssignHereResponse = z.infer<typeof ShiftTeamAssignHereResponseSchema>;

export const ShiftTeamMemberInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
}))();
export type ShiftTeamMemberInput = z.infer<typeof ShiftTeamMemberInputSchema>;

/* Phase 53 — pivot week view + publish-week ===============================
 * Slim associate list for the row-axis of the people-x-days grid; and a
 * batch-publish endpoint so HR can flip a whole week of DRAFT shifts to
 * OPEN/ASSIGNED in one click.
 */

export const AssociateLiteSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
}))();
export type AssociateLite = z.infer<typeof AssociateLiteSchema>;

export const AssociateListResponseSchema = /* @__PURE__ */ (() => z.object({
  associates: z.array(AssociateLiteSchema),
  // True when the roster hit the server's page cap and rows were dropped.
  // The scheduling grid uses this list as its ROW AXIS, so a silent cut
  // means a manager scanning for unstaffed people reads an incomplete grid
  // as complete. Optional so older clients keep parsing.
  truncated: z.boolean().optional(),
}))();
export type AssociateListResponse = z.infer<typeof AssociateListResponseSchema>;

/**
 * Week-at-a-glance fit data for the scheduling grid: each associate's
 * weekly availability windows plus the specific days blocked by approved
 * time off or one-off "can't work" exceptions. Lets the grid shade cells
 * BEFORE the manager drops a shift on someone who can't take it.
 */
export const AvailabilityOverviewResponseSchema = /* @__PURE__ */ (() => z.object({
  associates: z.array(
    z.object({
      associateId: UuidSchema,
      windows: z.array(
        z.object({
          dayOfWeek: z.number().int().min(0).max(6),
          startMinute: z.number().int().min(0).max(1439),
          endMinute: z.number().int().min(0).max(1440),
        }),
      ),
      /** Calendar days (YYYY-MM-DD) vetoed by approved PTO or exceptions. */
      blockedDays: z.array(z.string()),
    }),
  ),
  /** True when more people were in reach than the overview carries. */
  truncated: z.boolean().optional(),
}))();
export type AvailabilityOverviewResponse = z.infer<
  typeof AvailabilityOverviewResponseSchema
>;

export const PublishWeekInputSchema = /* @__PURE__ */ (() => z.object({
  /**
   * Exact start instant of the window (inclusive). The CLIENT computes the
   * displayed week's boundary — the server must not re-snap it: snapping to
   * "local Monday midnight" on a UTC server published the UTC week, not the
   * one on the admin's screen (late-Sunday-evening drafts silently skipped).
   */
  weekStart: z.string().datetime(),
  /** Exclusive end instant. Omitted = weekStart + 7×24h (pre-DST-aware
   *  callers); the UI sends the real zone-aware boundary. */
  weekEnd: z.string().datetime().optional(),
  /** When set, only DRAFT shifts for this client are published. */
  clientId: UuidSchema.optional(),
  /**
   * Batch late-notice reason. When present, drafts inside a fair-workweek
   * state's 14-day notice window are published WITH this reason recorded
   * (drafts carrying their own reason keep it) instead of being skipped.
   * Absent = those drafts are skipped, exactly as before.
   */
  lateNoticeReason: z.string().trim().min(1).max(500).optional(),
}))();
export type PublishWeekInput = z.infer<typeof PublishWeekInputSchema>;

export const PublishWeekSkipReasonSchema = /* @__PURE__ */ (() => z.enum([
  'predictive_schedule_violation',
  // Publishing this draft would give its associate two overlapping
  // ASSIGNED shifts — fix the times or reassign, then re-publish.
  'double_booking',
]))();
export type PublishWeekSkipReason = z.infer<typeof PublishWeekSkipReasonSchema>;

export const PublishWeekSkipSchema = /* @__PURE__ */ (() => z.object({
  shiftId: UuidSchema,
  reason: PublishWeekSkipReasonSchema,
  detail: z.string().nullable(),
}))();
export type PublishWeekSkip = z.infer<typeof PublishWeekSkipSchema>;

export const PublishWeekResponseSchema = /* @__PURE__ */ (() => z.object({
  published: z.number().int().nonnegative(),
  skipped: z.array(PublishWeekSkipSchema),
  /** True when more than the per-request cap of drafts matched — the rest
   *  are still DRAFT; run publish again. Silent before, which quietly left
   *  drafts unpublished on very large weeks. */
  truncated: z.boolean().optional(),
  /** What the labor-rules engine warned about on the shifts that published
   *  (overtime ahead, short rest where the rules only warn). A `block`
   *  finding never reaches here: publish-week answers 409
   *  `labor_rules_block` with `{ findings }` and publishes nothing. */
  laborWarnings: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(['warn', 'block']),
      reason: z.string(),
      shiftId: UuidSchema,
      associateId: UuidSchema.nullable(),
      associateName: z.string().nullable(),
    }),
  ).optional(),
}))();
export type PublishWeekResponse = z.infer<typeof PublishWeekResponseSchema>;

/* Auto-schedule the week ================================================== */

export const AutoScheduleWeekInputSchema = /* @__PURE__ */ (() => z.object({
  /** Exact window start (inclusive) — same no-server-resnap contract as
   *  PublishWeekInput; snapping on a UTC server acted on the wrong week. */
  weekStart: z.string().datetime(),
  /** Exclusive end. Omitted = weekStart + 7×24h. */
  weekEnd: z.string().datetime().optional(),
  /** When set, only fills OPEN shifts for this client. */
  clientId: UuidSchema.optional(),
  /** When set, only fills shifts at this location. */
  locationId: UuidSchema.optional(),
  /** Fill unpublished drafts only — published open shifts are left for a
   *  person to decide (Build next week: nothing live changes before the
   *  manager's Publish click). */
  draftsOnly: z.boolean().optional(),
}))();
export type AutoScheduleWeekInput = z.infer<typeof AutoScheduleWeekInputSchema>;

export const AutoScheduleSkipReasonSchema = /* @__PURE__ */ (() => z.enum([
  /** Every associate either had a hard conflict, was on PTO, or was unscored. */
  'no_eligible_candidate',
  /** Top candidate would already exceed 40h with no slack — manager review needed. */
  'all_candidates_overtime',
]))();
export type AutoScheduleSkipReason = z.infer<typeof AutoScheduleSkipReasonSchema>;

export const AutoScheduleSkipSchema = /* @__PURE__ */ (() => z.object({
  shiftId: UuidSchema,
  reason: AutoScheduleSkipReasonSchema,
  detail: z.string().nullable(),
}))();
export type AutoScheduleSkip = z.infer<typeof AutoScheduleSkipSchema>;

export const AutoScheduleWeekResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Number of OPEN shifts that were auto-assigned. */
  assigned: z.number().int().nonnegative(),
  /** Shifts that couldn't be auto-filled, with the reason. */
  skipped: z.array(AutoScheduleSkipSchema),
  /** Per-associate roll-up so the UI can render "Jane got 3 shifts, Bob got 2". */
  byAssociate: z.array(
    z.object({
      associateId: UuidSchema,
      associateName: z.string(),
      shiftsAssigned: z.number().int().positive(),
    }),
  ),
}))();
export type AutoScheduleWeekResponse = z.infer<typeof AutoScheduleWeekResponseSchema>;

/* iCal feed URL for the signed-in associate */

export const CalendarFeedUrlResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Absolute URL the user can paste into Google/Apple/Outlook to subscribe. */
  url: z.string().url(),
  /** webcal:// variant — Apple Calendar handles this directly via system handler. */
  webcalUrl: z.string(),
}))();
export type CalendarFeedUrlResponse = z.infer<typeof CalendarFeedUrlResponseSchema>;

/* Phase 54.4 — schedule PDF export ======================================== */

export const ScheduleExportInputSchema = /* @__PURE__ */ (() => z.object({
  /** ISO timestamp; the server treats this as the inclusive start of the range. */
  from: z.string().datetime(),
  /** ISO timestamp; the server treats this as the EXCLUSIVE end of the range. */
  to: z.string().datetime(),
  clientId: UuidSchema.optional(),
}))();
export type ScheduleExportInput = z.infer<typeof ScheduleExportInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Payroll — Phase 8 (MVP, demo-only withholding; disbursement stubbed)
 * -------------------------------------------------------------------------- */

export const PayrollRunStatusSchema = /* @__PURE__ */ (() => z.enum([
  'DRAFT',
  'FINALIZED',
  'DISBURSED',
  'CANCELLED',
]))();
export type PayrollRunStatus = z.infer<typeof PayrollRunStatusSchema>;

export const PayrollItemStatusSchema = /* @__PURE__ */ (() => z.enum([
  'PENDING',
  'DISBURSED',
  'FAILED',
  'HELD',
  // Gap 3 — set when the parent run is voided.
  'VOIDED',
]))();
export type PayrollItemStatus = z.infer<typeof PayrollItemStatusSchema>;

// Gap 3 — distinguishes regular periodic runs from off-cycle bonus/terminal-pay
// runs and from amendment runs that correct a prior disbursed run.
export const PayrollRunKindSchema = /* @__PURE__ */ (() => z.enum(['REGULAR', 'OFF_CYCLE', 'AMENDMENT', 'DAILY', 'MANUAL']))();
export type PayrollRunKind = z.infer<typeof PayrollRunKindSchema>;

// Wave 1.2 — earning kinds. Mirrors PayrollEarningKind in schema.prisma.
export const PayrollEarningKindSchema = /* @__PURE__ */ (() => z.enum([
  'REGULAR',
  'OVERTIME',
  'DOUBLE_TIME',
  'RETRO',
  'PREMIUM',
  'HOLIDAY',
  'SICK',
  'VACATION',
  'BONUS',
  'COMMISSION',
  'TIPS',
  'REIMBURSEMENT',
  // PAYEXP: what daily pay already paid this period, shown (negative) on the true-up.
  'DAILY_SETTLED',
  // Non-cash taxable income (group-term life over $50,000): taxed, never paid out. W-2 Box 12 C.
  'IMPUTED_INCOME',
]))();
export type PayrollEarningKind = z.infer<typeof PayrollEarningKindSchema>;

export const PayrollItemEarningSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  kind: PayrollEarningKindSchema,
  hours: z.number().nullable(),
  rate: z.number().nullable(),
  amount: z.number(),
  isTaxable: z.boolean(),
  notes: z.string().nullable(),
}))();
export type PayrollItemEarning = z.infer<typeof PayrollItemEarningSchema>;

export const PayrollItemSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  payrollRunId: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string().nullable(),
  hoursWorked: z.number().nonnegative(),
  hourlyRate: z.number().nonnegative(),
  grossPay: z.number().nonnegative(),
  federalWithholding: z.number().nonnegative(),
  // Phase 18 — full per-paycheck tax breakdown.
  fica: z.number().nonnegative(),
  medicare: z.number().nonnegative(),
  stateWithholding: z.number().nonnegative(),
  taxState: z.string().nullable(),
  ytdWages: z.number().nonnegative(),
  ytdMedicareWages: z.number().nonnegative(),
  // Employer-side. Not deducted from net; surfaced for finance/audit.
  employerFica: z.number().nonnegative(),
  employerMedicare: z.number().nonnegative(),
  employerFuta: z.number().nonnegative(),
  employerSuta: z.number().nonnegative(),
  netPay: z.number(),
  /** Pre-tax benefit deductions taken this period. Serialized so the amend
   *  wizard can seed the REAL value — omitting it made every amendment
   *  zero the deduction and silently overpay. Optional for back-compat. */
  preTaxDeductions: z.number().nonnegative().optional(),
  /** 401(k)/403(b) sub-bucket of preTaxDeductions. */
  preTaxRetirement: z.number().nonnegative().optional(),
  // Wave 4.2 — post-tax deductions (garnishments etc.) taken this period.
  // Subtracted from net AFTER taxes; does not affect taxable wages.
  postTaxDeductions: z.number().nonnegative(),
  status: PayrollItemStatusSchema,
  disbursementRef: z.string().nullable(),
  disbursedAt: z.string().datetime().nullable(),
  failureReason: z.string().nullable(),
  // Wave 1.2 — per-kind breakdown that sums to grossPay.
  earnings: z.array(PayrollItemEarningSchema),
  /** Every deduction on the check, itemized (PayrollItemDeduction): the
   *  pre-tax lines sum to preTaxDeductions, the post-tax to postTaxDeductions;
   *  EMPLOYER lines are paid on top and never reduce net. Absent on checks
   *  from before itemizing. `key` matches the YTD map on /me/items/:id/ytd. */
  deductions: z
    .array(
      z.object({
        key: z.string(),
        code: z.string(),
        category: z.enum(['PRE_TAX', 'POST_TAX', 'EMPLOYER']),
        label: z.string(),
        employeeAmount: z.number(),
        employerAmount: z.number(),
      }),
    )
    .optional(),
  /** State disability / paid-leave / employee UI contributions withheld (CA SDI, NJ TDI/FLI, WA PFML …):
   *  taxes with no column of their own, out of net. Absent when none. */
  stateProgramTaxes: z.array(z.object({ code: z.string(), label: z.string(), amount: z.number() })).optional(),
  /** The kind of run that paid this check (REGULAR, OFF_CYCLE, AMENDMENT, DAILY, MANUAL) — on the associate's own list. */
  runKind: z.enum(['REGULAR', 'OFF_CYCLE', 'AMENDMENT', 'DAILY', 'MANUAL']).optional(),
  /** Van rides taken from this check (part of postTaxDeductions) — the
   *  paystub's own "Transportation" line. Associate-facing reads only.
   *  Brief 1A-3: `deferred` is what was owed but held back by the
   *  minimum-wage guard (carried to a later check). */
  transport: z
    .object({
      amount: z.number().nonnegative(),
      rides: z.number().int(),
      noShows: z.number().int(),
      deferred: z.number().nonnegative().optional(),
      minimumWage: z.number().nonnegative().optional(),
      minimumWageState: z.string().optional(),
    })
    .optional(),
}))();
export type PayrollItem = z.infer<typeof PayrollItemSchema>;

export const PayrollRunSummarySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  /** The pay schedule the run pays (null: a legacy or off-cycle run). */
  payrollScheduleId: UuidSchema.nullable().optional(),
  payrollScheduleName: z.string().nullable().optional(),
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  periodStart: z.string(),  // YYYY-MM-DD
  periodEnd: z.string(),
  status: PayrollRunStatusSchema,
  totalGross: z.number().nonnegative(),
  totalTax: z.number().nonnegative(),
  totalNet: z.number(),
  // Phase 18 — employer-side total (FICA match + Medicare match + FUTA + SUTA).
  totalEmployerTax: z.number().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  notes: z.string().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  disbursedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  // Gap 3 — kind + amendment / void metadata. kind is REGULAR for any run
  // created before this lands (default migration value). amendsRunId,
  // amendmentReason are populated only on AMENDMENT runs. cancelledAt /
  // cancelledById / cancelReason are populated only
  // on voided runs (status=CANCELLED). All optional in the contract so
  // historical responses remain valid.
  kind: PayrollRunKindSchema,
  amendsRunId: UuidSchema.nullable(),
  amendmentReason: z.string().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  cancelledById: UuidSchema.nullable(),
  cancelReason: z.string().nullable(),
  // Tier-3 — four-eyes approval stamp (optional so historical responses
  // stay valid). Set when a second person approves a FINALIZED run.
  approvedAt: z.string().datetime().nullable().optional(),
  approverEmail: z.string().nullable().optional(),
  /** OFF_CYCLE made from the period ledger: it pays the period's approved time (finance walk 1). */
  includesApprovedTime: z.boolean().optional(),
  /** The payday the run's schedule names for its period (YYYY-MM-DD); null for a run on no schedule. */
  payDate: z.string().nullable().optional(),
  /** When the review report was signed off on the run's current numbers (null: not yet, or not required). */
  reviewSignedAt: z.string().datetime().nullable().optional(),
  /**
   * The stored totals above, checked against the run's non-voided paychecks
   * (apps/api/src/lib/payrollRunTotals.ts). `totalsAgree` false means the
   * run records money its paychecks don't add up to — every page that shows
   * the run's money says so.
   */
  itemsGross: z.number().optional(),
  itemsNet: z.number().optional(),
  paychecks: z.number().int().nonnegative().optional(),
  totalsAgree: z.boolean().optional(),
  /** What the run waits on next, from the same lifecycle the guided close shows (finance walk 10). */
  nextStep: z
    .object({
      key: z.enum(['finalize', 'review', 'fund', 'held', 'disburse', 'uploadFile', 'deposit', 'remit', 'done', 'cancelled']),
      label: z.string(),
      to: z.string(),
      /** Someone else's move (a second approver, the bank) rather than the payroll person's. */
      waitingOn: z.string().nullable(),
    })
    .optional(),
}))();
export type PayrollRunSummary = z.infer<typeof PayrollRunSummarySchema>;

export const PayrollRunListResponseSchema = /* @__PURE__ */ (() => z.object({
  runs: z.array(PayrollRunSummarySchema),
}))();
export type PayrollRunListResponse = z.infer<typeof PayrollRunListResponseSchema>;

export const PayrollRunDetailSchema = /* @__PURE__ */ (() => PayrollRunSummarySchema.extend({
  items: z.array(PayrollItemSchema),
}))();
export type PayrollRunDetail = z.infer<typeof PayrollRunDetailSchema>;

// Gap 3 — POST /payroll/runs/:id/amend body. HR sends ABSOLUTE corrected
// values per affected associate; the server fetches the originals and
// stores signed deltas on the new AMENDMENT run's items. `reason` is
// rendered verbatim on the amendment paystub PDF and stored on
// PayrollRun.amendmentReason — required, non-empty (whitespace stripped).
export const PayrollRunAmendInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().trim().min(1, 'reason is required'),
  corrections: z
    .array(
      z.object({
        associateId: UuidSchema,
        hoursWorked: z.number(),
        hourlyRate: z.number().nonnegative(),
        grossPay: z.number(),
        federalWithholding: z.number(),
        fica: z.number(),
        medicare: z.number(),
        stateWithholding: z.number(),
        preTaxDeductions: z.number().default(0),
        // Gap 1 — sub-bucket of preTaxDeductions covering 401(k)/403(b)
        // contributions. Defaults to 0 when omitted (current state — no
        // live retirement plans). Drives Box 3/5 add-back on the W-2.
        preTaxRetirement: z.number().default(0),
        postTaxDeductions: z.number().default(0),
        employerFica: z.number().default(0),
        employerMedicare: z.number().default(0),
        employerFuta: z.number().default(0),
        employerSuta: z.number().default(0),
        // Optional override; when omitted the server preserves the
        // original item's taxState.
        taxState: z.string().nullable().optional(),
      })
    )
    .min(1, 'at least one correction is required'),
}))();
export type PayrollRunAmendInput = z.infer<typeof PayrollRunAmendInputSchema>;

export const PayrollRunCreateInputSchema = /* @__PURE__ */ (() => z
  .object({
    clientId: UuidSchema.nullable().optional(),
    /** YYYY-MM-DD inclusive. */
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD'),
    /** YYYY-MM-DD inclusive. */
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
    /** Default hourly rate when an associate's shifts in the period have none. */
    defaultHourlyRate: z.number().nonnegative().optional(),
    notes: z.string().max(1000).optional(),
    /** OFF_CYCLE = bonus/terminal-pay run: no time aggregation, paychecks
     *  come entirely from add-on earning lines. Default REGULAR. */
    kind: z.enum(['REGULAR', 'OFF_CYCLE']).optional(),
    /** The pay schedule this run pays: only people on it, for the days they were on it (paySchedules.ts). */
    payrollScheduleId: UuidSchema.nullable().optional(),
    /** OFF_CYCLE only: pay the period's approved time that is on no paystub yet (a missed payday from the period ledger, finance walk 1). */
    includesApprovedTime: z.boolean().optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  }))();
export type PayrollRunCreateInput = z.infer<typeof PayrollRunCreateInputSchema>;

// Wave 6.2 — Run preview. Same input shape as create (notes is irrelevant
// but accepted so the wizard can pass the same payload). Output is a
// projected per-associate breakdown with no DB rows touched.
export const PayrollRunPreviewItemSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  associateName: z.string(),
  hoursWorked: z.number().nonnegative(),
  hourlyRate: z.number().nonnegative(),
  /** Where the rate came from — DEFAULT means the editable $15 fallback
   *  because the associate has NO compensation record (flag it!). */
  rateSource: z.enum(['OVERRIDE', 'COMP', 'DEFAULT', 'SALARY']).optional(),
  regularHours: z.number().nonnegative(),
  overtimeHours: z.number().nonnegative(),
  /** The labor-rules engine's split: hours past a live jurisdiction's double-time line (0 elsewhere), and the multipliers paid. */
  doubleTimeHours: z.number().nonnegative().optional(),
  overtimeMultiplier: z.number().positive().optional(),
  doubleMultiplier: z.number().positive().optional(),
  grossPay: z.number().nonnegative(),
  preTaxDeductions: z.number().nonnegative(),
  /** Gap 1 — 401(k)/403(b) sub-bucket; reduces FIT only, not FICA/Medicare. */
  preTaxRetirement: z.number().nonnegative(),
  federalIncomeTax: z.number().nonnegative(),
  fica: z.number().nonnegative(),
  medicare: z.number().nonnegative(),
  stateIncomeTax: z.number().nonnegative(),
  taxState: z.string().nullable(),
  payFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY', 'DAILY']),
  disposableEarnings: z.number().nonnegative(),
  postTaxDeductions: z.number().nonnegative(),
  netPay: z.number(),
  employerFica: z.number().nonnegative(),
  employerMedicare: z.number().nonnegative(),
  employerFuta: z.number().nonnegative(),
  employerSuta: z.number().nonnegative(),
  ytdWages: z.number().nonnegative(),
  /** Brief 1A-3: the van ride charges this check will take (inside
   *  postTaxDeductions), what the minimum-wage guard defers, and charges on
   *  file with no signed authorization (never taken). */
  rideCharges: z
    .object({
      amount: z.number().nonnegative(),
      deferred: z.number().nonnegative(),
      rides: z.number().int(),
      noShows: z.number().int(),
      unauthorized: z.number().nonnegative(),
    })
    .optional(),
}))();
export type PayrollRunPreviewItem = z.infer<typeof PayrollRunPreviewItemSchema>;

export const PayrollRunPreviewResponseSchema = /* @__PURE__ */ (() => z.object({
  items: z.array(PayrollRunPreviewItemSchema),
  totals: z.object({
    totalGross: z.number().nonnegative(),
    totalEmployeeTax: z.number().nonnegative(),
    totalNet: z.number(),
    totalEmployerTax: z.number().nonnegative(),
    totalGarnishments: z.number().nonnegative(),
    itemCount: z.number().int().nonnegative(),
  }),
  /**
   * Changes against the last REGULAR run on the same schedule (or client),
   * before this run exists (finance walk 9). Null when there is no earlier
   * locked run to compare with.
   */
  previous: z
    .object({
      runId: UuidSchema,
      periodStart: z.string(),
      periodEnd: z.string(),
      people: z.number().int().nonnegative(),
      gross: z.number(),
      net: z.number(),
      hours: z.number(),
      /** Per person in that run: what they were paid then. */
      byAssociate: z.array(z.object({ associateId: UuidSchema, associateName: z.string(), hours: z.number(), gross: z.number(), net: z.number() })),
      /** In the last run, not in this preview. */
      missing: z.array(z.object({ associateId: UuidSchema, associateName: z.string(), net: z.number() })),
      /** In this preview, not in the last run. */
      newPeople: z.array(z.object({ associateId: UuidSchema, associateName: z.string() })),
      /** People whose net moved more than 15% either way. */
      moved: z.array(z.object({ associateId: UuidSchema, associateName: z.string(), netDelta: z.number(), netDeltaPct: z.number().nullable() })),
    })
    .nullable()
    .optional(),
}))();
export type PayrollRunPreviewResponse = z.infer<typeof PayrollRunPreviewResponseSchema>;

export const PayrollItemListResponseSchema = /* @__PURE__ */ (() => z.object({
  items: z.array(PayrollItemSchema),
}))();
export type PayrollItemListResponse = z.infer<typeof PayrollItemListResponseSchema>;

/**
 * Authoritative year-to-date totals as of one paystub — every DISBURSED item
 * of that stub's year up to and including it, summed in SQL.
 *
 * The client cannot compute this: GET /payroll/me/items returns only the
 * most recent 50 stubs, so summing what's loaded silently understates YTD
 * once an associate has more (a weekly payer passes 50 inside one year).
 */
export const PayrollItemYtdResponseSchema = /* @__PURE__ */ (() => z.object({
  year: z.number().int(),
  /** Paystubs summed into these totals — lets the UI show what it's based on. */
  paystubCount: z.number().int().nonnegative(),
  gross: z.number(),
  federalWithholding: z.number(),
  fica: z.number(),
  medicare: z.number(),
  stateWithholding: z.number(),
  preTaxDeductions: z.number(),
  postTaxDeductions: z.number(),
  netPay: z.number(),
  employerFica: z.number(),
  employerMedicare: z.number(),
  employerFuta: z.number(),
  employerSuta: z.number(),
  /** Earning kind → YTD amount, for the earnings table's YTD column. */
  byKind: z.record(PayrollEarningKindSchema, z.number()),
  /** Van ride charges inside postTaxDeductions, YTD. */
  transport: z.number().optional(),
  /** State program code → YTD withheld (CA_SDI, NJ_TDI …). */
  stateProgramTaxes: z.record(z.string(), z.number()).optional(),
  /** Itemized deduction key (code|source) → YTD employee and employer amounts. */
  deductions: z.record(z.string(), z.object({ employee: z.number(), employer: z.number() })).optional(),
}))();
export type PayrollItemYtdResponse = z.infer<typeof PayrollItemYtdResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Wave 1.1 — Pay schedules (QuickBooks Online Payroll parity)
 * -------------------------------------------------------------------------- */

export const PayrollFrequencySchema = /* @__PURE__ */ (() => z.enum([
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
  'MONTHLY',
  // PAYEXP: paid each day; a weekly true-up settles overtime and deductions.
  'DAILY',
]))();
export type PayrollFrequency = z.infer<typeof PayrollFrequencySchema>;

export const PayrollScheduleSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  name: z.string().min(1).max(120),
  frequency: PayrollFrequencySchema,
  /** YYYY-MM-DD reference point used to anchor the cadence math. */
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payDateOffsetDays: z.number().int().min(0).max(31),
  isActive: z.boolean(),
  notes: z.string().nullable(),
  associateCount: z.number().int().nonnegative(),
  /** Computed window the wizard treats as the next period to run. */
  nextPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nextPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nextPayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}))();
export type PayrollSchedule = z.infer<typeof PayrollScheduleSchema>;

export const PayrollScheduleListResponseSchema = /* @__PURE__ */ (() => z.object({
  schedules: z.array(PayrollScheduleSchema),
}))();
export type PayrollScheduleListResponse = z.infer<typeof PayrollScheduleListResponseSchema>;

/** One selectable pay-period window in the admin time review picker. */
export const PayPeriodSchema = /* @__PURE__ */ (() => z.object({
  /** YYYY-MM-DD, inclusive. */
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** YYYY-MM-DD, inclusive. */
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** True when today falls inside the period. */
  current: z.boolean(),
  /** True when a payroll run for exactly this window is finalized or paid
   *  (a draft run doesn't count). `current` is computed on the server's
   *  UTC date — clients decide "today's period" from start/end locally. */
  hasRun: z.boolean(),
}))();
export type PayPeriod = z.infer<typeof PayPeriodSchema>;

export const PayPeriodListResponseSchema = /* @__PURE__ */ (() => z.object({
  periods: z.array(PayPeriodSchema),
}))();
export type PayPeriodListResponse = z.infer<typeof PayPeriodListResponseSchema>;

export const PayrollScheduleCreateInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema.nullable().optional(),
  name: z.string().min(1).max(120),
  frequency: PayrollFrequencySchema,
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payDateOffsetDays: z.number().int().min(0).max(31).optional(),
  notes: z.string().max(1000).optional(),
}))();
export type PayrollScheduleCreateInput = z.infer<typeof PayrollScheduleCreateInputSchema>;

export const PayrollScheduleUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().min(1).max(120).optional(),
  frequency: PayrollFrequencySchema.optional(),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payDateOffsetDays: z.number().int().min(0).max(31).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
}))();
export type PayrollScheduleUpdateInput = z.infer<typeof PayrollScheduleUpdateInputSchema>;

export const PayrollScheduleAssignInputSchema = /* @__PURE__ */ (() => z.object({
  associateIds: z.array(UuidSchema).min(1).max(500),
}))();
export type PayrollScheduleAssignInput = z.infer<typeof PayrollScheduleAssignInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Wave 8 — QBO-parity UX
 *
 *  Pre-flight exception triage and a Payroll-home summary card so HR can
 *  open the page and see "next pay date · X paystubs · projected $Y · N
 *  issues" at a glance before opening the wizard.
 * -------------------------------------------------------------------------- */

/**
 * Pre-flight exception kinds. `BLOCKING` items must be resolved (or the
 * associate excluded) before a run can be created. `WARNING` is something
 * a payroll admin should look at but doesn't break the run. `INFO` is
 * heads-up signal (OT spike, unsupported state).
 */
export const PayrollExceptionKindSchema = /* @__PURE__ */ (() => z.enum([
  'MISSING_W4',          // BLOCKING — W2 employee with no W-4 submission
  'MISSING_BANK_ACCOUNT',// WARNING  — no primary payout method on file
  'TERMINATED_IN_RUN',   // WARNING  — terminated <= periodEnd but has hours
  'OT_SPIKE',            // INFO     — > 20 OT hours in this period
  'UNSUPPORTED_STATE',   // BLOCKING — state has no SIT table; nothing would be withheld
  'UNAPPROVED_TIME',     // WARNING  — unapproved hours will NOT be paid this run
  'MISSING_COMP_RECORD', // WARNING  — no comp record; the default rate would apply
  'RETRO_PAY',           // INFO     — a back-dated rate change adds retroactive pay to this run
  'STATE_W4_INCOMPLETE', // WARNING  — the state certificate is missing a field the state needs (MD county)
  'LOCAL_TAX_REVIEW',    // BLOCKING — a local jurisdiction this check owes hasn't been reviewed with the tax adviser
  'LOCAL_TAX_UNRESOLVED',// BLOCKING — the address can't decide a local tax (PA resident with no PSD code …)
  'BELOW_PREVAILING_WAGE', // BLOCKING — a public-works worker paid under the project's prevailing rate
  'APPRENTICE_RATIO',    // WARNING  — more apprentices on a project than the ratio allows
  'WAGE_STATEMENT_INCOMPLETE', // WARNING — the work state's paystub rule needs data not on file (employer address/phone, sick balance)
  'ROTH_CATCH_UP',       // WARNING  — a higher earner's catch-up stops: the plan has no deemed Roth (SECURE 2.0 §603)
  'DEFERRAL_LIMIT',      // INFO     — an annual limit (402(g), catch-up, HSA, FSA) stops part of an election this check
  'UNASSIGNED_SCHEDULE', // WARNING  — approved time in the period but on no pay schedule: not paid by a schedule's run
  'LATE_APPROVED_TIME',  // WARNING  — approved time from an earlier period whose payday passed with no paystub for it (finance walk 1)
]))();
export type PayrollExceptionKind = z.infer<typeof PayrollExceptionKindSchema>;

export const PayrollExceptionSeveritySchema = /* @__PURE__ */ (() => z.enum(['BLOCKING', 'WARNING', 'INFO']))();
export type PayrollExceptionSeverity = z.infer<typeof PayrollExceptionSeveritySchema>;

export const PayrollExceptionSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  associateName: z.string(),
  kind: PayrollExceptionKindSchema,
  severity: PayrollExceptionSeveritySchema,
  /** Short human-readable summary for the UI. */
  message: z.string(),
  /** Optional structured detail (e.g. terminationDate, otHours). */
  detail: z.record(z.unknown()).optional(),
}))();
export type PayrollException = z.infer<typeof PayrollExceptionSchema>;

export const PayrollExceptionsResponseSchema = /* @__PURE__ */ (() => z.object({
  exceptions: z.array(PayrollExceptionSchema),
  /** Counts per severity — handy for the landing page chip. */
  counts: z.object({
    blocking: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
}))();
export type PayrollExceptionsResponse = z.infer<typeof PayrollExceptionsResponseSchema>;

export const PayrollExceptionsInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema.nullable().optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** A run for one pay schedule: exceptions for its people only (paySchedules.ts). */
  payrollScheduleId: UuidSchema.nullable().optional(),
}))();
export type PayrollExceptionsInput = z.infer<typeof PayrollExceptionsInputSchema>;

/**
 * Payroll-home summary. The hero card on AdminPayrollView shows the
 * soonest schedule's projected run plus a snapshot of the most recent run
 * the user can see. `nextRun` is null when no schedule is configured.
 */
export const PayrollUpcomingSummarySchema = /* @__PURE__ */ (() => z.object({
  nextRun: z
    .object({
      scheduleId: UuidSchema,
      scheduleName: z.string(),
      clientId: UuidSchema.nullable(),
      clientName: z.string().nullable(),
      frequency: PayrollFrequencySchema,
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      employeeCount: z.number().int().nonnegative(),
      projectedGross: z.number().nonnegative(),
      projectedNet: z.number(),
      projectedEmployerCost: z.number().nonnegative(),
      blockingExceptions: z.number().int().nonnegative(),
      totalExceptions: z.number().int().nonnegative(),
      /**
       * If a DRAFT run already exists for this exact period, its ID. The
       * landing-page CTA flips from "Run payroll" to "Resume run" and
       * deep-links to that draft instead of opening the wizard.
       */
      draftRunId: UuidSchema.nullable(),
    })
    .nullable(),
  /** Hired people on no pay schedule — the hero's blocker (finance walk 10). */
  peopleOnNoSchedule: z.number().int().nonnegative().optional(),
  /** The next due period for EVERY schedule the caller can run (the per-schedule list on payroll home). */
  bySchedule: z
    .array(
      z.object({
        scheduleId: UuidSchema,
        scheduleName: z.string(),
        frequency: PayrollFrequencySchema,
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /** People on the schedule for some of the period. */
        people: z.number().int().nonnegative(),
        draftRunId: UuidSchema.nullable(),
      }),
    )
    .optional(),
  lastRun: z
    .object({
      id: UuidSchema,
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum(['DRAFT', 'FINALIZED', 'DISBURSED', 'CANCELLED']),
      /** Non-voided paychecks. */
      itemCount: z.number().int().nonnegative(),
      /** The run's STORED net — the number the runs grid and the close page show (apps/api/src/lib/payrollRunTotals.ts). */
      totalNet: z.number(),
      totalGross: z.number().optional(),
      /** The same sums over its paychecks, and whether they agree with the stored totals. */
      itemsNet: z.number().optional(),
      itemsGross: z.number().optional(),
      totalsAgree: z.boolean().optional(),
      finalizedAt: z.string().datetime().nullable(),
      disbursedAt: z.string().datetime().nullable(),
    })
    .nullable(),
}))();
export type PayrollUpcomingSummary = z.infer<typeof PayrollUpcomingSummarySchema>;

// Read-only view of one row from the payroll_config DB table. Powers the
// /payroll/config admin page so HR can sanity-check what tax tables the
// withholding engine is about to use without reading the migration SQL.
export const PayrollConfigBracketSchema = /* @__PURE__ */ (() => z.object({
  over: z.number(),
  flat: z.number(),
  rate: z.number(),
}))();
export const PayrollConfigSchema = /* @__PURE__ */ (() => z.object({
  year: z.number().int(),
  ssWageBase: z.number(),
  medicareSurchargeThreshold: z.number(),
  fedBracketsSingle: z.array(PayrollConfigBracketSchema),
  fedBracketsMfj: z.array(PayrollConfigBracketSchema),
  fedBracketsHoh: z.array(PayrollConfigBracketSchema),
  /** When true, Disburse requires a second approver (not the run's
   *  creator). Surfaced so the UI can disable the button instead of
   *  letting the admin walk the full ceremony into a 409. */
  requireSecondApproval: z.boolean().optional(),
  updatedAt: z.string().datetime(),
}))();
export type PayrollConfigBracket = z.infer<typeof PayrollConfigBracketSchema>;
export type PayrollConfig = z.infer<typeof PayrollConfigSchema>;

/* -------------------------------------------------------------------------- *
 *  Documents — Phase 9 (local-fs storage; S3 swap is future work)
 * -------------------------------------------------------------------------- */

export const DocumentKindSchema = /* @__PURE__ */ (() => z.enum([
  'ID',
  'SSN_CARD',
  'I9_SUPPORTING',
  'W4_PDF',
  'OFFER_LETTER',
  'POLICY',
  'HOUSING_AGREEMENT',
  'TRANSPORT_AGREEMENT',
  'J1_DS2019',
  'J1_VISA',
  'SIGNED_AGREEMENT',
  // HR-uploaded result PDFs from external providers (Checkr, drug-test
  // lab, E-Verify). HR runs the check externally and uploads the result
  // PDF into the associate's profile via /documents/admin/upload.
  'BACKGROUND_CHECK_RESULT',
  'DRUG_TEST_RESULT',
  'I9_VERIFICATION_RESULT',
  // Evidence of an externally-processed payment (paystub, cleared check,
  // processor report) attached to an ExternalPayment pay period.
  'PAYSTUB',
  'OTHER',
]))();
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/** The kinds that make up an identity check — I-9 Section 2 and E-Verify.
 *  Shared so the API's partitioning and the web's bulk-download scoping
 *  can't drift apart. */
export const IDENTITY_DOCUMENT_KINDS = [
  'I9_SUPPORTING',
  'ID',
  'SSN_CARD',
  'J1_VISA',
  'J1_DS2019',
] as const satisfies readonly DocumentKind[];

/**
 * Kinds a document can never be reclassified from or to. These are
 * system-written artifacts whose kind encodes a linkage a relabel would
 * silently corrupt: SIGNED_AGREEMENT ↔ e-sign Signature rows, PAYSTUB ↔
 * ExternalPayment evidence, W4_PDF ↔ the rendered W-4 submission.
 */
export const RECLASSIFY_LOCKED_KINDS = [
  'SIGNED_AGREEMENT',
  'PAYSTUB',
  'W4_PDF',
] as const satisfies readonly DocumentKind[];

/** Fix a misfiled upload: move a document to a different kind bucket. */
export const DocumentReclassifyInputSchema = /* @__PURE__ */ (() => z.object({
  kind: DocumentKindSchema,
}))();
export type DocumentReclassifyInput = z.infer<typeof DocumentReclassifyInputSchema>;

export const DocumentStatusSchema = /* @__PURE__ */ (() => z.enum([
  'UPLOADED',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
]))();
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/* ----- External payments -------------------------------------------------- *
 * Audit documentation for externally-run payroll: HR records each pay
 * period per associate and attaches evidence files (kind=PAYSTUB). All
 * dates are calendar dates (YYYY-MM-DD) — see the dateOnly helpers.
 * -------------------------------------------------------------------------- */

export const ExternalPaymentMethodSchema = /* @__PURE__ */ (() => z.enum([
  'DIRECT_DEPOSIT',
  'CHECK',
  'CASH',
  'PAYROLL_PROVIDER',
  'OTHER',
]))();
export type ExternalPaymentMethod = z.infer<typeof ExternalPaymentMethodSchema>;

export const ExternalPaymentInputSchema = /* @__PURE__ */ (() => z
  .object({
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
    payDate: z.string().date().nullable().optional(),
    grossAmount: z.number().nonnegative().max(1_000_000).nullable().optional(),
    netAmount: z.number().nonnegative().max(1_000_000).nullable().optional(),
    method: ExternalPaymentMethodSchema.default('OTHER'),
    reference: z.string().trim().max(120).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  }))();
export type ExternalPaymentInput = z.infer<typeof ExternalPaymentInputSchema>;

export const ExternalPaymentEvidenceSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.string(),
  /** False when the underlying blob is gone (ephemeral storage wiped). */
  fileAvailable: z.boolean(),
}))();
export type ExternalPaymentEvidence = z.infer<typeof ExternalPaymentEvidenceSchema>;

export const ExternalPaymentSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  periodStart: z.string(), // YYYY-MM-DD
  periodEnd: z.string(), // YYYY-MM-DD
  payDate: z.string().nullable(), // YYYY-MM-DD
  grossAmount: z.number().nullable(),
  netAmount: z.number().nullable(),
  method: ExternalPaymentMethodSchema,
  reference: z.string().nullable(),
  note: z.string().nullable(),
  createdByEmail: z.string().nullable(),
  createdAt: z.string(),
  evidence: z.array(ExternalPaymentEvidenceSchema),
}))();
export type ExternalPayment = z.infer<typeof ExternalPaymentSchema>;

export const ExternalPaymentListResponseSchema = /* @__PURE__ */ (() => z.object({
  payments: z.array(ExternalPaymentSchema),
  total: z.number(),
}))();
export type ExternalPaymentListResponse = z.infer<
  typeof ExternalPaymentListResponseSchema
>;

/* ----- I-9 document catalog ---------------------------------------------- *
 * The federal acceptable-documents lists. Uploads used to land as generic
 * "Photo ID" blobs, so Section 2 verification meant HR guessing which list
 * an image.jpg belonged to. The associate now declares the specific
 * document; the SERVER derives the list from this catalog (the client's
 * claimed list is never trusted).
 *
 * Legacy uploads (before the catalog) carry NULLs everywhere and are never
 * reclassified or invalidated — the submit gate has an explicit legacy
 * pass-through for them.
 * -------------------------------------------------------------------------- */

export const I9DocListSchema = /* @__PURE__ */ (() => z.enum(['A', 'B', 'C']))();
export type I9DocList = z.infer<typeof I9DocListSchema>;

export const DocSideSchema = /* @__PURE__ */ (() => z.enum(['FRONT', 'BACK']))();
export type DocSide = z.infer<typeof DocSideSchema>;

export interface I9CatalogEntry {
  title: string;
  list: I9DocList;
  /** The DocumentKind bucket the file stores under (keeps every existing
   *  consumer — vault, E-Verify packet views, exports — working unchanged). */
  kind: 'ID' | 'SSN_CARD' | 'I9_SUPPORTING';
  /** Card-shaped documents get an optional front/back side tag at upload. */
  card?: boolean;
}

export const I9_DOC_CATALOG: readonly I9CatalogEntry[] = [
  // List A — identity AND employment authorization (sufficient alone).
  { title: 'U.S. Passport or Passport Card', list: 'A', kind: 'ID', card: true },
  { title: 'Permanent Resident Card (Green Card, Form I-551)', list: 'A', kind: 'ID', card: true },
  { title: 'Foreign passport with I-551 stamp or work authorization', list: 'A', kind: 'ID' },
  { title: 'Employment Authorization Document (Form I-766)', list: 'A', kind: 'ID', card: true },
  // List B — identity only (must pair with a List C document).
  { title: "Driver's license", list: 'B', kind: 'ID', card: true },
  { title: 'State ID card', list: 'B', kind: 'ID', card: true },
  { title: 'School ID card with photo', list: 'B', kind: 'ID', card: true },
  { title: 'U.S. Military card or draft record', list: 'B', kind: 'ID', card: true },
  // List C — employment authorization only.
  { title: 'Social Security card (unrestricted)', list: 'C', kind: 'SSN_CARD', card: true },
  { title: 'Birth certificate (original or certified copy)', list: 'C', kind: 'I9_SUPPORTING' },
  { title: 'Native American tribal document', list: 'C', kind: 'I9_SUPPORTING' },
];

export function i9CatalogEntry(title: string): I9CatalogEntry | undefined {
  return I9_DOC_CATALOG.find((e) => e.title === title);
}

/**
 * Does a classified document set satisfy Form I-9? One List A document, OR
 * at least one List B AND one List C. Unclassified (legacy) docs don't
 * count here — callers apply the legacy pass-through separately.
 */
export function i9SetSatisfied(lists: Array<I9DocList | null | undefined>): boolean {
  const has = (l: I9DocList) => lists.includes(l);
  return has('A') || (has('B') && has('C'));
}

export const DocumentRecordSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string().nullable(),
  clientId: UuidSchema.nullable(),
  kind: DocumentKindSchema,
  /** Federal catalog identity — null on legacy uploads + non-I-9 docs. */
  i9DocTitle: z.string().nullable().optional(),
  i9List: I9DocListSchema.nullable().optional(),
  side: DocSideSchema.nullable().optional(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  status: DocumentStatusSchema,
  expiresAt: z.string().datetime().nullable(),
  rejectionReason: z.string().nullable(),
  verifiedById: UuidSchema.nullable(),
  verifierEmail: z.string().email().nullable(),
  verifiedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** True when the underlying file is still on disk. False when the
   * DocumentRecord exists but the upload was lost (e.g. ephemeral
   * filesystem reset on redeploy). UI should disable preview/download
   * and prompt re-upload when false. */
  fileAvailable: z.boolean(),
}))();
export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;

export const DocumentListResponseSchema = /* @__PURE__ */ (() => z.object({
  documents: z.array(DocumentRecordSchema),
  /** Total matching rows. The list is one page, so the UI can say
   *  "showing 1–50 of N" rather than presenting a partial vault as audit
   *  truth. Optional for back-compat. */
  total: z.number().int().nonnegative().optional(),
  /** Zero-based page index this response represents. */
  page: z.number().int().nonnegative().optional(),
  /** Rows per page the server actually applied (it clamps). */
  pageSize: z.number().int().positive().optional(),
}))();
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const DocumentRejectInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().min(1).max(500),
}))();
export type DocumentRejectInput = z.infer<typeof DocumentRejectInputSchema>;

/**
 * The associate document vault — every DocumentRecord on file plus a
 * compliance summary from each domain's ledger, so the profile's Documents
 * tab can pair evidence with the decision it supports ("background PASSED,
 * report on file") instead of showing a flat undated pile.
 *
 * Statuses are plain strings (not the domain enums) — the vault renders
 * them; it is not the write path for any of these ledgers.
 */
export const DocumentVaultSummarySchema = /* @__PURE__ */ (() => z.object({
  i9: z
    .object({
      section1CompletedAt: z.string().datetime().nullable(),
      section2CompletedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  everify: z
    .object({
      status: z.string().nullable(),
      caseNumber: z.string().nullable(),
      closedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  /** Latest background check, or null if never screened. */
  background: z
    .object({
      status: z.string(),
      completedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  /** Latest drug test order + newest result recency (Walmart 60-day rule). */
  drugTest: z
    .object({
      status: z.string().nullable(),
      completedAt: z.string().datetime().nullable(),
      lastResultAt: z.string().datetime().nullable(),
      /** True when the newest DRUG_TEST_RESULT doc is inside the 60-day window. */
      fresh: z.boolean(),
    })
    .nullable(),
  j1: z
    .object({
      programStartDate: z.string(),
      programEndDate: z.string(),
      sponsorAgency: z.string(),
    })
    .nullable(),
}))();
export type DocumentVaultSummary = z.infer<typeof DocumentVaultSummarySchema>;

export const DocumentVaultResponseSchema = /* @__PURE__ */ (() => z.object({
  documents: z.array(DocumentRecordSchema),
  total: z.number().int().nonnegative(),
  summary: DocumentVaultSummarySchema,
}))();
export type DocumentVaultResponse = z.infer<typeof DocumentVaultResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Compliance — Phase 10 (I-9, Background, J-1)
 * -------------------------------------------------------------------------- */

export const I9DocumentListSchema = /* @__PURE__ */ (() => z.enum(['LIST_A', 'LIST_B_AND_C']))();
export type I9DocumentList = z.infer<typeof I9DocumentListSchema>;

export const I9VerificationSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  associateEmail: z.string().email(),
  // Most recent Application id for the associate, used by the HR Section 2
  // verifier to call POST /onboarding/applications/:id/i9/section2. Null when
  // the associate has never had an application (which would also mean they
  // can't have an I-9 — defensive nullable, not an expected case).
  applicationId: UuidSchema.nullable(),
  section1CompletedAt: z.string().datetime().nullable(),
  section2CompletedAt: z.string().datetime().nullable(),
  section2VerifierUserId: UuidSchema.nullable(),
  section2VerifierEmail: z.string().email().nullable(),
  documentList: I9DocumentListSchema.nullable(),
  supportingDocIds: z.array(UuidSchema),
  /** Application start date (YYYY-MM-DD) — anchors the Section 2
   *  3-business-day deadline in the queue. */
  startDate: z.string().nullable().optional(),
  /** Work-authorization expiry (YYYY-MM-DD) — drives the reverification
   *  filter for time-limited statuses. */
  workAuthExpiresAt: z.string().nullable().optional(),
  /** The associate's current client (open assignment, else latest approved
   *  application) — feeds the client filter. Null mid-onboarding. */
  clientId: UuidSchema.nullable().optional(),
  clientName: z.string().nullable().optional(),
  /** Keep the I-9 until this date (YYYY-MM-DD): the later of 3 years from
   *  hire and 1 year from separation. Null until a hire date exists. */
  retainUntil: z.string().nullable().optional(),
  /** Reverification (Supplement B) due on this date (YYYY-MM-DD) — the
   *  work-authorization expiry. Null when the status never expires. */
  reverifyDueAt: z.string().nullable().optional(),
  /** Separated on (ISO instant) — retention runs from here. */
  separatedAt: z.string().datetime().nullable().optional(),
}))();
export type I9Verification = z.infer<typeof I9VerificationSchema>;

export const I9ListResponseSchema = /* @__PURE__ */ (() => z.object({
  i9s: z.array(I9VerificationSchema),
  /** True when more I-9s matched than the list carries. */
  truncated: z.boolean().optional(),
}))();
export type I9ListResponse = z.infer<typeof I9ListResponseSchema>;

export const I9UpsertInputSchema = /* @__PURE__ */ (() => z
  .object({
    section1CompletedAt: z.string().datetime().nullable().optional(),
    section2CompletedAt: z.string().datetime().nullable().optional(),
    documentList: I9DocumentListSchema.nullable().optional(),
    supportingDocIds: z.array(UuidSchema).optional(),
    /** Reverification (Supplement B): renewed work-auth expiry, YYYY-MM-DD.
     *  Null clears it (e.g. status changed to one that never expires). */
    workAuthExpiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'workAuthExpiresAt must be YYYY-MM-DD')
      .nullable()
      .optional(),
  })
  .refine(
    (v) =>
      // Recording section 2 requires the document list — Form I-9 itself
      // requires the verifier to record which list of docs they inspected.
      !v.section2CompletedAt || (v.documentList !== undefined && v.documentList !== null),
    { message: 'documentList is required when recording section 2', path: ['documentList'] }
  ))();
export type I9UpsertInput = z.infer<typeof I9UpsertInputSchema>;

export const BgCheckStatusSchema = /* @__PURE__ */ (() => z.enum([
  'INITIATED',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'NEEDS_REVIEW',
  /** Consent recorded, no screening provider connected — the check never ran. */
  'NOT_RUN',
]))();
export type BgCheckStatus = z.infer<typeof BgCheckStatusSchema>;

export const BackgroundCheckSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  clientId: UuidSchema.nullable(),
  /** Display name for clientId (the check's own client when recorded, else
   *  the associate's current placement) — feeds the client filter. */
  clientName: z.string().nullable().optional(),
  provider: z.string(),
  externalId: z.string().nullable(),
  status: BgCheckStatusSchema,
  initiatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  /** BACKGROUND_CHECK_RESULT documents on file for this associate — a
   *  finalized status with zero reports is a decision with no evidence. */
  reportCount: z.number().int().nonnegative().optional(),
  /** FCRA adjudication (audit 2026-10-21 #14): ENGAGED | PRE_ADVERSE | ADVERSE. */
  adjudication: z.string().nullable().optional(),
  preAdverseSentAt: z.string().datetime().nullable().optional(),
  adverseWaitUntil: z.string().datetime().nullable().optional(),
  adverseSentAt: z.string().datetime().nullable().optional(),
  /** The provider's verdict before adjudication: clear | consider. */
  result: z.string().nullable().optional(),
  /** Ordered through a connected provider — adverse action runs in its panel. */
  viaProvider: z.boolean().optional(),
}))();
export type BackgroundCheck = z.infer<typeof BackgroundCheckSchema>;

/** The FCRA adverse-action worklist (GET /compliance/adverse-actions). */
export const AdverseActionStageSchema = /* @__PURE__ */ (() => z.enum(['FINAL_DUE', 'DECIDE', 'WAITING', 'DONE']))();
export type AdverseActionStage = z.infer<typeof AdverseActionStageSchema>;

export const AdverseActionRowSchema = /* @__PURE__ */ (() => z.object({
  checkId: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  stage: AdverseActionStageSchema,
  waitUntil: z.string().datetime().nullable(),
  preAdverseSentAt: z.string().datetime().nullable(),
  adverseSentAt: z.string().datetime().nullable(),
  result: z.string().nullable(),
  status: BgCheckStatusSchema,
  viaProvider: z.boolean(),
}))();
export type AdverseActionRow = z.infer<typeof AdverseActionRowSchema>;

export const AdverseActionListResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(AdverseActionRowSchema),
}))();
export type AdverseActionListResponse = z.infer<typeof AdverseActionListResponseSchema>;

/**
 * Voluntary EEO self-identification (audit 2026-10-21 #14). Submitted by the
 * applicant on their own page or by the new hire on their checklist; stored
 * apart from the candidate and the application, read only in aggregate.
 */
export const EEO_GENDER_VALUES = ['FEMALE', 'MALE', 'NONBINARY', 'DECLINE'] as const;
export const EEO_ETHNICITY_VALUES = [
  'HISPANIC_OR_LATINO',
  'WHITE',
  'BLACK_OR_AFRICAN_AMERICAN',
  'NATIVE_HAWAIIAN_OR_PACIFIC_ISLANDER',
  'ASIAN',
  'AMERICAN_INDIAN_OR_ALASKA_NATIVE',
  'TWO_OR_MORE_RACES',
  'DECLINE',
] as const;
export const EEO_VETERAN_VALUES = ['PROTECTED', 'NOT_PROTECTED', 'DECLINE'] as const;
export const EEO_DISABILITY_VALUES = ['YES', 'NO', 'DECLINE'] as const;

export const EeoSelfIdInputSchema = /* @__PURE__ */ (() => z.object({
  /** The whole form declined — nothing else is kept. */
  declined: z.boolean().optional(),
  gender: z.enum(EEO_GENDER_VALUES).nullable().optional(),
  ethnicity: z.enum(EEO_ETHNICITY_VALUES).nullable().optional(),
  veteranStatus: z.enum(EEO_VETERAN_VALUES).nullable().optional(),
  disabilityStatus: z.enum(EEO_DISABILITY_VALUES).nullable().optional(),
}))();
export type EeoSelfIdInput = z.infer<typeof EeoSelfIdInputSchema>;

/** A count, or '<5' when the bucket is too small to publish. */
export const EeoBucketCountSchema = /* @__PURE__ */ (() => z.union([z.number().int().nonnegative(), z.literal('<5')]))();

export const EeoApplicantReportSchema = /* @__PURE__ */ (() => z.object({
  from: z.string(),
  to: z.string(),
  /** Candidates created plus applications invited in the window. */
  applicants: z.number().int().nonnegative(),
  responses: EeoBucketCountSchema,
  declined: EeoBucketCountSchema,
  gender: z.record(z.string(), EeoBucketCountSchema),
  ethnicity: z.record(z.string(), EeoBucketCountSchema),
  veteranStatus: z.record(z.string(), EeoBucketCountSchema),
  disabilityStatus: z.record(z.string(), EeoBucketCountSchema),
}))();
export type EeoApplicantReport = z.infer<typeof EeoApplicantReportSchema>;

export const BackgroundCheckListResponseSchema = /* @__PURE__ */ (() => z.object({
  checks: z.array(BackgroundCheckSchema),
}))();
export type BackgroundCheckListResponse = z.infer<typeof BackgroundCheckListResponseSchema>;

export const BackgroundInitiateInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  provider: z.string().min(1).max(80).default('alto-stub'),
  /** The provider's own reference (e.g. Checkr candidate/report id) so a
   *  check ordered in an external portal is traceable from here. */
  externalId: z.string().max(120).optional(),
}))();
export type BackgroundInitiateInput = z.infer<typeof BackgroundInitiateInputSchema>;

export const BackgroundUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  status: BgCheckStatusSchema,
  externalId: z.string().max(120).optional(),
}))();
export type BackgroundUpdateInput = z.infer<typeof BackgroundUpdateInputSchema>;

/**
 * Bulk Checkr ordering — associates who have never been screened, shaped for
 * the provider's bulk-invitation CSV (email required; first name and phone
 * optional — Checkr collects DOB/SSN from the candidate directly, so no
 * heavy PII leaves this system).
 */
export const BackgroundPendingRowSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  /** Same derivation as DirectoryStatus (defined inline — that schema is
   *  declared later in this module): APPROVED application ⇒ ACTIVE,
   *  in-flight ⇒ PENDING (onboarding), otherwise INACTIVE. */
  status: z.enum(['ACTIVE', 'PENDING', 'INACTIVE']),
}))();
export type BackgroundPendingRow = z.infer<typeof BackgroundPendingRowSchema>;

export const BackgroundPendingResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(BackgroundPendingRowSchema),
  /** True when more than the 500-row cap matched — the CSV is partial. */
  truncated: z.boolean(),
}))();
export type BackgroundPendingResponse = z.infer<typeof BackgroundPendingResponseSchema>;

/** Recorded AFTER the CSV upload to the provider succeeds — downloading a
 *  file is not ordering, so the download itself marks nothing. */
export const BackgroundBulkInitiateInputSchema = /* @__PURE__ */ (() => z.object({
  associateIds: z.array(UuidSchema).min(1).max(500),
  provider: z.string().min(1).max(80).default('checkr'),
}))();
export type BackgroundBulkInitiateInput = z.infer<typeof BackgroundBulkInitiateInputSchema>;

export const BackgroundBulkInitiateResponseSchema = /* @__PURE__ */ (() => z.object({
  created: z.number().int().nonnegative(),
  /** Already had a check by the time this ran (raced with another admin). */
  skipped: z.number().int().nonnegative(),
}))();
export type BackgroundBulkInitiateResponse = z.infer<typeof BackgroundBulkInitiateResponseSchema>;

/** An HR-uploaded provider report on file for the check's associate. */
export const BackgroundReportDocSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  kind: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  fileAvailable: z.boolean(),
}))();
export type BackgroundReportDoc = z.infer<typeof BackgroundReportDocSchema>;

/**
 * Drawer payload: the check plus its associate's report documents — the same
 * evidence-next-to-decision aggregation the E-Verify case detail does with
 * closure packets. Reports attach to the ASSOCIATE (by document kind), so an
 * associate re-screened twice shares one report pool across both checks.
 */
export const BackgroundCheckDetailSchema = /* @__PURE__ */ (() => z.object({
  check: BackgroundCheckSchema,
  reports: z.array(BackgroundReportDocSchema),
}))();
export type BackgroundCheckDetail = z.infer<typeof BackgroundCheckDetailSchema>;

/* ----- Drug tests --------------------------------------------------------- *
 * Mirrors the background-check surface. The difference is recurrence: the
 * Walmart SOW requires a result within 60 DAYS, so "needs a test" means the
 * last DRUG_TEST_RESULT document is stale (or absent), not "never had a row".
 * -------------------------------------------------------------------------- */

export const DrugTestStatusSchema = /* @__PURE__ */ (() => z.enum([
  'INITIATED',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'NEEDS_REVIEW',
]))();
export type DrugTestStatus = z.infer<typeof DrugTestStatusSchema>;

export const DrugTestSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  clientId: UuidSchema.nullable(),
  /** Display name for clientId (the test's own client when recorded, else
   *  the associate's current placement) — feeds the client filter. */
  clientName: z.string().nullable().optional(),
  provider: z.string(),
  externalId: z.string().nullable(),
  status: DrugTestStatusSchema,
  initiatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  /** DRUG_TEST_RESULT documents on file for this associate. */
  reportCount: z.number().int().nonnegative().optional(),
}))();
export type DrugTest = z.infer<typeof DrugTestSchema>;

export const DrugTestListResponseSchema = /* @__PURE__ */ (() => z.object({
  tests: z.array(DrugTestSchema),
}))();
export type DrugTestListResponse = z.infer<typeof DrugTestListResponseSchema>;

export const DrugTestInitiateInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  provider: z.string().min(1).max(80).default('checkr'),
  externalId: z.string().max(120).optional(),
}))();
export type DrugTestInitiateInput = z.infer<typeof DrugTestInitiateInputSchema>;

export const DrugTestUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  status: DrugTestStatusSchema,
  externalId: z.string().max(120).optional(),
}))();
export type DrugTestUpdateInput = z.infer<typeof DrugTestUpdateInputSchema>;

export const DrugTestPendingRowSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  /** Same derivation as DirectoryStatus: APPROVED application ⇒ ACTIVE,
   *  in-flight ⇒ PENDING (onboarding), otherwise INACTIVE. */
  status: z.enum(['ACTIVE', 'PENDING', 'INACTIVE']),
  /** When their newest result document was filed — null means never tested;
   *  a date here means the result aged past the 60-day window. */
  lastResultAt: z.string().datetime().nullable(),
}))();
export type DrugTestPendingRow = z.infer<typeof DrugTestPendingRowSchema>;

export const DrugTestPendingResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(DrugTestPendingRowSchema),
  truncated: z.boolean(),
}))();
export type DrugTestPendingResponse = z.infer<typeof DrugTestPendingResponseSchema>;

export const DrugTestBulkInitiateInputSchema = /* @__PURE__ */ (() => z.object({
  associateIds: z.array(UuidSchema).min(1).max(500),
  provider: z.string().min(1).max(80).default('checkr'),
}))();
export type DrugTestBulkInitiateInput = z.infer<typeof DrugTestBulkInitiateInputSchema>;

export const DrugTestBulkInitiateResponseSchema = /* @__PURE__ */ (() => z.object({
  created: z.number().int().nonnegative(),
  /** Gained an open order by the time this ran (raced with another admin). */
  skipped: z.number().int().nonnegative(),
}))();
export type DrugTestBulkInitiateResponse = z.infer<typeof DrugTestBulkInitiateResponseSchema>;

export const DrugTestDetailSchema = /* @__PURE__ */ (() => z.object({
  test: DrugTestSchema,
  /** Same doc shape as background reports — both render in the doc viewer. */
  reports: z.array(BackgroundReportDocSchema),
}))();
export type DrugTestDetail = z.infer<typeof DrugTestDetailSchema>;

export const J1ProfileSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  associateEmail: z.string().email(),
  programStartDate: z.string(),
  programEndDate: z.string(),
  ds2019Number: z.string(),
  sponsorAgency: z.string(),
  visaNumber: z.string().nullable(),
  sevisId: z.string().nullable(),
  country: z.string(),
  /** Server-computed: days from now until programEndDate (negative = expired). */
  daysUntilEnd: z.number().int(),
}))();
export type J1Profile = z.infer<typeof J1ProfileSchema>;

export const J1ListResponseSchema = /* @__PURE__ */ (() => z.object({
  profiles: z.array(J1ProfileSchema),
  /** True when more profiles matched than the list carries. */
  truncated: z.boolean().optional(),
}))();
export type J1ListResponse = z.infer<typeof J1ListResponseSchema>;

export const J1UpsertInputSchema = /* @__PURE__ */ (() => z
  .object({
    programStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    programEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ds2019Number: z.string().min(1).max(80),
    sponsorAgency: z.string().min(1).max(120),
    visaNumber: z.string().max(80).nullable().optional(),
    sevisId: z.string().max(80).nullable().optional(),
    country: z.string().min(1).max(80),
  })
  .refine((v) => v.programEndDate >= v.programStartDate, {
    message: 'programEndDate must be on or after programStartDate',
    path: ['programEndDate'],
  }))();
export type J1UpsertInput = z.infer<typeof J1UpsertInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Analytics — Phase 11
 * -------------------------------------------------------------------------- */

/** One KPI's weekly trend: 8 UTC-week buckets (oldest → current; the last
 *  bucket is the in-progress week) plus the change between the last two
 *  complete weeks. */
export const KpiTrendSchema = /* @__PURE__ */ (() => z.object({
  /** Weekly values, oldest first; last bucket is the in-progress week. */
  series: z.array(z.number()),
  /** Last complete week minus the week before it (absolute change). */
  delta: z.number(),
}))();
export type KpiTrend = z.infer<typeof KpiTrendSchema>;

export const DashboardKPIsSchema = /* @__PURE__ */ (() => z.object({
  /** "Working": the one definition of active (lib/activeDefinition) over activeWindowDays. */
  activeAssociates: z.number().int().nonnegative(),
  /** "On the books": hired and not separated (peopleStatus.ts), in the caller's reach. */
  onTheBooks: z.number().int().nonnegative().optional(),
  /** The company's active window in days (OrgSetting.activeWindowDays) — what "Working" is measured over. */
  activeWindowDays: z.number().int().positive().optional(),
  openShiftsNext30d: z.number().int().nonnegative(),
  associatesClockedIn: z.number().int().nonnegative(),
  pendingOnboardingApplications: z.number().int().nonnegative(),
  pendingI9Section2: z.number().int().nonnegative(),
  pendingDocumentReviews: z.number().int().nonnegative(),
  /** Sum of NET pay across all DISBURSED runs in the requested window. */
  netPaidLast30d: z.number().nonnegative(),
  /** Sum of NET pay across DRAFT + FINALIZED runs (pending disbursement). */
  netPendingDisbursement: z.number().nonnegative(),
  /** Bucketed counts for chart rendering. */
  applicationStatusCounts: z.record(z.number().int().nonnegative()),
  /** The window (in days) the time-bounded fields above were computed for.
   *  Default 30; overridable via ?days=N on /analytics/dashboard. The legacy
   *  field names retain "30d"/"Next30d" for back-compat. */
  windowDays: z.number().int().positive().default(30),
  /** Optional weekly micro-trends keyed by series name (`hoursWorked`,
   *  `shiftsScheduled`, `applications`, `hires`). All-optional so older
   *  clients — and older servers — interop without a lockstep deploy. */
  trends: z.record(KpiTrendSchema).optional(),
}))();
export type DashboardKPIs = z.infer<typeof DashboardKPIsSchema>;

/* -------------------------------------------------------------------------- *
 *  Communications — Phase 12 (stubbed providers; queue-based)
 * -------------------------------------------------------------------------- */

export const NotificationChannelSchema = /* @__PURE__ */ (() => z.enum(['SMS', 'PUSH', 'EMAIL', 'IN_APP', 'WHATSAPP']))();
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationStatusSchema = /* @__PURE__ */ (() => z.enum([
  'QUEUED',
  'SENT',
  'FAILED',
  'READ',
  // EMAIL only — async statuses driven by Resend's event webhook and the
  // do-not-email suppression list.
  'BOUNCED',
  'COMPLAINED',
  'SUPPRESSED',
  // WHATSAPP — the handset took it (Brief 1C-4); read lands as READ.
  'DELIVERED',
  // SMS / PUSH — no provider is configured, so nothing left the building.
  // Recorded instead of SENT so the sent log never claims a text went out.
  'NOT_CONFIGURED',
]))();
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

export const NotificationSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  channel: NotificationChannelSchema,
  status: NotificationStatusSchema,
  recipientUserId: UuidSchema.nullable(),
  recipientPhone: z.string().nullable(),
  recipientEmail: z.string().email().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  category: z.string().nullable(),
  externalRef: z.string().nullable(),
  // Resend's message id for real EMAIL sends; what the events webhook
  // matches bounces/complaints against. Optional for back-compat.
  providerMessageId: z.string().nullable().optional(),
  failureReason: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  /** Seen ≠ read: seenAt clears the bell badge (stamped when the panel
   *  opens); readAt clears the row highlight (stamped on click).
   *  Optional for back-compat with rows serialized before the column. */
  seenAt: z.string().datetime().nullable().optional(),
  senderUserId: UuidSchema.nullable(),
  senderEmail: z.string().email().nullable(),
  // Optional in-app deeplink. When set, the bell renders the row as a
  // link rather than just marking-read on click. First user: payroll
  // failure notifications point at /payroll?run={runId}.
  linkUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  /** Admin log only: the recipient account's person (or account email) —
   *  so the sent log names people, not user ids. */
  recipientName: z.string().nullable().optional(),
}))();
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListResponseSchema = /* @__PURE__ */ (() => z.object({
  notifications: z.array(NotificationSchema),
  /** Total matching rows. The inbox is capped per request, and without
   *  this the bell silently stopped at the cap — notification N+1 was
   *  unreachable with no indication it existed. Optional for back-compat. */
  total: z.number().int().nonnegative().optional(),
}))();
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const NotificationSendInputSchema = /* @__PURE__ */ (() => z
  .object({
    channel: NotificationChannelSchema,
    recipientUserId: UuidSchema.optional(),
    /** The person picked in the composer; the server resolves their account,
     *  email and phone (whichever the channel needs). */
    recipientAssociateId: UuidSchema.optional(),
    // max 40 matches the directory's stored phone length — the send
    // dialog auto-fills from the directory, and a legally-stored
    // 21+-char number ("+1 (555) 123-4567 ext 22") must not 400.
    recipientPhone: z.string().min(5).max(40).optional(),
    recipientEmail: z.string().email().optional(),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(4000),
    category: z.string().min(1).max(80).optional(),
  })
  .refine(
    (v) => v.recipientUserId || v.recipientAssociateId || v.recipientPhone || v.recipientEmail,
    { message: 'one of recipientUserId / recipientAssociateId / recipientPhone / recipientEmail is required' }
  )
  .refine(
    (v) => v.channel !== 'IN_APP' || !!v.recipientUserId || !!v.recipientAssociateId,
    { message: 'IN_APP notifications require recipientUserId', path: ['channel'] }
  )
  .refine(
    (v) => v.channel !== 'SMS' || !!v.recipientPhone || !!v.recipientUserId || !!v.recipientAssociateId,
    { message: 'SMS requires recipientPhone or recipientUserId', path: ['channel'] }
  ))();
export type NotificationSendInput = z.infer<typeof NotificationSendInputSchema>;

export const NotificationBroadcastInputSchema = /* @__PURE__ */ (() => z.object({
  channel: NotificationChannelSchema.exclude(['SMS']),
  audience: z.enum(['ALL_ASSOCIATES', 'ALL_HR']),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(4000),
  category: z.string().min(1).max(80).optional(),
}))();
export type NotificationBroadcastInput = z.infer<typeof NotificationBroadcastInputSchema>;

/* ----- Email suppression list (do-not-email) --------------------------- */

export const EmailSuppressionReasonSchema = /* @__PURE__ */ (() => z.enum(['BOUNCED', 'COMPLAINED', 'MANUAL']))();
export type EmailSuppressionReason = z.infer<typeof EmailSuppressionReasonSchema>;

export const EmailSuppressionSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  email: z.string().email(),
  reason: EmailSuppressionReasonSchema,
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
}))();
export type EmailSuppression = z.infer<typeof EmailSuppressionSchema>;

export const EmailSuppressionListResponseSchema = /* @__PURE__ */ (() => z.object({
  suppressions: z.array(EmailSuppressionSchema),
}))();
export type EmailSuppressionListResponse = z.infer<typeof EmailSuppressionListResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Performance — Phase 13
 * -------------------------------------------------------------------------- */

export const PerformanceReviewStatusSchema = /* @__PURE__ */ (() => z.enum([
  'DRAFT',
  'SUBMITTED',
  'ACKNOWLEDGED',
]))();
export type PerformanceReviewStatus = z.infer<typeof PerformanceReviewStatusSchema>;

export const PerformanceReviewSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  reviewerUserId: UuidSchema.nullable(),
  reviewerEmail: z.string().email().nullable(),
  sourcePipId: UuidSchema.nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  overallRating: z.number().int().min(1).max(5),
  summary: z.string(),
  strengths: z.string().nullable(),
  improvements: z.string().nullable(),
  goals: z.string().nullable(),
  status: PerformanceReviewStatusSchema,
  submittedAt: z.string().datetime().nullable(),
  acknowledgedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
}))();
export type PerformanceReview = z.infer<typeof PerformanceReviewSchema>;

export const PerformanceReviewListResponseSchema = /* @__PURE__ */ (() => z.object({
  reviews: z.array(PerformanceReviewSchema),
}))();
export type PerformanceReviewListResponse = z.infer<typeof PerformanceReviewListResponseSchema>;

export const PerformanceReviewCreateInputSchema = /* @__PURE__ */ (() => z
  .object({
    associateId: UuidSchema,
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    overallRating: z.number().int().min(1).max(5),
    summary: z.string().min(1).max(4000),
    strengths: z.string().max(2000).optional(),
    improvements: z.string().max(2000).optional(),
    goals: z.string().max(2000).optional(),
    // Closed PIP that this review summarises, if any. The API validates
    // the PIP belongs to the same associate before persisting.
    sourcePipId: UuidSchema.optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  }))();
export type PerformanceReviewCreateInput = z.infer<typeof PerformanceReviewCreateInputSchema>;

export const PerformanceReviewUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  overallRating: z.number().int().min(1).max(5).optional(),
  summary: z.string().min(1).max(4000).optional(),
  strengths: z.string().max(2000).nullable().optional(),
  improvements: z.string().max(2000).nullable().optional(),
  goals: z.string().max(2000).nullable().optional(),
}))();
export type PerformanceReviewUpdateInput = z.infer<typeof PerformanceReviewUpdateInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Recruiting — Phase 14
 * -------------------------------------------------------------------------- */

export const CandidateStageSchema = /* @__PURE__ */ (() => z.enum([
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
]))();
export type CandidateStage = z.infer<typeof CandidateStageSchema>;

export const CandidateSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  position: z.string().nullable(),
  source: z.string().nullable(),
  stage: CandidateStageSchema,
  notes: z.string().nullable(),
  resumeUrl: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  hiredAssociateId: UuidSchema.nullable(),
  hiredClientId: UuidSchema.nullable(),
  hiredAt: z.string().datetime().nullable(),
  rejectedReason: z.string().nullable(),
  withdrawnReason: z.string().nullable(),
  /** When they entered their current stage — "days in stage" reads this. */
  stageChangedAt: z.string().datetime(),
  /** The posting they applied to or are hired against — what a hire fills. */
  jobPostingId: UuidSchema.nullable(),
  createdAt: z.string().datetime(),
}))();
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidateListResponseSchema = /* @__PURE__ */ (() => z.object({
  candidates: z.array(CandidateSchema),
  /** Everyone matching the filters — the page is `candidates`. */
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
}))();
export type CandidateListResponse = z.infer<typeof CandidateListResponseSchema>;

export const CandidateSortSchema = /* @__PURE__ */ (() => z.enum(['newest', 'oldest', 'name', 'waiting', 'moved']))();
export type CandidateSort = z.infer<typeof CandidateSortSchema>;

/**
 * The candidate list's filters, as the page keeps them in its URL and a
 * saved view stores them. All optional; the server does the filtering.
 */
export const CandidateFiltersSchema = /* @__PURE__ */ (() => z.object({
  q: z.string().trim().max(120).optional(),
  /** One stage, or several comma-separated. */
  stage: z.string().max(120).optional(),
  source: z.string().trim().max(80).optional(),
  jobPostingId: z.string().uuid().optional(),
  /** In an open stage for a week or more. */
  stuck: z.enum(['1']).optional(),
  sort: CandidateSortSchema.optional(),
}))();
export type CandidateFilters = z.infer<typeof CandidateFiltersSchema>;

/** The board: every stage's count, and the first page of each column. */
export const CandidateBoardResponseSchema = /* @__PURE__ */ (() => z.object({
  columns: z.array(
    z.object({
      stage: CandidateStageSchema,
      total: z.number().int(),
      candidates: z.array(CandidateSchema),
    }),
  ),
}))();
export type CandidateBoardResponse = z.infer<typeof CandidateBoardResponseSchema>;

/* ----- Saved views ---------------------------------------------------------- */

export const SavedViewScopeSchema = /* @__PURE__ */ (() => z.enum(['recruiting.candidates', 'people.directory', 'onboarding.applications', 'clients.list']))();
export type SavedViewScope = z.infer<typeof SavedViewScopeSchema>;

/** A view's query: the list's own URL params — short strings only. */
export const SavedViewQuerySchema = /* @__PURE__ */ (() => z
  .record(z.string().max(40), z.string().max(200))
  .refine((q) => Object.keys(q).length <= 20, 'Too many filters'))();

export const SavedViewSchema = /* @__PURE__ */ (() => z.object({
  id: z.string().uuid(),
  scope: SavedViewScopeSchema,
  name: z.string(),
  query: SavedViewQuerySchema,
  shared: z.boolean(),
  mine: z.boolean(),
  ownerName: z.string(),
  updatedAt: z.string(),
}))();
export type SavedView = z.infer<typeof SavedViewSchema>;

export const SavedViewInputSchema = /* @__PURE__ */ (() => z.object({
  scope: SavedViewScopeSchema,
  name: z.string().trim().min(1).max(60),
  query: SavedViewQuerySchema,
  shared: z.boolean().optional(),
}))();
export type SavedViewInput = z.infer<typeof SavedViewInputSchema>;

export const SavedViewUpdateSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(1).max(60).optional(),
  query: SavedViewQuerySchema.optional(),
  shared: z.boolean().optional(),
}))();
export type SavedViewUpdate = z.infer<typeof SavedViewUpdateSchema>;

export const CandidateCreateInputSchema = /* @__PURE__ */ (() => z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  position: z.string().max(120).optional(),
  source: z.string().max(80).optional(),
  notes: z.string().max(2000).optional(),
  resumeUrl: httpUrl(2000).optional(),
  linkedinUrl: httpUrl(2000).optional(),
  jobPostingId: UuidSchema.nullable().optional(),
}))();
export type CandidateCreateInput = z.infer<typeof CandidateCreateInputSchema>;

// Public careers-site application body. A superset of the recruiter-facing
// CandidateCreateInputSchema with two extras:
//  - `website` is a honeypot — bots fill every visible-looking field, so a
//    non-empty value lets us 200-OK the request without persisting.
//  - `source` defaults to "CAREERS_PAGE" server-side; sites can override
//    (e.g. "indeed-redirect") to track funnels.
export const CareersApplyInputSchema = /* @__PURE__ */ (() => z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(40).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  resumeUrl: httpUrl(2000).optional().nullable(),
  linkedinUrl: httpUrl(2000).optional().nullable(),
  source: z.string().max(80).optional().nullable(),
  // Honeypot: must be empty/missing for legitimate submissions.
  website: z.string().max(500).optional().nullable(),
}))();
export type CareersApplyInput = z.infer<typeof CareersApplyInputSchema>;

export const CandidateUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  phone: z.string().max(40).nullable().optional(),
  position: z.string().max(120).nullable().optional(),
  source: z.string().max(80).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  jobPostingId: UuidSchema.nullable().optional(),
}))();
export type CandidateUpdateInput = z.infer<typeof CandidateUpdateInputSchema>;

export const CandidateAdvanceInputSchema = /* @__PURE__ */ (() => z
  .object({
    stage: CandidateStageSchema,
    rejectedReason: z.string().min(1).max(500).optional(),
    withdrawnReason: z.string().min(1).max(500).optional(),
  })
  .refine(
    (v) => v.stage !== 'REJECTED' || !!v.rejectedReason,
    { message: 'rejectedReason is required when moving to REJECTED', path: ['rejectedReason'] }
  )
  .refine(
    (v) => v.stage !== 'WITHDRAWN' || !!v.withdrawnReason,
    { message: 'withdrawnReason is required when moving to WITHDRAWN', path: ['withdrawnReason'] }
  )
  .refine(
    (v) => v.stage !== 'HIRED',
    { message: 'use POST /candidates/:id/hire to move to HIRED (creates Associate)', path: ['stage'] }
  ))();
export type CandidateAdvanceInput = z.infer<typeof CandidateAdvanceInputSchema>;

/**
 * Hiring a candidate IS inviting them to onboarding: the same fields as
 * ApplicationCreateInput, minus the name and email the candidate already
 * carries. Client and template are required — a hire with neither used to
 * create a bare associate record and leave HR to re-type everything into
 * a separate invite.
 */
export const CandidateHireInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  templateId: UuidSchema,
  locationId: UuidSchema.optional(),
  position: z.string().min(1).max(120).optional(),
  startDate: z.string().datetime().optional(),
  employmentType: EmploymentTypeSchema.optional(),
  hireRole: HireableRoleSchema.optional(),
  /** The accepted offer whose pay becomes their starting rate. */
  offerId: UuidSchema.optional(),
}))();
export type CandidateHireInput = z.infer<typeof CandidateHireInputSchema>;

export const CandidateHireResponseSchema = /* @__PURE__ */ (() => CandidateSchema.extend({
  applicationId: UuidSchema,
  /** Dev-stub only: the invite link when email isn't configured. */
  inviteUrl: z.string().nullable(),
  /** Whether the accepted offer's pay was recorded as their starting rate. */
  payRecorded: z.boolean(),
  /**
   * When the onboarding invite email goes out — it waits a few seconds so
   * the hire can be undone before it does. Null when it went out already
   * (or email isn't configured).
   */
  emailDueAt: z.string().nullable().optional(),
}))();
export type CandidateHireResponse = z.infer<typeof CandidateHireResponseSchema>;

export const CandidateEventKindSchema = /* @__PURE__ */ (() => z.enum([
  'CREATED',
  'APPLIED_AGAIN',
  'EDITED',
  'STAGE_CHANGED',
  'NOTE',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_RESCHEDULED',
  'INTERVIEW_SCORED',
  'INTERVIEW_CANCELLED',
  'OFFER_CREATED',
  'OFFER_APPROVAL_REQUESTED',
  'OFFER_APPROVED',
  'OFFER_APPROVAL_DECLINED',
  'OFFER_SENT',
  'OFFER_DECIDED',
  'SUBMITTED_TO_CLIENT',
  'CLIENT_FEEDBACK',
  'HIRED',
  'HIRE_UNDONE',
  'REMOVED',
  'RESTORED',
  // The candidate's own page (routes/candidatePortal).
  'PORTAL_LINK_SENT',
  'INTERVIEW_CONFIRMED',
  'DOCUMENT_REQUESTED',
  'DOCUMENT_UPLOADED',
  'DOCUMENT_REVIEWED',
]))();
export type CandidateEventKind = z.infer<typeof CandidateEventKindSchema>;

/** One entry on a candidate's timeline. */
export const CandidateEventSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  kind: CandidateEventKindSchema,
  fromStage: CandidateStageSchema.nullable(),
  toStage: CandidateStageSchema.nullable(),
  body: z.string().nullable(),
  actorName: z.string().nullable(),
  createdAt: z.string().datetime(),
}))();
export type CandidateEvent = z.infer<typeof CandidateEventSchema>;

export const CandidateEventListResponseSchema = /* @__PURE__ */ (() => z.object({
  events: z.array(CandidateEventSchema),
}))();
export type CandidateEventListResponse = z.infer<typeof CandidateEventListResponseSchema>;

/**
 * A structured scorecard: every kit question rated on the same four-point
 * scale, with notes, plus an overall summary. Ratings on one scale are
 * what let several interviewers' scorecards be read side by side and
 * averaged — free-text answers alone could only be read one at a time.
 */
export const SCORECARD_RATINGS = [
  { value: 4, label: 'Strong' },
  { value: 3, label: 'Good' },
  { value: 2, label: 'Mixed' },
  { value: 1, label: 'Weak' },
] as const;

export const InterviewScorecardSchema = /* @__PURE__ */ (() => z.object({
  answers: z
    .array(
      z.object({
        prompt: z.string().min(1).max(1000),
        rating: z.number().int().min(1).max(4).nullable(),
        notes: z.string().max(4000),
      }),
    )
    .max(50),
  summary: z.string().max(8000),
}))();
export type InterviewScorecard = z.infer<typeof InterviewScorecardSchema>;

export const CandidateNoteInputSchema = /* @__PURE__ */ (() => z.object({
  body: z.string().trim().min(1).max(4000),
}))();
export type CandidateNoteInput = z.infer<typeof CandidateNoteInputSchema>;

/** A candidate named on the recruiter's dashboard. */
const RecruitingSummaryCandidateSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  name: z.string(),
  position: z.string().nullable(),
  stage: CandidateStageSchema,
  daysInStage: z.number().int(),
}))();

/** The recruiter's dashboard: what's in the pipeline and what's waiting. */
export const RecruitingSummarySchema = /* @__PURE__ */ (() => z.object({
  /** Open candidates per stage (Applied → Offer). */
  byStage: z.object({
    APPLIED: z.number().int(),
    SCREENING: z.number().int(),
    INTERVIEW: z.number().int(),
    OFFER: z.number().int(),
  }),
  /** Days a candidate may sit in one stage before they count as stuck. */
  stuckAfterDays: z.number().int(),
  stuckCount: z.number().int(),
  /** Longest-waiting first. */
  stuck: z.array(RecruitingSummaryCandidateSchema),
  interviewsToday: z.array(
    z.object({
      id: UuidSchema,
      candidateId: UuidSchema,
      candidateName: z.string(),
      scheduledFor: z.string().datetime(),
    }),
  ),
  interviewsNext7Days: z.number().int(),
  /** Interviews that have happened but have no score yet. */
  unscoredInterviews: z.number().int(),
  offersAwaitingReply: z.number().int(),
  /** Offers held because their pay is outside the client's band. */
  offersAwaitingApproval: z.number().int(),
  hiredThisMonth: z.number().int(),
  /** Median days from applying to hired, over hires in the last 90 days. */
  medianDaysToHire: z.number().nullable(),
}))();
export type RecruitingSummary = z.infer<typeof RecruitingSummarySchema>;

/* ----- Recruiting analytics ----------------------------------------------- *
 * The recruiting dashboard: how candidates move through the funnel, how
 * fast roles fill, where hires come from and what each source costs,
 * how offers land and how each client's orders are filled — and whether
 * the people hired stay 90 days, by source and by who hired them.
 * Rates are 0–100, rounded; null when there is nothing to divide by.
 * ------------------------------------------------------------------------- */

const RateSchema = /* @__PURE__ */ (() => z.number().min(0).max(100).nullable())();

export const RecruitingFunnelStageSchema = /* @__PURE__ */ (() => z.object({
  stage: z.enum(['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED']),
  /** Candidates from the range who got at least this far. */
  reached: z.number().int(),
  /** Of those, the share who reached the next stage. */
  toNextPct: RateSchema,
}))();

export const RecruitingSourceRowSchema = /* @__PURE__ */ (() => z.object({
  /** The Candidate.source key; null when none was recorded. */
  source: z.string().nullable(),
  applicants: z.number().int(),
  hires: z.number().int(),
  /** Of the range's applicants from this source, the share hired so far. */
  applicantToHirePct: RateSchema,
  /** Spend recorded for the months the range touches; null when none. */
  spend: z.number().nullable(),
  costPerHire: z.number().nullable(),
}))();

export const RecruitingClientRowSchema = /* @__PURE__ */ (() => z.object({
  clientId: z.string().uuid(),
  clientName: z.string(),
  hires: z.number().int(),
  offersAccepted: z.number().int(),
  /** Accepted + declined + expired. */
  offersDecided: z.number().int(),
  offerAcceptancePct: RateSchema,
  /** Headcount on the client's postings opened in the range. */
  openings: z.number().int(),
  filled: z.number().int(),
  fillRatePct: RateSchema,
  medianDaysToFill: z.number().nullable(),
}))();

export const RecruitingRetentionRowSchema = /* @__PURE__ */ (() => z.object({
  key: z.string().nullable(),
  label: z.string(),
  hires: z.number().int(),
  stayed: z.number().int(),
  stayedPct: RateSchema,
}))();

export const RecruitingAnalyticsSchema = /* @__PURE__ */ (() => z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  funnel: z.object({
    applicants: z.number().int(),
    stages: z.array(RecruitingFunnelStageSchema),
    rejected: z.number().int(),
    withdrawn: z.number().int(),
    inProgress: z.number().int(),
  }),
  speed: z.object({
    hires: z.number().int(),
    medianDaysToHire: z.number().nullable(),
    postingsFilled: z.number().int(),
    medianDaysToFill: z.number().nullable(),
  }),
  sources: z.array(RecruitingSourceRowSchema),
  spendTotal: z.number().nullable(),
  costPerHire: z.number().nullable(),
  offers: z.object({
    accepted: z.number().int(),
    declined: z.number().int(),
    expired: z.number().int(),
    acceptancePct: RateSchema,
  }),
  fill: z.object({
    openings: z.number().int(),
    filled: z.number().int(),
    fillRatePct: RateSchema,
  }),
  clients: z.array(RecruitingClientRowSchema),
  retention: z.object({
    /** The hires measured: those old enough to have had 90 days. */
    window: z.object({ from: z.string(), to: z.string() }),
    overall: RecruitingRetentionRowSchema,
    bySource: z.array(RecruitingRetentionRowSchema),
    byRecruiter: z.array(RecruitingRetentionRowSchema),
  }),
}))();
export type RecruitingAnalytics = z.infer<typeof RecruitingAnalyticsSchema>;

/* ----- The recruiter's home ------------------------------------------------ *
 * One round trip for the recruiter's dashboard: today's interviews, who
 * applied, what is waiting on the recruiter and what is waiting on someone
 * else, the pipeline and open postings, the numbers, and recent activity.
 * Lists are the first few; `total` counts all of them.
 * ------------------------------------------------------------------------- */

const HomeCandidateRef = {
  candidateId: z.string().uuid(),
  candidateName: z.string(),
};

export const RecruiterHomeSchema = /* @__PURE__ */ (() => z.object({
  interviewsToday: z.array(
    z.object({
      id: z.string().uuid(),
      ...HomeCandidateRef,
      position: z.string().nullable(),
      scheduledFor: z.string(),
      durationMinutes: z.number().int(),
      location: z.string().nullable(),
      interviewerName: z.string().nullable(),
      mine: z.boolean(),
      /** upcoming; done (scored); needs_score (its time has passed, no scorecard). */
      state: z.enum(['upcoming', 'done', 'needs_score']),
    }),
  ),
  newApplicants: z.object({
    last24h: z.number().int(),
    last7d: z.number().int(),
    /** The last 7 days, by source (null = not recorded). */
    bySource: z.array(z.object({ source: z.string().nullable(), count: z.number().int() })),
    recent: z.array(
      z.object({
        ...HomeCandidateRef,
        position: z.string().nullable(),
        source: z.string().nullable(),
        postingTitle: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  waitingOnYou: z.object({
    toScore: z.object({
      total: z.number().int(),
      mine: z.number().int(),
      items: z.array(
        z.object({
          interviewId: z.string().uuid(),
          ...HomeCandidateRef,
          scheduledFor: z.string(),
          interviewerName: z.string().nullable(),
          mine: z.boolean(),
        }),
      ),
    }),
    stuck: z.object({
      total: z.number().int(),
      afterDays: z.number().int(),
      items: z.array(
        z.object({ ...HomeCandidateRef, position: z.string().nullable(), stage: z.string(), daysInStage: z.number().int() }),
      ),
    }),
    /** A client approved them and no offer has gone out since. */
    clientApproved: z.array(
      z.object({
        submittalId: z.string().uuid(),
        ...HomeCandidateRef,
        clientName: z.string(),
        storeName: z.string().nullable(),
        feedback: z.string().nullable(),
        decidedAt: z.string(),
      }),
    ),
    /** Signed their offer; not hired yet. */
    readyToHire: z.array(
      z.object({
        offerId: z.string().uuid(),
        ...HomeCandidateRef,
        jobTitle: z.string(),
        clientName: z.string(),
        startDate: z.string(),
        acceptedAt: z.string().nullable(),
      }),
    ),
    /**
     * Quiet candidates who close on their own within a few days unless
     * something happens — the warning before the clean-up.
     */
    closingSoon: z.object({
      total: z.number().int(),
      items: z.array(z.object({ ...HomeCandidateRef, stage: z.string(), closesAt: z.string() })),
    }),
    /** Held for pay approval, drafted by someone else — yours to approve. */
    offersToApprove: z.array(
      z.object({
        offerId: z.string().uuid(),
        ...HomeCandidateRef,
        jobTitle: z.string(),
        approvalNote: z.string().nullable(),
      }),
    ),
  }),
  waitingOnOthers: z.object({
    withClients: z.object({
      total: z.number().int(),
      items: z.array(
        z.object({
          submittalId: z.string().uuid(),
          ...HomeCandidateRef,
          clientName: z.string(),
          storeName: z.string().nullable(),
          sentAt: z.string(),
          days: z.number().int(),
        }),
      ),
    }),
    awaitingSignature: z.object({
      total: z.number().int(),
      items: z.array(
        z.object({
          offerId: z.string().uuid(),
          ...HomeCandidateRef,
          jobTitle: z.string(),
          sentAt: z.string().nullable(),
          expiresAt: z.string().nullable(),
          /** Expires within three days. */
          expiringSoon: z.boolean(),
        }),
      ),
    }),
    /** Hired, invited to onboarding, not started. */
    onboardingNotStarted: z.object({
      total: z.number().int(),
      items: z.array(
        z.object({
          applicationId: z.string().uuid(),
          ...HomeCandidateRef,
          clientName: z.string(),
          invitedAt: z.string(),
          days: z.number().int(),
          /**
           * About when the onboarding clean-up closes it (and takes the
           * hire back) if they still haven't started.
           */
          closesAt: z.string().nullable(),
        }),
      ),
    }),
  }),
  pipeline: z.object({
    APPLIED: z.number().int(),
    SCREENING: z.number().int(),
    INTERVIEW: z.number().int(),
    OFFER: z.number().int(),
  }),
  postings: z.object({
    total: z.number().int(),
    items: z.array(
      z.object({
        id: z.string().uuid(),
        title: z.string(),
        clientName: z.string().nullable(),
        openings: z.number().int(),
        hired: z.number().int(),
        applicants: z.number().int(),
        applicants7d: z.number().int(),
        daysOpen: z.number().int().nullable(),
      }),
    ),
  }),
  numbers: z.object({
    hiresThisMonth: z.number().int(),
    hiresLastMonth: z.number().int(),
    medianDaysToHire: z.number().nullable(),
    offerAcceptancePct: z.number().nullable(),
    offersDecided: z.number().int(),
  }),
  /** The requisitions (Positions) behind the pipeline, by status — what the
   *  recruiter is hiring against and what is still waiting for approval.
   *  Optional so older fixtures and clients keep working. */
  requisitions: z
    .object({
      total: z.number().int(),
      byStatus: z.record(z.string(), z.number().int()),
      items: z.array(
        z.object({
          id: z.string().uuid(),
          code: z.string(),
          title: z.string(),
          clientName: z.string().nullable(),
          status: z.string(),
          fteAuthorized: z.number(),
          targetStartDate: z.string().nullable(),
          /** The seat's budget, when the headcount plan sets one. */
          budgetAmount: z.number().nullable().optional(),
          budgetPeriod: z.enum(['ANNUAL', 'MONTHLY']).nullable().optional(),
          /** Who a requisition still waiting on approval waits on, and since when. */
          waitingOn: z.string().nullable().optional(),
          requestedAt: z.string().nullable().optional(),
        }),
      ),
    })
    .optional(),
  activity: z.array(
    z.object({
      id: z.string().uuid(),
      ...HomeCandidateRef,
      kind: CandidateEventKindSchema,
      fromStage: CandidateStageSchema.nullable(),
      toStage: CandidateStageSchema.nullable(),
      body: z.string().nullable(),
      actorName: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
}))();
export type RecruiterHome = z.infer<typeof RecruiterHomeSchema>;

export const RecruitingSourceSpendSchema = /* @__PURE__ */ (() => z.object({
  id: z.string().uuid(),
  source: z.string(),
  /** YYYY-MM. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number(),
  note: z.string().nullable(),
  updatedByEmail: z.string().nullable(),
}))();
export type RecruitingSourceSpend = z.infer<typeof RecruitingSourceSpendSchema>;

export const RecruitingSourceSpendInputSchema = /* @__PURE__ */ (() => z.object({
  source: z.string().trim().min(1).max(80),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM'),
  amount: z.number().nonnegative().max(10_000_000),
  note: z.string().trim().max(500).nullable().optional(),
}))();
export type RecruitingSourceSpendInput = z.infer<typeof RecruitingSourceSpendInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 15 — Time / Scheduling depth (Rippling-grade)
 * -------------------------------------------------------------------------- */

export const TimeAnomalySchema = /* @__PURE__ */ (() => z.enum([
  'GEOFENCE_VIOLATION_IN',
  'GEOFENCE_VIOLATION_OUT',
  'NO_BREAK',
  'MEAL_BREAK_TOO_SHORT',
  'OVERTIME_UNAPPROVED',
  'FORGOT_CLOCKOUT',
  'OUTSIDE_SHIFT_WINDOW',
  // Clocked out well before the linked shift's scheduled end.
  'EARLY_OUT',
]))();
export type TimeAnomaly = z.infer<typeof TimeAnomalySchema>;

export const BreakTypeSchema = /* @__PURE__ */ (() => z.enum(['MEAL', 'REST']))();
export type BreakType = z.infer<typeof BreakTypeSchema>;

export const BreakEntrySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  timeEntryId: UuidSchema,
  type: BreakTypeSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  minutes: z.number().int().nonnegative(),
}))();
export type BreakEntry = z.infer<typeof BreakEntrySchema>;

export const JobSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  clientName: z.string().nullable(),
  name: z.string(),
  billRate: z.number().nullable(),
  payRate: z.number().nullable(),
  isActive: z.boolean(),
}))();
export type Job = z.infer<typeof JobSchema>;

export const JobListResponseSchema = /* @__PURE__ */ (() => z.object({
  jobs: z.array(JobSchema),
}))();
export type JobListResponse = z.infer<typeof JobListResponseSchema>;

export const JobCreateInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  name: z.string().min(1).max(120),
  billRate: z.number().nonnegative().optional(),
  payRate: z.number().nonnegative().optional(),
}))();
export type JobCreateInput = z.infer<typeof JobCreateInputSchema>;

export const JobUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().min(1).max(120).optional(),
  billRate: z.number().nonnegative().nullable().optional(),
  payRate: z.number().nonnegative().nullable().optional(),
  isActive: z.boolean().optional(),
}))();
export type JobUpdateInput = z.infer<typeof JobUpdateInputSchema>;

const GeoSchema = /* @__PURE__ */ (() => z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
}))();

export const ClockInInputV2Schema = /* @__PURE__ */ (() => z.object({
  notes: z.string().max(500).optional(),
  jobId: UuidSchema.optional(),
  geo: GeoSchema.optional(),
}))();
export type ClockInInputV2 = z.infer<typeof ClockInInputV2Schema>;

export const ClockOutInputV2Schema = /* @__PURE__ */ (() => z.object({
  notes: z.string().max(500).optional(),
  geo: GeoSchema.optional(),
  /** Where the state requires breaks, the worker's answer at clock-out (lib/timeCorrections). */
  breakAttestation: z
    .object({
      meal: z.enum(['YES', 'NO', 'WAIVED']),
      rest: z.enum(['YES', 'NO']).nullable().optional(),
      note: z.string().max(500).nullable().optional(),
    })
    .optional(),
}))();
export type ClockOutInputV2 = z.infer<typeof ClockOutInputV2Schema>;

export const StartBreakInputSchema = /* @__PURE__ */ (() => z.object({
  type: BreakTypeSchema,
}))();
export type StartBreakInput = z.infer<typeof StartBreakInputSchema>;

export const ActiveDashboardEntrySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  jobId: UuidSchema.nullable(),
  jobName: z.string().nullable(),
  clockInAt: z.string().datetime(),
  minutesElapsed: z.number().int().nonnegative(),
  onBreak: z.boolean(),
  geofenceOk: z.boolean().nullable(),
  clockInLat: z.number().nullable(),
  clockInLng: z.number().nullable(),
  /** IANA zone of the entry's site, so punch times render on the site's wall clock. */
  locationTimezone: z.string().nullable().optional(),
  /** The entry's store (the punch's, else its shift's) — places it in a
   *  supervisor's shift window. */
  locationId: UuidSchema.nullable().optional(),
  /** Matched shift bounds — powers the live board's shift-window filter. */
  shiftStartsAt: z.string().datetime().nullable().optional(),
  shiftEndsAt: z.string().datetime().nullable().optional(),
}))();
export type ActiveDashboardEntry = z.infer<typeof ActiveDashboardEntrySchema>;

export const ActiveDashboardResponseSchema = /* @__PURE__ */ (() => z.object({
  entries: z.array(ActiveDashboardEntrySchema),
}))();
export type ActiveDashboardResponse = z.infer<typeof ActiveDashboardResponseSchema>;

export const AvailabilityWindowSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(24 * 60),
  endMinute: z.number().int().min(0).max(24 * 60),
}))();
export type AvailabilityWindow = z.infer<typeof AvailabilityWindowSchema>;

export const AvailabilityListResponseSchema = /* @__PURE__ */ (() => z.object({
  windows: z.array(AvailabilityWindowSchema),
}))();
export type AvailabilityListResponse = z.infer<typeof AvailabilityListResponseSchema>;

export const AvailabilityReplaceInputSchema = /* @__PURE__ */ (() => z.object({
  windows: z
    .array(
      z
        .object({
          dayOfWeek: z.number().int().min(0).max(6),
          startMinute: z.number().int().min(0).max(24 * 60),
          endMinute: z.number().int().min(0).max(24 * 60),
        })
        .refine((w) => w.endMinute > w.startMinute, {
          message: 'endMinute must be greater than startMinute',
        })
    )
    .max(50),
}))();
export type AvailabilityReplaceInput = z.infer<typeof AvailabilityReplaceInputSchema>;

export const ShiftSwapStatusSchema = /* @__PURE__ */ (() => z.enum([
  'PENDING_PEER',
  'PEER_ACCEPTED',
  'PEER_DECLINED',
  'MANAGER_APPROVED',
  'MANAGER_REJECTED',
  'CANCELLED',
]))();
export type ShiftSwapStatus = z.infer<typeof ShiftSwapStatusSchema>;

export const ShiftSwapRequestSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  shiftId: UuidSchema,
  shiftStartsAt: z.string().datetime(),
  shiftEndsAt: z.string().datetime(),
  // IANA timezone of the shift's work site — swap cards render the shift's
  // hours in THIS zone, same as the schedule list, so the two surfaces never
  // show different wall-clock times for the same shift.
  shiftTimezone: z.string(),
  shiftPosition: z.string(),
  /** Trade half: the counterparty shift the requester takes in exchange.
   *  Null = plain give-away. */
  inExchange: TradeOptionSchema.nullable(),
  shiftClientName: z.string().nullable(),
  requesterAssociateId: UuidSchema,
  requesterName: z.string(),
  counterpartyAssociateId: UuidSchema,
  counterpartyName: z.string(),
  status: ShiftSwapStatusSchema,
  note: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** Admin list only: approving would push the receiving associate past
   *  40h scheduled that week. Advisory. */
  wouldExceed40h: z.boolean().optional(),
}))();
export type ShiftSwapRequest = z.infer<typeof ShiftSwapRequestSchema>;

export const ShiftSwapListResponseSchema = /* @__PURE__ */ (() => z.object({
  requests: z.array(ShiftSwapRequestSchema),
}))();
export type ShiftSwapListResponse = z.infer<typeof ShiftSwapListResponseSchema>;

export const SwapCreateInputSchema = /* @__PURE__ */ (() => z.object({
  shiftId: UuidSchema,
  counterpartyAssociateId: UuidSchema,
  note: z.string().max(500).optional(),
  /** Optional trade: a shift of the counterparty's the requester takes in
   *  exchange. Must belong to the counterparty and still be upcoming. */
  counterpartShiftId: UuidSchema.optional(),
}))();
export type SwapCreateInput = z.infer<typeof SwapCreateInputSchema>;

export const SwapDecideInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().max(500).optional(),
}))();
export type SwapDecideInput = z.infer<typeof SwapDecideInputSchema>;

export const ShiftConflictSchema = /* @__PURE__ */ (() => z.object({
  conflictingShiftId: UuidSchema,
  conflictingStartsAt: z.string().datetime(),
  conflictingEndsAt: z.string().datetime(),
  conflictingClientName: z.string().nullable(),
  conflictingPosition: z.string(),
}))();
export type ShiftConflict = z.infer<typeof ShiftConflictSchema>;

// Phase 52 — APPROVED time-off that overlaps the shift window. Surfaced
// in the UI as a hard warning ("they're on PTO that day") so HR doesn't
// accidentally double-book someone who's away.
export const TimeOffConflictSchema = /* @__PURE__ */ (() => z.object({
  requestId: UuidSchema,
  category: z.string(),
  startDate: z.string(), // YYYY-MM-DD
  endDate: z.string(),
}))();
export type TimeOffConflict = z.infer<typeof TimeOffConflictSchema>;

export const ShiftConflictsResponseSchema = /* @__PURE__ */ (() => z.object({
  conflicts: z.array(ShiftConflictSchema),
  timeOffConflicts: z.array(TimeOffConflictSchema).default([]),
  /** One-off "can't work this day" declarations covering the shift day. */
  unavailableDays: z
    .array(
      z.object({
        date: z.string(), // YYYY-MM-DD
        note: z.string().nullable(),
      }),
    )
    .default([]),
}))();
export type ShiftConflictsResponse = z.infer<typeof ShiftConflictsResponseSchema>;

export const AutoFillCandidateSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  associateName: z.string(),
  weeklyMinutesScheduled: z.number().int().nonnegative(),
  weeklyMinutesActual: z.number().int().nonnegative(),
  matchesAvailability: z.boolean(),
  noConflict: z.boolean(),
  // Phase 52 — true when an APPROVED time-off request covers the shift day.
  // Surfaced so the picker can flag them; their score is also forced to 0.
  onApprovedTimeOff: z.boolean().default(false),
  score: z.number().min(0).max(1),
  /* The facts a scheduler decides on, so the Assign dialog never sends
   * them to three other pages (role walk, ops 7). All optional: an older
   * server answers without them and the dialog shows what it has. */
  /** Home store name, when the person has one. */
  homeLocationName: z.string().nullable().optional(),
  /** Minutes scheduled this week INCLUDING the shift being assigned. */
  projectedWeeklyMinutes: z.number().int().nonnegative().optional(),
  /** The cost rate the shift would be paid at; null when none resolves. */
  hourlyRateCents: z.number().int().nonnegative().nullable().optional(),
  /** This shift's cost at that rate (straight time). */
  shiftCostCents: z.number().int().nonnegative().nullable().optional(),
  /** The overtime premium this assignment adds over straight time, as the paycheck would split the week (the labor-rules engine). */
  otPremiumCents: z.number().int().nonnegative().optional(),
  /** Minutes of overtime and double time this assignment adds to the person's week (the engine's split: past 40, or a live daily rule). */
  otMinutes: z.number().int().nonnegative().optional(),
  /** Whether taking this shift adds overtime — the server's answer; the web never re-derives it from 40 hours. */
  wouldBeOvertime: z.boolean().optional(),
  /** Last 90 days: late arrivals, no-shows, call-outs. */
  reliability: z.object({
    late: z.number().int().nonnegative(),
    noShow: z.number().int().nonnegative(),
    callOut: z.number().int().nonnegative(),
    days: z.number().int().positive(),
  }).optional(),
  /** Their window on the shift's day, e.g. "Avail Mon 4:00 PM–11:00 PM", or why they don't fit. */
  availabilityLabel: z.string().nullable().optional(),
  /** Shifts worked at this site in the last 90 days — site history. */
  siteShiftsWorked: z.number().int().nonnegative().optional(),
  /** Straight-line distance from home to the site, when both are known. */
  distanceMiles: z.number().nonnegative().nullable().optional(),
  /** Required credentials for the position: which they hold and which they lack. */
  credentials: z.object({
    required: z.array(z.string()),
    missing: z.array(z.string()),
  }).optional(),
}))();
export type AutoFillCandidate = z.infer<typeof AutoFillCandidateSchema>;

export const AutoFillResponseSchema = /* @__PURE__ */ (() => z.object({
  candidates: z.array(AutoFillCandidateSchema),
}))();
export type AutoFillResponse = z.infer<typeof AutoFillResponseSchema>;

// Phase 131 — ClientGeofenceInputSchema was removed; the Client
// geofence columns are gone. Use LocationUpdateInputSchema's latitude /
// longitude / geofenceRadiusMeters fields against
// PATCH /clients/:id/locations/:lid instead.

/* -------------------------------------------------------------------------- *
 *  Phase 16 — Invitation flow
 * -------------------------------------------------------------------------- */

export const InviteSummarySchema = /* @__PURE__ */ (() => z.object({
  email: z.string().email(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  expiresAt: z.string().datetime(),
}))();
export type InviteSummary = z.infer<typeof InviteSummarySchema>;

export const AcceptInviteInputSchema = /* @__PURE__ */ (() => z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(256),
}))();
export type AcceptInviteInput = z.infer<typeof AcceptInviteInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 39 — User settings (password change + display name)
 * -------------------------------------------------------------------------- */

export const ChangePasswordInputSchema = /* @__PURE__ */ (() => z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'New password must differ from current password',
    path: ['newPassword'],
  }))();
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

export const UpdateProfileInputSchema = /* @__PURE__ */ (() => z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
}))();
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;

/**
 * Curated IANA timezones we support in the picker. US ones first (this is a
 * US-focused HR app), then a small set of common international ones so
 * remote / multinational employees aren't stuck. Keep this in sync with
 * the dropdown order on /settings.
 *
 * To add a timezone: append the IANA name AND a label here. The server
 * validates against this list — submitting an unknown TZ returns 400.
 */
export const SUPPORTED_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Madrid',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;
export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

export const TIMEZONE_LABELS: Record<SupportedTimezone, string> = {
  'America/New_York': 'Eastern (New York)',
  'America/Chicago': 'Central (Chicago)',
  'America/Denver': 'Mountain (Denver)',
  'America/Phoenix': 'Mountain — no DST (Phoenix)',
  'America/Los_Angeles': 'Pacific (Los Angeles)',
  'America/Anchorage': 'Alaska (Anchorage)',
  'Pacific/Honolulu': 'Hawaii (Honolulu)',
  'America/Toronto': 'Eastern Canada (Toronto)',
  'America/Mexico_City': 'Mexico City',
  'America/Sao_Paulo': 'São Paulo',
  UTC: 'UTC',
  'Europe/London': 'London',
  'Europe/Paris': 'Paris',
  'Europe/Madrid': 'Madrid',
  'Asia/Kolkata': 'India (Kolkata)',
  'Asia/Singapore': 'Singapore',
  'Asia/Tokyo': 'Tokyo',
  'Australia/Sydney': 'Sydney',
};

export const UpdateLanguageInputSchema = /* @__PURE__ */ (() => z.object({
  // Null clears the preference (English).
  language: EmailLanguageSchema.nullable(),
}))();

export const UpdateTimezoneInputSchema = /* @__PURE__ */ (() => z.object({
  // Null clears the preference and falls back to the browser locale.
  timezone: z.enum(SUPPORTED_TIMEZONES).nullable(),
}))();
export type UpdateTimezoneInput = z.infer<typeof UpdateTimezoneInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Notification preferences (per-user EMAIL opt-out by category)
 *
 *  IN_APP delivery is unaffected by these — the bell stays authoritative.
 *  Mandatory categories cannot be muted (formal HR notices and security
 *  alerts must reach the user no matter what).
 *
 *  Adding a new bucket: append to NOTIFICATION_CATEGORIES AND extend the
 *  bucketForRawCategory() resolver in apps/api/src/lib/notify.ts so the
 *  raw category strings the routes pass map back to a user-facing key.
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
      'Broadcast messages from HR. Muting this (or using the unsubscribe link in an announcement email) stops the emails; the in-app copy still arrives.',
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
    description: 'Always on — password resets and other security alerts.',
    mandatory: true,
    audience: 'all',
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
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['key'];
/** Who a bucket is for: Alto staff, portal (store / market / region)
 *  accounts, or everyone. Settings lists only the buckets for the role. */
export type NotificationAudience = (typeof NOTIFICATION_CATEGORIES)[number]['audience'];

/** The buckets a role sees in Settings. */
export function notificationCategoriesFor(role: string) {
  const portal = role === 'CLIENT_PORTAL';
  return NOTIFICATION_CATEGORIES.filter((c) => c.audience === 'all' || (portal ? c.audience === 'portal' : c.audience === 'staff'));
}

/**
 * Map a raw call-site category string (e.g. 'shift_published',
 * 'payroll.payment_failed') to its user-facing NOTIFICATION_CATEGORIES
 * bucket. Single source of truth shared by the API's email-mute check and
 * the web bell's row labels/icons — previously two copies that drifted.
 * Null = unknown string: the API treats it as "always send" (defensive
 * over-delivery) and the bell renders a neutral row.
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
): NotificationCategory | null {
  if (!raw) return null;
  if (raw === 'broadcast') return 'broadcast';
  if (raw === 'message') return 'messages';
  if (raw === 'portal.digest') return 'store_daily';
  if (raw === 'portal.coverage') return 'store_alerts';
  if (raw === 'client-request') return 'store_requests';
  if (raw === 'portal.service_report' || raw === 'portal.statement' || raw === 'portal.ops_report')
    return 'store_reports';
  // Staff-side operational sweeps. They resolved to no bucket at all, which
  // meant isEmailMuted() always answered false for them — so they were
  // unmutable, and a mute check added to their senders would have been a
  // no-op. 'workplace' is the staff bucket for operational alerts; the
  // portal.* buckets above are for CLIENT_PORTAL accounts, and these two go
  // to HR, Ops and the chairman.
  if (raw === 'portal.engagement_digest' || raw === 'kiosk_device_alert') return 'workplace';
  if (raw === 'discipline') return 'discipline';
  if (raw === 'probation') return 'probation';
  if (raw === 'security') return 'security';
  if (raw === 'documents' || raw.startsWith('documents.')) return 'documents';
  if (raw === 'time-off' || raw === 'vto') return 'time_off';
  if (
    raw === 'scheduling' ||
    raw === 'schedule_digest' ||
    raw === 'week_ahead' ||
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
    raw.startsWith('ops.') ||
    raw.startsWith('decision_') ||
    raw.startsWith('compliance') ||
    raw.startsWith('reports')
  )
    return 'workplace';
  return null;
}

/** Raw categories that signal something went WRONG — the bell paints these
 *  rows in the alert tone so a failed payment never looks like a birthday. */
export function isUrgentCategory(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /failed|rejected|no_show|escalation|alert|voided|expired|coverage/.test(raw);
}

const NOTIFICATION_CATEGORY_KEYS = NOTIFICATION_CATEGORIES.map((c) => c.key) as [
  NotificationCategory,
  ...NotificationCategory[],
];

export const PatchNotificationPreferenceInputSchema = /* @__PURE__ */ (() => z
  .object({
    category: z.enum(NOTIFICATION_CATEGORY_KEYS),
    // Either switch may be sent on its own — the settings page toggles one
    // at a time, and an absent field leaves that channel as it was.
    emailEnabled: z.boolean().optional(),
    inAppEnabled: z.boolean().optional(),
  })
  .refine((v) => v.emailEnabled !== undefined || v.inAppEnabled !== undefined, {
    message: 'Provide emailEnabled, inAppEnabled, or both.',
  }))();
export type PatchNotificationPreferenceInput = z.infer<
  typeof PatchNotificationPreferenceInputSchema
>;

export interface NotificationPreferenceEntry {
  category: NotificationCategory;
  label: string;
  description: string;
  mandatory: boolean;
  emailEnabled: boolean;
  /** The bell. Muting this stops the in-app row being written at all. */
  inAppEnabled: boolean;
}

/* -------------------------------------------------------------------------- *
 *  Email change (two-step verification)
 *
 *  Request requires re-auth via current password. Confirmation is via a
 *  single-use ~256-bit token emailed to the NEW address; clicking the
 *  link confirms ownership and swaps the email. The old address gets a
 *  separate informational email after the swap so the user can intervene
 *  if they didn't initiate.
 * -------------------------------------------------------------------------- */

export const RequestEmailChangeInputSchema = /* @__PURE__ */ (() => z.object({
  newEmail: z.string().email().max(254),
  // Same minimum as login — keeps the password-input UX consistent and
  // ensures the dummy-hash compare path can always run on a malformed
  // submission without blowing up.
  currentPassword: z.string().min(12).max(256),
}))();
export type RequestEmailChangeInput = z.infer<typeof RequestEmailChangeInputSchema>;

export const ConfirmEmailChangeInputSchema = /* @__PURE__ */ (() => z.object({
  // ~43-char base64url; cap higher for forward compatibility.
  token: z.string().min(20).max(200),
}))();
export type ConfirmEmailChangeInput = z.infer<typeof ConfirmEmailChangeInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 26 — Time off (sick-leave accrual + ledger)
 * -------------------------------------------------------------------------- */

export const TimeOffCategorySchema = /* @__PURE__ */ (() => z.enum([
  'SICK',
  'VACATION',
  'PTO',
  'BEREAVEMENT',
  'JURY_DUTY',
  'OTHER',
]))();
export type TimeOffCategory = z.infer<typeof TimeOffCategorySchema>;

/**
 * Leave that an event grants, not a bank.
 *
 * Bereavement is given per occurrence — three days for a death in the
 * family — and jury duty is a summons the employer cannot refuse. Neither
 * is accrued, so neither has hours to be short of, and an approver who was
 * told "Insufficient balance. Available 0h, requested 8h" was being asked
 * to fund a bank that was never going to have anything in it.
 *
 * An employer may still choose to bank these (say 24h of bereavement a
 * year) by giving the associate an entitlement. Where they have, the
 * balance is drawn down like any other; what never happens is a refusal.
 */
export const EVENT_BASED_TIME_OFF_CATEGORIES = ['BEREAVEMENT', 'JURY_DUTY'] as const;

export function isEventBasedTimeOffCategory(category: string): boolean {
  return (EVENT_BASED_TIME_OFF_CATEGORIES as readonly string[]).includes(category);
}

export const TimeOffLedgerReasonSchema = /* @__PURE__ */ (() => z.enum([
  'ACCRUAL',
  'USE',
  'ADJUSTMENT',
  'CARRYOVER_FORFEIT',
  'ANNUAL_GRANT',
  'PAYOUT',
]))();
export type TimeOffLedgerReason = z.infer<typeof TimeOffLedgerReasonSchema>;

export const TimeOffBalanceSchema = /* @__PURE__ */ (() => z.object({
  category: TimeOffCategorySchema,
  balanceMinutes: z.number().int(),
}))();
export type TimeOffBalance = z.infer<typeof TimeOffBalanceSchema>;

export const TimeOffLedgerEntrySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  category: TimeOffCategorySchema,
  reason: TimeOffLedgerReasonSchema,
  deltaMinutes: z.number().int(),
  sourceTimeEntryId: UuidSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
}))();
export type TimeOffLedgerEntry = z.infer<typeof TimeOffLedgerEntrySchema>;

export const TimeOffMyBalanceResponseSchema = /* @__PURE__ */ (() => z.object({
  balances: z.array(TimeOffBalanceSchema),
  recentLedger: z.array(TimeOffLedgerEntrySchema),
}))();
export type TimeOffMyBalanceResponse = z.infer<typeof TimeOffMyBalanceResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 30 — Time-off requests (associate-submitted; HR-approved)
 * -------------------------------------------------------------------------- */

export const TimeOffRequestStatusSchema = /* @__PURE__ */ (() => z.enum([
  'PENDING',
  'APPROVED',
  'DENIED',
  'CANCELLED',
]))();
export type TimeOffRequestStatus = z.infer<typeof TimeOffRequestStatusSchema>;

// Dates are submitted as YYYY-MM-DD strings; the server clamps to UTC midnight.
const IsoDateSchema = /* @__PURE__ */ (() => z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'))();

export const TimeOffRequestCreateInputSchema = /* @__PURE__ */ (() => z
  .object({
    category: TimeOffCategorySchema,
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    // Hours (decimal, half-hour granularity). Server converts to minutes.
    hours: z.number().positive().max(2000).multipleOf(0.5),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  }))();
export type TimeOffRequestCreateInput = z.infer<typeof TimeOffRequestCreateInputSchema>;

export const TimeOffRequestDecisionInputSchema = /* @__PURE__ */ (() => z.object({
  note: z.string().max(500).optional(),
  /**
   * Approve even though the balance doesn't cover it, and say why.
   *
   * Most associates have no balance at all: only SICK accrues, and only
   * in states whose law provides for it (Florida's rate is zero), while
   * every other category needs an entitlement someone configured by hand.
   * So the balance gate — correct in itself — became a wall with nothing
   * behind it, and the approver had no way through.
   *
   * A reason is required rather than a bare flag: this writes a negative
   * balance, and a negative balance with no explanation is the kind of
   * thing that gets found months later by someone reconciling PTO.
   */
  overrideReason: z.string().trim().min(3).max(300).optional(),
}))();
export type TimeOffRequestDecisionInput = z.infer<typeof TimeOffRequestDecisionInputSchema>;

export const TimeOffRequestDenyInputSchema = /* @__PURE__ */ (() => z.object({
  // Note is required for DENY — the associate sees this in their history.
  note: z.string().min(1).max(500),
}))();
export type TimeOffRequestDenyInput = z.infer<typeof TimeOffRequestDenyInputSchema>;

export const TimeOffRequestSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string().nullable(),
  category: TimeOffCategorySchema,
  startDate: z.string(),  // YYYY-MM-DD
  endDate: z.string(),
  requestedMinutes: z.number().int(),
  reason: z.string().nullable(),
  status: TimeOffRequestStatusSchema,
  reviewerUserId: UuidSchema.nullable(),
  reviewerEmail: z.string().nullable(),
  reviewerNote: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** Admin list only: the associate's current balance for this category,
   *  so approvers see over-draw BEFORE clicking approve. */
  balanceMinutes: z.number().int().nullable().optional(),
  /** Admin list, PENDING rows only: how many ASSIGNED shifts the leave
   *  window overlaps — the coverage hole the approver is about to punch.
   *  Null/absent when not computed. */
  assignedShiftOverlaps: z.number().int().nullable().optional(),
}))();
export type TimeOffRequest = z.infer<typeof TimeOffRequestSchema>;

export const TimeOffRequestListResponseSchema = /* @__PURE__ */ (() => z.object({
  requests: z.array(TimeOffRequestSchema),
  /** True row count before the server cap — lets the UI say "200 of N". */
  total: z.number().int().nonnegative().optional(),
}))();
export type TimeOffRequestListResponse = z.infer<typeof TimeOffRequestListResponseSchema>;

export const TimeOffRequestResponseSchema = /* @__PURE__ */ (() => z.object({
  request: TimeOffRequestSchema,
}))();
export type TimeOffRequestResponse = z.infer<typeof TimeOffRequestResponseSchema>;

export const TimeOffAdminListQuerySchema = /* @__PURE__ */ (() => z.object({
  /** One person's requests — the person record's Time off tab. */
  associateId: UuidSchema.optional(),
  status: TimeOffRequestStatusSchema.optional(),
}))();
export type TimeOffAdminListQuery = z.infer<typeof TimeOffAdminListQuerySchema>;

// ===== Phase 76 — Org hierarchy ===========================================

export const DepartmentSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  parentId: UuidSchema.nullable(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  associateCount: z.number().int().nonnegative(),
}))();
export type Department = z.infer<typeof DepartmentSchema>;

export const DepartmentListResponseSchema = /* @__PURE__ */ (() => z.object({
  departments: z.array(DepartmentSchema),
}))();
export type DepartmentListResponse = z.infer<typeof DepartmentListResponseSchema>;

export const DepartmentInputSchema = /* @__PURE__ */ (() => z.object({
  /** A client's department, or the company's own (a direct employer has no clients). */
  clientId: UuidSchema.nullable(),
  parentId: UuidSchema.nullable().optional(),
  name: z.string().min(1).max(120),
  code: z.string().max(40).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
}))();
export type DepartmentInput = z.infer<typeof DepartmentInputSchema>;

export const CostCenterSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  associateCount: z.number().int().nonnegative(),
}))();
export type CostCenter = z.infer<typeof CostCenterSchema>;

export const CostCenterListResponseSchema = /* @__PURE__ */ (() => z.object({
  costCenters: z.array(CostCenterSchema),
}))();
export type CostCenterListResponse = z.infer<typeof CostCenterListResponseSchema>;

export const CostCenterInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
}))();
export type CostCenterInput = z.infer<typeof CostCenterInputSchema>;

export const JobProfileSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  code: z.string(),
  title: z.string(),
  family: z.string().nullable(),
  level: z.string().nullable(),
  isExempt: z.boolean(),
  description: z.string().nullable(),
  /** Treasury Tipped Occupation Code (W-2 box 14b from 2026). */
  tippedOccupationCode: z.string().nullable().optional(),
  associateCount: z.number().int().nonnegative(),
}))();
export type JobProfile = z.infer<typeof JobProfileSchema>;

export const JobProfileListResponseSchema = /* @__PURE__ */ (() => z.object({
  jobProfiles: z.array(JobProfileSchema),
}))();
export type JobProfileListResponse = z.infer<typeof JobProfileListResponseSchema>;

export const JobProfileInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  code: z.string().min(1).max(40),
  title: z.string().min(1).max(120),
  family: z.string().max(80).optional().nullable(),
  level: z.string().max(40).optional().nullable(),
  isExempt: z.boolean().optional(),
  description: z.string().max(500).optional().nullable(),
  /** Three-digit Treasury Tipped Occupation Code (Treas. Reg. §1.224-1 list); null clears it. */
  tippedOccupationCode: z.string().regex(/^\d{3}$/, 'Tipped occupation codes are three digits').optional().nullable(),
}))();
export type JobProfileInput = z.infer<typeof JobProfileInputSchema>;

// ----- Shift positions ----------------------------------------------------
// Per-client catalog that constrains the free-text Shift.position field to
// an admin-curated dropdown ("F&D Morning Shift", etc.).
export const ShiftPositionSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  name: z.string(),
  sortOrder: z.number().int(),
  /** Supervisor/lead position — drives the labor-cost report's
   *  lead-vs-associate split. Optional for back-compat. */
  isLead: z.boolean().optional(),
}))();
export type ShiftPosition = z.infer<typeof ShiftPositionSchema>;

export const ShiftPositionListResponseSchema = /* @__PURE__ */ (() => z.object({
  shiftPositions: z.array(ShiftPositionSchema),
}))();
export type ShiftPositionListResponse = z.infer<
  typeof ShiftPositionListResponseSchema
>;

export const ShiftPositionInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  name: z.string().min(1).max(120),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isLead: z.boolean().optional(),
}))();
export type ShiftPositionInput = z.infer<typeof ShiftPositionInputSchema>;

// Associate-side org assignment. Used by PUT /associates/:id/org.
export const AssociateOrgAssignmentInputSchema = /* @__PURE__ */ (() => z.object({
  managerId: UuidSchema.nullable().optional(),
  departmentId: UuidSchema.nullable().optional(),
  costCenterId: UuidSchema.nullable().optional(),
  jobProfileId: UuidSchema.nullable().optional(),
}))();
export type AssociateOrgAssignmentInput = z.infer<typeof AssociateOrgAssignmentInputSchema>;

// HR-side patch of plain associate fields (phone, etc.). Mirrors the
// fields self-service exposes on /me/profile but gated to manage:org so
// HR can correct contact info without asking the associate to re-submit
// onboarding. Address fields stay read-only here on purpose — those go
// through onboarding's PROFILE_INFO task which is the source of truth.
export const AssociateProfilePatchInputSchema = /* @__PURE__ */ (() => z.object({
  phone: z.string().trim().min(7).max(40).nullable().optional(),
  // Inline HR fixes to what the directory drawer displays. position and
  // startDate live on the associate's workplace APPLICATION (newest
  // APPROVED, else newest) — the same record the directory reads — so the
  // server patches that application, not the Associate row.
  position: z.string().trim().min(1).max(120).optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
}))();
export type AssociateProfilePatchInput = z.infer<typeof AssociateProfilePatchInputSchema>;

// Manual deactivate/reactivate — the temporary pause, distinct from a
// Separation. The reason is required: it prints in the inactive-workforce
// audit packet and the drawer, so "personal leave — expected back Oct"
// beats a bare timestamp.
export const AssociateDeactivateInputSchema = /* @__PURE__ */ (() => z.object({
  reason: z.string().trim().min(3).max(300),
}))();
export type AssociateDeactivateInput = z.infer<typeof AssociateDeactivateInputSchema>;

export const AssociateDeactivateResponseSchema = /* @__PURE__ */ (() => z.object({
  ok: z.literal(true),
  deactivatedAt: z.string().datetime(),
  /** Future ASSIGNED shifts released back to OPEN so they can be re-covered. */
  releasedShifts: z.number().int(),
  /** PENDING open-shift claims expired alongside. */
  expiredClaims: z.number().int(),
  loginDisabled: z.boolean(),
}))();
export type AssociateDeactivateResponse = z.infer<typeof AssociateDeactivateResponseSchema>;

export const AssociateOrgSummarySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  managerId: UuidSchema.nullable(),
  managerName: z.string().nullable(),
  departmentId: UuidSchema.nullable(),
  departmentName: z.string().nullable(),
  costCenterId: UuidSchema.nullable(),
  costCenterCode: z.string().nullable(),
  jobProfileId: UuidSchema.nullable(),
  jobProfileTitle: z.string().nullable(),
  // Cache-busted URL to the associate's profile photo, or null when no
  // photo on file. Avatar component falls back to initials in the null
  // case. The URL is `/associates/:id/photo?v=<photoUpdatedAt>`.
  photoUrl: z.string().nullable(),
}))();
export type AssociateOrgSummary = z.infer<typeof AssociateOrgSummarySchema>;

export const AssociateOrgListResponseSchema = /* @__PURE__ */ (() => z.object({
  associates: z.array(AssociateOrgSummarySchema),
  /** True when the list hit its cap and more people exist than were returned. */
  truncated: z.boolean().optional(),
}))();
export type AssociateOrgListResponse = z.infer<typeof AssociateOrgListResponseSchema>;

// ===== Directory =========================================================
//
// One-stop list of every person Alto HR knows about, with the joins HR
// actually wants in the row: employment status (derived from applications),
// current workplace (client), live pay rate, employment type, start date,
// and the org-fields tile. Powers /people.
export const DirectoryStatusSchema = /* @__PURE__ */ (() => z.enum([
  'ACTIVE', // Has at least one APPROVED application not yet ended.
  'PENDING', // Has a DRAFT/SUBMITTED/IN_REVIEW application — onboarding in flight.
  'INACTIVE', // No live applications (rejected, ended, or none at all).
]))();
export type DirectoryStatus = z.infer<typeof DirectoryStatusSchema>;

export const DirectoryEntrySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  employmentType: z.string(),
  j1Status: z.boolean(),
  /** The older three words, derived from workStatus (directoryStatusOf). */
  status: DirectoryStatusSchema,
  /** Where the person stands, in the one vocabulary every page uses (peopleStatus.ts). */
  workStatus: WorkStatusSchema.optional(),
  // Workplace = the open AssociateAssignment's client when one exists
  // (Phase 131 — a transfer moves the live workplace immediately);
  // otherwise the client of the most-recent ACTIVE application, falling
  // back to the most-recent application overall.
  workplaceClientId: UuidSchema.nullable(),
  workplaceClientName: z.string().nullable(),
  position: z.string().nullable(),
  startDate: z.string().nullable(), // ISO date or null
  // Pay rate from the latest open CompensationRecord (effectiveTo=null).
  payAmount: z.string().nullable(), // decimal-as-string so the wire stays exact
  payType: z.string().nullable(), // HOURLY / SALARY / COMMISSION etc.
  payCurrency: z.string().nullable(),
  // Org tile.
  managerId: UuidSchema.nullable(),
  managerName: z.string().nullable(),
  departmentId: UuidSchema.nullable(),
  departmentName: z.string().nullable(),
  jobProfileId: UuidSchema.nullable(),
  jobProfileTitle: z.string().nullable(),
  // For pending entries — the % complete on their onboarding checklist.
  onboardingPercent: z.number().int().min(0).max(100).nullable(),
  // The id of the workplace application — present whenever a workplace
  // could be derived. Used by the drawer to deep-link into the onboarding
  // detail and to drive the nudge action for PENDING associates.
  applicationId: UuidSchema.nullable(),
  /** Set when a completed separation is what makes this associate
   *  INACTIVE (null for rehires with a newer approval). */
  separatedAt: z.string().datetime().nullable().optional(),
  /** Manual pause — set by POST /associates/:id/deactivate. While set the
   *  associate is INACTIVE, their login is disabled, and the kiosk rejects
   *  new clock-ins; Reactivate clears it with the record intact. */
  deactivatedAt: z.string().datetime().nullable().optional(),
  deactivationReason: z.string().nullable().optional(),
  // First time this associate's record was created — useful as a proxy
  // for tenure when no formal hire date is on file.
  createdAt: z.string().datetime(),
  // Cache-busted URL to the associate's profile photo, or null. Avatar
  // falls back to initials when null.
  photoUrl: z.string().nullable(),
  // Phase 131 — open AssociateAssignment, if any. Null when the
  // associate has never been placed at a Location.
  /** The login to open a messenger thread with — set only for someone the
   *  messenger serves (staff), never a plain associate. */
  messageUserId: UuidSchema.nullable().optional(),
  currentLocationId: UuidSchema.nullable(),
  currentLocationName: z.string().nullable(),
  // Start date (YYYY-MM-DD) of that open assignment. The transfer and
  // separation date pickers use it as a floor: an effective date before
  // it would close the assignment before it began.
  currentAssignmentStartedAt: z.string().nullable(),
}))();
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

export const DirectoryListResponseSchema = /* @__PURE__ */ (() => z.object({
  associates: z.array(DirectoryEntrySchema),
  // See ClientListResponseSchema.nextCursor for the contract — same
  // shape, applies to /directory's cursor-paginated reads.
  nextCursor: z.string().uuid().nullable().optional(),
}))();
export type DirectoryListResponse = z.infer<typeof DirectoryListResponseSchema>;

// ===== Phase 78 — Position ================================================

export const PositionStatusSchema = /* @__PURE__ */ (() => z.enum([
  'PLANNED',
  'OPEN',
  'FILLED',
  'FROZEN',
  'CLOSED',
]))();
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

export const PositionSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  code: z.string(),
  title: z.string(),
  jobProfileId: UuidSchema.nullable(),
  jobProfileTitle: z.string().nullable(),
  departmentId: UuidSchema.nullable(),
  departmentName: z.string().nullable(),
  costCenterId: UuidSchema.nullable(),
  costCenterCode: z.string().nullable(),
  managerAssociateId: UuidSchema.nullable(),
  managerName: z.string().nullable(),
  fteAuthorized: z.string(), // serialized Decimal
  status: PositionStatusSchema,
  filledByAssociateId: UuidSchema.nullable(),
  filledByName: z.string().nullable(),
  filledAt: z.string().datetime().nullable(),
  targetStartDate: z.string().nullable(), // YYYY-MM-DD
  minHourlyRate: z.string().nullable(),
  maxHourlyRate: z.string().nullable(),
  /** Headcount plan (HR pack 2026-10): the money set aside for the seat, per period. */
  budgetAmount: z.string().nullable(),
  budgetPeriod: z.enum(['ANNUAL', 'MONTHLY']).nullable(),
  notes: z.string().nullable(),
  /** Approval engine: the requisition that must be approved before the seat opens (null = none asked yet or not required). */
  requisition: z.object({ approvalId: UuidSchema, status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) }).nullable().optional(),
}))();
export type Position = z.infer<typeof PositionSchema>;

export const PositionListResponseSchema = /* @__PURE__ */ (() => z.object({
  positions: z.array(PositionSchema),
  /** True when the list hit its cap and more seats exist than were returned. */
  truncated: z.boolean().optional(),
}))();
export type PositionListResponse = z.infer<typeof PositionListResponseSchema>;

export const PositionInputSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  code: z.string().min(1).max(40),
  title: z.string().min(1).max(120),
  jobProfileId: UuidSchema.nullable().optional(),
  departmentId: UuidSchema.nullable().optional(),
  costCenterId: UuidSchema.nullable().optional(),
  managerAssociateId: UuidSchema.nullable().optional(),
  fteAuthorized: z.number().min(0.01).max(2.0).optional(),
  status: PositionStatusSchema.optional(),
  targetStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  minHourlyRate: z.number().min(0).max(99999.99).nullable().optional(),
  maxHourlyRate: z.number().min(0).max(99999.99).nullable().optional(),
  budgetAmount: z.number().min(0).max(99_999_999.99).nullable().optional(),
  budgetPeriod: z.enum(['ANNUAL', 'MONTHLY']).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
}))();
export type PositionInput = z.infer<typeof PositionInputSchema>;

export const PositionAssignInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  filledAt: z.string().datetime().optional(),
}))();
export type PositionAssignInput = z.infer<typeof PositionAssignInputSchema>;

export const PositionStatusInputSchema = /* @__PURE__ */ (() => z.object({
  status: PositionStatusSchema,
}))();
export type PositionStatusInput = z.infer<typeof PositionStatusInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Approval engine (2026-10) — maker-checker on the changes that move money,
 *  people or access. One record; the decider is never the requester.
 * -------------------------------------------------------------------------- */

export const ApprovalRequestKindSchema = /* @__PURE__ */ (() => z.enum([
  'PAY_RATE_CHANGE',
  'BILL_RATE_CHANGE',
  'SEPARATION_COMPLETE',
  'SELF_SERVICE_CHANGE',
  'PROMOTION',
  'REQUISITION',
  'ROLE_CHANGE',
  'WORKFLOW_GATE',
  'LABOR_RULES_LIVE',
  'PAYROLL_FUNDING_LIMIT',
  'TAX_PAYMENT',
  'DAILY_PAY_POLICY',
  'BILLING_ADJUSTMENT',
  'GARNISHMENT_PAYEE_BANK',
  'PAY_BY_CHECK',
  'BILL_APPROVAL',
  'VENDOR_BANK',
  'PERIOD_REOPEN',
  'PAY_RATE_BATCH',
]))();
export type ApprovalRequestKind = z.infer<typeof ApprovalRequestKindSchema>;

export const APPROVAL_REQUEST_KIND_LABELS: Record<ApprovalRequestKind, string> = {
  PAY_RATE_CHANGE: 'Pay rate',
  BILL_RATE_CHANGE: 'Bill rate',
  SEPARATION_COMPLETE: 'Separation',
  SELF_SERVICE_CHANGE: 'Profile change',
  PROMOTION: 'Promotion',
  REQUISITION: 'Requisition',
  ROLE_CHANGE: 'Access change',
  WORKFLOW_GATE: 'Workflow gate',
  LABOR_RULES_LIVE: 'Labor rules go live',
  PAYROLL_FUNDING_LIMIT: 'Payroll funding limit',
  TAX_PAYMENT: 'Tax payment',
  DAILY_PAY_POLICY: 'Daily pay policy',
  BILLING_ADJUSTMENT: 'Billing adjustment',
  GARNISHMENT_PAYEE_BANK: 'Garnishment payee bank',
  PAY_BY_CHECK: 'Paper check this payday',
  BILL_APPROVAL: 'Vendor bill',
  VENDOR_BANK: 'Vendor bank account',
  PERIOD_REOPEN: 'Reopen a closed month',
  PAY_RATE_BATCH: 'Pay change for many people',
};

export const ApprovalRequestStatusSchema = /* @__PURE__ */ (() => z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']))();
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

const NamedPersonSchema = /* @__PURE__ */ (() => z.object({ id: UuidSchema, name: z.string() }))();

export const ApprovalRequestSummarySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  kind: ApprovalRequestKindSchema,
  status: ApprovalRequestStatusSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  proposed: z.unknown(),
  before: z.unknown().nullable(),
  requester: NamedPersonSchema.nullable(),
  approverRule: z.object({ capability: z.string().nullable(), userId: z.string().nullable(), role: z.string().nullable() }),
  clientId: UuidSchema.nullable(),
  associateId: UuidSchema.nullable(),
  decidedBy: NamedPersonSchema.nullable(),
  decidedAt: z.string().nullable(),
  reason: z.string().nullable(),
  appliedAt: z.string().nullable(),
  applyError: z.string().nullable(),
  createdAt: z.string(),
  /** Whether the signed-in person may decide it (the server's rule). */
  mayDecide: z.boolean(),
}))();
export type ApprovalRequestSummary = z.infer<typeof ApprovalRequestSummarySchema>;

export const ApprovalDecideInputSchema = /* @__PURE__ */ (() => z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(2000).optional().nullable(),
}))();
export type ApprovalDecideInput = z.infer<typeof ApprovalDecideInputSchema>;

/** What a route answers when the change went to a second person instead of landing (HTTP 202). */
export const PendingApprovalResponseSchema = /* @__PURE__ */ (() => z.object({
  pending: z.literal(true),
  approvalId: UuidSchema,
  title: z.string(),
}))();
export type PendingApprovalResponse = z.infer<typeof PendingApprovalResponseSchema>;

export const ApprovalDelegationInputSchema = /* @__PURE__ */ (() => z.object({
  toUserId: UuidSchema,
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(200).optional().nullable(),
}))();
export type ApprovalDelegationInput = z.infer<typeof ApprovalDelegationInputSchema>;

export const ApprovalDelegationSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  startsOn: z.string(),
  endsOn: z.string(),
  note: z.string().nullable(),
  from: NamedPersonSchema,
  to: NamedPersonSchema,
}))();
export type ApprovalDelegation = z.infer<typeof ApprovalDelegationSchema>;

/** Temporary elevated access: a role until a date, reverted by the sweep. */
export const AccessGrantInputSchema = /* @__PURE__ */ (() => z.object({
  userId: UuidSchema,
  role: RoleSchema,
  /** ISO datetime; at most 30 days out. */
  until: z.string().datetime(),
  reason: z.string().trim().min(3).max(300),
}))();
export type AccessGrantInput = z.infer<typeof AccessGrantInputSchema>;

export const AccessGrantSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  user: z.object({ id: UuidSchema, name: z.string(), email: z.string() }),
  role: RoleSchema,
  grantedBy: NamedPersonSchema.nullable(),
  reason: z.string(),
  expiresAt: z.string(),
  revertedAt: z.string().nullable(),
  revertedWhy: z.string().nullable(),
  createdAt: z.string(),
}))();
export type AccessGrant = z.infer<typeof AccessGrantSchema>;

export const PromotionStatusSchema = /* @__PURE__ */ (() => z.enum(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED']))();
export type PromotionStatus = z.infer<typeof PromotionStatusSchema>;

export const PromotionInputSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  jobProfileId: UuidSchema.nullable().optional(),
  newTitle: z.string().trim().max(120).nullable().optional(),
  level: z.string().trim().max(40).nullable().optional(),
  payType: z.enum(['HOURLY', 'SALARY']).nullable().optional(),
  amount: z.number().positive().max(99_999_999.99).nullable().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(2000).nullable().optional(),
}))();
export type PromotionInput = z.infer<typeof PromotionInputSchema>;

export const PromotionSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  jobProfileId: UuidSchema.nullable(),
  jobProfileTitle: z.string().nullable(),
  newTitle: z.string().nullable(),
  level: z.string().nullable(),
  payType: z.enum(['HOURLY', 'SALARY']).nullable(),
  amount: z.string().nullable(),
  currentAmount: z.string().nullable(),
  effectiveFrom: z.string(),
  notes: z.string().nullable(),
  status: PromotionStatusSchema,
  approvalRequestId: UuidSchema.nullable(),
  requestedBy: NamedPersonSchema.nullable(),
  letterDocumentId: UuidSchema.nullable(),
  appliedAt: z.string().nullable(),
  createdAt: z.string(),
}))();
export type Promotion = z.infer<typeof PromotionSchema>;

export const WorkflowTaskSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  title: z.string(),
  details: z.string().nullable(),
  assigneeUserId: UuidSchema.nullable(),
  assigneeRole: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: UuidSchema.nullable(),
  linkUrl: z.string().nullable(),
  dueAt: z.string().nullable(),
  status: z.enum(['OPEN', 'DONE']),
  doneAt: z.string().nullable(),
  createdAt: z.string(),
}))();
export type WorkflowTask = z.infer<typeof WorkflowTaskSchema>;

/** A pay or bill-rate change as Finance reads it from the audit trail. */
export const PayChangeRowSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  at: z.string(),
  kind: z.enum(['pay', 'bill']),
  actor: NamedPersonSchema.nullable(),
  associateId: UuidSchema.nullable(),
  associateName: z.string().nullable(),
  clientId: UuidSchema.nullable(),
  position: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  effectiveFrom: z.string().nullable(),
  reason: z.string().nullable(),
  approvalRequestId: UuidSchema.nullable(),
  note: z.string().nullable(),
}))();
export type PayChangeRow = z.infer<typeof PayChangeRowSchema>;

export const PositionHeadcountSchema = /* @__PURE__ */ (() => z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(PositionStatusSchema, z.number().int().nonnegative()),
  fteAuthorized: z.string(),
  fteFilled: z.string(),
}))();
export type PositionHeadcount = z.infer<typeof PositionHeadcountSchema>;

/* -------------------------------------------------------------------------- *
 *  Compliance Scorecard — Walmart Contract Compliance dashboard
 *
 *  Each tile has its own GET endpoint so the page can refresh them
 *  independently. Tiles 3 (shifts) and 4 (billing) include "unsupported"
 *  signals — schema for shift-lead presence, MOD sign-off, temp logs,
 *  Fieldglass timesheets, invoice tracking, and monthly reports doesn't
 *  exist yet. The UI shows them as "Coming soon" rather than fake numbers.
 * -------------------------------------------------------------------------- */

export const ComplianceTagSchema = /* @__PURE__ */ (() => z.enum([
  'EEO_HARASSMENT',
  'OSHA_SAFETY',
  'WALMART_CADE',
  'FOOD_HANDLER',
]))();
export type ComplianceTag = z.infer<typeof ComplianceTagSchema>;

export const EVerifyStatusSchema = /* @__PURE__ */ (() => z.enum([
  'PENDING',
  'EMPLOYMENT_AUTHORIZED',
  'TENTATIVE_NONCONFIRMATION',
  'FINAL_NONCONFIRMATION',
  'CLOSE_CASE_AND_RESUBMIT',
]))();
export type EVerifyStatus = z.infer<typeof EVerifyStatusSchema>;

/* -------------------------------------------------------------------------- *
 *  E-Verify directorate
 *
 *  Staging surface for the federal E-Verify portal: everything the government
 *  form asks for, in one payload, plus a record of the case outcome. HR was
 *  spending ~20 minutes per case gathering these fields off five screens.
 *
 *  Defined after EVerifyStatusSchema because it references it — module-level
 *  consts are in the temporal dead zone until their declaration runs.
 * -------------------------------------------------------------------------- */

export const I9CitizenshipStatusSchema = /* @__PURE__ */ (() => z.enum([
  'US_CITIZEN',
  'NON_CITIZEN_NATIONAL',
  'LAWFUL_PERMANENT_RESIDENT',
  'ALIEN_AUTHORIZED_TO_WORK',
]))();
export type I9CitizenshipStatus = z.infer<typeof I9CitizenshipStatusSchema>;

export const EVerifyBlockerSchema = /* @__PURE__ */ (() => z.enum([
  'NO_I9',
  'SECTION1_INCOMPLETE',
  'SECTION2_INCOMPLETE',
  'NO_CITIZENSHIP',
  'NO_SSN',
  'NO_DOB',
  'NO_HIRE_DATE',
]))();
export type EVerifyBlocker = z.infer<typeof EVerifyBlockerSchema>;

/** One row of the directory. SSN is last-4 only here — the full number is
 *  returned solely by the per-associate detail endpoint, which is audited. */
export const EVerifyRosterRowSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  associateName: z.string(),
  associateEmail: z.string(),
  /** The associate's current client (open assignment, else latest approved
   *  application) — feeds the client filter. Null mid-onboarding. */
  clientId: UuidSchema.nullable().optional(),
  clientName: z.string().nullable().optional(),
  hireDate: z.string().nullable(),
  ssnLast4: z.string().nullable(),
  caseNumber: z.string().nullable(),
  status: EVerifyStatusSchema.nullable(),
  caseOpenedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  /** 3 business days after the hire date — the federal filing deadline. */
  dueBy: z.string().nullable(),
  /** Past the deadline with no case opened. */
  overdue: z.boolean(),
  blockers: z.array(EVerifyBlockerSchema),
  ready: z.boolean(),
}))();
export type EVerifyRosterRow = z.infer<typeof EVerifyRosterRowSchema>;

export const EVerifyRosterResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(EVerifyRosterRowSchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    authorized: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    nonconfirmation: z.number().int().nonnegative(),
    notRun: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
}))();
export type EVerifyRosterResponse = z.infer<typeof EVerifyRosterResponseSchema>;

/** An identity document attached to the I-9, for the Section 2 panel. */
export const EVerifyDocumentSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  kind: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  side: z.enum(['FRONT', 'BACK']).nullable(),
  /** Federal catalog identity — null on records uploaded before the
   *  catalog existed (never backfilled). */
  i9DocTitle: z.string().nullable().optional(),
  i9List: I9DocListSchema.nullable().optional(),
  fileAvailable: z.boolean(),
}))();
export type EVerifyDocument = z.infer<typeof EVerifyDocumentSchema>;

/**
 * The aggregation payload — the whole point of the feature. Field order
 * mirrors the federal "Enter Form I-9 Information" screens so a verifier
 * reads straight down one column instead of hunting across the product.
 *
 * Carries a FULL SSN. Returned only to manage:compliance holders and audited
 * on every read.
 */
export const EVerifyCaseDetailSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  // --- Section 1: employee information and attestation ---
  lastName: z.string(),
  firstName: z.string(),
  middleInitial: z.string().nullable(),
  otherLastNames: z.array(z.string()),
  dob: z.string().nullable(),
  ssn: z.string().nullable(),
  email: z.string().nullable(),
  citizenshipStatus: I9CitizenshipStatusSchema.nullable(),
  alienRegistrationNumber: z.string().nullable(),
  workAuthExpiresAt: z.string().nullable(),
  // --- Section 2: employer review and verification ---
  documentList: I9DocumentListSchema.nullable(),
  documents: z.array(EVerifyDocumentSchema),
  /**
   * The case packet E-Verify hands back once a case is closed — HR downloads
   * it from the federal portal and uploads it here. Stored as
   * I9_VERIFICATION_RESULT documents; kept separate from `documents` (the
   * associate's identity papers) because they answer different questions:
   * one is what was inspected, the other is what the government returned.
   */
  packets: z.array(EVerifyDocumentSchema),
  /**
   * Everything else on the associate's file — the misfiled-passport net.
   * Associates regularly upload identity papers into the wrong checklist
   * slot during onboarding; the record then carries a non-identity kind and
   * the two arrays above can't see it, so the case view reads "no documents"
   * while the passport sits on the profile as OTHER. Surfaced (collapsed in
   * the UI) so the verifier can find and reclassify it instead.
   */
  otherDocuments: z.array(EVerifyDocumentSchema),
  section1CompletedAt: z.string().datetime().nullable(),
  section2CompletedAt: z.string().datetime().nullable(),
  section2VerifierEmail: z.string().nullable(),
  // --- Case state ---
  hireDate: z.string().nullable(),
  /**
   * The earliest clock-in on record, ISO, or null if they have never
   * worked. NOT the hire date: the I-9's three-business-day clock runs
   * from the first day of employment for pay, and the hire date is the
   * day the offer was dated — routinely weeks earlier.
   */
  firstClockInAt: z.string().datetime().nullable(),
  dueBy: z.string().nullable(),
  overdue: z.boolean(),
  caseNumber: z.string().nullable(),
  status: EVerifyStatusSchema.nullable(),
  caseOpenedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  blockers: z.array(EVerifyBlockerSchema),
  ready: z.boolean(),
}))();
export type EVerifyCaseDetail = z.infer<typeof EVerifyCaseDetailSchema>;

export const EVerifyCaseInputSchema = /* @__PURE__ */ (() => z
  .object({
    caseNumber: z.string().trim().min(1).max(60).nullable().optional(),
    status: EVerifyStatusSchema.nullable().optional(),
    caseOpenedAt: z.string().datetime().nullable().optional(),
    closedAt: z.string().datetime().nullable().optional(),
  })
  .refine(
    (v) =>
      // A closed case with no number is unusable: the case number is the only
      // handle back into the federal portal if the outcome is ever queried.
      !v.closedAt || (v.caseNumber !== undefined && v.caseNumber !== null),
    { message: 'caseNumber is required when closing a case', path: ['caseNumber'] },
  )
  .refine(
    (v) =>
      // Same reasoning for a terminal outcome recorded without a number.
      !v.status ||
      v.status === 'PENDING' ||
      (v.caseNumber !== undefined && v.caseNumber !== null),
    { message: 'caseNumber is required to record an outcome', path: ['caseNumber'] },
  ))();
export type EVerifyCaseInput = z.infer<typeof EVerifyCaseInputSchema>;

/** Narrow on purpose: this screen labels an identity, it doesn't rewrite one.
 *  Name, DOB and SSN stay owned by onboarding. */
export const EVerifyIdentityInputSchema = /* @__PURE__ */ (() => z.object({
  middleInitial: z.string().trim().max(1).nullable().optional(),
  otherLastNames: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
}))();
export type EVerifyIdentityInput = z.infer<typeof EVerifyIdentityInputSchema>;

export const ScorecardSeveritySchema = /* @__PURE__ */ (() => z.enum(['ok', 'warn', 'critical']))();
export type ScorecardSeverity = z.infer<typeof ScorecardSeveritySchema>;

/**
 * THE severity thresholds — one table, shared by the API's tile builders
 * and the web page's progress bars. They used to disagree (server said
 * critical above 10% failing; the UI colored bars on a 95/80 completion
 * scale), so a signal could render a warning-yellow bar under a Critical
 * tile badge.
 */
export const SCORECARD_CRITICAL_FAIL_PCT = 10;
export function scorecardSeverityFromFailPct(failPct: number): ScorecardSeverity {
  if (failPct > SCORECARD_CRITICAL_FAIL_PCT) return 'critical';
  if (failPct > 0) return 'warn';
  return 'ok';
}

/** Letter grade for the weighted 0–100 compliance score. */
export function scorecardGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 95) return 'A';
  if (score >= 85) return 'B';
  if (score >= 75) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

const ScorecardSubjectSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema.nullable(),
  associateName: z.string().nullable(),
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
  /** Statutory deadline (ISO date) for this gap, when one exists —
   *  I-9 §2 / E-Verify three-business-day windows. */
  dueBy: z.string().nullable().optional(),
  /** Days PAST dueBy (positive = overdue). Null/absent = not applicable. */
  daysOverdue: z.number().int().nullable().optional(),
}))();
export type ScorecardSubject = z.infer<typeof ScorecardSubjectSchema>;

// Tile 1 — onboarding completeness
export const ScorecardOnboardingSignalSchema = /* @__PURE__ */ (() => z.object({
  key: z.enum([
    'AGE_18_PLUS',
    'DRUG_TEST_60D',
    'BACKGROUND_CHECK',
    'I9_BOTH_SECTIONS',
    'E_VERIFY',
    'W4_ON_FILE',
    'OFFER_LETTER_SIGNED',
    'POLICY_ACK_SIGNED',
  ]),
  label: z.string(),
  contractClause: z.string(),
  completedCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  missing: z.array(ScorecardSubjectSchema),
  /** How many of the missing are PAST a statutory deadline (I-9 §2 /
   *  E-Verify 3-business-day windows). Any overdue forces the signal —
   *  and its tile — critical regardless of population percentage. */
  overdueCount: z.number().int().nonnegative().optional(),
}))();
export type ScorecardOnboardingSignal = z.infer<typeof ScorecardOnboardingSignalSchema>;

export const ScorecardOnboardingResponseSchema = /* @__PURE__ */ (() => z.object({
  activeAssociateCount: z.number().int().nonnegative(),
  // Number of active associates passing every signal (no gaps). Computed
  // server-side because the per-signal `missing[]` lists are capped for
  // payload size, so the client can't reliably take their union.
  fullyCompliantCount: z.number().int().nonnegative(),
  signals: z.array(ScorecardOnboardingSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
}))();
export type ScorecardOnboardingResponse = z.infer<typeof ScorecardOnboardingResponseSchema>;

/* ----- Manual compliance attestation (replaces Coming-soon rows) -------- */

export const ManualAttestationCadenceSchema = /* @__PURE__ */ (() => z.enum(['WEEKLY', 'MONTHLY', 'ANNUAL']))();
export type ManualAttestationCadence = z.infer<typeof ManualAttestationCadenceSchema>;

export const ManualAttestationOutcomeSchema = /* @__PURE__ */ (() => z.enum(['YES', 'NO', 'NOT_APPLICABLE']))();
export type ManualAttestationOutcome = z.infer<typeof ManualAttestationOutcomeSchema>;

export const ManualAttestationStatusSchema = /* @__PURE__ */ (() => z.enum([
  'attested',
  'due_soon',
  'overdue',
  'upcoming',
]))();
export type ManualAttestationStatus = z.infer<typeof ManualAttestationStatusSchema>;

export const ManualAttestationSignalSchema = /* @__PURE__ */ (() => z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  cadence: ManualAttestationCadenceSchema,
  /** Inclusive ISO date (YYYY-MM-DD) covering the start of the current period. */
  periodStart: z.string(),
  /** Inclusive ISO date covering the end of the current period. */
  periodEnd: z.string(),
  /** ISO date the attestation must be filed by. */
  dueDate: z.string(),
  status: ManualAttestationStatusSchema,
  /** Latest attestation for the current period, if any. */
  current: z
    .object({
      id: UuidSchema,
      outcome: ManualAttestationOutcomeSchema,
      actionTakenAt: z.string().datetime().nullable(),
      attestedById: UuidSchema,
      attestedByEmail: z.string().email(),
      attestedAt: z.string().datetime(),
      notes: z.string().nullable(),
      evidenceDocumentId: UuidSchema.nullable(),
    })
    .nullable(),
  /** Snapshot of the prior period's attestation for context. */
  previous: z
    .object({
      periodStart: z.string(),
      periodEnd: z.string(),
      outcome: ManualAttestationOutcomeSchema,
      actionTakenAt: z.string().datetime().nullable(),
    })
    .nullable(),
  /** Reminders put off until this moment (ISO) for the current period; null = not snoozed. */
  snoozedUntil: z.string().datetime().nullable().optional(),
}))();
export type ManualAttestationSignal = z.infer<typeof ManualAttestationSignalSchema>;

export const ManualAttestationListResponseSchema = /* @__PURE__ */ (() => z.object({
  signals: z.array(ManualAttestationSignalSchema),
}))();
export type ManualAttestationListResponse = z.infer<typeof ManualAttestationListResponseSchema>;

export const ManualAttestationCreateInputSchema = /* @__PURE__ */ (() => z
  .object({
    key: z.string().min(1).max(64),
    /** Period the attestation covers — the API validates it matches a known config period. */
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    outcome: ManualAttestationOutcomeSchema,
    /** When the actual action happened (null when outcome=NOT_APPLICABLE). */
    actionTakenAt: z.string().datetime().nullable(),
    notes: z.string().max(1000).nullable(),
    evidenceDocumentId: UuidSchema.nullable(),
  })
  .refine(
    (v) => v.outcome === 'NOT_APPLICABLE' || v.actionTakenAt !== null,
    {
      message: 'actionTakenAt is required when outcome is YES or NO',
      path: ['actionTakenAt'],
    },
  ))();
export type ManualAttestationCreateInput = z.infer<
  typeof ManualAttestationCreateInputSchema
>;

/** Signals the ASSOCIATE can fix themselves — the only ones "Nudge all
 *  missing" accepts. I-9 §2 / E-Verify / background / age are HR-side
 *  work; nudging the associate for those would be noise. */
export const ScorecardNudgeableSignalSchema = /* @__PURE__ */ (() => z.enum([
  'DRUG_TEST_60D',
  'W4_ON_FILE',
  'OFFER_LETTER_SIGNED',
  'POLICY_ACK_SIGNED',
]))();
export type ScorecardNudgeableSignal = z.infer<typeof ScorecardNudgeableSignalSchema>;

export const ScorecardNudgeInputSchema = /* @__PURE__ */ (() => z.object({
  signalKey: ScorecardNudgeableSignalSchema,
  clientId: UuidSchema.optional(),
}))();
export type ScorecardNudgeInput = z.infer<typeof ScorecardNudgeInputSchema>;

export const ScorecardNudgeResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Associates notified this call. */
  nudged: z.number().int().nonnegative(),
  /** Skipped — already nudged for this signal within the last 7 days. */
  deduped: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
}))();
export type ScorecardNudgeResponse = z.infer<typeof ScorecardNudgeResponseSchema>;

// Tile 2 — expiring documents (30/60/90)
export const ScorecardExpirationKindSchema = /* @__PURE__ */ (() => z.enum([
  'WORKERS_COMP',
  'GENERAL_LIABILITY',
  'DRUG_TEST',
  'I9_WORK_AUTH',
  'J1_DS2019',
  'TRAINING_CERT',
  // Real expiry columns that were indexed but never queried by the tile:
  'DOCUMENT', // DocumentRecord.expiresAt (any kind carrying a date)
  'VACCINATION', // VaccinationRecord.expiresOn
  'AGREEMENT', // Agreement.expiresOn
]))();
export type ScorecardExpirationKind = z.infer<typeof ScorecardExpirationKindSchema>;

export const ScorecardExpiringItemSchema = /* @__PURE__ */ (() => z.object({
  kind: ScorecardExpirationKindSchema,
  label: z.string(),
  expiresAt: z.string(),
  daysUntil: z.number().int(),
  subject: ScorecardSubjectSchema,
}))();
export type ScorecardExpiringItem = z.infer<typeof ScorecardExpiringItemSchema>;

export const ScorecardExpirationsResponseSchema = /* @__PURE__ */ (() => z.object({
  buckets: z.object({
    red: z.array(ScorecardExpiringItemSchema),    // 0–30 days
    amber: z.array(ScorecardExpiringItemSchema),  // 31–60 days
    green: z.array(ScorecardExpiringItemSchema),  // 61–90 days
  }),
  /**
   * Insurance-policy attestations that don't have an expiry-date model
   * yet (Workers Comp, General Liability). Same manual-attestation pattern
   * as the Billing tile — HR confirms each year that coverage is current.
   */
  attestations: z.array(ManualAttestationSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
}))();
export type ScorecardExpirationsResponse = z.infer<typeof ScorecardExpirationsResponseSchema>;

// Tile 3 — shift compliance
export const ScorecardShiftSignalSchema = /* @__PURE__ */ (() => z.object({
  key: z.enum([
    'FILL_RATE',
    'NO_SHOW_RATE',
    'SHIFT_LEAD_PRESENT',
    'TEMPERATURE_LOGS',
    'MOD_SIGNOFF',
    'FIELDGLASS_TIMESHEETS',
  ]),
  label: z.string(),
  contractClause: z.string(),
  status: z.enum(['live', 'unsupported']),
  // Live signals carry a percent + target. Unsupported signals carry only
  // the label + a reason the UI can show as "Coming soon".
  value: z.number().nullable(),
  target: z.number().nullable(),
  reason: z.string().nullable(),
}))();
export type ScorecardShiftSignal = z.infer<typeof ScorecardShiftSignalSchema>;

export const ScorecardShiftsResponseSchema = /* @__PURE__ */ (() => z.object({
  windowDays: z.number().int().positive(),
  signals: z.array(ScorecardShiftSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
}))();
export type ScorecardShiftsResponse = z.infer<typeof ScorecardShiftsResponseSchema>;

// Tile 4 — billing & invoicing
export const ScorecardBillingRateRowSchema = /* @__PURE__ */ (() => z.object({
  clientId: UuidSchema,
  clientName: z.string(),
  jobId: UuidSchema,
  jobName: z.string(),
  billRate: z.number(),
  expectedRate: z.number().nullable(),
  match: z.boolean(),
}))();
export type ScorecardBillingRateRow = z.infer<typeof ScorecardBillingRateRowSchema>;

/** A FINAL unpaid statement aging toward the Walmart MSA 90-day forfeiture
 *  window. Live receivables data — the weekly INVOICE_FORFEITURE attestation
 *  confirms the human review; this is the list that review looks at. */
export const ScorecardAtRiskStatementSchema = /* @__PURE__ */ (() => z.object({
  statementId: UuidSchema,
  clientId: UuidSchema,
  clientName: z.string(),
  number: z.number().int().nullable(),
  finalizedAt: z.string().datetime(),
  ageDays: z.number().int().nonnegative(),
  /** 90 − ageDays; negative = past the forfeiture window. */
  daysToForfeit: z.number().int(),
  /** Statement total from its snapshot; null when the snapshot predates totals. */
  amount: z.number().nullable(),
}))();
export type ScorecardAtRiskStatement = z.infer<typeof ScorecardAtRiskStatementSchema>;

export const ScorecardBillingResponseSchema = /* @__PURE__ */ (() => z.object({
  rateChecks: z.array(ScorecardBillingRateRowSchema),
  /** FINAL unpaid statements ≥60 days old, oldest first. */
  atRiskStatements: z.array(ScorecardAtRiskStatementSchema),
  /** Total FINAL unpaid statements examined for the at-risk list. */
  unpaidFinalCount: z.number().int().nonnegative(),
  /** Manual-attestation signals that used to be "Coming soon" placeholders. */
  attestations: z.array(ManualAttestationSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
}))();
export type ScorecardBillingResponse = z.infer<typeof ScorecardBillingResponseSchema>;

// Tile 5 — training completeness
export const ScorecardTrainingSignalSchema = /* @__PURE__ */ (() => z.object({
  tag: ComplianceTagSchema,
  label: z.string(),
  contractClause: z.string(),
  // No Course tagged with this complianceTag → status = 'no_course'.
  // Course exists but no enrollments → status = 'no_enrollments'.
  // Otherwise live counts.
  status: z.enum(['live', 'no_course', 'no_enrollments']),
  completedCount: z.number().int().nonnegative(),
  totalAssociates: z.number().int().nonnegative(),
  missing: z.array(ScorecardSubjectSchema),
  /** EVERY missing associate id (missing[] above is capped for display).
   *  Feeds the bulk-enroll action, which chunks these into the existing
   *  POST /courses/:id/enroll (max 500/call). */
  missingIds: z.array(UuidSchema),
  /** PUBLISHED courses carrying this tag — the enroll targets. */
  courses: z.array(z.object({ id: UuidSchema, title: z.string() })),
}))();
export type ScorecardTrainingSignal = z.infer<typeof ScorecardTrainingSignalSchema>;

export const ScorecardTrainingResponseSchema = /* @__PURE__ */ (() => z.object({
  signals: z.array(ScorecardTrainingSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
}))();
export type ScorecardTrainingResponse = z.infer<typeof ScorecardTrainingResponseSchema>;

// Tile 6 — open actions (rolled up from the other tiles server-side)
export const ScorecardActionStateSchema = /* @__PURE__ */ (() => z.object({
  status: z.enum(['OPEN', 'SNOOZED', 'DONE']),
  assigneeUserId: UuidSchema.nullable(),
  assigneeEmail: z.string().nullable(),
  snoozedUntil: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}))();
export type ScorecardActionState = z.infer<typeof ScorecardActionStateSchema>;

export const ScorecardActionSchema = /* @__PURE__ */ (() => z.object({
  id: z.string(),
  severity: ScorecardSeveritySchema,
  title: z.string(),
  contractClause: z.string(),
  subject: ScorecardSubjectSchema,
  link: z.string().nullable(),  // SPA path, e.g. "/people?associate=..."
  /** Persisted remediation state (assignment/snooze). Absent = untouched. */
  state: ScorecardActionStateSchema.nullable().optional(),
}))();
export type ScorecardAction = z.infer<typeof ScorecardActionSchema>;

export const ScorecardActionsResponseSchema = /* @__PURE__ */ (() => z.object({
  actions: z.array(ScorecardActionSchema),
  criticalCount: z.number().int().nonnegative(),
  warnCount: z.number().int().nonnegative(),
  /** Weighted 0–100 org compliance score (see scorecardGrade). */
  score: z.number().int().min(0).max(100),
  /** True when the action list hit the response cap — the CSV export and
   *  the drawer both surface this so nobody mistakes a page for the world. */
  truncated: z.boolean(),
  totalActionCount: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
}))();
export type ScorecardActionsResponse = z.infer<typeof ScorecardActionsResponseSchema>;

export const ScorecardActionStateInputSchema = /* @__PURE__ */ (() => z.object({
  /** The derived action id (stable across regenerations). */
  actionId: z.string().min(1).max(300),
  status: z.enum(['OPEN', 'SNOOZED', 'DONE']).optional(),
  /** Assign to a user (null clears). Omit to leave unchanged. */
  assigneeUserId: UuidSchema.nullable().optional(),
  /** Required when status=SNOOZED. */
  snoozedUntil: z.string().datetime().nullable().optional(),
}))();
export type ScorecardActionStateInput = z.infer<typeof ScorecardActionStateInputSchema>;

export const ScorecardHistoryPointSchema = /* @__PURE__ */ (() => z.object({
  day: z.string(), // YYYY-MM-DD
  score: z.number().int().min(0).max(100),
  criticalCount: z.number().int().nonnegative(),
  warnCount: z.number().int().nonnegative(),
  activeAssociateCount: z.number().int().nonnegative(),
  fullyCompliantCount: z.number().int().nonnegative(),
}))();
export type ScorecardHistoryPoint = z.infer<typeof ScorecardHistoryPointSchema>;

export const ScorecardHistoryResponseSchema = /* @__PURE__ */ (() => z.object({
  points: z.array(ScorecardHistoryPointSchema),
  /** Score delta vs ~7 days ago (null when no snapshot exists that far back). */
  weekDelta: z.number().int().nullable(),
}))();
export type ScorecardHistoryResponse = z.infer<typeof ScorecardHistoryResponseSchema>;

// ----- Tile 7 — OSHA safety ------------------------------------------------
// The tile READS the pre-existing OSHA injury log (Phase 88 — OshaIncident,
// managed at /compliance/osha). These schemas mirror that model's enums;
// they do not define a second incident system.

export const OshaIncidentSeveritySchema = /* @__PURE__ */ (() => z.enum([
  'FIRST_AID',
  'MEDICAL_TREATMENT',
  'RESTRICTED_DUTY',
  'DAYS_AWAY',
  'FATAL',
]))();
export type OshaIncidentSeverity = z.infer<typeof OshaIncidentSeveritySchema>;

export const OshaIncidentStatusSchema = /* @__PURE__ */ (() => z.enum([
  'REPORTED',
  'INVESTIGATING',
  'RESOLVED',
  'ESCALATED',
]))();
export type OshaIncidentStatus = z.infer<typeof OshaIncidentStatusSchema>;

/** DART = the recordables that involved days away or restricted duty. */
export function isDartSeverity(severity: OshaIncidentSeverity): boolean {
  return severity === 'DAYS_AWAY' || severity === 'RESTRICTED_DUTY';
}

/** Incident-rate targets: incidents × 200,000 ÷ hours worked (the OSHA
 *  normalization — 100 FTEs × 40h × 50wk). BLS staffing/warehousing runs
 *  ~4.5; these targets are the bar we hold ourselves to, not the average. */
export const OSHA_TRIR_TARGET = 3.0;
export const OSHA_DART_TARGET = 2.0;

/** One OshaIncident as the scorecard tile surfaces it. */
export const ScorecardSafetyIncidentSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema.nullable(),
  associateName: z.string().nullable(),
  clientId: UuidSchema,
  clientName: z.string().nullable(),
  occurredAt: z.string().datetime(),
  location: z.string().nullable(),
  description: z.string(),
  bodyPart: z.string().nullable(),
  severity: OshaIncidentSeveritySchema,
  isRecordable: z.boolean(),
  daysAway: z.number().int().nonnegative(),
  daysRestricted: z.number().int().nonnegative(),
  status: OshaIncidentStatusSchema,
}))();
export type ScorecardSafetyIncident = z.infer<typeof ScorecardSafetyIncidentSchema>;

export const ScorecardSafetyResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Whole days since the most recent recordable, all-time. Null = none ever
   *  (the factory sign reads "—", which is the best possible number). */
  daysSinceLastRecordable: z.number().int().nonnegative().nullable(),
  recordableCountYtd: z.number().int().nonnegative(),
  dartCountYtd: z.number().int().nonnegative(),
  /** Hours worked YTD (completed/approved time entries) — the TRIR denominator. */
  hoursWorkedYtd: z.number().nonnegative(),
  /** Null when there are no hours yet to normalize against. */
  trir: z.number().nonnegative().nullable(),
  dart: z.number().nonnegative().nullable(),
  /** Unresolved incidents (REPORTED / INVESTIGATING / ESCALATED). */
  openIncidents: z.array(ScorecardSafetyIncidentSchema),
  attestations: z.array(ManualAttestationSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
}))();
export type ScorecardSafetyResponse = z.infer<typeof ScorecardSafetyResponseSchema>;

// =============================================================================
// Org branding (settings audit row #8)
// =============================================================================

// Tight hex regex — must be #RRGGBB (no shorthand). Keeps the email rendering
// path simple (no need to expand #ABC → #AABBCC) and survives copy-paste from
// any colour picker.
export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

// Logos go inline (data: URI) in HTML emails so we don't depend on a CDN.
// 1MB cap keeps the row small + the HTML email under most provider limits.
export const ORG_LOGO_MAX_BYTES = 1024 * 1024;
export const ORG_LOGO_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
] as const;
export type OrgLogoContentType = (typeof ORG_LOGO_ALLOWED_TYPES)[number];

// Org-enforced MFA policy. Mirrors the Prisma MfaRequirement enum; the
// role mapping for ADMINS lives in roles.ts (isMfaAdminRole).
export const MfaRequirementSchema = /* @__PURE__ */ (() => z.enum(['OFF', 'ADMINS', 'ALL']))();

/* ---------------------------------------------------------------------------
 *  Names (product taxonomy, 2026-10-13). Hugo is the orchestrator and the
 *  assistant persona; each tenant picks what its team calls him. Compass is
 *  the logo mark only.
 * -------------------------------------------------------------------------- */
export const PRODUCT_NAME = 'Alto People';
export const ASSISTANT_PLATFORM_NAME = 'Hugo';
export const ASSISTANT_NAME_PROMPT = 'What would you like your team to call me?';

export const OrgBrandingSchema = /* @__PURE__ */ (() => z.object({
  orgName: z.string().min(1).max(120),
  /** The tenant's display name for Hugo. */
  assistantName: z.string().min(1).max(60),
  /** Brief 1A-2: trailing days of work that make an associate active. */
  activeWindowDays: z.number().int().min(1).max(90),
  /** Brief 1A-2: the company workweek start (0 = Sunday … 6 = Saturday) and time zone. */
  weekStartsOn: z.number().int().min(0).max(6),
  timezone: z.string().min(1).max(64),
  senderName: z.string().min(1).max(120).nullable(),
  supportEmail: z
    .string()
    .max(254)
    .regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, 'Must be a bare email address.')
    .nullable(),
  primaryColor: z
    .string()
    .regex(HEX_COLOR_REGEX, 'Must be a #RRGGBB hex colour.')
    .nullable(),
  // Logo URL on the API host (server reads bytes from DB and serves with
  // the right content-type). Null when no logo uploaded.
  logoUrl: z.string().nullable(),
  logoUpdatedAt: z.string().datetime().nullable(),
  // Security — org-enforced MFA. Not branding, but it lives on the same
  // OrgSetting singleton and rides the same GET/PATCH surface.
  mfaRequirement: MfaRequirementSchema,
  // Finance — where financial-change alerts also go, and what payroll does
  // with a bank change Finance has not verified by the cutoff.
  financeMailbox: z.string().nullable(),
  unverifiedPayoutPolicy: UnverifiedPayoutPolicySchema,
  // Approval engine (2026-10) — the maker-checker switches. A second person
  // is required only where one exists.
  payChangeApprovalPct: z.number().int().min(0).max(100),
  payChangeAlwaysApprove: z.boolean(),
  billRateApproval: z.boolean(),
  separationSecondPerson: z.boolean(),
  selfServiceApproval: z.boolean(),
  roleChangeApproval: z.boolean(),
  requisitionApproval: z.boolean(),
  /** Before a payroll run pays out, someone signs off on its review report. */
  payrollReviewRequired: z.boolean(),
  /** Finance: the remit-to printed on invoices and statements (name, address lines, how to pay), and the cash floor the forecast draws. */
  remitToName: z.string().nullable(),
  remitToAddress: z.string().nullable(),
  remitToInstructions: z.string().nullable(),
  cashMinimum: z.number().nullable(),
  updatedAt: z.string().datetime(),
}))();
export type OrgBranding = z.infer<typeof OrgBrandingSchema>;

// PATCH body — every field optional; null clears, undefined leaves alone.
// Logo is uploaded via a separate multipart endpoint, not part of this body.
export const UpdateOrgBrandingInputSchema = /* @__PURE__ */ (() => z
  .object({
    orgName: z.string().min(1).max(120).optional(),
    assistantName: z.string().trim().min(1).max(60).optional(),
    activeWindowDays: z.number().int().min(1).max(90).optional(),
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    senderName: z.string().min(1).max(120).nullable().optional(),
    supportEmail: z
      .string()
      .max(254)
      .regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, 'Must be a bare email address.')
      .nullable()
      .optional(),
    primaryColor: z
      .string()
      .regex(HEX_COLOR_REGEX, 'Must be a #RRGGBB hex colour.')
      .nullable()
      .optional(),
    mfaRequirement: MfaRequirementSchema.optional(),
    financeMailbox: z
      .string()
      .max(254)
      .regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, 'Must be a bare email address.')
      .nullable()
      .optional(),
    unverifiedPayoutPolicy: UnverifiedPayoutPolicySchema.optional(),
    payChangeApprovalPct: z.number().int().min(0).max(100).optional(),
    payChangeAlwaysApprove: z.boolean().optional(),
    billRateApproval: z.boolean().optional(),
    separationSecondPerson: z.boolean().optional(),
    selfServiceApproval: z.boolean().optional(),
    roleChangeApproval: z.boolean().optional(),
    requisitionApproval: z.boolean().optional(),
    payrollReviewRequired: z.boolean().optional(),
    remitToName: z.string().trim().max(255).nullable().optional(),
    remitToAddress: z.string().trim().max(500).nullable().optional(),
    remitToInstructions: z.string().trim().max(500).nullable().optional(),
    cashMinimum: z.number().min(0).max(1_000_000_000).nullable().optional(),
  })
  .strict())();
export type UpdateOrgBrandingInput = z.infer<typeof UpdateOrgBrandingInputSchema>;

/* -------------------------------------------------------------------------- *
 *  TOTP MFA enrollment
 * -------------------------------------------------------------------------- */

export const MFA_TOTP_DIGITS = 6;
export const MFA_TOTP_PERIOD_SECONDS = 30;
export const MFA_RECOVERY_CODE_COUNT = 8;

/** Server response when starting enrollment. The plaintext secret and
 *  recovery codes are shown to the user exactly once — closing the page
 *  without confirming throws them away (the encrypted secret stored
 *  server-side is overwritten on the next /enroll/start call). */
export const MfaEnrollStartResponseSchema = /* @__PURE__ */ (() => z.object({
  secret: z.string().min(1),
  provisioningUri: z.string().url(),
  recoveryCodes: z.array(z.string().min(1)).length(MFA_RECOVERY_CODE_COUNT),
}))();
export type MfaEnrollStartResponse = z.infer<typeof MfaEnrollStartResponseSchema>;

export const MfaEnrollConfirmInputSchema = /* @__PURE__ */ (() => z.object({
  // 6-digit numeric. Server tolerates a single 30s window of skew.
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits.'),
}))();
export type MfaEnrollConfirmInput = z.infer<typeof MfaEnrollConfirmInputSchema>;

export const MfaDisableInputSchema = /* @__PURE__ */ (() => z.object({
  currentPassword: z.string().min(1).max(256),
}))();
export type MfaDisableInput = z.infer<typeof MfaDisableInputSchema>;

/** Code submitted to /auth/mfa-challenge. Either a 6-digit TOTP or a
 *  recovery code in `xxxxx-xxxxx` format. The server resolves which
 *  flavour was provided. */
export const MfaChallengeInputSchema = /* @__PURE__ */ (() => z.object({
  /** Access pack: remember this device for the tenant's device-trust days (when the tenant allows). */
  rememberDevice: z.boolean().optional(),
  code: z
    .string()
    .min(1)
    .max(20)
    .transform((s) => s.trim().toLowerCase()),
}))();
export type MfaChallengeInput = z.infer<typeof MfaChallengeInputSchema>;

export const MfaChallengeResponseSchema = /* @__PURE__ */ (() => z.object({
  user: AuthUserSchema,
}))();
export type MfaChallengeResponse = z.infer<typeof MfaChallengeResponseSchema>;

/** Snapshot of the caller's MFA state for the Settings card. */
export const MfaStatusResponseSchema = /* @__PURE__ */ (() => z.object({
  enrolled: z.boolean(),
  enabledAt: z.string().datetime().nullable(),
  remainingRecoveryCodes: z.number().int().nonnegative(),
}))();
export type MfaStatusResponse = z.infer<typeof MfaStatusResponseSchema>;

/** Regenerate-codes input. Same password-reauth contract as disable —
 *  rotating recovery codes is destructive (existing codes stop working) so
 *  we hold it to the same bar. */
export const MfaRegenerateInputSchema = /* @__PURE__ */ (() => z.object({
  currentPassword: z.string().min(1).max(256),
}))();
export type MfaRegenerateInput = z.infer<typeof MfaRegenerateInputSchema>;

export const MfaRegenerateResponseSchema = /* @__PURE__ */ (() => z.object({
  recoveryCodes: z.array(z.string().min(1)).length(MFA_RECOVERY_CODE_COUNT),
}))();
export type MfaRegenerateResponse = z.infer<typeof MfaRegenerateResponseSchema>;

// ===== Phase 131 — Locations + transfers =================================

export const LocationSummarySchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  /** Brief 2-1b: null for a direct employer's site. */
  clientId: UuidSchema.nullable(),
  name: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  geofenceRadiusMeters: z.number().int().nullable(),
  isActive: z.boolean(),
  // IANA timezone of the work site. The scheduling grid renders every shift
  // in this zone, so the create/edit dialogs must interpret the times an
  // admin TYPES in this zone too (otherwise a CA admin entering "4am" for a
  // FL store stores 4am Pacific = 7am Eastern, and everyone sees it 3h late).
  timezone: z.string(),
}))();
export type LocationSummary = z.infer<typeof LocationSummarySchema>;

/* -------------------------------------------------------------------------- *
 *  Client statements — monthly billing/SLA artifact. DRAFT recomputes;
 *  FINAL is an immutable, sequentially numbered snapshot.
 * -------------------------------------------------------------------------- */

export const StatementLineSchema = /* @__PURE__ */ (() => z.object({
  label: z.string(),
  hours: z.number(),
  rate: z.number(),
  amount: z.number(),
}))();

export const StatementSnapshotSchema = /* @__PURE__ */ (() => z.object({
  clientName: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** When the snapshot was computed — drafts show their staleness. */
  generatedAt: z.string().datetime().optional(),
  lines: z.array(StatementLineSchema),
  stores: z.array(
    z.object({ locationName: z.string(), hours: z.number(), amount: z.number() }),
  ),
  totals: z.object({
    hours: z.number(),
    regularHours: z.number(),
    otHours: z.number(),
    /** Hours past a live jurisdiction's double-time line, billed like overtime (lib/clientStatement); absent when none. */
    doubleTimeHours: z.number().optional(),
    /** What the client owes: subtotal + sales tax. */
    amount: z.number(),
    hoursAmount: z.number().optional(),
    adjustmentsAmount: z.number().optional(),
    /** Hours + adjustments before tax; absent on snapshots that predate sales tax (then equal to amount). */
    subtotal: z.number().optional(),
    salesTaxRatePct: z.number().optional(),
    salesTax: z.number().optional(),
  }),
  sla: z.object({
    publishedShifts: z.number().int(),
    assignedShifts: z.number().int(),
    fillRatePct: z.number().nullable(),
    punctualPct: z.number().nullable(),
    noShows: z.number().int(),
    pendingEntries: z.number().int(),
  }),
}))();
export type StatementSnapshot = z.infer<typeof StatementSnapshotSchema>;

export const ClientStatementSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
  number: z.number().int().nullable(),
  status: z.enum(['DRAFT', 'FINAL']),
  snapshot: StatementSnapshotSchema,
  finalizedAt: z.string().datetime().nullable(),
  finalizedByEmail: z.string().nullable(),
  /** Receivables: when the client's payment was recorded (null = a FINAL
   *  statement is outstanding). paymentRef = check/ACH reference. */
  paidAt: z.string().datetime().nullable().optional(),
  paymentRef: z.string().nullable().optional(),
  /** Invoicing: the PO billed against, when it falls due (the client's terms), and the reminder cadence's position. */
  poNumber: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  reminderStage: z.number().int().optional(),
  lastReminderAt: z.string().datetime().nullable().optional(),
}))();
export type ClientStatement = z.infer<typeof ClientStatementSchema>;

export const ClientStatementListResponseSchema = /* @__PURE__ */ (() => z.object({
  statements: z.array(ClientStatementSchema),
}))();
export type ClientStatementListResponse = z.infer<
  typeof ClientStatementListResponseSchema
>;

/* -------------------------------------------------------------------------- *
 *  OT outlook — who is projected past 40h this week, by name.
 * -------------------------------------------------------------------------- */

export const OtOutlookRowSchema = /* @__PURE__ */ (() => z.object({
  associateId: UuidSchema,
  associateName: z.string(),
  /** Client(s) of their remaining shifts this week, display string. */
  clientNames: z.string(),
  workedMinutes: z.number(),
  remainingScheduledMinutes: z.number(),
  projectedMinutes: z.number(),
  /** Minutes past 40h if the week runs as scheduled. */
  projectedOtMinutes: z.number(),
  /** Estimated extra billed cost of that OT at 1.5× the SOW rate. */
  estOtBilled: z.number().nullable(),
}))();
export type OtOutlookRow = z.infer<typeof OtOutlookRowSchema>;

export const OtOutlookResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(OtOutlookRowSchema),
  generatedAt: z.string().datetime(),
  /** True when the week's assigned shifts ran past what the radar reads. */
  truncated: z.boolean().optional(),
}))();
export type OtOutlookResponse = z.infer<typeof OtOutlookResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Retention analytics — computed, no storage.
 * -------------------------------------------------------------------------- */

export const RetentionResponseSchema = /* @__PURE__ */ (() => z.object({
  monthly: z.array(
    z.object({
      /** YYYY-MM */
      month: z.string(),
      headcountStart: z.number().int(),
      hires: z.number().int(),
      separations: z.number().int(),
      voluntary: z.number().int(),
      involuntary: z.number().int(),
      /** separations ÷ average headcount, percent; null when headcount 0. */
      turnoverPct: z.number().nullable(),
    }),
  ),
  cohorts: z.array(
    z.object({
      /** Hiring month, YYYY-MM */
      month: z.string(),
      hires: z.number().int(),
      /** % of the cohort still active N days after hire; null = not yet old
       *  enough to measure. */
      s30: z.number().nullable(),
      s60: z.number().nullable(),
      s90: z.number().nullable(),
      s180: z.number().nullable(),
    }),
  ),
  byLocation: z.array(
    z.object({
      locationId: UuidSchema,
      locationName: z.string(),
      active: z.number().int(),
      separations12mo: z.number().int(),
      survival90Pct: z.number().nullable(),
    }),
  ),
}))();
export type RetentionResponse = z.infer<typeof RetentionResponseSchema>;

export const LocationListResponseSchema = /* @__PURE__ */ (() => z.object({
  locations: z.array(LocationSummarySchema),
}))();
export type LocationListResponse = z.infer<typeof LocationListResponseSchema>;

/** Geofence inputs come as a trio: all three together (set) or all three
 *  null (clear). Per-axis nulls are coerced to the all-null case on the
 *  server. radius is meters. lat/lng have ~5cm precision. */
/** Brief 2-1b step 7: the kind of site; the tenant's terminology names it. */
export const SITE_TYPES = ['STORE', 'PROPERTY', 'OFFICE', 'WAREHOUSE', 'OTHER'] as const;
export const SiteTypeSchema = /* @__PURE__ */ (() => z.enum(SITE_TYPES))();
export type SiteType = z.infer<typeof SiteTypeSchema>;

const LocationBaseFields = {
  type: SiteTypeSchema.optional(),
  name: z.string().trim().min(1).max(255),
  addressLine1: z.string().max(255).nullable().optional(),
  addressLine2: z.string().max(255).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/, 'Two-letter USPS code')
    .nullable()
    .optional(),
  zip: z.string().max(10).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusMeters: z.number().int().min(1).max(50_000).nullable().optional(),
  // IANA timezone of the work site — drives how the scheduling grid + dialogs
  // render and interpret shift times. Optional on input; the DB column defaults
  // to America/New_York, so omitted-field creates and existing rows are
  // unchanged. Validated against the supported list (Central, Pacific, etc.).
  timezone: z.enum(SUPPORTED_TIMEZONES).optional(),
};

export const LocationCreateInputSchema = /* @__PURE__ */ (() => z.object(LocationBaseFields))();
export type LocationCreateInput = z.infer<typeof LocationCreateInputSchema>;

export const LocationUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  ...LocationBaseFields,
  isActive: z.boolean().optional(),
}))();
export type LocationUpdateInput = z.infer<typeof LocationUpdateInputSchema>;

/** Body for POST /org/associates/:id/transfer. startedAt is ISO
 *  YYYY-MM-DD; the API closes the open assignment with endedAt =
 *  startedAt and opens a new one at locationId. The target location may
 *  belong to a DIFFERENT client — Alto is the employer of record for
 *  every client, so a cross-client move is a plain transfer, not a
 *  rehire. It has side effects though (shifts released, org fields
 *  cleared, kiosk PIN re-pointed), so it must be acknowledged with
 *  confirmCrossClient — otherwise a mis-picked location would quietly
 *  move someone to another client. */
export const AssociateTransferInputSchema = /* @__PURE__ */ (() => z.object({
  locationId: UuidSchema,
  startedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  reason: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Must be true when locationId belongs to a different client than the
   *  associate's current one; the API 400s (cross_client_confirmation_required)
   *  without it. Ignored on intra-client transfers. */
  confirmCrossClient: z.boolean().optional(),
}))();
export type AssociateTransferInput = z.infer<typeof AssociateTransferInputSchema>;

export const AssociateTransferResponseSchema = /* @__PURE__ */ (() => z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  locationId: UuidSchema,
  locationName: z.string(),
  startedAt: z.string(),
  clientId: UuidSchema,
  clientName: z.string(),
  crossClient: z.boolean(),
  /** Cross-client cleanup tallies — all zero/false on intra-client moves. */
  releasedShifts: z.number().int(),
  expiredClaims: z.number().int(),
  removedTeamMemberships: z.number().int(),
  vacatedPositions: z.number().int(),
  kioskPinMoved: z.boolean(),
}))();
export type AssociateTransferResponse = z.infer<typeof AssociateTransferResponseSchema>;

/* ===== Web push subscriptions ============================================ */

/** Browser PushSubscription payload — stored per user; the API pushes
 *  through it whenever a bell notification is created. */
export const PushSubscribeInputSchema = /* @__PURE__ */ (() => z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  }),
}))();
export type PushSubscribeInput = z.infer<typeof PushSubscribeInputSchema>;

export const PushUnsubscribeInputSchema = /* @__PURE__ */ (() => z.object({
  endpoint: z.string().url().max(1000),
}))();
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeInputSchema>;

export const PushPublicKeyResponseSchema = /* @__PURE__ */ (() => z.object({
  publicKey: z.string(),
}))();
export type PushPublicKeyResponse = z.infer<typeof PushPublicKeyResponseSchema>;

/* ===== Bulk associate CSV import (client onboarding / migration) ========= */

/** One parsed + normalized CSV row. Nullable fields were absent/blank in
 *  the file. clientId is the RESOLVED id (clientName → id lookup done
 *  server-side); clientName echoes what the file said for display. */
export const CsvImportRowDataSchema = /* @__PURE__ */ (() => z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  hireDate: z.string().nullable(), // YYYY-MM-DD
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  position: z.string().nullable(),
}))();
export type CsvImportRowData = z.infer<typeof CsvImportRowDataSchema>;

export const CsvImportPreviewRowSchema = /* @__PURE__ */ (() => z.object({
  /** 1-based physical line in the uploaded file where this row starts
   *  (the header is line 1, so the first data row is usually line 2). */
  line: z.number().int().positive(),
  data: CsvImportRowDataSchema,
  /** Empty = importable. Human-readable, field-prefixed messages. */
  errors: z.array(z.string()),
}))();
export type CsvImportPreviewRow = z.infer<typeof CsvImportPreviewRowSchema>;

export const CsvImportPreviewResponseSchema = /* @__PURE__ */ (() => z.object({
  rows: z.array(CsvImportPreviewRowSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    valid: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    /** Rows flagged because the email already exists (associate/user) or
     *  repeats an earlier line in the same file. Subset of `invalid`. */
    duplicateEmails: z.number().int().nonnegative(),
  }),
}))();
export type CsvImportPreviewResponse = z.infer<typeof CsvImportPreviewResponseSchema>;

/** 'create' = silent migration (Associate + Application rows, no emails).
 *  'invite' = additionally mint an INVITED user + send the invite email. */
export const CsvImportModeSchema = /* @__PURE__ */ (() => z.enum(['create', 'invite']))();
export type CsvImportMode = z.infer<typeof CsvImportModeSchema>;

export const CsvImportCommitRowSchema = /* @__PURE__ */ (() => z.object({
  line: z.number().int().positive(),
  email: z.string().nullable(),
  status: z.enum(['created', 'invited', 'skipped']),
  /** Set when status = skipped: 'already_exists', 'duplicate_in_file',
   *  'invalid: …', or a runtime failure code/message. */
  reason: z.string().nullable(),
}))();
export type CsvImportCommitRow = z.infer<typeof CsvImportCommitRowSchema>;

export const CsvImportCommitResponseSchema = /* @__PURE__ */ (() => z.object({
  mode: CsvImportModeSchema,
  results: z.array(CsvImportCommitRowSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    invited: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
}))();
export type CsvImportCommitResponse = z.infer<typeof CsvImportCommitResponseSchema>;

/* ===== Phase 96 — Reports: relative period tokens ======================== */

/** Relative date-window tokens for saved report filters (`op: 'period'`).
 *  Stored in the spec verbatim and resolved to concrete instants on the
 *  server at RUN time, so a saved "last week's hours" report never goes
 *  stale. Week tokens follow the org workweek (Saturday 00:00 → Friday
 *  24:00, org-local); month/year tokens are org-local calendar windows. */
export const REPORT_PERIOD_TOKENS = [
  'last-week',
  'this-week',
  'last-month',
  'month-to-date',
  'year-to-date',
  // Date-range presets (HR walk 17: "terminations last quarter").
  'last-quarter',
  'quarter-to-date',
  'last-30-days',
  'last-90-days',
  'last-year',
] as const;
export const ReportPeriodTokenSchema = /* @__PURE__ */ (() => z.enum(REPORT_PERIOD_TOKENS))();
export type ReportPeriodToken = z.infer<typeof ReportPeriodTokenSchema>;

export const REPORT_PERIOD_LABELS: Record<ReportPeriodToken, string> = {
  'last-week': 'Last week',
  'this-week': 'This week',
  'last-month': 'Last month',
  'month-to-date': 'Month to date',
  'year-to-date': 'Year to date',
  'last-quarter': 'Last quarter',
  'quarter-to-date': 'Quarter to date',
  'last-30-days': 'Last 30 days',
  'last-90-days': 'Last 90 days',
  'last-year': 'Last year',
};

/* -------------------------------------------------------------------------- *
 *  Product analytics — is anyone actually using this?
 *
 *  Distinct from the workforce analytics above, which answer questions
 *  about associates. These answer questions about the software: who signs
 *  in, what they open, what breaks. Every field is served from a daily
 *  rollup, never from the raw audit log.
 * -------------------------------------------------------------------------- */

export interface ActiveUsersPoint {
  /** YYYY-MM-DD, UTC. */
  day: string;
  activeUsers: number;
}

export interface ActiveUsersResponse {
  series: ActiveUsersPoint[];
  dau: number;
  wau: number;
  mau: number;
  /** WAU/MAU. A ratio, not a verdict. */
  stickiness: number;
}

export interface TrafficPoint {
  day: string;
  requests: number;
  clientError: number;
  serverError: number;
  /** Server errors as a fraction of all requests — 4xx is usually the app working. */
  errorRate: number;
  avgMs: number;
}

export interface TrafficResponse {
  series: TrafficPoint[];
}

export interface RouteUsageRow {
  method: string;
  /** Express pattern — "/rides/:id". Never a resolved path. */
  route: string;
  requests: number;
  serverError: number;
  errorRate: number;
  avgMs: number;
}

export interface RouteUsageResponse {
  busiest: RouteUsageRow[];
  /** Only routes with enough traffic for a rate to mean anything. */
  failing: RouteUsageRow[];
}

export type WebVitalMetric = 'LCP' | 'INP' | 'CLS' | 'TTFB';
export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

/** One Core Web Vital over the window: p75 and how the samples rated. */
export interface WebVitalSummary {
  metric: WebVitalMetric;
  samples: number;
  /** Milliseconds, or the unitless CLS score. Null with no samples. */
  p75: number | null;
  rating: WebVitalRating | null;
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface WebVitalRouteRow {
  /** SPA path pattern — "/clients/:id". Never a resolved path. */
  route: string;
  samples: number;
  lcpP75: number | null;
  inpP75: number | null;
  clsP75: number | null;
  ttfbP75: number | null;
}

export interface WebVitalsResponse {
  metrics: WebVitalSummary[];
  /** Busiest routes first. */
  routes: WebVitalRouteRow[];
}

/* -------------------------------------------------------------------------- *
 *  Reliability — is the platform staying up, and where is it slow?
 *
 *  The error budget is ten errors a week (Hybrid Workforce Plan, Phase 1
 *  exit criteria). Errors come from Sentry when a read token is configured;
 *  the rest is the API's own rollups. Weeks are org weeks: Saturday 00:00
 *  to Friday 24:00, Florida-local.
 * -------------------------------------------------------------------------- */

/** Weekly errors at or under this count is "within budget". */
export const RELIABILITY_ERROR_BUDGET = 10;

export interface ReliabilityRouteRow {
  method: string;
  /** Express pattern — never a resolved path. */
  route: string;
  requests: number;
  serverError: number;
  avgMs: number;
  /** Null when every row in the window predates the latency histogram. */
  p95Ms: number | null;
}

export interface ReliabilityWeekRow {
  /** ISO instant, org-week start. */
  weekStart: string;
  /** ISO instant, exclusive. */
  weekEnd: string;
  /** Sentry's accepted error events; null when Sentry is not connected. */
  sentryErrors: number | null;
  /** 5xx responses from the route rollup — always available. */
  serverErrors: number;
  requests: number;
  /** Null when Sentry is not connected (the budget is a Sentry number). */
  underBudget: boolean | null;
  /** The week in progress — not yet judged against the budget. */
  current: boolean;
}

export interface ReliabilityIssueRow {
  shortId: string;
  title: string;
  culprit: string;
  count: number;
  userCount: number;
  lastSeen: string;
  permalink: string;
  project: string;
}

export interface ReliabilityDayPoint {
  day: string;
  total: number;
  accepted: number;
}

export interface ReliabilityResponse {
  days: number;
  budget: number;
  sentry: {
    configured: boolean;
    /** Unresolved issues in the window, most frequent first. Empty when not connected. */
    issues: ReliabilityIssueRow[];
  };
  errors: {
    /** This org week so far, from Sentry; null when not connected. */
    thisWeek: number | null;
    /** This org week so far, 5xx from the rollup. */
    serverErrorsThisWeek: number;
    /** Oldest first; the last row is the week in progress. */
    weeks: ReliabilityWeekRow[];
    /** Closed weeks in a row at or under budget, most recent backwards. Null when not connected. */
    consecutiveWeeksUnderBudget: number | null;
  };
  routes: {
    /** The ten busiest routes in the window with their p95. */
    busiest: ReliabilityRouteRow[];
    /** The five slowest by p95 among routes with enough traffic. */
    slowest: ReliabilityRouteRow[];
  };
  kiosk: {
    total: number;
    accepted: number;
    rejected: number;
    /** accepted ÷ total; null with no punches. */
    rate: number | null;
    series: ReliabilityDayPoint[];
  };
  rides: {
    /** Rides whose pickup time has passed, cancellations excluded. */
    total: number;
    completed: number;
    noShow: number;
    /** Past-due seats never marked completed or no-show. */
    unresolved: number;
    rate: number | null;
  };
  restarts: {
    count: number;
    lastBootAt: string | null;
    version: string | null;
  };
}

/**
 * Who a release-note bullet is for. ALL reaches everyone; the rest map
 * from the reader's role on the server (associates, drivers, shift
 * supervisors, store-portal users, and everyone else as ADMIN).
 */
export type ReleaseNoteAudience = 'ALL' | 'ADMIN' | 'ASSOCIATE' | 'SUPERVISOR' | 'DRIVER' | 'CLIENT';
export const RELEASE_NOTE_AUDIENCES: readonly ReleaseNoteAudience[] = ['ALL', 'ADMIN', 'ASSOCIATE', 'SUPERVISOR', 'DRIVER', 'CLIENT'];

export interface ReleaseNoteItem {
  audience: ReleaseNoteAudience;
  en: string;
  /** Spanish copy; null falls back to English in the app. */
  es: string | null;
}

export interface ReleaseNote {
  id: string;
  /** YYYY-MM-DD — the release day, which is also the card's "version". */
  day: string;
  /** Already filtered to the reader's audience, except for editors. */
  items: ReleaseNoteItem[];
  publishedAt: string | null;
}

export interface ReleaseNotesResponse {
  notes: ReleaseNote[];
  /** Whether the caller may write notes (drives the editor). */
  canEdit: boolean;
}

export interface ReleaseNoteInput {
  day: string;
  items: ReleaseNoteItem[];
  published: boolean;
}

/** Out-of-office cover for a manager's team inbox. */
export interface TeamDelegation {
  id: string;
  /** YYYY-MM-DD, inclusive. */
  startsOn: string;
  endsOn: string;
  note: string | null;
  from: { id: string; name: string };
  to: { id: string; name: string };
}

export interface TeamDelegationsResponse {
  /** Cover the caller has given, current and upcoming. */
  given: TeamDelegation[];
  /** Cover the caller is providing, current and upcoming. */
  received: TeamDelegation[];
  today: string;
}

export interface TeamDelegationCandidate {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface TeamDelegationInput {
  toUserId: string;
  startsOn: string;
  endsOn: string;
  note?: string;
}

/** Universal search — every record kind the command palette can land on. */
export type SearchKind = 'people' | 'clients' | 'locations' | 'applications' | 'shifts' | 'documents' | 'statements' | 'help';

export interface SearchHit {
  id: string;
  title: string;
  /** One line of context — a store, a status, a date. */
  hint: string | null;
  /** In-app path the hit opens. */
  href: string;
}

export interface SearchGroup {
  kind: SearchKind;
  hits: SearchHit[];
}

export interface SearchResponse {
  /** Only the kinds the caller may see, in display order; empty groups omitted. */
  groups: SearchGroup[];
}

export interface AdoptionResponse {
  signups: { day: string; accounts: number }[];
  funnel: {
    created: number;
    activated: number;
    activationRate: number;
  };
  activeByRole: { role: string; users: number }[];
  /** Invited, never once signed in — the funnel's real leak. */
  neverSignedIn: number;
  dormant30d: number;
  totalActiveAccounts: number;
}

/** One row of a person's own sign-in history. */
export interface LoginHistoryEvent {
  id: string;
  action: string;
  at: string;
  ip: string | null;
  userAgent: string | null;
  /** IANA zone the browser reported at the time, when it offered one. */
  timezone?: string | null;
  /** True when this sign-in came from a network not seen before. */
  newNetwork?: boolean;
}

/** How the document vault orders a page. Sorting has to happen on the
 *  server: the queue's whole job is "oldest first", and a page sorted
 *  after it was cut shows the oldest rows OF THAT PAGE, not of the vault. */
export const DocumentSortSchema = /* @__PURE__ */ (() => z.enum([
  'uploaded_asc',
  'uploaded_desc',
  'associate_asc',
  'associate_desc',
  'kind_asc',
  'kind_desc',
  'file_asc',
  'file_desc',
  'size_asc',
  'size_desc',
  'status_asc',
  'status_desc',
]))();
export type DocumentSort = z.infer<typeof DocumentSortSchema>;

/** Vault counts, computed over the whole population rather than the page —
 *  the KPI strip used to be derived from the capped list, so every number
 *  on the page was wrong once the vault passed the cap. */
export const DocumentStatsSchema = /* @__PURE__ */ (() => z.object({
  total: z.number().int().nonnegative(),
  uploaded: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  /** Oldest still-unreviewed upload, for the SLA banner. */
  oldestPendingAt: z.string().datetime().nullable(),
}))();
export type DocumentStats = z.infer<typeof DocumentStatsSchema>;

/* -------------------------------------------------------------------------- *
 *  Emergency Mode (Brief 1C-1) — one switch that protects the workforce.
 *
 *  Declaring suspends the shifts in scope, tells every associate in their
 *  language, opens the "I'm safe" check-in and books evacuation seats for
 *  whoever asks; stand down puts the schedule back from the next shift on.
 * -------------------------------------------------------------------------- */

export const EmergencyStatusSchema = /* @__PURE__ */ (() => z.enum(['ACTIVE', 'STOOD_DOWN']))();
export type EmergencyStatus = z.infer<typeof EmergencyStatusSchema>;

export const EmergencyCheckInStatusSchema = /* @__PURE__ */ (() => z.enum(['SAFE', 'NEEDS_HELP']))();
export type EmergencyCheckInStatus = z.infer<typeof EmergencyCheckInStatusSchema>;

export const EmergencyDeclareInputSchema = /* @__PURE__ */ (() => z.object({
  title: z.string().trim().min(2).max(120),
  /** The declarer's words, English. Sent as written. */
  message: z.string().trim().min(2).max(2000),
  /** Optional renderings; English is sent to that language when empty. */
  messageEs: z.string().trim().max(2000).optional(),
  messageTr: z.string().trim().max(2000).optional(),
  allSites: z.boolean(),
  locationIds: z.array(UuidSchema).max(200).default([]),
  /** Shifts ending after this are suspended. Defaults to now. */
  startsAt: z.string().datetime().optional(),
  /** Evacuation vans leave around this time; omit for no transport mode. */
  pickupAt: z.string().datetime().nullable().optional(),
  /** Where the vans go; null means each rider's own store. */
  destinationLocationId: UuidSchema.nullable().optional(),
  escalationMinutes: z.number().int().min(5).max(1440).default(60),
}))();
export type EmergencyDeclareInput = z.infer<typeof EmergencyDeclareInputSchema>;

export const EmergencyCheckInInputSchema = /* @__PURE__ */ (() => z.object({
  status: EmergencyCheckInStatusSchema,
  needsRide: z.boolean().default(false),
  note: z.string().trim().max(300).optional(),
}))();
export type EmergencyCheckInInput = z.infer<typeof EmergencyCheckInInputSchema>;

export interface EmergencySiteRef {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
}

export interface EmergencySummary {
  id: string;
  title: string;
  status: EmergencyStatus;
  allSites: boolean;
  sites: EmergencySiteRef[];
  startsAt: string;
  pickupAt: string | null;
  destination: { id: string; name: string } | null;
  escalationMinutes: number;
  declaredAt: string;
  declaredBy: string | null;
  stoodDownAt: string | null;
  stoodDownBy: string | null;
  shiftsSuspended: number;
  associatesNotified: number;
  shiftsRestored: number;
  checkIns: { total: number; responded: number; safe: number; needsHelp: number; needsRide: number };
  /**
   * The text channel, told the truth: whether an SMS provider is connected
   * (and why not), and — on the declare / stand-down answer — how many texts
   * actually left. Absent on older rows; never "sent" for a text that wasn't.
   */
  texts?: { available: boolean; reason: string | null; sent?: number; notSent?: number };
}

export interface EmergencyBoardRow {
  associateId: string;
  name: string;
  siteId: string | null;
  siteName: string;
  clientId: string | null;
  phone: string | null;
  /** The address on file: the rider's saved Home, else the associate record. */
  address: string | null;
  status: EmergencyCheckInStatus | null;
  needsRide: boolean;
  note: string | null;
  respondedAt: string | null;
  ride: { id: string; status: string; located: boolean } | null;
  /** No response after the escalation interval. */
  overdue: boolean;
}

export interface EmergencyBoard {
  emergency: EmergencySummary;
  rows: EmergencyBoardRow[];
  escalation: EmergencyBoardRow[];
  bySite: Array<{ siteId: string | null; siteName: string; total: number; responded: number; safe: number; needsHelp: number }>;
  /** When the escalation interval lapses, ISO. */
  escalateAt: string;
}

export interface EmergencyListResponse {
  emergencies: EmergencySummary[];
}

export interface EmergencySitesResponse {
  sites: EmergencySiteRef[];
}

/** What the associate app shows: the active emergency they are in, if any. */
export interface MyEmergencyResponse {
  emergency: {
    id: string;
    title: string;
    /** In the associate's language. */
    message: string;
    startsAt: string;
    pickupAt: string | null;
    declaredAt: string;
    rideOffered: boolean;
  } | null;
  checkIn: {
    status: EmergencyCheckInStatus;
    needsRide: boolean;
    respondedAt: string;
    ride: { status: string; pickupAt: string | null } | null;
  } | null;
}

/* -------------------------------------------------------------------------- *
 *  Program Lifecycle (Brief 1C-2) — J-1 and H-2B participants, their
 *  sponsors, the dates everything turns on, and the alerts those dates fire.
 * -------------------------------------------------------------------------- */

export const ProgramTypeSchema = /* @__PURE__ */ (() => z.enum(['J1_SWT', 'H2B', 'DOMESTIC']))();
export type ProgramType = z.infer<typeof ProgramTypeSchema>;
export const PROGRAM_TYPE_LABELS: Record<ProgramType, string> = {
  J1_SWT: 'J-1 Summer Work Travel',
  H2B: 'H-2B',
  DOMESTIC: 'Domestic',
};

export const SecondJobStatusSchema = /* @__PURE__ */ (() => z.enum(['NOT_REQUESTED', 'REQUESTED', 'APPROVED', 'DENIED']))();
export type SecondJobStatus = z.infer<typeof SecondJobStatusSchema>;

const ProgramDateOnly = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();

export const SponsorInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(2).max(160),
  programType: ProgramTypeSchema.default('J1_SWT'),
  contactName: z.string().trim().max(120).nullable().optional(),
  contactEmail: z.string().trim().email().max(254).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  website: z.string().trim().max(300).nullable().optional(),
  checkInCadenceDays: z.number().int().min(1).max(365).default(30),
  checkInRequirements: z.string().trim().max(2000).nullable().optional(),
  reportingCadence: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().default(true),
}))();
export type SponsorInput = z.infer<typeof SponsorInputSchema>;

export interface Sponsor {
  id: string;
  name: string;
  programType: ProgramType;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  checkInCadenceDays: number;
  checkInRequirements: string | null;
  reportingCadence: string | null;
  notes: string | null;
  isActive: boolean;
  /** Programs still running (program end on or after today). */
  activeParticipants: number;
}

export const ProgramInputSchema = /* @__PURE__ */ (() => z
  .object({
    associateId: UuidSchema,
    type: ProgramTypeSchema,
    sponsorId: UuidSchema.nullable().optional(),
    ds2019Number: z.string().trim().max(80).nullable().optional(),
    ds2019IssuedOn: ProgramDateOnly.nullable().optional(),
    ds2019ExpiresOn: ProgramDateOnly.nullable().optional(),
    visaExpiresOn: ProgramDateOnly.nullable().optional(),
    sevisId: z.string().trim().max(80).nullable().optional(),
    country: z.string().trim().max(80).nullable().optional(),
    programStart: ProgramDateOnly,
    programEnd: ProgramDateOnly,
    gracePeriodDays: z.number().int().min(0).max(120).default(30),
    secondJobStatus: SecondJobStatusSchema.default('NOT_REQUESTED'),
    h2bPetitionNumber: z.string().trim().max(60).nullable().optional(),
    petitionClientId: UuidSchema.nullable().optional(),
    petitionValidFrom: ProgramDateOnly.nullable().optional(),
    petitionValidTo: ProgramDateOnly.nullable().optional(),
    worksiteArea: z.string().trim().max(160).nullable().optional(),
    lastSponsorCheckInOn: ProgramDateOnly.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** Ids in the document store this program refers to (DS-2019, visa, petition). */
    documentIds: z.array(UuidSchema).max(20).default([]),
  })
  .refine((v) => v.programEnd >= v.programStart, { message: 'programEnd must be on or after programStart', path: ['programEnd'] })
  .refine((v) => v.type !== 'H2B' || !!v.petitionClientId, {
    message: 'An H-2B program names the client the petition was certified for',
    path: ['petitionClientId'],
  }))();
export type ProgramInput = z.infer<typeof ProgramInputSchema>;

export const ProgramUpdateSchema = /* @__PURE__ */ (() => z.object({
  sponsorId: UuidSchema.nullable().optional(),
  ds2019Number: z.string().trim().max(80).nullable().optional(),
  ds2019IssuedOn: ProgramDateOnly.nullable().optional(),
  ds2019ExpiresOn: ProgramDateOnly.nullable().optional(),
  visaExpiresOn: ProgramDateOnly.nullable().optional(),
  sevisId: z.string().trim().max(80).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  programStart: ProgramDateOnly.optional(),
  programEnd: ProgramDateOnly.optional(),
  gracePeriodDays: z.number().int().min(0).max(120).optional(),
  secondJobStatus: SecondJobStatusSchema.optional(),
  h2bPetitionNumber: z.string().trim().max(60).nullable().optional(),
  petitionClientId: UuidSchema.nullable().optional(),
  petitionValidFrom: ProgramDateOnly.nullable().optional(),
  petitionValidTo: ProgramDateOnly.nullable().optional(),
  worksiteArea: z.string().trim().max(160).nullable().optional(),
  lastSponsorCheckInOn: ProgramDateOnly.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  documentIds: z.array(UuidSchema).max(20).optional(),
  /** Close early (left the program, transferred, no-show). */
  closedReason: z.string().trim().max(300).nullable().optional(),
}))();
export type ProgramUpdate = z.infer<typeof ProgramUpdateSchema>;

export type ProgramAlertKind =
  | 'PROGRAM_END'
  | 'GRACE_END'
  | 'VISA_EXPIRY'
  | 'DS2019_EXPIRY'
  | 'I9_REVERIFY'
  | 'SPONSOR_CHECKIN'
  | 'PETITION_END';
export const PROGRAM_ALERT_LABELS: Record<ProgramAlertKind, string> = {
  PROGRAM_END: 'Program ends',
  GRACE_END: 'Grace period ends',
  VISA_EXPIRY: 'Visa expires',
  DS2019_EXPIRY: 'DS-2019 expires',
  I9_REVERIFY: 'I-9 reverification due',
  SPONSOR_CHECKIN: 'Sponsor check-in due',
  PETITION_END: 'H-2B petition ends',
};

export interface ProgramAlert {
  kind: ProgramAlertKind;
  label: string;
  /** YYYY-MM-DD the thing happens. */
  dueOn: string;
  /** Negative when already past. */
  daysUntil: number;
  /** The lead time, in days, that fired this alert. */
  lead: number;
  severity: 'critical' | 'warn';
  programId: string;
  associateId: string;
  associateName: string;
  siteName: string | null;
  clientId: string | null;
  programType: ProgramType;
}

export interface ProgramSummary {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  siteId: string | null;
  siteName: string | null;
  clientId: string | null;
  clientName: string | null;
  type: ProgramType;
  sponsorId: string | null;
  sponsorName: string | null;
  ds2019Number: string | null;
  ds2019IssuedOn: string | null;
  ds2019ExpiresOn: string | null;
  visaExpiresOn: string | null;
  sevisId: string | null;
  country: string | null;
  programStart: string;
  programEnd: string;
  gracePeriodDays: number;
  /** YYYY-MM-DD: programEnd + grace. */
  graceEndsOn: string;
  secondJobStatus: SecondJobStatus;
  h2bPetitionNumber: string | null;
  petitionClientId: string | null;
  petitionClientName: string | null;
  petitionValidFrom: string | null;
  petitionValidTo: string | null;
  worksiteArea: string | null;
  lastSponsorCheckInOn: string | null;
  nextSponsorCheckInOn: string | null;
  i9WorkAuthExpiresOn: string | null;
  notes: string | null;
  closedAt: string | null;
  closedReason: string | null;
  /** Server-computed from today. */
  daysUntilEnd: number;
  status: 'UPCOMING' | 'ACTIVE' | 'GRACE' | 'ENDED' | 'CLOSED';
  documents: Array<{ id: string; kind: string; filename: string; expiresAt: string | null }>;
  alerts: ProgramAlert[];
}

export interface ProgramListResponse {
  programs: ProgramSummary[];
}

export interface ProgramAlertSettings {
  programEndDays: number[];
  visaExpiryDays: number[];
  i9ReverifyDays: number[];
  sponsorCheckInDays: number[];
  petitionEndDays: number[];
}
export const ProgramAlertSettingsSchema = /* @__PURE__ */ (() => z.object({
  programEndDays: z.array(z.number().int().min(0).max(365)).max(8),
  visaExpiryDays: z.array(z.number().int().min(0).max(365)).max(8),
  i9ReverifyDays: z.array(z.number().int().min(0).max(365)).max(8),
  sponsorCheckInDays: z.array(z.number().int().min(0).max(365)).max(8),
  petitionEndDays: z.array(z.number().int().min(0).max(365)).max(8),
}))();

export interface ProgramAlertsResponse {
  alerts: ProgramAlert[];
  settings: ProgramAlertSettings;
}

/** Counts only, by month, site and channel — safe to hand a client. */
export interface TransitionCalendarCell {
  /** YYYY-MM */
  month: string;
  siteId: string | null;
  siteName: string;
  clientId: string | null;
  clientName: string;
  channel: ProgramType;
  arrivals: number;
  programEnds: number;
  departures: number;
}

export interface TransitionCalendarResponse {
  from: string;
  to: string;
  months: string[];
  cells: TransitionCalendarCell[];
  totals: { arrivals: number; programEnds: number; departures: number };
}

export interface SponsorReportRow {
  associateId: string;
  associateName: string;
  country: string | null;
  programStart: string;
  programEnd: string;
  siteName: string | null;
  clientName: string | null;
  /** Hours worked in the window, from verified clock-ins. */
  hours: number;
  /** The address on file, or null. */
  housing: string | null;
  incidents: number;
  lastSponsorCheckInOn: string | null;
  departure: { lastDayWorked: string; reason: string } | null;
}

export interface SponsorReportResponse {
  sponsor: Sponsor;
  from: string;
  to: string;
  rows: SponsorReportRow[];
  totals: { participants: number; hours: number; incidents: number; departures: number };
}

/* -------------------------------------------------------------------------- *
 *  Season Planner (Brief 1C-3) — demand by store, shift and week becomes
 *  associates, beds, van seats and recruiting targets by channel. A plan is
 *  a scenario; outputs are computed on read.
 * -------------------------------------------------------------------------- */

export const RECRUITING_CHANNELS = ['LOCAL', 'J1_NORTH', 'J1_SOUTH', 'H2B'] as const;
export type RecruitingChannel = (typeof RECRUITING_CHANNELS)[number];
export const RECRUITING_CHANNEL_LABELS: Record<RecruitingChannel, string> = {
  LOCAL: 'Local hires',
  J1_NORTH: 'J-1 northern hemisphere',
  J1_SOUTH: 'J-1 southern hemisphere',
  H2B: 'H-2B',
};

const ChannelPercentSchema = /* @__PURE__ */ (() => z.object({
  LOCAL: z.number().min(0).max(100),
  J1_NORTH: z.number().min(0).max(100),
  J1_SOUTH: z.number().min(0).max(100),
  H2B: z.number().min(0).max(100),
}))();
export type ChannelPercent = z.infer<typeof ChannelPercentSchema>;
const ChannelWeeksSchema = /* @__PURE__ */ (() => z.object({
  LOCAL: z.number().int().min(0).max(52),
  J1_NORTH: z.number().int().min(0).max(52),
  J1_SOUTH: z.number().int().min(0).max(52),
  H2B: z.number().int().min(0).max(52),
}))();
export type ChannelWeeks = z.infer<typeof ChannelWeeksSchema>;

export const SeasonDemandWeekSchema = /* @__PURE__ */ (() => z.object({
  /** Org week start, YYYY-MM-DD (a Saturday). */
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  day: z.number().int().min(0).max(2000),
  evening: z.number().int().min(0).max(2000),
  overnight: z.number().int().min(0).max(2000),
}))();
export type SeasonDemandWeek = z.infer<typeof SeasonDemandWeekSchema>;

/** Brief 3-3: demand as tasks — a type, how many a week, minutes each, its risk. */
export const SeasonTaskDemandLineSchema = /* @__PURE__ */ (() => z.object({
  /** A capability code from WORKER_CAPABILITIES. */
  capability: z.string().min(1).max(60),
  count: z.number().int().min(0).max(100_000),
  minutes: z.number().int().min(0).max(1440),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('LOW'),
}))();
export type SeasonTaskDemandLine = z.infer<typeof SeasonTaskDemandLineSchema>;

export const SeasonTaskDemandWeekSchema = /* @__PURE__ */ (() => z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tasks: z.array(SeasonTaskDemandLineSchema).max(50),
}))();
export type SeasonTaskDemandWeek = z.infer<typeof SeasonTaskDemandWeekSchema>;

export const SeasonPlanSiteInputSchema = /* @__PURE__ */ (() => z.object({
  locationId: UuidSchema,
  bedsAvailable: z.number().int().min(0).max(5000).default(0),
  vanSeatsPerRun: z.number().int().min(0).max(200).default(14),
  runsPerShift: z.number().int().min(0).max(20).default(1),
  routeMinutes: z.number().int().min(0).max(600).default(45),
  demand: z.array(SeasonDemandWeekSchema).max(60).default([]),
  /** Brief 3-3: the week's work as tasks; the planner proposes the people-robot mix from it. */
  taskDemand: z.array(SeasonTaskDemandWeekSchema).max(60).default([]),
}))();
export type SeasonPlanSiteInput = z.infer<typeof SeasonPlanSiteInputSchema>;

export const SeasonPlanInputSchema = /* @__PURE__ */ (() => z
  .object({
    name: z.string().trim().min(2).max(120),
    clientId: UuidSchema.nullable().optional(),
    seasonStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    seasonEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    targetHoursPerWeek: z.number().int().min(8).max(80).default(40),
    shiftHours: z.number().int().min(4).max(12).default(8),
    reservePct: z.number().int().min(0).max(100).default(10),
    channelMix: ChannelPercentSchema.optional(),
    arrivalLeadWeeks: ChannelWeeksSchema.optional(),
    housingShare: ChannelPercentSchema.optional(),
    rideShare: ChannelPercentSchema.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** Sites in the plan; omitted on create = every active store of the client (or every store). */
    sites: z.array(SeasonPlanSiteInputSchema).max(60).optional(),
  })
  .refine((v) => v.seasonEnd >= v.seasonStart, { message: 'seasonEnd must be on or after seasonStart', path: ['seasonEnd'] }))();
export type SeasonPlanInput = z.infer<typeof SeasonPlanInputSchema>;

export const SeasonPlanUpdateSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(2).max(120).optional(),
  seasonStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  seasonEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  targetHoursPerWeek: z.number().int().min(8).max(80).optional(),
  shiftHours: z.number().int().min(4).max(12).optional(),
  reservePct: z.number().int().min(0).max(100).optional(),
  channelMix: ChannelPercentSchema.optional(),
  arrivalLeadWeeks: ChannelWeeksSchema.optional(),
  housingShare: ChannelPercentSchema.optional(),
  rideShare: ChannelPercentSchema.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** Replaces the site list when present. */
  sites: z.array(SeasonPlanSiteInputSchema).max(60).optional(),
  archived: z.boolean().optional(),
}))();
export type SeasonPlanUpdate = z.infer<typeof SeasonPlanUpdateSchema>;

export interface SeasonPlanSiteWeek {
  week: string;
  day: number;
  evening: number;
  overnight: number;
  /** Floor headcount per day across the three shifts. */
  daily: number;
  /** Shift slots that week (daily × 7). */
  shiftSlots: number;
  associatesNeeded: number;
  bedsNeeded: number;
  bedsAvailable: number;
  bedsGap: number;
  /** Peak seats needed on one shift's runs vs. what the vans carry. */
  vanSeatsNeeded: number;
  vanSeatsAvailable: number;
  vanSeatsGap: number;
  /** Actuals, when the week is in the past or in progress. */
  scheduledHours: number | null;
  activeHeadcount: number | null;
  /** The Workforce agent's coverage.forecast: days that week the site is short, from its latest forecast. Null outside the forecast. */
  forecastShortDays?: number | null;
  /** Brief 3-3: the hybrid mix from the week's task demand; null when the week has none. */
  mix?: SeasonWeekMix | null;
}

export interface SeasonPlanSiteComputed {
  locationId: string;
  siteName: string;
  clientId: string;
  clientName: string;
  bedsAvailable: number;
  vanSeatsPerRun: number;
  runsPerShift: number;
  routeMinutes: number;
  weeks: SeasonPlanSiteWeek[];
  peak: { week: string; daily: number; associatesNeeded: number; bedsNeeded: number; vanSeatsNeeded: number };
  /** Brief 3-3 */
  taskDemand: SeasonTaskDemandWeek[];
  /** Robots placed at the site today (the mix's capacity). */
  robotsPlaced: number;
  hourlyRateCents: number;
}

export interface SeasonRecruitingTarget {
  channel: RecruitingChannel;
  label: string;
  sharePct: number;
  /** Associates this channel must supply at the plan's peak. */
  target: number;
  /** Season start minus the channel's lead time. */
  recruitBy: string;
  /** Programs on the books with a start inside the season (J-1 by hemisphere, H-2B), or hires for LOCAL. */
  pipeline: number;
  gap: number;
}

export interface SeasonGap {
  kind: 'HEADCOUNT' | 'BEDS' | 'VAN_SEATS' | 'RECRUITING';
  siteName: string | null;
  week: string | null;
  needed: number;
  available: number;
  shortfall: number;
  text: string;
}

export interface SeasonPlanSummary {
  id: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  seasonStart: string;
  seasonEnd: string;
  targetHoursPerWeek: number;
  shiftHours: number;
  reservePct: number;
  channelMix: ChannelPercent;
  arrivalLeadWeeks: ChannelWeeks;
  housingShare: ChannelPercent;
  rideShare: ChannelPercent;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  siteCount: number;
  weeks: string[];
}

export interface SeasonPlanComputed extends SeasonPlanSummary {
  sites: SeasonPlanSiteComputed[];
  /** Company-wide, per week. */
  totals: Array<{
    week: string;
    daily: number;
    associatesNeeded: number;
    bedsNeeded: number;
    bedsAvailable: number;
    vanSeatsNeeded: number;
    vanSeatsAvailable: number;
    scheduledHours: number | null;
    activeHeadcount: number | null;
    forecastShortDays?: number | null;
    /** Brief 3-3: summed over the sites that carry task demand; null when none does. */
    laborCostCents?: number | null;
    robotCostCents?: number | null;
    robotsNeeded?: number | null;
    backupCrew?: number | null;
  }>;
  peak: { week: string; daily: number; associatesNeeded: number; bedsNeeded: number; bedsAvailable: number; bedsGap: number };
  recruiting: SeasonRecruitingTarget[];
  gaps: SeasonGap[];
}

export interface SeasonPlanListResponse {
  plans: SeasonPlanSummary[];
}

export interface SeasonPlanCompareResponse {
  a: SeasonPlanComputed;
  b: SeasonPlanComputed;
}

/* -------------------------------------------------------------------------- *
 *  WhatsApp (Brief 1C-4) — a delivery channel with consent, receipts, and a
 *  small assistant. Templates are registered with Meta under the names the
 *  admin page lists.
 * -------------------------------------------------------------------------- */

export type WhatsAppConsentStatus = 'OPTED_IN' | 'OPTED_OUT';

export interface WhatsAppMeResponse {
  configured: boolean;
  phoneOnFile: string | null;
  consent: { status: WhatsAppConsentStatus; phone: string; optedInAt: string; optedOutAt: string | null } | null;
}

export const WhatsAppConsentInputSchema = /* @__PURE__ */ (() => z.object({
  optIn: z.boolean(),
  phone: z.string().trim().max(40).optional(),
}))();
export type WhatsAppConsentInput = z.infer<typeof WhatsAppConsentInputSchema>;

export type WhatsAppMessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'RECEIVED';
export type WhatsAppMessageKind = 'TEMPLATE' | 'TEXT' | 'QUESTION' | 'ANSWER' | 'HANDOFF' | 'SYSTEM';

export interface WhatsAppMessageRow {
  id: string;
  associateId: string | null;
  associateName: string | null;
  /** Last four digits only. */
  phone: string;
  direction: 'OUTBOUND' | 'INBOUND';
  kind: WhatsAppMessageKind;
  templateName: string | null;
  language: string;
  body: string;
  category: string | null;
  status: WhatsAppMessageStatus;
  statusAt: string | null;
  failureReason: string | null;
  conversationId: string | null;
  createdAt: string;
}

export interface WhatsAppTemplateInfo {
  key: string;
  metaName: string;
  metaCategory: string;
  params: string[];
  description: string;
  body: { en: string; es: string; tr: string };
}

export interface WhatsAppOverview {
  configured: boolean;
  webhookConfigured: boolean;
  apiVersion: string;
  phoneNumberId: string | null;
  consent: { optedIn: number; optedOut: number };
  last7Days: { sent: number; delivered: number; read: number; failed: number; questions: number; handoffs: number };
  templates: WhatsAppTemplateInfo[];
}

/* -------------------------------------------------------------------------- *
 *  Workers (Brief 1D-1) — a worker is not assumed to be a person. Every
 *  worker has a type, an accountable owner, capabilities and a lifecycle.
 * -------------------------------------------------------------------------- */

export const WorkerTypeSchema = /* @__PURE__ */ (() => z.enum(['PERSON', 'AGENT', 'ROBOT']))();
export type WorkerType = z.infer<typeof WorkerTypeSchema>;
export const WORKER_TYPE_LABELS: Record<WorkerType, string> = { PERSON: 'Person', AGENT: 'AI agent', ROBOT: 'Robot' };

export const WorkerStatusSchema = /* @__PURE__ */ (() => z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED']))();
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
export const WORKER_STATUS_LABELS: Record<WorkerStatus, string> = {
  ONBOARDING: 'Onboarding',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  OFFBOARDED: 'Offboarded',
};

/** Certified task types a worker can be trusted with. Grows with the hybrid crews. */
export const WORKER_CAPABILITIES = [
  { code: 'stocking', label: 'Stocking and replenishment', types: ['PERSON', 'ROBOT'] },
  { code: 'floor-care', label: 'Floor care', types: ['PERSON', 'ROBOT'] },
  { code: 'shelf-scanning', label: 'Shelf scanning', types: ['ROBOT'] },
  { code: 'food-service', label: 'Food service and bussing', types: ['PERSON', 'ROBOT'] },
  { code: 'room-delivery', label: 'Room and item delivery', types: ['ROBOT'] },
  { code: 'unloading', label: 'Truck unloading and tote handling', types: ['PERSON', 'ROBOT'] },
  { code: 'supervision', label: 'Crew supervision', types: ['PERSON'] },
  { code: 'driving', label: 'Driving', types: ['PERSON'] },
  { code: 'messaging', label: 'Send messages to associates', types: ['AGENT'] },
  { code: 'schedule-read', label: 'Read schedules', types: ['AGENT'] },
  { code: 'schedule-write', label: 'Propose schedule changes', types: ['AGENT'] },
  { code: 'report-read', label: 'Read reports', types: ['AGENT'] },
  { code: 'deploy', label: 'Deploy the platform', types: ['AGENT'] },
] as const;
export type WorkerCapabilityCode = (typeof WORKER_CAPABILITIES)[number]['code'];
const capabilityCodes = WORKER_CAPABILITIES.map((c) => c.code) as [WorkerCapabilityCode, ...WorkerCapabilityCode[]];

export const WorkerInputSchema = /* @__PURE__ */ (() => z.object({
  type: z.enum(['AGENT', 'ROBOT']),
  name: z.string().trim().min(2).max(160),
  /** Required: no worker without a human accountable for it. */
  ownerUserId: UuidSchema,
  status: WorkerStatusSchema.default('ONBOARDING'),
  capabilities: z.array(z.enum(capabilityCodes)).max(20).default([]),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** Where it works from day one; optional. */
  locationId: UuidSchema.nullable().optional(),
}))();
export type WorkerInput = z.infer<typeof WorkerInputSchema>;

export const WorkerUpdateSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(2).max(160).optional(),
  ownerUserId: UuidSchema.optional(),
  status: WorkerStatusSchema.optional(),
  capabilities: z.array(z.enum(capabilityCodes)).max(20).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}))();
export type WorkerUpdate = z.infer<typeof WorkerUpdateSchema>;

export const WorkerAssignmentInputSchema = /* @__PURE__ */ (() => z.object({
  locationId: UuidSchema,
  startedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Ends the current open assignment at the same site before opening this one. */
  notes: z.string().trim().max(500).nullable().optional(),
}))();
export type WorkerAssignmentInput = z.infer<typeof WorkerAssignmentInputSchema>;

export interface WorkerSiteRef {
  locationId: string;
  siteName: string;
  clientId: string;
  clientName: string;
  startedAt: string;
  endedAt: string | null;
  /** 'associate' for a PERSON worker's AssociateAssignment, 'worker' otherwise. */
  source: 'associate' | 'worker';
}

export interface WorkerSummary {
  id: string;
  type: WorkerType;
  name: string;
  associateId: string | null;
  /** The accountable account; `associateId` is their own person record when they have one, so a row can show a face and link to it. */
  owner: { id: string; name: string; email: string; associateId?: string | null } | null;
  /** PERSON rows only: who they report to, read from the associate record. Absent on agents and robots. */
  manager?: { associateId: string; name: string } | null;
  status: WorkerStatus;
  capabilities: string[];
  notes: string | null;
  sites: WorkerSiteRef[];
  /** Shifts on the schedule from now on. */
  upcomingShifts: number;
  createdAt: string;
  offboardedAt: string | null;
}

export interface WorkersResponse {
  workers: WorkerSummary[];
  counts: Record<WorkerType, Record<WorkerStatus, number>>;
  /** Must be zero. Listed so the page can say so. */
  withoutOwner: WorkerSummary[];
  /** Associates that have no PERSON worker yet (the sweep fills them when an owner can be found). */
  associatesWithoutWorker: number;
  /** True when the roster hit its cap and more workers exist than were returned. */
  truncated?: boolean;
}

/* ---------------------------------------------------------------------------
 *  Agent registry (Brief 1D-2) — every AI agent Alto runs is registered,
 *  scoped, owned and logged. An agent is a Worker of type AGENT; the
 *  profile carries what the registry needs beyond the worker row.
 * -------------------------------------------------------------------------- */

export const AgentEnvironmentSchema = /* @__PURE__ */ (() => z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']))();
export type AgentEnvironment = z.infer<typeof AgentEnvironmentSchema>;
export const AGENT_ENVIRONMENT_LABELS: Record<AgentEnvironment, string> = {
  PRODUCTION: 'Production',
  STAGING: 'Staging',
  DEVELOPMENT: 'Development',
};

/**
 * The capabilities an agent may be granted, drawn from the role catalog.
 * Least privilege by construction: nothing here touches pay, people
 * records, access or settings; those are human-only, and the gated
 * actions below are how an agent asks a person for them.
 */
export const AGENT_SCOPES = [
  { code: 'view:scheduling', label: 'Read schedules' },
  { code: 'view:time', label: 'Read time and attendance' },
  { code: 'view:analytics', label: 'Read reports' },
  { code: 'view:communications', label: 'Read messages' },
  { code: 'manage:communications', label: 'Write messages' },
  { code: 'view:transport', label: 'Read rides and routes' },
  { code: 'view:compliance', label: 'Read compliance status' },
  // Agent families step 0 (owner's decisions 1 and 2, 2026-10-13). Each acts
  // only through a claimed approval or as an ungated notice, per capability.
  { code: 'view:org', label: 'Read people and sites' },
  { code: 'manage:scheduling', label: 'Assign shifts (through an approval)' },
  { code: 'manage:compliance', label: 'Send compliance reminders' },
  // Agent-only: HR case routes gate on role, not on a capability, so a
  // case-opening agent holds this and nothing that reads every case.
  { code: 'open:hr-case', label: 'Open HR cases (through an approval)' },
  // BEYOND: the Payroll agent reads the pre-payroll exceptions; it changes nothing itself.
  { code: 'view:payroll', label: 'Read payroll readiness' },
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number]['code'];
const agentScopeCodes = AGENT_SCOPES.map((s) => s.code) as [AgentScope, ...AgentScope[]];
export const AgentScopeSchema = /* @__PURE__ */ (() => z.enum(agentScopeCodes))();

/**
 * The agent families of the product taxonomy. An agent record names its
 * family and the capability it performs; the Agents page groups by family.
 */
export const AGENT_FAMILIES = [
  { group: 'Agents for the Workforce', code: 'talent', label: 'Talent' },
  { group: 'Agents for the Workforce', code: 'workforce', label: 'Workforce' },
  { group: 'Agents for the Workforce', code: 'programs', label: 'Programs' },
  { group: 'Agents for the Workforce', code: 'payroll', label: 'Payroll' },
  { group: 'Agents for the Workforce', code: 'decision-intelligence', label: 'Decision Intelligence' },
  { group: 'Agents for Operations', code: 'operations', label: 'Operations' },
  { group: 'Agents for Operations', code: 'robotics', label: 'Robotics' },
  { group: 'Agents for Operations', code: 'safety', label: 'Safety' },
  { group: 'Agents for Compliance', code: 'compliance', label: 'Compliance' },
  { group: 'Agents for Compliance', code: 'audit', label: 'Audit' },
  { group: 'Agents for Compliance', code: 'contracts', label: 'Contracts' },
  { group: 'Agents for Finance and Clients', code: 'billing', label: 'Billing' },
  { group: 'Agents for Finance and Clients', code: 'client', label: 'Client' },
  { group: 'Agents for IT and Developers', code: 'deployment', label: 'Deployment' },
  { group: 'Agents for IT and Developers', code: 'reliability', label: 'Reliability' },
  { group: 'Agents for IT and Developers', code: 'developer', label: 'Developer' },
  { group: 'Agents for Everyone', code: 'associate-self-service', label: 'Associate Self-Service' },
  { group: 'Agents for Everyone', code: 'manager-self-service', label: 'Manager Self-Service' },
] as const;
export type AgentFamily = (typeof AGENT_FAMILIES)[number]['code'];
const agentFamilyCodes = AGENT_FAMILIES.map((f) => f.code) as [AgentFamily, ...AgentFamily[]];
export const AgentFamilySchema = /* @__PURE__ */ (() => z.enum(agentFamilyCodes))();

/** High-risk actions an agent may only request; a person approves or rejects from the queue. */
export const AgentGatedActionSchema = /* @__PURE__ */ (() => z.enum(['PAY_CHANGE', 'SEPARATION', 'CLIENT_MESSAGE', 'DATA_EXPORT', 'SHIFT_ASSIGN', 'CASE_OPEN', 'POLICY_GATE']))();
export type AgentGatedAction = z.infer<typeof AgentGatedActionSchema>;
export const AGENT_GATED_ACTION_LABELS: Record<AgentGatedAction, string> = {
  PAY_CHANGE: 'Pay change',
  SEPARATION: 'Separation',
  CLIENT_MESSAGE: 'Message to a client',
  DATA_EXPORT: 'Data export',
  SHIFT_ASSIGN: 'Shift assignment',
  CASE_OPEN: 'Open an HR case',
  // Brief 2-6 step 2: a capability the customer's own policy gates.
  POLICY_GATE: 'Gated by your policy',
};
/** The ones the agent carries out itself once a person approved; pay and separations are done by the approver. */
export const AGENT_EXECUTABLE_ACTIONS: readonly AgentGatedAction[] = ['CLIENT_MESSAGE', 'DATA_EXPORT', 'SHIFT_ASSIGN', 'CASE_OPEN', 'POLICY_GATE'];

export const AgentApprovalStatusSchema = /* @__PURE__ */ (() => z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CONSUMED', 'EXPIRED']))();
export type AgentApprovalStatus = z.infer<typeof AgentApprovalStatusSchema>;
export const AGENT_APPROVAL_STATUS_LABELS: Record<AgentApprovalStatus, string> = {
  PENDING: 'Waiting',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CONSUMED: 'Done',
  EXPIRED: 'Expired',
};

const AgentLimitsShape = {
  /** Calendar-month spend cap; null = no cap. */
  spendCapCents: z.number().int().min(0).max(100_000_000).nullable(),
  rateLimitPerMinute: z.number().int().min(1).max(10_000),
  /** Hours of operation, org-local; both null = any hour. End 24 = midnight. */
  allowedHoursStart: z.number().int().min(0).max(23).nullable(),
  allowedHoursEnd: z.number().int().min(1).max(24).nullable(),
};

export const AgentInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(2).max(160),
  /** Required: no agent without a person accountable for it. */
  ownerUserId: UuidSchema,
  purpose: z.string().trim().min(3).max(500),
  vendor: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  modelVersion: z.string().trim().min(1).max(80),
  environment: AgentEnvironmentSchema.default('PRODUCTION'),
  family: AgentFamilySchema.nullable().optional(),
  capability: z.string().trim().max(120).nullable().optional(),
  scopes: z.array(AgentScopeSchema).max(20).default([]),
  spendCapCents: AgentLimitsShape.spendCapCents.optional().default(null),
  rateLimitPerMinute: AgentLimitsShape.rateLimitPerMinute.default(60),
  allowedHoursStart: AgentLimitsShape.allowedHoursStart.optional().default(null),
  allowedHoursEnd: AgentLimitsShape.allowedHoursEnd.optional().default(null),
  status: WorkerStatusSchema.default('ONBOARDING'),
  capabilities: z.array(z.enum(capabilityCodes)).max(20).default([]),
  notes: z.string().trim().max(2000).nullable().optional(),
}))();
export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentUpdateSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(2).max(160).optional(),
  ownerUserId: UuidSchema.optional(),
  purpose: z.string().trim().min(3).max(500).optional(),
  vendor: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  modelVersion: z.string().trim().min(1).max(80).optional(),
  environment: AgentEnvironmentSchema.optional(),
  family: AgentFamilySchema.nullable().optional(),
  capability: z.string().trim().max(120).nullable().optional(),
  scopes: z.array(AgentScopeSchema).max(20).optional(),
  spendCapCents: AgentLimitsShape.spendCapCents.optional(),
  rateLimitPerMinute: AgentLimitsShape.rateLimitPerMinute.optional(),
  allowedHoursStart: AgentLimitsShape.allowedHoursStart.optional(),
  allowedHoursEnd: AgentLimitsShape.allowedHoursEnd.optional(),
  status: WorkerStatusSchema.optional(),
  capabilities: z.array(z.enum(capabilityCodes)).max(20).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}))();
export type AgentUpdate = z.infer<typeof AgentUpdateSchema>;

export const AgentCredentialIssueSchema = /* @__PURE__ */ (() => z.object({
  /** Short-lived: a day by default, a week at most. */
  ttlHours: z.number().int().min(1).max(168).default(24),
}))();
export type AgentCredentialIssue = z.infer<typeof AgentCredentialIssueSchema>;

export const AgentRevokeSchema = /* @__PURE__ */ (() => z.object({ reason: z.string().trim().max(200).optional() }))();

export const AgentRequestInputSchema = /* @__PURE__ */ (() => z.object({
  action: AgentGatedActionSchema,
  /** What the agent wants, in words a person can approve. */
  summary: z.string().trim().min(3).max(500),
  payload: z.record(z.string(), z.unknown()).default({}),
}))();
export type AgentRequestInput = z.infer<typeof AgentRequestInputSchema>;

export const AgentDecisionSchema = /* @__PURE__ */ (() => z.object({ note: z.string().trim().max(500).optional() }))();

/**
 * One decision on a proposal: POST /agents/approvals/:id/decide. A rejection
 * carries its reason; it is kept on the proposal and on the trail.
 */
export const AgentDecideInputSchema = /* @__PURE__ */ (() =>
  z
    .object({
      decision: z.enum(['APPROVE', 'REJECT']),
      reason: z.string().trim().max(500).optional(),
    })
    .superRefine((v, ctx) => {
      if (v.decision === 'REJECT' && !(v.reason && v.reason.length >= 3)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Say why you are rejecting this proposal.' });
      }
    }))();
export type AgentDecideInput = z.infer<typeof AgentDecideInputSchema>;

/** What a proposal touches: a record a person can open. */
export const ProposalAffectedKindSchema = /* @__PURE__ */ (() => z.enum(['person', 'site', 'shift', 'case', 'client']))();
export type ProposalAffectedKind = z.infer<typeof ProposalAffectedKindSchema>;

/**
 * The evidence behind a proposal — what a person reads before deciding:
 * why this (and not something else), what it changes, the rule that put it
 * in front of them, and who it touches. Written by the capability that made
 * the proposal; a generic block stands in when a creator has nothing more.
 */
export const ProposalEvidenceSchema = /* @__PURE__ */ (() =>
  z.object({
    why: z.string().max(2000),
    alternatives: z.array(z.object({ label: z.string().max(200), note: z.string().max(500) })).max(20),
    impact: z.array(z.object({ label: z.string().max(80), value: z.string().max(200) })).max(20),
    policy: z.string().max(500).nullable(),
    affects: z.array(z.object({ kind: ProposalAffectedKindSchema, id: z.string().min(1), name: z.string().max(200) })).max(20),
  }))();
export type ProposalEvidence = z.infer<typeof ProposalEvidenceSchema>;

export const AgentSpendInputSchema = /* @__PURE__ */ (() => z.object({
  amountCents: z.number().int().min(0).max(100_000_000),
  taskRef: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
  occurredAt: z.string().datetime().optional(),
}))();
export type AgentSpendInput = z.infer<typeof AgentSpendInputSchema>;

/** What an agent sends to a conversation; a client thread turns it into an approval request. */
export const AgentMessageInputSchema = /* @__PURE__ */ (() => z.object({
  conversationId: UuidSchema,
  body: z.string().trim().min(1).max(4000),
  /** An approved request's id, to carry out a message that was gated. */
  approvalId: UuidSchema.optional(),
}))();
export type AgentMessageInput = z.infer<typeof AgentMessageInputSchema>;

export type AgentCredentialState = 'ACTIVE' | 'ROTATING' | 'EXPIRED' | 'REVOKED';

export interface AgentCredentialSummary {
  id: string;
  last4: string;
  state: AgentCredentialState;
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  issuedBy: { id: string; name: string } | null;
  rotatedFromId: string | null;
}

export interface AgentApprovalSummary {
  id: string;
  workerId: string;
  agentName: string;
  /** The agent's family (its glyph) and accountable owner, so the decision names who stands behind it. */
  agentFamily: AgentFamily | null;
  agentOwner: { id: string; name: string } | null;
  action: AgentGatedAction;
  summary: string;
  payload: Record<string, unknown>;
  status: AgentApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  consumedAt: string | null;
  /** The proposal this request carries, when a capability filed it. */
  proposalId: string | null;
  capabilityKey: string | null;
  /** What a person reads before deciding. Always present; generic when the creator wrote nothing more. */
  evidence: ProposalEvidence;
  /** Set by routes that know the caller: may this person decide it under the server's rule? */
  mayDecide?: boolean;
}

export interface AgentTrailEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentProfileSummary {
  purpose: string;
  family: AgentFamily | null;
  capability: string | null;
  vendor: string;
  model: string;
  modelVersion: string;
  environment: AgentEnvironment;
  scopes: AgentScope[];
  spendCapCents: number | null;
  rateLimitPerMinute: number;
  allowedHoursStart: number | null;
  allowedHoursEnd: number | null;
  builtInKey: string | null;
  lastActiveAt: string | null;
}

export interface AgentSummary extends WorkerSummary {
  profile: AgentProfileSummary;
  activeCredentials: number;
  pendingApprovals: number;
  spendThisMonthCents: number;
  /** Brief 1D-3. Always sent by the API; optional so earlier fixtures still compile. */
  certification?: AgentCertification;
  /** The trailing seven days. */
  scorecard?: AgentScorecard;
  kill?: AgentKillState;
  drift?: AgentDrift;
}

export interface AgentDetail extends AgentSummary {
  credentials: AgentCredentialSummary[];
  approvals: AgentApprovalSummary[];
  spend: { id: string; occurredAt: string; amountCents: number; taskRef: string | null; note: string | null }[];
  trail: AgentTrailEntry[];
}

export interface AgentRegistryResponse {
  agents: AgentSummary[];
  counts: Record<WorkerStatus, number>;
  pendingApprovals: number;
  /** Built-in agents the boot sweep could not register (no owner account yet). */
  builtInMissing: string[];
  /** The same agents with the names the page shows; the keys above stay for callers that match on them. */
  builtInMissingAgents?: { key: string; name: string }[];
  /** Brief 1D-3: the switch. Agent families step 0: this organization's switch. */
  control?: AgentControlState;
  /** The operator's switch over every tenant; an agent stops when either is set. */
  platformControl?: AgentControlState;
}

export interface AgentIssuedCredential {
  id: string;
  /** Shown once. */
  plaintext: string;
  last4: string;
  expiresAt: string;
}

/** What /agent/v1/me answers. */
export interface AgentSelf {
  workerId: string;
  name: string;
  status: WorkerStatus;
  scopes: AgentScope[];
  limits: { spendCapCents: number | null; rateLimitPerMinute: number; allowedHoursStart: number | null; allowedHoursEnd: number | null };
  spendThisMonthCents: number;
  credential: { id: string; expiresAt: string };
}

/* ---------------------------------------------------------------------------
 *  Agent controls (Brief 1D-3) — the off switch, certification before
 *  production, the scorecard and the drift alert.
 * -------------------------------------------------------------------------- */

export const AgentSuspendSchema = /* @__PURE__ */ (() => z.object({ reason: z.string().trim().min(3).max(300) }))();

/**
 * A scenario is an input and what must come back. `expected.output` is
 * compared whole (order of keys ignored); `expected.allowedActions` passes
 * when every action the agent took is in the set.
 */
export const AgentScenarioInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(2).max(160),
  input: z.record(z.string(), z.unknown()),
  expected: z
    .object({
      output: z.record(z.string(), z.unknown()).optional(),
      allowedActions: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    })
    .refine((e) => e.output !== undefined || e.allowedActions !== undefined, { message: 'Give an expected output or the allowed actions.' }),
}))();
export type AgentScenarioInput = z.infer<typeof AgentScenarioInputSchema>;

/** What the agent answers a scenario with, through /agent/v1. */
export const AgentScenarioAnswerSchema = /* @__PURE__ */ (() => z.object({
  output: z.record(z.string(), z.unknown()).optional(),
  actions: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
}))();
export type AgentScenarioAnswer = z.infer<typeof AgentScenarioAnswerSchema>;

export const AgentDriftSchema = /* @__PURE__ */ (() => z.object({
  driftErrorRatePct: z.number().int().min(1).max(100).nullable().optional(),
  driftCostPerTaskCents: z.number().int().min(1).max(100_000_000).nullable().optional(),
}))();

export interface AgentScenarioRunSummary {
  id: string;
  modelVersion: string;
  passed: boolean;
  actual: Record<string, unknown> | null;
  reason: string | null;
  ranBy: { id: string; name: string } | null;
  ranAt: string;
}

export interface AgentScenarioSummary {
  id: string;
  name: string;
  input: Record<string, unknown>;
  expected: { output?: Record<string, unknown>; allowedActions?: string[] };
  /** The newest run under the agent's current model version, if any. */
  latest: AgentScenarioRunSummary | null;
  createdAt: string;
}

export interface AgentCertification {
  modelVersion: string;
  certifiedAt: string | null;
  certifiedModelVersion: string | null;
  /** Certified for the version it runs now. */
  current: boolean;
  scenarios: number;
  passing: number;
  /** Every scenario has a passing run under the current version, and there is at least one. */
  ready: boolean;
  /** Built-in agents the API can exercise itself. */
  runnable: boolean;
}

export interface AgentScorecard {
  days: number;
  tasksCompleted: number;
  errors: number;
  /** errors / (tasks + errors), whole percent; null with nothing to measure. */
  errorRatePct: number | null;
  exceptionsEscalated: number;
  approvalsRequested: number;
  approvalsRejected: number;
  spendCents: number;
  costPerTaskCents: number | null;
}

export interface AgentControlState {
  allSuspendedAt: string | null;
  suspendedBy: { id: string; name: string } | null;
  reason: string | null;
}

export interface AgentKillState {
  suspendedAt: string | null;
  suspendedBy: { id: string; name: string } | null;
  suspendReason: string | null;
}

export interface AgentDrift {
  driftErrorRatePct: number | null;
  driftCostPerTaskCents: number | null;
  lastDriftAlertAt: string | null;
}

/* ---------------------------------------------------------------------------
 *  Headcount (Brief 1A-2) — every number on the screen is the one definition
 *  of active, beside what payroll last said.
 * -------------------------------------------------------------------------- */

export interface HeadcountRow {
  id: string;
  name: string;
  /** For a store row, its client. */
  clientName?: string;
  active: number;
  scheduledThisWeek: number;
  /** Associates placed here whose role has no rate card (Brief 1A-2); null until the rate table exists. */
  withoutRate: number | null;
}

export interface ReconciliationSummary {
  periodStart: string;
  periodEnd: string;
  ranAt: string;
  platformActive: number;
  platformPaid: number;
  payrollPaid: number | null;
  headcountVariance: number | null;
  hoursVariance: number | null;
  grossVariance: number | null;
  varianceLines: number | null;
  payrollProvided: boolean;
  /** What was compared, in words (a self-check names itself). */
  notes: string | null;
}

export interface HeadcountOverview {
  asOf: string;
  windowDays: number;
  /** The one definition, company-wide ("Working"). */
  active: number;
  /** Hired and not separated (peopleStatus.ts): the same number Analytics and the People directory show. */
  onTheBooks?: number;
  /** Everyone by the one status, from the same reading (lib/peopleStatus). */
  statusCounts?: WorkStatusCounts;
  /** Associates on an ASSIGNED shift in the current org week. */
  scheduledThisWeek: number;
  /** Associates the payroll engine would pay for the last closed period, or null when no run exists. */
  onPayrollLastPeriod: { count: number; periodStart: string; periodEnd: string } | null;
  /** Associates with housing on file; null until the housing link (Helios) exists. */
  inHousing: number | null;
  /** On file but not active, by reason. */
  notActive: { employedNotPlaced: number; placedNoRecentWork: number; separated: number; deactivated: number; onboarding: number };
  byClient: HeadcountRow[];
  byStore: HeadcountRow[];
  byDepartment: { id: string | null; name: string; active: number }[];
  byEmploymentType: { employmentType: string; active: number }[];
  reconciliation: ReconciliationSummary | null;
}

/* ===== Inbox — every decision waiting on the signed-in person ============== */

/** One queue the person may act on, as a count and the link to it. */
/**
 * How a queue ranks against the others (role walk HR 4): a legal clock
 * (an E-Verify mismatch, a claim's response window) above money (payroll
 * sign-off, bills due) above routine work (a punch to review). Absent on
 * an older API: routine.
 */
export const INBOX_URGENCIES = ['legal', 'money', 'routine'] as const;
export type InboxUrgency = (typeof INBOX_URGENCIES)[number];

export const InboxSourceSchema = /* @__PURE__ */ (() => z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  /** Capped at 999 by the API. */
  count: z.number().int().min(0).max(999),
  path: z.string().min(1),
  urgency: z.enum(INBOX_URGENCIES).optional(),
  /** The soonest deadline among the items counted, when the queue has one. */
  dueAt: z.string().datetime().nullable().optional(),
  /** A task's own progress ("2 of 8 done") — the associate's onboarding. */
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(1) }).optional(),
  /**
   * Another desk owns this company-wide queue (queues.ts QUEUE_REGISTRY):
   * shown under "Also watching", never counted in `total` or a badge.
   */
  watching: z.boolean().optional(),
}))();
export type InboxSource = z.infer<typeof InboxSourceSchema>;

/**
 * The Inbox's order: legal clocks first, then money, then routine; within
 * a band the soonest deadline, then the biggest queue. One ranking for the
 * page, the home rows and the phone sheet, so no two surfaces disagree.
 */
export function rankInboxSources<T extends Pick<InboxSource, 'count' | 'urgency' | 'dueAt'>>(sources: readonly T[]): T[] {
  const band = (s: T) => INBOX_URGENCIES.indexOf(s.urgency ?? 'routine');
  const due = (s: T) => (s.dueAt ? Date.parse(s.dueAt) : Number.POSITIVE_INFINITY);
  return [...sources].sort((a, b) => band(a) - band(b) || due(a) - due(b) || b.count - a.count);
}

/** GET /me/inbox — only the sources the caller may see. */
export const InboxResponseSchema = /* @__PURE__ */ (() => z.object({
  /** Items in the queues this person owns (not the "Also watching" ones). */
  total: z.number().int().min(0),
  sources: z.array(InboxSourceSchema),
}))();
export type InboxResponse = z.infer<typeof InboxResponseSchema>;
