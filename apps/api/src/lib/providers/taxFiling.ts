import { createHmac } from 'node:crypto';
import { hmac, providerFetch, ProviderError, safeEqual, vendorMessage } from './http.js';
import type { ProviderContext } from './connections.js';

/**
 * Tax filing through a filing partner. TaxBandits is the default:
 *
 *   documented  (developer.taxbandits.com, read 2026-10-17)
 *     auth      a JWS (HS256, claims iss=sub=ClientId, aud=UserToken, iat)
 *               signed with the ClientSecret, sent in the `Authentication`
 *               header to …/v2/tbsauth; the answer's `AccessToken` is a
 *               Bearer token for an hour. Sandbox
 *               https://testoauth.expressauth.net, production
 *               https://oauth.expressauth.net.
 *     flow      Business/Create → Form941/Create (SubmissionId, RecordId)
 *               → Form941/Transmit → Form941/Status; the same for 940,
 *               W-2 (W-3 is the transmittal TaxBandits builds), 1099 and
 *               1095-C.
 *     webhook   "E-file Status Change": headers Signature + TimeStamp; the
 *               signature is base64 HMAC-SHA256 of `${ClientId}\n${TimeStamp}`
 *               with the ClientSecret. Payload SubmissionId, FormType,
 *               Records[{ RecordId, Status, StatusTime, Errors[{Code,Message}] }].
 *   to confirm  the per-form request field names (the API reference pages
 *               were not readable) — marked below.
 */

export type FilableKind = 'F941' | 'F940' | 'W2' | 'W2C' | 'F1099_NEC' | 'F1099_MISC' | 'F1095C' | 'F1094C';

