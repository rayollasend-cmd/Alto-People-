import { z } from 'zod';

/* -------------------------------------------------------------------------- *
 *  Common
 * -------------------------------------------------------------------------- */

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* -------------------------------------------------------------------------- *
 *  Domain enums (mirror Prisma enums in apps/api/prisma/schema.prisma).
 *  Kept as Zod literals so the wire contract stays string-based.
 * -------------------------------------------------------------------------- */

export const ClientStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'PROSPECT']);
export type ClientStatus = z.infer<typeof ClientStatusSchema>;

export const OnboardingTrackSchema = z.enum([
  'STANDARD',
  'J1',
  'CLIENT_SPECIFIC',
]);
export type OnboardingTrack = z.infer<typeof OnboardingTrackSchema>;

export const ApplicationStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const TaskKindSchema = z.enum([
  'PROFILE_INFO',
  'DOCUMENT_UPLOAD',
  'E_SIGN',
  'BACKGROUND_CHECK',
  'W4',
  'DIRECT_DEPOSIT',
  'POLICY_ACK',
  'J1_DOCS',
  'I9_VERIFICATION',
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'SKIPPED',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/* -------------------------------------------------------------------------- *
 *  Clients
 * -------------------------------------------------------------------------- */

export const ClientSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  industry: z.string().nullable(),
  status: ClientStatusSchema,
  contactEmail: z.string().email().nullable(),
  // Two-letter USPS code; drives Phase 23 OT/break policy and Phase 25
  // predictive-scheduling enforcement. Null = federal default.
  state: z.string().length(2).nullable(),
});
export type ClientSummary = z.infer<typeof ClientSummarySchema>;

// Phase 47 — richer shape returned only by the list endpoint. Detail /
// create / update routes still return the lean ClientSummary so they
// don't pay for the count queries on every write.
//
// openApplications counts every Application that hasn't been REJECTED.
// lastPayrollDisbursedAt is the most recent PayrollRun that actually
// settled for this client; null when no run has ever disbursed.
//
// Phase 72 — activeAssociateCount counts Application rows that have
// reached APPROVED. It's a coarse proxy for "successfully onboarded";
// dedup-by-associate isn't perfect but the same associate having two
// approved apps for the same client is a very rare edge case.
export const ClientListItemSchema = ClientSummarySchema.extend({
  openApplications: z.number().int().nonnegative(),
  activeAssociateCount: z.number().int().nonnegative(),
  lastPayrollDisbursedAt: z.string().datetime().nullable(),
});
export type ClientListItem = z.infer<typeof ClientListItemSchema>;

export const ClientStateInputSchema = z.object({
  state: z.string().length(2).nullable(),
});
export type ClientStateInput = z.infer<typeof ClientStateInputSchema>;

// Phase 46 — HR-managed client CRUD. `name` is required and unique-ish at
// the UI level (the API does not enforce uniqueness — two clients named
// "Acme" are legal because of distinct UUIDs). Industry / contact email
// stay optional. Status defaults to PROSPECT for new records so the
// roster doesn't auto-populate active counts before HR confirms.
export const ClientCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  industry: z.string().trim().max(80).nullable().optional(),
  status: ClientStatusSchema.optional(),
  contactEmail: z.string().trim().email().max(254).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
});
export type ClientCreateInput = z.infer<typeof ClientCreateInputSchema>;

// Partial update — every field is optional; sending null clears the
// nullable ones. Use the dedicated /:id/state and /:id/geofence routes
// for state and geofence (they have side-effects on policy enforcement).
export const ClientUpdateInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  industry: z.string().trim().max(80).nullable().optional(),
  status: ClientStatusSchema.optional(),
  contactEmail: z.string().trim().email().max(254).nullable().optional(),
});
export type ClientUpdateInput = z.infer<typeof ClientUpdateInputSchema>;

export const ClientListResponseSchema = z.object({
  clients: z.array(ClientListItemSchema),
});
export type ClientListResponse = z.infer<typeof ClientListResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Onboarding
 * -------------------------------------------------------------------------- */

export const ChecklistTaskSchema = z.object({
  id: UuidSchema,
  kind: TaskKindSchema,
  status: TaskStatusSchema,
  title: z.string(),
  description: z.string().nullable(),
  order: z.number().int(),
  documentId: UuidSchema.nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ChecklistTask = z.infer<typeof ChecklistTaskSchema>;

// Phase 41 — drives W-4 onboarding task inclusion + payroll tax math.
// W2_EMPLOYEE is the default for back-compat with every prior application.
export const EmploymentTypeSchema = z.enum([
  'W2_EMPLOYEE',
  'CONTRACTOR_1099_INDIVIDUAL',
  'CONTRACTOR_1099_BUSINESS',
]);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

// Phase 60 — last invite/nudge email delivery status, surfaced on the
// inbox + detail page so HR sees bounces before the associate fails to
// log in. null = no email ever attempted (shouldn't happen in practice
// after Phase 16, but legacy rows + tests can produce it).
export const InviteDeliveryStatusSchema = z.enum(['QUEUED', 'SENT', 'FAILED']);
export type InviteDeliveryStatus = z.infer<typeof InviteDeliveryStatusSchema>;

export const InviteDeliveryInfoSchema = z.object({
  status: InviteDeliveryStatusSchema,
  // ISO when the row was created (≈ when the send was attempted).
  attemptedAt: z.string().datetime(),
  // ISO of successful send, null if FAILED or still QUEUED.
  sentAt: z.string().datetime().nullable(),
  // Provider error message, null when SENT.
  failureReason: z.string().nullable(),
  // What triggered this row: "onboarding.invite" or "onboarding.nudge".
  category: z.string(),
});
export type InviteDeliveryInfo = z.infer<typeof InviteDeliveryInfoSchema>;

export const ApplicationSummarySchema = z.object({
  id: UuidSchema,
  associateName: z.string(),
  clientName: z.string(),
  onboardingTrack: OnboardingTrackSchema,
  status: ApplicationStatusSchema,
  position: z.string().nullable(),
  startDate: z.string().datetime().nullable(),
  invitedAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
  percentComplete: z.number().min(0).max(100),
  // Phase 60 — most recent EMAIL Notification on this associate's user
  // tagged onboarding.invite or onboarding.nudge. null when there's no
  // such row yet (test fixtures, legacy data).
  lastInviteDelivery: InviteDeliveryInfoSchema.nullable().optional(),
});
export type ApplicationSummary = z.infer<typeof ApplicationSummarySchema>;

export const ApplicationDetailSchema = ApplicationSummarySchema.extend({
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
  hireDate: z.string().date().nullable(),
});
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

// HR review actions — used by /onboarding/applications/:id/approve and
// /reject. hireDate is a YYYY-MM-DD date string the HR user picks in the
// approve dialog.
export const ApproveApplicationInputSchema = z.object({
  hireDate: z.string().date(),
});
export type ApproveApplicationInput = z.infer<
  typeof ApproveApplicationInputSchema
>;

export const RejectApplicationInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RejectApplicationInput = z.infer<
  typeof RejectApplicationInputSchema
>;

export const ApplicationListResponseSchema = z.object({
  applications: z.array(ApplicationSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type ApplicationListResponse = z.infer<
  typeof ApplicationListResponseSchema
>;

// Roll-up counts + sample rows for the Onboarding sidebar tiles. Decouples
// the stats panel from the paginated list so the client doesn't have to
// pull every row just to count statuses.
export const ApplicationStatsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(ApplicationStatusSchema, z.number().int().nonnegative()),
  inFlight: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  bounced: z.number().int().nonnegative(),
  avgPercent: z.number().min(0).max(100),
  staleSamples: z.array(ApplicationSummarySchema),
  bouncedSamples: z.array(ApplicationSummarySchema),
});
export type ApplicationStatsResponse = z.infer<
  typeof ApplicationStatsResponseSchema
>;

export const TemplateTaskSchema = z.object({
  id: UuidSchema,
  kind: TaskKindSchema,
  title: z.string(),
  description: z.string().nullable(),
  order: z.number().int(),
});
export type TemplateTask = z.infer<typeof TemplateTaskSchema>;

export const OnboardingTemplateSchema = z.object({
  id: UuidSchema,
  clientId: UuidSchema.nullable(),
  track: OnboardingTrackSchema,
  name: z.string(),
  tasks: z.array(TemplateTaskSchema),
});
export type OnboardingTemplate = z.infer<typeof OnboardingTemplateSchema>;

export const TemplateListResponseSchema = z.object({
  templates: z.array(OnboardingTemplateSchema),
});
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;

/* ===== Phase 61 — template editor (HR CRUD) ============================ */

// Tasks come without ids (server generates) and the order field is
// optional — server normalizes by array index so HR can just reorder
// in the array and let the API assign 0..N-1.
export const TemplateTaskInputSchema = z.object({
  kind: TaskKindSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  order: z.number().int().nonnegative().optional(),
});
export type TemplateTaskInput = z.infer<typeof TemplateTaskInputSchema>;

export const TemplateUpsertInputSchema = z.object({
  name: z.string().min(1).max(80),
  track: OnboardingTrackSchema,
  // null = global template (applies to any client). UUID = client-scoped.
  clientId: UuidSchema.nullable(),
  // Full-replace semantics: this list IS the new task list. Empty
  // arrays are rejected (a checklist with no tasks is meaningless).
  tasks: z.array(TemplateTaskInputSchema).min(1).max(30),
});
export type TemplateUpsertInput = z.infer<typeof TemplateUpsertInputSchema>;

/* ===== Phase 62 — onboarding analytics ================================= */

// Distribution of completion days for the chosen population (whole org,
// one client, one track). Days are floats since hours matter at the low end
// of the curve. `sample` = how many completed applications fed the math
// (medianDays/p90Days are null when sample = 0).
export const OnboardingCompletionStatsSchema = z.object({
  medianDays: z.number().nullable(),
  p90Days: z.number().nullable(),
  sample: z.number().int().nonnegative(),
});
export type OnboardingCompletionStats = z.infer<
  typeof OnboardingCompletionStatsSchema
>;

export const OnboardingTrackBreakdownSchema = z.object({
  track: OnboardingTrackSchema,
  count: z.number().int().nonnegative(),
  medianDays: z.number().nullable(),
});
export type OnboardingTrackBreakdown = z.infer<
  typeof OnboardingTrackBreakdownSchema
>;

export const OnboardingClientBreakdownSchema = z.object({
  clientId: UuidSchema,
  clientName: z.string(),
  count: z.number().int().nonnegative(),
  medianDays: z.number().nullable(),
});
export type OnboardingClientBreakdown = z.infer<
  typeof OnboardingClientBreakdownSchema
>;

export const OnboardingMonthlyPointSchema = z.object({
  // YYYY-MM (UTC, inclusive of the whole month)
  month: z.string(),
  invited: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
});
export type OnboardingMonthlyPoint = z.infer<typeof OnboardingMonthlyPointSchema>;

export const OnboardingAnalyticsResponseSchema = z.object({
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
});
export type OnboardingAnalyticsResponse = z.infer<
  typeof OnboardingAnalyticsResponseSchema
>;

/* -------------------------------------------------------------------------- *
 *  Health
 * -------------------------------------------------------------------------- */

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  ts: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Auth
 * -------------------------------------------------------------------------- */

export const RoleSchema = z.enum([
  'EXECUTIVE_CHAIRMAN',
  'HR_ADMINISTRATOR',
  'OPERATIONS_MANAGER',
  'LIVE_ASN',
  'ASSOCIATE',
  'CLIENT_PORTAL',
  'FINANCE_ACCOUNTANT',
  'INTERNAL_RECRUITER',
  'MANAGER',
]);

export const UserStatusSchema = z.enum(['ACTIVE', 'DISABLED', 'INVITED']);

export const AuthUserSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  role: RoleSchema,
  status: UserStatusSchema,
  clientId: UuidSchema.nullable(),
  associateId: UuidSchema.nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  // Phase 39 — IANA timezone preference. Null means "use the browser's
  // locale" on the web side and "fall back to UTC" in email layout.
  timezone: z.string().nullable(),
  // Phase 47 — TOTP MFA. True iff the user has confirmed enrollment with
  // a valid 6-digit code. Drives the Settings card and (in a follow-up
  // PR) the login challenge step.
  mfaEnabled: z.boolean(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Discriminated on `mfaRequired` so the client can branch without hunting
 * through optional fields. The MFA path returns no user — completing
 * sign-in requires a follow-up POST /auth/mfa-challenge with a code.
 */
export const LoginSuccessResponseSchema = z.object({
  mfaRequired: z.literal(false).optional(),
  user: AuthUserSchema,
});
export type LoginSuccessResponse = z.infer<typeof LoginSuccessResponseSchema>;

export const LoginMfaRequiredResponseSchema = z.object({
  mfaRequired: z.literal(true),
});
export type LoginMfaRequiredResponse = z.infer<typeof LoginMfaRequiredResponseSchema>;

export const LoginResponseSchema = z.union([
  LoginSuccessResponseSchema,
  LoginMfaRequiredResponseSchema,
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Phase 32 — accept-invite returns the same shape as login PLUS a hint
 * for the client about where to send the freshly-activated user. For
 * new associates with an open onboarding application, this is their
 * checklist URL so they don't dead-end on the dashboard.
 */
export const AcceptInviteResponseSchema = z.object({
  user: AuthUserSchema,
  nextPath: z.string(),
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

export const MeResponseSchema = z.object({
  user: AuthUserSchema.nullable(),
});
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
export const HireableRoleSchema = z.enum(HIREABLE_ROLES);
export type HireableRole = z.infer<typeof HireableRoleSchema>;

export const ApplicationCreateInputSchema = z.object({
  associateEmail: z.string().email(),
  associateFirstName: z.string().min(1).max(80),
  associateLastName: z.string().min(1).max(80),
  clientId: UuidSchema,
  templateId: UuidSchema,
  position: z.string().min(1).max(120).optional(),
  startDate: z.string().datetime().optional(),
  employmentType: EmploymentTypeSchema.optional(),
  // Defaults to ASSOCIATE on the server when omitted. Set to a management
  // role to onboard a new manager / recruiter / accountant via the same
  // invite + checklist pipeline. Their User row is created with this role
  // so on first login they land in the correct sidebar / capability set.
  hireRole: HireableRoleSchema.optional(),
});
export type ApplicationCreateInput = z.infer<typeof ApplicationCreateInputSchema>;

/* ===== Phase 58 — bulk invite, bulk resend, nudge ====================== */

// One row in a bulk-invite batch. firstName/lastName fall back to email if HR
// pasted only addresses (parser will split on the local-part). The shared
// clientId/templateId/employmentType apply to every row in the batch.
export const BulkInviteApplicantSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  position: z.string().min(1).max(120).optional(),
  startDate: z.string().datetime().optional(),
});
export type BulkInviteApplicant = z.infer<typeof BulkInviteApplicantSchema>;

export const BulkInviteInputSchema = z.object({
  clientId: UuidSchema,
  templateId: UuidSchema,
  employmentType: EmploymentTypeSchema.optional(),
  applicants: z.array(BulkInviteApplicantSchema).min(1).max(200),
});
export type BulkInviteInput = z.infer<typeof BulkInviteInputSchema>;

// Per-applicant outcome — succeeded rows include an applicationId; failed
// rows include a stable error code + message so the UI can show why.
export const BulkInviteResultRowSchema = z.object({
  email: z.string().email(),
  ok: z.boolean(),
  applicationId: UuidSchema.nullable(),
  invitedUserId: UuidSchema.nullable(),
  inviteUrl: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type BulkInviteResultRow = z.infer<typeof BulkInviteResultRowSchema>;

export const BulkInviteResponseSchema = z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkInviteResultRowSchema),
});
export type BulkInviteResponse = z.infer<typeof BulkInviteResponseSchema>;

export const BulkResendInputSchema = z.object({
  applicationIds: z.array(UuidSchema).min(1).max(200),
});
export type BulkResendInput = z.infer<typeof BulkResendInputSchema>;

export const BulkResendResultRowSchema = z.object({
  applicationId: UuidSchema,
  ok: z.boolean(),
  invitedUserId: UuidSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type BulkResendResultRow = z.infer<typeof BulkResendResultRowSchema>;

export const BulkResendResponseSchema = z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkResendResultRowSchema),
});
export type BulkResendResponse = z.infer<typeof BulkResendResponseSchema>;

// HR-composed nudge email. Sent through the same Notification pipe as
// invites, but flagged with category = "onboarding.nudge" for filtering.
export const NudgeInputSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});
export type NudgeInput = z.infer<typeof NudgeInputSchema>;

export const NudgeResponseSchema = z.object({
  ok: z.literal(true),
  recipientEmail: z.string().email(),
  notificationId: UuidSchema,
  emailSent: z.boolean(),
});
export type NudgeResponse = z.infer<typeof NudgeResponseSchema>;

export const ProfileSubmissionSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  dob: z.string().datetime().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  zip: z.string().max(10).nullable().optional(),
});
export type ProfileSubmission = z.infer<typeof ProfileSubmissionSchema>;

