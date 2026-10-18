import { activeConnection, contextFor, recordFailure, recordOutboundEvent, recordSuccess, type ProviderContext } from '../providers/connections.js';
import { ProviderError, providerFetch, vendorMessage } from '../providers/http.js';

/**
 * Full-service payroll tax through an embedded payroll provider.
 *
 * With a provider connected (Check or Zeal), the provider is the one that
 * remits each agency's tax and files its returns, and — where the
 * customer's contract says so — stands behind the penalty if it gets one
 * wrong. Alto keeps everything above it: time, pay rules, approvals,
 * margin, the ledger and the record. Without one, Alto runs "in house": it
 * computes and schedules every deposit and return, produces the files, and
 * the customer pays and files them, recording each confirmation.
 *
 * Request shapes. Both providers publish REST references; their partner
 * contracts govern the exact tax-deposit and filing endpoints, so every
 * path and field below that we could not confirm against a contract is
 * marked "CONFIRM WITH CHECK" / "CONFIRM WITH ZEAL". Nothing here is called
 * in tests — they mock fetch.
 */

export type EmbeddedProviderId = 'CHECK_HQ' | 'ZEAL';

export interface CompanySync {
  legalName: string;
  ein: string | null;
  address: { line1: string | null; city: string | null; state: string | null; zip: string | null };
  /** Each agency account: kind, jurisdiction, account number, deposit frequency, rate. */
  accounts: Array<{ kind: string; jurisdiction: string; accountNumber: string | null; depositFrequency: string; rate: number | null }>;
}

export interface TaxPaymentRequest {
  idempotencyKey: string;
  kind: string;
  jurisdiction: string;
  periodLabel: string;
  amount: number;
  dueDate: string;
  accountNumber: string | null;
}

export interface ReturnRequest {
  idempotencyKey: string;
  kind: string;
  jurisdiction: string;
  periodLabel: string;
  /** The figures as Alto generated them (the provider files its own copy and we compare). */
  totals: Record<string, number>;
}

export type RemoteStatus = 'SUBMITTED' | 'PAID' | 'FILED' | 'ACCEPTED' | 'REJECTED' | 'FAILED';

export interface RemoteResult {
  providerRef: string;
  status: RemoteStatus;
  confirmationNumber: string | null;
  message: string | null;
}

export interface EmbeddedPayrollProvider {
  id: EmbeddedProviderId;
  label: string;
  test(ctx: ProviderContext): Promise<void>;
  syncCompany(ctx: ProviderContext, company: CompanySync): Promise<{ externalCompanyId: string }>;
  submitTaxPayment(ctx: ProviderContext, p: TaxPaymentRequest): Promise<RemoteResult>;
  submitReturn(ctx: ProviderContext, r: ReturnRequest): Promise<RemoteResult>;
  status(ctx: ProviderContext, kind: 'payment' | 'return', providerRef: string): Promise<RemoteResult>;
}

function mapStatus(raw: unknown): RemoteStatus {
  const s = String(raw ?? '').toLowerCase();
  if (/(reject)/.test(s)) return 'REJECTED';
  if (/(fail|error|returned|cancel)/.test(s)) return 'FAILED';
  if (/(accept)/.test(s)) return 'ACCEPTED';
  if (/(filed)/.test(s)) return 'FILED';
  if (/(paid|remitted|settled|complete)/.test(s)) return 'PAID';
  return 'SUBMITTED';
}

async function call(ctx: ProviderContext, method: string, path: string, body: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const res = await providerFetch<Record<string, unknown>>(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.credentials.apiKey ?? ''}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ProviderError(vendorMessage(res.json, `The provider answered ${res.status}.`), res.status, 'provider_error');
  return res.json;
}

const idOf = (json: Record<string, unknown>): string => String(json.id ?? json.ID ?? json.uuid ?? '');

