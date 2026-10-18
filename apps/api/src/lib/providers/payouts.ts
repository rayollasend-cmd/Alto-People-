import { createVerify } from 'node:crypto';
import { ProviderError } from './http.js';
import type { ProviderContext } from './connections.js';
import { testWise, type WiseConfig } from '../wise.js';

/**
 * Payouts: Wise. The transfer itself (quote → recipient → transfer → fund)
 * lives in lib/wise.ts and already calls Wise; this file adds what a
 * tenant's own connection needs — its config, a connection test, and the
 * transfer state-change webhook.
 *
 *   webhook  Wise signs each delivery with its private key; the base64
 *            signature of the raw body is in X-Signature-SHA256 and is
 *            checked (RSA-SHA256) against Wise's published public key for
 *            the environment, which the admin pastes into the connection.
 *            Event `transfers#state-change`: data.resource.id (transfer id),
 *            data.current_state, data.previous_state, data.occurred_at.
 */

export function wiseConfigFor(ctx: ProviderContext): WiseConfig {
  return { apiKey: ctx.credentials.apiKey ?? '', profileId: ctx.credentials.profileId ?? '', baseUrl: ctx.baseUrl };
}

export async function testWiseConnection(ctx: ProviderContext): Promise<void> {
  const r = await testWise(wiseConfigFor(ctx));
  if (!r.ok) throw new ProviderError(r.message ?? 'Wise refused the token.', null, 'auth_failed');
}

export interface WiseTransferEvent {
  eventId: string;
  transferId: string;
  currentState: string;
  previousState: string | null;
}

export function parseWiseWebhook(ctx: ProviderContext, raw: Buffer, headers: Record<string, string | undefined>): WiseTransferEvent {
  const sig = headers['x-signature-sha256'];
  const key = typeof ctx.settings.webhookPublicKey === 'string' ? ctx.settings.webhookPublicKey.trim() : '';
  if (!sig || !key) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
  let valid: boolean;
  try {
    const v = createVerify('RSA-SHA256');
    v.update(raw);
    v.end();
    valid = v.verify(key, sig, 'base64');
  } catch {
    valid = false;
  }
  if (!valid) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
  const j = JSON.parse(raw.toString('utf8')) as {
    event_type?: string;
    sent_at?: string;
    subscription_id?: string;
    data?: { resource?: { id?: number | string }; current_state?: string; previous_state?: string; occurred_at?: string };
  };
  const transferId = String(j.data?.resource?.id ?? '');
  const current = String(j.data?.current_state ?? '');
  return {
    eventId: `${transferId}:${current}:${j.data?.occurred_at ?? j.sent_at ?? ''}`,
    transferId,
    currentState: current,
    previousState: j.data?.previous_state ?? null,
  };
}
