import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import type { ExecClientRow, ExecClients } from '@alto-people/shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
// A tap on a bubble navigates; the harness has one route, so the call itself is checked.
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate }));
// The matrix draws through ECharts; jsdom can't lay a figure out, so a fake engine stands in.
const fakeChart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() };
vi.mock('@/components/ui/charts/echarts/engine', () => ({ loadEcharts: () => Promise.resolve({ init: () => fakeChart }) }));

import { apiFetch } from '@/lib/api';
import { ExecClientsPage } from '@/pages/executive/ClientsPage';
import { HEALTH_RANK, concentrationBand, fmtNps, healthTone, portfolioMarginPct, shareRows } from '@/pages/executive/clients/clientMath';
import { leagueRows } from '@/pages/executive/clients/StoreLeague';
import { COMPARISON, PERIOD, location, renderAsChairman, routeApi } from './execPagesHarness';

/**
 * The chairman's Client portfolio: concentration against the risk line with
 * the index in words, the client matrix, every client exact, the weighted
 * pipeline and the store league — and the portfolio of two, of none, and a
 * pipeline with nothing in it.
 */

const client = (over: Partial<ExecClientRow> & Pick<ExecClientRow, 'clientId' | 'name' | 'billed'>): ExecClientRow => ({
  margin: over.billed * 0.208,
  marginPct: 20.8,
  sharePct: 0,
  headcount: 10,
  hours: over.billed / 21.21,
  fillPct: 98.5,
  nps: null,
  health: null,
  healthLabel: 'Good',
  trend: [5, 6, 7, 6, 7, 8, 7, 8].map((n) => n * 1000),
  href: `/clients/${over.clientId}`,
  ...over,
});

const CLIENTS: ExecClientRow[] = [
  client({ clientId: 'c1', name: 'Coastal Resort Holdings', billed: 62406.18, sharePct: 57.3, headcount: 26, healthLabel: 'Watch', nps: 42 }),
  client({ clientId: 'c2', name: 'Seaside Hospitality Group', billed: 19783.27, sharePct: 18.2, healthLabel: 'Good', nps: -8 }),
  client({ clientId: 'c3', name: 'Emerald Coast Foods', billed: 16000, sharePct: 14.7, marginPct: 12.1, margin: 1936, healthLabel: 'At risk' }),
  client({ clientId: 'c4', name: 'Pine Ridge Resort', billed: 10700, sharePct: 9.8, marginPct: 27.9, margin: 2985.3, healthLabel: null }),
];

const store = (i: number, margin: number, otHours = 0) => ({ locationId: `l${i}`, name: `Store ${i}`, clientName: 'Coastal Resort Holdings', billed: margin * 5, margin, marginPct: margin > 0 ? 20 : -5, hours: 400, otHours });

function portfolio(over: Partial<ExecClients> = {}): ExecClients {
  return {
    period: PERIOD,
    comparison: COMPARISON,
    clients: CLIENTS,
    concentration: { topSharePct: 57.3, topClientName: 'Coastal Resort Holdings', thresholdPct: 50, hhi: 3923 },
    pipeline: {
      stages: [
        { stage: 'VERBAL', label: 'Verbal yes', count: 1, weeklyValue: 4400, probability: 0.8, weightedAnnual: 183040 },
        { stage: 'PROPOSAL', label: 'Proposal', count: 2, weeklyValue: 9920, probability: 0.5, weightedAnnual: 257920 },
        { stage: 'LEAD', label: 'Lead', count: 0, weeklyValue: 0, probability: 0.1, weightedAnnual: 0 },
      ],
      weightedAnnual: 440960,
      prospects: [
        { id: 'p1', name: 'Destin Marina Group', stage: 'VERBAL', stageLabel: 'Verbal yes', weeklyValue: 4400, daysInStage: 7 },
        { id: 'p2', name: 'Pine Ridge Resort', stage: 'PROPOSAL', stageLabel: 'Proposal', weeklyValue: null, daysInStage: 1 },
      ],
    },
    league: [store(1, 7729.55, 10.5), store(2, 4113.35), store(3, -400, 6)],
    ...over,
  };
}

function show(data: ExecClients | Error, route = '/executive/clients') {
  vi.mocked(apiFetch).mockImplementation(
    routeApi({
      '/executive/clients': () => {
        if (data instanceof Error) throw data;
        return data;
      },
    }) as typeof apiFetch,
  );
  return renderAsChairman(<ExecClientsPage />, { route });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.clearAllMocks();
});

