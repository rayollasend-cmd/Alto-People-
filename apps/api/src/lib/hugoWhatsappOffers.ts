import { Prisma, type PrismaClient } from '@prisma/client';
import type { HugoTaskCreateInput } from '@alto-people/shared';
import { normalizeHugoText } from './hugo.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Hugo's state on an inbound WhatsApp question (WhatsAppMessage.hugo):
 * how it was answered, and the task offer that waits for the person's
 * START. Kept light — no registry, no model — so the WhatsApp front door
 * (lib/whatsappAssistant) can read and clear offers without loading Hugo's
 * brain (lib/hugoWhatsapp), which comes in only when it is needed.
 *
 *   route    instant  the registry answered at once
 *            fast     the quick model was asked  ┐ the tenant's daily
 *            deep     the strong model was asked ┘ valve counts these
 *            rules    the registry, as the fallback (no key, the valve,
 *                     a failure, the person's allowance used up)
 *            offer    a WATCH_* task was offered, waiting on START
 *            pointer  work that starts in the app, pointed to
 *            task     START took an offer
 *
 * An offer is the person's own (their user id on it), watches only, and
 * keeps 30 minutes; one waits at a time per person — a newer offer, or
 * STOP, sets the older one aside.
 */

type Db = PrismaClient;

export const OFFER_MINUTES = 30;
const DAY_MS = 86_400_000;

export type HugoWaRoute = 'instant' | 'fast' | 'deep' | 'rules' | 'offer' | 'pointer' | 'task';

export interface HugoWaOffer {
  userId: string;
  tasks: HugoTaskCreateInput[];
  expiresAt: string;
  state: 'PENDING' | 'TAKEN' | 'EXPIRED' | 'VOID';
  /** TAKEN: the task START began (or found already running). */
  taskId?: string;
  at?: string;
}

export interface HugoWaState {
  route: HugoWaRoute;
  /** The model was asked and failed; the registry answered. */
  failed?: boolean;
  /** The tenant's daily valve was reached; the registry answered. */
  valve?: boolean;
  /** The person's allowance was used up (lib/hugoAllowance): when it renews, and whether this answer said so. */
  allowance?: { renewsAt: string; told: boolean };
  offer?: HugoWaOffer;
}

/** Write Hugo's state on the inbound row (a no-op without one). */
export async function markInbound(db: Db, inboundId: string | null, state: HugoWaState): Promise<void> {
  if (!inboundId) return;
  await db.whatsAppMessage.update({ where: { id: inboundId }, data: { hugo: state as unknown as Prisma.InputJsonValue }, select: { id: true } });
}

/** "START", "START 2", "empezar 1", "BAŞLA" — the whole message, nothing else. Null when it isn't one. */
export function startReply(text: string): { pick: number | null } | null {
  const m = /^(start|empezar|basla)(?:\s*#?\s*(\d{1,2}))?[\s.!]*$/.exec(normalizeHugoText(text));
  if (!m) return null;
  return { pick: m[2] ? Number(m[2]) : null };
}

const pendingWhere = (associateId: string, now: Date): Prisma.WhatsAppMessageWhereInput => ({
  tenantId: tenantIdForWrite(),
  associateId,
  direction: 'INBOUND',
  createdAt: { gte: new Date(now.getTime() - DAY_MS) },
  hugo: { path: ['offer', 'state'], equals: 'PENDING' },
});

/** The person's offer still waiting on START (expired or not), newest first; null when none. */
export async function pendingOffer(db: Db, associateId: string, now: Date): Promise<{ id: string; state: HugoWaState; offer: HugoWaOffer } | null> {
  const row = await db.whatsAppMessage.findFirst({ where: pendingWhere(associateId, now), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, hugo: true } });
  const state = row?.hugo as HugoWaState | null | undefined;
  if (!row || !state?.offer) return null;
  return { id: row.id, state, offer: state.offer };
}

/**
 * Move an offer on from PENDING — only if it still is (two STARTs at once
 * take it once). True when this call moved it.
 */
export async function settleOffer(db: Db, row: { id: string; state: HugoWaState }, next: Partial<HugoWaOffer> & { state: HugoWaOffer['state'] }, route?: HugoWaRoute): Promise<boolean> {
  const offer = row.state.offer!;
  const state: HugoWaState = { ...row.state, ...(route ? { route } : {}), offer: { ...offer, ...next } };
  const moved = await db.whatsAppMessage.updateMany({
    where: { id: row.id, hugo: { path: ['offer', 'state'], equals: 'PENDING' } },
    data: { hugo: state as unknown as Prisma.InputJsonValue },
  });
  return moved.count === 1;
}

/** Put a TAKEN offer back to PENDING (the task could not start; the person may fix it and reply again). */
export async function reopenOffer(db: Db, row: { id: string; state: HugoWaState }): Promise<void> {
  await db.whatsAppMessage.update({ where: { id: row.id }, data: { hugo: row.state as unknown as Prisma.InputJsonValue }, select: { id: true } });
}

/** Set aside every offer still waiting for this person (STOP, or a newer offer), except `keepId`. */
export async function voidOffers(db: Db, associateId: string, now: Date, keepId: string | null = null): Promise<number> {
  const rows = await db.whatsAppMessage.findMany({ where: { ...pendingWhere(associateId, now), ...(keepId ? { id: { not: keepId } } : {}) }, select: { id: true, hugo: true } });
  let n = 0;
  for (const r of rows) {
    if (await settleOffer(db, { id: r.id, state: r.hugo as unknown as HugoWaState }, { state: 'VOID', at: now.toISOString() })) n++;
  }
  return n;
}

/** Record the offer on the inbound question and set aside any older one. */
export async function recordOffer(db: Db, inboundId: string, associateId: string, userId: string, tasks: HugoTaskCreateInput[], now: Date): Promise<HugoWaOffer> {
  const offer: HugoWaOffer = { userId, tasks, expiresAt: new Date(now.getTime() + OFFER_MINUTES * 60_000).toISOString(), state: 'PENDING' };
  await markInbound(db, inboundId, { route: 'offer', offer });
  await voidOffers(db, associateId, now, inboundId);
  return offer;
}
