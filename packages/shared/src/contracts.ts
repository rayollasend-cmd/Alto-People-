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
