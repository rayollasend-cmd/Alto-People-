import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  ASSOCIATE_CTX_SELECT,
  fileOfferLetterPdf,
  renderTemplateTokens as render,
  toAssociateCtx,
  type AssociateCtxRow,
} from '../lib/offerLetters.js';

/**
 * Phase 89 — Mail-merge document templates with versioned snapshots.
 *
 * Lifecycle: create template → save versions → publish a version
 * (becomes currentVersionId) → render against an associate.
 *
 * Token syntax in template body: {{ path.to.value }}. The renderer walks
 * dot paths into the supplied data object and substitutes — falling back
 * to "" for missing keys (with a warning header in dev mode).
 */

export const docTemplatesRouter = Router();

// Templates are an HR-admin authoring tool. Gate reads on view:hr-admin
// so associates with view:documents (their own personal docs page)
// can't enumerate offer-letter / termination-letter templates.
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:documents');

// Token renderer lives in lib/offerLetters.ts (shared with the approval
// hook and the backfill sweep) — imported above as `render`.

// ----- Templates ---------------------------------------------------------

const TemplateInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  kind: z
    .enum([
      'OFFER_LETTER',
      'POLICY',
      'NDA',
      'PROMOTION_LETTER',
      'TERMINATION_LETTER',
      'WARNING_LETTER',
      'GENERIC',
    ])
    .optional(),
});

const VersionInputSchema = z.object({
  subject: z.string().max(500).optional().nullable(),
  body: z.string().min(1).max(200000),
  variables: z.record(z.string(), z.unknown()).optional(),
});

docTemplatesRouter.get('/document-templates', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.documentTemplate.findMany({
    take: 1000,
    where: {
      deletedAt: null,
      ...(clientId
        ? { OR: [{ clientId }, { clientId: null }] }
        : {}),
    },
    include: {
      currentVersion: {
        select: { id: true, version: true, publishedAt: true },
      },
      _count: { select: { versions: true, renders: true } },
    },
    orderBy: { name: 'asc' },
  });
  res.json({
    templates: rows.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      name: t.name,
      kind: t.kind,
      currentVersion: t.currentVersion?.version ?? null,
      currentVersionId: t.currentVersionId,
      versionCount: t._count.versions,
      renderCount: t._count.renders,
      updatedAt: t.updatedAt.toISOString(),
    })),
  });
});

