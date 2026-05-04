import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  ApplicationCreateInputSchema,
  ApproveApplicationInputSchema,
  BackgroundCheckAuthorizeInputSchema,
  BulkInviteInputSchema,
  BulkResendInputSchema,
  DirectDepositInputSchema,
  J1UpsertInputSchema,
  NudgeInputSchema,
  PolicyAckInputSchema,
  ProfileSubmissionSchema,
  RejectApplicationInputSchema,
  TemplateUpsertInputSchema,
  W4SubmissionInputSchema,
  type ApplicationDetail,
  type ApplicationListResponse,
  type ApplicationPoliciesResponse,
  type ApplicationSummary,
  type AuditLogEntry,
  type AuditLogListResponse,
  type BulkInviteResponse,
  type BulkInviteResultRow,
  type BulkResendResponse,
  type BulkResendResultRow,
  type ChecklistTask,
  type InviteDeliveryInfo,
  type InviteDeliveryStatus,
  type NudgeResponse,
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
import multer from 'multer';
import { decryptString, encryptString } from '../lib/crypto.js';
import { recordOnboardingEvent } from '../lib/audit.js';
import {
  notifyAllAdmins,
  notifyAssociate,
  notifyHrOnApplicationComplete,
  notifyManager,
} from '../lib/notify.js';
import {
  applicationApprovedTemplate,
  applicationRejectedTemplate,
  i9Section2Template,
  inviteTemplate,
} from '../lib/emailTemplates.js';
import {
  renderCompliancePacket,
  type PacketData,
} from '../lib/compliancePacket.js';
import { AGREEMENT_BODY, AGREEMENT_TITLE } from '../lib/altoHrContent.js';

export const onboardingRouter = Router();

const MANAGE = requireCapability('manage:onboarding');

// Prisma's interactive-transaction default ceiling is 5 s. Neon (over the
// internet) routinely exceeds that for the multi-statement writes below, so
// every $transaction in this file passes TX_OPTS to lift it to 30 s.
const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

/* ===== Phase 60 — invite delivery surface =============================== */

const INVITE_NOTIFICATION_CATEGORIES = [
  'onboarding.invite',
  'onboarding.nudge',
] as const;

function toDeliveryInfo(n: {
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  failureReason: string | null;
  category: string | null;
}): InviteDeliveryInfo {
  // Map Prisma's wider NotificationStatus enum down to the three states
  // HR cares about. SENT = delivered to provider successfully; FAILED =
  // provider rejected it; QUEUED = our process never got past creation
  // (or the row was created with status QUEUED — uncommon but possible).
  const status: InviteDeliveryStatus =
    n.status === 'SENT' ? 'SENT' : n.status === 'FAILED' ? 'FAILED' : 'QUEUED';
  return {
    status,
    attemptedAt: n.createdAt.toISOString(),
    sentAt: n.sentAt ? n.sentAt.toISOString() : null,
    failureReason: n.failureReason,
    category: n.category ?? 'onboarding.invite',
  };
}

/**
 * Latest invite/nudge delivery info per associate, for many associates at
 * once. Pulled in two queries (resolve user IDs, then notifications) so
 * we don't N+1 the inbox list. Returns a Map keyed by associateId.
 */
async function fetchLatestInviteDeliveryByAssociate(
  associateIds: string[]
): Promise<Map<string, InviteDeliveryInfo>> {
  if (associateIds.length === 0) return new Map();

  const users = await prisma.user.findMany({
    take: 1000,
    where: { associateId: { in: associateIds } },
    select: { id: true, associateId: true },
  });
  if (users.length === 0) return new Map();

  const userIdToAssociate = new Map<string, string>();
  for (const u of users) {
    if (u.associateId) userIdToAssociate.set(u.id, u.associateId);
  }

  // Pull all invite/nudge notifications for these users newest-first;
  // the first one we see per associate wins. Bounded in practice — even
  // a chronically nudged onboarding only generates a handful of rows.
  const notifications = await prisma.notification.findMany({
    take: 500,
    where: {
      recipientUserId: { in: Array.from(userIdToAssociate.keys()) },
      category: { in: [...INVITE_NOTIFICATION_CATEGORIES] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      recipientUserId: true,
      status: true,
      createdAt: true,
      sentAt: true,
      failureReason: true,
      category: true,
    },
  });

  const byAssociate = new Map<string, InviteDeliveryInfo>();
  for (const n of notifications) {
    if (!n.recipientUserId) continue;
    const associateId = userIdToAssociate.get(n.recipientUserId);
    if (!associateId) continue;
    if (byAssociate.has(associateId)) continue;
    byAssociate.set(associateId, toDeliveryInfo(n));
  }
  return byAssociate;
}

/* ===== Phase 58 — shared invite helper used by single + bulk endpoints === */

interface InviteApplicantInput {
  associateFirstName: string;
  associateLastName: string;
  associateEmail: string;
  clientId: string;
  templateId: string;
  employmentType?: 'W2_EMPLOYEE' | 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS';
  position?: string;
  startDate?: string; // ISO
  // Role to mint the INVITED User with. Defaults to ASSOCIATE. Management
  // roles let HR onboard a new manager via this same pipeline so they
  // land in the correct sidebar on first login.
  hireRole?:
    | 'ASSOCIATE'
    | 'OPERATIONS_MANAGER'
    | 'MANAGER'
    | 'INTERNAL_RECRUITER'
    | 'WORKFORCE_MANAGER'
    | 'MARKETING_MANAGER'
    | 'FINANCE_ACCOUNTANT';
}

interface InviteApplicantResult {
  applicationId: string;
  invitedUserId: string;
  inviteUrl: string | null; // dev-stub only
}

/**
 * Invite one applicant. Same flow as POST /applications, factored out so the
 * bulk endpoint doesn't duplicate it. Throws HttpError on hard failures
 * (duplicate ACTIVE user, missing client/template, etc.).
 */
async function inviteOneApplicant(
  actorUserId: string,
  reqForAudit: import('express').Request,
  input: InviteApplicantInput
): Promise<InviteApplicantResult> {
  const email = input.associateEmail.trim().toLowerCase();
  const invite = generateInviteToken();
  const expiresAt = new Date(Date.now() + env.INVITE_TOKEN_TTL_SECONDS * 1000);

  const result = await prisma.$transaction(async (tx) => {
    let associate = await tx.associate.findUnique({ where: { email } });
    if (!associate) {
      associate = await tx.associate.create({
        data: {
          email,
          firstName: input.associateFirstName,
          lastName: input.associateLastName,
          ...(input.employmentType ? { employmentType: input.employmentType } : {}),
        },
      });
    } else if (
      input.employmentType &&
      associate.employmentType !== input.employmentType
    ) {
      associate = await tx.associate.update({
        where: { id: associate.id },
        data: { employmentType: input.employmentType },
      });
    }

    const [client, template] = await Promise.all([
      tx.client.findFirst({ where: { id: input.clientId, deletedAt: null } }),
      tx.onboardingTemplate.findUnique({
        where: { id: input.templateId },
        include: { tasks: { orderBy: { order: 'asc' } } },
      }),
    ]);
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    if (!template) throw new HttpError(404, 'template_not_found', 'Template not found');

    const hireRole = input.hireRole ?? 'ASSOCIATE';
    let user = await tx.user.findUnique({ where: { email } });
    if (user) {
      if (user.status === 'ACTIVE' && user.passwordHash) {
        throw new HttpError(
          409,
          'user_already_active',
          'A user with this email is already active. Cannot re-invite.'
        );
      }
      // Promote a previously-invited user to the new role if HR re-invites
      // with a different hireRole (e.g. they invited as ASSOCIATE first,
      // then realised they meant MANAGER).
      const updates: Prisma.UserUpdateInput = {};
      if (user.associateId !== associate.id) {
        updates.associate = { connect: { id: associate.id } };
      }
      if (user.role !== hireRole) {
        updates.role = hireRole;
      }
      if (Object.keys(updates).length > 0) {
        user = await tx.user.update({ where: { id: user.id }, data: updates });
      }
    } else {
      user = await tx.user.create({
        data: {
          email,
          role: hireRole,
          status: 'INVITED',
          associateId: associate.id,
        },
      });
    }

    await tx.inviteToken.create({
      data: { tokenHash: invite.hash, userId: user.id, expiresAt },
    });

    const isContractor = associate.employmentType !== 'W2_EMPLOYEE';
    const tasksForChecklist = template.tasks.filter(
      (t) => !(isContractor && t.kind === 'W4')
    );

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
              create: tasksForChecklist.map((t) => ({
                kind: t.kind,
                title: t.title,
                description: t.description,
                order: t.order,
              })),
            },
          },
        },
      },
      include: {
        checklist: { include: { tasks: true } },
      },
    });

    // Auto-issue the Alto HR Associate Employment Agreement on the E_SIGN
    // task so the associate has it ready to read and sign as soon as they
    // accept the invite. Idempotent — only one agreement per E_SIGN task.
    const esignTask = application.checklist?.tasks.find((t) => t.kind === 'E_SIGN');
    if (esignTask) {
      await tx.esignAgreement.create({
        data: {
          applicationId: application.id,
          taskId: esignTask.id,
          title: AGREEMENT_TITLE,
          body: AGREEMENT_BODY,
          createdById: actorUserId,
        },
      });
    }

    return { application, client, user, associate };
  }, TX_OPTS);

  // Email — non-fatal; HR can resend later.
  const acceptUrl = `${env.APP_BASE_URL}/accept-invite/${invite.raw}`;
  const tpl = inviteTemplate({
    firstName: result.associate.firstName,
    clientName: result.client.name,
    hireDate: result.associate.hireDate ? result.associate.hireDate.toISOString().slice(0, 10) : null,
    magicLink: acceptUrl,
    linkExpiresAt: expiresAt.toISOString().slice(0, 10),
  });
  const subject = tpl.subject;
  const body = tpl.text;

  let emailRef: string | null = null;
  let emailFailed: string | null = null;
  try {
    const r = await send({
      channel: 'EMAIL',
      recipient: { userId: result.user.id, phone: null, email },
      subject,
      body,
      html: tpl.html,
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
      senderUserId: actorUserId,
    },
  });

  await recordOnboardingEvent({
    actorUserId,
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
    req: reqForAudit,
  });

  return {
    applicationId: result.application.id,
    invitedUserId: result.user.id,
    inviteUrl: env.RESEND_API_KEY && env.RESEND_FROM ? null : acceptUrl,
  };
}

