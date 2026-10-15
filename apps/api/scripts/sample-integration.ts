/**
 * Brief 2-4 step 6 — a sample integration against the public API, written
 * the way a customer would: plain fetch, no Alto code imported, so it can be
 * copied out of the repo as is. CI runs it against a test server
 * (src/__tests__/routes/publicApiSample.test.ts), so it cannot rot.
 *
 *   ALTO_BASE_URL=https://people.altohr.com/api \
 *   ALTO_CLIENT_ID=altc_… ALTO_CLIENT_SECRET=… \
 *   npx tsx scripts/sample-integration.ts [--write]
 *
 * Read-only by default: token, sites, workers and this fortnight's shifts.
 * With --write (a client holding schedules:write and webhooks:manage) it
 * also creates a draft shift, assigns the first active person, cancels the
 * shift, and subscribes then removes a webhook, every POST with its own
 * Idempotency-Key.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface SampleOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  write?: boolean;
  /** For the webhook step: an https URL that would receive deliveries. */
  webhookUrl?: string;
  log?: (line: string) => void;
}

export interface SampleResult {
  sites: number;
  workers: number;
  shifts: number;
  created?: { shiftId: string; assignedWorkerId: string | null; cancelled: boolean; webhookId: string };
}

interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

class AltoClient {
  private token: { value: string; until: number } | null = null;
  constructor(private readonly o: SampleOptions) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 30_000) return this.token.value;
    const res = await fetch(`${this.o.baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(this.o.clientSecret)}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, until: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
      const res = await fetch(`${this.o.baseUrl}/v1${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      // 401: the token expired between the check and the call; 429: back off as told.
      if (res.status === 401 && attempt === 1) {
        this.token = null;
        continue;
      }
      if (res.status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? '1') * 1000));
        continue;
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
      return JSON.parse(text) as T;
    }
  }

  /** Every page of a list, following nextCursor. */
  async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const p: Page<T> = await this.call('GET', `${path}${sep}limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      out.push(...p.data);
      cursor = p.nextCursor;
    } while (cursor);
    return out;
  }
}

/** How a receiver checks a delivery: the HMAC of "t.body" and a timestamp within five minutes. */
export function verifyAltoSignature(secret: string, rawBody: string, header: string, now = Date.now(), toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSeconds || !parts.v1) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

export async function runSampleIntegration(o: SampleOptions): Promise<SampleResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const alto = new AltoClient(o);

  const sites = await alto.all<{ id: string; name: string; active: boolean }>('/sites');
  log(`${sites.length} site(s)`);
  const workers = await alto.all<{ id: string; type: string; status: string; name: string }>('/workers?type=PERSON');
  log(`${workers.length} person(s)`);
  const from = new Date();
  const to = new Date(from.getTime() + 14 * 86_400_000);
  const shifts = await alto.all<{ id: string }>(`/shifts?from=${from.toISOString()}&to=${to.toISOString()}`);
  log(`${shifts.length} shift(s) in the next 14 days`);

  const result: SampleResult = { sites: sites.length, workers: workers.length, shifts: shifts.length };
  if (!o.write) return result;

  const site = sites.find((s) => s.active);
  if (!site) throw new Error('No active site to create a shift at.');
  const start = new Date(Date.now() + 21 * 86_400_000);
  start.setUTCHours(14, 0, 0, 0);
  const shift = await alto.call<{ id: string; status: string }>('POST', '/shifts', {
    siteId: site.id,
    position: 'Sample integration',
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 8 * 3_600_000).toISOString(),
  });
  log(`created draft shift ${shift.id}`);

  const person = workers.find((w) => w.status === 'ACTIVE' || w.status === 'ONBOARDING');
  let assignedWorkerId: string | null = null;
  if (person) {
    const assigned = await alto.call<{ assignedWorkerId: string | null }>('POST', `/shifts/${shift.id}/assign`, { workerId: person.id });
    assignedWorkerId = assigned.assignedWorkerId;
    log(`assigned ${person.name}`);
  }
  const cancelled = await alto.call<{ status: string }>('POST', `/shifts/${shift.id}/cancel`, { reason: 'Sample integration run' });
  log(`cancelled: ${cancelled.status}`);

  const hook = await alto.call<{ id: string; secret: string }>('POST', '/webhooks', { name: 'Sample integration', url: o.webhookUrl ?? 'https://example.com/alto-webhooks', events: ['shift.created', 'shift.changed'] });
  log(`webhook ${hook.id} subscribed (secret shown once; store it to verify Alto-Signature)`);
  await alto.call('DELETE', `/webhooks/${hook.id}`);
  log('webhook removed');

  result.created = { shiftId: shift.id, assignedWorkerId, cancelled: cancelled.status === 'CANCELLED', webhookId: hook.id };
  return result;
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/sample-integration.ts');
if (invokedDirectly) {
  const { ALTO_BASE_URL, ALTO_CLIENT_ID, ALTO_CLIENT_SECRET } = process.env;
  if (!ALTO_BASE_URL || !ALTO_CLIENT_ID || !ALTO_CLIENT_SECRET) {
    console.error('Set ALTO_BASE_URL, ALTO_CLIENT_ID and ALTO_CLIENT_SECRET.');
    process.exit(2);
  }
  runSampleIntegration({ baseUrl: ALTO_BASE_URL.replace(/\/$/, ''), clientId: ALTO_CLIENT_ID, clientSecret: ALTO_CLIENT_SECRET, write: process.argv.includes('--write') })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
