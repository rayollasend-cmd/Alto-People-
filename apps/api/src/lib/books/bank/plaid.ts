import type { ProviderConnection } from '@prisma/client';
import { prisma } from '../../../db.js';
import { contextFor, encryptCredentials, recordFailure, recordSuccess, type ProviderContext } from '../../providers/connections.js';
import { ProviderError, providerFetch } from '../../providers/http.js';
import { tenantIdForWrite } from '../../tenant.js';

/**
 * Plaid, for the books' bank and card feeds: Link (a token for the browser
 * widget, then the public token exchanged for an access token), the
 * accounts behind an Item, and /transactions/sync with its cursor.
 *
 * Credentials (client id, secret) live on the tenant's BANK_FEED provider
 * connection under Integrations. Each linked Item's access token is kept in
 * the same encrypted credentials blob, as `item:<itemId>` — never in a
 * plain column. Every Plaid call goes through PlaidClient, so a test swaps
 * in a fake with setPlaidClientFactory.
 */

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: { current: number | null; available: number | null; iso_currency_code?: string | null };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Plaid's sign: positive is money OUT of the account. */
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  check_number?: string | null;
}

export interface PlaidSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string; account_id?: string }>;
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidClient {
  linkTokenCreate(input: { userId: string; clientName: string }): Promise<{ link_token: string }>;
  publicTokenExchange(publicToken: string): Promise<{ access_token: string; item_id: string }>;
  accountsGet(accessToken: string): Promise<{ accounts: PlaidAccount[]; item: { institution_id?: string | null }; institutionName?: string | null }>;
  transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage>;
}

const BASE = { SANDBOX: 'https://sandbox.plaid.com', PRODUCTION: 'https://production.plaid.com' } as const;

function httpClient(ctx: ProviderContext): PlaidClient {
  const base = BASE[ctx.environment];
  const auth = { client_id: ctx.credentials.clientId ?? '', secret: ctx.credentials.secret ?? '' };
  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const r = await providerFetch<T & { error_message?: string; display_message?: string }>(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...auth, ...body }),
    });
    if (!r.ok) {
      const j = r.json as { error_message?: string; display_message?: string; error_code?: string };
      throw new ProviderError(j.display_message || j.error_message || `Plaid answered ${r.status}.`, r.status, j.error_code ?? 'plaid_error');
    }
    return r.json;
  };
  return {
    linkTokenCreate: ({ userId, clientName }) =>
      call('/link/token/create', { client_name: clientName.slice(0, 30), user: { client_user_id: userId }, products: ['transactions'], country_codes: ['US'], language: 'en' }),
    publicTokenExchange: (publicToken) => call('/item/public_token/exchange', { public_token: publicToken }),
    accountsGet: async (accessToken) => call('/accounts/get', { access_token: accessToken }),
    transactionsSync: (accessToken, cursor) => call('/transactions/sync', { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 }),
  };
}

let factory: (ctx: ProviderContext) => PlaidClient = httpClient;

/** Tests: swap the client. Pass null to restore the real one. */
export function setPlaidClientFactory(f: ((ctx: ProviderContext) => PlaidClient) | null): void {
  factory = f ?? httpClient;
}

/** The tenant's active Plaid connection, or null when none is set up. */
export async function plaidConnection(): Promise<ProviderConnection | null> {
  return prisma.providerConnection.findFirst({ where: { tenantId: tenantIdForWrite(), kind: 'BANK_FEED', active: true }, orderBy: { createdAt: 'desc' } });
}

export async function requirePlaid(): Promise<{ row: ProviderConnection; ctx: ProviderContext; client: PlaidClient }> {
  const row = await plaidConnection();
  if (!row) throw new ProviderError('Connect Plaid under Settings › Integrations first (Bank and card feeds).', null, 'plaid_not_configured');
  const ctx = contextFor(row);
  return { row, ctx, client: factory(ctx) };
}

export function clientFor(ctx: ProviderContext): PlaidClient {
  return factory(ctx);
}

/** Keep an Item's access token in the connection's encrypted credentials. */
export async function storeItemToken(row: ProviderConnection, itemId: string, accessToken: string): Promise<void> {
  const ctx = contextFor(row);
  await prisma.providerConnection.update({ where: { id: row.id }, data: { credentialsEnc: encryptCredentials({ ...ctx.credentials, [`item:${itemId}`]: accessToken }) } });
}

export function itemToken(ctx: ProviderContext, itemId: string): string | null {
  return ctx.credentials[`item:${itemId}`] ?? null;
}

/** BankFeedAccount.providerAccountId holds "<itemId>/<accountId>". */
export const plaidRef = (itemId: string, accountId: string) => `${itemId}/${accountId}`;
export function splitPlaidRef(ref: string | null): { itemId: string; accountId: string } | null {
  if (!ref) return null;
  const i = ref.indexOf('/');
  return i > 0 ? { itemId: ref.slice(0, i), accountId: ref.slice(i + 1) } : null;
}

/** The Integrations page's "Test connection": a link token proves the keys work. */
export async function testPlaidConnection(ctx: ProviderContext): Promise<void> {
  if (!ctx.credentials.clientId || !ctx.credentials.secret) throw new ProviderError('Enter the client ID and secret.', null, 'missing_credentials');
  await factory(ctx).linkTokenCreate({ userId: 'connection-test', clientName: 'Alto' });
}

export async function withPlaidHealth<T>(row: ProviderConnection, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    await recordSuccess(row.id);
    return r;
  } catch (err) {
    await recordFailure(row.id, err instanceof Error ? err.message : 'Plaid failed.');
    throw err;
  }
}
