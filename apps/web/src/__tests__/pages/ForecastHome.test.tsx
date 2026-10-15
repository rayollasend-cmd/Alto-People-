import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import type { ForecastResponse, ForecastSitesResponse } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/forecastApi', () => ({
  listForecastSites: vi.fn(),
  getSiteForecast: vi.fn(),
  runForecast: vi.fn(),
  setForecastSignal: vi.fn(),
  removeForecastSignal: vi.fn(),
  createPlanFromForecast: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn().mockResolvedValue({ clients: [] }) }));
vi.mock('recharts', async (orig) => ({
  ...(await orig<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="chart">{children}</div>,
}));

import { getSiteForecast, listForecastSites, runForecast } from '@/lib/forecastApi';
import { ForecastHome } from '@/pages/forecast/ForecastHome';

/**
 * Brief 3-4 — the forecast page: an honest empty state before the first
 * compute, then one site's band with its drivers and the scoring table,
 * and the compute action for the people who hold manage:org.
 */

const run = { id: 'r1', method: 'seasonal-naive-trend/1', generatedAt: '2026-10-15T18:00:00.000Z', anchorWeek: '2026-10-10', horizonWeeks: 26, trigger: 'manual', weights: { lastYearWeight: 0.5, bandLow: -0.15, bandHigh: 0.18 } };
const site = { locationId: 'l1', siteName: 'Front Beach 218', clientName: 'Coastal Resort Holdings', timezone: 'America/Chicago', next4WeeksHours: 2480, mapePct: 8.4, historyWeeks: 52 };
const sitesEmpty: ForecastSitesResponse = { run: null, sites: [site] };
const sitesWithRun: ForecastSitesResponse = { run, sites: [site, { ...site, locationId: 'l2', siteName: 'Thomas Drive 412', mapePct: null, next4WeeksHours: 900 }] };

function week(weekStart: string, p50: number, actual: number | null, extra: Partial<ForecastResponse['weeks'][number]['drivers']> = {}) {
  return {
    weekStart,
    p10: Math.round(p50 * 0.85),
    p50,
    p90: Math.round(p50 * 1.18),
    actualHours: actual,
    drivers: { lastYearScaled: 600, recentMean: 620, trendPerWeek: 4, holidayFactor: 1, holidayName: null, signalFactor: 1, signals: [], lastYearWeight: 0.5, leadWeeks: actual === null ? 1 : 0, ...extra },
  };
}
const detail: ForecastResponse = {
  run,
  site,
  weeks: [
    week('2026-09-19', 0, 610),
    week('2026-09-26', 0, 640),
    week('2026-10-03', 0, 655),
    week('2026-10-10', 648, null),
    week('2026-10-17', 690, null, { holidayFactor: 1.08, holidayName: 'Independence Day', leadWeeks: 2 }),
    week('2026-10-24', 720, null, { signalFactor: 1.2, signals: [{ kind: 'TRUCKS', factor: 1.2, source: 'Client truck schedule' }], leadWeeks: 3 }),
  ],
  accuracy: [{ weekStart: '2026-10-03', leadWeeks: 4, forecastP50: 630, actualHours: 655, absPctError: 3.8 }],
  signals: [{ id: 's1', weekStart: '2026-10-24', kind: 'TRUCKS', factor: 1.2, source: 'Client truck schedule', note: null }],
};

function renderPage(role: 'WORKFORCE_MANAGER' | 'EXECUTIVE_CHAIRMAN' = 'WORKFORCE_MANAGER') {
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'workforce@altohr.com', role, status: 'ACTIVE' as const, clientId: null, clientName: null, associateId: null },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/forecast']}>
          <ForecastHome />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<ForecastHome>', () => {
  it('before the first compute it says so and offers the compute to a manager', async () => {
    vi.mocked(listForecastSites).mockResolvedValue(sitesEmpty);
    vi.mocked(getSiteForecast).mockResolvedValue({ ...detail, run: null, weeks: [], accuracy: [], signals: [] });
    vi.mocked(runForecast).mockResolvedValue({ runId: 'r1', sites: 1, weeks: 26, scored: 0, weights: { lastYearWeight: 0.5, bandLow: -0.15, bandHigh: 0.15, mapePct: 9.1, summerMapePct: null, scoredWeeks: 12 } });
    renderPage();
    expect(await screen.findByText('No forecast yet')).toBeInTheDocument();
    expect(screen.getByText('Not computed yet')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /compute forecast/i })[0]!);
    expect(runForecast).toHaveBeenCalled();
  });

  it('with a run it draws the site, says why the next weeks are what they are, and lists the scoring', async () => {
    vi.mocked(listForecastSites).mockResolvedValue(sitesWithRun);
    vi.mocked(getSiteForecast).mockResolvedValue(detail);
    renderPage();
    expect(await screen.findByText('Front Beach 218: hours by week')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /site/i })).toHaveValue('l1');
    // The summary strip: the next four weeks from the horizon, the back-test error, the history.
    expect(screen.getByText('2,058 h')).toBeInTheDocument(); // 648 + 690 + 720
    expect(screen.getByText('8.4%')).toBeInTheDocument();
    expect(screen.getByText('52 wk')).toBeInTheDocument();
    // The drivers in words.
    expect(screen.getByText(/Independence Day ×1\.08/)).toBeInTheDocument();
    expect(screen.getByText(/Truck schedule ×1\.20 \(Client truck schedule\)/)).toBeInTheDocument();
    // The scoring table.
    expect(screen.getByText('3.8%')).toBeInTheDocument();
    // The weights, said plainly.
    expect(screen.getByText(/Last year weighs 50%/)).toBeInTheDocument();
  });

  it('a read-only role sees the forecast and no compute, signals or plan actions', async () => {
    vi.mocked(listForecastSites).mockResolvedValue(sitesWithRun);
    vi.mocked(getSiteForecast).mockResolvedValue(detail);
    renderPage('EXECUTIVE_CHAIRMAN');
    expect(await screen.findByText('Front Beach 218: hours by week')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recompute/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start a season plan/i })).not.toBeInTheDocument();
  });
});
