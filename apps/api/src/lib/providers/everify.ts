import type { EVerifyStatus } from '@prisma/client';
import { hmac, providerFetch, ProviderError, safeEqual, vendorMessage } from './http.js';
import type { ProviderContext } from './connections.js';

/**
 * E-Verify, behind one interface with two adapters:
 *
 *   DHS_EVERIFY     direct E-Verify web services. Access requires a DHS web
 *                   services MOU and interface certification; the request
 *                   shapes come from the Interface Control Agreement, which
 *                   DHS issues to approved employers only. The paths and
 *                   field names below follow the ICA's REST resources as
 *                   publicly described ("cases", "referral", "close") —
 *                   CONFIRM EVERY FIELD AGAINST YOUR ICA before production.
 *   EVERIFY_AGENT   an E-Verify employer agent (an I-9 vendor) that holds
 *                   the DHS connection. Vendors differ; this adapter speaks
 *                   the common REST shape (POST /cases, GET /cases/:n,
 *                   POST /cases/:n/referral|no-action|close) with a bearer
 *                   key and HMAC-signed webhooks — confirm with your agent.
 *
 * Manual mode (no connection) stays: HR types into the government site and
 * records the outcome, as before.
 */

export interface EVerifyCaseInput {
  firstName: string;
  lastName: string;
  middleInitial: string | null;
  otherLastNames: string | null;
  dob: string;
  ssn: string;
  email: string | null;
  citizenshipStatus: string;
  alienNumber: string | null;
  workAuthExpiresAt: string | null;
  documentList: string | null;
  firstDayOfEmployment: string;
  /** Alto's reference, echoed back on webhooks. */
  ref: string;
}

export interface EVerifyCaseState {
  caseNumber: string;
  status: EVerifyStatus;
  rawStatus: string;
  closed: boolean;
}

export type EVerifyClosure = 'EMPLOYEE_CONTINUES_TO_WORK' | 'EMPLOYEE_NO_LONGER_EMPLOYED' | 'INCORRECT_DATA' | 'DUPLICATE_CASE' | 'TERMINATED_FOR_FINAL_NONCONFIRMATION';

export interface EVerifyProvider {
  test(ctx: ProviderContext): Promise<void>;
  createCase(ctx: ProviderContext, input: EVerifyCaseInput): Promise<EVerifyCaseState>;
  getCase(ctx: ProviderContext, caseNumber: string): Promise<EVerifyCaseState>;
  /** The employee chose to take action on a mismatch: refer the case to SSA/DHS. */
  refer(ctx: ProviderContext, caseNumber: string): Promise<EVerifyCaseState>;
  /** The employee chose not to take action: the mismatch becomes final. */
  noAction(ctx: ProviderContext, caseNumber: string): Promise<EVerifyCaseState>;
  close(ctx: ProviderContext, caseNumber: string, reason: EVerifyClosure): Promise<EVerifyCaseState>;
  /** Verify and read a webhook; null when the provider doesn't call back. */
  parseWebhook?(ctx: ProviderContext, raw: Buffer, headers: Record<string, string | undefined>): { eventId: string; caseNumber: string; rawStatus: string } | null;
}

/** The provider's case status, in words, to Alto's rolled-up status. */
export function mapEVerifyStatus(raw: string): { status: EVerifyStatus; closed: boolean } {
  const s = raw.toUpperCase().replace(/[\s-]+/g, '_');
  const closed = s.includes('CLOSED');
  if (s.includes('FINAL_NONCONFIRMATION') || s === 'FNC') return { status: 'FINAL_NONCONFIRMATION', closed };
  if (s.includes('CLOSE_CASE_AND_RESUBMIT')) return { status: 'CLOSE_CASE_AND_RESUBMIT', closed };
  if (s.includes('EMPLOYMENT_AUTHORIZED') || s === 'EA') return { status: 'EMPLOYMENT_AUTHORIZED', closed };
  if (s.includes('TENTATIVE') || s === 'TNC' || s.includes('PENDING_REFERRAL') || s.includes('REFERRED') || s.includes('CONTINUANCE') || s.includes('MISMATCH')) {
    return { status: 'TENTATIVE_NONCONFIRMATION', closed };
  }
  return { status: 'PENDING', closed };
}

function state(caseNumber: string, raw: string): EVerifyCaseState {
  const m = mapEVerifyStatus(raw);
  return { caseNumber, rawStatus: raw, status: m.status, closed: m.closed };
}

/* ----- DHS web services ------------------------------------------------ */

const dhsTokens = new Map<string, { token: string; until: number }>();

