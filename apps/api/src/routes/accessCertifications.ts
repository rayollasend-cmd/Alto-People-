import { Router } from 'express';
import { csvCell as sharedCsvCell } from '@alto-people/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { canRunCertifications, closeCertification, openCertification } from '../lib/accessCertification.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Access pack — access certification campaigns (lib/accessCertification).
 *
 *   POST   /admin/access-certifications                 open one (manage:org)
 *   GET    /admin/access-certifications                 the tenant's campaigns (manage:org), or mine as a reviewer
 *   GET    /admin/access-certifications/:id             one, with its items — the owner sees all, a reviewer their own
 *   POST   /admin/access-certifications/:id/items/:itemId/decide   KEEP | REVOKE | CHANGE with a note
 *   POST   /admin/access-certifications/:id/close       every item decided → closed, audited
 *   GET    /admin/access-certifications/:id/export.csv  the decisions, one row per account
 */
export const accessCertificationsRouter = Router();

const MANAGE = requireCapability('manage:org');

const OpenSchema = z.object({
  name: z.string().trim().min(3).max(160),
  scope: z.enum(['ALL', 'INTERNAL', 'CLIENT', 'ASSOCIATE']).default('ALL'),
  dueAt: z.string().datetime(),
});

const DecideSchema = z.object({
  decision: z.enum(['KEEP', 'REVOKE', 'CHANGE']),
  note: z.string().trim().max(500).optional(),
});

accessCertificationsRouter.post('/admin/access-certifications', MANAGE, async (req, res) => {
  const input = OpenSchema.parse(req.body);
  const dueAt = new Date(input.dueAt);
  if (dueAt.getTime() < Date.now()) throw new HttpError(400, 'due_in_past', 'The due date must be in the future.');
  const r = await openCertification(prisma, { name: input.name, scope: input.scope, dueAt, createdById: req.user!.id });
  res.status(201).json(r);
});

function summarize(c: { id: string; name: string; scope: string; status: string; dueAt: Date; createdAt: Date; closedAt: Date | null; items: Array<{ decision: string | null }> }) {
  return {
    id: c.id,
    name: c.name,
    scope: c.scope,
    status: c.status,
    dueAt: c.dueAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    closedAt: c.closedAt?.toISOString() ?? null,
    items: c.items.length,
    decided: c.items.filter((i) => i.decision).length,
    revoke: c.items.filter((i) => i.decision === 'REVOKE').length,
    change: c.items.filter((i) => i.decision === 'CHANGE').length,
  };
}

accessCertificationsRouter.get('/admin/access-certifications', requireAuth, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const runs = canRunCertifications(req.user!.role);
  const rows = await prisma.accessCertification.findMany({
    where: runs ? { tenantId } : { tenantId, items: { some: { reviewerUserId: req.user!.id } } },
    orderBy: [{ status: 'asc' }, { dueAt: 'desc' }],
    include: { items: { select: { decision: true, reviewerUserId: true } } },
    take: 100,
  });
  res.json({
    runs,
    certifications: rows.map((c) => ({
      ...summarize(c),
      mine: c.items.filter((i) => i.reviewerUserId === req.user!.id && !i.decision).length,
    })),
  });
});

async function loadCertification(req: { user?: { id: string; role: import('@prisma/client').Role } }, id: string) {
  const runs = canRunCertifications(req.user!.role);
  const cert = await prisma.accessCertification.findFirst({
    where: runs ? { id, tenantId: tenantIdForWrite() } : { id, tenantId: tenantIdForWrite(), items: { some: { reviewerUserId: req.user!.id } } },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });
  if (!cert) throw new HttpError(404, 'not_found', 'No such certification.');
  return { cert, runs };
}