/** Check (checkhq.com). Base URLs and Bearer auth per Check's public docs; tax endpoints: CONFIRM WITH CHECK. */
const checkHq: EmbeddedPayrollProvider = {
  id: 'CHECK_HQ',
  label: 'Check',
  async test(ctx) {
    await call(ctx, 'GET', `/companies/${encodeURIComponent(String(ctx.settings.companyId ?? ''))}`, undefined);
  },
  async syncCompany(ctx, company) {
    const existing = String(ctx.settings.companyId ?? '');
    const payload = {
      legal_name: company.legalName,
      ein: company.ein,
      address: { line1: company.address.line1, city: company.address.city, state: company.address.state, postal_code: company.address.zip },
    };
    const json = existing ? await call(ctx, 'PATCH', `/companies/${existing}`, payload) : await call(ctx, 'POST', '/companies', payload);
    // Agency registrations: CONFIRM WITH CHECK (company tax parameters / jurisdictions).
    for (const a of company.accounts) {
      await call(ctx, 'POST', `/companies/${idOf(json) || existing}/tax_parameters`, { jurisdiction: a.jurisdiction, kind: a.kind, account_number: a.accountNumber, deposit_schedule: a.depositFrequency, rate: a.rate });
    }
    return { externalCompanyId: idOf(json) || existing };
  },
  async submitTaxPayment(ctx, p) {
    // CONFIRM WITH CHECK: Check remits tax from each payroll it funds; a standalone deposit is a partner endpoint.
    const json = await call(ctx, 'POST', `/companies/${ctx.settings.companyId ?? ''}/tax_deposits`, { jurisdiction: p.jurisdiction, kind: p.kind, period: p.periodLabel, amount: p.amount.toFixed(2), due_date: p.dueDate, account_number: p.accountNumber }, p.idempotencyKey);
    return { providerRef: idOf(json), status: mapStatus(json.status), confirmationNumber: (json.confirmation_number as string | undefined) ?? null, message: null };
  },
  async submitReturn(ctx, r) {
    // CONFIRM WITH CHECK: filings are produced by Check for companies it files for.
    const json = await call(ctx, 'POST', `/companies/${ctx.settings.companyId ?? ''}/tax_filings`, { jurisdiction: r.jurisdiction, form: r.kind, period: r.periodLabel, totals: r.totals }, r.idempotencyKey);
    return { providerRef: idOf(json), status: mapStatus(json.status), confirmationNumber: (json.confirmation_number as string | undefined) ?? null, message: null };
  },
  async status(ctx, kind, ref) {
    const json = await call(ctx, 'GET', `/${kind === 'payment' ? 'tax_deposits' : 'tax_filings'}/${encodeURIComponent(ref)}`, undefined);
    return { providerRef: ref, status: mapStatus(json.status), confirmationNumber: (json.confirmation_number as string | undefined) ?? null, message: (json.status_reason as string | undefined) ?? null };
  },
};

