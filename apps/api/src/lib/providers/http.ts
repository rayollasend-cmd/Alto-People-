import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The one way provider adapters call out: a timeout, JSON in and out, and
 * a ProviderError that carries the vendor's own message (never a body that
 * could hold PII) so the failure reads in the UI as what broke.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string = 'provider_error',
  ) {
    super(message);
  }
}

export interface ProviderResponse<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  json: T;
  text: string;
}

export async function providerFetch<T = Record<string, unknown>>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<ProviderResponse<T>> {
  if (!url || !/^https:\/\//.test(url)) {
    throw new ProviderError('The provider address must start with https://.', null, 'bad_base_url');
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProviderError(timedOut ? 'The provider did not answer in time.' : 'Could not reach the provider.', null, timedOut ? 'timeout' : 'unreachable');
  }
  const text = await res.text();
  let json = {} as T;
  try {
    json = (text ? JSON.parse(text) : {}) as T;
  } catch {
    /* XML or plain text: callers that expect it read `text` */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** The vendor's error message out of the common JSON error shapes, trimmed. */
export function vendorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const pick = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const fromErrors = Array.isArray(o.errors)
      ? o.errors
          .map((e) => (typeof e === 'string' ? e : e && typeof e === 'object' ? pick((e as Record<string, unknown>).message) ?? pick((e as Record<string, unknown>).Message) : null))
          .filter(Boolean)
          .join('; ')
      : null;
    const msg = fromErrors || pick(o.error) || pick(o.message) || pick(o.Message) || pick((o.Errors as Record<string, unknown> | undefined)?.Message);
    if (msg) return msg.slice(0, 300);
  }
  return fallback;
}

/** Constant-time compare of two signature strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** HMAC-SHA256 of a raw body, hex or base64. */
export function hmac(secret: string, data: string | Buffer, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}
