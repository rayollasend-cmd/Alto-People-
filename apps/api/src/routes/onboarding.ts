import { Router } from 'express';
import {
  ApplicationCreateInputSchema,
  DirectDepositInputSchema,
  PolicyAckInputSchema,
  ProfileSubmissionSchema,
  W4SubmissionInputSchema,
  type ApplicationDetail,
  type ApplicationListResponse,
  type ApplicationPoliciesResponse,
  type ApplicationSummary,
  type AuditLogEntry,
  type AuditLogListResponse,
  type ChecklistTask,
  type OnboardingTemplate,
  type PolicyForApplication,
  type TemplateListResponse,
  type TemplateTask,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { generateInviteToken } from '../lib/inviteToken.js';
import { sendReminderForUser } from '../lib/inviteReminder.js';
import { send } from '../lib/notifications.js';
import { hashSignedPdf, renderSignedAgreement } from '../lib/esign.js';
import { resolveStoragePath, UPLOAD_ROOT } from '../lib/storage.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertCanModifyApplication,
  scopeApplications,
  scopeTemplates,
} from '../lib/scope.js';
import {
  computePercent,
  markTaskDoneByKind,
  markTaskSkippedById,
} from '../lib/checklist.js';
import { encryptString } from '../lib/crypto.js';
import { recordOnboardingEvent } from '../lib/audit.js';

export const onboardingRouter = Router();

const MANAGE = requireCapability('manage:onboarding');

// Prisma's interactive-transaction default ceiling is 5 s. Neon (over the
// internet) routinely exceeds that for the multi-statement writes below, so
// every $transaction in this file passes TX_OPTS to lift it to 30 s.
const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

/* ===== READ ============================================================== */

onboardingRouter.get('/applications', async (req, res, next) => {
  try {
    const rows = await prisma.application.findMany({
      where: scopeApplications(req.user!),
      orderBy: { invitedAt: 'desc' },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        client: { select: { name: true } },
        checklist: { include: { tasks: { select: { status: true } } } },
      },
    });

    const applications: ApplicationSummary[] = rows.map((row) => ({
      id: row.id,
      associateName: `${row.associate.firstName} ${row.associate.lastName}`,
      clientName: row.client.name,
      onboardingTrack: row.onboardingTrack,
      status: row.status,
      position: row.position,
      startDate: row.startDate ? row.startDate.toISOString() : null,
      invitedAt: row.invitedAt.toISOString(),
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      percentComplete: computePercent(row.checklist?.tasks ?? []),
    }));

    const payload: ApplicationListResponse = { applications };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

onboardingRouter.get('/applications/:id', async (req, res, next) => {
  try {
    const row = await prisma.application.findFirst({
      where: { ...scopeApplications(req.user!), id: req.params.id },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        client: { select: { name: true } },
        checklist: { include: { tasks: { orderBy: { order: 'asc' } } } },
      },
    });
    if (!row) {
      throw new HttpError(404, 'application_not_found', 'Application not found');
    }

    const tasks: ChecklistTask[] = (row.checklist?.tasks ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      title: t.title,
      description: t.description,
      order: t.order,
      documentId: t.documentId,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    }));

    const detail: ApplicationDetail = {
      id: row.id,
      associateId: row.associateId,
      clientId: row.clientId,
      associateName: `${row.associate.firstName} ${row.associate.lastName}`,
      clientName: row.client.name,
      onboardingTrack: row.onboardingTrack,
      status: row.status,
      position: row.position,
      startDate: row.startDate ? row.startDate.toISOString() : null,
      invitedAt: row.invitedAt.toISOString(),
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      percentComplete: computePercent(row.checklist?.tasks ?? []),
      tasks,
    };
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

onboardingRouter.get('/templates', async (req, res, next) => {
  try {
    const rows = await prisma.onboardingTemplate.findMany({
      where: scopeTemplates(req.user!),
      include: { tasks: { orderBy: { order: 'asc' } } },
      orderBy: [{ track: 'asc' }, { name: 'asc' }],
    });
    const templates: OnboardingTemplate[] = rows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      track: row.track,
      name: row.name,
      tasks: row.tasks.map(
        (t): TemplateTask => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          description: t.description,
          order: t.order,
        })
      ),
    }));
    const payload: TemplateListResponse = { templates };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* ===== POLICIES + AUDIT (read-extras) ==================================== */