export const W4FilingStatusSchema = z.enum([
  'SINGLE',
  'MARRIED_FILING_JOINTLY',
  'HEAD_OF_HOUSEHOLD',
]);

export const W4SubmissionInputSchema = z.object({
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
});
export type W4SubmissionInput = z.infer<typeof W4SubmissionInputSchema>;

export const DirectDepositInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('BANK_ACCOUNT'),
    routingNumber: z.string().regex(/^\d{9}$/, 'Routing number must be 9 digits'),
    accountNumber: z.string().regex(/^\d{4,17}$/, 'Account number must be 4–17 digits'),
    accountType: z.enum(['CHECKING', 'SAVINGS']),
  }),
  z.object({
    type: z.literal('BRANCH_CARD'),
    branchCardId: z.string().min(1).max(80),
  }),
]);
export type DirectDepositInput = z.infer<typeof DirectDepositInputSchema>;

export const PolicyAckInputSchema = z.object({
  policyId: UuidSchema,
});
export type PolicyAckInput = z.infer<typeof PolicyAckInputSchema>;

/* ===== Phase 63 — DOCUMENT_UPLOAD / BACKGROUND_CHECK / J1_DOCS ========= */

// Associate clicks "I'm done uploading" — server validates that at least
// one DocumentRecord exists for the associate in an ID-class kind, then
// marks the DOCUMENT_UPLOAD checklist task DONE. The actual file uploads
// go through the existing /documents/me/upload endpoint.
export const DocumentUploadCompleteResponseSchema = z.object({
  ok: z.literal(true),
  documentCount: z.number().int().nonnegative(),
});
export type DocumentUploadCompleteResponse = z.infer<
  typeof DocumentUploadCompleteResponseSchema
>;

// Associate authorizes the background check by typing their full legal
// name (acts as a wet-signature equivalent). Provider stays "stub" until
// Phase 64+ wires Checkr; status flips to PASSED immediately so the
// checklist can flow without a real third-party round-trip.
export const BackgroundCheckAuthorizeInputSchema = z.object({
  typedName: z.string().min(1).max(120),
  authorize: z.literal(true),
});
export type BackgroundCheckAuthorizeInput = z.infer<
  typeof BackgroundCheckAuthorizeInputSchema
>;

// Final marker: associate has filled out the J1 profile AND uploaded at
// least one J1_DS2019 / J1_VISA document. Server checks both before
// flipping the task DONE. The profile upsert itself reuses the existing
// J1UpsertInputSchema (Phase 10 compliance route) so HR + associate
// write the same shape.
export const J1DocsCompleteResponseSchema = z.object({
  ok: z.literal(true),
  hasProfile: z.boolean(),
  documentCount: z.number().int().nonnegative(),
});
export type J1DocsCompleteResponse = z.infer<typeof J1DocsCompleteResponseSchema>;

export const PolicyForApplicationSchema = z.object({
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
});
export type PolicyForApplication = z.infer<typeof PolicyForApplicationSchema>;

export const ApplicationPoliciesResponseSchema = z.object({
  policies: z.array(PolicyForApplicationSchema),
});
export type ApplicationPoliciesResponse = z.infer<typeof ApplicationPoliciesResponseSchema>;

