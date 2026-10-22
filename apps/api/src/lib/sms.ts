import { env } from '../config/env.js';
import { prisma } from '../db.js';

/**
 * Outbound text messages — the SMS channel behind lib/notifications.
 *
 * Until 2026-10-21 every SMS send answered with a STUB-SMS ref and was
 * recorded as SENT: emergency alerts, crew texts, candidate links and SMS
 * broadcasts were "sent" and never left the building. Now:
 *
 *   - Configured (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + a Messaging
 *     Service SID or a from number): the Twilio Messages API, the message
 *     SID as the external ref. Twilio's own errors surface as a thrown
 *     Error, so the caller's row goes FAILED with the reason.
 *   - Not configured: SmsNotConfiguredError. The generic sender records a
 *     NOT_CONFIGURED row; callers that own a row write that status. Nothing
 *     is ever reported as sent.
 *   - Opted out (the number texted STOP, or an admin opted it out):
 *     SmsOptedOutError — recorded SUPPRESSED, like a do-not-email address.
 *
 * The transport is swappable (setSmsTransportForTests) so the whole path —
 * dispatch, statuses, opt-outs, the broadcast counts — is tested without a
 * Twilio account.
 */

export interface SmsMessage {
  /** E.164. */
  to: string;
  body: string;
}

export interface SmsTransportResult {
  /** The provider's message id (Twilio SID). */
  sid: string;
  /** Provider status at accept time ("queued", "accepted"…). */
  status: string;
}

export type SmsTransport = (msg: SmsMessage) => Promise<SmsTransportResult>;

export class SmsNotConfiguredError extends Error {
  readonly code = 'sms_not_configured';
  constructor() {
    super(smsNotConfiguredReason());
    this.name = 'SmsNotConfiguredError';
  }
}

export class SmsOptedOutError extends Error {
  readonly code = 'sms_opted_out';
  constructor(readonly phone: string) {
    super(`sms_opted_out: ${phone} texted STOP — no texts go to it until they text START.`);
    this.name = 'SmsOptedOutError';
  }
}

export class SmsBadNumberError extends Error {
  readonly code = 'sms_bad_number';
  constructor(readonly raw: string) {
    super(`sms_bad_number: "${raw}" is not a phone number texts can reach.`);
    this.name = 'SmsBadNumberError';
  }
}

/* ----- Configuration ------------------------------------------------------ */

/** True when every piece the Twilio Messages API needs is set. */
export function smsConfigured(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER),
  );
}

/** The one sentence the composer, the crew-text dialog and the log show when texts are off. */
export function smsNotConfiguredReason(): string {
  if (smsConfigured()) return '';
  const missing: string[] = [];
  if (!env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
  if (!env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM_NUMBER) missing.push('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER');
  return `Texting isn’t connected — set ${missing.join(', ')} on the API to send texts.`;
}

/* ----- Numbers ------------------------------------------------------------ */

/**
 * E.164 from whatever the roster holds: "(555) 123-4567", "555.123.4567",
 * "+1 555 123 4567", "15551234567". Ten digits are read as a US/Canada
 * number; a leading + keeps its country code. Null when it cannot be a
 * dialable number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (plus) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/* ----- STOP / START ------------------------------------------------------- */

// The carrier keywords (CTIA). Twilio honours them on its side for long
// codes and messaging services; we record them too so our own log never
// tries a number that asked us to stop, and so an admin can see why.
const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|parar|alto|detener|durdur|arrête|arret)\s*[.!]*\s*$/i;
const START_WORDS = /^\s*(start|unstop|yes|resume|empezar|continuar|başlat|baslat)\s*[.!]*\s*$/i;

export function isStopKeyword(text: string): boolean {
  return STOP_WORDS.test(text);
}

export function isStartKeyword(text: string): boolean {
  return START_WORDS.test(text);
}