export interface Filer {
  ein: string;
  name: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

export interface FilingInput {
  ref: string;
  kind: FilableKind;
  taxYear: number;
  quarter: number | null;
  amounts: Record<string, unknown>;
  filer: Filer;
  /** W-2 / 1099 / 1095-C recipient. */
  recipient: { firstName: string; lastName: string; ssn: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null } | null;
}

export type EfileStatus = 'SUBMITTED' | 'SENT_TO_AGENCY' | 'ACCEPTED' | 'REJECTED';

export interface FilingResult {
  submissionId: string;
  recordId: string | null;
  status: EfileStatus;
  rejectionReason: string | null;
  /** The business id the partner created for the EIN, to keep in settings. */
  businessId?: string | null;
}

export interface FilingEvent {
  eventId: string;
  submissionId: string;
  records: Array<{ recordId: string; status: EfileStatus; reason: string | null }>;
}

export interface TaxFilingProvider {
  test(ctx: ProviderContext): Promise<void>;
  submit(ctx: ProviderContext, input: FilingInput): Promise<FilingResult>;
  status(ctx: ProviderContext, kind: FilableKind, submissionId: string, recordId: string | null): Promise<FilingResult>;
  parseWebhook(ctx: ProviderContext, raw: Buffer, headers: Record<string, string | undefined>): FilingEvent;
}

export function mapEfileStatus(raw: string): EfileStatus {
  const s = raw.toUpperCase().replace(/\s+/g, '_');
  if (s.startsWith('ACCEPTED')) return 'ACCEPTED';
  if (s.startsWith('REJECTED')) return 'REJECTED';
  if (s.includes('SENT') || s.includes('TRANSMITTED')) return 'SENT_TO_AGENCY';
  return 'SUBMITTED';
}

const ENDPOINT: Record<FilableKind, string> = {
  F941: 'Form941',
  F940: 'Form940',
  W2: 'FormW2',
  W2C: 'FormW2C',
  F1099_NEC: 'Form1099NEC',
  F1099_MISC: 'Form1099MISC',
  F1095C: 'Form1095C',
  // The 1094-C transmittal is built by the partner from the 1095-Cs it carries.
  F1094C: 'Form1095C',
};

const AUTH_URL = { SANDBOX: 'https://testoauth.expressauth.net/v2/tbsauth', PRODUCTION: 'https://oauth.expressauth.net/v2/tbsauth' };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The JWS TaxBandits asks for (exported for tests). */
export function taxBanditsJws(clientId: string, clientSecret: string, userToken: string, now = new Date()): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: clientId, sub: clientId, aud: userToken, iat: Math.floor(now.getTime() / 1000) }));
  const sig = b64url(createHmac('sha256', clientSecret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

const tokens = new Map<string, { token: string; until: number }>();

async function token(ctx: ProviderContext): Promise<string> {
  const hit = tokens.get(ctx.connectionId);
  if (hit && hit.until > Date.now()) return hit.token;
  const { clientId, clientSecret, userToken } = ctx.credentials;
  if (!clientId || !clientSecret || !userToken) throw new ProviderError('Enter the client ID, client secret and user token.', null, 'missing_credentials');
  const r = await providerFetch<{ AccessToken?: string; ExpiresIn?: number }>(AUTH_URL[ctx.environment], {
    method: 'GET',
    headers: { Authentication: taxBanditsJws(clientId, clientSecret, userToken) },
  });
  if (!r.ok || !r.json.AccessToken) throw new ProviderError(vendorMessage(r.json, 'TaxBandits refused the credentials.'), r.status, 'auth_failed');
  tokens.set(ctx.connectionId, { token: r.json.AccessToken, until: Date.now() + Math.max(60, (r.json.ExpiresIn ?? 3600) - 120) * 1000 });
  return r.json.AccessToken;
}

async function tb(ctx: ProviderContext, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await providerFetch(`${ctx.baseUrl}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token(ctx)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new ProviderError(vendorMessage(r.json, `TaxBandits answered ${r.status}.`), r.status);
  return r.json;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** The form's lines in TaxBandits' terms. CONFIRM FIELD NAMES against the API reference. */
function returnData(input: FilingInput): Record<string, unknown> {
  const a = input.amounts;
  switch (input.kind) {
    case 'F941':
      return {
        Quarter: `Q${input.quarter ?? 1}`,
        NumberOfEmployees: num(a.employeeCount),
        TotalWages: num(a.totalWages),
        FederalIncomeTaxWithheld: num(a.totalFederalWithheld),
        SocialSecurityWages: num(a.ficaSocialSecurityWages ?? a.totalWages),
        MedicareWages: num(a.ficaMedicareWages ?? a.totalWages),
        TotalTaxLiability: num(a.totalTaxLiability ?? a.totalEmployerTax),
        TotalDeposits: num(a.totalDeposits),
      };
    case 'F940':
      return { TotalPayments: num(a.totalPayments ?? a.totalWages), ExemptPayments: num(a.exemptPayments), FUTATaxableWages: num(a.futaTaxableWages), FUTATax: num(a.futaTax), TotalDeposits: num(a.totalDeposits) };
    case 'W2':
    case 'W2C':
      return {
        Box1: num(a.box1Wages),
        Box2: num(a.box2FitWithheld),
        Box3: num(a.box3SsWages),
        Box4: num(a.box4SsTax),
        Box5: num(a.box5MedicareWages),
        Box6: num(a.box6MedicareTax),
        States: Array.isArray(a.stateLines)
          ? (a.stateLines as Array<Record<string, unknown>>).map((l) => ({ StateCd: l.state, StateWages: num(l.stateWages), StateIncomeTax: num(l.stateIncomeTax) }))
          : [],
      };
    case 'F1099_NEC':
      return { B1NEC: num(a.box1NonemployeeCompensation), B4FedTaxWH: num(a.box4FitWithheld) };
    case 'F1099_MISC':
      return { B1Rents: num(a.box1Rents), B3OtherIncome: num(a.box3OtherIncome), B4FedTaxWH: num(a.box4FitWithheld) };
    case 'F1095C':
    case 'F1094C':
      return { Months: a.months ?? a, PlanStartMonth: a.planStartMonth ?? '01' };
  }
}

async function ensureBusiness(ctx: ProviderContext, filer: Filer): Promise<string> {
  const existing = typeof ctx.settings.businessId === 'string' && ctx.settings.businessId ? ctx.settings.businessId : null;
  if (existing) return existing;
  const j = await tb(ctx, 'POST', 'Business/Create', {
    BusinessNm: filer.name,
    EINorSSN: filer.ein.replace(/\D/g, ''),
    IsEIN: true,
    ContactNm: filer.contactName,
    Phone: filer.contactPhone?.replace(/\D/g, '') ?? null,
    USAddress: { Address1: filer.addressLine1, City: filer.city, State: filer.state, ZipCd: filer.zip },
  });
  const id = String(j.BusinessId ?? '');
  if (!id) throw new ProviderError(vendorMessage(j, 'TaxBandits did not return a business ID.'), null);
  return id;
}

function firstRecord(j: Record<string, unknown>): { recordId: string | null; status: string; reason: string | null } {
  const lists = ['SuccessRecords', 'Form941Records', 'FormRecords', 'Records'];
  for (const k of lists) {
    const v = (j[k] as { SuccessRecords?: unknown[] } | unknown[] | undefined) ?? null;
    const arr = Array.isArray(v) ? v : Array.isArray((v as { SuccessRecords?: unknown[] } | null)?.SuccessRecords) ? (v as { SuccessRecords: unknown[] }).SuccessRecords : null;
    if (arr && arr.length) {
      const r = arr[0] as Record<string, unknown>;
      const errs = Array.isArray(r.Errors) ? (r.Errors as Array<{ Message?: string }>).map((e) => e.Message).filter(Boolean).join('; ') : null;
      return { recordId: r.RecordId ? String(r.RecordId) : null, status: String(r.Status ?? r.RecordStatus ?? 'SUBMITTED'), reason: errs || null };
    }
  }
  return { recordId: null, status: String(j.SubmissionStatus ?? j.Status ?? 'SUBMITTED'), reason: null };
}

export const taxBandits: TaxFilingProvider = {
  async test(ctx) {
    await token(ctx);
  },
  async submit(ctx, input) {
    const businessId = await ensureBusiness(ctx, input.filer);
    const ep = ENDPOINT[input.kind];
    const recipient = input.recipient
      ? {
          FirstNm: input.recipient.firstName,
          LastNm: input.recipient.lastName,
          SSN: input.recipient.ssn,
          USAddress: { Address1: input.recipient.addressLine1, City: input.recipient.city, State: input.recipient.state, ZipCd: input.recipient.zip },
        }
      : null;
    const created = await tb(ctx, 'POST', `${ep}/Create`, {
      SubmissionManifest: { TaxYear: String(input.taxYear), IsFederalFiling: true },
      ReturnHeader: { Business: { BusinessId: businessId } },
      ReturnData: [{ SequenceId: input.ref, ...(recipient ? { Recipient: recipient, Employee: recipient } : {}), ...returnData(input) }],
    });
    const submissionId = String(created.SubmissionId ?? '');
    const rec = firstRecord(created);
    if (!submissionId) throw new ProviderError(vendorMessage(created, 'TaxBandits did not accept the return.'), null);
    if (rec.reason) return { submissionId, recordId: rec.recordId, status: 'REJECTED', rejectionReason: rec.reason, businessId };
    const sent = await tb(ctx, 'POST', `${ep}/Transmit`, { SubmissionId: submissionId, RecordIds: rec.recordId ? [rec.recordId] : undefined });
    const after = firstRecord(sent);
    const status = mapEfileStatus(after.status === 'SUBMITTED' ? String(sent.SubmissionStatus ?? 'TRANSMITTED') : after.status);
    return { submissionId, recordId: rec.recordId, status, rejectionReason: after.reason, businessId };
  },
  async status(ctx, kind, submissionId, recordId) {
    const qs = new URLSearchParams({ SubmissionId: submissionId, ...(recordId ? { RecordIds: recordId } : {}) });
    const j = await tb(ctx, 'GET', `${ENDPOINT[kind]}/Status?${qs.toString()}`);
    const rec = firstRecord(j);
    return { submissionId, recordId: rec.recordId ?? recordId, status: mapEfileStatus(rec.status), rejectionReason: rec.reason };
  },
  parseWebhook(ctx, raw, headers) {
    const sig = headers.signature;
    const ts = headers.timestamp;
    const { clientId, clientSecret } = ctx.credentials;
    if (!sig || !ts || !clientId || !clientSecret) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
    if (!safeEqual(hmac(clientSecret, `${clientId}\n${ts}`, 'base64'), sig)) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
    const j = JSON.parse(raw.toString('utf8')) as { SubmissionId?: string; Records?: Array<Record<string, unknown>> };
    const submissionId = String(j.SubmissionId ?? '');
    const records = (j.Records ?? []).map((r) => ({
      recordId: String(r.RecordId ?? ''),
      status: mapEfileStatus(String(r.Status ?? '')),
      reason: Array.isArray(r.Errors) ? (r.Errors as Array<{ Message?: string }>).map((e) => e.Message).filter(Boolean).join('; ') || null : null,
    }));
    return { eventId: `${submissionId}:${ts}`, submissionId, records };
  },
};

export function taxFilingAdapter(provider: string): TaxFilingProvider {
  if (provider === 'TAXBANDITS') return taxBandits;
  throw new ProviderError(`${provider} is not a tax filing provider.`, null, 'wrong_kind');
}