export const AuditLogEntrySchema = z.object({
  id: UuidSchema,
  action: z.string(),
  actorUserId: UuidSchema.nullable(),
  actorEmail: z.string().email().nullable(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).nullable(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogListResponseSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 44 — QuickBooks Online integration (per-client OAuth + JE sync)
 * -------------------------------------------------------------------------- */

export const QboJeModeSchema = z.enum(['AGGREGATE', 'PER_EMPLOYEE']);
export type QboJeMode = z.infer<typeof QboJeModeSchema>;

export const QboStatusSchema = z.object({
  connected: z.boolean(),
  realmId: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  lastRefreshedAt: z.string().datetime().nullable(),
  // True when the integration is in stub mode (no Intuit creds configured).
  // The UI uses this to badge the connection card.
  stubMode: z.boolean(),
  // Account-ref configuration HR can fill in to map JE lines onto their
  // QBO chart-of-accounts. All seven default to null.
  accountSalariesExpense: z.string().nullable(),
  accountFederalTaxPayable: z.string().nullable(),
  accountStateTaxPayable: z.string().nullable(),
  accountFicaPayable: z.string().nullable(),
  accountMedicarePayable: z.string().nullable(),
  accountBenefitsPayable: z.string().nullable(),
  accountNetPayPayable: z.string().nullable(),
  // Wave 5.2 — JE granularity. AGGREGATE = one JE per run (default);
  // PER_EMPLOYEE = one JE per associate, with EmployeeRef.
  jeMode: QboJeModeSchema,
});
export type QboStatus = z.infer<typeof QboStatusSchema>;

export const QboAuthorizeStartResponseSchema = z.object({
  authorizeUrl: z.string().url(),
  state: z.string(),
});
export type QboAuthorizeStartResponse = z.infer<typeof QboAuthorizeStartResponseSchema>;

export const QboAccountConfigInputSchema = z.object({
  accountSalariesExpense: z.string().trim().min(1).max(64).nullable().optional(),
  accountFederalTaxPayable: z.string().trim().min(1).max(64).nullable().optional(),
  accountStateTaxPayable: z.string().trim().min(1).max(64).nullable().optional(),
  accountFicaPayable: z.string().trim().min(1).max(64).nullable().optional(),
  accountMedicarePayable: z.string().trim().min(1).max(64).nullable().optional(),
  accountBenefitsPayable: z.string().trim().min(1).max(64).nullable().optional(),
  accountNetPayPayable: z.string().trim().min(1).max(64).nullable().optional(),
  // Wave 5.2 — when omitted, jeMode is left unchanged.
  jeMode: QboJeModeSchema.optional(),
});
export type QboAccountConfigInput = z.infer<typeof QboAccountConfigInputSchema>;

export const QboSyncResponseSchema = z.object({
  journalEntryId: z.string(),
  syncedAt: z.string().datetime(),
});
export type QboSyncResponse = z.infer<typeof QboSyncResponseSchema>;

// Wave 3.1 — Chart-of-accounts discovery
export const QboAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  classification: z.string(),
  accountType: z.string(),
  isSubAccount: z.boolean(),
});
export type QboAccount = z.infer<typeof QboAccountSchema>;

export const QboAccountListResponseSchema = z.object({
  accounts: z.array(QboAccountSchema),
});
export type QboAccountListResponse = z.infer<typeof QboAccountListResponseSchema>;

// Wave 3.2 — Batch associate sync
export const QboSyncAssociatesResponseSchema = z.object({
  scanned: z.number().int().nonnegative(),
  synced: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      associateId: UuidSchema,
      name: z.string(),
      reason: z.string(),
    })
  ),
});
export type QboSyncAssociatesResponse = z.infer<typeof QboSyncAssociatesResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 43 — Time-off entitlements (annual lump-sum + carryover cap)
 * -------------------------------------------------------------------------- */

export const TimeOffEntitlementSchema = z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  category: z.enum(['SICK', 'VACATION', 'PTO', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER']),
  annualMinutes: z.number().int().nonnegative(),
  carryoverMaxMinutes: z.number().int().nonnegative(),
  policyAnchorMonth: z.number().int().min(1).max(12),
  policyAnchorDay: z.number().int().min(1).max(31),
  lastGrantedAt: z.string().datetime().nullable(),
});
export type TimeOffEntitlement = z.infer<typeof TimeOffEntitlementSchema>;

export const TimeOffEntitlementListResponseSchema = z.object({
  entitlements: z.array(TimeOffEntitlementSchema),
});
export type TimeOffEntitlementListResponse = z.infer<typeof TimeOffEntitlementListResponseSchema>;

export const TimeOffEntitlementUpsertInputSchema = z.object({
  associateId: UuidSchema,
  category: z.enum(['SICK', 'VACATION', 'PTO', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER']),
  annualMinutes: z.number().int().nonnegative(),
  carryoverMaxMinutes: z.number().int().nonnegative(),
  policyAnchorMonth: z.number().int().min(1).max(12).default(1),
  policyAnchorDay: z.number().int().min(1).max(31).default(1),
});
export type TimeOffEntitlementUpsertInput = z.infer<typeof TimeOffEntitlementUpsertInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 42 — Benefits enrollment
 * -------------------------------------------------------------------------- */

export const BenefitsPlanKindSchema = z.enum([
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
]);
export type BenefitsPlanKind = z.infer<typeof BenefitsPlanKindSchema>;

export const BenefitsPlanSchema = z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  kind: BenefitsPlanKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  employerContributionCentsPerPeriod: z.number().int().nonnegative(),
  employeeContributionDefaultCentsPerPeriod: z.number().int().nonnegative(),
  isActive: z.boolean(),
});
export type BenefitsPlan = z.infer<typeof BenefitsPlanSchema>;

export const BenefitsPlanListResponseSchema = z.object({
  plans: z.array(BenefitsPlanSchema),
});
export type BenefitsPlanListResponse = z.infer<typeof BenefitsPlanListResponseSchema>;

export const BenefitsPlanCreateInputSchema = z.object({
  clientId: UuidSchema,
  kind: BenefitsPlanKindSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  employerContributionCentsPerPeriod: z.number().int().nonnegative().default(0),
  employeeContributionDefaultCentsPerPeriod: z.number().int().nonnegative().default(0),
});
export type BenefitsPlanCreateInput = z.infer<typeof BenefitsPlanCreateInputSchema>;

export const BenefitsPlanUpdateInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  employerContributionCentsPerPeriod: z.number().int().nonnegative().optional(),
  employeeContributionDefaultCentsPerPeriod: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
});
export type BenefitsPlanUpdateInput = z.infer<typeof BenefitsPlanUpdateInputSchema>;

export const BenefitsEnrollmentSchema = z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  planId: UuidSchema,
  electedAmountCentsPerPeriod: z.number().int().nonnegative(),
  effectiveDate: z.string().datetime(),
  terminationDate: z.string().datetime().nullable(),
  // Joined plan summary so the UI can render without a second fetch.
  planKind: BenefitsPlanKindSchema,
  planName: z.string(),
});
export type BenefitsEnrollment = z.infer<typeof BenefitsEnrollmentSchema>;

export const BenefitsEnrollmentListResponseSchema = z.object({
  enrollments: z.array(BenefitsEnrollmentSchema),
});
export type BenefitsEnrollmentListResponse = z.infer<typeof BenefitsEnrollmentListResponseSchema>;

export const BenefitsEnrollInputSchema = z.object({
  planId: UuidSchema,
  electedAmountCentsPerPeriod: z.number().int().nonnegative(),
  effectiveDate: z.string().datetime(),
});
export type BenefitsEnrollInput = z.infer<typeof BenefitsEnrollInputSchema>;

export const BenefitsTerminateInputSchema = z.object({
  terminationDate: z.string().datetime(),
});
export type BenefitsTerminateInput = z.infer<typeof BenefitsTerminateInputSchema>;

/* ----- Phase 40 — global audit search (with entity context) ------------ */

export const AuditSearchEntrySchema = z.object({
  id: UuidSchema,
  action: z.string(),
  actorUserId: UuidSchema.nullable(),
  actorEmail: z.string().email().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  clientId: UuidSchema.nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type AuditSearchEntry = z.infer<typeof AuditSearchEntrySchema>;

export const AuditSearchResponseSchema = z.object({
  entries: z.array(AuditSearchEntrySchema),
  /** Cursor — pass back via `before` to fetch the next page. Null = end. */
  nextBefore: z.string().datetime().nullable(),
});
export type AuditSearchResponse = z.infer<typeof AuditSearchResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Time & Attendance — Phase 6
 * -------------------------------------------------------------------------- */

export const TimeEntryStatusSchema = z.enum([
  'ACTIVE',
  'COMPLETED',
  'APPROVED',
  'REJECTED',
]);
export type TimeEntryStatus = z.infer<typeof TimeEntryStatusSchema>;

export const TimeEntrySchema = z.object({
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
});
export type TimeEntry = z.infer<typeof TimeEntrySchema>;

export const TimeEntryListResponseSchema = z.object({
  entries: z.array(TimeEntrySchema),
});
export type TimeEntryListResponse = z.infer<typeof TimeEntryListResponseSchema>;

export const ClockInInputSchema = z.object({
  notes: z.string().max(500).optional(),
});
export type ClockInInput = z.infer<typeof ClockInInputSchema>;

export const ClockOutInputSchema = z.object({
  notes: z.string().max(500).optional(),
});
export type ClockOutInput = z.infer<typeof ClockOutInputSchema>;

export const TimeApproveInputSchema = z.object({
  /** Optional override of clockInAt/clockOutAt during approval (e.g., HR fixes a forgotten clock-out). */
  clockInAt: z.string().datetime().optional(),
  clockOutAt: z.string().datetime().optional(),
});
export type TimeApproveInput = z.infer<typeof TimeApproveInputSchema>;

export const TimeRejectInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type TimeRejectInput = z.infer<typeof TimeRejectInputSchema>;

export const ActiveTimeEntryResponseSchema = z.object({
  active: TimeEntrySchema.nullable(),
});
export type ActiveTimeEntryResponse = z.infer<typeof ActiveTimeEntryResponseSchema>;

/* ===== Phase 64 — bulk approve/reject for time entries ================= */

export const BulkTimeApproveInputSchema = z.object({
  entryIds: z.array(UuidSchema).min(1).max(200),
});
export type BulkTimeApproveInput = z.infer<typeof BulkTimeApproveInputSchema>;

export const BulkTimeRejectInputSchema = z.object({
  entryIds: z.array(UuidSchema).min(1).max(200),
  reason: z.string().min(1).max(500),
});
export type BulkTimeRejectInput = z.infer<typeof BulkTimeRejectInputSchema>;

export const BulkTimeResultRowSchema = z.object({
  entryId: UuidSchema,
  ok: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type BulkTimeResultRow = z.infer<typeof BulkTimeResultRowSchema>;

export const BulkTimeResponseSchema = z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkTimeResultRowSchema),
});
export type BulkTimeResponse = z.infer<typeof BulkTimeResponseSchema>;

/* Phase 65 — time entry exports (CSV + PDF) ================================ */
// Mirrors ScheduleExportInputSchema. `to` is end-EXCLUSIVE so the same range
// helpers can be reused on the front end.

export const TimeExportInputSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  status: TimeEntryStatusSchema.optional(),
  clientId: UuidSchema.optional(),
  associateId: UuidSchema.optional(),
});
export type TimeExportInput = z.infer<typeof TimeExportInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Scheduling — Phase 7
 * -------------------------------------------------------------------------- */

export const ShiftStatusSchema = z.enum([
  'DRAFT',
  'OPEN',
  'ASSIGNED',
  'COMPLETED',
  'CANCELLED',
]);
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>;

