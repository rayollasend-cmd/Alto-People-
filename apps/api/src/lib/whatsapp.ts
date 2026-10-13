import { createHmac, timingSafeEqual } from 'node:crypto';
import { getBrandingSync } from './branding.js';
import type { PrismaClient, WhatsAppMessageKind, WhatsAppMessageStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { metaLanguageCode, renderTemplate, templateDef, toWaLang, type WaLang, type WaTemplateKey } from './whatsappContent.js';
import { moduleOn } from './tenantProfile.js';

/**
 * WHATSAPP AS A DELIVERY CHANNEL (Meta Cloud API).
 *
 * One rule decides everything here: Meta lets us open a conversation only
 * with a registered TEMPLATE; free text is allowed inside 24 hours of the
 * associate's last message. So a notice goes out as its template (the
 * same words lib/whatsappContent renders into the record), and the
 * assistant's replies — always inside that window — go as text.
 *
 * Unconfigured (no token / phone number id) every send is a stub: the
 * record is written with a STUB id and nothing leaves the process. That
 * is what dev, CI and the day before the Meta app is approved look like.
 */

type Db = PrismaClient;

const GRAPH = 'https://graph.facebook.com';
const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function whatsappConfigured(): boolean {
  return !!(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

/** Meta addresses a handset by E.164 digits without the plus; a US number typed as 10 digits gets its 1. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

export interface WaPayload {
  to: string;
  template?: { name: string; language: string; params: string[] };
  text?: string;
}

export type WaSender = (payload: WaPayload) => Promise<{ id: string }>;

let sender: WaSender | null = null;

/** Test seam: capture what would be sent. */
export function setWhatsAppSenderForTests(fn: WaSender | null): void {
  sender = fn;
}

async function graphSend(payload: WaPayload): Promise<{ id: string }> {
  const body = payload.template
    ? {
        messaging_product: 'whatsapp',
        to: payload.to,
        type: 'template',
        template: {
          name: payload.template.name,
          language: { code: payload.template.language },
          components: payload.template.params.length
            ? [{ type: 'body', parameters: payload.template.params.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      }
    : { messaging_product: 'whatsapp', to: payload.to, type: 'text', text: { body: payload.text ?? '' } };
  const res = await fetch(`${GRAPH}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string } };
  if (!res.ok || !json.messages?.[0]?.id) {
    throw new Error(json.error?.message ?? `WhatsApp ${res.status}`);
  }
  return { id: json.messages[0].id };
}

async function deliver(payload: WaPayload): Promise<{ id: string; stub: boolean }> {
  if (sender) return { ...(await sender(payload)), stub: false };
  if (!whatsappConfigured()) return { id: `STUB-WA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, stub: true };
  return { ...(await graphSend(payload)), stub: false };
}

export interface SendOptions {
  associateId: string;
  /** The notice as a registered template with its positional parameters per language. */
  template?: { key: WaTemplateKey; params: (lang: WaLang) => string[] };
  /** Free text — only allowed inside the customer-service window; outside it the generic template carries it. */
  text?: (lang: WaLang) => string;
  category?: string | null;
  kind?: WhatsAppMessageKind;
  notificationId?: string | null;
  replyToId?: string | null;
  /** Override the language (default: the associate's user language). */
  lang?: WaLang;
}

/**
 * Send one message to an opted-in associate. Returns the record, or null
 * when they have no consent (not an error — the other channels still
 * carried the notice).
 */
/** Brief 2-1b: the brand values a template names after its own parameters. */
function brandParamsFor(def: { brandParams?: Array<'orgName' | 'assistantName'> }): string[] {
  const b = getBrandingSync();
  return (def.brandParams ?? []).map((k) => (k === 'orgName' ? b.orgName : b.assistantName));
}

export async function sendWhatsApp(db: Db, o: SendOptions, now: Date = new Date()): Promise<{ id: string; status: WhatsAppMessageStatus } | null> {
  const consent = await db.whatsAppConsent.findUnique({ where: { associateId: o.associateId } });
  if (!consent || consent.status !== 'OPTED_IN') return null;
  const user = o.lang ? null : await db.user.findFirst({ where: { associateId: o.associateId, deletedAt: null }, select: { language: true } });
  const lang: WaLang = o.lang ?? toWaLang(user?.language);
  const inWindow = !!consent.lastInboundAt && now.getTime() - consent.lastInboundAt.getTime() < CUSTOMER_WINDOW_MS;

  let payload: WaPayload;
  let body: string;
  let templateName: string | null = null;
  let kind: WhatsAppMessageKind = o.kind ?? 'TEMPLATE';
  if (o.text && inWindow) {
    body = o.text(lang);
    payload = { to: consent.phone, text: body };
    if (!o.kind) kind = 'TEXT';
  } else if (o.template) {
    // Brief 2-1b: a template that belongs to a module the tenant does not run is
    // not sent; where a plain twin exists, that goes instead.
    let key = o.template.key;
    const first = templateDef(key);
    if (first.requiresModule && !(await moduleOn(first.requiresModule))) {
      if (!first.fallbackKey) return null;
      key = first.fallbackKey;
    }
    const def = templateDef(key);
    const params = [...o.template.params(lang), ...brandParamsFor(def)];
    body = renderTemplate(key, lang, params);
    templateName = def.metaName;
    payload = { to: consent.phone, template: { name: def.metaName, language: metaLanguageCode(lang), params } };
  } else if (o.text) {
    // Outside the window, free text rides the generic template.
    const text = o.text(lang);
    const params = [getBrandingSync().orgName, text, ...brandParamsFor(templateDef('alto_notice'))];
    body = renderTemplate('alto_notice', lang, params);
    templateName = 'alto_notice';
    payload = { to: consent.phone, template: { name: 'alto_notice', language: metaLanguageCode(lang), params } };
  } else {
    return null;
  }

  const row = await db.whatsAppMessage.create({
    data: {
      associateId: o.associateId,
      phone: consent.phone,
      direction: 'OUTBOUND',
      kind,
      templateName,
      language: lang,
      body: body.slice(0, 4000),
      category: o.category ?? null,
      notificationId: o.notificationId ?? null,
      replyToId: o.replyToId ?? null,
      status: 'QUEUED',
    },
    select: { id: true },
  });
  try {
    const sent = await deliver(payload);
    await db.whatsAppMessage.update({ where: { id: row.id }, data: { waMessageId: sent.id, status: 'SENT', statusAt: now } });
    if (o.notificationId) {
      await db.notification.updateMany({ where: { id: o.notificationId }, data: { status: 'SENT', sentAt: now, externalRef: sent.id, providerMessageId: sent.stub ? null : sent.id } });
    }
    return { id: row.id, status: 'SENT' };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db.whatsAppMessage.update({ where: { id: row.id }, data: { status: 'FAILED', statusAt: now, failureReason: reason } });
    if (o.notificationId) {
      await db.notification.updateMany({ where: { id: o.notificationId }, data: { status: 'FAILED', failureReason: reason } });
    }
    logger.warn({ err, associateId: o.associateId }, 'whatsapp: send failed');
    return { id: row.id, status: 'FAILED' };
  }
}

export interface NotificationLike {
  subject: string | null;
  body: string;
  category?: string;
  wa?: { template: WaTemplateKey; params: (lang: WaLang) => string[] };
}

/**
 * The channel hook: a notification that went to the bell and the inbox
 * also goes to WhatsApp when the person opted in. Writes its own
 * Notification row (channel WHATSAPP) so the communications record shows
 * the delivery and, later, the receipt.
 */
export async function sendWhatsAppForUser(userId: string, n: NotificationLike, db: Db = defaultPrisma): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { associateId: true, language: true } });
  if (!user?.associateId) return;
  const consent = await db.whatsAppConsent.findUnique({ where: { associateId: user.associateId }, select: { status: true, phone: true } });
  if (!consent || consent.status !== 'OPTED_IN') return;
  const note = await db.notification.create({
    data: {
      channel: 'WHATSAPP',
      status: 'QUEUED',
      recipientUserId: userId,
      recipientPhone: consent.phone,
      subject: n.subject,
      body: n.body,
      category: n.category ?? null,
    },
    select: { id: true },
  });
  await sendWhatsApp(db, {
    associateId: user.associateId,
    template: n.wa ? { key: n.wa.template, params: n.wa.params } : { key: 'alto_notice', params: () => [n.subject ?? 'Alto HR', n.body] },
    text: n.wa ? undefined : () => `${n.subject ? `${n.subject}\n\n` : ''}${n.body}`,
    category: n.category ?? null,
    notificationId: note.id,
  });
}

/** A delivery receipt from the webhook: sent → delivered → read, or failed. */
export async function applyWhatsAppStatus(
  db: Db,
  waMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  at: Date,
  error?: string | null,
): Promise<boolean> {
  const row = await db.whatsAppMessage.findUnique({ where: { waMessageId }, select: { id: true, status: true, notificationId: true } });
  if (!row) return false;
  const order: WhatsAppMessageStatus[] = ['QUEUED', 'SENT', 'DELIVERED', 'READ'];
  const next: WhatsAppMessageStatus = status === 'failed' ? 'FAILED' : status === 'read' ? 'READ' : status === 'delivered' ? 'DELIVERED' : 'SENT';
  // Receipts can arrive out of order; never move backwards.
  if (next !== 'FAILED' && order.indexOf(next) <= order.indexOf(row.status)) return true;
  await db.whatsAppMessage.update({ where: { id: row.id }, data: { status: next, statusAt: at, failureReason: error ?? undefined } });
  if (row.notificationId) {
    await db.notification.updateMany({
      where: { id: row.notificationId },
      data: next === 'FAILED' ? { status: 'FAILED', failureReason: error ?? 'WhatsApp delivery failed' } : next === 'READ' ? { status: 'READ', readAt: at } : next === 'DELIVERED' ? { status: 'DELIVERED' } : {},
    });
  }
  return true;
}

/** Meta signs every webhook body with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function verifyWhatsAppSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!env.WHATSAPP_APP_SECRET || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

/** For tests and tooling: the signature a body would carry. */
export function signWhatsAppBody(rawBody: Buffer | string, secret = env.WHATSAPP_APP_SECRET ?? ''): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
