import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultTenantProfile, ROLE_CAPABILITIES, type Capability, type ExecClients, type ExecFinancials, type ExecKpi, type ExecOverview, type ExecPeople, type ExecRisks } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import type { ExecTargetsResponse } from '@/lib/executiveApi';
import type { ExecDecision } from '@/pages/executive/home/DecisionQueueCard';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
// Hugo and the release note have their own tests; the home's order and words are under test here.
vi.mock('@/components/home/HugoSeat', () => ({ HugoSeat: () => null }));
vi.mock('@/components/WhatsNew', () => ({ WhatsNew: () => null }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

import { apiFetch } from '@/lib/api';
import { ExecutiveDashboard } from '@/pages/ExecutiveDashboard';

/**
 * The chairman's home (2026-10-27): the scorecard of eight measures against
 * the comparison and the plan, the one-line "no plan" prompt, the plan
 * drawer, the decisions (top three, then all), and the four previews below
 * the fold — each in its data and its empty state.
 */

const trend = (vals: number[]) => vals.map((value, i) => ({ start: `2026-08-${String(i + 1).padStart(2, '0')}`, value }));

function kpi(over: Partial<ExecKpi> & Pick<ExecKpi, 'id' | 'label' | 'unit'>): ExecKpi {
  return {
    value: null,
    sub: null,
    compare: null,
    delta: null,
    deltaPct: null,
    betterWhen: 'up',
    target: null,
    targetLabel: null,
    status: 'none',
    statusLabel: 'No plan set',
    trend: trend([1, 2, 3, 4]),
    basis: 'estimate',
    definition: 'How it is counted.',
    href: '/executive/financials',
    ...over,
  };
}

function overview(over: Partial<ExecOverview> = {}): ExecOverview {
  return {
    period: { key: 'quarter', label: 'Q4 to date', start: '2026-10-01', end: '2026-10-27', complete: false, elapsedPct: 29, asOf: '2026-10-27T12:44:00.000Z' },
    comparison: { key: 'prior', label: 'vs Q3, same days', start: '2026-07-01', end: '2026-07-27', available: true, reason: null },
    scorecard: [
      kpi({ id: 'revenue', label: 'Revenue', unit: 'money', value: 82190.5, sub: '3,870 paid hours', compare: 58878.5, delta: 23312, deltaPct: 0.396, status: 'watch', statusLabel: 'Just short of plan', target: 86300, href: '/executive/financials' }),
      kpi({ id: 'marginPct', label: 'Gross margin', unit: 'pct', value: 20.83, sub: '$17.1k margin', compare: 20.83, delta: 0, deltaPct: 0 }),
      kpi({ id: 'workforce', label: 'Active workforce', unit: 'count', value: 36, sub: 'of 44 on the books', delta: -1, deltaPct: -0.027, basis: 'live', href: '/executive/people' }),
      kpi({ id: 'fillRate', label: 'Fill rate', unit: 'pct', value: 99.1, delta: 2.3, status: 'good', statusLabel: 'Healthy', basis: 'live' }),
      kpi({ id: 'turnover', label: 'Turnover', unit: 'pct', value: 0, betterWhen: 'down', basis: 'live' }),
      kpi({ id: 'overtimePct', label: 'Overtime', unit: 'pct', value: 0.3, delta: -1.4, betterWhen: 'down', status: 'good', statusLabel: 'Healthy', basis: 'live' }),
      kpi({ id: 'dso', label: 'Days to collect', unit: 'days', value: 23, betterWhen: 'down', basis: 'statements' }),
      kpi({ id: 'cash', label: 'Cash', unit: 'money', value: 181091.03, delta: -68900, deltaPct: -0.276, basis: 'books' }),
    ],
    changes: [
      { id: 'rev', tone: 'good', text: 'Revenue rose to $82.2k, up 39.6% on the same days of Q3.', href: '/executive/financials' },
      { id: 'cash', tone: 'bad', text: 'Cash fell to $181k, down 27.6% on the same days of Q3.', href: null },
    ],
    plan: { quarter: '2026-Q4', set: true },
    notes: ['Weeks run Saturday to Friday, Eastern time.'],
    ...over,
  };
}

const targets: ExecTargetsResponse = {
  quarter: '2026-Q4',
  elapsedPct: 29,
  targets: { revenueTarget: 1_200_000, marginTarget: 240_000, headcountTarget: 40, turnoverPctTarget: 30, fillRatePctTarget: 95 },
  actuals: { revenueQtd: 82_190.5, marginQtd: 17_120, headcount: 36, turnoverAnnualizedPct: 0, fillRatePct: 99.1 },
};

const decision = (i: number, over: Partial<ExecDecision> = {}): ExecDecision => ({
  key: `d${i}`,
  category: 'run',
  severity: i === 1 ? 'critical' : 'normal',
  label: `Decision number ${i}`,
  detail: `Why decision ${i} matters.`,
  stakes: i === 1 ? 17_640.25 : null,
  ageDays: i === 1 ? 4 : 0,
  linkUrl: '/clients',
  status: 'open',
  delegatedDays: null,
  claimedBy: null,
  ...over,
});

const financials = {
  period: overview().period,
  comparison: overview().comparison,
  kpis: [
    kpi({ id: 'dso', label: 'Days to collect', unit: 'days', value: 23, betterWhen: 'down' }),
    kpi({ id: 'cash', label: 'Cash', unit: 'money', value: 181091.03 }),
  ],
  waterfall: [
    { key: 'billed', label: 'Billed', amount: 82190.5 },
    { key: 'basePay', label: 'Base pay', amount: 58000 },
    { key: 'overtimePremium', label: 'Overtime premium', amount: 79 },
    { key: 'burden', label: 'Employer burden', amount: 6980 },
    { key: 'overhead', label: 'Overhead', amount: 0 },
    { key: 'margin', label: 'Margin', amount: 17131.5 },
  ],
  weeks: [],
  cash: { today: 181091.03, accounts: 2, minimum: 50000, forecast: [], lowPoint: { weekStart: '2026-12-15', balance: 135046.28, belowMinimum: false } },
  receivables: { total: 0, buckets: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 }, open: [], dsoByMonth: [] },
  payrollRuns: [],
  profit: null,
  rates: { billRate: 21.21, payRate: 15, burdenPct: 12, overheadPerHour: 0 },
} as ExecFinancials;

const clients = (rows = true): ExecClients => ({
  period: overview().period,
  comparison: overview().comparison,
  clients: rows
    ? [
        { clientId: 'c2', name: 'Seaside Hospitality Group', billed: 19800, margin: 4120, marginPct: 20.8, sharePct: 24.1, headcount: 8, hours: 930, fillPct: 98, nps: null, health: null, healthLabel: 'Good', trend: [], href: '/clients/c2' },
        { clientId: 'c3', name: 'Harbor Inn', billed: 900, margin: 90, marginPct: 10, sharePct: 1.1, headcount: 1, hours: 40, fillPct: 60, nps: null, health: null, healthLabel: 'At risk', trend: [], href: '/clients/c3' },
        { clientId: 'c1', name: 'Coastal Resort Holdings', billed: 62390.5, margin: 13010, marginPct: 20.8, sharePct: 75.9, headcount: 28, hours: 2940, fillPct: 99, nps: 40, health: null, healthLabel: 'Watch', trend: [], href: '/clients/c1' },
      ]
    : [],
  concentration: rows ? { topSharePct: 75.9, topClientName: 'Coastal Resort Holdings', thresholdPct: 50, hhi: 6342 } : { topSharePct: 0, topClientName: null, thresholdPct: 50, hhi: 0 },
  pipeline: { stages: [], weightedAnnual: 0, prospects: [] },
  league: [],
});

const people = {
  period: overview().period,
  comparison: overview().comparison,
  kpis: [
    kpi({ id: 'turnover', label: 'Turnover', unit: 'pct', value: 12.4, target: 30, status: 'good', statusLabel: 'On plan', betterWhen: 'down' }),
    kpi({ id: 'overtimePct', label: 'Overtime', unit: 'pct', value: 0.3, delta: -1.4, betterWhen: 'down' }),
  ],
  counts: { active: 36, onTheBooks: 44, onboarding: 3, deactivated: 3, placedNotActive: 0, notPlaced: 2 },
  weeks: Array.from({ length: 13 }, (_, i) => ({ start: `2026-07-${String(i + 1).padStart(2, '0')}`, active: 36, hires: i === 5 ? 6 : i === 7 ? 4 : 1, separations: i === 7 ? 1 : 0, hours: 900, otHours: 3, otPct: 0.3, unexcused: 0 })),
  turnover: { annualizedPct: 12.4, targetPct: 30, separations90d: 1, estCost90d: 400 },
  attendance: { sites: [], weeks: [], cells: [] },
  tenure: [],
  newHires: [],
  topWorkers: [],
  anniversaries: [],
} as ExecPeople;

const risks = (list = true): ExecRisks => ({
  asOf: '2026-10-27T12:00:00.000Z',
  risks: list
    ? [
        { id: 'r2', category: 'people', severity: 'medium', title: 'Seaside Grand has no supervisor', detail: '', owner: 'Operations', trend: 'steady', metric: '10 people placed', href: '/executive/risk' },
        { id: 'r1', category: 'client', severity: 'high', title: 'One client is 76% of revenue', detail: '', owner: 'Clients', trend: 'steady', metric: '75.7% of est. billed', href: '/executive/risk' },
      ]
    : [],
});

interface Routes {
  overview?: ExecOverview | 'fail' | 'pending';
  decisions?: ExecDecision[];
  clients?: ExecClients;
  risks?: ExecRisks;
}

function mockApi(r: Routes = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/executive/overview')) {
      if (r.overview === 'fail') throw Object.assign(new Error('boom'), { name: 'ApiError', status: 500 });
      if (r.overview === 'pending') return new Promise(() => {}) as never;
      return (r.overview ?? overview()) as never;
    }
    if (path === '/executive/briefing') return { decisions: r.decisions ?? [decision(1), decision(2)] } as never;
    if (path === '/executive/targets') return targets as never;
    if (path.startsWith('/executive/financials')) return financials as never;
    if (path.startsWith('/executive/clients')) return (r.clients ?? clients()) as never;
    if (path.startsWith('/executive/people')) return people as never;
    if (path === '/executive/risks') return (r.risks ?? risks()) as never;
    if (path === '/executive/decisions/action') return { ok: true } as never;
    throw new Error(`unexpected ${path}`);
  });
}

