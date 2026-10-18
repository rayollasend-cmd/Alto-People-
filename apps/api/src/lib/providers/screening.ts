import { hmac, providerFetch, ProviderError, safeEqual, vendorMessage } from './http.js';
import type { ProviderContext } from './connections.js';

/**
 * Background checks, behind one interface:
 *
 *   CHECKR             documented: https://docs.checkr.com (read 2026-10-17).
 *                      Basic auth with the API key as the username; POST
 *                      /candidates, POST /invitations (candidate_id,
 *                      package, work_locations), GET /reports/:id (status
 *                      pending|complete|suspended|paused, result clear|
 *                      consider), POST /adverse_actions (report_id,
 *                      post_notice_scheduled_at), DELETE /adverse_actions/:id;
 *                      webhooks signed HMAC-SHA256 with the API key in
 *                      X-Checkr-Signature.
 *   GENERIC_SCREENING  Sterling / First Advantage style providers: an order
 *                      and status API behind a bearer key, HMAC-signed
 *                      webhooks. Shapes are the common pattern, not one
 *                      vendor's contract — confirm with your provider.
 */

export interface ScreeningCandidate {
  ref: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  zip: string | null;
  workState: string | null;
  workCity: string | null;
}

export interface ScreeningOrder {
  externalId: string;
  externalCandidateId: string | null;
  invitationUrl: string | null;
  rawStatus: string;
}

export interface ScreeningReport {
  externalId: string;
  rawStatus: string;
  /** clear | consider | null while pending */
  result: 'clear' | 'consider' | null;
  complete: boolean;
}

export interface ScreeningEvent {
  eventId: string;
  type: string;
  /** The report, or the invitation that leads to it. */
  objectId: string;
  reportId: string | null;
  rawStatus: string;
  result: 'clear' | 'consider' | null;
}

export interface ScreeningProvider {
  test(ctx: ProviderContext): Promise<void>;
  order(ctx: ProviderContext, c: ScreeningCandidate, packageCode: string): Promise<ScreeningOrder>;
  /** The report behind an order: Checkr's invitation id resolves to its report once the person completes it. */
  report(ctx: ProviderContext, externalId: string): Promise<ScreeningReport>;
  /** Start pre-adverse action; returns the provider's adverse action id when it runs the notices. */
  preAdverse(ctx: ProviderContext, reportId: string, postNoticeAt: Date): Promise<string | null>;
  cancelAdverse(ctx: ProviderContext, adverseActionId: string): Promise<void>;
  parseWebhook(ctx: ProviderContext, raw: Buffer, headers: Record<string, string | undefined>): ScreeningEvent;
}

const asResult = (v: unknown): 'clear' | 'consider' | null => (v === 'clear' || v === 'consider' ? v : null);

/* ----- Checkr ------------------------------------------------------------ */

