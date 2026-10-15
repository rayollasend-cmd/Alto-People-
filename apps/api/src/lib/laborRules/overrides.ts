import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { HttpError } from '../../middleware/error.js';
import { enqueueAudit } from '../audit.js';
import { ALTO_TENANT_ID } from '../tenant.js';
import { RuleParamsSchema } from './params.js';

/**
 * Brief 2-2 step 6 — a tenant's and a site's own rules (manage:org).
 *
 *   An override starts DRAFT, applies to pay only once ACTIVE (a named
 *   approver and a note, owner's decision 5's pattern), and is retired, never
 *   deleted. Only DRAFT rows are edited; an ACTIVE row is replaced by a new
 *   version. Every change writes an audit row with before and after.
 *   Whatever is entered, resolution lets an override add protection only
 *   (lib/laborRules/resolve).
 *
 *   Shipped packs are signed here too, but only by the operator tenant (Alto
 *   HR) and only with counsel's reference in the note (decision 10): a pack
 *   is shared by every tenant.
 */

type Db = PrismaClient;

export const OverrideInputSchema = z
  .object({
    level: z.enum(['TENANT', 'SITE']),
    siteId: z.string().uuid().nullable().optional(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    params: RuleParamsSchema,
    source: z.string().trim().min(3).max(1000),
  })
  .strict()
  .refine((v) => (v.level === 'SITE') === !!v.siteId, { message: 'A site override names its site; a tenant override names none.', path: ['siteId'] })
  .refine((v) => Object.keys(v.params).length > 0, { message: 'Set at least one rule.', path: ['params'] })
  .refine((v) => v.params.minors?.severity === undefined || v.params.minors.severity === 'block', { message: 'Minors’ limits always block.', path: ['params'] });
export type OverrideInput = z.infer<typeof OverrideInputSchema>;

export const OverrideUpdateSchema = z.object({ params: RuleParamsSchema.optional(), source: z.string().trim().min(3).max(1000).optional(), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
export const ApprovalSchema = z.object({ note: z.string().trim().min(5).max(500) }).strict();

const D = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

async function ownRow(db: Db, tenantId: string, id: string) {
  const row = await db.laborRuleSet.findFirst({ where: { id, OR: [{ tenantId }, { tenantId: null }] } });
  if (!row) throw new HttpError(404, 'rule_set_not_found', 'Rule set not found.');
  return row;
}

const audit = (actorUserId: string, tenantId: string, action: string, id: string, metadata: Prisma.InputJsonObject) =>
  enqueueAudit({ actorUserId, clientId: null, tenantId, action, entityType: 'LaborRuleSet', entityId: id, metadata }, 'laborRules');

export async function createOverride(db: Db, tenantId: string, input: OverrideInput, actorUserId: string) {
  if (input.siteId && !(await db.site.findFirst({ where: { id: input.siteId, tenantId, deletedAt: null }, select: { id: true } }))) {
    throw new HttpError(404, 'site_not_found', 'Site not found.');
  }
  const last = await db.laborRuleSet.findFirst({
    where: { tenantId, level: input.level, siteId: input.siteId ?? null, effectiveFrom: D(input.effectiveFrom) },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const row = await db.laborRuleSet.create({
    data: {
      tenantId,
      jurisdiction: input.level,
      level: input.level,
      siteId: input.siteId ?? null,
      effectiveFrom: D(input.effectiveFrom),
      version: (last?.version ?? 0) + 1,
      params: input.params as Prisma.InputJsonObject,
      source: input.source,
      sourceDate: D(new Date().toISOString().slice(0, 10)),
      status: 'DRAFT',
    },
  });
  audit(actorUserId, tenantId, 'labor_rules.override_created', row.id, { level: input.level, siteId: input.siteId ?? null, effectiveFrom: input.effectiveFrom, version: row.version, after: input.params as Prisma.InputJsonObject });
  return row;
}

export async function updateDraft(db: Db, tenantId: string, id: string, input: z.infer<typeof OverrideUpdateSchema>, actorUserId: string) {
  const row = await ownRow(db, tenantId, id);
  if (row.tenantId === null) throw new HttpError(403, 'pack_read_only', 'A shipped pack changes by a reviewed release, not here.');
  if (row.status !== 'DRAFT') throw new HttpError(409, 'not_draft', 'Only a draft is edited; add a new version to change a signed rule set.');
  const updated = await db.laborRuleSet.update({
    where: { id },
    data: {
      ...(input.params ? { params: input.params as Prisma.InputJsonObject } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.effectiveFrom ? { effectiveFrom: D(input.effectiveFrom) } : {}),
    },
  });
  audit(actorUserId, tenantId, 'labor_rules.override_updated', id, { before: row.params as Prisma.InputJsonObject, after: updated.params as Prisma.InputJsonObject, effectiveFrom: updated.effectiveFrom.toISOString().slice(0, 10) });
  return updated;
}

export async function activateSet(db: Db, tenantId: string, id: string, note: string, actorUserId: string) {
  const row = await ownRow(db, tenantId, id);
  if (row.tenantId === null && tenantId !== ALTO_TENANT_ID) throw new HttpError(403, 'pack_operator_only', 'Shipped packs are signed by the platform operator with counsel.');
  if (row.status !== 'DRAFT') throw new HttpError(409, 'not_draft', 'Only a draft is signed.');
  const now = new Date();
  try {
    const updated = await db.$transaction(async (tx) => {
      // The ACTIVE set it replaces for the same scope and date steps down first (one ACTIVE per date).
      await tx.laborRuleSet.updateMany({ where: { id: { not: id }, tenantId: row.tenantId, jurisdiction: row.jurisdiction, siteId: row.siteId, effectiveFrom: row.effectiveFrom, status: 'ACTIVE' }, data: { status: 'RETIRED' } });
      return tx.laborRuleSet.update({ where: { id }, data: { status: 'ACTIVE', approvedAt: now, approvedByUserId: actorUserId, approvalNote: note } });
    });
    audit(actorUserId, tenantId, row.tenantId === null ? 'labor_rules.pack_signed' : 'labor_rules.override_signed', id, { jurisdiction: row.jurisdiction, effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10), version: row.version, note });
    return updated;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new HttpError(409, 'active_exists', 'Another signed set already covers that date.');
    throw err;
  }
}

export async function retireSet(db: Db, tenantId: string, id: string, actorUserId: string) {
  const row = await ownRow(db, tenantId, id);
  if (row.tenantId === null && tenantId !== ALTO_TENANT_ID) throw new HttpError(403, 'pack_operator_only', 'Shipped packs are retired by the platform operator.');
  if (row.status === 'RETIRED') return row;
  const updated = await db.laborRuleSet.update({ where: { id }, data: { status: 'RETIRED' } });
  audit(actorUserId, tenantId, 'labor_rules.retired', id, { previousStatus: row.status, jurisdiction: row.jurisdiction });
  return updated;
}
