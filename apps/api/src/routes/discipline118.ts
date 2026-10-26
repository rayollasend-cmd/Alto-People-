import { Router } from 'express';
import { z } from 'zod';
import { ROLE_LABELS } from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { scopeAssociatesIncludingFormer } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { notifyAssociate, notifyManager } from '../lib/notify.js';
import { enqueueAudit } from '../lib/audit.js';
import {
  disciplineAssociateTemplate,
  disciplineManagerTemplate,
} from '../lib/emailTemplates.js';
import { publicBaseUrl } from '../lib/emailLayout.js';

/**
 * Phase 118 — Disciplinary action log.
 *
 * Read/write reuses view:performance / manage:performance for HR + managers.
 * The acknowledgment endpoint is open to authenticated users (the route
 * checks ownership via req.user.associateId).
 */

export const discipline118Router = Router();

// Reads are org-wide HR data — gate on view:hr-admin so a regular
// associate can't enumerate every warning/suspension/termination.
// Subjects still acknowledge their own actions via the requireAuth
// /:id/acknowledge endpoint below.
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:performance');

const KIND = z.enum([
  'VERBAL_WARNING',
  'WRITTEN_WARNING',
  'FINAL_WARNING',
  'SUSPENSION',
  'TERMINATION',
]);

// ----- List ----------------------------------------------------------------

/** Rows a discipline list draws per page. */
const ACTION_PAGE = 100;

discipline118Router.get('/disciplinary-actions', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const status = z
    .enum(['ACTIVE', 'ACKNOWLEDGED', 'RESCINDED'])
    .optional()
    .parse(req.query.status);
  // ?state=in-force — every action not rescinded (awaiting acknowledgment or acknowledged).
  const state = z.enum(['in-force']).optional().parse(req.query.state);
  const kind = KIND.optional().parse(req.query.kind);

  const page = z.coerce.number().int().min(0).max(10_000).default(0).parse(req.query.page);
  const where: Prisma.DisciplinaryActionWhereInput = {
    AND: [
      // This tenant's, for people (current or former) inside the caller's reach.
      { tenantId: tenantIdForWrite(), associate: scopeAssociatesIncludingFormer(req.user!) },
      associateId ? { associateId } : {},
      status ? { status } : {},
      state === 'in-force' ? { status: { in: ['ACTIVE', 'ACKNOWLEDGED'] as const } } : {},
      kind ? { kind } : {},
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.disciplinaryAction.findMany({
    take: ACTION_PAGE,
    skip: page * ACTION_PAGE,
    where,
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      issuedBy: { select: { email: true } },
      rescindedBy: { select: { email: true } },
    },
    orderBy: [{ effectiveDate: 'desc' }, { id: 'asc' }],
    }),
    prisma.disciplinaryAction.count({ where }),
  ]);
  res.json({
    total,
    page,
    hasMore: (page + 1) * ACTION_PAGE < total,
    actions: rows.map((a) => ({
      id: a.id,
      associateId: a.associateId,
      associateName: `${a.associate.firstName} ${a.associate.lastName}`,
      associateEmail: a.associate.email,
      kind: a.kind,
      status: a.status,
      incidentDate: a.incidentDate.toISOString().slice(0, 10),
      effectiveDate: a.effectiveDate.toISOString().slice(0, 10),
      suspensionDays: a.suspensionDays,
      description: a.description,
      expectedAction: a.expectedAction,
      issuedByEmail: a.issuedBy?.email ?? null,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      acknowledgedSig: a.acknowledgedSig,
      rescindedAt: a.rescindedAt?.toISOString() ?? null,
      rescindedReason: a.rescindedReason,
      rescindedByEmail: a.rescindedBy?.email ?? null,
      // The employee's own side (F500 G5), shown to HR on the action.
      employeeResponse: a.employeeResponse,
      employeeRespondedAt: a.employeeRespondedAt?.toISOString() ?? null,
    })),
  });
});

// ----- Summary ---------------------------------------------------------------
//
// The log's numbers (F500 2026-10-22: the page had none): actions in force
// (not rescinded), those still awaiting the person's acknowledgment, how many
// people hold a final warning in force (one step from termination), and how
// many were issued in the last 90 days. Same reach as the list.

