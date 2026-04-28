import type { NotificationChannel } from '@alto-people/shared';
import { env } from '../config/env.js';

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
    const payload: Record<string, unknown> = {
      from: env.RESEND_FROM,
      to: [to],
      subject: input.subject ?? '(no subject)',
      text: input.body,
    };
    if (input.attachments && input.attachments.length > 0) {
      payload.attachments = input.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
        content_type: a.contentType,
      }));
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
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
