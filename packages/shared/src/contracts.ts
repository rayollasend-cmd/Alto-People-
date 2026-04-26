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