/** Zeal (zeal.com). Bearer auth per Zeal's public docs; tax endpoints: CONFIRM WITH ZEAL. */
const zeal: EmbeddedPayrollProvider = {
  id: 'ZEAL',
  label: 'Zeal',
  async test(ctx) {
    await call(ctx, 'GET', `/companies?companyID=${encodeURIComponent(String(ctx.settings.companyId ?? ''))}`, undefined);
  },
  async syncCompany(ctx, company) {
    const payload = {
      companyID: ctx.settings.companyId ?? undefined,
      business_name: company.legalName,
      ein: company.ein,
      business_address: { street1: company.address.line1, city: company.address.city, state: company.address.state, zip: company.address.zip },
      tax_accounts: company.accounts.map((a) => ({ jurisdiction: a.jurisdiction, type: a.kind, account_number: a.accountNumber, deposit_frequency: a.depositFrequency, rate: a.rate })), // CONFIRM WITH ZEAL
    };
    const json = await call(ctx, ctx.settings.companyId ? 'PATCH' : 'POST', '/companies', payload);
    return { externalCompanyId: String(json.companyID ?? ctx.settings.companyId ?? '') };
  },
  async submitTaxPayment(ctx, p) {
    const json = await call(ctx, 'POST', '/taxes/deposits', { companyID: ctx.settings.companyId, jurisdiction: p.jurisdiction, tax_type: p.kind, period: p.periodLabel, amount: p.amount, due_date: p.dueDate }, p.idempotencyKey); // CONFIRM WITH ZEAL
    return { providerRef: String(json.depositID ?? idOf(json)), status: mapStatus(json.status), confirmationNumber: (json.confirmation as string | undefined) ?? null, message: null };
  },
  async submitReturn(ctx, r) {
    const json = await call(ctx, 'POST', '/taxes/filings', { companyID: ctx.settings.companyId, jurisdiction: r.jurisdiction, form: r.kind, period: r.periodLabel, totals: r.totals }, r.idempotencyKey); // CONFIRM WITH ZEAL
    return { providerRef: String(json.filingID ?? idOf(json)), status: mapStatus(json.status), confirmationNumber: (json.confirmation as string | undefined) ?? null, message: null };
  },
  async status(ctx, kind, ref) {
    const json = await call(ctx, 'GET', `/taxes/${kind === 'payment' ? 'deposits' : 'filings'}/${encodeURIComponent(ref)}`, undefined); // CONFIRM WITH ZEAL
    return { providerRef: ref, status: mapStatus(json.status), confirmationNumber: (json.confirmation as string | undefined) ?? null, message: (json.reason as string | undefined) ?? null };
  },
};

const ADAPTERS: Record<EmbeddedProviderId, EmbeddedPayrollProvider> = { CHECK_HQ: checkHq, ZEAL: zeal };

export function embeddedAdapter(provider: string): EmbeddedPayrollProvider {
  const a = ADAPTERS[provider as EmbeddedProviderId];
  if (!a) throw new ProviderError(`No embedded payroll adapter for ${provider}.`, null, 'unknown_provider');
  return a;
}

/** Who pays and files: the connected provider (with its guarantee as the contract states), or in house. */
export interface FilingMode {
  mode: 'PROVIDER' | 'IN_HOUSE';
  connectionId: string | null;
  providerId: EmbeddedProviderId | null;
  providerLabel: string | null;
  /** Recorded from the customer's contract at connection time (settings.penaltyGuarantee). */
  penaltyGuarantee: boolean;
  environment: 'SANDBOX' | 'PRODUCTION' | null;
}

export async function filingMode(): Promise<FilingMode> {
  const row = await activeConnection('EMBEDDED_PAYROLL');
  if (!row) return { mode: 'IN_HOUSE', connectionId: null, providerId: null, providerLabel: null, penaltyGuarantee: false, environment: null };
  const settings = (row.settings as Record<string, unknown> | null) ?? {};
  const providerId = row.provider as EmbeddedProviderId;
  return {
    mode: 'PROVIDER',
    connectionId: row.id,
    providerId,
    providerLabel: ADAPTERS[providerId]?.label ?? row.provider,
    penaltyGuarantee: settings.penaltyGuarantee === true || settings.penaltyGuarantee === 'true',
    environment: row.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  };
}

/** Run one provider call with health and the outbound event recorded. */
export async function withProvider<T>(eventType: string, fn: (adapter: EmbeddedPayrollProvider, ctx: ProviderContext) => Promise<T>): Promise<T> {
  const row = await activeConnection('EMBEDDED_PAYROLL');
  if (!row) throw new ProviderError('No payroll provider is connected.', null, 'not_connected');
  const ctx = contextFor(row);
  try {
    const out = await fn(embeddedAdapter(row.provider), ctx);
    await recordSuccess(row.id);
    await recordOutboundEvent({ connection: ctx, kind: row.kind, eventType, ok: true, error: null });
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The provider call failed.';
    await recordFailure(row.id, message);
    await recordOutboundEvent({ connection: ctx, kind: row.kind, eventType, ok: false, error: message });
    throw err;
  }
}

/** For the connection test in routes/providerConnections. */
export async function testEmbeddedConnection(ctx: ProviderContext): Promise<void> {
  await embeddedAdapter(ctx.provider).test(ctx);
}

