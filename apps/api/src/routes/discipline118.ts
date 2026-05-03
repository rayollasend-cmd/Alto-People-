import { Router } from 'express';
import { z } from 'zod';
import { ROLE_LABELS } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { notifyAssociate, notifyManager } from '../lib/notify.js';
import {
  disciplineAssociateTemplate,
  disciplineManagerTemplate,
} from '../lib/emailTemplates.js';
import { env } from '../config/env.js';

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

discipline118Router.get('/disciplinary-actions', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const status = z
    .enum(['ACTIVE', 'ACKNOWLEDGED', 'RESCINDED'])
    .optional()
    .parse(req.query.status);
  const kind = KIND.optional().parse(req.query.kind);

  const rows = await prisma.disciplinaryAction.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      issuedBy: { select: { email: true } },
      rescindedBy: { select: { email: true } },
    },
    orderBy: { effectiveDate: 'desc' },
  });
  res.json({
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
    })),
  });
});

// ----- Per-associate ladder rollup -----------------------------------------

discipline118Router.get(
  '/disciplinary-actions/ladder/:associateId',
  VIEW,
  async (req, res) => {
    const associateId = z.string().uuid().parse(req.params.associateId);
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
    const actorRole = actor?.role ? ROLE_LABELS[actor.role] : 'HR Administrator';
    const assocTpl = disciplineAssociateTemplate({
      firstName: associate.firstName,
      kindLabel,
      effectiveDate: input.effectiveDate,
      incidentDate: input.incidentDate,
      suspensionDays: input.suspensionDays ?? null,
      description: input.description,
      expectedAction: input.expectedAction ?? null,
      actor: { name: actorName, role: actorRole },
      disciplineUrl: `${env.APP_BASE_URL}/me/discipline/${created.id}`,
    });
    void notifyAssociate(input.associateId, {
      subject: assocTpl.subject,
      body: assocTpl.text,
      html: assocTpl.html,
      category: 'discipline',
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
    });
    res.status(201).json({ id: created.id });
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