discipline118Router.get('/disciplinary-actions/summary', VIEW, async (req, res) => {
  const reach: Prisma.DisciplinaryActionWhereInput = { tenantId: tenantIdForWrite(), associate: scopeAssociatesIncludingFormer(req.user!) };
  const since = new Date(Date.now() - 90 * 86_400_000);
  const [inForce, awaitingAck, finals, issued90d] = await Promise.all([
    prisma.disciplinaryAction.count({ where: { ...reach, status: { in: ['ACTIVE', 'ACKNOWLEDGED'] } } }),
    prisma.disciplinaryAction.count({ where: { ...reach, status: 'ACTIVE' } }),
    prisma.disciplinaryAction.findMany({ where: { ...reach, kind: 'FINAL_WARNING', status: { in: ['ACTIVE', 'ACKNOWLEDGED'] } }, select: { associateId: true }, distinct: ['associateId'], take: 10_000 }),
    prisma.disciplinaryAction.count({ where: { ...reach, createdAt: { gte: since } } }),
  ]);
  res.json({ inForce, awaitingAck, finalWarningPeople: finals.length, issued90d });
});

// ----- Per-associate ladder rollup -----------------------------------------

discipline118Router.get(
  '/disciplinary-actions/ladder/:associateId',
  VIEW,
  async (req, res) => {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertSameTenant('associate', associateId);
    const counts = await prisma.disciplinaryAction.groupBy({
      by: ['kind'],
      where: { associateId, status: { not: 'RESCINDED' } },
      _count: { _all: true },
    });
    const ladder: Record<string, number> = {
      VERBAL_WARNING: 0,
      WRITTEN_WARNING: 0,
      FINAL_WARNING: 0,
      SUSPENSION: 0,
      TERMINATION: 0,
    };
    for (const c of counts) ladder[c.kind] = c._count._all;
    res.json({ associateId, ladder });
  },
);

// ----- Issue ---------------------------------------------------------------

const IssueInputSchema = z.object({
  associateId: z.string().uuid(),
  kind: KIND,
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  suspensionDays: z.number().int().min(1).max(365).optional().nullable(),
  description: z.string().min(1).max(4000),
  expectedAction: z.string().max(2000).optional().nullable(),
});

discipline118Router.post(
  '/disciplinary-actions',
  MANAGE,
  async (req, res) => {
    const input = IssueInputSchema.parse(req.body);
    if (input.kind === 'SUSPENSION' && !input.suspensionDays) {
      throw new HttpError(
        400,
        'suspension_days_required',
        'SUSPENSION actions must include suspensionDays.',
      );
    }
    const associate = await prisma.associate.findUnique({
      where: { id: input.associateId },
    });
    if (!associate || associate.deletedAt) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found.');
    }
    const created = await prisma.disciplinaryAction.create({
      data: {
        associateId: input.associateId,
        kind: input.kind,
        incidentDate: new Date(input.incidentDate),
        effectiveDate: new Date(input.effectiveDate),
        suspensionDays: input.suspensionDays ?? null,
        description: input.description,
        expectedAction: input.expectedAction ?? null,
        issuedById: req.user!.id,
      },
    });
    const kindLabel = input.kind.replace(/_/g, ' ').toLowerCase();
    const actor = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        email: true,
        role: true,
        associate: { select: { firstName: true, lastName: true } },
      },
    });
    const actorName = actor?.associate
      ? `${actor.associate.firstName} ${actor.associate.lastName}`
      : actor?.email ?? 'HR';
    const actorRole = actor?.role ? ROLE_LABELS[actor.role] : 'HR administrator';
    const assocTpl = disciplineAssociateTemplate({
      firstName: associate.firstName,
      kindLabel,
      effectiveDate: input.effectiveDate,
      incidentDate: input.incidentDate,
      suspensionDays: input.suspensionDays ?? null,
      description: input.description,
      expectedAction: input.expectedAction ?? null,
      actor: { name: actorName, role: actorRole },
      disciplineUrl: `${publicBaseUrl()}/me/discipline/${created.id}`,
    });
    void notifyAssociate(input.associateId, {
      subject: assocTpl.subject,
      body: assocTpl.text,
      html: assocTpl.html,
      category: 'discipline',
      linkUrl: `/me/discipline/${created.id}`,
    });
    const mgrTpl = disciplineManagerTemplate({
      associateName: `${associate.firstName} ${associate.lastName}`,
      kindLabel,
      effectiveDate: input.effectiveDate,
      suspensionDays: input.suspensionDays ?? null,
      actor: { name: actorName, role: actorRole },
    });
    void notifyManager(input.associateId, {
      subject: mgrTpl.subject,
      body: mgrTpl.text,
      html: mgrTpl.html,
      category: 'discipline',
      linkUrl: `/people?associateId=${input.associateId}`,
    });
    res.status(201).json({ id: created.id });
  },
);

