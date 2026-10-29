import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from './tenant.js';

/**
 * An offer past its expiry is expired — everywhere, not only once the
 * candidate opens the link (PEOPLE-13). Renee's offer lapsed Oct 26 and
 * still read "Sent — Awaiting their signature", with an Accept button,
 * and counted as an open offer.
 *
 *   liveSentOffer()      the where for "sent and still answerable"
 *   expireLapsedOffers() marks every lapsed SENT offer EXPIRED (on read:
 *                        the offers list and the recruiting summary call
 *                        it, so a list never shows a lapsed offer as sent)
 *   isLapsed()           one offer, in memory
 */

type Db = PrismaClient | Prisma.TransactionClient;

export function liveSentOffer(now: Date = new Date()): Prisma.OfferWhereInput {
  return { status: 'SENT', OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] };
}

export function isLapsed(o: { status: string; expiresAt: Date | null }, now: Date = new Date()): boolean {
  return o.status === 'SENT' && !!o.expiresAt && o.expiresAt.getTime() < now.getTime();
}

/** Mark this tenant's lapsed SENT offers EXPIRED. The link keeps working — it says the offer expired. */
export async function expireLapsedOffers(db: Db, now: Date = new Date()): Promise<number> {
  const r = await db.offer.updateMany({
    where: { tenantId: tenantIdForWrite(), status: 'SENT', expiresAt: { lt: now } },
    data: { status: 'EXPIRED', decidedAt: now },
  });
  return r.count;
}
