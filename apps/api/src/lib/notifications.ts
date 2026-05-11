import type { NotificationChannel } from '@alto-people/shared';
import { env } from '../config/env.js';
import { getBrandingSync } from './branding.js';

/* ---------------------------------------------------------------------------
 * Resend rate-limit throttle.
 *
 * Resend's free tier caps at 5 requests/second per account. notifyAllAdmins
 * fan-outs and broadcast sends can fire 10+ emails in the same tick, so we
 * were getting batched 429s in production. The fix: serialize the Resend
 * fetch through a min-interval gate, so back-to-back calls naturally space
 * themselves out without callers needing to know about throttling.
 *
 * 250ms gap = 4 req/s effective. Slightly under the 5/s cap so a single
 * concurrent caller doesn't accidentally trip it on clock skew.
 *
 * Process-local throttle is sufficient — Railway runs a single container
 * for the api service. If we ever scale to multiple replicas, this needs
 * to move to a shared limiter (Redis token bucket).
 *
 * Retry on 429: when Resend still returns 429 (e.g. another tenant or a
 * burst we didn't see locally), we honour the Retry-After header (or
 * default to 1s) and retry once. Beyond that we give up so a stuck
 * Resend can't block the entire queue.
 * ------------------------------------------------------------------------ */

const RESEND_MIN_INTERVAL_MS = 250;
const RESEND_MAX_RETRIES = 1;

let resendQueue: Promise<unknown> = Promise.resolve();
let lastResendCallAt = 0;

// Multi-replica safety sentinel — pairs with the user-cache and kiosk-
// rate-limit guards in index.ts. The throttle above is per-process, so
// with N replicas the effective rate is up to N × 4 req/s, which will
// trip Resend's 5/s tenant cap on the third replica. Call this from a
// Redis-token-bucket adapter at boot to swap in a shared limiter.
export function installSharedResendThrottle(backendName: string) {
  (globalThis as { __RESEND_THROTTLE_BACKEND__?: string }).__RESEND_THROTTLE_BACKEND__ =
    backendName;
}

async function throttledResendFetch(payload: unknown): Promise<Response> {
  // Chain onto the queue so concurrent callers serialize through the same
  // min-interval gate. The .then ignores the prior result; .catch swallows
  // it so one failed send doesn't poison the queue.
  const slot = resendQueue.then(async () => {
    const elapsed = Date.now() - lastResendCallAt;
    if (elapsed < RESEND_MIN_INTERVAL_MS) {
      await new Promise((r) =>
        setTimeout(r, RESEND_MIN_INTERVAL_MS - elapsed),
      );
    }
    lastResendCallAt = Date.now();
    return doResendFetch(payload, 0);
  });
  resendQueue = slot.catch(() => undefined);
  return slot;
}

async function doResendFetch(
  payload: unknown,
  attempt: number,
): Promise<Response> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 429 || attempt >= RESEND_MAX_RETRIES) return res;
  // Honour Retry-After if Resend gave us one (seconds), else default 1s.
  const ra = res.headers.get('retry-after');
  const waitMs = ra ? Math.max(500, Number(ra) * 1000) : 1000;
  await new Promise((r) => setTimeout(r, waitMs));
  return doResendFetch(payload, attempt + 1);
}

/**
 * Resolves the From: header for a Resend send. If the org has set a
 * `senderName` in /admin/branding, we overlay that as the display name
 * onto the bare email parsed from RESEND_FROM. Otherwise RESEND_FROM is
 * forwarded verbatim — preserving any name baked into the env value.
 */
function effectiveFrom(): string | undefined {
  const raw = env.RESEND_FROM;
  if (!raw) return undefined;
  const senderName = getBrandingSync().senderName;
  if (!senderName) return raw;
  const m = raw.match(/<([^>]+)>/);
  const bare = m ? m[1] : raw;
  return `${senderName} <${bare}>`;
}

/**
 * Notification sender. SMS / PUSH stay stubbed. EMAIL goes through Resend
 * if RESEND_API_KEY + RESEND_FROM are set; otherwise it logs the body to
 * the API console (with the magic link visible) and returns a synthetic
 * STUB-EMAIL-... ref so the UI flow continues working.
 *
 * IN_APP doesn't need an external service — the Notification row IS the
 * delivery; the inbox endpoint reads it.
 */