export const ShiftSchema = z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  clientName: z.string().nullable(),
  position: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  location: z.string().nullable(),
  hourlyRate: z.number().nullable(),
  /** Cost-side rate (associate is paid this) — drives projected labor cost. */
  payRate: z.number().nullable(),
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
});
export type Shift = z.infer<typeof ShiftSchema>;

export const ShiftListResponseSchema = z.object({
  shifts: z.array(ShiftSchema),
});
export type ShiftListResponse = z.infer<typeof ShiftListResponseSchema>;

export const ShiftCreateInputSchema = z
  .object({
    clientId: UuidSchema,
    position: z.string().min(1).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
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
  });
export type ShiftCreateInput = z.infer<typeof ShiftCreateInputSchema>;

export const ShiftUpdateInputSchema = z
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
  })
  .refine(
    (v) =>
      v.startsAt === undefined ||
      v.endsAt === undefined ||
      new Date(v.endsAt) > new Date(v.startsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] }
  );
export type ShiftUpdateInput = z.infer<typeof ShiftUpdateInputSchema>;

export const ShiftAssignInputSchema = z.object({
  associateId: UuidSchema,
});
export type ShiftAssignInput = z.infer<typeof ShiftAssignInputSchema>;

export const ShiftCancelInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type ShiftCancelInput = z.infer<typeof ShiftCancelInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 51 — shift templates + copy-week
 * -------------------------------------------------------------------------- */

export const ShiftTemplateSchema = z.object({
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
});
export type ShiftTemplate = z.infer<typeof ShiftTemplateSchema>;

export const ShiftTemplateListResponseSchema = z.object({
  templates: z.array(ShiftTemplateSchema),
});
export type ShiftTemplateListResponse = z.infer<typeof ShiftTemplateListResponseSchema>;

export const ShiftTemplateCreateInputSchema = z.object({
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
});
export type ShiftTemplateCreateInput = z.infer<typeof ShiftTemplateCreateInputSchema>;

export const ShiftTemplateApplyInputSchema = z.object({
  /** ISO date that anchors the target week — server snaps to local Sunday. */
  weekStart: z.string().datetime(),
  /** Override the template's clientId (required if template is global). */
  clientId: UuidSchema.optional(),
});
export type ShiftTemplateApplyInput = z.infer<typeof ShiftTemplateApplyInputSchema>;

export const CopyWeekInputSchema = z.object({
  /** ISO timestamp; server snaps to the local Sunday at 00:00. */
  sourceWeekStart: z.string().datetime(),
  targetWeekStart: z.string().datetime(),
  /** When set, only shifts for this client are copied. */
  clientId: UuidSchema.optional(),
});
export type CopyWeekInput = z.infer<typeof CopyWeekInputSchema>;

export const CopyWeekResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type CopyWeekResponse = z.infer<typeof CopyWeekResponseSchema>;

/* Phase 53 — pivot week view + publish-week ===============================
 * Slim associate list for the row-axis of the people-x-days grid; and a
 * batch-publish endpoint so HR can flip a whole week of DRAFT shifts to
 * OPEN/ASSIGNED in one click.
 */

export const AssociateLiteSchema = z.object({
  id: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
});
export type AssociateLite = z.infer<typeof AssociateLiteSchema>;

export const AssociateListResponseSchema = z.object({
  associates: z.array(AssociateLiteSchema),
});
export type AssociateListResponse = z.infer<typeof AssociateListResponseSchema>;

export const PublishWeekInputSchema = z.object({
  /** ISO; server snaps to local Monday 00:00 of that week. */
  weekStart: z.string().datetime(),
  /** When set, only DRAFT shifts for this client are published. */
  clientId: UuidSchema.optional(),
});
export type PublishWeekInput = z.infer<typeof PublishWeekInputSchema>;

export const PublishWeekSkipReasonSchema = z.enum([
  'predictive_schedule_violation',
]);
export type PublishWeekSkipReason = z.infer<typeof PublishWeekSkipReasonSchema>;

export const PublishWeekSkipSchema = z.object({
  shiftId: UuidSchema,
  reason: PublishWeekSkipReasonSchema,
  detail: z.string().nullable(),
});
export type PublishWeekSkip = z.infer<typeof PublishWeekSkipSchema>;

export const PublishWeekResponseSchema = z.object({
  published: z.number().int().nonnegative(),
  skipped: z.array(PublishWeekSkipSchema),
});
export type PublishWeekResponse = z.infer<typeof PublishWeekResponseSchema>;

/* Auto-schedule the week ================================================== */

export const AutoScheduleWeekInputSchema = z.object({
  /** ISO; server snaps to local Monday 00:00 of that week. */
  weekStart: z.string().datetime(),
  /** When set, only fills OPEN shifts for this client. */
  clientId: UuidSchema.optional(),
});
export type AutoScheduleWeekInput = z.infer<typeof AutoScheduleWeekInputSchema>;

export const AutoScheduleSkipReasonSchema = z.enum([
  /** Every associate either had a hard conflict, was on PTO, or was unscored. */
  'no_eligible_candidate',
  /** Top candidate would already exceed 40h with no slack — manager review needed. */
  'all_candidates_overtime',
]);
export type AutoScheduleSkipReason = z.infer<typeof AutoScheduleSkipReasonSchema>;

export const AutoScheduleSkipSchema = z.object({
  shiftId: UuidSchema,
  reason: AutoScheduleSkipReasonSchema,
  detail: z.string().nullable(),
});
export type AutoScheduleSkip = z.infer<typeof AutoScheduleSkipSchema>;

export const AutoScheduleWeekResponseSchema = z.object({
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
});
export type AutoScheduleWeekResponse = z.infer<typeof AutoScheduleWeekResponseSchema>;

/* iCal feed URL for the signed-in associate */

export const CalendarFeedUrlResponseSchema = z.object({
  /** Absolute URL the user can paste into Google/Apple/Outlook to subscribe. */
  url: z.string().url(),
  /** webcal:// variant — Apple Calendar handles this directly via system handler. */
  webcalUrl: z.string(),
});
export type CalendarFeedUrlResponse = z.infer<typeof CalendarFeedUrlResponseSchema>;

/* Phase 54.4 — schedule PDF export ======================================== */

export const ScheduleExportInputSchema = z.object({
  /** ISO timestamp; the server treats this as the inclusive start of the range. */
  from: z.string().datetime(),
  /** ISO timestamp; the server treats this as the EXCLUSIVE end of the range. */
  to: z.string().datetime(),
  clientId: UuidSchema.optional(),
});
export type ScheduleExportInput = z.infer<typeof ScheduleExportInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Payroll — Phase 8 (MVP, demo-only withholding; disbursement stubbed)
 * -------------------------------------------------------------------------- */

export const PayrollRunStatusSchema = z.enum([
  'DRAFT',
  'FINALIZED',
  'DISBURSED',
  'CANCELLED',
]);
export type PayrollRunStatus = z.infer<typeof PayrollRunStatusSchema>;

export const PayrollItemStatusSchema = z.enum([
  'PENDING',
  'DISBURSED',
  'FAILED',
  'HELD',
]);
export type PayrollItemStatus = z.infer<typeof PayrollItemStatusSchema>;

// Wave 1.2 — earning kinds. Mirrors PayrollEarningKind in schema.prisma.
export const PayrollEarningKindSchema = z.enum([
  'REGULAR',
  'OVERTIME',
  'DOUBLE_TIME',
  'HOLIDAY',
  'SICK',
  'VACATION',
  'BONUS',
  'COMMISSION',
  'TIPS',
  'REIMBURSEMENT',
]);
export type PayrollEarningKind = z.infer<typeof PayrollEarningKindSchema>;

export const PayrollItemEarningSchema = z.object({
  id: UuidSchema,
  kind: PayrollEarningKindSchema,
  hours: z.number().nullable(),
  rate: z.number().nullable(),
  amount: z.number(),
  isTaxable: z.boolean(),
  notes: z.string().nullable(),
});
export type PayrollItemEarning = z.infer<typeof PayrollItemEarningSchema>;

export const PayrollItemSchema = z.object({
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
  // Wave 4.2 — post-tax deductions (garnishments etc.) taken this period.
  // Subtracted from net AFTER taxes; does not affect taxable wages.
  postTaxDeductions: z.number().nonnegative(),
  status: PayrollItemStatusSchema,
  disbursementRef: z.string().nullable(),
  disbursedAt: z.string().datetime().nullable(),
  failureReason: z.string().nullable(),
  // Wave 1.2 — per-kind breakdown that sums to grossPay.
  earnings: z.array(PayrollItemEarningSchema),
});
export type PayrollItem = z.infer<typeof PayrollItemSchema>;

export const PayrollRunSummarySchema = z.object({
  id: UuidSchema,
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
  // Phase 44 — QuickBooks Online sync state.
  qboJournalEntryId: z.string().nullable(),
  qboSyncedAt: z.string().datetime().nullable(),
  qboSyncError: z.string().nullable(),
});
export type PayrollRunSummary = z.infer<typeof PayrollRunSummarySchema>;

export const PayrollRunListResponseSchema = z.object({
  runs: z.array(PayrollRunSummarySchema),
});
export type PayrollRunListResponse = z.infer<typeof PayrollRunListResponseSchema>;

export const PayrollRunDetailSchema = PayrollRunSummarySchema.extend({
  items: z.array(PayrollItemSchema),
});
export type PayrollRunDetail = z.infer<typeof PayrollRunDetailSchema>;

export const PayrollRunCreateInputSchema = z
  .object({
    clientId: UuidSchema.nullable().optional(),
    /** YYYY-MM-DD inclusive. */
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD'),
    /** YYYY-MM-DD inclusive. */
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
    /** Default hourly rate when an associate's shifts in the period have none. */
    defaultHourlyRate: z.number().nonnegative().optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  });
export type PayrollRunCreateInput = z.infer<typeof PayrollRunCreateInputSchema>;

// Wave 6.2 — Run preview. Same input shape as create (notes is irrelevant
// but accepted so the wizard can pass the same payload). Output is a
// projected per-associate breakdown with no DB rows touched.
export const PayrollRunPreviewItemSchema = z.object({
  associateId: UuidSchema,
  associateName: z.string(),
  hoursWorked: z.number().nonnegative(),
  hourlyRate: z.number().nonnegative(),
  regularHours: z.number().nonnegative(),
  overtimeHours: z.number().nonnegative(),
  grossPay: z.number().nonnegative(),
  preTaxDeductions: z.number().nonnegative(),
  federalIncomeTax: z.number().nonnegative(),
  fica: z.number().nonnegative(),
  medicare: z.number().nonnegative(),
  stateIncomeTax: z.number().nonnegative(),
  taxState: z.string().nullable(),
  payFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY']),
  disposableEarnings: z.number().nonnegative(),
  postTaxDeductions: z.number().nonnegative(),
  netPay: z.number(),
  employerFica: z.number().nonnegative(),
  employerMedicare: z.number().nonnegative(),
  employerFuta: z.number().nonnegative(),
  employerSuta: z.number().nonnegative(),
  ytdWages: z.number().nonnegative(),
});
export type PayrollRunPreviewItem = z.infer<typeof PayrollRunPreviewItemSchema>;

