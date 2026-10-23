import type { NotificationChannel, NotificationStatus } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { getBrandingSync } from './branding.js';
import { mintUnsubscribeToken } from './emailUnsubscribe.js';
import { publicBaseUrl } from './emailLayout.js';
import { SmsNotConfiguredError, SmsOptedOutError, sendSms } from './sms.js';
import { pushConfigured, sendPushToUser } from './webPush.js';
import { apnsConfigured, fcmConfigured } from './nativePush.js';
import { withIdentityScope } from './tenant.js';

/**
 * Thrown by send() for a PUSH row when no push transport (VAPID, APNs or
 * FCM) is configured. Recorded as NOT_CONFIGURED, never SENT.
 */
export class PushNotConfiguredError extends Error {
  readonly code = 'push_not_configured';
  constructor() {
    super('Push isn’t set up — set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (web) or the APNs / FCM keys (phones) on the API.');
    this.name = 'PushNotConfiguredError';
  }
}

/** A WHATSAPP send reaching the generic sender: WhatsApp only goes out through lib/whatsapp's templates. */
export class WhatsAppNotRoutedError extends Error {
  readonly code = 'whatsapp_not_routed';
  constructor() {
    super('WhatsApp messages go out through the WhatsApp templates (Communications › WhatsApp), not as one-off sends.');
    this.name = 'WhatsAppNotRoutedError';
  }
}

/** True when an email can actually leave: a provider key and a From address are set. */
export function emailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
}

/**
 * The external reference a stubbed email gets (no provider connected: the
 * body went to the server log). Callers store it and mark the row SENT so
 * the flow behind it continues; anything reading the log back asks
 * isLoggedOnlyEmail() so it never says "Sent" for a message that went nowhere.
 */
export const STUB_EMAIL_REF_PREFIX = 'STUB-EMAIL-';

export function isLoggedOnlyEmail(row: { channel: string; externalRef: string | null }): boolean {
  return row.channel === 'EMAIL' && !!row.externalRef?.startsWith(STUB_EMAIL_REF_PREFIX);
}

/**
 * A bare link and the few words that introduce it ("Open it: https://…",
 * "Pick up where you left off: https://…", a URL alone on its line) — only
 * where it starts a sentence or a line, so a link inside a sentence stays.
 */
const LINK_WITH_LEAD_IN = /(^|[.!?][ \t]+|\n)(?:[^\n.!?:]{1,60}:[ \t]*)?https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

/**
 * An in-app notification's words without the app links it was written with.
 * The same body goes out by email, where "Open it: https://…" is the way in;
 * in the app the row's Open button carries `linkUrl`, so the URL is noise
 * ("http://localhost:5173/compliance?tab=scorecard" in the middle of a
 * card). A body with no `linkUrl` keeps its URLs — there they are the only
 * way to follow the message.
 */
