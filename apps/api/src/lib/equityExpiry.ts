import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { logger } from './logger.js';
import { runForEachTenant } from './tenantJobs.js';
import { tenantIdForWrite } from './tenant.js';
import { dateColumnKey } from './timezone.js';

/**
 * Equity grants expire (system audit 2026-10-21, Tier 3): an option grant
 * whose expiration date has passed and that was never exercised or
 * cancelled reads EXPIRED from the day after. Daily per tenant; idempotent.
 * PROPOSED grants expire too — an offer nobody granted by its own deadline
 * is no longer open.
 */
export async function expireEquityGrants(db: PrismaClient = defaultPrisma, today: Date = new Date()): Promise<{ expired: number }> {
  const cutoff = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const due = await db.equityGrant.findMany({
    where: { tenantId: tenantIdForWrite(), status: { in: ['PROPOSED', 'GRANTED'] }, expirationDate: { lt: cutoff } },
    select: { id: true, associateId: true, status: true, expirationDate: true, totalShares: true },
    take: 5000,
  });
  if (due.length === 0) return { expired: 0 };
  await db.equityGrant.updateMany({ where: { id: { in: due.map((g) => g.id) } }, data: { status: 'EXPIRED' } });
  for (const g of due) {
    enqueueAudit(
      {
        actorUserId: null,
        action: 'equity.grant_expired',
        entityType: 'EquityGrant',
        entityId: g.id,
        metadata: { associateId: g.associateId, from: g.status, expirationDate: g.expirationDate ? dateColumnKey(g.expirationDate) : null, totalShares: g.totalShares },
      },
      'equity',
    );
  }
  return { expired: due.length };
}

let timer: NodeJS.Timeout | null = null;

/** Once a day per tenant (and once at boot, after a short delay). */
export function startEquityExpiryCron(): void {
  if (timer) return;
  const tick = () => runForEachTenant('equityExpiry', () => expireEquityGrants()).catch((err) => logger.warn({ err }, 'equity expiry sweep failed'));
  setTimeout(tick, 90_000).unref();
  timer = setInterval(tick, 24 * 60 * 60_000);
  timer.unref();
}
