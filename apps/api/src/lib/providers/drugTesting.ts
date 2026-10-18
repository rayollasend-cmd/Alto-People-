import { hmac, providerFetch, ProviderError, safeEqual, vendorMessage } from './http.js';
import type { ProviderContext } from './connections.js';

/**
 * Drug tests, behind one interface:
 *
 *   ESCREEN    eScreen (Abbott) is reached through its partner REST API —
 *              access and the exact contract come with the partner
 *              agreement. The shape here (POST /orders → donor pass URL,
 *              expiry, collection site; GET /orders/:id → status, result,
 *              MRO verification) is the common one — confirm with eScreen.
 *   QUEST_ESP  Quest's Employer Solutions Portal accepts XML web service
 *              transactions: CreateOrder in, OrderStatus and OrderResult
 *              out (per Quest's ESP technical FAQ). Element names below
 *              are the documented method names with fields we could not
 *              confirm publicly — confirm with ESP support.
 *
 * The existing manual entry stays available whatever is connected.
 */

export interface DonorInput {
  ref: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  zip: string | null;
  dob: string | null;
}

export interface DrugOrder {
  externalId: string;
  donorPassUrl: string | null;
  donorPassExpiresAt: string | null;
  collectionSite: string | null;
  rawStatus: string;
}

export interface DrugStatus {
  externalId: string;
  rawStatus: string;
  /** NEGATIVE | POSITIVE | DILUTE | CANCELLED | null while pending */
  resultCode: 'NEGATIVE' | 'POSITIVE' | 'DILUTE' | 'CANCELLED' | null;
  mroVerified: boolean;
}

export interface DrugEvent extends DrugStatus {
  eventId: string;
}

export interface DrugTestProvider {
  test(ctx: ProviderContext): Promise<void>;
  order(ctx: ProviderContext, donor: DonorInput, panel: string, reason: string): Promise<DrugOrder>;
  status(ctx: ProviderContext, externalId: string): Promise<DrugStatus>;
  parseWebhook(ctx: ProviderContext, raw: Buffer, headers: Record<string, string | undefined>): DrugEvent;
}

export function normalizeResult(v: unknown): DrugStatus['resultCode'] {
  const s = String(v ?? '').toUpperCase();
  if (s.startsWith('NEG')) return 'NEGATIVE';
  if (s.startsWith('POS') || s === 'NON-NEGATIVE' || s === 'NON_NEGATIVE') return 'POSITIVE';
  if (s.includes('DILUTE')) return 'DILUTE';
  if (s.includes('CANCEL')) return 'CANCELLED';
  return null;
}

function verifyShared(ctx: ProviderContext, raw: Buffer, headers: Record<string, string | undefined>): void {
  const sig = headers['x-signature'];
  if (!ctx.webhookSecret || !sig || !safeEqual(hmac(ctx.webhookSecret, raw), sig)) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
}

/* ----- eScreen ------------------------------------------------------------ */

async function escreen(ctx: ProviderContext, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await providerFetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.credentials.apiKey ?? ''}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new ProviderError(vendorMessage(r.json, `eScreen answered ${r.status}.`), r.status);
  return r.json;
}

export const escreenTesting: DrugTestProvider = {
  async test(ctx) {
    await escreen(ctx, 'GET', `/accounts/${encodeURIComponent(ctx.credentials.accountId ?? '')}`);
  },
  async order(ctx, donor, panel, reason) {
    const j = await escreen(ctx, 'POST', '/orders', { accountId: ctx.credentials.accountId, reference: donor.ref, donor, panel, reason });
    return {
      externalId: String(j.orderId ?? j.id ?? ''),
      donorPassUrl: typeof j.donorPassUrl === 'string' ? j.donorPassUrl : null,
      donorPassExpiresAt: typeof j.donorPassExpiresAt === 'string' ? j.donorPassExpiresAt : null,
      collectionSite: typeof j.collectionSite === 'string' ? j.collectionSite : null,
      rawStatus: String(j.status ?? 'ordered'),
    };
  },
  async status(ctx, id) {
    const j = await escreen(ctx, 'GET', `/orders/${encodeURIComponent(id)}`);
    return { externalId: id, rawStatus: String(j.status ?? ''), resultCode: normalizeResult(j.result), mroVerified: j.mroVerified === true };
  },
  parseWebhook(ctx, raw, headers) {
    verifyShared(ctx, raw, headers);
    const j = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const id = String(j.orderId ?? j.id ?? '');
    return { eventId: String(j.eventId ?? `${id}:${j.status}:${j.result ?? ''}`), externalId: id, rawStatus: String(j.status ?? ''), resultCode: normalizeResult(j.result), mroVerified: j.mroVerified === true };
  },
};

/* ----- Quest ESP (XML) ---------------------------------------------------- */

const xmlEscape = (s: string | null | undefined) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml);
  return m ? m[1]!.trim() : null;
}

