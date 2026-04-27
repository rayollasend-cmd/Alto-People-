import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 124 — Knowledge base / FAQ.
 *
 * Read open to authenticated associates (the search/list filters out
 * non-PUBLISHED automatically). Write/publish/archive gated by
 * manage:onboarding (HR/admin owns content).
 */

export const kb124Router = Router();

const MANAGE = requireCapability('manage:onboarding');

// ----- Search / list (PUBLISHED only for associates) -----------------------

kb124Router.get('/kb/articles', requireAuth, async (req, res) => {
  const q = z.string().max(200).optional().parse(req.query.q);
  const category = z.string().max(60).optional().parse(req.query.category);
  const tag = z.string().max(60).optional().parse(req.query.tag);

  const rows = await prisma.kbArticle.findMany({
    where: {
      status: 'PUBLISHED',
      ...(category ? { category } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { body: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { views: 'desc' },
    take: 50,
  });
  res.json({
    articles: rows.map((a) => ({
      id: a.id,
      slug: a.slug,
      title: a.title,
      category: a.category,
      tags: a.tags,
      views: a.views,
      helpful: a.helpful,
      notHelpful: a.notHelpful,
      publishedAt: a.publishedAt?.toISOString() ?? null,
    })),
  });
});

// ----- Categories rollup ---------------------------------------------------

kb124Router.get('/kb/categories', requireAuth, async (_req, res) => {
  const groups = await prisma.kbArticle.groupBy({
    by: ['category'],
    where: { status: 'PUBLISHED' },
    _count: { _all: true },
  });
  res.json({
    categories: groups
      .map((g) => ({ category: g.category, count: g._count._all }))
      .sort((a, b) => b.count - a.count),
  });
});

// ----- Article detail by slug ----------------------------------------------

kb124Router.get('/kb/articles/:slug', requireAuth, async (req, res) => {
  const slug = z.string().max(200).parse(req.params.slug);
  const a = await prisma.kbArticle.findFirst({
    where: { slug, status: 'PUBLISHED' },
  });
  if (!a) {
    throw new HttpError(404, 'not_found', 'Article not found.');
  }
  // Bump view counter (best-effort).
  await prisma.kbArticle.update({
    where: { id: a.id },
    data: { views: { increment: 1 } },
  });
  // Did the requester vote already?
  let myVote: { helpful: boolean } | null = null;
  if (req.user!.associateId) {
    const f = await prisma.kbFeedback.findUnique({
      where: {
        articleId_associateId: {
          articleId: a.id,
          associateId: req.user!.associateId,
        },
      },
    });
    if (f) myVote = { helpful: f.helpful };
  }
  res.json({
    id: a.id,
    slug: a.slug,
    title: a.title,
    category: a.category,
    tags: a.tags,
    body: a.body,
    views: a.views + 1,
    helpful: a.helpful,
    notHelpful: a.notHelpful,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    myVote,
  });
});

// ----- Feedback (helpful / not helpful) ------------------------------------

const FeedbackInputSchema = z.object({
  helpful: z.boolean(),
  comment: z.string().max(2000).optional().nullable(),
});

kb124Router.post(
  '/kb/articles/:id/feedback',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!req.user!.associateId) {
      throw new HttpError(
        403,
        'no_associate_record',
        'Only associates can vote.',
      );
    }
    const input = FeedbackInputSchema.parse(req.body);
    const article = await prisma.kbArticle.findUnique({ where: { id } });
    if (!article) {
      throw new HttpError(404, 'not_found', 'Article not found.');
    }
    // Upsert vote; rebalance counters in a transaction so a flipped vote
    // doesn't double-count.
    await prisma.$transaction(async (tx) => {
      const existing = await tx.kbFeedback.findUnique({
        where: {
          articleId_associateId: {
            articleId: id,
            associateId: req.user!.associateId!,
          },
        },
      });
      if (existing) {
        if (existing.helpful === input.helpful) {
          // No change.
          return;
        }
        // Flip: decrement old, increment new.
        await tx.kbArticle.update({
          where: { id },
          data: existing.helpful
            ? { helpful: { decrement: 1 }, notHelpful: { increment: 1 } }
            : { notHelpful: { decrement: 1 }, helpful: { increment: 1 } },
        });
        await tx.kbFeedback.update({
          where: { id: existing.id },
          data: { helpful: input.helpful, comment: input.comment ?? null },
        });
      } else {
        await tx.kbFeedback.create({
          data: {
            articleId: id,
            associateId: req.user!.associateId!,
            helpful: input.helpful,
            comment: input.comment ?? null,
          },
        });
        await tx.kbArticle.update({
          where: { id },
          data: input.helpful
            ? { helpful: { increment: 1 } }
            : { notHelpful: { increment: 1 } },
        });
      }
    });
    res.json({ ok: true });
  },
);

// ----- Admin: list all (incl. drafts) --------------------------------------

kb124Router.get('/kb/admin/articles', MANAGE, async (req, res) => {
  const status = z
    .enum(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.kbArticle.findMany({
    where: status ? { status } : {},
    include: {
      client: { select: { name: true } },
      author: { select: { email: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({
    articles: rows.map((a) => ({
      id: a.id,
      slug: a.slug,
      title: a.title,
      category: a.category,
      status: a.status,
      tags: a.tags,
      views: a.views,
      helpful: a.helpful,
      notHelpful: a.notHelpful,
      clientName: a.client?.name ?? null,
      authorEmail: a.author?.email ?? null,
      updatedAt: a.updatedAt.toISOString(),
    })),
  });
});

// ----- Create --------------------------------------------------------------

const CreateInputSchema = z.object({
  clientId: z.string().uuid().optional().nullable(),
  title: z.string().min(3).max(200),
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, digits, and hyphens.'),
  body: z.string().min(1).max(50000),
  category: z.string().min(1).max(60),
  tags: z.array(z.string().max(60)).max(20).default([]),
});

kb124Router.post('/kb/articles', MANAGE, async (req, res) => {
  const input = CreateInputSchema.parse(req.body);
  try {
    const created = await prisma.kbArticle.create({
      data: {
        clientId: input.clientId ?? null,
        title: input.title,
        slug: input.slug,
        body: input.body,
        category: input.category,
        tags: input.tags,
        authorId: req.user!.id,
      },
    });
    res.status(201).json({ id: created.id });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      throw new HttpError(409, 'duplicate_slug', 'Slug already exists.');
    }
    throw err;
  }
});

// ----- Update --------------------------------------------------------------

const UpdateInputSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  body: z.string().min(1).max(50000).optional(),
  category: z.string().min(1).max(60).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
});

kb124Router.patch('/kb/articles/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = UpdateInputSchema.parse(req.body);
  const a = await prisma.kbArticle.findUnique({ where: { id } });
  if (!a) {
    throw new HttpError(404, 'not_found', 'Article not found.');
  }
  await prisma.kbArticle.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    },
  });
  res.json({ ok: true });
});

// ----- Publish / archive ---------------------------------------------------

kb124Router.post('/kb/articles/:id/publish', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const a = await prisma.kbArticle.findUnique({ where: { id } });
  if (!a) {
    throw new HttpError(404, 'not_found', 'Article not found.');
  }
  await prisma.kbArticle.update({
    where: { id },
    data: {
      status: 'PUBLISHED',
      publishedAt: a.publishedAt ?? new Date(),
    },
  });
  res.json({ ok: true });
});

kb124Router.post('/kb/articles/:id/archive', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const a = await prisma.kbArticle.findUnique({ where: { id } });
  if (!a) {
    throw new HttpError(404, 'not_found', 'Article not found.');
  }
  await prisma.kbArticle.update({
    where: { id },
    data: { status: 'ARCHIVED' },
  });
  res.json({ ok: true });
});

// ----- Delete --------------------------------------------------------------

kb124Router.delete('/kb/articles/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const a = await prisma.kbArticle.findUnique({ where: { id } });
  if (!a) {
    throw new HttpError(404, 'not_found', 'Article not found.');
  }
  await prisma.kbArticle.delete({ where: { id } });
  res.status(204).end();
});