async function dhsToken(ctx: ProviderContext): Promise<string> {
  const cached = dhsTokens.get(ctx.connectionId);
  if (cached && cached.until > Date.now()) return cached.token;
  // CONFIRM WITH ICA: the authentication resource and its field names.
  const r = await providerFetch<{ access_token?: string; expires_in?: number }>(`${ctx.baseUrl}/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ctx.credentials.clientId, password: ctx.credentials.clientSecret }),
  });
  if (!r.ok || !r.json.access_token) throw new ProviderError(vendorMessage(r.json, 'E-Verify refused the user ID and password.'), r.status, 'auth_failed');
  dhsTokens.set(ctx.connectionId, { token: r.json.access_token, until: Date.now() + Math.max(60, (r.json.expires_in ?? 900) - 60) * 1000 });
  return r.json.access_token;
}

async function dhsCall(ctx: ProviderContext, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const token = await dhsToken(ctx);
  const r = await providerFetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new ProviderError(vendorMessage(r.json, `E-Verify answered ${r.status}.`), r.status);
  return r.json;
}

const caseNo = (j: Record<string, unknown>): string => String(j.case_number ?? j.caseNumber ?? '');
const caseStatus = (j: Record<string, unknown>): string => String(j.case_status ?? j.caseStatus ?? j.status ?? 'PENDING');

export const dhsEVerify: EVerifyProvider = {
  async test(ctx) {
    await dhsToken(ctx);
  },
  async createCase(ctx, input) {
    // CONFIRM WITH ICA: the case resource's field names.
    const j = await dhsCall(ctx, 'POST', '/cases', {
      company_id: ctx.credentials.companyId,
      first_name: input.firstName,
      last_name: input.lastName,
      middle_initial: input.middleInitial,
      other_last_names_used: input.otherLastNames,
      date_of_birth: input.dob,
      ssn: input.ssn,
      email_address: input.email,
      citizenship_status_code: input.citizenshipStatus,
      alien_number: input.alienNumber,
      expiration_date: input.workAuthExpiresAt,
      document_type: input.documentList,
      date_of_hire: input.firstDayOfEmployment,
      client_company_reference: input.ref,
    });
    return state(caseNo(j), caseStatus(j));
  },
  async getCase(ctx, n) {
    const j = await dhsCall(ctx, 'GET', `/cases/${encodeURIComponent(n)}`);
    return state(n, caseStatus(j));
  },
  async refer(ctx, n) {
    const j = await dhsCall(ctx, 'POST', `/cases/${encodeURIComponent(n)}/referral`, {});
    return state(n, caseStatus(j));
  },
  async noAction(ctx, n) {
    const j = await dhsCall(ctx, 'POST', `/cases/${encodeURIComponent(n)}/confirm-employee-notified`, { employee_decision: 'NO_ACTION' });
    return state(n, caseStatus(j));
  },
  async close(ctx, n, reason) {
    const j = await dhsCall(ctx, 'POST', `/cases/${encodeURIComponent(n)}/close`, { case_closure_reason_code: reason });
    return state(n, caseStatus(j) || 'CLOSED');
  },
};

/* ----- Employer agent ---------------------------------------------------- */

async function agentCall(ctx: ProviderContext, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await providerFetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.credentials.apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new ProviderError(vendorMessage(r.json, `The E-Verify agent answered ${r.status}.`), r.status);
  return r.json;
}

export const agentEVerify: EVerifyProvider = {
  async test(ctx) {
    await agentCall(ctx, 'GET', `/companies/${encodeURIComponent(ctx.credentials.companyId ?? '')}`);
  },
  async createCase(ctx, input) {
    const j = await agentCall(ctx, 'POST', '/cases', { companyId: ctx.credentials.companyId, reference: input.ref, employee: input });
    return state(caseNo(j), caseStatus(j));
  },
  async getCase(ctx, n) {
    return state(n, caseStatus(await agentCall(ctx, 'GET', `/cases/${encodeURIComponent(n)}`)));
  },
  async refer(ctx, n) {
    return state(n, caseStatus(await agentCall(ctx, 'POST', `/cases/${encodeURIComponent(n)}/referral`, {})));
  },
  async noAction(ctx, n) {
    return state(n, caseStatus(await agentCall(ctx, 'POST', `/cases/${encodeURIComponent(n)}/no-action`, {})));
  },
  async close(ctx, n, reason) {
    return state(n, caseStatus(await agentCall(ctx, 'POST', `/cases/${encodeURIComponent(n)}/close`, { reason })) || 'CLOSED');
  },
  parseWebhook(ctx, raw, headers) {
    const sig = headers['x-signature'];
    if (!ctx.webhookSecret || !sig || !safeEqual(hmac(ctx.webhookSecret, raw), sig)) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
    const j = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const n = caseNo(j);
    return { eventId: String(j.id ?? j.eventId ?? `${n}:${caseStatus(j)}`), caseNumber: n, rawStatus: caseStatus(j) };
  },
};

export function everifyAdapter(provider: string): EVerifyProvider {
  if (provider === 'DHS_EVERIFY') return dhsEVerify;
  if (provider === 'EVERIFY_AGENT') return agentEVerify;
  throw new ProviderError(`${provider} is not an E-Verify provider.`, null, 'wrong_kind');
}

/** Federal working days (Mon–Fri) after a date: the 8-day window to contact SSA/DHS after referral. */
export function addFederalWorkingDays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}