async function quest(ctx: ProviderContext, method: 'CreateOrder' | 'OrderStatus', inner: string): Promise<string> {
  // CONFIRM WITH ESP SUPPORT: the envelope and element names.
  const body = `<?xml version="1.0" encoding="UTF-8"?><${method}Request><Credentials><UserName>${xmlEscape(ctx.credentials.username)}</UserName><Password>${xmlEscape(ctx.credentials.password)}</Password></Credentials>${inner}</${method}Request>`;
  const r = await providerFetch(`${ctx.baseUrl}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body });
  if (!r.ok) throw new ProviderError(tag(r.text, 'ErrorMessage') ?? `Quest answered ${r.status}.`, r.status);
  const err = tag(r.text, 'ErrorMessage');
  if (err) throw new ProviderError(err, r.status);
  return r.text;
}

export const questTesting: DrugTestProvider = {
  async test(ctx) {
    await quest(ctx, 'OrderStatus', `<AccountNumber>${xmlEscape(ctx.credentials.accountNumber)}</AccountNumber><ReferenceTestID>connection-test</ReferenceTestID>`).catch((e) => {
      // An unknown reference is a successful login.
      if (e instanceof ProviderError && /not found|unknown/i.test(e.message)) return '';
      throw e;
    });
  },
  async order(ctx, donor, panel, reason) {
    const xml = await quest(
      ctx,
      'CreateOrder',
      `<AccountNumber>${xmlEscape(ctx.credentials.accountNumber)}</AccountNumber><ClientReferenceID>${xmlEscape(donor.ref)}</ClientReferenceID>` +
        `<Donor><FirstName>${xmlEscape(donor.firstName)}</FirstName><LastName>${xmlEscape(donor.lastName)}</LastName><Email>${xmlEscape(donor.email)}</Email><Phone>${xmlEscape(donor.phone)}</Phone><ZipCode>${xmlEscape(donor.zip)}</ZipCode></Donor>` +
        `<UnitCodes><UnitCode>${xmlEscape(panel)}</UnitCode></UnitCodes><ReasonForTest>${xmlEscape(reason)}</ReasonForTest><SendDonorEmail>true</SendDonorEmail>`,
    );
    return {
      externalId: tag(xml, 'ReferenceTestID') ?? tag(xml, 'QuestOrderID') ?? '',
      donorPassUrl: tag(xml, 'DonorPassURL'),
      donorPassExpiresAt: tag(xml, 'ExpirationDateTime'),
      collectionSite: tag(xml, 'CollectionSiteName'),
      rawStatus: tag(xml, 'OrderStatus') ?? 'ordered',
    };
  },
  async status(ctx, id) {
    const xml = await quest(ctx, 'OrderStatus', `<AccountNumber>${xmlEscape(ctx.credentials.accountNumber)}</AccountNumber><ReferenceTestID>${xmlEscape(id)}</ReferenceTestID>`);
    return { externalId: id, rawStatus: tag(xml, 'OrderStatus') ?? '', resultCode: normalizeResult(tag(xml, 'FinalResult') ?? tag(xml, 'Result')), mroVerified: !!tag(xml, 'MROVerificationDate') };
  },
  parseWebhook(ctx, raw, headers) {
    verifyShared(ctx, raw, headers);
    const xml = raw.toString('utf8');
    const id = tag(xml, 'ReferenceTestID') ?? '';
    const status = tag(xml, 'OrderStatus') ?? '';
    const result = tag(xml, 'FinalResult') ?? tag(xml, 'Result');
    return {
      eventId: tag(xml, 'TransactionID') ?? `${id}:${status}:${result ?? ''}`,
      externalId: id,
      rawStatus: status,
      resultCode: normalizeResult(result),
      mroVerified: !!tag(xml, 'MROVerificationDate'),
    };
  },
};

export function drugTestAdapter(provider: string): DrugTestProvider {
  if (provider === 'ESCREEN') return escreenTesting;
  if (provider === 'QUEST_ESP') return questTesting;
  throw new ProviderError(`${provider} is not a drug-test provider.`, null, 'wrong_kind');
}

/**
 * Alto's ledger status from a provider result. A negative is final from the
 * lab; a positive or dilute is only FAILED once a Medical Review Officer has
 * verified it — until then it needs review, never an automatic decision.
 */
export function drugLedgerStatus(s: Pick<DrugStatus, 'resultCode' | 'mroVerified' | 'rawStatus'>): 'INITIATED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED' | 'NEEDS_REVIEW' {
  if (s.resultCode === 'NEGATIVE') return 'PASSED';
  if (s.resultCode === 'POSITIVE') return s.mroVerified ? 'FAILED' : 'NEEDS_REVIEW';
  if (s.resultCode === 'DILUTE' || s.resultCode === 'CANCELLED') return 'NEEDS_REVIEW';
  return /collect|lab|progress|received|review/i.test(s.rawStatus) ? 'IN_PROGRESS' : 'INITIATED';
}
