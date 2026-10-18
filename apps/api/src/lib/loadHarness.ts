/**
 * Brief 3-6 — the load-test harness's pure parts: the scenarios (the top
 * routes a 50,000-worker, 1,000-site tenant hits hardest), the percentile
 * math over the raw latencies, and the Markdown report with its pass/fail
 * against the budget. scripts/load/run.ts drives real traffic with these;
 * the unit test proves the definitions parse and a report renders from a
 * fixture without a database.
 */

export type ScenarioAuth = 'admin' | 'associate' | 'none';

export interface Scenario {
  /** Stable key for the report and the JSON output. */
  key: string;
  title: string;
  method: 'GET' | 'POST';
  /** Path under /api, or a function of the request number (rotating ids). */
  path: string | ((n: number) => string);
  auth: ScenarioAuth;
  /** JSON body, or a function of the request number. */
  body?: unknown | ((n: number, worker: number) => unknown);
  /** Concurrent connections. */
  connections: number;
  durationSeconds: number;
  /** p95 budget in milliseconds. */
  budgetMs: number;
  /** HTTP statuses that count as success (a second clock-in is a 409, by design). */
  okStatuses?: number[];
  /** Minimum milliseconds between two requests on one connection (the kiosk allows one punch a second per device). */
  paceMs?: number;
  /** What this scenario stands for in the brief's list. */
  why: string;
}

export const P95_BUDGET_MS = 2_000;

/**
 * The kiosks the scale seed registers for the clock-in burst: one per site
 * for the first LOAD_KIOSKS sites, each with one associate's PIN. Tokens
 * and PINs are deterministic so the harness needs no secret from the seed;
 * the token's first sixteen characters (the lookup prefix) differ per kiosk.
 */
export const LOAD_KIOSKS = 20;
export const LOAD_DEVICE_TOKEN = (i: number): string => `altokiosk_k${i.toString().padStart(5, '0')}${'0'.repeat(50)}`;
export const LOAD_PIN = (i: number): string => String(1000 + (i % 9000));

/** The brief's top ten, plus the two control-room polls it names. */
export const SCENARIOS: readonly Scenario[] = [
  { key: 'login', title: 'Sign in', method: 'POST', path: '/auth/login', auth: 'none', connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, okStatuses: [200, 202], why: 'Every session starts here; argon2 hashing is CPU-bound.' },
  { key: 'auth-me', title: 'Session (/auth/me)', method: 'GET', path: '/auth/me', auth: 'admin', connections: 25, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'Read on every page load by every role.' },
  { key: 'home-decisions', title: 'Home decision queue', method: 'GET', path: '/me/decisions', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'The admin and supervisor homes open on it; it fans out across queues.' },
  { key: 'schedule-week', title: 'Schedule, one week', method: 'GET', path: '/scheduling/shifts', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'The scheduling page and the week view; the largest read.' },
  {
    key: 'clock-in',
    title: 'Clock in at the kiosk, shift change',
    method: 'POST',
    path: '/kiosk/punch',
    auth: 'none',
    // Each connection is one kiosk punching one associate, a second apart
    // (the device throttle); the second punch of a pair is a clock-out.
    body: (_n: number, worker: number) => ({ deviceToken: LOAD_DEVICE_TOKEN(worker % LOAD_KIOSKS), pin: LOAD_PIN(worker % LOAD_KIOSKS) }),
    connections: LOAD_KIOSKS,
    durationSeconds: 10,
    paceMs: 1100,
    budgetMs: P95_BUDGET_MS,
    okStatuses: [200, 201, 409],
    why: 'Clock-ins at shift change: the punch an associate feels, through the kiosk they use.',
  },
  { key: 'time-live', title: 'Time & attendance, live', method: 'GET', path: '/time/admin/active', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'Who is on the clock now, polled by the admin page.' },
  { key: 'messages-list', title: 'Messages, conversations', method: 'GET', path: '/messages/conversations', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'Opened from every home; unread counts ride on it.' },
  { key: 'messages-send', title: 'Messages, send burst', method: 'POST', path: '/messages/conversations/{conversation}/messages', auth: 'admin', body: (n: number) => ({ body: `Load test message ${n}` }), connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, okStatuses: [200, 201], why: 'A store channel at shift change.' },
  { key: 'approvals', title: 'Approvals, walk-in queue', method: 'GET', path: '/time/admin/clock-in-requests?status=PENDING', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'The desk the kiosk feeds.' },
  { key: 'people-directory', title: 'People directory', method: 'GET', path: '/people/directory', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'The 50,000-row list behind the People page.' },
  { key: 'control-room-workers', title: 'Control room poll: one site', method: 'GET', path: '/control-room?locationId={site}', auth: 'admin', connections: 20, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'The roster the control room refreshes.' },
  { key: 'control-room-status', title: 'Control room poll: status', method: 'GET', path: '/status/public', auth: 'none', connections: 20, durationSeconds: 10, budgetMs: P95_BUDGET_MS, why: 'The public status page, cached 60 s; the cheap end of the poll.' },
  { key: 'inbox', title: 'Inbox', method: 'GET', path: '/me/inbox', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: 800, why: 'Every row badge in the sidebar; it counts every desk queue at once (Server-Timing names the slow one).' },
  { key: 'org-chart-field', title: 'Org chart, field', method: 'GET', path: '/org/chart?view=field', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: 1000, why: 'Region → client → store with today’s coverage; at this size crew loads per store.' },
  { key: 'org-chart-crew', title: 'Org chart, one store’s crew', method: 'GET', path: '/org/chart/crew?siteId={site}', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: 400, why: 'Opening a store on the field chart.' },
  { key: 'org-chart-company', title: 'Org chart, company', method: 'GET', path: '/org/chart?view=company', auth: 'admin', connections: 10, durationSeconds: 10, budgetMs: 1500, why: 'The office and every reporting line.' },
  {
    key: 'payroll-preview',
    title: 'Payroll preview, two weeks',
    method: 'POST',
    path: '/payroll/runs/preview',
    auth: 'admin',
    body: () => {
      const end = new Date();
      const start = new Date(end.getTime() - 14 * 86_400_000);
      return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10), defaultHourlyRate: 15 };
    },
    // One payroll admin at a time; it's the heaviest read in the product.
    connections: 1,
    durationSeconds: 30,
    budgetMs: 20_000,
    why: 'Every worker’s pay, taxes and deductions; failed outright past 32,767 people before the bind-limit fix.',
  },
];

