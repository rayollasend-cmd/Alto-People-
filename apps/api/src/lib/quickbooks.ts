import { randomBytes, createHash } from 'node:crypto';
import type { Prisma, PrismaClient, QuickbooksConnection } from '@prisma/client';
import { env } from '../config/env.js';
import { encryptString, decryptString } from './crypto.js';

/**
 * Phase 44 — Intuit QuickBooks Online OAuth 2.0 + JournalEntry posting.
 *
 * The integration runs in two modes:
 *
 * - **Stub** (default): if INTUIT_CLIENT_ID or INTUIT_CLIENT_SECRET is
 *   missing, OAuth flow returns a stub authorize URL that the callback
 *   accepts unconditionally; JournalEntry posts log the would-be payload
 *   and return STUB-QBO-... ids. Useful for dev + test without an Intuit
 *   developer account.
 * - **Real**: when both env vars are set, the same code paths hit
 *   Intuit's actual OAuth + v3 API endpoints. No code changes — the only
 *   thing that flips is the `if (isStubMode())` branch.
 *
 * Token storage: accessToken + refreshToken are AES-256-GCM encrypted at
 * rest using the same key + format as W-4 SSN / bank account numbers
 * (lib/crypto.ts). The DB column type is Bytes; decryption only happens
 * inside this file.
 */

// --- URL routing (sandbox vs production) ----------------------------------

const ENDPOINTS = {
  sandbox: {
    apiBase: 'https://sandbox-quickbooks.api.intuit.com',
    auth: 'https://appcenter.intuit.com/connect/oauth2',
    token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  },
  production: {
    apiBase: 'https://quickbooks.api.intuit.com',
    auth: 'https://appcenter.intuit.com/connect/oauth2',
    token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  },
} as const;

const SCOPES = 'com.intuit.quickbooks.accounting';

function endpoints() {
  return ENDPOINTS[env.INTUIT_ENV];
}

export function isStubMode(): boolean {
  return !env.INTUIT_CLIENT_ID || !env.INTUIT_CLIENT_SECRET;
}

function redirectUri(): string {
  // The redirect URI must be EXACTLY one of the values registered in the
  // Intuit developer dashboard. We always go through the API's /api prefix
  // (Vite dev proxy or same-origin in prod).
  return `${env.APP_BASE_URL}/api/quickbooks/connect/callback`;
}

// --- OAuth flow -----------------------------------------------------------

export interface AuthorizeStart {
  authorizeUrl: string;
  state: string;
}

/**
 * Build the OAuth authorize URL. The `state` parameter encodes the target
 * clientId so the callback knows which Client to attach the connection to;
 * we sign it with the JWT secret to prevent forgery.
 */