export const PayrollRunPreviewResponseSchema = z.object({
  items: z.array(PayrollRunPreviewItemSchema),
  totals: z.object({
    totalGross: z.number().nonnegative(),
    totalEmployeeTax: z.number().nonnegative(),
    totalNet: z.number(),
    totalEmployerTax: z.number().nonnegative(),
    totalGarnishments: z.number().nonnegative(),
    itemCount: z.number().int().nonnegative(),
  }),
});
export type PayrollRunPreviewResponse = z.infer<typeof PayrollRunPreviewResponseSchema>;

export const PayrollItemListResponseSchema = z.object({
  items: z.array(PayrollItemSchema),
});
export type PayrollItemListResponse = z.infer<typeof PayrollItemListResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Wave 1.1 — Pay schedules (QuickBooks Online Payroll parity)
 * -------------------------------------------------------------------------- */

export const PayrollFrequencySchema = z.enum([
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
  'MONTHLY',
]);
export type PayrollFrequency = z.infer<typeof PayrollFrequencySchema>;

export const PayrollScheduleSchema = z.object({
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
});
export type PayrollSchedule = z.infer<typeof PayrollScheduleSchema>;

export const PayrollScheduleListResponseSchema = z.object({
  schedules: z.array(PayrollScheduleSchema),
});
export type PayrollScheduleListResponse = z.infer<typeof PayrollScheduleListResponseSchema>;

export const PayrollScheduleCreateInputSchema = z.object({
  clientId: UuidSchema.nullable().optional(),
  name: z.string().min(1).max(120),
  frequency: PayrollFrequencySchema,
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payDateOffsetDays: z.number().int().min(0).max(31).optional(),
  notes: z.string().max(1000).optional(),
});
export type PayrollScheduleCreateInput = z.infer<typeof PayrollScheduleCreateInputSchema>;

export const PayrollScheduleUpdateInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  frequency: PayrollFrequencySchema.optional(),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payDateOffsetDays: z.number().int().min(0).max(31).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type PayrollScheduleUpdateInput = z.infer<typeof PayrollScheduleUpdateInputSchema>;

export const PayrollScheduleAssignInputSchema = z.object({
  associateIds: z.array(UuidSchema).min(1).max(500),
});
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
export const PayrollExceptionKindSchema = z.enum([
  'MISSING_W4',          // BLOCKING — W2 employee with no W-4 submission
  'MISSING_BANK_ACCOUNT',// WARNING  — no primary payout method on file
  'TERMINATED_IN_RUN',   // WARNING  — terminated <= periodEnd but has hours
  'OT_SPIKE',            // INFO     — > 20 OT hours in this period
  'UNSUPPORTED_STATE',   // INFO     — state has no real SIT table; using fallback
]);
export type PayrollExceptionKind = z.infer<typeof PayrollExceptionKindSchema>;

export const PayrollExceptionSeveritySchema = z.enum(['BLOCKING', 'WARNING', 'INFO']);
export type PayrollExceptionSeverity = z.infer<typeof PayrollExceptionSeveritySchema>;

export const PayrollExceptionSchema = z.object({
  associateId: UuidSchema,
  associateName: z.string(),
  kind: PayrollExceptionKindSchema,
  severity: PayrollExceptionSeveritySchema,
  /** Short human-readable summary for the UI. */
  message: z.string(),
  /** Optional structured detail (e.g. terminationDate, otHours). */
  detail: z.record(z.unknown()).optional(),
});
export type PayrollException = z.infer<typeof PayrollExceptionSchema>;

export const PayrollExceptionsResponseSchema = z.object({
  exceptions: z.array(PayrollExceptionSchema),
  /** Counts per severity — handy for the landing page chip. */
  counts: z.object({
    blocking: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
});
export type PayrollExceptionsResponse = z.infer<typeof PayrollExceptionsResponseSchema>;

export const PayrollExceptionsInputSchema = z.object({
  clientId: UuidSchema.nullable().optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type PayrollExceptionsInput = z.infer<typeof PayrollExceptionsInputSchema>;

/**
 * Payroll-home summary. The hero card on AdminPayrollView shows the
 * soonest schedule's projected run plus a snapshot of the most recent run
 * the user can see. `nextRun` is null when no schedule is configured.
 */
export const PayrollUpcomingSummarySchema = z.object({
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
  lastRun: z
    .object({
      id: UuidSchema,
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum(['DRAFT', 'FINALIZED', 'DISBURSED', 'CANCELLED']),
      itemCount: z.number().int().nonnegative(),
      totalNet: z.number(),
      finalizedAt: z.string().datetime().nullable(),
      disbursedAt: z.string().datetime().nullable(),
    })
    .nullable(),
});
export type PayrollUpcomingSummary = z.infer<typeof PayrollUpcomingSummarySchema>;

/* -------------------------------------------------------------------------- *
 *  Documents — Phase 9 (local-fs storage; S3 swap is future work)
 * -------------------------------------------------------------------------- */

export const DocumentKindSchema = z.enum([
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
  'OTHER',
]);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const DocumentStatusSchema = z.enum([
  'UPLOADED',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentRecordSchema = z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string().nullable(),
  clientId: UuidSchema.nullable(),
  kind: DocumentKindSchema,
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
});
export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;

export const DocumentListResponseSchema = z.object({
  documents: z.array(DocumentRecordSchema),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const DocumentRejectInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type DocumentRejectInput = z.infer<typeof DocumentRejectInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Compliance — Phase 10 (I-9, Background, J-1)
 * -------------------------------------------------------------------------- */

export const I9DocumentListSchema = z.enum(['LIST_A', 'LIST_B_AND_C']);
export type I9DocumentList = z.infer<typeof I9DocumentListSchema>;

export const I9VerificationSchema = z.object({
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
});
export type I9Verification = z.infer<typeof I9VerificationSchema>;

export const I9ListResponseSchema = z.object({
  i9s: z.array(I9VerificationSchema),
});
export type I9ListResponse = z.infer<typeof I9ListResponseSchema>;

export const I9UpsertInputSchema = z
  .object({
    section1CompletedAt: z.string().datetime().nullable().optional(),
    section2CompletedAt: z.string().datetime().nullable().optional(),
    documentList: I9DocumentListSchema.nullable().optional(),
    supportingDocIds: z.array(UuidSchema).optional(),
  })
  .refine(
    (v) =>
      // Recording section 2 requires the document list — Form I-9 itself
      // requires the verifier to record which list of docs they inspected.
      !v.section2CompletedAt || (v.documentList !== undefined && v.documentList !== null),
    { message: 'documentList is required when recording section 2', path: ['documentList'] }
  );
export type I9UpsertInput = z.infer<typeof I9UpsertInputSchema>;

export const BgCheckStatusSchema = z.enum([
  'INITIATED',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'NEEDS_REVIEW',
]);
export type BgCheckStatus = z.infer<typeof BgCheckStatusSchema>;

export const BackgroundCheckSchema = z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  clientId: UuidSchema.nullable(),
  provider: z.string(),
  externalId: z.string().nullable(),
  status: BgCheckStatusSchema,
  initiatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type BackgroundCheck = z.infer<typeof BackgroundCheckSchema>;

export const BackgroundCheckListResponseSchema = z.object({
  checks: z.array(BackgroundCheckSchema),
});
export type BackgroundCheckListResponse = z.infer<typeof BackgroundCheckListResponseSchema>;

export const BackgroundInitiateInputSchema = z.object({
  associateId: UuidSchema,
  provider: z.string().min(1).max(80).default('alto-stub'),
});
export type BackgroundInitiateInput = z.infer<typeof BackgroundInitiateInputSchema>;

export const BackgroundUpdateInputSchema = z.object({
  status: BgCheckStatusSchema,
  externalId: z.string().max(120).optional(),
});
export type BackgroundUpdateInput = z.infer<typeof BackgroundUpdateInputSchema>;

export const J1ProfileSchema = z.object({
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
});
export type J1Profile = z.infer<typeof J1ProfileSchema>;

export const J1ListResponseSchema = z.object({
  profiles: z.array(J1ProfileSchema),
});
export type J1ListResponse = z.infer<typeof J1ListResponseSchema>;

export const J1UpsertInputSchema = z
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
  });
export type J1UpsertInput = z.infer<typeof J1UpsertInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Analytics — Phase 11
 * -------------------------------------------------------------------------- */

export const DashboardKPIsSchema = z.object({
  activeAssociates: z.number().int().nonnegative(),
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
});
export type DashboardKPIs = z.infer<typeof DashboardKPIsSchema>;

/* -------------------------------------------------------------------------- *
 *  Communications — Phase 12 (stubbed providers; queue-based)
 * -------------------------------------------------------------------------- */

export const NotificationChannelSchema = z.enum(['SMS', 'PUSH', 'EMAIL', 'IN_APP']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationStatusSchema = z.enum(['QUEUED', 'SENT', 'FAILED', 'READ']);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

export const NotificationSchema = z.object({
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
  failureReason: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  senderUserId: UuidSchema.nullable(),
  senderEmail: z.string().email().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const NotificationSendInputSchema = z
  .object({
    channel: NotificationChannelSchema,
    recipientUserId: UuidSchema.optional(),
    recipientPhone: z.string().min(5).max(20).optional(),
    recipientEmail: z.string().email().optional(),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(4000),
    category: z.string().min(1).max(80).optional(),
  })
  .refine(
    (v) => v.recipientUserId || v.recipientPhone || v.recipientEmail,
    { message: 'one of recipientUserId / recipientPhone / recipientEmail is required' }
  )
  .refine(
    (v) => v.channel !== 'IN_APP' || !!v.recipientUserId,
    { message: 'IN_APP notifications require recipientUserId', path: ['channel'] }
  )
  .refine(
    (v) => v.channel !== 'SMS' || !!v.recipientPhone || !!v.recipientUserId,
    { message: 'SMS requires recipientPhone or recipientUserId', path: ['channel'] }
  );
export type NotificationSendInput = z.infer<typeof NotificationSendInputSchema>;

export const NotificationBroadcastInputSchema = z.object({
  channel: NotificationChannelSchema.exclude(['SMS']),
  audience: z.enum(['ALL_ASSOCIATES', 'ALL_HR']),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(4000),
  category: z.string().min(1).max(80).optional(),
});
export type NotificationBroadcastInput = z.infer<typeof NotificationBroadcastInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Performance — Phase 13
 * -------------------------------------------------------------------------- */

export const PerformanceReviewStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'ACKNOWLEDGED',
]);
export type PerformanceReviewStatus = z.infer<typeof PerformanceReviewStatusSchema>;

export const PerformanceReviewSchema = z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  associateName: z.string(),
  reviewerUserId: UuidSchema.nullable(),
  reviewerEmail: z.string().email().nullable(),
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
});
export type PerformanceReview = z.infer<typeof PerformanceReviewSchema>;

export const PerformanceReviewListResponseSchema = z.object({
  reviews: z.array(PerformanceReviewSchema),
});
export type PerformanceReviewListResponse = z.infer<typeof PerformanceReviewListResponseSchema>;

export const PerformanceReviewCreateInputSchema = z
  .object({
    associateId: UuidSchema,
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    overallRating: z.number().int().min(1).max(5),
    summary: z.string().min(1).max(4000),
    strengths: z.string().max(2000).optional(),
    improvements: z.string().max(2000).optional(),
    goals: z.string().max(2000).optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  });
export type PerformanceReviewCreateInput = z.infer<typeof PerformanceReviewCreateInputSchema>;

export const PerformanceReviewUpdateInputSchema = z.object({
  overallRating: z.number().int().min(1).max(5).optional(),
  summary: z.string().min(1).max(4000).optional(),
  strengths: z.string().max(2000).nullable().optional(),
  improvements: z.string().max(2000).nullable().optional(),
  goals: z.string().max(2000).nullable().optional(),
});
export type PerformanceReviewUpdateInput = z.infer<typeof PerformanceReviewUpdateInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Recruiting — Phase 14
 * -------------------------------------------------------------------------- */

export const CandidateStageSchema = z.enum([
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
]);
export type CandidateStage = z.infer<typeof CandidateStageSchema>;

export const CandidateSchema = z.object({
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
  createdAt: z.string().datetime(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidateListResponseSchema = z.object({
  candidates: z.array(CandidateSchema),
});
export type CandidateListResponse = z.infer<typeof CandidateListResponseSchema>;

export const CandidateCreateInputSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  position: z.string().max(120).optional(),
  source: z.string().max(80).optional(),
  notes: z.string().max(2000).optional(),
  resumeUrl: z.string().url().max(2000).optional(),
  linkedinUrl: z.string().url().max(2000).optional(),
});
export type CandidateCreateInput = z.infer<typeof CandidateCreateInputSchema>;

// Public careers-site application body. A superset of the recruiter-facing
// CandidateCreateInputSchema with two extras:
//  - `website` is a honeypot — bots fill every visible-looking field, so a
//    non-empty value lets us 200-OK the request without persisting.
//  - `source` defaults to "CAREERS_PAGE" server-side; sites can override
//    (e.g. "indeed-redirect") to track funnels.
export const CareersApplyInputSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(40).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  resumeUrl: z.string().url().max(2000).optional().nullable(),
  linkedinUrl: z.string().url().max(2000).optional().nullable(),
  source: z.string().max(80).optional().nullable(),
  // Honeypot: must be empty/missing for legitimate submissions.
  website: z.string().max(500).optional().nullable(),
});
export type CareersApplyInput = z.infer<typeof CareersApplyInputSchema>;

export const CandidateUpdateInputSchema = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  phone: z.string().max(40).nullable().optional(),
  position: z.string().max(120).nullable().optional(),
  source: z.string().max(80).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type CandidateUpdateInput = z.infer<typeof CandidateUpdateInputSchema>;

export const CandidateAdvanceInputSchema = z
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
  );
export type CandidateAdvanceInput = z.infer<typeof CandidateAdvanceInputSchema>;

export const CandidateHireInputSchema = z.object({
  /** Optional clientId to associate the new hire with via an Application. */
  clientId: UuidSchema.optional(),
  templateId: UuidSchema.optional(),
});
export type CandidateHireInput = z.infer<typeof CandidateHireInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 15 — Time / Scheduling depth (Rippling-grade)
 * -------------------------------------------------------------------------- */

export const TimeAnomalySchema = z.enum([
  'GEOFENCE_VIOLATION_IN',
  'GEOFENCE_VIOLATION_OUT',
  'NO_BREAK',
  'MEAL_BREAK_TOO_SHORT',
  'OVERTIME_UNAPPROVED',
  'FORGOT_CLOCKOUT',
  'OUTSIDE_SHIFT_WINDOW',
]);
export type TimeAnomaly = z.infer<typeof TimeAnomalySchema>;

export const BreakTypeSchema = z.enum(['MEAL', 'REST']);
export type BreakType = z.infer<typeof BreakTypeSchema>;

export const BreakEntrySchema = z.object({
  id: UuidSchema,
  timeEntryId: UuidSchema,
  type: BreakTypeSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  minutes: z.number().int().nonnegative(),
});
export type BreakEntry = z.infer<typeof BreakEntrySchema>;

export const JobSchema = z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  clientName: z.string().nullable(),
  name: z.string(),
  billRate: z.number().nullable(),
  payRate: z.number().nullable(),
  isActive: z.boolean(),
});
export type Job = z.infer<typeof JobSchema>;

