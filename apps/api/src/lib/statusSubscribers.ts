import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { STATUS_COMPONENTS } from '@alto-people/shared';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { send } from './notifications.js';
import { genericNotificationTemplate } from './emailTemplates.js';
import { ALTO_TENANT_ID } from './tenant.js';

/**
 * Incident updates by email from the public status page (F500 G5).
 *
 *   subscribe(email)   one row per address; sends a confirmation link (double
 *                      opt-in). Asking again re-sends it; a confirmed address
 *                      stays confirmed. The answer never says whether the
 *                      address was already on the list.
 *   confirm(token)     marks the row confirmed.
 *   unsubscribe(token) removes the row.
 *   notifyIncident()   an incident posted or resolved: one email to every
 *                      confirmed address, each with its own unsubscribe link.
 *
 * The links are HMAC-signed over the row id with a purpose prefix, so the
 * table holds no secret and a confirm link cannot unsubscribe (or the
 * reverse). The status page is the platform operator's: rows live in its
 * tenant.
 */

type Db = Pick<PrismaClient, 'statusSubscriber'> | Prisma.TransactionClient;
type Purpose = 'confirm' | 'unsubscribe';

function secret(): string {
  return env.CALENDAR_FEED_SECRET ?? env.JWT_SECRET;
}

function sign(purpose: Purpose, id: string): string {
  return createHmac('sha256', secret()).update(`status-${purpose}:${id}`, 'utf8').digest('base64url');
}

export function statusLinkToken(purpose: Purpose, id: string): string {
  return `${id}.${sign(purpose, id)}`;
}

/** The subscriber id a link carries, or null when the signature doesn't hold for that purpose. */
export function verifyStatusLinkToken(purpose: Purpose, token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const want = Buffer.from(sign(purpose, id));
  const got = Buffer.from(token.slice(dot + 1));
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

const base = () => env.APP_BASE_URL.replace(/\/$/, '');

async function mail(to: string, subject: string, body: string, linkUrl: string, linkLabel: string): Promise<boolean> {
  const tpl = genericNotificationTemplate({ subject, body, linkUrl, linkLabel });
  try {
    await send({ channel: 'EMAIL', recipient: { userId: null, phone: null, email: to }, subject, body: tpl.text, html: tpl.html, category: 'status_updates' });
    return true;
  } catch (err) {
    logger.warn({ err }, 'status subscriber email failed');
    return false;
  }
}

export async function subscribeToStatus(db: Db, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const row = await db.statusSubscriber.upsert({
    where: { tenantId_email: { tenantId: ALTO_TENANT_ID, email } },
    create: { tenantId: ALTO_TENANT_ID, email },
    update: {},
  });
  if (row.confirmedAt) return;
  await mail(
    email,
    'Confirm status updates',
    'Someone (we hope you) asked for an email when the platform has an incident and when it is resolved.\n\nConfirm to start them. If it wasn’t you, ignore this email and nothing will be sent.',
    `${base()}/status?confirm=${encodeURIComponent(statusLinkToken('confirm', row.id))}`,
    'Confirm updates',
  );
}

export async function confirmStatusSubscription(db: Db, token: string): Promise<boolean> {
  const id = verifyStatusLinkToken('confirm', token);
  if (!id) return false;
  const res = await db.statusSubscriber.updateMany({ where: { id, tenantId: ALTO_TENANT_ID }, data: { confirmedAt: new Date() } });
  return res.count > 0;
}

export async function unsubscribeFromStatus(db: Db, token: string): Promise<boolean> {
  const id = verifyStatusLinkToken('unsubscribe', token);
  if (!id) return false;
  await db.statusSubscriber.deleteMany({ where: { id, tenantId: ALTO_TENANT_ID } });
  // Already gone is still "you're unsubscribed".
  return true;
}

/** An incident was posted (or resolved): tell every confirmed address. Returns how many emails went out. */
export async function notifyStatusSubscribers(
  db: Db,
  incident: { title: string; component: string; impact: string; state: string; note: string },
): Promise<number> {
  const subs = await db.statusSubscriber.findMany({ where: { tenantId: ALTO_TENANT_ID, confirmedAt: { not: null } }, select: { id: true, email: true }, take: 5000 });
  const label = STATUS_COMPONENTS.find((c) => c.key === incident.component)?.label ?? incident.component;
  const resolved = incident.state === 'RESOLVED';
  const subject = resolved ? `Resolved: ${incident.title}` : `${incident.impact === 'OUTAGE' ? 'Outage' : 'Degraded'}: ${incident.title}`;
  let sent = 0;
  for (const s of subs) {
    const body = `${label} — ${resolved ? 'resolved' : incident.impact === 'OUTAGE' ? 'outage' : 'degraded performance'}.\n\n${incident.note}\n\nYou asked for these updates on the status page. Stop them any time: ${base()}/status?unsubscribe=${encodeURIComponent(statusLinkToken('unsubscribe', s.id))}`;
    if (await mail(s.email, subject, body, `${base()}/status`, 'Open the status page')) sent += 1;
  }
  return sent;
}
