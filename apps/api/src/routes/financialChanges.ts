import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import {
  KIND_LABEL,
  RISK_LABEL,
  holdFinancialChange,
  rejectFinancialChange,
  verifyFinancialChange,
  type RiskFlag,
} from '../lib/financialChanges.js';

/**
 * The Finance queue: every financial change, newest first, with what
 * changed (masked), who did it, from where, the risk flags, and the phone
 * number Finance must call to verify it. Mounted under
 * /payroll/financial-changes behind process:payroll.
 */
export const financialChangesRouter = Router();

const StatusFilter = z.enum(['PENDING', 'HELD', 'VERIFIED', 'REJECTED', 'OPEN', 'ALL']);

const CHANGE_INCLUDE = {
  associate: { select: { id: true, firstName: true, lastName: true, phone: true } },
  actorUser: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
  verifiedBy: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
} as const;

type Loaded = Awaited<ReturnType<typeof loadOne>>;

async function loadOne(id: string) {
  const row = await prisma.financialChange.findUnique({ where: { id }, include: CHANGE_INCLUDE });
  if (!row) throw new HttpError(404, 'not_found', 'Financial change not found.');
  return row;
}

function personName(u: { email: string; associate: { firstName: string; lastName: string } | null } | null): string | null {
  if (!u) return null;
  return u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email;
}

function toRow(c: NonNullable<Loaded>) {
  return {
    id: c.id,
    associate: { id: c.associate.id, name: `${c.associate.firstName} ${c.associate.lastName}` },
    kind: c.kind,
    kindLabel: KIND_LABEL[c.kind],
    source: c.source,
    onBehalf: c.onBehalf,
    actor: c.actorUser ? { id: c.actorUser.id, name: personName(c.actorUser), role: c.actorRole } : null,
    ip: c.ip,
    userAgent: c.userAgent,
    authStrength: c.authStrength,
    oldSummary: c.oldSummary,
    newSummary: c.newSummary,
    riskFlags: c.riskFlags,
    riskLabels: c.riskFlags.map((f) => RISK_LABEL[f as RiskFlag] ?? f),
    riskScore: c.riskScore,
    highRisk: c.highRisk,
    status: c.status,
    verifyPhoneLast4: c.verifyPhoneLast4,
    verifiedBy: c.verifiedBy ? { id: c.verifiedBy.id, name: personName(c.verifiedBy) } : null,
    verifiedAt: c.verifiedAt?.toISOString() ?? null,
    verifiedVia: c.verifiedVia,
    verificationNote: c.verificationNote,
    financeNotifiedAt: c.financeNotifiedAt?.toISOString() ?? null,
    associateNotifiedAt: c.associateNotifiedAt?.toISOString() ?? null,
    priorContactNotifiedAt: c.priorContactNotifiedAt?.toISOString() ?? null,
    acknowledgedAt: c.acknowledgedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

financialChangesRouter.get('/', async (req, res, next) => {
  try {
    const status = StatusFilter.catch('OPEN').parse(req.query.status);
    const days = z.coerce.number().int().min(1).max(365).catch(90).parse(req.query.days);
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await prisma.financialChange.findMany({
      where: {
        ...(status === 'OPEN'
          ? { status: { in: ['PENDING', 'HELD'] } }
          : status === 'ALL'
            ? { createdAt: { gte: since } }
            : { status, createdAt: { gte: since } }),
      },
      include: CHANGE_INCLUDE,
      orderBy: [{ highRisk: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    const [open, held] = await Promise.all([
      prisma.financialChange.count({ where: { status: 'PENDING' } }),
      prisma.financialChange.count({ where: { status: 'HELD' } }),
    ]);
    res.json({ rows: rows.map(toRow), counts: { pending: open, held } });
  } catch (err) {
    next(err);
  }
});

financialChangesRouter.get('/summary', async (_req, res, next) => {
  try {
    const [pending, held] = await Promise.all([
      prisma.financialChange.count({ where: { status: 'PENDING' } }),
      prisma.financialChange.count({ where: { status: 'HELD' } }),
    ]);
    res.json({ pending, held, open: pending + held });
  } catch (err) {
    next(err);
  }
});

financialChangesRouter.get('/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const row = await loadOne(id);
    const trail = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'FinancialChange', entityId: id },
          { entityType: 'Associate', entityId: row.associateId, action: { startsWith: 'financial.' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, actorUserId: true, createdAt: true, metadata: true },
    });
    res.json({
      change: toRow(row),
      trail: trail
        .filter((t) => (t.metadata as { financialChangeId?: string } | null)?.financialChangeId === id || !(t.metadata as { financialChangeId?: string } | null)?.financialChangeId)
        .map((t) => ({ id: t.id, action: t.action, actorUserId: t.actorUserId, at: t.createdAt.toISOString() })),
    });
  } catch (err) {
    next(err);
  }
});

const VerifyInput = z.object({
  via: z.enum(['PHONE_CALL', 'IN_PERSON', 'OTHER']),
  note: z.string().trim().max(1000).optional().nullable(),
  /** Finance confirms it reached the associate on the number that was on file before the change. */
  reachedOnNumberOnFile: z.literal(true),
});

financialChangesRouter.post('/:id/verify', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = VerifyInput.parse(req.body ?? {});
    const existing = await loadOne(id);
    if (existing.status === 'VERIFIED' || existing.status === 'REJECTED') {
      throw new HttpError(409, 'already_decided', `This change is already ${existing.status.toLowerCase()}.`);
    }
    // Nobody verifies their own change.
    if (existing.actorUserId && existing.actorUserId === req.user!.id) {
      throw new HttpError(403, 'own_change', 'A change cannot be verified by the person who made it.');
    }
    await verifyFinancialChange(id, { id: req.user!.id, role: req.user!.role }, input.via, input.note ?? null, req);
    res.json({ change: toRow(await loadOne(id)) });
  } catch (err) {
    next(err);
  }
});

const NoteInput = z.object({ note: z.string().trim().min(3).max(1000) });

financialChangesRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = NoteInput.parse(req.body ?? {});
    const existing = await loadOne(id);
    if (existing.status === 'VERIFIED' || existing.status === 'REJECTED') {
      throw new HttpError(409, 'already_decided', `This change is already ${existing.status.toLowerCase()}.`);
    }
    await rejectFinancialChange(id, { id: req.user!.id, role: req.user!.role }, input.note, req);
    res.json({ change: toRow(await loadOne(id)) });
  } catch (err) {
    next(err);
  }
});

financialChangesRouter.post('/:id/hold', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = NoteInput.parse(req.body ?? {});
    const existing = await loadOne(id);
    if (existing.status !== 'PENDING') {
      throw new HttpError(409, 'not_pending', 'Only a pending change can be held.');
    }
    await holdFinancialChange(id, { id: req.user!.id, role: req.user!.role }, input.note, req);
    res.json({ change: toRow(await loadOne(id)) });
  } catch (err) {
    next(err);
  }
});