export interface SendAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendInput {
  channel: NotificationChannel;
  recipient: { userId: string | null; phone: string | null; email: string | null };
  subject: string | null;
  body: string;
  /**
   * EMAIL-only. When provided, sent to Resend alongside `body` (text fallback).
   * Most modern clients render the HTML; the text body is the deliverability
   * fallback and what spam classifiers read.
   */
  html?: string;
  /** EMAIL-only. Resend supports attachments; in stub mode we log size + name. */
  attachments?: SendAttachment[];
}

export async function sendStubbed(
  channel: NotificationChannel,
  recipient: { userId: string | null; phone: string | null; email: string | null }
): Promise<{ externalRef: string | null }> {
  // Backwards-compatible signature for existing callers that don't have
  // subject/body to forward. EMAIL still falls back to stub here.
  return send({ channel, recipient, subject: null, body: '' });
}

export async function send(input: SendInput): Promise<{ externalRef: string | null }> {
  await new Promise((r) => setTimeout(r, 1));

  switch (input.channel) {
    case 'SMS':
      return { externalRef: `STUB-SMS-${Math.random().toString(36).slice(2, 10)}` };
    case 'PUSH':
      return { externalRef: `STUB-PUSH-${Math.random().toString(36).slice(2, 10)}` };
    case 'EMAIL':
      return sendEmail(input);
    case 'IN_APP':
      return { externalRef: null };
  }
}

async function sendEmail(input: SendInput): Promise<{ externalRef: string | null }> {
  const to = input.recipient.email;
  if (!to) {
    return { externalRef: `STUB-EMAIL-no-recipient-${Math.random().toString(36).slice(2, 8)}` };
  }
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    // Stubbed mode — print to the API console so the developer can copy
    // the magic link from there. Never log raw secrets in production.
    const attachmentsLine =
      input.attachments && input.attachments.length > 0
        ? `\n  Attachments: ${input.attachments
            .map((a) => `${a.filename} (${a.contentType}, ${a.content.byteLength} bytes)`)
            .join(', ')}`
        : '';
    console.log(
      `\n[alto-people/api] STUBBED EMAIL → ${to}\n  Subject: ${input.subject ?? '(none)'}${attachmentsLine}\n  Body:\n${input.body
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')}\n  (Set RESEND_API_KEY + RESEND_FROM in apps/api/.env to send for real.)\n`
    );
    return { externalRef: `STUB-EMAIL-${Math.random().toString(36).slice(2, 10)}` };
  }
  // Real Resend call.
  try {
    const from = effectiveFrom();
    const payload: Record<string, unknown> = {
      from,
      to: [to],
      subject: input.subject ?? '(no subject)',
      text: input.body,
    };
    if (input.html) {
      payload.html = input.html;
    }
    if (env.RESEND_REPLY_TO) {
      payload.reply_to = env.RESEND_REPLY_TO;
    }
    if (input.attachments && input.attachments.length > 0) {
      payload.attachments = input.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
        content_type: a.contentType,
      }));
    }
    const res = await throttledResendFetch(payload);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Log the from/reply-to we actually sent so a misconfigured RESEND_FROM
      // is debuggable from API logs alone (the user-facing error keeps the
      // raw Resend body for the route handler to surface). The API key is
      // never logged. Recipient is logged separately on the surrounding
      // catch/finally chain.
      console.error(
        '[notifications.send] Resend rejected payload',
        JSON.stringify({
          status: res.status,
          from: from ?? null,
          envFrom: env.RESEND_FROM ?? null,
          replyTo: env.RESEND_REPLY_TO ?? null,
          to,
          subjectLength: (input.subject ?? '').length,
          response: text.slice(0, 500),
        }),
      );
      throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string };
    return { externalRef: json.id ?? null };
  } catch (err) {
    // Surface the failure to the route handler so the Notification row gets
    // FAILED status. The route already wraps this in try/catch.
    throw err instanceof Error ? err : new Error(String(err));
  }
}