export function inAppBody(body: string, linkUrl: string | null): string {
  if (!linkUrl || !/https?:\/\//.test(body)) return body;
  const words = body
    .replace(LINK_WITH_LEAD_IN, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // A body that was nothing but the link keeps it: an empty card says less.
  return words || body;
}

/** True when at least one push transport can reach a device. */
export function anyPushConfigured(): boolean {
  return pushConfigured() || apnsConfigured() || fcmConfigured();
}

/**
 * The Notification status that tells the truth about a failed send():
 * a do-not-email address or a STOP'd number is SUPPRESSED, a channel with
 * no provider behind it is NOT_CONFIGURED, anything else FAILED. Every
 * caller that owns its Notification row maps through here, so no path can
 * write SENT for a message that did not leave.
 */
export function statusForSendError(err: unknown): Extract<NotificationStatus, 'SUPPRESSED' | 'NOT_CONFIGURED' | 'FAILED'> {
  if (err instanceof EmailSuppressedError || err instanceof SmsOptedOutError) return 'SUPPRESSED';
  if (err instanceof SmsNotConfiguredError || err instanceof PushNotConfiguredError || err instanceof WhatsAppNotRoutedError) return 'NOT_CONFIGURED';
  return 'FAILED';
}

/**
 * Thrown by send() when the recipient is on the EmailSuppression
 * do-not-email list (hard bounce / spam complaint / manual). Callers that
 * record delivery outcomes should catch this specifically and write a
 * SUPPRESSED Notification status; callers with only generic error handling
 * fall through to their FAILED path — either way the send is never
 * silently reported as SENT.
 */
export class EmailSuppressedError extends Error {
  readonly code = 'email_suppressed';
  constructor(
    readonly email: string,
    readonly reason: string,
  ) {
    super(`email_suppressed: ${email} is on the suppression list (${reason})`);
    this.name = 'EmailSuppressedError';
  }
}

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
 * Notification sender.
 *
 *   SMS    Twilio Messages API when TWILIO_* is configured (lib/sms);
 *          otherwise SmsNotConfiguredError → NOT_CONFIGURED. A number that
 *          texted STOP → SmsOptedOutError → SUPPRESSED. Never a stub ref.
 *   PUSH   every device of the recipient user (web push + APNs/FCM) when a
 *          transport is configured; otherwise PushNotConfiguredError.
 *   EMAIL  Resend if RESEND_API_KEY + RESEND_FROM are set; otherwise it logs
 *          the body to the API console (with the magic link visible) and
 *          returns a synthetic STUB-EMAIL-... ref so the dev flow continues.
 *   IN_APP no external service — the Notification row IS the delivery.
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
  /**
   * EMAIL-only. When true, the message goes out with RFC 8058 one-click
   * unsubscribe headers (List-Unsubscribe + List-Unsubscribe-Post) bound
   * to the recipient address. Set ONLY for broadcast/announcement-category
   * mail — transactional email (invites, password resets, paystubs, the
   * W-4 campaign) must never advertise an unsubscribe.
   */
  includeUnsubscribe?: boolean;
  /**
   * Which flow this message belongs to ("password_reset", "tax_form",
   * "offer"). Written onto the failure row so an outage can be read back
   * as a list of affected flows rather than a pile of anonymous rows.
   */
  category?: string | null;
  /**
   * Set false by callers that write their own Notification row for the
   * attempt (notify.ts, the invite paths, the mailers). Everyone else
   * gets a FAILED row written here, so no send can fail invisibly.
   */
  audit?: boolean;
}

export interface SendResult {
  externalRef: string | null;
  /**
   * Resend's message id when a real EMAIL send happened; null for stub
   * sends and non-EMAIL channels. Persist this on the Notification row so
   * async webhook events (delivered / bounced / complained) can be matched
   * back to it.
   */
  providerMessageId: string | null;
}

export async function sendStubbed(
  channel: NotificationChannel,
  recipient: { userId: string | null; phone: string | null; email: string | null }
): Promise<SendResult> {
  // Backwards-compatible signature for existing callers that don't have
  // subject/body to forward. EMAIL still falls back to stub here.
  // audit:false — every caller of this one (the admin composer) already
  // owns a Notification row and flips it to FAILED itself.
  return send({ channel, recipient, subject: null, body: '', audit: false });
}

/**
 * Write the failure down. Without this, a provider outage (a quota block,
 * a bad key, a 5xx) was invisible for every caller that didn't keep its
 * own Notification row: the message simply never arrived and the only
 * trace was a console line in a log that rotates. A FAILED row makes the
 * outage enumerable — filter Communications by status FAILED, read the
 * categories, and resend by hand.
 *
 * Never throws: an audit write must not turn a failed send into a crash.
 */
async function recordFailedSend(input: SendInput, err: unknown): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        channel: input.channel,
        status: statusForSendError(err),
        recipientUserId: input.recipient.userId,
        recipientEmail: input.recipient.email,
        recipientPhone: input.recipient.phone,
        subject: input.subject,
        // Bodies can be long (and carry a magic link); keep the row small
        // and the link out of it — this is an audit trail, not a copy.
        body: input.body.slice(0, 500),
        category: input.category ?? null,
        failureReason: (err instanceof Error ? err.message : String(err)).slice(
          0,
          500,
        ),
        sentAt: null,
      },
    });
  } catch (auditErr) {
    console.warn(
      '[notifications.send] could not record the failed send:',
      auditErr instanceof Error ? auditErr.message : auditErr,
    );
  }
}

export async function send(input: SendInput): Promise<SendResult> {
  try {
    return await dispatch(input);
  } catch (err) {
    if (input.audit !== false) await recordFailedSend(input, err);
    throw err;
  }
}

