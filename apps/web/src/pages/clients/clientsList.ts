import type { ClientListItem, ClientStatus } from '@alto-people/shared';
import { fmtMoney } from '@/lib/format';

/**
 * The clients list's rules, kept apart from the page so they are tested on
 * their own: the built-in views, the filters behind them, how a view is
 * written into the URL and into a saved view, the sort, the billed range,
 * and the phone row's one line of numbers.
 */

export type StatusFilter = ClientStatus | 'ALL';
export type Health = 'good' | 'watch' | 'risk';

export interface ClientsFilters {
  status: StatusFilter;
  /** Health is watch or risk. */
  attention: boolean;
  /** The signed-in person owns the account. */
  mine: boolean;
  /** The contract ended in the last 30 days or ends in the next 60. */
  ending: boolean;
}

export const NO_FILTERS: ClientsFilters = { status: 'ALL', attention: false, mine: false, ending: false };

export type BuiltInViewKey = 'all' | 'attention' | 'mine' | 'ending' | 'inactive';

export const BUILT_IN_VIEWS: ReadonlyArray<{ key: BuiltInViewKey; label: string; filters: ClientsFilters; hint: string }> = [
  { key: 'all', label: 'All', filters: NO_FILTERS, hint: 'Every account' },
  { key: 'attention', label: 'Needs attention', filters: { ...NO_FILTERS, attention: true }, hint: 'Accounts at risk or to watch' },
  { key: 'mine', label: 'Mine', filters: { ...NO_FILTERS, mine: true }, hint: 'Accounts you own' },
  { key: 'ending', label: 'Contract ending', filters: { ...NO_FILTERS, ending: true }, hint: 'Contracts that end in the next 60 days or ended in the last 30' },
  { key: 'inactive', label: 'Inactive', filters: { ...NO_FILTERS, status: 'INACTIVE' }, hint: 'Accounts no longer active' },
];

const sameFilters = (a: ClientsFilters, b: ClientsFilters) => a.status === b.status && a.attention === b.attention && a.mine === b.mine && a.ending === b.ending;

/** The built-in view the filters are exactly, or null (a combination of its own). */
export function builtInViewOf(f: ClientsFilters): BuiltInViewKey | null {
  return BUILT_IN_VIEWS.find((v) => sameFilters(v.filters, f))?.key ?? null;
}

