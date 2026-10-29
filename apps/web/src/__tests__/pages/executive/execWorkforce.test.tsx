import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { ExecPeople } from '@alto-people/shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { ApiError, apiFetch } from '@/lib/api';
import { ExecPeoplePage } from '@/pages/executive/PeoplePage';
import { attendanceGrid, pointsIn, turnoverStatus } from '@/pages/executive/people/peopleMath';
import { COMPARISON, PERIOD, execKpi, renderAsChairman, routeApi } from './execPagesHarness';

/**
 * The chairman's Workforce page: the scorecard's people measures, where
 * everyone stands in the People directory's words, thirteen weeks of
 * movement, turnover against its plan, the attendance heatmap and the
 * people themselves — and its loading, error and thin-history states.
 */

const weeks = (n: number): ExecPeople['weeks'] =>
  Array.from({ length: n }, (_, i) => ({
    start: `2026-${String(7 + Math.floor((i * 7 + 25) / 31)).padStart(2, '0')}-${String(((i * 7 + 25) % 31) + 1).padStart(2, '0')}`,
    active: 34 + (i % 3),
    hires: i === 3 ? 2 : 0,
    separations: i === 5 ? 1 : 0,
    hours: 1000 + i,
    otHours: i,
    otPct: i / 10,
    unexcused: 2,
  }));