async function dispatch(input: SendInput): Promise<SendResult> {
  await new Promise((r) => setTimeout(r, 1));

  switch (input.channel) {
    case 'SMS': {
      if (!input.recipient.phone) throw new Error('No phone number to text.');
      const r = await sendSms({
        to: input.recipient.phone,
        body: input.subject ? `${input.subject}\n${input.body}` : input.body,
      });
      return { externalRef: r.sid, providerMessageId: r.sid };
    }
    case 'PUSH': {
      if (!input.recipient.userId) throw new Error('Push needs a signed-in recipient.');
      if (!anyPushConfigured()) throw new PushNotConfiguredError();
      await sendPushToUser(input.recipient.userId, {
        title: input.subject ?? getBrandingSync().orgName,
        body: input.body,
      });
      return { externalRef: null, providerMessageId: null };
    }
    case 'EMAIL':
      return sendEmail(input);
    case 'IN_APP':
      return { externalRef: null, providerMessageId: null };
    case 'WHATSAPP':
      // Real WhatsApp sends go through lib/whatsapp (registered templates,
      // receipts, the 24-hour window); this generic sender cannot honour
      // those rules, so it refuses — recorded NOT_CONFIGURED, never a stub
      // reference written down as SENT.
      throw new WhatsAppNotRoutedError();
  }
}

async function sendEmail(input: SendInput): Promise<SendResult> {
  const to = input.recipient.email;
  if (!to) {
    return {
      externalRef: `${STUB_EMAIL_REF_PREFIX}no-recipient-${Math.random().toString(36).slice(2, 8)}`,
      providerMessageId: null,
    };
  }
  // Do-not-email gate. Checked before BOTH the stub and real branches so
  // behavior is identical across environments (and testable without Resend
  // credentials). Continuing to mail hard-bounced/complaining addresses
  // tanks domain reputation for every other recipient, so this throws —
  // never a silent "pretend it sent".
  // Decision 5 (multi-tenancy §10): one sending domain, so one list — an
  // address any tenant's mail bounced from is suppressed for every tenant.
  // The email is unique across the platform, so this is a key lookup, not a search.
  const suppression = await withIdentityScope(() =>
    prisma.emailSuppression.findUnique({
      where: { email: to.trim().toLowerCase() },
      select: { reason: true },
    }),
  );
  if (suppression) {
    console.warn(
      `[notifications.send] suppressed email to ${to} — address is on the ` +
        `do-not-email list (${suppression.reason}). Remove it under ` +
        `Communications → Suppressed emails to resume delivery.`,
    );
    throw new EmailSuppressedError(to, suppression.reason);
  }
  if (!emailConfigured()) {
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
    return {
      externalRef: `${STUB_EMAIL_REF_PREFIX}${Math.random().toString(36).slice(2, 10)}`,
      providerMessageId: null,
    };
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
    if (input.includeUnsubscribe) {
      // RFC 8058 one-click unsubscribe for broadcast/announcement mail.
      // The https URL is what Gmail/Yahoo POST on "unsubscribe" (no body
      // parsing needed — the HMAC token binds the recipient); the mailto
      // is the fallback for older clients. Transactional mail must not
      // set includeUnsubscribe, so it never carries these headers.
      const token = mintUnsubscribeToken(to);
      const unsubscribeUrl = `${publicBaseUrl()}/api/communications/unsubscribe/${token}`;
      const mailtoAddr =
        env.RESEND_REPLY_TO ??
        (from ? (from.match(/<([^>]+)>/)?.[1] ?? from) : null);
      payload.headers = {
        'List-Unsubscribe': mailtoAddr
          ? `<${unsubscribeUrl}>, <mailto:${mailtoAddr}?subject=unsubscribe>`
          : `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
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
    // The Resend id doubles as externalRef (back-compat with every caller
    // that only stores that column) AND as the dedicated providerMessageId
    // the /resend/webhook matcher prefers.
    return { externalRef: json.id ?? null, providerMessageId: json.id ?? null };
  } catch (err) {
    // Surface the failure to the route handler so the Notification row gets
    // FAILED status. The route already wraps this in try/catch.
    throw err instanceof Error ? err : new Error(String(err));
  }
}