export const JobListResponseSchema = z.object({
  jobs: z.array(JobSchema),
});
export type JobListResponse = z.infer<typeof JobListResponseSchema>;

export const JobCreateInputSchema = z.object({
  clientId: UuidSchema,
  name: z.string().min(1).max(120),
  billRate: z.number().nonnegative().optional(),
  payRate: z.number().nonnegative().optional(),
});
export type JobCreateInput = z.infer<typeof JobCreateInputSchema>;

export const JobUpdateInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  billRate: z.number().nonnegative().nullable().optional(),
  payRate: z.number().nonnegative().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type JobUpdateInput = z.infer<typeof JobUpdateInputSchema>;

const GeoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const ClockInInputV2Schema = z.object({
  notes: z.string().max(500).optional(),
  jobId: UuidSchema.optional(),
  geo: GeoSchema.optional(),
});
export type ClockInInputV2 = z.infer<typeof ClockInInputV2Schema>;

export const ClockOutInputV2Schema = z.object({
  notes: z.string().max(500).optional(),
  geo: GeoSchema.optional(),
});
export type ClockOutInputV2 = z.infer<typeof ClockOutInputV2Schema>;

export const StartBreakInputSchema = z.object({
  type: BreakTypeSchema,
});
export type StartBreakInput = z.infer<typeof StartBreakInputSchema>;

export const ActiveDashboardEntrySchema = z.object({
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
});
export type ActiveDashboardEntry = z.infer<typeof ActiveDashboardEntrySchema>;

export const ActiveDashboardResponseSchema = z.object({
  entries: z.array(ActiveDashboardEntrySchema),
});
export type ActiveDashboardResponse = z.infer<typeof ActiveDashboardResponseSchema>;

export const AvailabilityWindowSchema = z.object({
  id: UuidSchema,
  associateId: UuidSchema,
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(24 * 60),
  endMinute: z.number().int().min(0).max(24 * 60),
});
export type AvailabilityWindow = z.infer<typeof AvailabilityWindowSchema>;

export const AvailabilityListResponseSchema = z.object({
  windows: z.array(AvailabilityWindowSchema),
});
export type AvailabilityListResponse = z.infer<typeof AvailabilityListResponseSchema>;

export const AvailabilityReplaceInputSchema = z.object({
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
});
export type AvailabilityReplaceInput = z.infer<typeof AvailabilityReplaceInputSchema>;

export const ShiftSwapStatusSchema = z.enum([
  'PENDING_PEER',
  'PEER_ACCEPTED',
  'PEER_DECLINED',
  'MANAGER_APPROVED',
  'MANAGER_REJECTED',
  'CANCELLED',
]);
export type ShiftSwapStatus = z.infer<typeof ShiftSwapStatusSchema>;

export const ShiftSwapRequestSchema = z.object({
  id: UuidSchema,
  shiftId: UuidSchema,
  shiftStartsAt: z.string().datetime(),
  shiftEndsAt: z.string().datetime(),
  shiftPosition: z.string(),
  shiftClientName: z.string().nullable(),
  requesterAssociateId: UuidSchema,
  requesterName: z.string(),
  counterpartyAssociateId: UuidSchema,
  counterpartyName: z.string(),
  status: ShiftSwapStatusSchema,
  note: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ShiftSwapRequest = z.infer<typeof ShiftSwapRequestSchema>;

export const ShiftSwapListResponseSchema = z.object({
  requests: z.array(ShiftSwapRequestSchema),
});
export type ShiftSwapListResponse = z.infer<typeof ShiftSwapListResponseSchema>;

export const SwapCreateInputSchema = z.object({
  shiftId: UuidSchema,
  counterpartyAssociateId: UuidSchema,
  note: z.string().max(500).optional(),
});
export type SwapCreateInput = z.infer<typeof SwapCreateInputSchema>;

export const SwapDecideInputSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type SwapDecideInput = z.infer<typeof SwapDecideInputSchema>;

export const ShiftConflictSchema = z.object({
  conflictingShiftId: UuidSchema,
  conflictingStartsAt: z.string().datetime(),
  conflictingEndsAt: z.string().datetime(),
  conflictingClientName: z.string().nullable(),
  conflictingPosition: z.string(),
});
export type ShiftConflict = z.infer<typeof ShiftConflictSchema>;

// Phase 52 — APPROVED time-off that overlaps the shift window. Surfaced
// in the UI as a hard warning ("they're on PTO that day") so HR doesn't
// accidentally double-book someone who's away.
export const TimeOffConflictSchema = z.object({
  requestId: UuidSchema,
  category: z.string(),
  startDate: z.string(), // YYYY-MM-DD
  endDate: z.string(),
});
export type TimeOffConflict = z.infer<typeof TimeOffConflictSchema>;

export const ShiftConflictsResponseSchema = z.object({
  conflicts: z.array(ShiftConflictSchema),
  timeOffConflicts: z.array(TimeOffConflictSchema).default([]),
});
export type ShiftConflictsResponse = z.infer<typeof ShiftConflictsResponseSchema>;

export const AutoFillCandidateSchema = z.object({
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
});
export type AutoFillCandidate = z.infer<typeof AutoFillCandidateSchema>;

export const AutoFillResponseSchema = z.object({
  candidates: z.array(AutoFillCandidateSchema),
});
export type AutoFillResponse = z.infer<typeof AutoFillResponseSchema>;

export const ClientGeofenceInputSchema = z
  .object({
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    geofenceRadiusMeters: z.number().int().min(10).max(50_000).nullable().optional(),
  })
  .refine(
    (v) =>
      ((v.latitude == null) === (v.longitude == null)) &&
      ((v.latitude == null) === (v.geofenceRadiusMeters == null)),
    { message: 'latitude, longitude, and geofenceRadiusMeters must be set or cleared together' }
  );
export type ClientGeofenceInput = z.infer<typeof ClientGeofenceInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 16 — Invitation flow
 * -------------------------------------------------------------------------- */

export const InviteSummarySchema = z.object({
  email: z.string().email(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  expiresAt: z.string().datetime(),
});
export type InviteSummary = z.infer<typeof InviteSummarySchema>;

export const AcceptInviteInputSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(256),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 39 — User settings (password change + display name)
 * -------------------------------------------------------------------------- */

export const ChangePasswordInputSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'New password must differ from current password',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

export const UpdateProfileInputSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
});
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

export const UpdateTimezoneInputSchema = z.object({
  // Null clears the preference and falls back to the browser locale.
  timezone: z.enum(SUPPORTED_TIMEZONES).nullable(),
});
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
  },
  {
    key: 'documents',
    label: 'Document changes',
    description: 'Confirmations and rejections for documents you upload.',
    mandatory: false,
  },
  {
    key: 'time_off',
    label: 'Time-off decisions',
    description: 'Approvals, denials, and balance adjustments on PTO requests.',
    mandatory: false,
  },
  {
    key: 'scheduling',
    label: 'Schedule changes',
    description: 'Shifts you are added to, moved off of, or that get cancelled.',
    mandatory: false,
  },
  {
    key: 'shift_swaps',
    label: 'Shift swap requests',
    description: 'Peer swap offers, accepts, declines, and manager decisions.',
    mandatory: false,
  },
  {
    key: 'discipline',
    label: 'Disciplinary actions',
    description: 'Always on — formal HR record required by policy.',
    mandatory: true,
  },
  {
    key: 'probation',
    label: 'Probation period',
    description: 'Always on — required HR notice.',
    mandatory: true,
  },
  {
    key: 'security',
    label: 'Account security',
    description: 'Always on — password resets and other security alerts.',
    mandatory: true,
  },
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

