import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../../config/env.js';

/**
 * Intuit's change notifications: the body is signed with the app's webhook
 * verifier token — intuit-signature is base64(HMAC-SHA256(verifier, raw body)).
 */

export function webhookVerifier(): string | null {
  return env.INTUIT_WEBHOOK_VERIFIER ?? process.env.INTUIT_WEBHOOK_VERIFIER ?? null;
}

export function signWebhook(body: Buffer | string, verifier: string): string {
  return createHmac('sha256', verifier).update(body).digest('base64');
}

export function verifyWebhook(body: Buffer, signature: string | undefined, verifier: string | null = webhookVerifier()): boolean {
  if (!verifier || !signature) return false;
  const a = Buffer.from(signWebhook(body, verifier));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WebhookNotice {
  realmId: string;
  entities: Array<{ name: string; id: string; operation: string }>;
}

/** The notifications in a webhook body (empty when it isn't one). */
export function parseWebhook(body: Buffer): WebhookNotice[] {
  try {
    const j = JSON.parse(body.toString('utf8')) as { eventNotifications?: Array<{ realmId?: string; dataChangeEvent?: { entities?: Array<{ name?: string; id?: string; operation?: string }> } }> };
    return (j.eventNotifications ?? [])
      .filter((n) => n.realmId)
      .map((n) => ({ realmId: String(n.realmId), entities: (n.dataChangeEvent?.entities ?? []).map((e) => ({ name: String(e.name ?? ''), id: String(e.id ?? ''), operation: String(e.operation ?? '') })) }));
  } catch {
    return [];
  }
}
