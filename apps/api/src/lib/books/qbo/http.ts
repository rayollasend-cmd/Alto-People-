import { env } from '../../../config/env.js';
import { QboError, type QboChange, type QboClient, type QboCompanyInfo, type QboEntity, type QboType } from './types.js';

/**
 * QuickBooks Online v3 over HTTP. Every call carries a minorversion; a 429
 * or a 5xx is retried with backoff (a few seconds, then gives up and lets the
 * outbox try again later); QuickBooks' error envelope ("Fault") becomes a
 * QboError with its code and detail.
 */

const MINOR_VERSION = 75;
const BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const;

const resourceOf = (t: QboType) => t.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpQboClient implements QboClient {
  constructor(
    readonly realmId: string,
    private readonly token: () => Promise<string>,
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const sp = new URLSearchParams({ ...params, minorversion: String(MINOR_VERSION) });
    return `${BASE[env.INTUIT_ENV]}/v3/company/${this.realmId}/${path}?${sp.toString()}`;
  }

  private async call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      const text = await res.text();
      const err = parseFault(res.status, text);
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }

  async companyInfo(): Promise<QboCompanyInfo> {
    const [info, prefs] = await Promise.all([
      this.call('GET', this.url(`companyinfo/${this.realmId}`)),
      this.call('GET', this.url('preferences')),
    ]);
    const ci = info.CompanyInfo as { CompanyName?: string } | undefined;
    const p = prefs.Preferences as { AccountingInfoPrefs?: { BookCloseDate?: string } } | undefined;
    return { companyName: ci?.CompanyName ?? 'QuickBooks company', bookCloseDate: p?.AccountingInfoPrefs?.BookCloseDate?.slice(0, 10) ?? null };
  }

  async query(type: QboType, where?: string): Promise<QboEntity[]> {
    const out: QboEntity[] = [];
    for (let start = 1; ; start += 1000) {
      const q = `SELECT * FROM ${type}${where ? ` WHERE ${where}` : ''} STARTPOSITION ${start} MAXRESULTS 1000`;
      const r = await this.call('GET', this.url('query', { query: q }));
      const page = ((r.QueryResponse as Record<string, unknown> | undefined)?.[type] as QboEntity[] | undefined) ?? [];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  async get(type: QboType, id: string): Promise<QboEntity | null> {
    try {
      const r = await this.call('GET', this.url(`${resourceOf(type)}/${encodeURIComponent(id)}`));
      return (r[type] as QboEntity) ?? null;
    } catch (err) {
      if (err instanceof QboError && (err.status === 404 || err.code === '610')) return null;
      throw err;
    }
  }

  async create(type: QboType, body: Record<string, unknown>): Promise<QboEntity> {
    const r = await this.call('POST', this.url(resourceOf(type)), body);
    return r[type] as QboEntity;
  }

  async update(type: QboType, body: Record<string, unknown>): Promise<QboEntity> {
    const r = await this.call('POST', this.url(resourceOf(type)), body);
    return r[type] as QboEntity;
  }

  async remove(type: QboType, id: string, syncToken: string): Promise<void> {
    await this.call('POST', this.url(resourceOf(type), { operation: 'delete' }), { Id: id, SyncToken: syncToken });
  }

  async voidTxn(type: QboType, id: string, syncToken: string): Promise<QboEntity> {
    const r = await this.call('POST', this.url(resourceOf(type), { operation: 'void' }), { Id: id, SyncToken: syncToken, sparse: true });
    return r[type] as QboEntity;
  }

  async cdc(types: QboType[], changedSince: Date): Promise<QboChange[]> {
    const r = await this.call('GET', this.url('cdc', { entities: types.join(','), changedSince: changedSince.toISOString() }));
    const out: QboChange[] = [];
    const responses = (r.CDCResponse as Array<{ QueryResponse?: Array<Record<string, unknown>> }> | undefined) ?? [];
    for (const resp of responses) {
      for (const qr of resp.QueryResponse ?? []) {
        for (const t of types) {
          for (const e of (qr[t] as QboEntity[] | undefined) ?? []) {
            const deleted = (e as { status?: string }).status === 'Deleted';
            out.push({ type: t, id: e.Id, deleted, entity: deleted ? null : e, lastUpdated: e.MetaData?.LastUpdatedTime ?? null });
          }
        }
      }
    }
    return out;
  }
}

/** QuickBooks' error envelope → QboError. */
export function parseFault(status: number, text: string): QboError {
  try {
    const j = JSON.parse(text) as { Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }> }; fault?: { error?: Array<{ message?: string; detail?: string; code?: string }> } };
    const e = j.Fault?.Error?.[0];
    if (e) return new QboError(e.Message ?? `QuickBooks answered ${status}`, status, e.code ?? null, e.Detail ?? null);
    const f = j.fault?.error?.[0];
    if (f) return new QboError(f.message ?? `QuickBooks answered ${status}`, status, f.code ?? null, f.detail ?? null);
  } catch {
    /* not JSON */
  }
  return new QboError(`QuickBooks answered ${status}${text ? `: ${text.slice(0, 300)}` : ''}`, status);
}