/** Whole days from today to a calendar date (negative once it has passed). */
export function daysUntil(ymd: string | null | undefined, today: string): number | null {
  if (!ymd) return null;
  return Math.round((Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export const CONTRACT_ENDING_DAYS = 60;
const CONTRACT_ENDED_SHOWN_DAYS = 30;

export function contractEnding(c: Pick<ClientListItem, 'contractEndDate'>, today: string): boolean {
  const d = daysUntil(c.contractEndDate, today);
  return d !== null && d <= CONTRACT_ENDING_DAYS && d >= -CONTRACT_ENDED_SHOWN_DAYS;
}

export function needsAttention(c: Pick<ClientListItem, 'health'>): boolean {
  return c.health === 'watch' || c.health === 'risk';
}

export function matches(c: ClientListItem, f: ClientsFilters, ctx: { me: string | null; today: string }): boolean {
  if (f.status !== 'ALL' && c.status !== f.status) return false;
  if (f.attention && !needsAttention(c)) return false;
  if (f.mine && (!ctx.me || c.accountOwner?.id !== ctx.me)) return false;
  if (f.ending && !contractEnding(c, ctx.today)) return false;
  return true;
}

/** How many rows each built-in view holds, for the counts beside their names. */
export function viewCounts(rows: ClientListItem[], ctx: { me: string | null; today: string }): Record<BuiltInViewKey, number> {
  const out = { all: 0, attention: 0, mine: 0, ending: 0, inactive: 0 } as Record<BuiltInViewKey, number>;
  for (const v of BUILT_IN_VIEWS) out[v.key] = rows.filter((r) => matches(r, v.filters, ctx)).length;
  return out;
}

/* ----- Sort ------------------------------------------------------------------ */

export type SortDir = 'asc' | 'desc';
export interface ClientsSort {
  key: string | null;
  direction: SortDir;
}
export const DEFAULT_SORT: ClientsSort = { key: 'name', direction: 'asc' };

const HEALTH_RANK: Record<Health, number> = { risk: 0, watch: 1, good: 2 };

/** What each sortable column orders by; null sinks to the bottom either way. */
export const SORT_VALUE: Record<string, (c: ClientListItem) => string | number | null> = {
  name: (c) => c.name,
  health: (c) => (c.health ? HEALTH_RANK[c.health] : null),
  owner: (c) => c.accountOwner?.name ?? null,
  onAssignment: (c) => c.onAssignment ?? c.activeAssociateCount,
  fillRate: (c) => c.fillRatePct ?? null,
  hours: (c) => c.hoursThisWeek ?? null,
  billed: (c) => c.billedInRange ?? null,
  outstanding: (c) => c.outstanding ?? null,
  contractEnds: (c) => c.contractEndDate ?? null,
  lastPayroll: (c) => (c.lastPayrollDisbursedAt ? Date.parse(c.lastPayrollDisbursedAt) : null),
  status: (c) => c.status,
  industry: (c) => c.industry,
  state: (c) => c.state,
  openApplications: (c) => c.openApplications,
};

export function sortClients(rows: ClientListItem[], sort: ClientsSort): ClientListItem[] {
  const value = sort.key ? SORT_VALUE[sort.key] : undefined;
  if (!value) return rows;
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
    return c !== 0 ? c * dir : a.name.localeCompare(b.name);
  });
}

/** A header click: ascending, then descending, then back to the default order. */
export function nextSort(prev: ClientsSort, key: string): ClientsSort {
  if (prev.key !== key) return { key, direction: 'asc' };
  if (prev.direction === 'asc') return { key, direction: 'desc' };
  return DEFAULT_SORT;
}

/* ----- The billed range -------------------------------------------------------- */

export type BilledRangeKey = 'month' | 'lastMonth' | 'quarter' | 'ytd';
export const BILLED_RANGES: ReadonlyArray<{ key: BilledRangeKey; label: string }> = [
  { key: 'month', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'ytd', label: 'Year to date' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The range's first and last day (YYYY-MM-DD, inclusive) and its short name for a column header. */
export function billedRange(key: BilledRangeKey, today: string): { from: string; to: string; short: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const month0 = m - 1;
  if (key === 'lastMonth') {
    const py = month0 === 0 ? y - 1 : y;
    const pm = month0 === 0 ? 11 : month0 - 1;
    return { from: `${py}-${pad(pm + 1)}-01`, to: `${py}-${pad(pm + 1)}-${pad(lastDay(py, pm))}`, short: MONTHS[pm]! };
  }
  if (key === 'quarter') {
    const q0 = Math.floor(month0 / 3) * 3;
    return { from: `${y}-${pad(q0 + 1)}-01`, to: today, short: `Q${q0 / 3 + 1}` };
  }
  if (key === 'ytd') return { from: `${y}-01-01`, to: today, short: String(y) };
  return { from: `${y}-${pad(m)}-01`, to: today, short: MONTHS[month0]! };
}

export const isBilledRangeKey = (v: unknown): v is BilledRangeKey => BILLED_RANGES.some((r) => r.key === v);

/* ----- URL and saved views ------------------------------------------------------ */

export interface ListState {
  filters: ClientsFilters;
  q: string;
  sort: ClientsSort;
  range: BilledRangeKey;
  /** Columns the person turned off. */
  hidden: string[];
}

const STATUSES: StatusFilter[] = ['ALL', 'ACTIVE', 'INACTIVE', 'PROSPECT'];

/**
 * The list as URL params — the same shape a saved view keeps. Defaults are
 * left out, so "All" is a bare /clients and a view holds only what it sets.
 * `cols` is written only when asked (a saved view keeps the layout; the
 * address bar does not need it).
 */
export function toQuery(s: ListState, opts: { cols?: boolean; defaultHidden?: string[] } = {}): Record<string, string> {
  const q: Record<string, string> = {};
  if (s.filters.status !== 'ALL') q.status = s.filters.status;
  if (s.filters.attention) q.attention = '1';
  if (s.filters.mine) q.mine = '1';
  if (s.filters.ending) q.ending = '1';
  if (s.q.trim()) q.q = s.q.trim();
  if (s.sort.key && (s.sort.key !== DEFAULT_SORT.key || s.sort.direction !== DEFAULT_SORT.direction)) {
    q.sort = s.sort.key;
    q.dir = s.sort.direction;
  }
  if (s.range !== 'month') q.range = s.range;
  if (opts.cols) {
    const hidden = [...s.hidden].sort().join(',');
    const def = [...(opts.defaultHidden ?? [])].sort().join(',');
    if (hidden !== def) q.cols = hidden || '-';
  }
  return q;
}

export function fromQuery(q: Record<string, string | undefined>, defaults: { hidden: string[] }): ListState {
  const status = STATUSES.includes(q.status as StatusFilter) ? (q.status as StatusFilter) : 'ALL';
  const key = q.sort && SORT_VALUE[q.sort] ? q.sort : null;
  return {
    filters: { status, attention: q.attention === '1', mine: q.mine === '1', ending: q.ending === '1' },
    q: q.q ?? '',
    sort: key ? { key, direction: q.dir === 'desc' ? 'desc' : 'asc' } : DEFAULT_SORT,
    range: isBilledRangeKey(q.range) ? q.range : 'month',
    hidden: q.cols === undefined ? defaults.hidden : q.cols === '-' ? [] : q.cols.split(',').filter(Boolean),
  };
}

/* ----- Words and numbers ---------------------------------------------------- */

export const HEALTH_LABEL: Record<Health, string> = { good: 'Good', watch: 'Watch', risk: 'At risk' };

const pct = (v: number) => `${Math.round(v)}%`;

/** The phone row's one line: "12 on assignment · 94% filled · $5,760.00 due". Only what is known; money only when present, in full. */
export function numbersLine(c: ClientListItem): string {
  const parts: string[] = [`${c.onAssignment ?? c.activeAssociateCount} on assignment`];
  if (c.fillRatePct !== null && c.fillRatePct !== undefined) parts.push(`${pct(c.fillRatePct)} filled`);
  else if (c.hoursThisWeek) parts.push(`${(Math.round(c.hoursThisWeek * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h this week`);
  if (c.outstanding !== undefined && c.outstanding > 0) parts.push(`${fmtMoney(c.outstanding)} due`);
  return parts.join(' · ');
}