docTemplatesRouter.post('/document-templates', MANAGE, async (req, res) => {
  const input = TemplateInputSchema.parse(req.body);
  const created = await prisma.documentTemplate.create({
    data: {
      clientId: input.clientId ?? null,
      name: input.name,
      kind: input.kind ?? 'GENERIC',
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

docTemplatesRouter.delete(
  '/document-templates/:id',
  MANAGE,
  async (req, res) => {
    const id = req.params.id;
    await prisma.documentTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  },
);

docTemplatesRouter.get(
  '/document-templates/:id/versions',
  VIEW,
  async (req, res) => {
    const templateId = req.params.id;
    const rows = await prisma.documentTemplateVersion.findMany({
      take: 500,
      where: { templateId },
      orderBy: { version: 'desc' },
    });
    res.json({
      versions: rows.map((v) => ({
        id: v.id,
        version: v.version,
        subject: v.subject,
        body: v.body,
        variables: v.variables,
        publishedAt: v.publishedAt?.toISOString() ?? null,
      })),
    });
  },
);

/**
 * Save a new version. Auto-increments version number per template.
 * Always saved as DRAFT (publishedAt null) — must be explicitly
 * published to become currentVersionId.
 */
docTemplatesRouter.post(
  '/document-templates/:id/versions',
  MANAGE,
  async (req, res) => {
    const templateId = req.params.id;
    const input = VersionInputSchema.parse(req.body);
    const t = await prisma.documentTemplate.findUnique({
      where: { id: templateId },
    });
    if (!t || t.deletedAt) throw new HttpError(404, 'not_found', 'Template not found.');
    const last = await prisma.documentTemplateVersion.findFirst({
      where: { templateId },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (last?.version ?? 0) + 1;
    const created = await prisma.documentTemplateVersion.create({
      data: {
        templateId,
        version: nextVersion,
        subject: input.subject ?? null,
        body: input.body,
        variables: (input.variables ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
    res.status(201).json({ id: created.id, version: nextVersion });
  },
);

docTemplatesRouter.post(
  '/document-templates/:id/versions/:versionId/publish',
  MANAGE,
  async (req, res) => {
    const { id, versionId } = req.params;
    const v = await prisma.documentTemplateVersion.findUnique({
      where: { id: versionId },
    });
    if (!v || v.templateId !== id) {
      throw new HttpError(404, 'not_found', 'Version not found.');
    }
    await prisma.$transaction(async (tx) => {
      await tx.documentTemplateVersion.update({
        where: { id: versionId },
        data: { publishedAt: new Date(), publishedById: req.user!.id },
      });
      await tx.documentTemplate.update({
        where: { id },
        data: { currentVersionId: versionId },
      });
    });
    res.json({ ok: true });
  },
);

// ----- Render ------------------------------------------------------------

const RenderSchema = z.object({
  associateId: z.string().uuid().optional().nullable(),
  // versionId optional: defaults to template.currentVersionId.
  versionId: z.string().uuid().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

docTemplatesRouter.post(
  '/document-templates/:id/render',
  VIEW,
  async (req, res) => {
    const templateId = req.params.id;
    const input = RenderSchema.parse(req.body);
    const t = await prisma.documentTemplate.findUnique({
      where: { id: templateId },
    });
    if (!t || t.deletedAt) throw new HttpError(404, 'not_found', 'Template not found.');
    const versionId = input.versionId ?? t.currentVersionId;
    if (!versionId) {
      throw new HttpError(
        400,
        'no_version',
        'Template has no current version. Publish a version first.',
      );
    }
    const v = await prisma.documentTemplateVersion.findUnique({
      where: { id: versionId },
    });
    if (!v) throw new HttpError(404, 'not_found', 'Version not found.');

    // Build render context: associate (if any) + custom data.
    let associate: unknown = null;
    let associateRow: AssociateCtxRow | null = null;
    if (input.associateId) {
      const a = await prisma.associate.findUnique({
        where: { id: input.associateId },
        select: ASSOCIATE_CTX_SELECT,
      });
      if (!a) throw new HttpError(404, 'not_found', 'Associate not found.');
      associateRow = a;
      associate = toAssociateCtx(a);
    }
    const ctx = { associate, ...(input.data ?? {}) };
    const bodyResult = render(v.body, ctx);
    const subjectResult = v.subject ? render(v.subject, ctx) : null;
    const renderedBody = bodyResult.text;
    const renderedSubject = subjectResult?.text ?? null;
    const unresolvedTokens = [
      ...new Set([
        ...bodyResult.unresolvedTokens,
        ...(subjectResult?.unresolvedTokens ?? []),
      ]),
    ];

    const created = await prisma.documentRender.create({
      data: {
        templateId,
        versionId,
        associateId: input.associateId ?? null,
        renderedSubject,
        renderedBody,
        data: ctx as Prisma.InputJsonValue,
        renderedById: req.user!.id,
      },
    });

    // Close the loop for offer letters: the render used to live only in the
    // template's history — no file was ever placed on the associate's
    // record, so the compliance scorecard's "Offer letter on file" signal
    // (which counts filed OFFER_LETTER documents, per the Walmart MSA
    // clause) sat at 0% forever even for orgs generating letters here.
    // Rendering an OFFER_LETTER template against an associate now also
    // files the letter as a PDF in their vault. Vault writes stay behind
    // manage:documents — this route's VIEW gate admits read-only roles
    // (EXECUTIVE_CHAIRMAN), who keep the render but must not create
    // documents.
    let filedDocumentId: string | null = null;
    if (
      t.kind === 'OFFER_LETTER' &&
      associateRow &&
      hasCapability(req.user!.role, 'manage:documents')
    ) {
      filedDocumentId = await fileOfferLetterPdf({
        templateId,
        templateClientId: t.clientId,
        renderId: created.id,
        title: renderedSubject?.trim() || t.name,
        body: renderedBody,
        associate: associateRow,
        userId: req.user!.id,
        req,
      });
    }

    res.status(201).json({
      id: created.id,
      renderedSubject,
      renderedBody,
      // Tokens that resolved to NOTHING — the UI must show these so a
      // typo'd path can't silently blank a field in an offer letter.
      unresolvedTokens,
      // Non-null when the render was also filed to the associate's vault
      // (offer letters) — the UI confirms it so HR knows the scorecard and
      // audit packet now carry the letter.
      filedDocumentId,
    });
  },
);

/**
 * POST /document-templates/:id/bulk-render-missing
 *
 * Backfill for the compliance scorecard's "Offer letter on file" signal:
 * renders THIS offer-letter template for every associate in the
 * scorecard's population (most-recent application APPROVED) who has no
 * OFFER_LETTER document on file, filing each letter exactly like the
 * single render does.
 *
 * Skips — never files — any associate whose render leaves unresolved
 * tokens: mass-filing letters with blanked fields as VERIFIED compliance
 * evidence would be worse than the 0% it fixes. The response names them
 * (and the tokens) so HR can fix the data or the template and run again.
 *
 * MANAGE (manage:documents): this is a vault write, not a preview.
 * Capped per run; re-running continues where it stopped (already-filed
 * associates drop out of "missing").
 */
const BULK_RENDER_CAP = 200;

docTemplatesRouter.post(
  '/document-templates/:id/bulk-render-missing',
  MANAGE,
  async (req, res) => {
    const templateId = req.params.id;
    const t = await prisma.documentTemplate.findUnique({ where: { id: templateId } });
    if (!t || t.deletedAt) throw new HttpError(404, 'not_found', 'Template not found.');
    if (t.kind !== 'OFFER_LETTER') {
      throw new HttpError(
        400,
        'not_offer_letter',
        'Bulk generation is only for offer-letter templates.',
      );
    }
    if (!t.currentVersionId) {
      throw new HttpError(
        400,
        'no_version',
        'Template has no current version. Publish a version first.',
      );
    }
    const v = await prisma.documentTemplateVersion.findUniqueOrThrow({
      where: { id: t.currentVersionId },
    });

    // Same population as the scorecard tile: most-recent-application
    // APPROVED (deduped). Anyone else isn't counted by the signal, so
    // generating for them wouldn't move the number HR is looking at.
    const apps = await prisma.application.findMany({
      take: 500,
      where: { status: 'APPROVED', deletedAt: null, associate: { deletedAt: null } },
      select: { associateId: true },
      orderBy: { createdAt: 'desc' },
    });
    const populationIds = [...new Set(apps.map((a) => a.associateId))];

    const existing = await prisma.documentRecord.findMany({
      take: 1000,
      where: {
        associateId: { in: populationIds },
        kind: 'OFFER_LETTER',
        deletedAt: null,
      },
      select: { associateId: true },
    });
    const hasLetter = new Set(existing.map((d) => d.associateId));
    const missingIds = populationIds.filter((id) => !hasLetter.has(id));
    const batch = missingIds.slice(0, BULK_RENDER_CAP);

    let generated = 0;
    const skipped: Array<{ associateId: string; associateName: string; reason: string }> = [];

    // Sequential on purpose: each letter is a PDF render + blob write +
    // two audited inserts, and a 200-wide Promise.all would spike the
    // event loop and the DB for no user-visible win on an admin action.
    for (const associateId of batch) {
      const a = await prisma.associate.findUnique({
        where: { id: associateId },
        select: ASSOCIATE_CTX_SELECT,
      });
      if (!a) continue;
      const name = `${a.firstName} ${a.lastName}`;
      try {
        const ctx = { associate: toAssociateCtx(a) };
        const bodyResult = render(v.body, ctx);
        const subjectResult = v.subject ? render(v.subject, ctx) : null;
        const unresolved = [
          ...new Set([
            ...bodyResult.unresolvedTokens,
            ...(subjectResult?.unresolvedTokens ?? []),
          ]),
        ];
        if (unresolved.length > 0) {
          skipped.push({
            associateId,
            associateName: name,
            reason: `unresolved tokens: ${unresolved.join(', ')}`,
          });
          continue;
        }
        const createdRender = await prisma.documentRender.create({
          data: {
            templateId,
            versionId: v.id,
            associateId,
            renderedSubject: subjectResult?.text ?? null,
            renderedBody: bodyResult.text,
            data: ctx as Prisma.InputJsonValue,
            renderedById: req.user!.id,
          },
        });
        await fileOfferLetterPdf({
          templateId,
          templateClientId: t.clientId,
          renderId: createdRender.id,
          title: subjectResult?.text.trim() || t.name,
          body: bodyResult.text,
          associate: a,
          userId: req.user!.id,
          req,
        });
        generated += 1;
      } catch (err) {
        // One bad row must not sink the batch — report and continue.
        skipped.push({
          associateId,
          associateName: name,
          reason: err instanceof Error ? err.message : 'failed',
        });
      }
    }

    res.json({
      missingBefore: missingIds.length,
      generated,
      skippedCount: skipped.length,
      // Capped detail — enough for HR to act on without a giant payload.
      skipped: skipped.slice(0, 25),
      // Missing rows beyond this run's cap — "run again" continues.
      remaining: Math.max(0, missingIds.length - batch.length),
    });
  },
);

docTemplatesRouter.get(
  '/document-templates/:id/renders',
  VIEW,
  async (req, res) => {
    const templateId = req.params.id;
    const rows = await prisma.documentRender.findMany({
      where: { templateId },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        version: { select: { version: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({
      renders: rows.map((r) => ({
        id: r.id,
        version: r.version.version,
        associateName: r.associate
          ? `${r.associate.firstName} ${r.associate.lastName}`
          : null,
        renderedSubject: r.renderedSubject,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);