function renderHome({ route = '/', caps = ROLE_CAPABILITIES.EXECUTIVE_CHAIRMAN as ReadonlySet<Capability>, hotel = false } = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'exec@altohr.com', firstName: 'Victoria', role: 'EXECUTIVE_CHAIRMAN', status: 'ACTIVE' as const, clientId: null, associateId: null },
          role: 'EXECUTIVE_CHAIRMAN',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
          ...(hotel ? { tenant: { id: 't-hotel', ...defaultTenantProfile('DIRECT_EMPLOYER') } } : {}),
        }}
      >
        <MemoryRouter initialEntries={[route]}>
          <ExecutiveDashboard />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

describe('the scorecard', () => {
  it('eight measures, rounded, each with its change against the comparison and its drill-down (frame kept)', async () => {
    mockApi();
    renderHome({ route: '/?period=month' });
    const card = await screen.findByTestId('exec-scorecard');
    expect(card).toHaveAccessibleName('Scorecard');
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(8);
    expect(links.map((l) => l.getAttribute('data-testid'))).toEqual(
      ['revenue', 'marginPct', 'workforce', 'fillRate', 'turnover', 'overtimePct', 'dso', 'cash'].map((id) => `exec-kpi-${id}`),
    );
    const revenue = within(card).getByTestId('exec-kpi-revenue');
    expect(revenue).toHaveTextContent('$82.2k');
    expect(revenue).toHaveTextContent('+$23.3k (+39.6%)');
    expect(revenue).toHaveTextContent('vs Q3, same days');
    expect(revenue).toHaveAttribute('href', '/executive/financials?period=month');
    // The exact figure rides in the title; no cents on the face of a card.
    expect(revenue.getAttribute('title')).toContain('$82,190.50');
    expect(card).not.toHaveTextContent(/\$\d[\d,]*\.\d\d/);
    expect(within(card).getByTestId('exec-kpi-cash')).toHaveTextContent('$181k');
    expect(within(card).getByTestId('exec-kpi-cash')).toHaveTextContent('−$68.9k (−27.6%)');
    expect(within(card).getByTestId('exec-kpi-workforce')).toHaveTextContent('−1 (−2.7%)');
    expect(within(card).getByTestId('exec-kpi-marginPct')).toHaveTextContent('±0.0 pts');
  });

  it('skeletons while it loads; a sentence and Retry when it fails', async () => {
    mockApi({ overview: 'pending' });
    renderHome();
    expect(await screen.findByTestId('exec-scorecard-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('exec-scorecard')).not.toBeInTheDocument();
  });

  it('a failed scorecard says so, with a way to try again', async () => {
    mockApi({ overview: 'fail' });
    renderHome();
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('no plan for the quarter', () => {
  it('one calm line above the cards, with the action for whoever can set it', async () => {
    mockApi({ overview: overview({ plan: { quarter: '2026-Q4', set: false } }) });
    renderHome();
    const prompt = await screen.findByTestId('exec-plan-prompt');
    expect(prompt).toHaveTextContent('No plan is set for Q4 — set it to see every measure against plan.');
    expect(within(prompt).getByRole('button', { name: 'Set the plan' })).toBeInTheDocument();
  });

  it('read-only: the sentence without the action', async () => {
    mockApi({ overview: overview({ plan: { quarter: '2026-Q4', set: false } }) });
    const caps = new Set([...ROLE_CAPABILITIES.EXECUTIVE_CHAIRMAN].filter((c) => c !== 'set:exec-targets' && c !== 'manage:org'));
    renderHome({ caps });
    const prompt = await screen.findByTestId('exec-plan-prompt');
    expect(prompt).toHaveTextContent('No plan is set for Q4 yet');
    expect(within(prompt).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exec-set-plan')).not.toBeInTheDocument();
  });

  it('a plan in place: no prompt', async () => {
    mockApi();
    renderHome();
    await screen.findByTestId('exec-scorecard');
    expect(screen.queryByTestId('exec-plan-prompt')).not.toBeInTheDocument();
  });
});

describe('set the plan', () => {
  it('prefilled from the plan, each field beside the quarter so far; saves the body the API takes', async () => {
    const user = userEvent.setup();
    mockApi();
    renderHome();
    await user.click(await screen.findByTestId('exec-set-plan'));
    expect(await screen.findByText('Plan for Q4 2026')).toBeInTheDocument();
    const revenue = await screen.findByLabelText('Revenue');
    expect(revenue).toHaveValue('1,200,000');
    expect(screen.getByLabelText('Gross margin')).toHaveValue('240,000');
    expect(screen.getByText('Quarter to date: $82.2k · on pace for $283k')).toBeInTheDocument();
    expect(screen.getByText('Active now: 36')).toBeInTheDocument();
    expect(screen.getByTestId('exec-plan-implied')).toHaveTextContent('Implies a 20.0% margin');

    await user.clear(revenue);
    await user.type(revenue, '1,500,000');
    await user.clear(screen.getByLabelText('Gross margin'));
    await user.type(screen.getByLabelText('Gross margin'), '330000');
    expect(screen.getByTestId('exec-plan-implied')).toHaveTextContent('Implies a 22.0% margin');
    await user.clear(screen.getByLabelText('Fill rate'));
    await user.click(screen.getByRole('button', { name: 'Save the plan' }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/executive/targets', {
        method: 'PUT',
        body: { quarter: '2026-Q4', revenueTarget: 1_500_000, marginTarget: 330_000, headcountTarget: 40, turnoverPctTarget: 30, fillRatePctTarget: null },
      }),
    );
    expect(toasts.success).toHaveBeenCalledWith('Plan saved for Q4 2026.');
  });

  it('refuses a negative number, a fill rate over 100% and a margin above revenue — and sends nothing', async () => {
    const user = userEvent.setup();
    mockApi();
    renderHome();
    await user.click(await screen.findByTestId('exec-set-plan'));
    const fill = await screen.findByLabelText('Fill rate');
    await user.clear(fill);
    await user.type(fill, '120');
    await user.clear(screen.getByLabelText('Headcount (active)'));
    await user.type(screen.getByLabelText('Headcount (active)'), '-4');
    await user.clear(screen.getByLabelText('Gross margin'));
    await user.type(screen.getByLabelText('Gross margin'), '2,000,000');
    await user.click(screen.getByRole('button', { name: 'Save the plan' }));
    expect(await screen.findByText("A fill rate can't be over 100%.")).toBeInTheDocument();
    expect(screen.getByText("It can't be below zero.")).toBeInTheDocument();
    expect(screen.getByText("Gross margin can't be more than revenue.")).toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PUT')).toHaveLength(0);
  });
});

describe('what changed and the decisions', () => {
  it('the changes, each with its way in when it has one', async () => {
    mockApi();
    renderHome();
    const list = await screen.findByTestId('exec-changes');
    expect(within(list).getByRole('link', { name: /Revenue rose to \$82\.2k/ })).toHaveAttribute('href', '/executive/financials');
    expect(within(list).getByText(/Cash fell to \$181k/).closest('a')).toBeNull();
  });

  it('the top three decisions, then all of them; stakes rounded; delegate works in place', async () => {
    const user = userEvent.setup();
    mockApi({ decisions: [1, 2, 3, 4, 5].map((i) => decision(i)).concat(decision(6, { status: 'delegated', delegatedDays: 2, label: 'Handed-off item' })) });
    renderHome();
    const card = await screen.findByTestId('exec-decisions');
    expect(within(card).getAllByTestId('exec-decision')).toHaveLength(3);
    expect(screen.getByText('5 open · 1 with your team')).toBeInTheDocument();
    expect(within(card).getByText('$17.6k at stake')).toBeInTheDocument();
    expect(within(card).getByText('· waiting 4 days')).toBeInTheDocument();
    expect(within(card).getByText('delegated 2 days ago')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'See all 5' }));
    expect(within(card).getAllByTestId('exec-decision')).toHaveLength(5);
    await user.click(within(card).getByRole('button', { name: 'Show fewer' }));
    expect(within(card).getAllByTestId('exec-decision')).toHaveLength(3);

    await user.click(within(within(card).getAllByTestId('exec-decision')[0]!).getByRole('button', { name: 'Delegate' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/executive/decisions/action', { method: 'POST', body: { key: 'd1', action: 'delegate' } }));
    expect(toasts.success).toHaveBeenCalled();
  });

  it('nothing waiting: said once, in words', async () => {
    mockApi({ decisions: [] });
    renderHome();
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
    expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument();
  });
});

describe('the previews below the scorecard', () => {
  it('financials, clients, workforce and risk — each its one-line answer, its figures and its way in', async () => {
    mockApi();
    renderHome();
    const fin = await screen.findByTestId('exec-preview-financials');
    expect(await within(fin).findByText('Of $82.2k billed, $17.1k was margin — 20.8%.')).toBeInTheDocument();
    expect(within(fin).getByTestId('exec-fin-cash')).toHaveTextContent('$181k');
    expect(within(fin).getByTestId('exec-fin-cash')).toHaveTextContent('in 2 bank accounts');
    expect(within(fin).getByTestId('exec-fin-low')).toHaveTextContent('$135k');
    expect(within(fin).getByTestId('exec-fin-low')).toHaveTextContent('week of Dec 15');
    expect(within(fin).getByTestId('exec-fin-dso')).toHaveTextContent('23');
    expect(within(fin).getByRole('link', { name: /Open financials/ })).toHaveAttribute('href', '/executive/financials');

    const cl = screen.getByTestId('exec-preview-clients');
    expect(await within(cl).findByText('Coastal Resort Holdings is 75.9% of billing — past the 50% line.')).toBeInTheDocument();
    const rows = within(cl).getAllByTestId('exec-client-row');
    // Largest first.
    expect(rows[0]).toHaveTextContent('Coastal Resort Holdings');
    expect(rows[0]).toHaveTextContent('$62.4k');
    expect(rows.map((r) => within(r).getByTestId('exec-client-health').textContent)).toEqual(['Watch', 'Good', 'At risk']);
    // Health is a chip from the palette's scales — caution, positive, negative.
    expect(within(rows[0]!).getByTestId('exec-client-health')).toHaveClass('bg-caution-100', 'text-caution-800');
    expect(within(rows[1]!).getByTestId('exec-client-health')).toHaveClass('bg-positive-100', 'text-positive-800');
    expect(within(rows[2]!).getByTestId('exec-client-health')).toHaveClass('bg-negative-100', 'text-negative-800');
    expect(within(cl).getByRole('img', { name: 'Coastal Resort Holdings: 75.9% of billing; the line marks 50%' })).toBeInTheDocument();

    const wf = screen.getByTestId('exec-preview-workforce');
    expect(await within(wf).findByText('36 active · 21 hired and 1 left in 13 weeks.')).toBeInTheDocument();
    expect(within(wf).getByTestId('exec-people-turnover')).toHaveTextContent('12.4%');
    expect(within(wf).getByTestId('exec-people-turnover')).toHaveTextContent('Plan 30.0%');
    expect(within(wf).getByTestId('exec-people-ot')).toHaveTextContent('−1.4 pts vs Q3, same days');

    const rk = screen.getByTestId('exec-preview-risk');
    expect(await within(rk).findByText('2 open risks — 1 high.')).toBeInTheDocument();
    const items = within(within(rk).getByTestId('exec-risks')).getAllByRole('link');
    // Highest severity first, whatever order they came in.
    expect(items[0]).toHaveTextContent('High');
    expect(items[0]).toHaveTextContent('One client is 76% of revenue');
    expect(items[0]).toHaveTextContent('Owner: Clients');
    expect(within(rk).getByRole('link', { name: /Open the register/ })).toHaveAttribute('href', '/executive/risk');
  });

  it('empty portfolio and a clear register are said in words', async () => {
    mockApi({ clients: clients(false), risks: risks(false) });
    renderHome();
    expect(await screen.findByText('No client billed in this period.')).toBeInTheDocument();
    expect(screen.getByText('No billing in this period yet.')).toBeInTheDocument();
    expect(await screen.findByText('The register is clear.')).toBeInTheDocument();
    expect(screen.getByText('Nothing open on the register.')).toBeInTheDocument();
  });

  it('a direct employer bills no one: no client portfolio preview', async () => {
    mockApi();
    renderHome({ hotel: true });
    expect(await screen.findByTestId('exec-preview-financials')).toBeInTheDocument();
    expect(await screen.findByTestId('exec-preview-risk')).toBeInTheDocument();
    expect(screen.queryByTestId('exec-preview-clients')).not.toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.some(([p]) => p.startsWith('/executive/clients'))).toBe(false);
  });

  it('the previews wait for the scorecard: nothing below the fold is asked for first', async () => {
    mockApi({ overview: 'pending' });
    renderHome();
    await screen.findByTestId('exec-scorecard-loading');
    await new Promise((r) => setTimeout(r, 400));
    const asked = vi.mocked(apiFetch).mock.calls.map(([p]) => p);
    expect(asked.some((p) => p.startsWith('/executive/financials') || p.startsWith('/executive/clients') || p.startsWith('/executive/people') || p === '/executive/risks')).toBe(false);
  });
});

describe('the frame and the footnotes', () => {
  it('the definitions print once, small, at the foot', async () => {
    mockApi();
    renderHome();
    expect(await screen.findByTestId('exec-notes')).toHaveTextContent('Weeks run Saturday to Friday, Eastern time.');
  });
});
