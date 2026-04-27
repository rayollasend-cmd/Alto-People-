import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

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

const VIEW = requireCapability('view:documents');
const MANAGE = requireCapability('manage:documents');

// Token regex: {{ x }} or {{x}}. Whitespace OK; no nested braces.
const TOKEN_RE = /\{\{\s*([\w$.[\]]+)\s*\}\}/g;

function pathLookup(data: unknown, path: string): unknown {
  // Support dot + bracket index: a.b[0].c
  const parts = path.split(/\.|\[|\]/).filter(Boolean);
  let cur: unknown = data;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function render(template: string, data: unknown): string {
  return template.replace(TOKEN_RE, (_full, path: string) => {
    const v = pathLookup(data, path);
    if (v == null) return '';
    return String(v);
  });
}

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
    if (input.associateId) {
      const a = await prisma.associate.findUnique({
        where: { id: input.associateId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          state: true,
          department: { select: { name: true } },
          jobProfile: { select: { title: true } },
        },
      });
      if (!a) throw new HttpError(404, 'not_found', 'Associate not found.');
      associate = {
        ...a,
        department: a.department?.name ?? null,
        jobTitle: a.jobProfile?.title ?? null,
      };
    }
    const ctx = { associate, ...(input.data ?? {}) };
    const renderedBody = render(v.body, ctx);
    const renderedSubject = v.subject ? render(v.subject, ctx) : null;

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
    res.status(201).json({
      id: created.id,
      renderedSubject,
      renderedBody,
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
