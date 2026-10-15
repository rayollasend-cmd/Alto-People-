/**
 * Brief 3-6 — the load test. Drives the scenarios in lib/loadHarness.ts
 * against a running API (API_URL, default http://127.0.0.1:3001) seeded by
 * scripts/load/seed-scale.ts, records every latency, and writes
 * load-report.md + load-results.json. Exit 1 when any route misses its
 * p95 budget or fails more than 1% of its requests.
 *
 *   LOAD_SCALE=1 npx tsx scripts/load/seed-scale.ts   # once, on a scratch database
 *   npx tsx scripts/load/run.ts                        # against the running API
 *
 * The runner is a plain fetch loop with N concurrent workers per scenario:
 * exact percentiles over the raw latencies, no extra dependency, and the
 * same code on a laptop and in Actions. Logins rotate across 2,000 scale
 * accounts (five attempts per email per 15 minutes is the API's rule) and
 * clock-ins across 200 signed-in associates.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { SCENARIOS, renderReport, summarize, type Scenario, type ScenarioResult } from '../../src/lib/loadHarness.js';
import { SCALE_ASSOCIATE_PASSWORD, SCALE_EMAIL, SCALE_SITES, SCALE_USERS, SCALE_WORKERS } from './scale.js';

const API = (process.env.API_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.LOAD_ADMIN_EMAIL ?? 'admin@altohr.com';
const ADMIN_PASSWORD = process.env.LOAD_ADMIN_PASSWORD ?? 'alto-admin-dev';
const ASSOCIATE_SESSIONS = Number(process.env.LOAD_ASSOCIATE_SESSIONS ?? 200);
const ONLY = process.env.LOAD_ONLY ? new Set(process.env.LOAD_ONLY.split(',')) : null;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  const cookie = res.headers.getSetCookie?.() ?? [];
  const session = cookie.map((c) => c.split(';')[0]!).filter((c) => c.includes('alto.session')).join('; ');
  if (!session) throw new Error(`login ${email}: no session cookie in the response`);
  return session;
}

async function jsonWith(cookie: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Context {
  adminCookie: string;
  associateCookies: string[];
  conversationId: string;
  /** The site the control room polls: the first one the admin may see. */
  siteId: string;
}

async function prepare(): Promise<Context> {
  console.log(`[load] signing in as ${ADMIN_EMAIL} and ${ASSOCIATE_SESSIONS} scale associates`);
  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const associateCookies: string[] = [];
  for (let i = 0; i < ASSOCIATE_SESSIONS; i++) {
    associateCookies.push(await login(SCALE_EMAIL(i), SCALE_ASSOCIATE_PASSWORD));
  }
  // The message burst needs a conversation. An associate is never in the
  // messenger (lib/messaging.ts), so the admin writes to the first person the
  // directory says they may message: a supervisor or a desk.
  const dir = await jsonWith(adminCookie, 'GET', '/messages/directory');
  const people = ((dir.json as { people?: Array<{ id?: string }> } | null)?.people ?? []).filter((x) => x && x.id);
  const userId = people[0]?.id;
  if (!userId) throw new Error(`the admin has nobody to message: ${dir.status} ${JSON.stringify(dir.json).slice(0, 200)}`);
  const conv = await jsonWith(adminCookie, 'POST', '/messages/conversations', { participantIds: [userId], body: 'Load test opens the channel.' });
  const conversationId = (conv.json as { conversation?: { id?: string }; id?: string } | null)?.conversation?.id ?? (conv.json as { id?: string } | null)?.id;
  if (!conversationId) throw new Error(`could not start a conversation: ${conv.status} ${JSON.stringify(conv.json).slice(0, 200)}`);
  const sitesRes = await jsonWith(adminCookie, 'GET', '/control-room/sites');
  const siteId = ((sitesRes.json as { sites?: Array<{ id?: string }> } | null)?.sites ?? [])[0]?.id;
  if (!siteId) throw new Error(`the control room lists no site: ${sitesRes.status} ${JSON.stringify(sitesRes.json).slice(0, 200)}`);
  return { adminCookie, associateCookies, conversationId, siteId };
}

function resolvePath(s: Scenario, n: number, ctx: Context): string {
  let p = typeof s.path === 'function' ? s.path(n) : s.path;
  if (s.key === 'schedule-week') {
    const from = new Date();
    const to = new Date(from.getTime() + 6 * 86_400_000);
    p = `${p}?from=${ymd(from)}&to=${ymd(to)}`;
  }
  return p.replace('{conversation}', ctx.conversationId).replace('{site}', ctx.siteId);
}

function resolveBody(s: Scenario, n: number, worker: number): unknown {
  if (s.key === 'login') return { email: SCALE_EMAIL(n % SCALE_USERS), password: SCALE_ASSOCIATE_PASSWORD };
  return typeof s.body === 'function' ? (s.body as (n: number, worker: number) => unknown)(n, worker) : s.body;
}

async function runScenario(s: Scenario, ctx: Context): Promise<ScenarioResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let failed = 0;
  let n = 0;
  const ok = new Set(s.okStatuses ?? [200, 201, 204]);
  const deadline = performance.now() + s.durationSeconds * 1000;
  const worker = async (w: number) => {
    while (performance.now() < deadline) {
      const i = n++;
      const cookie = s.auth === 'admin' ? ctx.adminCookie : s.auth === 'associate' ? ctx.associateCookies[i % ctx.associateCookies.length]! : '';
      const body = s.method === 'POST' ? resolveBody(s, i, w) : undefined;
      const t0 = performance.now();
      let status = 0;
      try {
        const res = await fetch(`${API}${resolvePath(s, i, ctx)}`, {
          method: s.method,
          headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        status = res.status;
        await res.arrayBuffer();
      } catch {
        status = 0;
      }
      const ms = Math.round(performance.now() - t0);
      latencies.push(ms);
      const pace = s.paceMs ?? 0;
      if (pace > ms) await new Promise((resolve) => setTimeout(resolve, pace - ms));
      statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
      if (!ok.has(status)) failed++;
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: s.connections }, (_, w) => worker(w)));
  const seconds = (performance.now() - t0) / 1000;
  const result = summarize(s, latencies, statuses, failed, seconds);
  console.log(`[load] ${s.title}: ${result.requests} req, ${result.rps} rps, p50 ${result.p50} ms, p95 ${result.p95} ms, p99 ${result.p99} ms, failed ${result.failed} → ${result.pass ? 'pass' : 'FAIL'}`);
  return result;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const ctx = await prepare();
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    if (ONLY && !ONLY.has(s.key)) continue;
    results.push(await runScenario(s, ctx));
  }
  let commit: string | undefined;
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    commit = undefined;
  }
  const report = renderReport({ results, scale: { workers: SCALE_WORKERS, sites: SCALE_SITES }, startedAt, node: process.version, commit });
  writeFileSync('load-report.md', report.markdown);
  writeFileSync('load-results.json', JSON.stringify({ startedAt, results }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.markdown}\n`);
  console.log(report.markdown);
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[load] failed:', err);
  process.exit(1);
});