const NOTIFICATION_CATEGORY_KEYS = NOTIFICATION_CATEGORIES.map((c) => c.key) as [
  NotificationCategory,
  ...NotificationCategory[],
];

export const PatchNotificationPreferenceInputSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORY_KEYS),
  emailEnabled: z.boolean(),
});
export type PatchNotificationPreferenceInput = z.infer<
  typeof PatchNotificationPreferenceInputSchema
>;

export interface NotificationPreferenceEntry {
  category: NotificationCategory;
  label: string;
  description: string;
  mandatory: boolean;
  emailEnabled: boolean;
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

export const RequestEmailChangeInputSchema = z.object({
  newEmail: z.string().email().max(254),
  // Same minimum as login — keeps the password-input UX consistent and
  // ensures the dummy-hash compare path can always run on a malformed
  // submission without blowing up.
  currentPassword: z.string().min(12).max(256),
});
export type RequestEmailChangeInput = z.infer<typeof RequestEmailChangeInputSchema>;

export const ConfirmEmailChangeInputSchema = z.object({
  // ~43-char base64url; cap higher for forward compatibility.
  token: z.string().min(20).max(200),
});
export type ConfirmEmailChangeInput = z.infer<typeof ConfirmEmailChangeInputSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 26 — Time off (sick-leave accrual + ledger)
 * -------------------------------------------------------------------------- */

export const TimeOffCategorySchema = z.enum([
  'SICK',
  'VACATION',
  'PTO',
  'BEREAVEMENT',
  'JURY_DUTY',
  'OTHER',
]);
export type TimeOffCategory = z.infer<typeof TimeOffCategorySchema>;

export const TimeOffLedgerReasonSchema = z.enum([
  'ACCRUAL',
  'USE',
  'ADJUSTMENT',
  'CARRYOVER_FORFEIT',
  'ANNUAL_GRANT',
  'PAYOUT',
]);
export type TimeOffLedgerReason = z.infer<typeof TimeOffLedgerReasonSchema>;

export const TimeOffBalanceSchema = z.object({
  category: TimeOffCategorySchema,
  balanceMinutes: z.number().int(),
});
export type TimeOffBalance = z.infer<typeof TimeOffBalanceSchema>;

export const TimeOffLedgerEntrySchema = z.object({
  id: UuidSchema,
  category: TimeOffCategorySchema,
  reason: TimeOffLedgerReasonSchema,
  deltaMinutes: z.number().int(),
  sourceTimeEntryId: UuidSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type TimeOffLedgerEntry = z.infer<typeof TimeOffLedgerEntrySchema>;

export const TimeOffMyBalanceResponseSchema = z.object({
  balances: z.array(TimeOffBalanceSchema),
  recentLedger: z.array(TimeOffLedgerEntrySchema),
});
export type TimeOffMyBalanceResponse = z.infer<typeof TimeOffMyBalanceResponseSchema>;

/* -------------------------------------------------------------------------- *
 *  Phase 30 — Time-off requests (associate-submitted; HR-approved)
 * -------------------------------------------------------------------------- */

export const TimeOffRequestStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'DENIED',
  'CANCELLED',
]);
export type TimeOffRequestStatus = z.infer<typeof TimeOffRequestStatusSchema>;

// Dates are submitted as YYYY-MM-DD strings; the server clamps to UTC midnight.
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const TimeOffRequestCreateInputSchema = z
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
  });
export type TimeOffRequestCreateInput = z.infer<typeof TimeOffRequestCreateInputSchema>;

export const TimeOffRequestDecisionInputSchema = z.object({
  note: z.string().max(500).optional(),
});
export type TimeOffRequestDecisionInput = z.infer<typeof TimeOffRequestDecisionInputSchema>;

export const TimeOffRequestDenyInputSchema = z.object({
  // Note is required for DENY — the associate sees this in their history.
  note: z.string().min(1).max(500),
});
export type TimeOffRequestDenyInput = z.infer<typeof TimeOffRequestDenyInputSchema>;

export const TimeOffRequestSchema = z.object({
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
});
export type TimeOffRequest = z.infer<typeof TimeOffRequestSchema>;

export const TimeOffRequestListResponseSchema = z.object({
  requests: z.array(TimeOffRequestSchema),
});
export type TimeOffRequestListResponse = z.infer<typeof TimeOffRequestListResponseSchema>;

export const TimeOffRequestResponseSchema = z.object({
  request: TimeOffRequestSchema,
});
export type TimeOffRequestResponse = z.infer<typeof TimeOffRequestResponseSchema>;

export const TimeOffAdminListQuerySchema = z.object({
  status: TimeOffRequestStatusSchema.optional(),
});
export type TimeOffAdminListQuery = z.infer<typeof TimeOffAdminListQuerySchema>;

// ===== Phase 76 — Org hierarchy ===========================================

export const DepartmentSchema = z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  parentId: UuidSchema.nullable(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  associateCount: z.number().int().nonnegative(),
});
export type Department = z.infer<typeof DepartmentSchema>;

export const DepartmentListResponseSchema = z.object({
  departments: z.array(DepartmentSchema),
});
export type DepartmentListResponse = z.infer<typeof DepartmentListResponseSchema>;

export const DepartmentInputSchema = z.object({
  clientId: UuidSchema,
  parentId: UuidSchema.nullable().optional(),
  name: z.string().min(1).max(120),
  code: z.string().max(40).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
});
export type DepartmentInput = z.infer<typeof DepartmentInputSchema>;

export const CostCenterSchema = z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  associateCount: z.number().int().nonnegative(),
});
export type CostCenter = z.infer<typeof CostCenterSchema>;

export const CostCenterListResponseSchema = z.object({
  costCenters: z.array(CostCenterSchema),
});
export type CostCenterListResponse = z.infer<typeof CostCenterListResponseSchema>;

export const CostCenterInputSchema = z.object({
  clientId: UuidSchema,
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
});
export type CostCenterInput = z.infer<typeof CostCenterInputSchema>;

export const JobProfileSchema = z.object({
  id: UuidSchema,
  clientId: UuidSchema,
  code: z.string(),
  title: z.string(),
  family: z.string().nullable(),
  level: z.string().nullable(),
  isExempt: z.boolean(),
  description: z.string().nullable(),
  associateCount: z.number().int().nonnegative(),
});
export type JobProfile = z.infer<typeof JobProfileSchema>;

export const JobProfileListResponseSchema = z.object({
  jobProfiles: z.array(JobProfileSchema),
});
export type JobProfileListResponse = z.infer<typeof JobProfileListResponseSchema>;

export const JobProfileInputSchema = z.object({
  clientId: UuidSchema,
  code: z.string().min(1).max(40),
  title: z.string().min(1).max(120),
  family: z.string().max(80).optional().nullable(),
  level: z.string().max(40).optional().nullable(),
  isExempt: z.boolean().optional(),
  description: z.string().max(500).optional().nullable(),
});
export type JobProfileInput = z.infer<typeof JobProfileInputSchema>;

// Associate-side org assignment. Used by PUT /associates/:id/org.
export const AssociateOrgAssignmentInputSchema = z.object({
  managerId: UuidSchema.nullable().optional(),
  departmentId: UuidSchema.nullable().optional(),
  costCenterId: UuidSchema.nullable().optional(),
  jobProfileId: UuidSchema.nullable().optional(),
});
export type AssociateOrgAssignmentInput = z.infer<typeof AssociateOrgAssignmentInputSchema>;

// HR-side patch of plain associate fields (phone, etc.). Mirrors the
// fields self-service exposes on /me/profile but gated to manage:org so
// HR can correct contact info without asking the associate to re-submit
// onboarding. Address fields stay read-only here on purpose — those go
// through onboarding's PROFILE_INFO task which is the source of truth.
export const AssociateProfilePatchInputSchema = z.object({
  phone: z.string().trim().min(7).max(40).nullable().optional(),
});
export type AssociateProfilePatchInput = z.infer<typeof AssociateProfilePatchInputSchema>;

export const AssociateOrgSummarySchema = z.object({
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
});
export type AssociateOrgSummary = z.infer<typeof AssociateOrgSummarySchema>;

export const AssociateOrgListResponseSchema = z.object({
  associates: z.array(AssociateOrgSummarySchema),
});
export type AssociateOrgListResponse = z.infer<typeof AssociateOrgListResponseSchema>;

