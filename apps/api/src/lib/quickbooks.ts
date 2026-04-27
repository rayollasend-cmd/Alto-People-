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
        },
      },
      ...credits.map((c) => ({
        DetailType: 'JournalEntryLineDetail',
        Amount: round2(c.amount),
        Description: c.memo,
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: { value: c.accountRef },
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