async function checkr(ctx: ProviderContext, method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${ctx.credentials.apiKey ?? ''}:`).toString('base64');
  const r = await providerFetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new ProviderError(vendorMessage(r.json, `Checkr answered ${r.status}.`), r.status);
  return r.json;
}

export const checkrScreening: ScreeningProvider = {
  async test(ctx) {
    await checkr(ctx, 'GET', '/account');
  },
  async order(ctx, c, packageCode) {
    const cand = await checkr(ctx, 'POST', '/candidates', {
      first_name: c.firstName,
      last_name: c.lastName,
      email: c.email,
      ...(c.phone ? { phone: c.phone } : {}),
      ...(c.zip ? { zipcode: c.zip } : {}),
      custom_id: c.ref,
    });
    const inv = await checkr(ctx, 'POST', '/invitations', {
      candidate_id: cand.id,
      package: packageCode,
      work_locations: [{ country: 'US', ...(c.workState ? { state: c.workState } : {}), ...(c.workCity ? { city: c.workCity } : {}) }],
    });
    return {
      externalId: String(inv.id),
      externalCandidateId: String(cand.id),
      invitationUrl: typeof inv.invitation_url === 'string' ? inv.invitation_url : null,
      rawStatus: String(inv.status ?? 'pending'),
    };
  },
  async report(ctx, externalId) {
    // An invitation id until the person completes it; then its report.
    let reportId = externalId;
    if (!externalId.startsWith('rep') && !/^[0-9a-f]{24}$/.test(externalId)) {
      const inv = await checkr(ctx, 'GET', `/invitations/${encodeURIComponent(externalId)}`);
      if (!inv.report_id) return { externalId, rawStatus: String(inv.status ?? 'pending'), result: null, complete: false };
      reportId = String(inv.report_id);
    }
    const rep = await checkr(ctx, 'GET', `/reports/${encodeURIComponent(reportId)}`);
    const status = String(rep.status ?? 'pending');
    return { externalId: reportId, rawStatus: status, result: asResult(rep.result), complete: status === 'complete' };
  },
  async preAdverse(ctx, reportId, postNoticeAt) {
    const aa = await checkr(ctx, 'POST', '/adverse_actions', { report_id: reportId, post_notice_scheduled_at: postNoticeAt.toISOString() });
    return aa.id ? String(aa.id) : null;
  },
  async cancelAdverse(ctx, id) {
    await checkr(ctx, 'DELETE', `/adverse_actions/${encodeURIComponent(id)}`);
  },
  parseWebhook(ctx, raw, headers) {
    const sig = headers['x-checkr-signature'];
    const key = ctx.credentials.apiKey;
    if (!key || !sig || !safeEqual(hmac(key, raw), sig)) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
    const j = JSON.parse(raw.toString('utf8')) as { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
    const o = j.data?.object ?? {};
    const isReport = String(j.type ?? '').startsWith('report.');
    return {
      eventId: String(j.id ?? `${j.type}:${o.id}`),
      type: String(j.type ?? 'unknown'),
      objectId: String(o.id ?? ''),
      reportId: isReport ? String(o.id ?? '') : o.report_id ? String(o.report_id) : null,
      rawStatus: String(o.status ?? ''),
      result: asResult(o.result),
    };
  },
};

/* ----- Generic (Sterling, First Advantage…) ------------------------------ */

async function generic(ctx: ProviderContext, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await providerFetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.credentials.apiKey ?? ''}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new ProviderError(vendorMessage(r.json, `The screening provider answered ${r.status}.`), r.status);
  return r.json;
}

export const genericScreening: ScreeningProvider = {
  async test(ctx) {
    await generic(ctx, 'GET', '/packages');
  },
  async order(ctx, c, packageCode) {
    const j = await generic(ctx, 'POST', '/orders', { reference: c.ref, package: packageCode, candidate: c });
    return {
      externalId: String(j.id ?? j.orderId ?? ''),
      externalCandidateId: j.candidateId ? String(j.candidateId) : null,
      invitationUrl: typeof j.invitationUrl === 'string' ? j.invitationUrl : null,
      rawStatus: String(j.status ?? 'pending'),
    };
  },
  async report(ctx, externalId) {
    const j = await generic(ctx, 'GET', `/orders/${encodeURIComponent(externalId)}`);
    const status = String(j.status ?? 'pending');
    return { externalId, rawStatus: status, result: asResult(j.result), complete: status === 'complete' };
  },
  async preAdverse() {
    return null;
  },
  async cancelAdverse() {
    /* the provider runs no notices: nothing to cancel */
  },
  parseWebhook(ctx, raw, headers) {
    const sig = headers['x-signature'];
    if (!ctx.webhookSecret || !sig || !safeEqual(hmac(ctx.webhookSecret, raw), sig)) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
    const j = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const id = String(j.orderId ?? j.id ?? '');
    return { eventId: String(j.eventId ?? `${id}:${j.status}`), type: String(j.type ?? 'order.updated'), objectId: id, reportId: id, rawStatus: String(j.status ?? ''), result: asResult(j.result) };
  },
};

export function screeningAdapter(provider: string): ScreeningProvider {
  if (provider === 'CHECKR') return checkrScreening;
  if (provider === 'GENERIC_SCREENING') return genericScreening;
  throw new ProviderError(`${provider} is not a screening provider.`, null, 'wrong_kind');
}

/**
 * The package for a check: the most specific rule in the connection's
 * settings ({ packages: [{ clientId?, position?, package }] }), else the
 * default package.
 */
export function packageFor(settings: Record<string, unknown>, clientId: string | null, position: string | null): string | null {
  const rules = Array.isArray(settings.packages) ? (settings.packages as Array<{ clientId?: string | null; position?: string | null; package?: string }>) : [];
  const pos = position?.trim().toLowerCase() ?? null;
  const score = (r: { clientId?: string | null; position?: string | null }) =>
    (r.clientId ? (r.clientId === clientId ? 2 : -10) : 0) + (r.position ? (r.position.trim().toLowerCase() === pos ? 1 : -10) : 0);
  const best = rules.filter((r) => r.package && score(r) >= 0).sort((a, b) => score(b) - score(a))[0];
  if (best?.package) return best.package;
  return typeof settings.defaultPackage === 'string' && settings.defaultPackage ? settings.defaultPackage : null;
}