export async function recordSmsOptOut(phone: string, input: { reason: string; source?: string; tenantId?: string | null }): Promise<void> {
  const e164 = normalizePhone(phone);
  if (!e164) return;
  await prisma.smsOptOut.upsert({
    where: { phone: e164 },
    create: { phone: e164, reason: input.reason.slice(0, 40), source: input.source?.slice(0, 80) ?? null, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
    update: { reason: input.reason.slice(0, 40), source: input.source?.slice(0, 80) ?? null },
  });
}

export async function clearSmsOptOut(phone: string): Promise<boolean> {
  const e164 = normalizePhone(phone);
  if (!e164) return false;
  const r = await prisma.smsOptOut.deleteMany({ where: { phone: e164 } });
  return r.count > 0;
}

export async function isSmsOptedOut(phone: string): Promise<boolean> {
  const e164 = normalizePhone(phone);
  if (!e164) return false;
  const row = await prisma.smsOptOut.findUnique({ where: { phone: e164 }, select: { id: true } });
  return !!row;
}

/**
 * An inbound text's STOP / START, applied. Returns the reply Twilio should
 * send back (a plain confirmation), or null when the text is neither.
 * Works for any number — a candidate who never became an associate can
 * still opt out.
 */
export async function handleSmsKeyword(input: { from: string; text: string; source?: string }): Promise<string | null> {
  if (isStopKeyword(input.text)) {
    await recordSmsOptOut(input.from, { reason: 'STOP', source: input.source ?? 'sms' });
    return 'You’re unsubscribed from texts. Reply START to get them again.';
  }
  if (isStartKeyword(input.text)) {
    const cleared = await clearSmsOptOut(input.from);
    return cleared ? 'You’re subscribed to texts again. Reply STOP to unsubscribe.' : null;
  }
  return null;
}

/* ----- Transport ---------------------------------------------------------- */

const twilioTransport: SmsTransport = async (msg) => {
  const sid = env.TWILIO_ACCOUNT_SID!;
  const token = env.TWILIO_AUTH_TOKEN!;
  const form = new URLSearchParams({ To: msg.to, Body: msg.body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', env.TWILIO_FROM_NUMBER!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // Twilio's body is JSON {code, message}; keep the message, never the token.
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { code?: number; message?: string };
      if (j.message) detail = `${j.code ? `${j.code} ` : ''}${j.message}`;
    } catch {
      /* not JSON */
    }
    throw new Error(`Twilio ${res.status}: ${detail}`);
  }
  const j = JSON.parse(text) as { sid?: string; status?: string };
  if (!j.sid) throw new Error('Twilio answered without a message SID');
  return { sid: j.sid, status: j.status ?? 'queued' };
};

let transport: SmsTransport | null = null;
let forcedConfigured: boolean | null = null;

/**
 * Tests: a fake transport (and, by default, "configured" while it is set,
 * so the dispatch path is the real one). Pass null to restore Twilio.
 */
export function setSmsTransportForTests(fn: SmsTransport | null, opts: { configured?: boolean } = {}): void {
  transport = fn;
  forcedConfigured = fn ? (opts.configured ?? true) : null;
}

function configured(): boolean {
  return forcedConfigured ?? smsConfigured();
}

/** The reason texts are off right now, honouring the test override. */
export function smsAvailability(): { available: boolean; reason: string | null } {
  return configured() ? { available: true, reason: null } : { available: false, reason: smsNotConfiguredReason() };
}

/**
 * Send one text. Throws SmsNotConfiguredError / SmsOptedOutError /
 * SmsBadNumberError before any provider call, or the provider's error.
 * The body is trimmed to the 1,600-character Twilio limit.
 */
export async function sendSms(input: { to: string; body: string }): Promise<SmsTransportResult> {
  if (!configured()) throw new SmsNotConfiguredError();
  const to = normalizePhone(input.to);
  if (!to) throw new SmsBadNumberError(input.to);
  if (await isSmsOptedOut(to)) throw new SmsOptedOutError(to);
  const body = input.body.length > 1600 ? `${input.body.slice(0, 1597)}…` : input.body;
  return (transport ?? twilioTransport)({ to, body });
}

/** Map a thrown send error to the Notification status that tells the truth about it. */
export function smsErrorStatus(err: unknown): 'NOT_CONFIGURED' | 'SUPPRESSED' | 'FAILED' {
  if (err instanceof SmsNotConfiguredError) return 'NOT_CONFIGURED';
  if (err instanceof SmsOptedOutError) return 'SUPPRESSED';
  return 'FAILED';
}
