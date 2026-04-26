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