export interface ScenarioResult {
  key: string;
  title: string;
  requests: number;
  failed: number;
  durationSeconds: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  budgetMs: number;
  /** p95 within budget AND fewer than 1% failures. */
  pass: boolean;
  statuses: Record<string, number>;
}

/** Nearest-rank percentile over raw latencies (ms). Empty → 0. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(
  scenario: Pick<Scenario, 'key' | 'title' | 'budgetMs'>,
  latencies: number[],
  statuses: Record<string, number>,
  failed: number,
  durationSeconds: number,
): ScenarioResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  const requests = sorted.length;
  const p95 = percentile(sorted, 95);
  const failRate = requests === 0 ? 1 : failed / requests;
  return {
    key: scenario.key,
    title: scenario.title,
    requests,
    failed,
    durationSeconds,
    rps: durationSeconds > 0 ? Math.round((requests / durationSeconds) * 10) / 10 : 0,
    p50: percentile(sorted, 50),
    p95,
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    budgetMs: scenario.budgetMs,
    pass: requests > 0 && p95 <= scenario.budgetMs && failRate < 0.01,
    statuses,
  };
}

export interface LoadReportInput {
  results: ScenarioResult[];
  scale: { workers: number; sites: number };
  startedAt: string;
  node: string;
  commit?: string;
}

/** The Markdown report; one table, one verdict. */
export function renderReport(input: LoadReportInput): { markdown: string; pass: boolean } {
  const pass = input.results.every((r) => r.pass);
  const lines: string[] = [];
  lines.push('# Load test');
  lines.push('');
  lines.push(`${input.scale.workers.toLocaleString('en-US')} workers across ${input.scale.sites.toLocaleString('en-US')} sites · started ${input.startedAt} · Node ${input.node}${input.commit ? ` · ${input.commit.slice(0, 8)}` : ''}`);
  lines.push('');
  lines.push(`Budget: p95 ≤ ${P95_BUDGET_MS} ms and under 1% failures on every route. **${pass ? 'PASS' : 'FAIL'}**.`);
  lines.push('');
  lines.push('| Route | Requests | RPS | p50 ms | p95 ms | p99 ms | Max ms | Failed | Result |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const r of input.results) {
    lines.push(`| ${r.title} | ${r.requests} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.failed} | ${r.pass ? 'pass' : 'FAIL'} |`);
  }
  lines.push('');
  const failing = input.results.filter((r) => !r.pass);
  if (failing.length) {
    lines.push('## Over budget');
    lines.push('');
    for (const r of failing) {
      const status = Object.entries(r.statuses).map(([k, v]) => `${k}×${v}`).join(', ');
      lines.push(`- ${r.title}: p95 ${r.p95} ms (budget ${r.budgetMs}), ${r.failed} failed of ${r.requests}; statuses ${status}`);
    }
    lines.push('');
  }
  return { markdown: lines.join('\n'), pass };
}