function people(over: Partial<ExecPeople> = {}): ExecPeople {
  return {
    period: PERIOD,
    comparison: COMPARISON,
    kpis: [
      execKpi({ id: 'workforce', label: 'Active workforce', unit: 'count', value: 36, sub: 'of 44 on the books', delta: -1, deltaPct: -0.027, compare: 37 }),
      execKpi({ id: 'hires', label: 'Hires', unit: 'count', value: 3 }),
      execKpi({ id: 'turnover', label: 'Turnover', unit: 'pct', value: 12.4, betterWhen: 'down', target: 15, status: 'good', statusLabel: 'On plan' }),
      execKpi({ id: 'overtimePct', label: 'Overtime', unit: 'pct', value: 0.3 }),
    ],
    counts: { active: 36, onTheBooks: 44, onboarding: 3, deactivated: 3, placedNotActive: 2, notPlaced: 3 },
    weeks: weeks(13),
    turnover: { annualizedPct: 12.4, targetPct: 15, separations90d: 1, estCost90d: 400 },
    attendance: {
      sites: [
        { id: 's1', name: 'Front Beach 218' },
        { id: 's2', name: 'Destin Harbor 507' },
      ],
      weeks: ['2026-10-03', '2026-10-10'],
      cells: [
        { siteId: 's1', week: '2026-10-03', events: 4, perHundredShifts: 6.5 },
        { siteId: 's1', week: '2026-10-10', events: 0, perHundredShifts: 0 },
        { siteId: 's2', week: '2026-10-10', events: 2, perHundredShifts: 12.1 },
      ],
    },
    tenure: [
      { band: 'Under 90 days', count: 11 },
      { band: '1–2 years', count: 13 },
    ],
    newHires: [{ id: 'a1', name: 'Kendra Cole', photoUrl: null, hireDate: '2026-09-30' }],
    topWorkers: [{ id: 'a2', name: 'Mehmet Yılmaz', photoUrl: null, hours: 150.6 }],
    anniversaries: [{ id: 'a3', name: 'Grace Holloway', years: 1, date: '2026-10-30' }],
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the Workforce page', () => {
  it('reads the scorecard, the counts in the directory’s words and every section from one request', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/people': people() }) as never);
    renderAsChairman(<ExecPeoplePage />, { route: '/executive/people' });

    expect(await screen.findByTestId('exec-kpi-workforce')).toHaveTextContent('36');
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('/executive/people?period=quarter&compare=prior');
    // The KPI keeps the frame on its drill-down and says what it is compared with.
    expect(screen.getByTestId('exec-kpi-workforce')).toHaveTextContent('vs Q3, same days');

    const counts = screen.getByTestId('exec-workforce-counts');
    for (const [word, n] of [['On the books', '44'], ['Working', '36'], ['No recent shifts', '2'], ['Not placed', '3'], ['Paused', '3'], ['Onboarding', '3']] as const) {
      const link = within(counts).getByText(word).closest('a')!;
      expect(link).toHaveTextContent(n);
    }
    expect(within(counts).getByText('Working').closest('a')).toHaveAttribute('href', '/people?workStatus=ACTIVE');
    expect(within(counts).getByText('82% of the books')).toBeInTheDocument();

    // Turnover against its ceiling, with the money rounded and marked as an estimate.
    const turnover = screen.getByTestId('exec-turnover');
    expect(turnover).toHaveTextContent('12.4%');
    expect(turnover).toHaveTextContent('Turnover is running at 12.4% a year, inside the plan of 15.0%.');
    expect(turnover).toHaveTextContent('$400');
    expect(turnover).toHaveTextContent('1 separation at the standard cost of replacing someone.');

    // The heatmap: sites × weeks, a blank cell for a week with no shifts, a legend.
    expect(screen.getByRole('button', { name: /Front Beach 218, week of Oct 3: 6\.5 per 100 shifts \(4 events\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Destin Harbor 507, week of Oct 3: no shifts/ })).toBeInTheDocument();
    expect(screen.getByText(/More per 100 shifts/)).toBeInTheDocument();

    // The people, closing the page.
    const band = screen.getByTestId('exec-people-band');
    expect(within(band).getByText('Kendra')).toBeInTheDocument();
    expect(within(band).getByText('151h')).toBeInTheDocument();
    expect(within(band).getByText(/1 year/)).toBeInTheDocument();
  });

  it('turns a chart with fewer than four weeks into the number and a sentence', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/people': people({ weeks: weeks(2) }) }) as never);
    renderAsChairman(<ExecPeoplePage />, { route: '/executive/people' });
    const few = await screen.findByTestId('exec-headcount-few');
    expect(few).toHaveTextContent('Fewer than four weeks of history so far');
    expect(screen.getByTestId('exec-hires-few')).toHaveTextContent('Over 2 weeks: 0 hired, 0 separated, net 0.');
  });

  it('says plainly when there is nothing yet', async () => {
    vi.mocked(apiFetch).mockImplementation(
      routeApi({
        '/executive/people': people({ newHires: [], topWorkers: [], anniversaries: [], turnover: { annualizedPct: null, targetPct: null, separations90d: 0, estCost90d: 0 }, attendance: { sites: [], weeks: [], cells: [] } }),
      }) as never,
    );
    renderAsChairman(<ExecPeoplePage />, { route: '/executive/people' });
    expect(await screen.findByText('No one has started in the last 30 days.')).toBeInTheDocument();
    expect(screen.getByText('Not enough history to annualize turnover yet.')).toBeInTheDocument();
    expect(screen.getByText('No separations in the last 90 days.')).toBeInTheDocument();
    expect(screen.getByText('No shifts worked in the last eight weeks.')).toBeInTheDocument();
  });

  it('shows a skeleton while loading and a retry when the request fails', async () => {
    let fail = true;
    vi.mocked(apiFetch).mockImplementation(((path: string) => (fail ? Promise.reject(new ApiError(500, 'boom', 'Request failed (500)')) : routeApi({ '/executive/people': people() })(path))) as never);
    renderAsChairman(<ExecPeoplePage />, { route: '/executive/people' });
    expect(await screen.findByText(/Couldn.t load the workforce figures/)).toBeInTheDocument();
    expect(screen.queryByText('Request failed (500)')).not.toBeInTheDocument();
    fail = false;
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(await screen.findByTestId('exec-kpi-workforce')).toBeInTheDocument();
  });
  it('a hotel sees the same page with no client or staffing words of its own', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/people': people() }) as never);
    const { container } = renderAsChairman(<ExecPeoplePage />, { route: '/executive/people', off: ['clientPortal', 'billRates', 'programs'] });
    await screen.findByTestId('exec-workforce-counts');
    expect(container.textContent).not.toMatch(/\bclients?\b|\bassociates?\b|\balto\b/i);
  });
});

describe('the workforce arithmetic', () => {
  it('counts real readings only', () => {
    expect(pointsIn([1, null, 3, undefined, Number.NaN])).toBe(2);
  });
  it('judges turnover against a ceiling', () => {
    expect(turnoverStatus(12, 15)).toBe('good');
    expect(turnoverStatus(15.5, 15)).toBe('watch');
    expect(turnoverStatus(18, 15)).toBe('bad');
    expect(turnoverStatus(18, null)).toBe('none');
  });
  it('lays the attendance cells out sites × weeks, blank where a site ran nothing', () => {
    const g = attendanceGrid(people().attendance);
    expect(g.values).toEqual([
      [6.5, 0],
      [null, 12.1],
    ]);
    expect(g.events).toEqual([
      [4, 0],
      [0, 2],
    ]);
  });
});
