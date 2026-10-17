import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { DOCUMENT_KINDS, RETENTION_FLOOR_YEARS, retentionPreview } from '../lib/documentRetention.js';

/**
 * Document retention policies (HR pack 2026-10) — see lib/documentRetention.
 *
 *   GET  /document-retention            every kind, with its policy (or none) and legal floor
 *   PUT  /document-retention            { policies: [{ kind, retainYearsAfterSeparation | null }] }
 *   GET  /document-retention/preview    what the next sweep would purge
 */

export const documentRetentionRouter = Router();

const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:org');

async function grid() {
  const rows = await prisma.documentRetentionPolicy.findMany({ where: { tenantId: tenantIdForWrite() } });
  const byKind = new Map(rows.map((r) => [r.kind, r.retainYearsAfterSeparation]));
  return DOCUMENT_KINDS.map((kind) => ({
    kind,
    retainYearsAfterSeparation: byKind.get(kind) ?? null,
    floorYears: RETENTION_FLOOR_YEARS[kind] ?? null,
  }));
}

documentRetentionRouter.get('/document-retention', VIEW, async (_req, res) => {
  res.json({ policies: await grid() });
});

const PutSchema = z.object({
  policies: z
    .array(z.object({ kind: z.enum(DOCUMENT_KINDS as [string, ...string[]]), retainYearsAfterSeparation: z.number().int().min(1).max(100).nullable() }))
    .min(1)
    .max(32),
});

documentRetentionRouter.put('/document-retention', MANAGE, async (req, res) => {
  const input = PutSchema.parse(req.body);
  const tenantId = tenantIdForWrite();
  for (const p of input.policies) {
    const floor = RETENTION_FLOOR_YEARS[p.kind as keyof typeof RETENTION_FLOOR_YEARS];
    if (floor && p.retainYearsAfterSeparation !== null && p.retainYearsAfterSeparation < floor) {
      throw new HttpError(400, 'below_legal_floor', `${p.kind.replace(/_/g, ' ')} must be kept at least ${floor} years after separation.`);
    }
  }
  await prisma.$transaction(async (tx) => {
    for (const p of input.policies) {
      const kind = p.kind as (typeof DOCUMENT_KINDS)[number];
      if (p.retainYearsAfterSeparation === null) {
        await tx.documentRetentionPolicy.deleteMany({ where: { tenantId, kind } });
      } else {
        await tx.documentRetentionPolicy.upsert({
          where: { tenantId_kind: { tenantId, kind } },
          create: { tenantId, kind, retainYearsAfterSeparation: p.retainYearsAfterSeparation },
          update: { retainYearsAfterSeparation: p.retainYearsAfterSeparation },
        });
      }
    }
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'document.retention_policy_changed', entityType: 'DocumentRetentionPolicy', entityId: tenantId, metadata: { policies: input.policies } },
    'document.retention_policy_changed',
  );
  res.json({ policies: await grid() });
});

documentRetentionRouter.get('/document-retention/preview', VIEW, async (_req, res) => {
  const candidates = await retentionPreview();
  res.json({ count: candidates.length, candidates: candidates.slice(0, 200) });
});