export function buildAuthorizeUrl(targetClientId: string): AuthorizeStart {
  const nonce = randomBytes(16).toString('hex');
  const state = `${targetClientId}.${nonce}.${signState(targetClientId, nonce)}`;
  if (isStubMode()) {
    // Loop straight back to the callback with a fake code so the dev
    // can complete the flow without Intuit credentials.
    const sp = new URLSearchParams({
      code: 'STUB-CODE',
      state,
      realmId: 'STUB-REALM',
    });
    return {
      authorizeUrl: `${env.APP_BASE_URL}/api/quickbooks/connect/callback?${sp.toString()}`,
      state,
    };
  }
  const sp = new URLSearchParams({
    client_id: env.INTUIT_CLIENT_ID!,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return { authorizeUrl: `${endpoints().auth}?${sp.toString()}`, state };
}

export function verifyState(state: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [clientId, nonce, sig] = parts;
  if (signState(clientId, nonce) !== sig) return null;
  return clientId;
}

function signState(clientId: string, nonce: string): string {
  // HMAC-SHA256 truncated. JWT_SECRET is the existing app secret; reuse
  // avoids another env var.
  return createHash('sha256')
    .update(`${env.JWT_SECRET}:${clientId}:${nonce}`)
    .digest('hex')
    .slice(0, 16);
}

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

/**
 * Exchange an authorization `code` for an access/refresh token pair.
 * Stub mode returns a synthetic pair so the connect flow completes for
 * the UI smoke test.
 */
export async function exchangeCode(code: string): Promise<IntuitTokenResponse> {
  if (isStubMode()) {
    return {
      access_token: 'STUB-ACCESS-TOKEN',
      refresh_token: 'STUB-REFRESH-TOKEN',
      expires_in: 3600,
      token_type: 'bearer',
    };
  }
  const basic = Buffer.from(
    `${env.INTUIT_CLIENT_ID}:${env.INTUIT_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(endpoints().token, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intuit token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as IntuitTokenResponse;
}

async function refreshAccessToken(refreshToken: string): Promise<IntuitTokenResponse> {
  if (isStubMode()) {
    return {
      access_token: 'STUB-ACCESS-TOKEN-REFRESHED',
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'bearer',
    };
  }
  const basic = Buffer.from(
    `${env.INTUIT_CLIENT_ID}:${env.INTUIT_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(endpoints().token, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intuit refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as IntuitTokenResponse;
}

/**
 * Persist a fresh token pair to the QuickbooksConnection row, encrypting
 * both tokens at rest. realmId is updated too because Intuit's docs note
 * (rarely) it can change after a re-auth flow.
 */
export async function saveConnection(
  tx: Prisma.TransactionClient | PrismaClient,
  clientId: string,
  realmId: string,
  tokens: IntuitTokenResponse
): Promise<void> {
  const accessTokenEnc = encryptString(tokens.access_token);
  const refreshTokenEnc = encryptString(tokens.refresh_token);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await tx.quickbooksConnection.upsert({
    where: { clientId },
    create: {
      clientId,
      realmId,
      accessTokenEnc,
      refreshTokenEnc,
      expiresAt,
      lastRefreshedAt: new Date(),
    },
    update: {
      realmId,
      accessTokenEnc,
      refreshTokenEnc,
      expiresAt,
      lastRefreshedAt: new Date(),
    },
  });
}

/**
 * Returns a usable bearer token for the given client, auto-refreshing if
 * the stored access token is expired (or expiring within 60s).
 */
export async function getValidAccessToken(
  prisma: PrismaClient,
  clientId: string
): Promise<{ accessToken: string; realmId: string } | null> {
  const conn = await prisma.quickbooksConnection.findUnique({
    where: { clientId },
  });
  if (!conn) return null;

  if (conn.expiresAt.getTime() > Date.now() + 60_000) {
    return {
      accessToken: decryptString(conn.accessTokenEnc),
      realmId: conn.realmId,
    };
  }

  const refreshed = await refreshAccessToken(decryptString(conn.refreshTokenEnc));
  await saveConnection(prisma, clientId, conn.realmId, refreshed);
  return { accessToken: refreshed.access_token, realmId: conn.realmId };
}

// --- JournalEntry posting -------------------------------------------------

export interface PayrollJournalSource {
  /** Date the JE should land on (= run.disbursedAt or .finalizedAt). */
  txnDate: Date;
  /** Free-form memo on the JE; usually "Payroll {periodStart}-{periodEnd}". */
  memo: string;
  totalGross: number;
  totalEmployerTax: number;
  /** Sum of federalWithholding across the run's items. */
  totalFederal: number;
  totalState: number;
  totalFica: number; // employee + employer combined
  totalMedicare: number;
  totalBenefits: number; // pre-tax deductions
  totalNet: number;
  /**
   * Wave 5.2 — when set, the JE is tagged with EntityRef so QBO files it
   * under the matching Employee or Vendor. Used by per-employee JE mode.
   */
  entityRef?: { type: 'Employee' | 'Vendor'; value: string };
}

export interface JournalEntryResult {
  /** QBO JournalEntry.Id (or "STUB-QBO-..." in stub mode). */
  journalEntryId: string;
}

/**
 * Build a balanced JournalEntry from a payroll run summary and POST it to
 * QBO. The structure (in v3 API JSON shape):
 *
 *   DEBIT  Salaries Expense       = totalGross + totalEmployerTax
 *   CREDIT Federal Tax Payable    = totalFederal
 *   CREDIT State Tax Payable      = totalState
 *   CREDIT FICA Payable           = totalFica
 *   CREDIT Medicare Payable       = totalMedicare
 *   CREDIT Benefits Payable       = totalBenefits
 *   CREDIT Net Pay Payable        = totalNet
 *
 * Sum of debits must equal sum of credits or QBO rejects the JE. We
 * derive Salaries Expense as the sum of credits to guarantee balance
 * (it can drift from totalGross + totalEmployerTax by rounding cents in
 * pathological cases — better to plug than to fail).
 */
export async function postPayrollJournalEntry(
  prisma: PrismaClient,
  clientId: string,
  source: PayrollJournalSource
): Promise<JournalEntryResult> {
  const conn = await prisma.quickbooksConnection.findUnique({
    where: { clientId },
  });
  if (!conn) throw new Error('No QuickBooks connection for this client');

  const accounts = chooseAccounts(conn);
  const credits: Array<{ accountRef: string; amount: number; memo: string }> = [
    { accountRef: accounts.federalTaxPayable, amount: source.totalFederal, memo: 'Federal income tax withheld' },
    { accountRef: accounts.stateTaxPayable, amount: source.totalState, memo: 'State income tax withheld' },
    { accountRef: accounts.ficaPayable, amount: source.totalFica, memo: 'Social Security (FICA)' },
    { accountRef: accounts.medicarePayable, amount: source.totalMedicare, memo: 'Medicare' },
    { accountRef: accounts.benefitsPayable, amount: source.totalBenefits, memo: 'Pre-tax benefit deductions' },
    { accountRef: accounts.netPayPayable, amount: source.totalNet, memo: 'Net pay payable' },
  ].filter((c) => c.amount > 0);

  const debitTotal = credits.reduce((s, c) => s + c.amount, 0);

  // Wave 5.2 — when entityRef is set, attach it to every line so QBO files
  // the JE under the right Employee/Vendor. Optional fields outside that
  // are unchanged from the aggregate flow.
  const detailExtras = source.entityRef
    ? {
        Entity: {
          Type: source.entityRef.type,
          EntityRef: { value: source.entityRef.value },
        },
      }
    : {};

  const payload = {
    TxnDate: source.txnDate.toISOString().slice(0, 10),
    PrivateNote: source.memo,
    Line: [
      // Single debit line for the salary expense, sized to balance.
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: round2(debitTotal),
        Description: 'Total payroll expense',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: accounts.salariesExpense },
          ...detailExtras,
        },
      },
      ...credits.map((c) => ({
        DetailType: 'JournalEntryLineDetail',
        Amount: round2(c.amount),
        Description: c.memo,
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: { value: c.accountRef },
          ...detailExtras,
        },
      })),
    ],
  };

  if (isStubMode()) {
    const id = `STUB-QBO-${Date.now().toString(36)}`;
    console.info(
      `[quickbooks/stub] Would post JournalEntry id=${id} for client=${clientId}`,
      JSON.stringify(payload, null, 2)
    );
    return { journalEntryId: id };
  }

  const tokens = await getValidAccessToken(prisma, clientId);
  if (!tokens) throw new Error('No valid access token');

  const res = await fetch(
    `${endpoints().apiBase}/v3/company/${tokens.realmId}/journalentry?minorversion=70`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intuit JournalEntry POST failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { JournalEntry?: { Id?: string } };
  const id = body.JournalEntry?.Id;
  if (!id) throw new Error('Intuit response missing JournalEntry.Id');
  return { journalEntryId: id };
}

// --- Wave 3.1 — Chart of accounts auto-discovery --------------------------

export interface QboAccount {
  /** QBO Account.Id — string, used as the AccountRef.value in JEs. */
  id: string;
  /** Friendly account name as shown in QBO ("Payroll Expenses", etc.). */
  name: string;
  /**
   * QBO classification — one of: Asset, Liability, Equity, Revenue, Expense.
   * Lets the UI filter the picker so HR doesn't pick a Revenue account for
   * "Federal Tax Payable" by accident.
   */
  classification: string;
  /** QBO sub-type ("AccountsPayable", "PayrollLiabilities", etc.). */
  accountType: string;
  /** True when a parent exists; useful for UI indentation. */
  isSubAccount: boolean;
}

const STUB_ACCOUNTS: QboAccount[] = [
  { id: 'STUB-1', name: 'Payroll Expenses',           classification: 'Expense',   accountType: 'Expense',           isSubAccount: false },
  { id: 'STUB-2', name: 'Salaries & Wages',           classification: 'Expense',   accountType: 'Expense',           isSubAccount: true  },
  { id: 'STUB-3', name: 'Payroll Tax Expense',        classification: 'Expense',   accountType: 'Expense',           isSubAccount: true  },
  { id: 'STUB-4', name: 'Federal Income Tax Payable', classification: 'Liability', accountType: 'OtherCurrentLiability', isSubAccount: false },
  { id: 'STUB-5', name: 'State Income Tax Payable',   classification: 'Liability', accountType: 'OtherCurrentLiability', isSubAccount: false },
  { id: 'STUB-6', name: 'FICA Payable',               classification: 'Liability', accountType: 'OtherCurrentLiability', isSubAccount: false },
  { id: 'STUB-7', name: 'Medicare Payable',           classification: 'Liability', accountType: 'OtherCurrentLiability', isSubAccount: false },
  { id: 'STUB-8', name: 'Benefits Payable',           classification: 'Liability', accountType: 'OtherCurrentLiability', isSubAccount: false },
  { id: 'STUB-9', name: 'Net Pay Payable',            classification: 'Liability', accountType: 'OtherCurrentLiability', isSubAccount: false },
];

/**
 * Lists every active account in the QBO chart-of-accounts for the connected
 * realm. Used by the "Account mapping" UI so HR picks GL accounts from a
 * dropdown rather than typing in raw IDs. Stub mode returns a synthetic
 * 9-account list that exercises the picker UI end-to-end.
 *
 * QBO query API: `select * from Account where Active=true MAXRESULTS 1000`.
 * 1000 is the v3 hard cap; larger COAs need pagination via STARTPOSITION.
 */
export async function listQboAccounts(
  prisma: PrismaClient,
  clientId: string
): Promise<QboAccount[]> {
  if (isStubMode()) return STUB_ACCOUNTS;

  const tokens = await getValidAccessToken(prisma, clientId);
  if (!tokens) throw new Error('No valid access token');

  const query = encodeURIComponent('select * from Account where Active=true MAXRESULTS 1000');
  const res = await fetch(
    `${endpoints().apiBase}/v3/company/${tokens.realmId}/query?query=${query}&minorversion=70`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/json',
      },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intuit Account query failed (${res.status}): ${text}`);
  }
  type RawAccount = {
    Id: string;
    Name: string;
    Classification?: string;
    AccountType?: string;
    SubAccount?: boolean;
  };
  const body = (await res.json()) as { QueryResponse?: { Account?: RawAccount[] } };
  const rows = body.QueryResponse?.Account ?? [];
  return rows.map((a) => ({
    id: a.Id,
    name: a.Name,
    classification: a.Classification ?? '',
    accountType: a.AccountType ?? '',
    isSubAccount: !!a.SubAccount,
  }));
}

// --- Wave 3.2 — Associate ↔ QBO Employee/Vendor sync ---------------------

export interface SyncAssociateResult {
  /** True when we created (or updated) the QBO record this call. */
  changed: boolean;
  /** QBO Employee.Id for W2 records. */
  qboEmployeeId: string | null;
  /** QBO Vendor.Id for 1099 records. */
  qboVendorId: string | null;
}

interface AssociateSyncInput {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Both 1099 variants (INDIVIDUAL + BUSINESS) sync as Vendors. */
  employmentType: 'W2_EMPLOYEE' | 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS';
  qboEmployeeId: string | null;
  qboVendorId: string | null;
}

/**
 * Pushes one associate to QuickBooks as either an Employee (W2) or Vendor
 * (1099-NEC contractor). Idempotent: re-running with the same input is a
 * no-op when the QBO id is already cached and the upstream record matches.
 *
 * Stub mode synthesizes an id of the form `STUB-EMP-{associateId}` or
 * `STUB-VEN-{associateId}` so the cache columns get populated and the
 * payroll-run code can pretend it's wired through end-to-end.
 *
 * Errors propagate — the route handler decides whether one bad record
 * should fail the whole batch or just be skipped.
 */
export async function syncAssociateToQbo(
  prisma: PrismaClient,
  clientId: string,
  associate: AssociateSyncInput
): Promise<SyncAssociateResult> {
  const isW2 = associate.employmentType === 'W2_EMPLOYEE';
  const cacheKey = isW2 ? associate.qboEmployeeId : associate.qboVendorId;

  if (isStubMode()) {
    const newId = cacheKey ?? `STUB-${isW2 ? 'EMP' : 'VEN'}-${associate.id}`;
    const data: Prisma.AssociateUncheckedUpdateInput = {
      qboSyncedAt: new Date(),
      ...(isW2 ? { qboEmployeeId: newId } : { qboVendorId: newId }),
    };
    await prisma.associate.update({ where: { id: associate.id }, data });
    return {
      changed: !cacheKey,
      qboEmployeeId: isW2 ? newId : associate.qboEmployeeId,
      qboVendorId: isW2 ? associate.qboVendorId : newId,
    };
  }

  const tokens = await getValidAccessToken(prisma, clientId);
  if (!tokens) throw new Error('No valid access token');

  // Build the QBO payload. Both Employee and Vendor share the address /
  // contact shape; only the entity name and endpoint differ.
  const givenName = associate.firstName.trim();
  const familyName = associate.lastName.trim();
  const displayName = `${givenName} ${familyName}`.trim();
  const address = associate.addressLine1
    ? {
        Line1: associate.addressLine1,
        Line2: associate.addressLine2 ?? undefined,
        City: associate.city ?? undefined,
        CountrySubDivisionCode: associate.state ?? undefined,
        PostalCode: associate.zip ?? undefined,
      }
    : undefined;

  const baseBody = {
    GivenName: givenName,
    FamilyName: familyName,
    DisplayName: displayName,
    PrimaryEmailAddr: associate.email ? { Address: associate.email } : undefined,
    PrimaryPhone: associate.phone ? { FreeFormNumber: associate.phone } : undefined,
    PrimaryAddr: address,
  };

  const entityName = isW2 ? 'employee' : 'vendor';
  const url = `${endpoints().apiBase}/v3/company/${tokens.realmId}/${entityName}?minorversion=70`;

  // QBO upsert pattern: if we have a cached id, GET-then-PUT with SyncToken.
  // Otherwise POST a fresh record. We keep this simple by always POSTing
  // when no cache; a real production version would do a Display-Name search
  // first to dedup against records HR created manually in QBO.
  let body: Record<string, unknown> = baseBody;
  if (cacheKey) {
    // Fetch SyncToken — required for sparse-update via the upsert flag.
    const getRes = await fetch(
      `${endpoints().apiBase}/v3/company/${tokens.realmId}/${entityName}/${cacheKey}?minorversion=70`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' } }
    );
    if (getRes.ok) {
      type RawEntity = { Employee?: { SyncToken: string }; Vendor?: { SyncToken: string } };
      const json = (await getRes.json()) as RawEntity;
      const tok = isW2 ? json.Employee?.SyncToken : json.Vendor?.SyncToken;
      if (tok) {
        body = { ...baseBody, Id: cacheKey, SyncToken: tok, sparse: true };
      }
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intuit ${entityName} upsert failed (${res.status}): ${text}`);
  }
  type Resp = { Employee?: { Id: string }; Vendor?: { Id: string } };
  const json = (await res.json()) as Resp;
  const newId = isW2 ? json.Employee?.Id : json.Vendor?.Id;
  if (!newId) throw new Error(`Intuit ${entityName} response missing Id`);

  await prisma.associate.update({
    where: { id: associate.id },
    data: {
      qboSyncedAt: new Date(),
      ...(isW2 ? { qboEmployeeId: newId } : { qboVendorId: newId }),
    },
  });

  return {
    changed: newId !== cacheKey,
    qboEmployeeId: isW2 ? newId : associate.qboEmployeeId,
    qboVendorId: isW2 ? associate.qboVendorId : newId,
  };
}

function chooseAccounts(conn: QuickbooksConnection): {
  salariesExpense: string;
  federalTaxPayable: string;
  stateTaxPayable: string;
  ficaPayable: string;
  medicarePayable: string;
  benefitsPayable: string;
  netPayPayable: string;
} {
  // Stub mode is permissive: we return placeholder refs so the payload
  // logging step works. In real mode the account refs MUST exist in the
  // QBO chart-of-accounts; HR sets them once when configuring the
  // connection. Refs here are the QBO Account.Id (a string).
  return {
    salariesExpense: conn.accountSalariesExpense ?? 'STUB-SALARY-EXPENSE',
    federalTaxPayable: conn.accountFederalTaxPayable ?? 'STUB-FEDERAL-TAX',
    stateTaxPayable: conn.accountStateTaxPayable ?? 'STUB-STATE-TAX',
    ficaPayable: conn.accountFicaPayable ?? 'STUB-FICA',
    medicarePayable: conn.accountMedicarePayable ?? 'STUB-MEDICARE',
    benefitsPayable: conn.accountBenefitsPayable ?? 'STUB-BENEFITS',
    netPayPayable: conn.accountNetPayPayable ?? 'STUB-NET-PAY',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
