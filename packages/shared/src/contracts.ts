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
export const ClientListItemSchema = ClientSummarySchema.extend({
  openApplications: z.number().int().nonnegative(),
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
});
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

export const ApplicationListResponseSchema = z.object({
  applications: z.array(ApplicationSummarySchema),
});
export type ApplicationListResponse = z.infer<
  typeof ApplicationListResponseSchema
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
]);

export const UserStatusSchema = z.enum(['ACTIVE', 'DISABLED', 'INVITED']);

export const AuthUserSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  role: RoleSchema,
  status: UserStatusSchema,
  clientId: UuidSchema.nullable(),
  associateId: UuidSchema.nullable(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user: AuthUserSchema,
});
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

export const ApplicationCreateInputSchema = z.object({
  associateEmail: z.string().email(),
  associateFirstName: z.string().min(1).max(80),
  associateLastName: z.string().min(1).max(80),
  clientId: UuidSchema,
  templateId: UuidSchema,
  position: z.string().min(1).max(120).optional(),
  startDate: z.string().datetime().optional(),
  employmentType: EmploymentTypeSchema.optional(),
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
});
export type QboAccountConfigInput = z.infer<typeof QboAccountConfigInputSchema>;

export const QboSyncResponseSchema = z.object({
  journalEntryId: z.string(),
  syncedAt: z.string().datetime(),
});
export type QboSyncResponse = z.infer<typeof QboSyncResponseSchema>;

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
  status: PayrollItemStatusSchema,
  disbursementRef: z.string().nullable(),
  disbursedAt: z.string().datetime().nullable(),
  failureReason: z.string().nullable(),
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

export const PayrollItemListResponseSchema = z.object({
  items: z.array(PayrollItemSchema),
});
export type PayrollItemListResponse = z.infer<typeof PayrollItemListResponseSchema>;

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
  /** Sum of NET pay across all DISBURSED runs in the last 30 days. */
  netPaidLast30d: z.number().nonnegative(),
  /** Sum of NET pay across DRAFT + FINALIZED runs (pending disbursement). */
  netPendingDisbursement: z.number().nonnegative(),
  /** Bucketed counts for chart rendering. */
  applicationStatusCounts: z.record(z.number().int().nonnegative()),
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
});
export type CandidateCreateInput = z.infer<typeof CandidateCreateInputSchema>;

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
