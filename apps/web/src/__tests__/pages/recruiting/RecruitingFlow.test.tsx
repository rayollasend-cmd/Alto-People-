import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecruitingAnalytics as Analytics, RecruitingFlow } from '@alto-people/shared';

// The chart engine never loads in jsdom: the plot stays a skeleton, and the
// frame's summary and table carry the figure.
vi.mock('@/components/ui/charts/echarts/engine', () => ({ loadEcharts: () => new Promise(() => {}) }));
vi.mock('@/lib/recruitingApi', () => ({
  getRecruitingAnalytics: vi.fn(),
  listSourceSpend: vi.fn(async () => ({ spend: [] })),
  saveSourceSpend: vi.fn(),
  deleteSourceSpend: vi.fn(),
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ can: () => true, user: { id: 'me-1' } }),
}));

import { getRecruitingAnalytics } from '@/lib/recruitingApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { RecruitingAnalytics } from '@/pages/recruiting/RecruitingAnalytics';

type Exit = RecruitingFlow['exits'][number];
const STEPS = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'] as const;
/** Exits as [rejected, withdrew, open] per step, the API's 12 rows. */
function exits(counts: Record<(typeof STEPS)[number], [number, number, number]>, autoClosed: Partial<Record<(typeof STEPS)[number], number>> = {}): Exit[] {
  return STEPS.flatMap((stage) =>
    (['REJECTED', 'WITHDRAWN', 'OPEN'] as const).map((outcome, i) => ({
      stage,
      outcome,
      count: counts[stage][i]!,
      autoClosed: outcome === 'WITHDRAWN' ? (autoClosed[stage] ?? 0) : 0,
    })),
  );
}

const FLOW: RecruitingFlow = {
  reached: { APPLIED: 240, SCREENING: 170, INTERVIEW: 70, OFFER: 40, HIRED: 31 },
  exits: exits(
    { APPLIED: [30, 8, 32], SCREENING: [88, 6, 6], INTERVIEW: [20, 5, 5], OFFER: [0, 4, 5] },
    { SCREENING: 4 },
  ),
};

function data(flow: RecruitingFlow | undefined): Analytics {
  return {
    range: { from: '2026-07-26', to: '2026-10-23' },
    funnel: {
      applicants: flow?.reached.APPLIED ?? 240,
      stages: [
        { stage: 'APPLIED', reached: 240, toNextPct: 71 },
        { stage: 'SCREENING', reached: 170, toNextPct: 41 },
        { stage: 'INTERVIEW', reached: 70, toNextPct: 57 },
        { stage: 'OFFER', reached: 40, toNextPct: 78 },
        { stage: 'HIRED', reached: 31, toNextPct: null },
      ],
      rejected: 138,
      withdrawn: 23,
      inProgress: 48,
    },
    speed: { hires: 31, medianDaysToHire: 12, postingsFilled: 0, medianDaysToFill: null },
    sources: [],
    spendTotal: null,
    costPerHire: null,
    offers: { accepted: 0, declined: 0, expired: 0, acceptancePct: null },
    fill: { openings: 0, filled: 0, fillRatePct: null },
    clients: [],
    retention: {
      window: { from: '2025-07-26', to: '2026-07-25' },
      overall: { key: null, label: 'All hires', hires: 0, stayed: 0, stayedPct: null },
      bySource: [],
      byRecruiter: [],
    },
    ...(flow ? { flow } : {}),
  };
}

function renderPage(url = '/recruiting/analytics') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <RecruitingAnalytics />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const SUMMARY = 'Of 240 applicants, 31 were hired; most who left were rejected at screening (88).';

beforeEach(() => {
  vi.mocked(getRecruitingAnalytics).mockReset().mockResolvedValue(data(FLOW));
});

describe('How candidates move', () => {
  it('says in one sentence who was hired and where most who left stopped', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'How candidates move' })).toBeInTheDocument();
    // The figure is read as its summary; the drawing waits on the engine.
    expect(screen.getByRole('img', { name: SUMMARY })).toBeInTheDocument();
    expect(screen.getByText(/4 were closed automatically for no response/)).toBeInTheDocument();
  });

  it('lists every move in its table — each step onward, and each way out of it', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'How candidates move' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['From', 'To', 'Candidates']);
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent).join(' | '));
    expect(rows).toEqual([
      'Applied | Screening | 170',
      'Applied | Rejected | 30',
      'Applied | Withdrew | 8',
      'Applied | Still in progress | 32',
      'Screening | Interview | 70',
      'Screening | Rejected | 88',
      'Screening | Withdrew | 6',
      'Screening | Still in progress | 6',
      'Interview | Offer | 40',
      'Interview | Rejected | 20',
      'Interview | Withdrew | 5',
      'Interview | Still in progress | 5',
      'Offer | Hired | 31',
      // Nobody rejected at offer: no row, no ribbon.
      'Offer | Withdrew | 4',
      'Offer | Still in progress | 5',
    ]);
  });

  it('keeps how it is counted behind its ⓘ', async () => {
    const user = renderPage();
    await screen.findByRole('heading', { name: 'How candidates move' });
    expect(screen.queryByText(/A skipped step counts as passed through/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'How “How candidates move” is counted' }));
    expect(screen.getByRole('note')).toHaveTextContent(/An undone hire is not a hire/);
  });

  it('follows the range, and names the biggest exit when no one exit is most of them', async () => {
    const user = renderPage();
    await screen.findByRole('img', { name: SUMMARY });
    vi.mocked(getRecruitingAnalytics).mockResolvedValue(
      data({
        reached: { APPLIED: 20, SCREENING: 12, INTERVIEW: 6, OFFER: 3, HIRED: 2 },
        exits: exits({ APPLIED: [4, 3, 1], SCREENING: [3, 2, 1], INTERVIEW: [1, 1, 1], OFFER: [0, 1, 0] }),
      }),
    );
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(getRecruitingAnalytics).toHaveBeenCalledTimes(2));
    const [range] = vi.mocked(getRecruitingAnalytics).mock.calls[1]!;
    expect((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000).toBe(29);
    expect(await screen.findByRole('img', { name: 'Of 20 applicants, 2 were hired; the biggest exit was rejection at application (4).' })).toBeInTheDocument();
    // Nobody closed automatically in this range: nothing said about it.
    expect(screen.queryByText(/closed automatically for no response\./)).not.toBeInTheDocument();
  });

  it('says so when no one applied in the range', async () => {
    vi.mocked(getRecruitingAnalytics).mockResolvedValue(
      data({ reached: { APPLIED: 0, SCREENING: 0, INTERVIEW: 0, OFFER: 0, HIRED: 0 }, exits: exits({ APPLIED: [0, 0, 0], SCREENING: [0, 0, 0], INTERVIEW: [0, 0, 0], OFFER: [0, 0, 0] }) }),
    );
    renderPage();
    expect(await screen.findByText('No one applied in this range')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'How candidates move' })).not.toBeInTheDocument();
  });

  it('an API without the flow leaves the card out, and the funnel stands alone', async () => {
    vi.mocked(getRecruitingAnalytics).mockResolvedValue(data(undefined));
    renderPage();
    expect(await screen.findByRole('table', { name: 'Funnel' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'How candidates move' })).not.toBeInTheDocument();
  });
});