// ----- My actions (associate self-serve) ------------------------------------
// The subject's own view. The org-wide list above is HR-gated
// (view:hr-admin), which associates don't hold — so without this route the
// warning an associate is asked to formally acknowledge was UNREACHABLE in
// the product: notifications deep-linked to a page whose data 403'd.
discipline118Router.get(
  '/disciplinary-actions/me',
  requireAuth,
  async (req, res) => {
    const associateId = req.user!.associateId;
    if (!associateId) {
      res.json({ actions: [] });
      return;
    }
    const rows = await prisma.disciplinaryAction.findMany({
      take: 50,
      where: { associateId },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        issuedBy: { select: { email: true } },
      },
      orderBy: { effectiveDate: 'desc' },
    });
    res.json({
      actions: rows.map((a) => ({
        id: a.id,
        associateName: `${a.associate.firstName} ${a.associate.lastName}`,
        kind: a.kind,
        status: a.status,
        incidentDate: a.incidentDate.toISOString().slice(0, 10),
        effectiveDate: a.effectiveDate.toISOString().slice(0, 10),
        suspensionDays: a.suspensionDays,
        description: a.description,
        expectedAction: a.expectedAction,
        issuedByEmail: a.issuedBy?.email ?? null,
        acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
        acknowledgedSig: a.acknowledgedSig,
        rescindedAt: a.rescindedAt?.toISOString() ?? null,
        rescindedReason: a.rescindedReason,
        employeeResponse: a.employeeResponse,
        employeeRespondedAt: a.employeeRespondedAt?.toISOString() ?? null,
      })),
    });
  },
);

// ----- Respond (associate self-serve, F500 G5) ------------------------------
// Acknowledging says "I received it", not "I agree". The employee may write
// their side under a notice in force (once written, it can be rewritten while
// the notice stands); HR reads it on the action. Only the subject may write.

const ResponseInputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

discipline118Router.post(
  '/disciplinary-actions/:id/response',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = ResponseInputSchema.parse(req.body);
    const action = await prisma.disciplinaryAction.findUnique({ where: { id } });
    if (!action || req.user!.associateId !== action.associateId) {
      // Not theirs reads the same as not there: nothing about someone else's record.
      throw new HttpError(404, 'not_found', 'Action not found.');
    }
    if (action.status === 'RESCINDED') {
      throw new HttpError(409, 'rescinded', 'This notice was rescinded.');
    }
    const at = new Date();
    await prisma.disciplinaryAction.update({
      where: { id },
      data: { employeeResponse: input.text, employeeRespondedAt: at },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: null,
        tenantId: tenantIdForWrite(),
        action: 'discipline.employee_response',
        entityType: 'DisciplinaryAction',
        entityId: id,
        metadata: { length: input.text.length },
      },
      'discipline',
    );
    res.json({ ok: true, employeeRespondedAt: at.toISOString() });
  },
);

// ----- Acknowledge (associate self-serve) ----------------------------------

const AckInputSchema = z.object({
  signature: z.string().min(1).max(200),
});

discipline118Router.post(
  '/disciplinary-actions/:id/acknowledge',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = AckInputSchema.parse(req.body);
    const action = await prisma.disciplinaryAction.findUnique({
      where: { id },
    });
    if (!action) {
      throw new HttpError(404, 'not_found', 'Action not found.');
    }
    if (action.status !== 'ACTIVE') {
      throw new HttpError(
        409,
        'not_active',
        `Action is ${action.status}, cannot acknowledge.`,
      );
    }
    if (req.user!.associateId !== action.associateId) {
      throw new HttpError(
        403,
        'not_subject',
        'Only the subject associate can acknowledge.',
      );
    }
    await prisma.disciplinaryAction.update({
      where: { id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedSig: input.signature,
      },
    });
    res.json({ ok: true });
  },
);

// ----- Rescind (HR) --------------------------------------------------------

const RescindInputSchema = z.object({
  reason: z.string().min(1).max(2000),
});

discipline118Router.post(
  '/disciplinary-actions/:id/rescind',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = RescindInputSchema.parse(req.body);
    const action = await prisma.disciplinaryAction.findUnique({ where: { id } });
    if (!action) {
      throw new HttpError(404, 'not_found', 'Action not found.');
    }
    if (action.status === 'RESCINDED') {
      throw new HttpError(409, 'already_rescinded', 'Already rescinded.');
    }
    await prisma.disciplinaryAction.update({
      where: { id },
      data: {
        status: 'RESCINDED',
        rescindedAt: new Date(),
        rescindedReason: input.reason,
        rescindedById: req.user!.id,
      },
    });
    res.json({ ok: true });
  },
);
