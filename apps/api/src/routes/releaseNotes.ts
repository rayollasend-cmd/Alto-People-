import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { hasCapability, RELEASE_NOTE_AUDIENCES, type ReleaseNoteAudience, type ReleaseNoteItem } from '@alto-people/shared';
import { prisma } from '../db.js';
import { enqueueAudit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

export const releaseNotesRouter = Router();

/**
 * "WHAT'S NEW", SERVED — not compiled in.
 *
 * A release note used to be a constant in the web bundle: adding one
 * meant a deploy, and every reader saw every bullet in one language. Now
 * an admin writes the note here, each bullet names its audience, and the
 * card on every phone shows the right bullets in the reader's language
 * at the next open.
 *
 * Audience is derived from the reader's role on the server so a bullet
 * about kiosk PIN tools never reaches an associate's card, and a draft
 * (no publishedAt) is visible only to people who can write notes.
 */

const MANAGE = requireCapability('manage:org');
const MAX_NOTES = 50;

const ItemSchema = z.object({
  audience: z.enum(RELEASE_NOTE_AUDIENCES as [ReleaseNoteAudience, ...ReleaseNoteAudience[]]),
  en: z.string().trim().min(1).max(500),
  es: z.string().trim().max(500).nullable().optional().transform((v) => (v ? v : null)),
});
const InputSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(ItemSchema).min(1).max(20),
  published: z.boolean(),
});

/** Which audiences a role reads. ALL is everyone; the rest are exclusive. */
export function audiencesFor(role: string): Set<ReleaseNoteAudience> {
  const out = new Set<ReleaseNoteAudience>(['ALL']);
  if (role === 'ASSOCIATE') out.add('ASSOCIATE');
  else if (role === 'DRIVER') out.add('DRIVER');
  else if (role === 'SHIFT_SUPERVISOR' || role === 'FLOOR_SUPERVISOR') out.add('SUPERVISOR');
  else if (role === 'CLIENT_PORTAL') out.add('CLIENT');
  else out.add('ADMIN');
  return out;
}

type Row = { id: string; day: Date; items: Prisma.JsonValue; publishedAt: Date | null };

function shape(row: Row, audiences: Set<ReleaseNoteAudience> | null) {
  const items = (Array.isArray(row.items) ? row.items : []) as unknown as ReleaseNoteItem[];
  return {
    id: row.id,
    day: row.day.toISOString().slice(0, 10),
    items: audiences ? items.filter((i) => audiences.has(i.audience)) : items,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

const canEdit = (role: string) => hasCapability(role as Parameters<typeof hasCapability>[0], 'manage:org');

/** GET /release-notes?limit=20 — newest first; drafts only for editors. */
releaseNotesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const editor = canEdit(user.role);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), MAX_NOTES);
    const rows = await prisma.releaseNote.findMany({
      where: editor ? {} : { publishedAt: { not: null } },
      orderBy: [{ day: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    const audiences = editor ? null : audiencesFor(user.role);
    res.json({
      notes: rows.map((r) => shape(r, audiences)).filter((n) => editor || n.items.length > 0),
      canEdit: editor,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /release-notes/latest — the newest published note with something for this reader. */
releaseNotesRouter.get('/latest', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const audiences = audiencesFor(user.role);
    const rows = await prisma.releaseNote.findMany({
      where: { publishedAt: { not: null } },
      orderBy: [{ day: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });
    const note = rows.map((r) => shape(r, audiences)).find((n) => n.items.length > 0) ?? null;
    res.json({ note });
  } catch (err) {
    next(err);
  }
});

releaseNotesRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const parsed = InputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid release note', parsed.error.flatten());
    const { day, items, published } = parsed.data;
    const row = await prisma.releaseNote.create({
      data: {
        day: new Date(`${day}T00:00:00.000Z`),
        items: items as unknown as Prisma.InputJsonValue,
        publishedAt: published ? new Date() : null,
        createdById: req.user!.id,
      },
    });
    enqueueAudit(
      { actorUserId: req.user!.id, action: published ? 'release_note.published' : 'release_note.drafted', entityType: 'ReleaseNote', entityId: row.id, metadata: { day, items: items.length } },
      'releaseNotes.create',
    );
    res.status(201).json({ note: shape(row, null) });
  } catch (err) {
    next(err);
  }
});

releaseNotesRouter.patch('/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = InputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid release note', parsed.error.flatten());
    const existing = await prisma.releaseNote.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'not_found', 'Release note not found');
    const { day, items, published } = parsed.data;
    const row = await prisma.releaseNote.update({
      where: { id: existing.id },
      data: {
        day: new Date(`${day}T00:00:00.000Z`),
        items: items as unknown as Prisma.InputJsonValue,
        // Publishing stamps the moment; re-saving a published note keeps it.
        publishedAt: published ? (existing.publishedAt ?? new Date()) : null,
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: published && !existing.publishedAt ? 'release_note.published' : 'release_note.updated',
        entityType: 'ReleaseNote',
        entityId: row.id,
        metadata: { day, items: items.length, published },
      },
      'releaseNotes.update',
    );
    res.json({ note: shape(row, null) });
  } catch (err) {
    next(err);
  }
});

releaseNotesRouter.delete('/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.releaseNote.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'not_found', 'Release note not found');
    await prisma.releaseNote.delete({ where: { id: existing.id } });
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'release_note.deleted', entityType: 'ReleaseNote', entityId: existing.id, metadata: { day: existing.day.toISOString().slice(0, 10) } },
      'releaseNotes.delete',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