accessCertificationsRouter.get('/admin/access-certifications/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { cert, runs } = await loadCertification(req, id);
  const items = runs ? cert.items : cert.items.filter((i) => i.reviewerUserId === req.user!.id);
  const userIds = [...new Set(items.flatMap((i) => [i.subjectUserId, i.reviewerUserId, i.decidedById].filter((x): x is string => !!x)))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, role: true, status: true, associate: { select: { firstName: true, lastName: true } } } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const person = (uid: string | null) => {
    if (!uid) return null;
    const u = byId.get(uid);
    if (!u) return { id: uid, email: null, name: null, role: null, status: null };
    return { id: u.id, email: u.email, name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : null, role: u.role, status: u.status };
  };
  res.json({
    ...summarize(cert),
    runs,
    items: items.map((i) => ({
      id: i.id,
      subject: person(i.subjectUserId),
      reviewer: person(i.reviewerUserId),
      snapshot: i.snapshot,
      decision: i.decision,
      note: i.note,
      decidedBy: person(i.decidedById),
      decidedAt: i.decidedAt?.toISOString() ?? null,
      mine: i.reviewerUserId === req.user!.id,
    })),
  });
});

accessCertificationsRouter.post('/admin/access-certifications/:id/items/:itemId/decide', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const itemId = z.string().uuid().parse(req.params.itemId);
  const input = DecideSchema.parse(req.body);
  const { cert, runs } = await loadCertification(req, id);
  if (cert.status === 'CLOSED') throw new HttpError(409, 'closed', 'This certification is closed.');
  const item = cert.items.find((i) => i.id === itemId);
  if (!item) throw new HttpError(404, 'not_found', 'No such item.');
  if (!runs && item.reviewerUserId !== req.user!.id) throw new HttpError(403, 'forbidden', 'That account is not yours to certify.');
  if (item.subjectUserId === req.user!.id) throw new HttpError(400, 'self_certification', 'Nobody certifies their own access; the campaign owner reviews yours.');
  if (input.decision !== 'KEEP' && !input.note) throw new HttpError(400, 'note_required', 'Say what should change.');
  await prisma.accessCertificationItem.update({
    where: { id: itemId },
    data: { decision: input.decision, note: input.note ?? null, decidedById: req.user!.id, decidedAt: new Date() },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: null, tenantId: cert.tenantId, action: 'access.certification_decided', entityType: 'User', entityId: item.subjectUserId, metadata: { certificationId: id, decision: input.decision, note: input.note ?? null } },
    'accessCertification',
  );
  res.status(204).end();
});

accessCertificationsRouter.post('/admin/access-certifications/:id/close', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  try {
    res.json(await closeCertification(prisma, id, req.user!.id));
  } catch (err) {
    const m = err instanceof Error ? err.message : '';
    if (m === 'not_found') throw new HttpError(404, 'not_found', 'No such certification.');
    if (m === 'already_closed') throw new HttpError(409, 'closed', 'Already closed.');
    if (m.startsWith('undecided:')) throw new HttpError(409, 'undecided', `${m.slice('undecided:'.length)} account(s) still wait on a decision.`);
    throw err;
  }
});

accessCertificationsRouter.get('/admin/access-certifications/:id/export.csv', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { cert } = await loadCertification(req, id);
  const users = await prisma.user.findMany({ where: { id: { in: cert.items.flatMap((i) => [i.subjectUserId, i.reviewerUserId, i.decidedById].filter((x): x is string => !!x)) } }, select: { id: true, email: true } });
  const email = (uid: string | null) => (uid ? (users.find((u) => u.id === uid)?.email ?? uid) : '');
  const rows = cert.items.map((i) => {
    const snap = (i.snapshot as Record<string, unknown>) ?? {};
    return [email(i.subjectUserId), String(snap.role ?? ''), email(i.reviewerUserId), i.decision ?? '', i.note ?? '', email(i.decidedById), i.decidedAt?.toISOString() ?? ''];
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId: cert.tenantId, action: 'http.export', entityType: 'AccessCertification', entityId: id, metadata: { rows: rows.length } }, 'accessCertification');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="access-certification-${id.slice(0, 8)}.csv"`);
  // The shared escaper (@alto-people/shared): quoting alone doesn't stop a spreadsheet running a formula.
  const esc = (v: string) => sharedCsvCell(v);
  res.send([['account', 'role', 'reviewer', 'decision', 'note', 'decided by', 'decided at'], ...rows].map((r) => r.map(esc).join(',')).join('\n'));
});