onboardingRouter.get('/applications/:id/policies', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const client = await prisma.client.findUniqueOrThrow({
      where: { id: app.clientId },
      select: { industry: true },
    });

    const required = await prisma.policy.findMany({
      where: {
        deletedAt: null,
        requiredForOnboarding: true,
        OR: [
          { clientId: app.clientId },
          {
            clientId: null,
            industry: client.industry?.toLowerCase() ?? null,
          },
          { clientId: null, industry: null },
        ],
      },
      orderBy: [{ industry: 'asc' }, { title: 'asc' }],
    });

    const acks = await prisma.policyAcknowledgment.findMany({
      where: {
        associateId: app.associateId,
        policyId: { in: required.map((p) => p.id) },
      },
    });
    const ackByPolicyId = new Map(acks.map((a) => [a.policyId, a]));

    const policies: PolicyForApplication[] = required.map((p) => {
      const ack = ackByPolicyId.get(p.id) ?? null;
      return {
        id: p.id,
        title: p.title,
        version: p.version,
        industry: p.industry,
        bodyUrl: p.bodyUrl,
        acknowledged: !!ack,
        acknowledgedAt: ack ? ack.acknowledgedAt.toISOString() : null,
      };
    });

    const payload: ApplicationPoliciesResponse = { policies };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

onboardingRouter.get(
  '/applications/:id/audit',
  MANAGE,
  async (req, res, next) => {
    try {
      // Just confirms scope; HR/Ops always pass scopeApplications.
      const app = await assertCanModifyApplication(
        prisma,
        req.user!,
        req.params.id
      );

      const rows = await prisma.auditLog.findMany({
        where: {
          OR: [
            { entityType: 'Application', entityId: app.id },
            // Also surface auth events of the associate's user, scoped to the app's window.
            // For Phase 4 keep it simple — onboarding events are tagged with applicationId in metadata.
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          actorUser: { select: { email: true } },
        },
      });

      const entries: AuditLogEntry[] = rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        actorEmail: r.actorUser?.email ?? null,
        createdAt: r.createdAt.toISOString(),
        metadata: (r.metadata as Record<string, unknown>) ?? null,
      }));

      const payload: AuditLogListResponse = { entries };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

/* ===== CREATE APPLICATION (HR/Ops) ====================================== */

onboardingRouter.post('/applications', MANAGE, async (req, res, next) => {
  try {
    const parsed = ApplicationCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const email = input.associateEmail.trim().toLowerCase();

    // Generate the invite token raw outside the tx so we can use it after.
    const invite = generateInviteToken();
    const expiresAt = new Date(Date.now() + env.INVITE_TOKEN_TTL_SECONDS * 1000);

    const result = await prisma.$transaction(async (tx) => {
      // Find or create the associate
      let associate = await tx.associate.findUnique({ where: { email } });
      if (!associate) {
        associate = await tx.associate.create({
          data: {
            email,
            firstName: input.associateFirstName,
            lastName: input.associateLastName,
          },
        });
      }

      // Validate client + template exist
      const [client, template] = await Promise.all([
        tx.client.findFirst({
          where: { id: input.clientId, deletedAt: null },
        }),
        tx.onboardingTemplate.findUnique({
          where: { id: input.templateId },
          include: { tasks: { orderBy: { order: 'asc' } } },
        }),
      ]);
      if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
      if (!template) throw new HttpError(404, 'template_not_found', 'Template not found');

      // Find or create the User. If they already exist as ACTIVE under this
      // email, refuse — re-inviting an active user is a sign of confused
      // state; HR can reset password manually if needed.
      let user = await tx.user.findUnique({ where: { email } });
      if (user) {
        if (user.status === 'ACTIVE' && user.passwordHash) {
          throw new HttpError(
            409,
            'user_already_active',
            'A user with this email is already active. Cannot re-invite.'
          );
        }
        // Link the existing INVITED user to this Associate if missing.
        if (user.associateId !== associate.id) {
          user = await tx.user.update({
            where: { id: user.id },
            data: { associateId: associate.id },
          });
        }
      } else {
        user = await tx.user.create({
          data: {
            email,
            role: 'ASSOCIATE',
            status: 'INVITED',
            associateId: associate.id,
          },
        });
      }

      // Always issue a fresh token; an old one becomes stale once the
      // accept-invite endpoint consumes either.
      await tx.inviteToken.create({
        data: {
          tokenHash: invite.hash,
          userId: user.id,
          expiresAt,
        },
      });

      const application = await tx.application.create({
        data: {
          associateId: associate.id,
          clientId: client.id,
          onboardingTrack: template.track,
          status: 'DRAFT',
          position: input.position ?? null,
          startDate: input.startDate ? new Date(input.startDate) : null,
          checklist: {
            create: {
              tasks: {
                create: template.tasks.map((t) => ({
                  kind: t.kind,
                  title: t.title,
                  description: t.description,
                  order: t.order,
                })),
              },
            },
          },
        },
      });

      return { application, client, user, associate };
    }, TX_OPTS);

    // Queue + send the invitation email. Wrapped in try/catch so an email
    // failure doesn't roll back the application — HR can resend later.
    const acceptUrl = `${env.APP_BASE_URL}/accept-invite/${invite.raw}`;
    const subject = `You're invited to onboard with ${result.client.name}`;
    const body = [
      `Hi ${result.associate.firstName},`,
      ``,
      `${result.client.name} has invited you to complete onboarding through Alto People.`,
      ``,
      `Click this link to set your password and start your onboarding tasks:`,
      acceptUrl,
      ``,
      `This invitation expires on ${expiresAt.toISOString()}.`,
      ``,
      `If you didn't expect this email, you can safely ignore it.`,
    ].join('\n');

    let emailRef: string | null = null;
    let emailFailed: string | null = null;
    try {
      const r = await send({
        channel: 'EMAIL',
        recipient: { userId: result.user.id, phone: null, email },
        subject,
        body,
      });
      emailRef = r.externalRef;
    } catch (err) {
      emailFailed = err instanceof Error ? err.message : String(err);
    }
    await prisma.notification.create({
      data: {
        channel: 'EMAIL',
        status: emailFailed ? 'FAILED' : 'SENT',
        recipientUserId: result.user.id,
        recipientEmail: email,
        subject,
        body,
        category: 'onboarding.invite',
        externalRef: emailRef,
        failureReason: emailFailed,
        sentAt: emailFailed ? null : new Date(),
        senderUserId: req.user!.id,
      },
    });

    await recordOnboardingEvent({
      actorUserId: req.user!.id,
      action: 'onboarding.application_created',
      applicationId: result.application.id,
      clientId: result.client.id,
      metadata: {
        associateEmail: email,
        templateId: input.templateId,
        invitedUserId: result.user.id,
        emailQueued: emailRef !== null || emailFailed !== null,
        emailFailed,
      },
      req,
    });

    res.status(201).json({
      id: result.application.id,
      invitedUserId: result.user.id,
      // Returned in dev-stub mode only — gives HR a copy-pasteable link
      // when no real Resend is configured. Hidden when Resend sent for real.
      inviteUrl: env.RESEND_API_KEY && env.RESEND_FROM ? null : acceptUrl,
    });
  } catch (err) {
    next(err);
  }
});

/* ===== TASK WRITES ======================================================= */

/* PROFILE_INFO ----------------------------------------------------------- */
onboardingRouter.post('/applications/:id/profile', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const parsed = ProfileSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    await prisma.$transaction(async (tx) => {
      await tx.associate.update({
        where: { id: app.associateId },
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          dob: input.dob ? new Date(input.dob) : null,
          phone: input.phone ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          zip: input.zip ?? null,
        },
      });
      const checklist = await tx.onboardingChecklist.findUnique({
        where: { applicationId: app.id },
      });
      if (checklist) {
        await markTaskDoneByKind(tx, checklist.id, 'PROFILE_INFO');
      }
    }, TX_OPTS);

    await recordOnboardingEvent({
      actorUserId: req.user!.id,
      action: 'onboarding.profile_updated',
      applicationId: app.id,
      clientId: app.clientId,
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* W4 -------------------------------------------------------------------- */
onboardingRouter.post('/applications/:id/w4', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const parsed = W4SubmissionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const ssnCipher = input.ssn ? encryptString(input.ssn.replace(/-/g, '')) : null;

    await prisma.$transaction(async (tx) => {
      await tx.w4Submission.upsert({
        where: { associateId: app.associateId },
        create: {
          associateId: app.associateId,
          filingStatus: input.filingStatus,
          multipleJobs: input.multipleJobs,
          dependentsAmount: input.dependentsAmount,
          otherIncome: input.otherIncome,
          deductions: input.deductions,
          extraWithholding: input.extraWithholding,
          ssnEncrypted: ssnCipher,
        },
        update: {
          filingStatus: input.filingStatus,
          multipleJobs: input.multipleJobs,
          dependentsAmount: input.dependentsAmount,
          otherIncome: input.otherIncome,
          deductions: input.deductions,
          extraWithholding: input.extraWithholding,
          ...(ssnCipher ? { ssnEncrypted: ssnCipher } : {}),
        },
      });
      const checklist = await tx.onboardingChecklist.findUnique({
        where: { applicationId: app.id },
      });
      if (checklist) {
        await markTaskDoneByKind(tx, checklist.id, 'W4');
      }
    }, TX_OPTS);

    await recordOnboardingEvent({
      actorUserId: req.user!.id,
      action: 'onboarding.w4_submitted',
      applicationId: app.id,
      clientId: app.clientId,
      metadata: { hasSsn: input.ssn !== undefined },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* DIRECT_DEPOSIT -------------------------------------------------------- */
onboardingRouter.post(
  '/applications/:id/direct-deposit',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const parsed = DirectDepositInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const input = parsed.data;

      await prisma.$transaction(async (tx) => {
        const existing = await tx.payoutMethod.findFirst({
          where: { associateId: app.associateId, isPrimary: true },
        });

        if (input.type === 'BANK_ACCOUNT') {
          const data = {
            type: 'BANK_ACCOUNT' as const,
            // Routing numbers are public (printed on every check). No encryption.
            routingNumberEnc: Buffer.from(input.routingNumber, 'utf8'),
            accountNumberEnc: encryptString(input.accountNumber),
            accountType: input.accountType,
            branchCardId: null,
            isPrimary: true,
            verifiedAt: null,
          };
          if (existing) {
            await tx.payoutMethod.update({ where: { id: existing.id }, data });
          } else {
            await tx.payoutMethod.create({
              data: { associateId: app.associateId, ...data },
            });
          }
        } else {
          const data = {
            type: 'BRANCH_CARD' as const,
            routingNumberEnc: null,
            accountNumberEnc: null,
            accountType: null,
            branchCardId: input.branchCardId,
            isPrimary: true,
            verifiedAt: null,
          };
          if (existing) {
            await tx.payoutMethod.update({ where: { id: existing.id }, data });
          } else {
            await tx.payoutMethod.create({
              data: { associateId: app.associateId, ...data },
            });
          }
        }

        const checklist = await tx.onboardingChecklist.findUnique({
          where: { applicationId: app.id },
        });
        if (checklist) {
          await markTaskDoneByKind(tx, checklist.id, 'DIRECT_DEPOSIT');
        }
      }, TX_OPTS);

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.direct_deposit_set',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { type: input.type },
        req,
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

/* POLICY_ACK ------------------------------------------------------------ */
onboardingRouter.post('/applications/:id/policy-ack', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const parsed = PolicyAckInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const policyId = parsed.data.policyId;

    await prisma.$transaction(async (tx) => {
      const policy = await tx.policy.findFirst({
        where: { id: policyId, deletedAt: null },
      });
      if (!policy) {
        throw new HttpError(404, 'policy_not_found', 'Policy not found');
      }

      // Idempotent — unique on (policyId, associateId).
      await tx.policyAcknowledgment.upsert({
        where: {
          policyId_associateId: { policyId, associateId: app.associateId },
        },
        create: {
          policyId,
          associateId: app.associateId,
          clientId: app.clientId,
        },
        update: {},
      });

      // If every required policy for this app is now acked, mark task DONE.
      const client = await tx.client.findUnique({
        where: { id: app.clientId },
        select: { industry: true },
      });

      const required = await tx.policy.findMany({
        where: {
          deletedAt: null,
          requiredForOnboarding: true,
          OR: [
            { clientId: app.clientId },
            { clientId: null, industry: client?.industry?.toLowerCase() ?? null },
            { clientId: null, industry: null },
          ],
        },
        select: { id: true },
      });

      const ackedCount = await tx.policyAcknowledgment.count({
        where: {
          associateId: app.associateId,
          policyId: { in: required.map((p) => p.id) },
        },
      });

      if (ackedCount >= required.length && required.length > 0) {
        const checklist = await tx.onboardingChecklist.findUnique({
          where: { applicationId: app.id },
        });
        if (checklist) {
          await markTaskDoneByKind(tx, checklist.id, 'POLICY_ACK');
        }
      }
    }, TX_OPTS);

    await recordOnboardingEvent({
      actorUserId: req.user!.id,
      action: 'onboarding.policy_acknowledged',
      applicationId: app.id,
      clientId: app.clientId,
      metadata: { policyId },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== E-SIGNATURE (Phase 19) ======================================== */

// HR creates an agreement for an application. Optionally attaches it to an
// existing E_SIGN task in the checklist — when set, signing the agreement
// marks that task DONE.
onboardingRouter.post(
  '/applications/:id/esign/agreements',
  MANAGE,
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const title = String(req.body?.title ?? '').trim();
      const body = String(req.body?.body ?? '').trim();
      const taskId = req.body?.taskId ? String(req.body.taskId) : null;
      if (title.length === 0 || title.length > 200) {
        throw new HttpError(400, 'invalid_title', 'Title must be 1-200 chars');
      }
      if (body.length === 0 || body.length > 50_000) {
        throw new HttpError(400, 'invalid_body', 'Body must be 1-50000 chars');
      }
      if (taskId) {
        const task = await prisma.onboardingTask.findFirst({
          where: { id: taskId, kind: 'E_SIGN', checklist: { applicationId: app.id } },
        });
        if (!task) throw new HttpError(404, 'task_not_found', 'E_SIGN task not found');
      }

      const agreement = await prisma.esignAgreement.create({
        data: {
          applicationId: app.id,
          taskId,
          title,
          body,
          createdById: req.user!.id,
        },
      });

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.esign_agreement_created',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { agreementId: agreement.id, taskId },
        req,
      });

      res.status(201).json({
        id: agreement.id,
        applicationId: agreement.applicationId,
        taskId: agreement.taskId,
        title: agreement.title,
        body: agreement.body,
        createdAt: agreement.createdAt.toISOString(),
        signedAt: null,
        signatureId: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Either side (HR or assigned associate) reads the agreement to display.
onboardingRouter.get(
  '/applications/:id/esign/agreements/:agreementId',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const agreement = await prisma.esignAgreement.findFirst({
        where: { id: req.params.agreementId, applicationId: app.id },
      });
      if (!agreement) throw new HttpError(404, 'agreement_not_found', 'Agreement not found');
      res.json({
        id: agreement.id,
        applicationId: agreement.applicationId,
        taskId: agreement.taskId,
        title: agreement.title,
        body: agreement.body,
        createdAt: agreement.createdAt.toISOString(),
        signedAt: agreement.signedAt ? agreement.signedAt.toISOString() : null,
        signatureId: agreement.signatureId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Associate (or HR on their behalf — the typed name is recorded as proof
// of who-typed-what regardless) submits the typed signature. Server renders
// the signed PDF, hashes it, stores it under uploads/esign/, creates a
// DocumentRecord (so it shows up in the document vault) and a Signature
// row, and marks the linked E_SIGN task DONE if any.
onboardingRouter.post(
  '/applications/:id/esign/agreements/:agreementId/sign',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const agreement = await prisma.esignAgreement.findFirst({
        where: { id: req.params.agreementId, applicationId: app.id },
        include: { application: { include: { associate: true } } },
      });
      if (!agreement) throw new HttpError(404, 'agreement_not_found', 'Agreement not found');
      if (agreement.signedAt) {
        throw new HttpError(409, 'already_signed', 'Agreement already signed');
      }
      const typedName = String(req.body?.typedName ?? '').trim();
      if (typedName.length < 2 || typedName.length > 200) {
        throw new HttpError(400, 'invalid_typed_name', 'Typed name must be 2-200 chars');
      }

      // Capture audit context BEFORE rendering — they get embedded in the PDF.
      const ipAddress = req.ip ?? null;
      const userAgent = req.get('user-agent') ?? null;
      const signedAt = new Date();
      const associate = agreement.application.associate;

      const pdf = await renderSignedAgreement({
        agreement: { id: agreement.id, title: agreement.title, body: agreement.body },
        signer: {
          fullName: `${associate.firstName} ${associate.lastName}`,
          email: associate.email,
        },
        signedAt,
        ipAddress,
        userAgent,
        typedName,
      });
      const pdfHash = hashSignedPdf(pdf);

      // Persist to uploads/esign/<agreementId>/<hash>.pdf
      const relativeKey = `esign/${agreement.id}/${pdfHash.slice(0, 16)}.pdf`;
      const targetDir = join(UPLOAD_ROOT, 'esign', agreement.id);
      await mkdir(targetDir, { recursive: true });
      await writeFile(resolveStoragePath(relativeKey), pdf);

      const result = await prisma.$transaction(async (tx) => {
        const doc = await tx.documentRecord.create({
          data: {
            associateId: associate.id,
            clientId: app.clientId,
            kind: 'SIGNED_AGREEMENT',
            s3Key: relativeKey,
            filename: `${slugify(agreement.title)}.pdf`,
            mimeType: 'application/pdf',
            size: pdf.byteLength,
            status: 'VERIFIED',
            verifiedById: req.user!.id,
            verifiedAt: signedAt,
          },
        });
        const sig = await tx.signature.create({
          data: {
            documentId: doc.id,
            signerUserId: req.user!.id,
            associateId: associate.id,
            signedAt,
            ipAddress,
            userAgent,
            signatureS3Key: relativeKey,
            agreementId: agreement.id,
            typedName,
            pdfHash,
          },
        });
        const updatedAgreement = await tx.esignAgreement.update({
          where: { id: agreement.id },
          data: { signedAt, signatureId: sig.id },
        });
        // Mark the linked task DONE if any.
        if (agreement.taskId) {
          await tx.onboardingTask.update({
            where: { id: agreement.taskId },
            data: { status: 'DONE', completedAt: signedAt, documentId: doc.id },
          });
        }
        return { doc, sig, agreement: updatedAgreement };
      }, TX_OPTS);

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.esign_signed',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: {
          agreementId: agreement.id,
          signatureId: result.sig.id,
          documentId: result.doc.id,
          pdfHash,
          taskId: agreement.taskId,
        },
        req,
      });

      res.status(200).json({
        signatureId: result.sig.id,
        documentId: result.doc.id,
        pdfHash,
        signedAt: signedAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

// Streams the signed PDF. Scope: associate can fetch their own; HR/Ops
// can fetch any inside their scope.
onboardingRouter.get(
  '/esign/signatures/:signatureId/pdf',
  async (req, res, next) => {
    try {
      const sig = await prisma.signature.findUnique({
        where: { id: req.params.signatureId },
        include: { agreement: true },
      });
      if (!sig || !sig.agreement || !sig.signatureS3Key) {
        throw new HttpError(404, 'signature_not_found', 'Signature not found');
      }
      // Authz: scope by application.
      const app = await assertCanModifyApplication(
        prisma,
        req.user!,
        sig.agreement.applicationId
      );
      void app;

      const path = resolveStoragePath(sig.signatureS3Key);
      const { readFile } = await import('node:fs/promises');
      const pdf = await readFile(path);
      const liveHash = hashSignedPdf(pdf);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="signed-${sig.agreementId?.slice(0, 8) ?? 'agreement'}.pdf"`
      );
      res.setHeader('X-Pdf-Hash', liveHash);
      res.setHeader('X-Pdf-Hash-Stored', sig.pdfHash ?? '');
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  }
);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'agreement';
}

/* RESEND INVITE (HR/Ops only) ------------------------------------------ */
// Rotates the invite token for the application's associate user, sends a
// fresh "your new onboarding link" email, and kills the previous link. Use
// when a user lost the original email or the link expired. 409 if the user
// already accepted (status=ACTIVE with a passwordHash).
onboardingRouter.post(
  '/applications/:id/resend-invite',
  MANAGE,
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const user = await prisma.user.findFirst({
        where: { associateId: app.associateId },
      });
      if (!user) {
        throw new HttpError(404, 'no_invited_user', 'No user found for this associate');
      }
      if (user.status === 'ACTIVE' && user.passwordHash) {
        throw new HttpError(
          409,
          'user_already_active',
          'This associate has already accepted the invitation.'
        );
      }
      // Coerce them back to INVITED if they were DISABLED — the rotation
      // wipes any stale state.
      if (user.status !== 'INVITED') {
        await prisma.user.update({
          where: { id: user.id },
          data: { status: 'INVITED', passwordHash: null },
        });
      }

      const result = await sendReminderForUser(prisma, user.id, { reason: 'manual' });

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.invite_resent',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { invitedUserId: user.id, externalRef: result.externalRef },
        req,
      });

      res.status(200).json({
        invitedUserId: user.id,
        // Same dev-stub affordance as POST /applications: only show the
        // raw link when Resend isn't configured.
        inviteUrl:
          env.RESEND_API_KEY && env.RESEND_FROM
            ? null
            : `${env.APP_BASE_URL}/accept-invite/${result.rawToken}`,
      });
    } catch (err) {
      next(err);
    }
  }
);

/* TASK SKIP (HR/Ops only, demo) ----------------------------------------- */
onboardingRouter.post(
  '/applications/:id/tasks/:taskId/skip',
  MANAGE,
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const taskId = req.params.taskId;

      const task = await prisma.onboardingTask.findFirst({
        where: { id: taskId, checklist: { applicationId: app.id } },
      });
      if (!task) {
        throw new HttpError(404, 'task_not_found', 'Task not found');
      }

      await markTaskSkippedById(prisma, taskId);

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.task_skipped',
        applicationId: app.id,
        clientId: app.clientId,
        taskId: taskId,
        metadata: { kind: task.kind },
        req,
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