// ===== Directory =========================================================
//
// One-stop list of every person Alto HR knows about, with the joins HR
// actually wants in the row: employment status (derived from applications),
// current workplace (client), live pay rate, employment type, start date,
// and the org-fields tile. Powers /people.
export const DirectoryStatusSchema = z.enum([
  'ACTIVE', // Has at least one APPROVED application not yet ended.
  'PENDING', // Has a DRAFT/SUBMITTED/IN_REVIEW application — onboarding in flight.
  'INACTIVE', // No live applications (rejected, ended, or none at all).
]);
export type DirectoryStatus = z.infer<typeof DirectoryStatusSchema>;

export const DirectoryEntrySchema = z.object({
  id: UuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  employmentType: z.string(),
  j1Status: z.boolean(),
  status: DirectoryStatusSchema,
  // Workplace = client of the most-recent ACTIVE application; falls back
  // to the most-recent application overall when nothing is active.
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
  // First time this associate's record was created — useful as a proxy
  // for tenure when no formal hire date is on file.
  createdAt: z.string().datetime(),
  // Cache-busted URL to the associate's profile photo, or null. Avatar
  // falls back to initials when null.
  photoUrl: z.string().nullable(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

export const DirectoryListResponseSchema = z.object({
  associates: z.array(DirectoryEntrySchema),
});
export type DirectoryListResponse = z.infer<typeof DirectoryListResponseSchema>;

// ===== Phase 78 — Position ================================================

export const PositionStatusSchema = z.enum([
  'PLANNED',
  'OPEN',
  'FILLED',
  'FROZEN',
  'CLOSED',
]);
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

export const PositionSchema = z.object({
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
  notes: z.string().nullable(),
});
export type Position = z.infer<typeof PositionSchema>;

export const PositionListResponseSchema = z.object({
  positions: z.array(PositionSchema),
});
export type PositionListResponse = z.infer<typeof PositionListResponseSchema>;

export const PositionInputSchema = z.object({
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
  notes: z.string().max(1000).nullable().optional(),
});
export type PositionInput = z.infer<typeof PositionInputSchema>;

export const PositionAssignInputSchema = z.object({
  associateId: UuidSchema,
  filledAt: z.string().datetime().optional(),
});
export type PositionAssignInput = z.infer<typeof PositionAssignInputSchema>;

export const PositionStatusInputSchema = z.object({
  status: PositionStatusSchema,
});
export type PositionStatusInput = z.infer<typeof PositionStatusInputSchema>;

export const PositionHeadcountSchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(PositionStatusSchema, z.number().int().nonnegative()),
  fteAuthorized: z.string(),
  fteFilled: z.string(),
});
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

export const ComplianceTagSchema = z.enum([
  'EEO_HARASSMENT',
  'OSHA_SAFETY',
  'WALMART_CADE',
  'FOOD_HANDLER',
]);
export type ComplianceTag = z.infer<typeof ComplianceTagSchema>;

export const EVerifyStatusSchema = z.enum([
  'PENDING',
  'EMPLOYMENT_AUTHORIZED',
  'TENTATIVE_NONCONFIRMATION',
  'FINAL_NONCONFIRMATION',
  'CLOSE_CASE_AND_RESUBMIT',
]);
export type EVerifyStatus = z.infer<typeof EVerifyStatusSchema>;

export const ScorecardSeveritySchema = z.enum(['ok', 'warn', 'critical']);
export type ScorecardSeverity = z.infer<typeof ScorecardSeveritySchema>;

const ScorecardSubjectSchema = z.object({
  associateId: UuidSchema.nullable(),
  associateName: z.string().nullable(),
  clientId: UuidSchema.nullable(),
  clientName: z.string().nullable(),
});

// Tile 1 — onboarding completeness
export const ScorecardOnboardingSignalSchema = z.object({
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
});
export type ScorecardOnboardingSignal = z.infer<typeof ScorecardOnboardingSignalSchema>;

export const ScorecardOnboardingResponseSchema = z.object({
  activeAssociateCount: z.number().int().nonnegative(),
  // Number of active associates passing every signal (no gaps). Computed
  // server-side because the per-signal `missing[]` lists are capped for
  // payload size, so the client can't reliably take their union.
  fullyCompliantCount: z.number().int().nonnegative(),
  signals: z.array(ScorecardOnboardingSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
});
export type ScorecardOnboardingResponse = z.infer<typeof ScorecardOnboardingResponseSchema>;

// Tile 2 — expiring documents (30/60/90)
export const ScorecardExpirationKindSchema = z.enum([
  'WORKERS_COMP',
  'GENERAL_LIABILITY',
  'DRUG_TEST',
  'I9_WORK_AUTH',
  'J1_DS2019',
  'TRAINING_CERT',
]);
export type ScorecardExpirationKind = z.infer<typeof ScorecardExpirationKindSchema>;

export const ScorecardExpiringItemSchema = z.object({
  kind: ScorecardExpirationKindSchema,
  label: z.string(),
  expiresAt: z.string(),
  daysUntil: z.number().int(),
  subject: ScorecardSubjectSchema,
});
export type ScorecardExpiringItem = z.infer<typeof ScorecardExpiringItemSchema>;

export const ScorecardExpirationsResponseSchema = z.object({
  buckets: z.object({
    red: z.array(ScorecardExpiringItemSchema),    // 0–30 days
    amber: z.array(ScorecardExpiringItemSchema),  // 31–60 days
    green: z.array(ScorecardExpiringItemSchema),  // 61–90 days
  }),
  unsupported: z.array(z.object({
    kind: ScorecardExpirationKindSchema,
    label: z.string(),
    reason: z.string(),
  })),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
});
export type ScorecardExpirationsResponse = z.infer<typeof ScorecardExpirationsResponseSchema>;

// Tile 3 — shift compliance
export const ScorecardShiftSignalSchema = z.object({
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
});
export type ScorecardShiftSignal = z.infer<typeof ScorecardShiftSignalSchema>;

export const ScorecardShiftsResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  signals: z.array(ScorecardShiftSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
});
export type ScorecardShiftsResponse = z.infer<typeof ScorecardShiftsResponseSchema>;

// Tile 4 — billing & invoicing
export const ScorecardBillingRateRowSchema = z.object({
  clientId: UuidSchema,
  clientName: z.string(),
  jobId: UuidSchema,
  jobName: z.string(),
  billRate: z.number(),
  expectedRate: z.number().nullable(),
  match: z.boolean(),
});
export type ScorecardBillingRateRow = z.infer<typeof ScorecardBillingRateRowSchema>;

export const ScorecardBillingResponseSchema = z.object({
  rateChecks: z.array(ScorecardBillingRateRowSchema),
  unsupported: z.array(z.object({
    key: z.enum(['INVOICE_FORFEITURE', 'MONTHLY_REPORT', 'FIELDGLASS_LAST_SUBMIT']),
    label: z.string(),
    reason: z.string(),
  })),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
});
export type ScorecardBillingResponse = z.infer<typeof ScorecardBillingResponseSchema>;

// Tile 5 — training completeness
export const ScorecardTrainingSignalSchema = z.object({
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
});
export type ScorecardTrainingSignal = z.infer<typeof ScorecardTrainingSignalSchema>;

export const ScorecardTrainingResponseSchema = z.object({
  signals: z.array(ScorecardTrainingSignalSchema),
  severity: ScorecardSeveritySchema,
  generatedAt: z.string().datetime(),
});
export type ScorecardTrainingResponse = z.infer<typeof ScorecardTrainingResponseSchema>;

// Tile 6 — open actions (rolled up from the other tiles server-side)
export const ScorecardActionSchema = z.object({
  id: z.string(),
  severity: ScorecardSeveritySchema,
  title: z.string(),
  contractClause: z.string(),
  subject: ScorecardSubjectSchema,
  link: z.string().nullable(),  // SPA path, e.g. "/people?associate=..."
});
export type ScorecardAction = z.infer<typeof ScorecardActionSchema>;

export const ScorecardActionsResponseSchema = z.object({
  actions: z.array(ScorecardActionSchema),
  criticalCount: z.number().int().nonnegative(),
  warnCount: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
});
export type ScorecardActionsResponse = z.infer<typeof ScorecardActionsResponseSchema>;

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

export const OrgBrandingSchema = z.object({
  orgName: z.string().min(1).max(120),
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
  updatedAt: z.string().datetime(),
});
export type OrgBranding = z.infer<typeof OrgBrandingSchema>;

// PATCH body — every field optional; null clears, undefined leaves alone.
// Logo is uploaded via a separate multipart endpoint, not part of this body.
export const UpdateOrgBrandingInputSchema = z
  .object({
    orgName: z.string().min(1).max(120).optional(),
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
  })
  .strict();
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
export const MfaEnrollStartResponseSchema = z.object({
  secret: z.string().min(1),
  provisioningUri: z.string().url(),
  recoveryCodes: z.array(z.string().min(1)).length(MFA_RECOVERY_CODE_COUNT),
});
export type MfaEnrollStartResponse = z.infer<typeof MfaEnrollStartResponseSchema>;

export const MfaEnrollConfirmInputSchema = z.object({
  // 6-digit numeric. Server tolerates a single 30s window of skew.
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits.'),
});
export type MfaEnrollConfirmInput = z.infer<typeof MfaEnrollConfirmInputSchema>;

export const MfaDisableInputSchema = z.object({
  currentPassword: z.string().min(1).max(256),
});
export type MfaDisableInput = z.infer<typeof MfaDisableInputSchema>;

/** Code submitted to /auth/mfa-challenge. Either a 6-digit TOTP or a
 *  recovery code in `xxxxx-xxxxx` format. The server resolves which
 *  flavour was provided. */
export const MfaChallengeInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(20)
    .transform((s) => s.trim().toLowerCase()),
});
export type MfaChallengeInput = z.infer<typeof MfaChallengeInputSchema>;

export const MfaChallengeResponseSchema = z.object({
  user: AuthUserSchema,
});
export type MfaChallengeResponse = z.infer<typeof MfaChallengeResponseSchema>;

/** Snapshot of the caller's MFA state for the Settings card. */
export const MfaStatusResponseSchema = z.object({
  enrolled: z.boolean(),
  enabledAt: z.string().datetime().nullable(),
  remainingRecoveryCodes: z.number().int().nonnegative(),
});
export type MfaStatusResponse = z.infer<typeof MfaStatusResponseSchema>;

/** Regenerate-codes input. Same password-reauth contract as disable —
 *  rotating recovery codes is destructive (existing codes stop working) so
 *  we hold it to the same bar. */
export const MfaRegenerateInputSchema = z.object({
  currentPassword: z.string().min(1).max(256),
});
export type MfaRegenerateInput = z.infer<typeof MfaRegenerateInputSchema>;

export const MfaRegenerateResponseSchema = z.object({
  recoveryCodes: z.array(z.string().min(1)).length(MFA_RECOVERY_CODE_COUNT),
});
export type MfaRegenerateResponse = z.infer<typeof MfaRegenerateResponseSchema>;


