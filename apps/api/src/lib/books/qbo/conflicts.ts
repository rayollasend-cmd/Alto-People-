import type { Prisma, PrismaClient, QboSyncConflict } from '@prisma/client';
import { tenantIdForWrite } from '../../tenant.js';

/**
 * The same record changed on both sides (or QuickBooks changed something in
 * a month the site has closed): a person decides. A record has at most one
 * OPEN conflict — a second difference updates it rather than piling up.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface ConflictInput {
  linkId: string;
  localType: string;
  localId: string;
  summary: string;
  /** What the site has (its synced fields). */
  siteVersion: unknown;
  /** What QuickBooks has: { type, entity } (entity null when it was deleted there). */
  qboVersion: { type: string; id: string; entity: unknown; reason?: string };
}

export async function raiseConflict(db: Db, c: ConflictInput): Promise<QboSyncConflict> {
  const tenantId = tenantIdForWrite();
  const open = await db.qboSyncConflict.findFirst({ where: { tenantId, localType: c.localType, localId: c.localId, status: 'OPEN' } });
  const data = {
    linkId: c.linkId,
    summary: c.summary.slice(0, 300),
    siteVersion: (c.siteVersion ?? {}) as Prisma.InputJsonValue,
    qboVersion: c.qboVersion as unknown as Prisma.InputJsonValue,
  };
  if (open) return db.qboSyncConflict.update({ where: { id: open.id }, data });
  return db.qboSyncConflict.create({ data: { tenantId, localType: c.localType, localId: c.localId, status: 'OPEN', ...data } });
}

export async function openConflictFor(db: Db, localType: string, localId: string): Promise<QboSyncConflict | null> {
  return db.qboSyncConflict.findFirst({ where: { tenantId: tenantIdForWrite(), localType, localId, status: 'OPEN' } });
}
