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
});
export type ClientSummary = z.infer<typeof ClientSummarySchema>;

export const ClientListResponseSchema = z.object({
  clients: z.array(ClientSummarySchema),
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
});
export type ApplicationSummary = z.infer<typeof ApplicationSummarySchema>;

export const ApplicationDetailSchema = ApplicationSummarySchema.extend({
  associateId: UuidSchema,
  clientId: UuidSchema,
  tasks: z.array(ChecklistTaskSchema),
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
});
export type ApplicationCreateInput = z.infer<typeof ApplicationCreateInputSchema>;

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
  itemCount: z.number().int().nonnegative(),
  notes: z.string().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  disbursedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
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