describe('the Client portfolio page', () => {
  it('asks for the frame and says how concentrated the book is, with the line drawn and the client past it named', async () => {
    show(portfolio(), '/executive/clients?period=year');
    const conc = await screen.findByTestId('exec-concentration');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/executive/clients?period=year&compare=prior');
    expect(screen.getAllByText('A concentrated book: one client, Coastal Resort Holdings, is 57.3% of revenue.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Concentration index (HHI) 3,923 of 10,000 — under 1,500 is diversified, over 2,500 concentrated.').length).toBeGreaterThan(0);
    expect(conc).toHaveTextContent('50% risk line');
    // The risk line's name sits in an aria-hidden header row; the clients follow.
    const rows = within(conc).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Coastal Resort HoldingsOver the line57.3%$62.4k');
    expect(rows[1]).not.toHaveTextContent('Over the line');
    expect(screen.getByTestId('exec-board-pack-link')).toHaveAttribute('href', '/executive/board-packs?period=year');
  });

  it('draws the matrix with every client in it, its quadrants named and health by the list\'s word', async () => {
    show(portfolio());
    await screen.findByTestId('scatter-matrix');
    await act(async () => {});
    expect(screen.getByText('High margin, small')).toBeInTheDocument();
    expect(screen.getByText('Low margin, large')).toBeInTheDocument();
    const opt = fakeChart.setOption.mock.calls.at(-1)![0] as { series: Array<{ data: Array<{ id: string; tone: string }> }> };
    expect(Object.fromEntries(opt.series[0]!.data.map((d) => [d.id, d.tone]))).toEqual({ c1: 'watch', c2: 'good', c3: 'bad', c4: 'none' });
    expect(screen.getAllByText(/4 clients billed in the period\. The largest, Coastal Resort Holdings, billed \$62\.4k at 20\.8% margin\. The best margin is Pine Ridge Resort's, at 27\.9%\./).length).toBeGreaterThan(0);
    // A tap on a bubble opens the client.
    const onClick = fakeChart.on.mock.calls.find((c) => c[0] === 'click')![1] as (p: unknown) => void;
    act(() => onClick({ data: { id: 'c3' } }));
    expect(navigate).toHaveBeenCalledWith('/clients/c3');
    // The page's URL stays the frame's: the table keeps its sort to itself.
    expect(location()).toBe('/executive/clients');
  });

  it('lists every client exact, largest first, with health as a word and NPS signed', async () => {
    show(portfolio());
    const table = await screen.findByRole('table', { name: 'Clients' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Coastal Resort Holdings', 'Seaside Hospitality Group', 'Emerald Coast Foods', 'Pine Ridge Resort']);
    expect(within(rows[0]!).getByRole('link', { name: 'Coastal Resort Holdings' })).toHaveAttribute('href', '/clients/c1');
    expect(rows[0]).toHaveTextContent('$62,406.18');
    expect(rows[0]).toHaveTextContent('+42');
    expect(rows[1]).toHaveTextContent('−8');
    expect(within(rows[0]!).getByText('Watch')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('At risk')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Not rated')).toBeInTheDocument();
    // Never a numeric score.
    expect(table).not.toHaveTextContent(/Watch · \d/);
    // The dictionary's names (LEAD-5): the portfolio's money is Revenue at the standard rates,
    // and the card says statements are the invoice-grade figure — Clients' "Billed" reads those.
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Revenue (est.)', 'Gross margin', 'Gross margin %']));
    expect(headers).not.toContain('Billed');
    expect(screen.getAllByText(/finalized statements are the invoice-grade figure/).length).toBeGreaterThan(0);
  });

  it('weights the pipeline: the annual total as the headline, each stage in words, an empty stage with no bar, the rates in a footnote', async () => {
    show(portfolio());
    expect(await screen.findByTestId('exec-pipeline-total')).toHaveTextContent('$441k a year');
    expect(screen.getByTestId('funnel-stage-PROPOSAL')).toHaveTextContent('Proposal2 prospects$258k a year$9.92k a week · 50% close');
    expect(screen.getByTestId('funnel-stage-LEAD')).toHaveTextContent('LeadNo prospects');
    expect(screen.getByTestId('funnel-stage-LEAD').querySelector('[data-width]')).toBeNull();
    expect(screen.getByTestId('exec-pipeline-footnote')).toHaveTextContent('Weighted at each stage\'s close rate — Verbal yes 80%, Proposal 50%, Lead 10%.');
    const prospects = screen.getByRole('table', { name: 'Prospects' });
    expect(within(prospects).getByText('Not sized')).toBeInTheDocument();
    expect(within(prospects).getByText('1 day')).toBeInTheDocument();
  });

  it('ranks the stores by margin, a loss in its own colour with a minus sign, overtime in words', async () => {
    show(portfolio());
    const league = await screen.findByTestId('exec-store-league');
    const rows = within(league).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Store 1');
    expect(rows[0]).toHaveTextContent('10.5h overtime (2.6% of hours)');
    expect(rows[1]).toHaveTextContent('No overtime');
    expect(within(rows[2]!).getByText('−$400')).toHaveClass('text-negative-800');
  });

  it('two clients: the matrix is a list; no clients and no prospects: each section says so', async () => {
    const { unmount } = show(portfolio({ clients: CLIENTS.slice(0, 2) }));
    expect(await screen.findByTestId('exec-matrix-few')).toHaveTextContent('The matrix appears once there are three clients.');
    unmount();
    show(portfolio({ clients: [], concentration: { topSharePct: 0, topClientName: null, thresholdPct: 50, hhi: 0 }, pipeline: { stages: [], weightedAnnual: 0, prospects: [] }, league: [] }));
    expect((await screen.findAllByText('Clients appear here once approved time is billed in the period.')).length).toBeGreaterThan(0);
    expect(screen.getByText('No prospects in the pipeline')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the pipeline' })).toHaveAttribute('href', '/clients/pipeline');
    expect(screen.getAllByText('No store worked hours in this period.').length).toBeGreaterThan(0);
  });

  it('a company that bills no one is told so, in words that are its own, and asks for nothing', () => {
    vi.mocked(apiFetch).mockImplementation(() => Promise.reject(new Error('should not be called')));
    renderAsChairman(<ExecClientsPage />, { route: '/executive/clients', off: ['clientPortal'] });
    expect(screen.getByTestId('exec-clients-off')).toHaveTextContent('Billing is turned off for this organization');
    expect(screen.getByRole('link', { name: 'Financials' })).toHaveAttribute('href', '/executive/financials');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Portfolio$/);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('shows a skeleton while loading and a retry when it fails', async () => {
    vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderAsChairman(<ExecClientsPage />, { route: '/executive/clients' });
    expect(screen.getByTestId('exec-clients-loading')).toBeInTheDocument();
    unmount();
    show(new Error('boom'));
    expect(await screen.findByText(/Couldn’t load the client portfolio\./)).toBeInTheDocument();
  });
});

describe('the portfolio arithmetic', () => {
  it('reads health from the clients list\'s word, and sorts at risk first', () => {
    expect(healthTone({ health: null, healthLabel: 'Good' })).toBe('good');
    expect(healthTone({ health: null, healthLabel: 'Watch' })).toBe('watch');
    expect(healthTone({ health: null, healthLabel: 'At risk' })).toBe('bad');
    expect(healthTone({ health: null, healthLabel: null })).toBe('none');
    expect(healthTone({ health: 55, healthLabel: null })).toBe('bad');
    expect([HEALTH_RANK.bad, HEALTH_RANK.watch, HEALTH_RANK.good, HEALTH_RANK.none]).toEqual([0, 1, 2, null]);
  });

  it('calls a book concentrated past the line or over 2,500, moderate from 1,500', () => {
    expect(concentrationBand(1200, 55, 50)).toBe('high');
    expect(concentrationBand(2600, 40, 50)).toBe('high');
    expect(concentrationBand(2000, 40, 50)).toBe('moderate');
    expect(concentrationBand(900, 20, 50)).toBe('low');
  });

  it('folds the clients past the largest seven into one row', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ clientId: `c${i}`, name: `C${i}`, billed: 100 - i, sharePct: 10 }));
    const rows = shareRows(many);
    expect(rows).toHaveLength(8);
    expect(rows[7]).toMatchObject({ key: 'other', other: 3, sharePct: 30 });
    expect(shareRows(many.slice(0, 8))).toHaveLength(8);
  });

  it('works out the portfolio margin and signs an NPS', () => {
    expect(portfolioMarginPct([{ billed: 100, margin: 20 }, { billed: 100, margin: 10 }])).toBe(15);
    expect(portfolioMarginPct([])).toBeNull();
    expect([fmtNps(42), fmtNps(-8), fmtNps(0), fmtNps(null)]).toEqual(['+42', '−8', '0', '—']);
  });

  it('draws a long league as its top and its bottom with the count between', () => {
    const l = Array.from({ length: 20 }, (_, i) => i);
    expect(leagueRows(l)).toEqual({ head: [0, 1, 2, 3, 4, 5, 6, 7], hidden: 8, tail: [16, 17, 18, 19] });
    expect(leagueRows(l.slice(0, 12))).toEqual({ head: l.slice(0, 12), hidden: 0, tail: [] });
  });
});