/* ===== READ ============================================================== */

onboardingRouter.get('/applications', async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const q = req.query.q?.toString().trim();

    const where: Prisma.ApplicationWhereInput = {
      ...scopeApplications(req.user!),
      ...(status && status !== 'ALL'
        ? { status: status as Prisma.ApplicationWhereInput['status'] }
        : {}),
      ...(q
        ? {
            associate: {
              is: {
                OR: [
                  { firstName: { contains: q, mode: 'insensitive' } },
                  { lastName: { contains: q, mode: 'insensitive' } },
                  { email: { contains: q, mode: 'insensitive' } },
                ],
              },
            },
          }
        : {}),
    };

    // Pagination — defaults sized so most HR uses fit on one page (typical
    // active onboarding count per client) while still capping the worst-
    // case payload at 200 rows. Without this, every list call pulled the
    // full table and didn't degrade gracefully past a few hundred rows.
    const page = Math.max(1, parseInt(req.query.page?.toString() ?? '1', 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(
        1,
        parseInt(req.query.pageSize?.toString() ?? '50', 10) || 50
      )
    );

    const [rows, total] = await Promise.all([
      prisma.application.findMany({
        where,
        orderBy: { invitedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          associate: { select: { firstName: true, lastName: true } },
          client: { select: { name: true } },
          checklist: { include: { tasks: { select: { status: true } } } },
        },
      }),
      prisma.application.count({ where }),
    ]);

    const deliveryByAssociate = await fetchLatestInviteDeliveryByAssociate(
      rows.map((r) => r.associateId)
    );

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
      lastInviteDelivery: deliveryByAssociate.get(row.associateId) ?? null,
    }));

    const payload: ApplicationListResponse = {
      applications,
      total,
      page,
      pageSize,
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Aggregated stats for the Onboarding sidebar tiles (total / inFlight /
// stale / bounced / avgPercent + small "samples" arrays). Replaces a
// previous client pattern that pulled the entire (unfiltered) list just to
// count statuses — that was the dominant cost on the page at 500+ apps.
//
// We use a `groupBy` for byStatus + total, and a single targeted findMany
// for the in-flight subset to compute progress / staleness / bounced
// samples. APPROVED / REJECTED rows are skipped from the heavy fetch since
// they don't contribute to any tile but `total` and `byStatus`.
const STATS_STALE_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

onboardingRouter.get('/applications/stats', async (req, res, next) => {
  try {
    const where: Prisma.ApplicationWhereInput = scopeApplications(req.user!);

    const [grouped, inFlightRows] = await Promise.all([
      prisma.application.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      prisma.application.findMany({
        take: 500,
        where: { ...where, status: { notIn: ['APPROVED', 'REJECTED'] } },
        orderBy: { invitedAt: 'desc' },
        include: {
          associate: { select: { firstName: true, lastName: true } },
          client: { select: { name: true } },
          checklist: { include: { tasks: { select: { status: true } } } },
        },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    let total = 0;
    let inFlight = 0;
    for (const g of grouped) {
      byStatus[g.status] = g._count._all;
      total += g._count._all;
      if (g.status !== 'APPROVED' && g.status !== 'REJECTED') {
        inFlight += g._count._all;
      }
    }

    const deliveryByAssociate = await fetchLatestInviteDeliveryByAssociate(
      inFlightRows.map((r) => r.associateId)
    );

    const inFlightSummaries: ApplicationSummary[] = inFlightRows.map((row) => ({
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
      lastInviteDelivery: deliveryByAssociate.get(row.associateId) ?? null,
    }));

    const now = Date.now();
    const stale = inFlightSummaries.filter(
      (a) =>
        a.percentComplete < 100 &&
        now - new Date(a.invitedAt).getTime() > STATS_STALE_DAYS * ONE_DAY_MS
    );
    const bounced = inFlightSummaries.filter(
      (a) => a.lastInviteDelivery?.status === 'FAILED'
    );

    const avgPercent =
      inFlightSummaries.length === 0
        ? 0
        : Math.round(
            inFlightSummaries.reduce((acc, a) => acc + a.percentComplete, 0) /
              inFlightSummaries.length
          );

    res.json({
      total,
      byStatus,
      inFlight,
      stale: stale.length,
      bounced: bounced.length,
      avgPercent,
      staleSamples: stale.slice(0, 3),
      bouncedSamples: bounced.slice(0, 3),
    });
  } catch (err) {
    next(err);
  }
});

onboardingRouter.get('/applications/:id', async (req, res, next) => {
  try {
    const row = await prisma.application.findFirst({
      where: { ...scopeApplications(req.user!), id: req.params.id },
      include: {
        associate: {
          select: {
            firstName: true,
            lastName: true,
            employmentType: true,
            hireDate: true,
          },
        },
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

    const deliveryByAssociate = await fetchLatestInviteDeliveryByAssociate([
      row.associateId,
    ]);

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
      employmentType: row.associate.employmentType,
      lastInviteDelivery: deliveryByAssociate.get(row.associateId) ?? null,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
      rejectionReason: row.rejectionReason,
      hireDate: row.associate.hireDate
        ? row.associate.hireDate.toISOString().slice(0, 10)
        : null,
    };
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

/* ===== HR review outcome — approve / reject ============================== */
//
// Both routes are MANAGE-gated (manage:onboarding) and idempotency-rejecting:
// once an application has settled into APPROVED or REJECTED, neither action
// can re-fire — HR re-runs the onboarding by creating a new application.
//
// Approve side-effects in one transaction:
//   1) Application.status -> APPROVED, approvedAt -> now
//   2) Associate.hireDate -> body.hireDate
//   3) User (if any) for this associate -> status ACTIVE so they can log in
//      (their tokenVersion is bumped so any pre-hire invite session is
//      invalidated and they're forced to sign in via the activated account)
// Reject side-effects:
//   1) Application.status -> REJECTED, rejectedAt -> now, rejectionReason
// Per product call: rejected User accounts stay intact so the same person
// can be re-considered later via a brand-new Application — no soft-delete.

onboardingRouter.post(
  '/applications/:id/approve',
  MANAGE,
  async (req, res, next) => {
    try {
      const parsed = ApproveApplicationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_body',
          'Invalid request body',
          parsed.error.flatten()
        );
      }
      const { hireDate } = parsed.data;
      const app = await prisma.application.findFirst({
        where: { ...scopeApplications(req.user!), id: req.params.id },
        include: { checklist: { include: { tasks: true } } },
      });
      if (!app) {
        throw new HttpError(
          404,
          'application_not_found',
          'Application not found'
        );
      }
      if (app.status === 'APPROVED' || app.status === 'REJECTED') {
        throw new HttpError(
          409,
          'application_already_decided',
          `Application is already ${app.status}.`
        );
      }
      const percent = computePercent(app.checklist?.tasks ?? []);
      if (percent < 100) {
        throw new HttpError(
          409,
          'checklist_incomplete',
          `Checklist is ${percent}% complete — finish all tasks before approving.`
        );
      }

      // Date-only — strip the time so a midday approval doesn't accidentally
      // backdate the hireDate to the previous day in some timezones.
      const hireDateValue = new Date(`${hireDate}T00:00:00.000Z`);
      const now = new Date();

      await prisma.$transaction(async (tx) => {
        await tx.application.update({
          where: { id: app.id },
          data: { status: 'APPROVED', approvedAt: now },
        });
        await tx.associate.update({
          where: { id: app.associateId },
          data: { hireDate: hireDateValue },
        });
        // Activate the associate's User (if one exists). tokenVersion bump
        // invalidates any pre-hire invite session so they must sign in via
        // the now-activated account.
        await tx.user.updateMany({
          where: { associateId: app.associateId },
          data: { status: 'ACTIVE', tokenVersion: { increment: 1 } },
        });
      }, TX_OPTS);

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'application.approved',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { hireDate, percentComplete: percent },
        req,
      });

      const approvedAssoc = await prisma.associate.findUnique({
        where: { id: app.associateId },
        select: { firstName: true, lastName: true },
      });
      const approvedClient = await prisma.client.findUnique({
        where: { id: app.clientId },
        select: { name: true },
      });
      const approvedTpl = applicationApprovedTemplate({
        firstName: approvedAssoc?.firstName ?? 'there',
        clientName: approvedClient?.name ?? 'your assigned client',
        hireDate,
        appUrl: env.APP_BASE_URL,
      });
      void notifyAssociate(app.associateId, {
        subject: approvedTpl.subject,
        body: approvedTpl.text,
        html: approvedTpl.html,
        category: 'onboarding',
      });
      // Manager copy so the new hire's direct manager knows they're cleared
      // to start — no-op if no manager assigned.
      void notifyManager(app.associateId, {
        subject: 'New hire approved on your team',
        body: `One of your direct reports was just approved${hireDate ? ` with a hire date of ${hireDate}` : ''}. Reach out to set up day-1 expectations.`,
        category: 'onboarding',
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

onboardingRouter.post(
  '/applications/:id/reject',
  MANAGE,
  async (req, res, next) => {
    try {
      const parsed = RejectApplicationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_body',
          'Invalid request body',
          parsed.error.flatten()
        );
      }
      const { reason } = parsed.data;
      const app = await prisma.application.findFirst({
        where: { ...scopeApplications(req.user!), id: req.params.id },
      });
      if (!app) {
        throw new HttpError(
          404,
          'application_not_found',
          'Application not found'
        );
      }
      if (app.status === 'APPROVED' || app.status === 'REJECTED') {
        throw new HttpError(
          409,
          'application_already_decided',
          `Application is already ${app.status}.`
        );
      }

      await prisma.application.update({
        where: { id: app.id },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          rejectionReason: reason,
        },
      });

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'application.rejected',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { reason },
        req,
      });

      const rejAssoc = await prisma.associate.findUnique({
        where: { id: app.associateId },
        select: { firstName: true, lastName: true },
      });
      const rejClient = await prisma.client.findUnique({
        where: { id: app.clientId },
        select: { name: true },
      });
      const rejTpl = applicationRejectedTemplate({
        firstName: rejAssoc?.firstName ?? 'there',
        clientName: rejClient?.name ?? 'your assigned client',
        rejectionReason: reason,
        decisionDate: new Date().toISOString().slice(0, 10),
      });
      void notifyAssociate(app.associateId, {
        subject: rejTpl.subject,
        body: rejTpl.text,
        html: rejTpl.html,
        category: 'onboarding',
      });
      // Manager copy so the team owner knows the candidate isn't joining.
      void notifyManager(app.associateId, {
        subject: 'Application declined on your team',
        body: `An application for one of your direct reports was declined. Reason: ${reason}.`,
        category: 'onboarding',
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

onboardingRouter.get('/templates', async (req, res, next) => {
  try {
    const rows = await prisma.onboardingTemplate.findMany({
      take: 1000,
      where: scopeTemplates(req.user!),
      include: { tasks: { orderBy: { order: 'asc' } } },
      orderBy: [{ track: 'asc' }, { name: 'asc' }],
    });
    const templates: OnboardingTemplate[] = rows.map(toTemplate);
    const payload: TemplateListResponse = { templates };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

function toTemplate(row: {
  id: string;
  clientId: string | null;
  track: OnboardingTemplate['track'];
  name: string;
  tasks: Array<{
    id: string;
    kind: TemplateTask['kind'];
    title: string;
    description: string | null;
    order: number;
  }>;
}): OnboardingTemplate {
  return {
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
  };
}

/* ===== TEMPLATE CRUD (Phase 61, HR/Ops only) ============================ */

// Validate that the chosen client exists (for client-scoped templates) and
// enforce the (clientId, track) unique pair so we don't get two STANDARD
// templates for the same client.
async function validateTemplateUpsert(
  clientId: string | null,
  track: OnboardingTemplate['track'],
  excludeTemplateId?: string
): Promise<void> {
  if (clientId) {
    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
  }
  const existing = await prisma.onboardingTemplate.findFirst({
    where: {
      clientId,
      track,
      ...(excludeTemplateId ? { id: { not: excludeTemplateId } } : {}),
    },
  });
  if (existing) {
    throw new HttpError(
      409,
      'template_track_taken',
      `A ${track} template already exists for this ${clientId ? 'client' : 'global scope'}.`
    );
  }
}

onboardingRouter.post('/templates', MANAGE, async (req, res, next) => {
  try {
    const parsed = TemplateUpsertInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { name, track, clientId, tasks } = parsed.data;
    await validateTemplateUpsert(clientId, track);

    const created = await prisma.onboardingTemplate.create({
      data: {
        name: name.trim(),
        track,
        clientId,
        tasks: {
          create: tasks.map((t, i) => ({
            kind: t.kind,
            title: t.title.trim(),
            description: t.description ?? null,
            // Normalize order by array position — clients can leave it out.
            order: t.order ?? i,
          })),
        },
      },
      include: { tasks: { orderBy: { order: 'asc' } } },
    });
    res.status(201).json(toTemplate(created));
  } catch (err) {
    next(err);
  }
});

onboardingRouter.put('/templates/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = TemplateUpsertInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const id = req.params.id;
    const existing = await prisma.onboardingTemplate.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'template_not_found', 'Template not found');
    }
    const { name, track, clientId, tasks } = parsed.data;
    await validateTemplateUpsert(clientId, track, id);

    // Full-replace tasks within a transaction so a failure mid-update
    // doesn't leave the template with a half-applied task list.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.onboardingTemplateTask.deleteMany({ where: { templateId: id } });
      return tx.onboardingTemplate.update({
        where: { id },
        data: {
          name: name.trim(),
          track,
          clientId,
          tasks: {
            create: tasks.map((t, i) => ({
              kind: t.kind,
              title: t.title.trim(),
              description: t.description ?? null,
              order: t.order ?? i,
            })),
          },
        },
        include: { tasks: { orderBy: { order: 'asc' } } },
      });
    }, TX_OPTS);
    res.json(toTemplate(updated));
  } catch (err) {
    next(err);
  }
});

onboardingRouter.delete('/templates/:id', MANAGE, async (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = await prisma.onboardingTemplate.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'template_not_found', 'Template not found');
    }
    // Refuse if any application was created from this template — we don't
    // track templateId on Application directly (only the resolved
    // OnboardingTrack), so use track + (optional) clientId as a proxy.
    // This is conservative: it might block a delete that would technically
    // be safe, but it matches the user-visible idea of "this template is
    // in use." HR can re-create the template if they really want to delete.
    const usedBy = await prisma.application.count({
      where: {
        clientId: existing.clientId ?? undefined,
        onboardingTrack: existing.track,
        deletedAt: null,
      },
    });
    if (usedBy > 0) {
      throw new HttpError(
        409,
        'template_in_use',
        `Cannot delete: ${usedBy} application(s) use this track for this client.`
      );
    }
    await prisma.onboardingTemplate.delete({ where: { id } });
    res.status(204).end();
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
      take: 1000,
      where: {
        deletedAt: null,
        requiredForOnboarding: true,
        // Defensive: a stub policy with no body AND no bodyUrl is
        // un-acknowledgeable (the UI gates Acknowledge on scroll-to-bottom),
        // so it would silently block POLICY_ACK from completing. Skip
        // anything that has no readable content.
        OR: [{ body: { not: null } }, { bodyUrl: { not: null } }],
        AND: {
          OR: [
            { clientId: app.clientId },
            {
              clientId: null,
              industry: client.industry?.toLowerCase() ?? null,
            },
            { clientId: null, industry: null },
          ],
        },
      },
      orderBy: [{ industry: 'asc' }, { title: 'asc' }],
    });

    const acks = await prisma.policyAcknowledgment.findMany({
      take: 500,
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
        body: p.body ?? null,
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

/* ===== COMPLIANCE PACKET (Phase 59) ===================================== */
// Single-PDF bundle of every artifact tied to this application — what an
// auditor or insurance carrier wants in one shot. SSN/bank fields are
// last-4-only at render time; full values stay encrypted at rest.
onboardingRouter.get(
  '/applications/:id/packet.pdf',
  MANAGE,
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);

      const [
        full,
        w4,
        payout,
        i9,
        policyAcks,
        esignAgreements,
        documents,
        auditEvents,
      ] = await Promise.all([
        prisma.application.findUniqueOrThrow({
          where: { id: app.id },
          include: {
            associate: true,
            client: { select: { name: true } },
            checklist: { include: { tasks: { orderBy: { order: 'asc' } } } },
          },
        }),
        prisma.w4Submission.findUnique({ where: { associateId: app.associateId } }),
        prisma.payoutMethod.findFirst({
          where: { associateId: app.associateId, isPrimary: true },
        }),
        prisma.i9Verification.findUnique({
          where: { associateId: app.associateId },
          include: { section2Verifier: { select: { email: true } } },
        }),
        prisma.policyAcknowledgment.findMany({
          take: 500,
          where: { associateId: app.associateId },
          include: { policy: { select: { title: true, version: true } } },
          orderBy: { acknowledgedAt: 'asc' },
        }),
        prisma.esignAgreement.findMany({
          take: 500,
          where: { applicationId: app.id },
          include: { signatures: { orderBy: { signedAt: 'asc' }, take: 1 } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.documentRecord.findMany({
          take: 500,
          where: { associateId: app.associateId, deletedAt: null },
          include: { verifiedBy: { select: { email: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.auditLog.findMany({
          where: { entityType: 'Application', entityId: app.id },
          orderBy: { createdAt: 'asc' },
          include: { actorUser: { select: { email: true } } },
          take: 500,
        }),
      ]);

      const isContractor = full.associate.employmentType !== 'W2_EMPLOYEE';

      const data: PacketData = {
        meta: {
          generatedAt: new Date().toISOString(),
          generatedBy: req.user!.email ?? 'unknown',
        },
        application: {
          id: full.id,
          status: full.status,
          track: full.onboardingTrack,
          position: full.position,
          startDate: full.startDate ? full.startDate.toISOString() : null,
          invitedAt: full.invitedAt.toISOString(),
          submittedAt: full.submittedAt ? full.submittedAt.toISOString() : null,
        },
        client: { name: full.client.name },
        associate: {
          firstName: full.associate.firstName,
          lastName: full.associate.lastName,
          email: full.associate.email,
          employmentType: full.associate.employmentType,
          phone: full.associate.phone,
          dob: full.associate.dob ? full.associate.dob.toISOString() : null,
          addressLine1: full.associate.addressLine1,
          addressLine2: full.associate.addressLine2,
          city: full.associate.city,
          state: full.associate.state,
          zip: full.associate.zip,
        },
        // 1099 contractors don't fill W-4. Suppress the section entirely.
        w4:
          !isContractor && w4
            ? {
                filingStatus: w4.filingStatus,
                multipleJobs: w4.multipleJobs,
                dependentsAmount: w4.dependentsAmount.toString(),
                otherIncome: w4.otherIncome.toString(),
                deductions: w4.deductions.toString(),
                extraWithholding: w4.extraWithholding.toString(),
                ssnLast4: full.associate.ssnLast4,
                signedAt: w4.signedAt ? w4.signedAt.toISOString() : null,
              }
            : null,
        payout: payout
          ? (() => {
              // Decrypt server-side (this handler is HR/Ops-only and the
              // packet response goes straight to the auditor's download).
              // We slice the last 4 chars of the *plaintext* and discard
              // the rest before handing to the renderer — full numbers
              // never reach the PDF process state past this expression.
              let routingMasked: string | null = null;
              let accountLast4: string | null = null;
              try {
                if (payout.routingNumberEnc) {
                  const r = decryptString(payout.routingNumberEnc);
                  routingMasked = `•••••${r.slice(-4)}`;
                }
                if (payout.accountNumberEnc) {
                  const a = decryptString(payout.accountNumberEnc);
                  accountLast4 = a.slice(-4);
                }
              } catch {
                // If decryption fails (key rotation, corrupt blob), the
                // packet still renders — just without the masked digits.
                routingMasked = null;
                accountLast4 = null;
              }
              return {
                type:
                  payout.type === 'BANK_ACCOUNT' || payout.type === 'BRANCH_CARD'
                    ? payout.type
                    : 'OTHER',
                accountType: payout.accountType,
                routingMasked,
                accountLast4,
                branchCardId: payout.branchCardId,
                verifiedAt: payout.verifiedAt ? payout.verifiedAt.toISOString() : null,
              };
            })()
          : null,
        i9: i9
          ? {
              citizenshipStatus: i9.citizenshipStatus,
              section1CompletedAt: i9.section1CompletedAt
                ? i9.section1CompletedAt.toISOString()
                : null,
              section1TypedName: i9.section1TypedName,
              section2CompletedAt: i9.section2CompletedAt
                ? i9.section2CompletedAt.toISOString()
                : null,
              section2VerifierEmail: i9.section2Verifier?.email ?? null,
              documentList: i9.documentList,
              workAuthExpiresAt: i9.workAuthExpiresAt
                ? i9.workAuthExpiresAt.toISOString()
                : null,
              hasAlienRegistrationNumber: !!i9.alienRegistrationNumberEnc,
            }
          : null,
        tasks: (full.checklist?.tasks ?? []).map((t) => ({
          kind: t.kind,
          title: t.title,
          status: t.status,
          completedAt: t.completedAt ? t.completedAt.toISOString() : null,
        })),
        policyAcks: policyAcks.map((a) => ({
          title: a.policy.title,
          version: a.policy.version,
          acknowledgedAt: a.acknowledgedAt.toISOString(),
        })),
        esignAgreements: esignAgreements.map((e) => {
          const sig = e.signatures[0] ?? null;
          return {
            title: e.title,
            signedAt: e.signedAt ? e.signedAt.toISOString() : null,
            typedName: sig?.typedName ?? null,
            pdfHashHex: sig?.pdfHash ?? null,
          };
        }),
        documents: documents.map((d) => ({
          kind: d.kind,
          filename: d.filename,
          status: d.status,
          verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
          verifiedByEmail: d.verifiedBy?.email ?? null,
          rejectionReason: d.rejectionReason,
        })),
        audit: auditEvents.map((e) => ({
          action: e.action,
          actorEmail: e.actorUser?.email ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      };

      const pdf = await renderCompliancePacket(data);

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.packet_downloaded',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { pdfBytes: pdf.length },
        req,
      });

      const filename = `compliance-packet-${full.associate.lastName}-${full.associate.firstName}-${app.id.slice(0, 8)}.pdf`
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(pdf.length));
      res.end(pdf);
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
    const result = await inviteOneApplicant(req.user!.id, req, parsed.data);
    res.status(201).json({
      id: result.applicationId,
      invitedUserId: result.invitedUserId,
      inviteUrl: result.inviteUrl,
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

    void notifyHrOnApplicationComplete(app.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* W4 -------------------------------------------------------------------- */

// GET — what's on file (redacted). Lets the W-4 form show "•••-••-1234"
// instead of demanding the associate retype their SSN every time they
// re-open the page.
onboardingRouter.get('/applications/:id/w4', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const [w4, associate] = await Promise.all([
      prisma.w4Submission.findUnique({ where: { associateId: app.associateId } }),
      prisma.associate.findUniqueOrThrow({
        where: { id: app.associateId },
        select: { ssnLast4: true },
      }),
    ]);
    res.json({
      hasSubmission: w4 !== null,
      filingStatus: w4?.filingStatus ?? null,
      multipleJobs: w4?.multipleJobs ?? false,
      dependentsAmount: w4 ? w4.dependentsAmount.toString() : null,
      otherIncome: w4 ? w4.otherIncome.toString() : null,
      deductions: w4 ? w4.deductions.toString() : null,
      extraWithholding: w4 ? w4.extraWithholding.toString() : null,
      hasSsnOnFile: w4?.ssnEncrypted != null,
      ssnLast4: associate.ssnLast4,
      submittedAt: w4?.signedAt ? w4.signedAt.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

onboardingRouter.post('/applications/:id/w4', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const parsed = W4SubmissionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    // SSN is required for an actual W-4. We accept resubmission without an
    // SSN ONLY when there's already one encrypted on file for this
    // associate — that's how the redacted-display flow works (the form
    // shows "•••-••-1234" and doesn't require retype).
    const existing = await prisma.w4Submission.findUnique({
      where: { associateId: app.associateId },
      select: { ssnEncrypted: true },
    });
    const alreadyHasSsn = existing?.ssnEncrypted != null;
    if (!input.ssn && !alreadyHasSsn) {
      throw new HttpError(
        400,
        'ssn_required',
        'Social Security Number is required to submit a W-4.'
      );
    }
    const ssnDigits = input.ssn ? input.ssn.replace(/-/g, '') : null;
    const ssnCipher = ssnDigits ? encryptString(ssnDigits) : null;
    const ssnLast4 = ssnDigits ? ssnDigits.slice(-4) : null;

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
          signedAt: new Date(),
        },
        update: {
          filingStatus: input.filingStatus,
          multipleJobs: input.multipleJobs,
          dependentsAmount: input.dependentsAmount,
          otherIncome: input.otherIncome,
          deductions: input.deductions,
          extraWithholding: input.extraWithholding,
          ...(ssnCipher ? { ssnEncrypted: ssnCipher } : {}),
          signedAt: new Date(),
        },
      });
      // Also mirror the last-4 onto the Associate so the redacted display
      // and compliance packet can show it without decrypting.
      if (ssnLast4) {
        await tx.associate.update({
          where: { id: app.associateId },
          data: { ssnLast4 },
        });
      }
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

    void notifyHrOnApplicationComplete(app.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* DIRECT_DEPOSIT -------------------------------------------------------- */

// ABA routing-number checksum (ANSI X9.5). The leading nine-digit number is
// valid iff (3*(d1+d4+d7) + 7*(d2+d5+d8) + (d3+d6+d9)) is a multiple of 10.
// Stops the obvious typo (123456789, 999999999, etc) before it lands on a
// pay run. Routing numbers are public; this is purely format validation.
function isValidAba(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split('').map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

// GET — what's on file (redacted). Powers the "•••• 1234" display in the
// direct-deposit form so the associate can confirm what's there without
// retyping. Never returns full account or routing digits.
onboardingRouter.get(
  '/applications/:id/direct-deposit',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const payout = await prisma.payoutMethod.findFirst({
        where: { associateId: app.associateId, isPrimary: true },
      });
      if (!payout) {
        res.json({ hasPayoutMethod: false });
        return;
      }
      let routingMasked: string | null = null;
      let accountLast4: string | null = null;
      try {
        if (payout.routingNumberEnc) {
          // Routing is stored as plain UTF-8 bytes — see the comment in the
          // POST handler. Just decode as a string.
          const r = payout.routingNumberEnc.toString('utf8');
          routingMasked = `•••••${r.slice(-4)}`;
        }
        if (payout.accountNumberEnc) {
          const a = decryptString(payout.accountNumberEnc);
          accountLast4 = a.slice(-4);
        }
      } catch {
        routingMasked = null;
        accountLast4 = null;
      }
      res.json({
        hasPayoutMethod: true,
        type: payout.type,
        accountType: payout.accountType,
        routingMasked,
        accountLast4,
        branchCardId: payout.branchCardId,
        verifiedAt: payout.verifiedAt ? payout.verifiedAt.toISOString() : null,
        updatedAt: payout.updatedAt?.toISOString() ?? null,
      });
    } catch (err) {
      next(err);
    }
  }
);

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
      if (input.type === 'BANK_ACCOUNT' && !isValidAba(input.routingNumber)) {
        throw new HttpError(
          400,
          'invalid_routing_number',
          'Routing number failed the ABA checksum — please double-check it on your check or bank app.'
        );
      }

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

      void notifyHrOnApplicationComplete(app.id);
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
        take: 1000,
        where: {
          deletedAt: null,
          requiredForOnboarding: true,
          // Mirror the GET filter above: skip un-acknowledgeable stubs so
          // the auto-completion check counts the same set the UI shows.
          OR: [{ body: { not: null } }, { bodyUrl: { not: null } }],
          AND: {
            OR: [
              { clientId: app.clientId },
              { clientId: null, industry: client?.industry?.toLowerCase() ?? null },
              { clientId: null, industry: null },
            ],
          },
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

    void notifyHrOnApplicationComplete(app.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Phase 63 — DOCUMENT_UPLOAD / BACKGROUND_CHECK / J1_DOCS ========= */

// DOCUMENT_UPLOAD ------------------------------------------------------ */
// Files come in via the existing /documents/me/upload pipeline. This
// endpoint is the "I'm done" handshake: the associate clicks finish on
// the upload screen, server confirms at least one identity-class doc
// exists for them, then marks the DOCUMENT_UPLOAD checklist task DONE.
const ID_CLASS_DOC_KINDS = ['ID', 'SSN_CARD', 'I9_SUPPORTING'] as const;

onboardingRouter.post(
  '/applications/:id/document-upload',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);

      const documentCount = await prisma.documentRecord.count({
        where: {
          associateId: app.associateId,
          deletedAt: null,
          kind: { in: [...ID_CLASS_DOC_KINDS] },
        },
      });
      if (documentCount === 0) {
        throw new HttpError(
          400,
          'no_documents',
          'Upload at least one ID, SSN card, or I-9 supporting document before finishing.'
        );
      }

      const checklist = await prisma.onboardingChecklist.findUnique({
        where: { applicationId: app.id },
      });
      if (checklist) {
        await markTaskDoneByKind(prisma, checklist.id, 'DOCUMENT_UPLOAD');
      }

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.documents_submitted',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { documentCount },
        req,
      });

      void notifyHrOnApplicationComplete(app.id);
      res.json({ ok: true, documentCount });
    } catch (err) {
      next(err);
    }
  }
);

// BACKGROUND_CHECK ----------------------------------------------------- */
// Stub provider for now — associate types their full legal name (acts as
// a consent signature) and the BackgroundCheck row flips straight to
// PASSED. Phase 64+ will swap in a real Checkr / Sterling integration;
// this endpoint's contract stays the same so the UI doesn't change.
onboardingRouter.post(
  '/applications/:id/background-check',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const parsed = BackgroundCheckAuthorizeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const { typedName } = parsed.data;

      // Sanity-check that the typed name vaguely matches the associate's
      // record. Lower-case + strip whitespace + require either first OR
      // last name to appear. Forgiving — different from a wet signature.
      const associate = await prisma.associate.findUniqueOrThrow({
        where: { id: app.associateId },
        select: { firstName: true, lastName: true },
      });
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const typed = norm(typedName);
      const matches =
        typed.includes(norm(associate.firstName)) ||
        typed.includes(norm(associate.lastName));
      if (!matches) {
        throw new HttpError(
          400,
          'name_mismatch',
          'The typed name must include your first or last name as on file.'
        );
      }

      const now = new Date();
      const bg = await prisma.$transaction(async (tx) => {
        // One BackgroundCheck per associate is enough for v1. Re-running
        // the endpoint just refreshes the row so a re-applying associate
        // gets a fresh PASSED record instead of a stale one.
        const existing = await tx.backgroundCheck.findFirst({
          where: { associateId: app.associateId },
          orderBy: { initiatedAt: 'desc' },
        });
        const data = {
          provider: 'stub',
          // PASSED in the stub world; a real provider would set INITIATED
          // here and flip to PASSED via webhook later.
          status: 'PASSED' as const,
          completedAt: now,
        };
        return existing
          ? tx.backgroundCheck.update({ where: { id: existing.id }, data })
          : tx.backgroundCheck.create({
              data: {
                ...data,
                associateId: app.associateId,
                clientId: app.clientId,
                initiatedAt: now,
              },
            });
      }, TX_OPTS);

      const checklist = await prisma.onboardingChecklist.findUnique({
        where: { applicationId: app.id },
      });
      if (checklist) {
        await markTaskDoneByKind(prisma, checklist.id, 'BACKGROUND_CHECK');
      }

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.background_check_authorized',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { provider: bg.provider, status: bg.status, typedName },
        req,
      });

      void notifyHrOnApplicationComplete(app.id);
      res.json({
        id: bg.id,
        associateId: bg.associateId,
        provider: bg.provider,
        status: bg.status,
        initiatedAt: bg.initiatedAt.toISOString(),
        completedAt: bg.completedAt ? bg.completedAt.toISOString() : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// J1_DOCS -------------------------------------------------------------- */
// Two-step: associate POSTs the J1Profile (program dates, DS-2019 number,
// sponsor, country, etc.), then uploads DS-2019 / visa scans through the
// document vault, then POSTs `/finish` to mark the task DONE. Splitting
// the profile from the finish lets HR see the metadata even before files
// are uploaded.
onboardingRouter.post(
  '/applications/:id/j1-profile',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const parsed = J1UpsertInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const input = parsed.data;
      // J1UpsertInputSchema enforces YYYY-MM-DD shape and that
      // programEndDate >= programStartDate; we still verify strict-after
      // here so a same-day program (start == end) is rejected upstream
      // of the date constructor (DST edge cases).
      const start = new Date(`${input.programStartDate}T00:00:00.000Z`);
      const end = new Date(`${input.programEndDate}T00:00:00.000Z`);
      if (end <= start) {
        throw new HttpError(
          400,
          'bad_program_dates',
          'Program end date must be after start date.'
        );
      }

      const profile = await prisma.j1Profile.upsert({
        where: { associateId: app.associateId },
        create: {
          associateId: app.associateId,
          programStartDate: start,
          programEndDate: end,
          ds2019Number: input.ds2019Number.trim(),
          sponsorAgency: input.sponsorAgency.trim(),
          visaNumber: input.visaNumber?.trim() || null,
          sevisId: input.sevisId?.trim() || null,
          country: input.country.trim(),
        },
        update: {
          programStartDate: start,
          programEndDate: end,
          ds2019Number: input.ds2019Number.trim(),
          sponsorAgency: input.sponsorAgency.trim(),
          visaNumber: input.visaNumber?.trim() || null,
          sevisId: input.sevisId?.trim() || null,
          country: input.country.trim(),
        },
      });

      // Flip the associate's j1Status flag so HR queries can quickly
      // identify J-1 hires without joining J1Profile.
      await prisma.associate.update({
        where: { id: app.associateId },
        data: { j1Status: true },
      });

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.j1_profile_saved',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { ds2019Number: profile.ds2019Number, country: profile.country },
        req,
      });

      res.json({
        id: profile.id,
        associateId: profile.associateId,
        programStartDate: profile.programStartDate.toISOString(),
        programEndDate: profile.programEndDate.toISOString(),
        ds2019Number: profile.ds2019Number,
        sponsorAgency: profile.sponsorAgency,
        visaNumber: profile.visaNumber,
        sevisId: profile.sevisId,
        country: profile.country,
      });
    } catch (err) {
      next(err);
    }
  }
);

const J1_DOC_KINDS = ['J1_DS2019', 'J1_VISA'] as const;

onboardingRouter.post(
  '/applications/:id/j1-finish',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const [profile, documentCount] = await Promise.all([
        prisma.j1Profile.findUnique({ where: { associateId: app.associateId } }),
        prisma.documentRecord.count({
          where: {
            associateId: app.associateId,
            deletedAt: null,
            kind: { in: [...J1_DOC_KINDS] },
          },
        }),
      ]);
      if (!profile) {
        throw new HttpError(
          400,
          'no_profile',
          'Save your J-1 program details before finishing.'
        );
      }
      if (documentCount === 0) {
        throw new HttpError(
          400,
          'no_documents',
          'Upload at least one DS-2019 or J-1 visa scan before finishing.'
        );
      }

      const checklist = await prisma.onboardingChecklist.findUnique({
        where: { applicationId: app.id },
      });
      if (checklist) {
        await markTaskDoneByKind(prisma, checklist.id, 'J1_DOCS');
      }

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.j1_docs_submitted',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { documentCount },
        req,
      });

      void notifyHrOnApplicationComplete(app.id);
      res.json({ ok: true, hasProfile: true, documentCount });
    } catch (err) {
      next(err);
    }
  }
);

/* ===== I-9 (Phase 20) ================================================ */
//
// Phase 4 already had the I9_VERIFICATION task as a stub and Phase 10
// shipped the HR-side `compliance/i9` upsert. Phase 20 adds:
//   1. Associate-facing Section 1 self-attestation with typed-name e-sign
//      (capturing IP/UA/citizenship status/work-auth expiry).
//   2. Mobile-camera document upload — multipart photo accepting ID,
//      passport, SSN card, etc. Files land in the existing document vault
//      at uploads/i9/<associateId>/<hash>.<ext>.
//   3. Section 2 verifier flow that records WHICH uploaded document IDs
//      satisfy the I-9 List A or List B+C requirements, and DONE-s the
//      I9_VERIFICATION task once both sections are complete.

const I9_MAX_BYTES = 10 * 1024 * 1024;
const I9_ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const i9Upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: I9_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!I9_ALLOWED_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', `Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

const I9_CITIZENSHIP_VALUES = [
  'US_CITIZEN',
  'NON_CITIZEN_NATIONAL',
  'LAWFUL_PERMANENT_RESIDENT',
  'ALIEN_AUTHORIZED_TO_WORK',
] as const;

type I9CitizenshipStatus = typeof I9_CITIZENSHIP_VALUES[number];

function maybeMarkI9TaskDone(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  applicationId: string,
  hasSection1: boolean,
  hasSection2: boolean,
  now: Date
): Promise<unknown> | null {
  if (!hasSection1 || !hasSection2) return null;
  return tx.onboardingTask.updateMany({
    where: {
      checklist: { applicationId },
      kind: 'I9_VERIFICATION',
      status: { not: 'DONE' },
    },
    data: { status: 'DONE', completedAt: now },
  });
}

// Read I-9 status for the application's associate.
onboardingRouter.get('/applications/:id/i9', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const row = await prisma.i9Verification.findUnique({
      where: { associateId: app.associateId },
      include: {
        section2Verifier: { select: { email: true } },
      },
    });
    res.json({
      associateId: app.associateId,
      section1: row && row.section1CompletedAt
        ? {
            completedAt: row.section1CompletedAt.toISOString(),
            citizenshipStatus: row.citizenshipStatus,
            workAuthExpiresAt: row.workAuthExpiresAt
              ? row.workAuthExpiresAt.toISOString().slice(0, 10)
              : null,
            // alienRegistrationNumberEnc is intentionally NOT returned —
            // the associate types it once and HR doesn't need it back
            // through the wire. A future hardened decrypt path can expose
            // it to the section-2 verifier UI when needed.
            hasAlienNumber: row.alienRegistrationNumberEnc !== null,
            typedName: row.section1TypedName,
          }
        : null,
      documentsSubmittedAt: row?.documentsSubmittedAt
        ? row.documentsSubmittedAt.toISOString()
        : null,
      section2: row && row.section2CompletedAt
        ? {
            completedAt: row.section2CompletedAt.toISOString(),
            verifierEmail: row.section2Verifier?.email ?? null,
            documentList: row.documentList,
            supportingDocIds: Array.isArray(row.supportingDocIds)
              ? (row.supportingDocIds as string[])
              : [],
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// Associate marks "I'm done — please review." Requires Section 1 signed
// and at least one I-9 document on file. Sets documentsSubmittedAt and
// transitions the I9_VERIFICATION task to IN_PROGRESS so the checklist
// shows visible progress while HR works on Section 2.
onboardingRouter.post('/applications/:id/i9/submit', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);

    const verification = await prisma.i9Verification.findUnique({
      where: { associateId: app.associateId },
    });
    if (!verification || !verification.section1CompletedAt) {
      throw new HttpError(
        400,
        'section1_not_signed',
        'Sign Section 1 before submitting documents for HR review.'
      );
    }

    const docCount = await prisma.documentRecord.count({
      where: {
        associateId: app.associateId,
        deletedAt: null,
        kind: { in: ['I9_SUPPORTING', 'ID', 'SSN_CARD', 'J1_VISA', 'J1_DS2019'] },
      },
    });
    if (docCount === 0) {
      throw new HttpError(
        400,
        'no_documents',
        'Upload at least one identification document before submitting.'
      );
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const upd = await tx.i9Verification.update({
        where: { associateId: app.associateId },
        data: { documentsSubmittedAt: verification.documentsSubmittedAt ?? now },
      });
      // Idempotent: only flip PENDING → IN_PROGRESS. Don't clobber a
      // task that HR has already moved to DONE via Section 2.
      await tx.onboardingTask.updateMany({
        where: {
          checklist: { applicationId: app.id },
          kind: 'I9_VERIFICATION',
          status: 'PENDING',
        },
        data: { status: 'IN_PROGRESS' },
      });
      return upd;
    }, TX_OPTS);

    await recordOnboardingEvent({
      actorUserId: req.user!.id,
      action: 'onboarding.i9_documents_submitted',
      applicationId: app.id,
      clientId: app.clientId,
      metadata: { documentCount: docCount },
      req,
    });

    res.status(200).json({
      documentsSubmittedAt: updated.documentsSubmittedAt?.toISOString() ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// Associate (or HR-on-behalf, audited) submits Section 1 attestation.
onboardingRouter.post('/applications/:id/i9/section1', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);

    const status = String(req.body?.citizenshipStatus ?? '').toUpperCase();
    if (!I9_CITIZENSHIP_VALUES.includes(status as I9CitizenshipStatus)) {
      throw new HttpError(400, 'invalid_citizenship_status', 'Pick exactly one citizenship status');
    }
    const typedName = String(req.body?.typedName ?? '').trim();
    if (typedName.length < 2 || typedName.length > 200) {
      throw new HttpError(400, 'invalid_typed_name', 'Typed name must be 2-200 chars');
    }
    const alienRegistrationNumber: string | null =
      typeof req.body?.alienRegistrationNumber === 'string'
        ? req.body.alienRegistrationNumber.replace(/\s+/g, '').slice(0, 30) || null
        : null;
    const workAuthExpiresAt: Date | null = req.body?.workAuthExpiresAt
      ? new Date(`${String(req.body.workAuthExpiresAt).slice(0, 10)}T00:00:00.000Z`)
      : null;

    // Per USCIS: ALIEN_AUTHORIZED_TO_WORK requires either an A-Number, an
    // I-94, or a foreign-passport number. We accept A-Number; the others
    // can come in via the supporting-docs upload. Either way, we require
    // the work-auth expiry date for that status (it's literally on the
    // form). LAWFUL_PERMANENT_RESIDENT requires the A-Number.
    if (status === 'ALIEN_AUTHORIZED_TO_WORK' && !workAuthExpiresAt) {
      throw new HttpError(
        400,
        'work_auth_expiry_required',
        'workAuthExpiresAt is required for ALIEN_AUTHORIZED_TO_WORK'
      );
    }
    if (
      (status === 'ALIEN_AUTHORIZED_TO_WORK' || status === 'LAWFUL_PERMANENT_RESIDENT') &&
      !alienRegistrationNumber
    ) {
      throw new HttpError(
        400,
        'alien_number_required',
        'alienRegistrationNumber is required for this citizenship status'
      );
    }

    const now = new Date();
    const ipAddress = req.ip ?? null;
    const userAgent = req.get('user-agent') ?? null;
    const alienEnc = alienRegistrationNumber ? encryptString(alienRegistrationNumber) : null;

    const updated = await prisma.$transaction(async (tx) => {
      const upserted = await tx.i9Verification.upsert({
        where: { associateId: app.associateId },
        create: {
          associateId: app.associateId,
          section1CompletedAt: now,
          citizenshipStatus: status as I9CitizenshipStatus,
          alienRegistrationNumberEnc: alienEnc,
          workAuthExpiresAt,
          section1TypedName: typedName,
          section1Ip: ipAddress,
          section1UserAgent: userAgent,
        },
        update: {
          section1CompletedAt: now,
          citizenshipStatus: status as I9CitizenshipStatus,
          // Only overwrite the encrypted blob when the caller provided a
          // fresh number — re-attestations without a new A# keep the old
          // value so we don't accidentally erase it.
          ...(alienEnc !== null ? { alienRegistrationNumberEnc: alienEnc } : {}),
          workAuthExpiresAt,
          section1TypedName: typedName,
          section1Ip: ipAddress,
          section1UserAgent: userAgent,
        },
      });
      await maybeMarkI9TaskDone(
        tx,
        app.id,
        true,
        upserted.section2CompletedAt !== null,
        now
      );
      return upserted;
    }, TX_OPTS);

    await recordOnboardingEvent({
      actorUserId: req.user!.id,
      action: 'onboarding.i9_section1_submitted',
      applicationId: app.id,
      clientId: app.clientId,
      metadata: {
        citizenshipStatus: updated.citizenshipStatus,
        hasAlienNumber: alienEnc !== null,
        workAuthExpiresAt: workAuthExpiresAt ? workAuthExpiresAt.toISOString().slice(0, 10) : null,
      },
      req,
    });

    const assoc = await prisma.associate.findUnique({
      where: { id: app.associateId },
      select: { firstName: true, lastName: true, hireDate: true },
    });
    const i9Client = await prisma.client.findUnique({
      where: { id: app.clientId },
      select: { name: true },
    });
    const associateName = assoc ? `${assoc.firstName} ${assoc.lastName}` : 'an associate';
    const hireDateStr = assoc?.hireDate ? assoc.hireDate.toISOString().slice(0, 10) : null;
    let section2Due: string | null = null;
    if (assoc?.hireDate) {
      // Three business days from hire date (cheap calendar approximation —
      // skips weekends, ignores federal holidays).
      let due = new Date(assoc.hireDate);
      let added = 0;
      while (added < 3) {
        due = new Date(due.getTime() + 24 * 60 * 60 * 1000);
        const dow = due.getUTCDay();
        if (dow !== 0 && dow !== 6) added += 1;
      }
      section2Due = due.toISOString().slice(0, 10);
    }
    const i9Tpl = i9Section2Template({
      associateName,
      clientName: i9Client?.name ?? 'the client',
      hireDate: hireDateStr,
      section2DueDate: section2Due,
      i9Url: `${env.APP_BASE_URL}/admin/applications/${app.id}/i9`,
    });
    void notifyAllAdmins({
      subject: i9Tpl.subject,
      body: i9Tpl.text,
      html: i9Tpl.html,
      category: 'onboarding',
    });

    res.status(200).json({
      section1CompletedAt: updated.section1CompletedAt?.toISOString() ?? null,
      citizenshipStatus: updated.citizenshipStatus,
    });
  } catch (err) {
    next(err);
  }
});

// Mobile-camera document upload. Accepts a single multipart "file" field;
// the request also carries documentKind (one of I9_SUPPORTING / ID /
// SSN_CARD / J1_VISA / J1_DS2019), and an optional documentSide
// (FRONT/BACK) preserved in the filename for the Section-2 verifier.
onboardingRouter.post(
  '/applications/:id/i9/documents',
  i9Upload.single('file'),
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const file = req.file;
      if (!file) throw new HttpError(400, 'file_required', 'multipart "file" field required');

      const allowedKinds = ['I9_SUPPORTING', 'ID', 'SSN_CARD', 'J1_VISA', 'J1_DS2019'] as const;
      const documentKind = (req.body?.documentKind ?? 'I9_SUPPORTING').toString();
      if (!allowedKinds.includes(documentKind as typeof allowedKinds[number])) {
        throw new HttpError(400, 'invalid_document_kind', `documentKind must be one of ${allowedKinds.join(', ')}`);
      }
      const side = req.body?.documentSide
        ? String(req.body.documentSide).toUpperCase()
        : null;
      if (side && side !== 'FRONT' && side !== 'BACK') {
        throw new HttpError(400, 'invalid_document_side', 'documentSide must be FRONT or BACK');
      }

      // Hash the file body for content-addressed storage. Keeps duplicate
      // uploads (a user re-tapping submit) from spamming the vault.
      const { createHash } = await import('node:crypto');
      const sha = createHash('sha256').update(file.buffer).digest('hex');
      const ext = (file.mimetype === 'image/jpeg' && '.jpg') ||
        (file.mimetype === 'image/png' && '.png') ||
        (file.mimetype === 'image/webp' && '.webp') ||
        (file.mimetype === 'application/pdf' && '.pdf') ||
        '';
      const sideTag = side ? `-${side.toLowerCase()}` : '';
      const relativeKey = `i9/${app.associateId}/${sha.slice(0, 16)}${sideTag}${ext}`;
      const targetDir = join(UPLOAD_ROOT, 'i9', app.associateId);
      await mkdir(targetDir, { recursive: true });
      await writeFile(resolveStoragePath(relativeKey), file.buffer);

      const baseFilename = file.originalname || `i9-${documentKind.toLowerCase()}${sideTag}${ext}`;
      const doc = await prisma.documentRecord.create({
        data: {
          associateId: app.associateId,
          clientId: app.clientId,
          kind: documentKind as 'I9_SUPPORTING' | 'ID' | 'SSN_CARD' | 'J1_VISA' | 'J1_DS2019',
          s3Key: relativeKey,
          filename: baseFilename,
          mimeType: file.mimetype,
          size: file.size,
          status: 'UPLOADED',
        },
      });

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.i9_document_uploaded',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { documentId: doc.id, documentKind, documentSide: side, sha256: sha, size: file.size },
        req,
      });

      res.status(201).json({
        documentId: doc.id,
        kind: doc.kind,
        side,
        size: doc.size,
        mimeType: doc.mimeType,
        sha256: sha,
      });
    } catch (err) {
      next(err);
    }
  }
);

// List the I-9 supporting documents uploaded for this application's
// associate (Phase 24). HR uses this to render thumbnails on the Section 2
// verifier card. Returns only I-9-relevant kinds; the response is
// download-URL-linkable via /api/documents/:id/download (HR-scoped).
onboardingRouter.get('/applications/:id/i9/documents', async (req, res, next) => {
  try {
    const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
    const rows = await prisma.documentRecord.findMany({
      take: 500,
      where: {
        associateId: app.associateId,
        deletedAt: null,
        kind: { in: ['I9_SUPPORTING', 'ID', 'SSN_CARD', 'J1_VISA', 'J1_DS2019'] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        filename: true,
        mimeType: true,
        size: true,
        status: true,
        createdAt: true,
      },
    });
    res.json({
      documents: rows.map((d) => {
        // Filename embeds the side tag (e.g. `id-front.jpg`); pull it back
        // out so the verifier UI can group front/back of the same doc.
        const lower = d.filename.toLowerCase();
        const side: 'FRONT' | 'BACK' | null = lower.includes('-front')
          ? 'FRONT'
          : lower.includes('-back')
            ? 'BACK'
            : null;
        return {
          id: d.id,
          kind: d.kind,
          filename: d.filename,
          mimeType: d.mimeType,
          size: d.size,
          status: d.status,
          side,
          createdAt: d.createdAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// HR Section 2 verification. Caller picks the document list (LIST_A or
// LIST_B_AND_C) and the document IDs they personally inspected.
onboardingRouter.post(
  '/applications/:id/i9/section2',
  MANAGE,
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const documentList = String(req.body?.documentList ?? '').toUpperCase();
      if (documentList !== 'LIST_A' && documentList !== 'LIST_B_AND_C') {
        throw new HttpError(400, 'invalid_document_list', 'documentList must be LIST_A or LIST_B_AND_C');
      }
      const supportingDocIds: unknown = req.body?.supportingDocIds;
      if (!Array.isArray(supportingDocIds) || supportingDocIds.length === 0) {
        throw new HttpError(
          400,
          'docs_required',
          'supportingDocIds is required (must be a non-empty array of document UUIDs)'
        );
      }
      const ids = supportingDocIds.map((x) => String(x));
      // Verify every doc belongs to this associate.
      const docs = await prisma.documentRecord.findMany({
        take: 500,
        where: { id: { in: ids }, associateId: app.associateId, deletedAt: null },
        select: { id: true },
      });
      if (docs.length !== ids.length) {
        throw new HttpError(404, 'doc_not_found', 'One or more supporting documents not found for this associate');
      }
      const minDocs = documentList === 'LIST_A' ? 1 : 2;
      if (ids.length < minDocs) {
        throw new HttpError(
          400,
          'doc_count',
          `LIST_${documentList === 'LIST_A' ? 'A' : 'B_AND_C'} requires at least ${minDocs} document(s)`
        );
      }
      // Section 1 must be complete first.
      const existing = await prisma.i9Verification.findUnique({
        where: { associateId: app.associateId },
      });
      if (!existing || !existing.section1CompletedAt) {
        throw new HttpError(409, 'section1_required', 'Section 1 must be completed before Section 2');
      }

      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const upserted = await tx.i9Verification.update({
          where: { associateId: app.associateId },
          data: {
            section2CompletedAt: now,
            section2VerifierUserId: req.user!.id,
            documentList: documentList as 'LIST_A' | 'LIST_B_AND_C',
            supportingDocIds: ids,
          },
        });
        // Also flip the associated DocumentRecords to VERIFIED with the
        // current HR user as verifier.
        await tx.documentRecord.updateMany({
          where: { id: { in: ids } },
          data: { status: 'VERIFIED', verifiedById: req.user!.id, verifiedAt: now },
        });
        await maybeMarkI9TaskDone(tx, app.id, true, true, now);
        return upserted;
      }, TX_OPTS);

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.i9_section2_verified',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: { documentList: updated.documentList, docCount: ids.length },
        req,
      });

      void notifyHrOnApplicationComplete(app.id);
      res.json({
        section2CompletedAt: updated.section2CompletedAt?.toISOString() ?? null,
        documentList: updated.documentList,
        supportingDocIds: ids,
      });
    } catch (err) {
      next(err);
    }
  }
);

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

// HR or the associate lists every agreement attached to an application.
// Same scope rule as everything else under /applications/:id — the
// assertCanModifyApplication guard handles cross-tenant + non-owner.
onboardingRouter.get(
  '/applications/:id/esign/agreements',
  async (req, res, next) => {
    try {
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const rows = await prisma.esignAgreement.findMany({
        take: 500,
        where: { applicationId: app.id },
        orderBy: { createdAt: 'desc' },
      });
      res.json({
        agreements: rows.map((a) => ({
          id: a.id,
          applicationId: a.applicationId,
          taskId: a.taskId,
          title: a.title,
          body: a.body,
          createdAt: a.createdAt.toISOString(),
          signedAt: a.signedAt ? a.signedAt.toISOString() : null,
          signatureId: a.signatureId,
        })),
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

      void notifyHrOnApplicationComplete(app.id);

      // Email a copy of the signed PDF to the associate. Non-fatal — the
      // signature itself is already persisted, and the document lives in
      // the vault under their folder regardless. Notification row records
      // the attempt so HR can see it landed.
      if (associate.email) {
        const linkUrl = `${env.APP_BASE_URL}/api/onboarding/esign/signatures/${result.sig.id}/pdf`;
        const subject = `Signed: ${agreement.title}`;
        const emailBody = [
          `Hi ${associate.firstName},`,
          ``,
          `Thank you for signing the ${agreement.title}.`,
          ``,
          `A copy of the signed agreement is attached to this email and is also`,
          `available in your Documents in Alto People at any time:`,
          linkUrl,
          ``,
          `Signed on: ${signedAt.toISOString()}`,
          `Document fingerprint (SHA-256): ${pdfHash}`,
          ``,
          `If you didn't sign this, contact hr@altohr.com immediately.`,
          ``,
          `— Alto HR`,
        ].join('\n');
        let emailRef: string | null = null;
        let emailFailed: string | null = null;
        try {
          const r = await send({
            channel: 'EMAIL',
            recipient: {
              userId: req.user!.id,
              phone: null,
              email: associate.email,
            },
            subject,
            body: emailBody,
            attachments: [
              {
                filename: `${slugify(agreement.title)}.pdf`,
                content: pdf,
                contentType: 'application/pdf',
              },
            ],
          });
          emailRef = r.externalRef;
        } catch (err) {
          emailFailed = err instanceof Error ? err.message : String(err);
        }
        await prisma.notification.create({
          data: {
            channel: 'EMAIL',
            status: emailFailed ? 'FAILED' : 'SENT',
            recipientUserId: req.user!.id,
            recipientEmail: associate.email,
            subject,
            body: emailBody,
            category: 'onboarding.esign_copy',
            externalRef: emailRef,
            failureReason: emailFailed,
            sentAt: emailFailed ? null : new Date(),
            senderUserId: req.user!.id,
          },
        });
      }

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

/* BULK INVITE (HR/Ops only, Phase 58) ---------------------------------- */
// Run inviteOneApplicant per row, isolated. One bad row (duplicate ACTIVE,
// missing template, etc.) doesn't block the rest — failures are reported
// per-row in the response so HR can fix and retry just those.
onboardingRouter.post(
  '/applications/bulk',
  MANAGE,
  async (req, res, next) => {
    try {
      const parsed = BulkInviteInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const { clientId, templateId, employmentType, applicants } = parsed.data;

      const results: BulkInviteResultRow[] = [];
      let succeeded = 0;
      let failed = 0;

      for (const a of applicants) {
        try {
          const r = await inviteOneApplicant(req.user!.id, req, {
            associateFirstName: a.firstName,
            associateLastName: a.lastName,
            associateEmail: a.email,
            clientId,
            templateId,
            employmentType,
            position: a.position,
            startDate: a.startDate,
          });
          results.push({
            email: a.email,
            ok: true,
            applicationId: r.applicationId,
            invitedUserId: r.invitedUserId,
            inviteUrl: r.inviteUrl,
            errorCode: null,
            errorMessage: null,
          });
          succeeded++;
        } catch (err) {
          const code = err instanceof HttpError ? err.code : 'invite_failed';
          const message = err instanceof Error ? err.message : String(err);
          results.push({
            email: a.email,
            ok: false,
            applicationId: null,
            invitedUserId: null,
            inviteUrl: null,
            errorCode: code,
            errorMessage: message,
          });
          failed++;
        }
      }

      const body: BulkInviteResponse = { succeeded, failed, results };
      // 207 Multi-Status would be more correct when both succeeded + failed
      // are non-zero, but a flat 200 keeps client error handling simpler.
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);

/* BULK RESEND INVITE (HR/Ops only, Phase 58) --------------------------- */
// Re-rotates invite tokens + sends a fresh invite email for many
// applications at once. Same semantics per row as resend-invite — ACTIVE
// users are skipped with a 409 in the row error.
onboardingRouter.post(
  '/applications/bulk-resend',
  MANAGE,
  async (req, res, next) => {
    try {
      const parsed = BulkResendInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const { applicationIds } = parsed.data;

      const results: BulkResendResultRow[] = [];
      let succeeded = 0;
      let failed = 0;

      for (const applicationId of applicationIds) {
        try {
          const app = await assertCanModifyApplication(prisma, req.user!, applicationId);
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
            metadata: { invitedUserId: user.id, externalRef: result.externalRef, bulk: true },
            req,
          });
          results.push({
            applicationId,
            ok: true,
            invitedUserId: user.id,
            errorCode: null,
            errorMessage: null,
          });
          succeeded++;
        } catch (err) {
          const code = err instanceof HttpError ? err.code : 'resend_failed';
          const message = err instanceof Error ? err.message : String(err);
          results.push({
            applicationId,
            ok: false,
            invitedUserId: null,
            errorCode: code,
            errorMessage: message,
          });
          failed++;
        }
      }

      const body: BulkResendResponse = { succeeded, failed, results };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  }
);

/* NUDGE EMAIL (HR/Ops only, Phase 58) ---------------------------------- */
// HR-composed email to an associate mid-onboarding. Different from a
// resend (which rotates tokens) — this is a free-form prod nudge: "you
// still owe us your W-4". Logged as category=onboarding.nudge so we can
// rate-limit later if needed.
onboardingRouter.post(
  '/applications/:id/nudge',
  MANAGE,
  async (req, res, next) => {
    try {
      const parsed = NudgeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const { subject, body } = parsed.data;
      const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
      const user = await prisma.user.findFirst({
        where: { associateId: app.associateId },
      });
      if (!user || !user.email) {
        throw new HttpError(404, 'no_recipient', 'No recipient found for this associate');
      }

      let emailRef: string | null = null;
      let emailFailed: string | null = null;
      try {
        const r = await send({
          channel: 'EMAIL',
          recipient: { userId: user.id, phone: null, email: user.email },
          subject,
          body,
        });
        emailRef = r.externalRef;
      } catch (err) {
        emailFailed = err instanceof Error ? err.message : String(err);
      }

      const notif = await prisma.notification.create({
        data: {
          channel: 'EMAIL',
          status: emailFailed ? 'FAILED' : 'SENT',
          recipientUserId: user.id,
          recipientEmail: user.email,
          subject,
          body,
          category: 'onboarding.nudge',
          externalRef: emailRef,
          failureReason: emailFailed,
          sentAt: emailFailed ? null : new Date(),
          senderUserId: req.user!.id,
        },
      });

      await recordOnboardingEvent({
        actorUserId: req.user!.id,
        action: 'onboarding.nudge_sent',
        applicationId: app.id,
        clientId: app.clientId,
        metadata: {
          recipientEmail: user.email,
          subject,
          notificationId: notif.id,
          emailFailed,
        },
        req,
      });

      const response: NudgeResponse = {
        ok: true,
        recipientEmail: user.email,
        notificationId: notif.id,
        emailSent: emailFailed === null,
      };
      res.status(200).json(response);
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

      void notifyHrOnApplicationComplete(app.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
