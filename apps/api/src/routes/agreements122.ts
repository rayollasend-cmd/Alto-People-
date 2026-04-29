import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 122 — Per-associate legal agreements.
 *
 * Issue + manage gated by manage:documents (HR/legal). Sign route is open
 * to authenticated users — the route checks the subject is the associate
 * being asked to sign.
 */

export const agreements122Router = Router();

// VIEW gates org-wide reads on view:hr-admin so non-admin roles
// (associate / client_portal) can't enumerate every agreement.
// Subjects still see their own pending list via /my/agreements.
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:documents');

const KIND = z.enum([
  'NDA',
  'NON_COMPETE',
  'IP_ASSIGNMENT',
  'ARBITRATION',
  'EMPLOYMENT_OFFER',
  'SEPARATION_AGREEMENT',
  'EQUITY_GRANT',
  'OTHER',
]);

// ----- List ----------------------------------------------------------------

agreements122Router.get('/agreements', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const kind = KIND.optional().parse(req.query.kind);
  const status = z
    .enum(['PENDING_SIGNATURE', 'SIGNED', 'EXPIRED', 'SUPERSEDED'])
    .optional()
    .parse(req.query.status);

  const rows = await prisma.agreement.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      issuedBy: { select: { email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    agreements: rows.map((a) => ({
      id: a.id,
      associateId: a.associateId,
      associateName: `${a.associate.firstName} ${a.associate.lastName}`,
      associateEmail: a.associate.email,
      kind: a.kind,
      customLabel: a.customLabel,
      status: a.status,
      documentUrl: a.documentUrl,
      effectiveDate: a.effectiveDate?.toISOString().slice(0, 10) ?? null,
      expiresOn: a.expiresOn?.toISOString().slice(0, 10) ?? null,
      signedAt: a.signedAt?.toISOString() ?? null,
      signature: a.signature,
      supersedesId: a.supersedesId,
      notes: a.notes,
      issuedByEmail: a.issuedBy?.email ?? null,
    })),
  });
});

// ----- My pending ----------------------------------------------------------

agreements122Router.get(
  '/my/agreements',
  requireAuth,
  async (req, res) => {
    if (!req.user!.associateId) {
      return res.json({ agreements: [] });
    }
    const rows = await prisma.agreement.findMany({
      where: { associateId: req.user!.associateId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      agreements: rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        customLabel: a.customLabel,
        status: a.status,
        documentUrl: a.documentUrl,
        effectiveDate: a.effectiveDate?.toISOString().slice(0, 10) ?? null,
        expiresOn: a.expiresOn?.toISOString().slice(0, 10) ?? null,
        signedAt: a.signedAt?.toISOString() ?? null,
        notes: a.notes,
      })),
    });
  },
);

// ----- Issue ---------------------------------------------------------------

const IssueInputSchema = z.object({
  associateId: z.string().uuid(),
  kind: KIND,
  customLabel: z.string().max(120).optional().nullable(),
  documentUrl: z.string().url().max(500).optional().nullable(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  supersedesId: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

agreements122Router.post('/agreements', MANAGE, async (req, res) => {
  const input = IssueInputSchema.parse(req.body);
  if (input.kind === 'OTHER' && !input.customLabel) {
    throw new HttpError(
      400,
      'custom_label_required',
      'OTHER kind requires customLabel.',
    );
  }
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }
  const created = await prisma.$transaction(async (tx) => {
    if (input.supersedesId) {
      await tx.agreement.update({
        where: { id: input.supersedesId },
        data: { status: 'SUPERSEDED' },
      });
    }
    return tx.agreement.create({
      data: {
        associateId: input.associateId,
        kind: input.kind,
        customLabel: input.customLabel ?? null,
        documentUrl: input.documentUrl ?? null,
        effectiveDate: input.effectiveDate
          ? new Date(input.effectiveDate)
          : null,
        expiresOn: input.expiresOn ? new Date(input.expiresOn) : null,
        supersedesId: input.supersedesId ?? null,
        notes: input.notes ?? null,
        issuedById: req.user!.id,
      },
    });
  });
  res.status(201).json({ id: created.id });
});

// ----- Sign (subject self-serve) -------------------------------------------

const SignInputSchema = z.object({
  signature: z.string().min(1).max(200),
});

agreements122Router.post(
  '/agreements/:id/sign',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = SignInputSchema.parse(req.body);
    const a = await prisma.agreement.findUnique({ where: { id } });
    if (!a) {
      throw new HttpError(404, 'not_found', 'Agreement not found.');
    }
    if (a.status !== 'PENDING_SIGNATURE') {
      throw new HttpError(
        409,
        'not_pending',
        `Agreement is ${a.status}, cannot sign.`,
      );
    }
    if (req.user!.associateId !== a.associateId) {
      throw new HttpError(
        403,
        'not_subject',
        'Only the subject associate can sign.',
      );
    }
    await prisma.agreement.update({
      where: { id },
      data: {
        status: 'SIGNED',
        signedAt: new Date(),
        signature: input.signature,
        // If effectiveDate wasn't pre-set, default to today.
        effectiveDate: a.effectiveDate ?? new Date(),
      },
    });
    res.json({ ok: true });
  },
);

// ----- Mark expired (HR housekeeping) --------------------------------------

agreements122Router.post(
  '/agreements/:id/expire',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const a = await prisma.agreement.findUnique({ where: { id } });
    if (!a) {
      throw new HttpError(404, 'not_found', 'Agreement not found.');
    }
    if (a.status === 'EXPIRED' || a.status === 'SUPERSEDED') {
      throw new HttpError(409, 'terminal', `Already ${a.status}.`);
    }
    await prisma.agreement.update({
      where: { id },
      data: { status: 'EXPIRED' },
    });
    res.json({ ok: true });
  },
);

// ----- Delete --------------------------------------------------------------

agreements122Router.delete('/agreements/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const a = await prisma.agreement.findUnique({ where: { id } });
  if (!a) {
    throw new HttpError(404, 'not_found', 'Agreement not found.');
  }
  await prisma.agreement.delete({ where: { id } });
  res.status(204).end();
});
