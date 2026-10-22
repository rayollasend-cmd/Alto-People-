import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReliabilityResponse } from '@alto-people/shared';

vi.mock('@/lib/reliabilityApi', () => ({ getReliability: vi.fn() }));
vi.mock('@/lib/scheduledJobsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/scheduledJobsApi')>()),
  listScheduledJobs: vi.fn(),
  runScheduledJob: vi.fn(),
}));

import { getReliability } from '@/lib/reliabilityApi';
import { listScheduledJobs, runScheduledJob, type ScheduledJob } from '@/lib/scheduledJobsApi';
import { ReliabilityHome } from '@/pages/analytics/ReliabilityHome';
import { AuthContext } from '@/lib/auth';

/**
 * The reliability page: one hero (errors against the budget) and the
 * other three measures under it. The thing to guard is honesty — without
 * Sentry it must say "not connected", never show a zero as a verdict.
 */

const week = (over: Partial<ReliabilityResponse['errors']['weeks'][number]>): ReliabilityResponse['errors']['weeks'][number] => ({
  weekStart: '2026-06-27T04:00:00.000Z',
  weekEnd: '2026-07-04T04:00:00.000Z',
  sentryErrors: 3,
  serverErrors: 1,
  requests: 5000,
  underBudget: true,
  current: false,
  ...over,
});

function response(over: Partial<ReliabilityResponse> = {}): ReliabilityResponse {
  return {
    days: 7,
    budget: 10,
    sentry: { configured: true, issues: [] },
    errors: {
      thisWeek: 4,
      serverErrorsThisWeek: 2,
      weeks: [week({}), week({ weekStart: '2026-07-04T04:00:00.000Z', weekEnd: '2026-07-11T04:00:00.000Z', sentryErrors: 4, underBudget: null, current: true })],
      consecutiveWeeksUnderBudget: 3,
    },
    routes: {
      busiest: [{ method: 'GET', route: '/time/me', requests: 1200, serverError: 0, avgMs: 90, p95Ms: 300 }],
      slowest: [{ method: 'GET', route: '/rides/:id', requests: 40, serverError: 1, avgMs: 900, p95Ms: 2500 }],
    },
    kiosk: { total: 400, accepted: 388, rejected: 12, rate: 0.97, series: [] },
    rides: { total: 60, completed: 57, noShow: 2, unresolved: 1, rate: 0.95 },
    restarts: { count: 1, lastBootAt: '2026-07-06T09:00:00.000Z', version: 'abc' },
    ...over,
  };
}

function renderPage() {
  // The page reads the signed-in person and the tenant (the operator's incident panel).
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'ops@example.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE' },
          loading: false,
          can: () => true,
          tenant: { id: 'tenant-1', businessModel: 'WORKFORCE_PROVIDER', modules: {}, terminology: {} },
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ReliabilityHome />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

const job = (over: Partial<ScheduledJob>): ScheduledJob => ({
  name: 'shiftReminder',
  label: 'Shift reminders (day before, confirm asks, no-shows)',
  intervalSeconds: 1800,
  armed: true,
  running: false,
  runs: 4,
  failures: 0,
  lastStartedAt: '2026-10-21T10:00:00.000Z',
  lastFinishedAt: '2026-10-21T10:00:02.000Z',
  lastOkAt: '2026-10-21T10:00:02.000Z',
  lastDurationMs: 2000,
  lastError: null,
  nextRunAt: '2026-10-21T10:30:00.000Z',
  note: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(getReliability).mockReset();
  vi.mocked(listScheduledJobs).mockReset();
  vi.mocked(runScheduledJob).mockReset();
  vi.mocked(listScheduledJobs).mockResolvedValue({ jobs: [], now: '2026-10-21T10:05:00.000Z' });
});

describe('scheduled jobs', () => {
  it('lists each job with its state, cadence and next run, and says when a job is off or failing', async () => {
    vi.mocked(getReliability).mockResolvedValue(response());
    vi.mocked(listScheduledJobs).mockResolvedValue({
      now: '2026-10-21T10:05:00.000Z',
      jobs: [
        job({}),
        job({ name: 'scheduleDigest', label: 'Schedule digest to admins (daily)', intervalSeconds: 0, armed: false, nextRunAt: null }),
        job({ name: 'auditChainCheck', label: 'Audit hash-chain verification (nightly)', intervalSeconds: 86400, lastError: 'db down', failures: 1 }),
      ],
    });
    renderPage();
    expect((await screen.findAllByText('Shift reminders (day before, confirm asks, no-shows)')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Every 30 min').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Last run failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('db down').length).toBeGreaterThan(0);
    expect(screen.getByText(/1 failing\. 1 off\./)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Run .* now/ }).length).toBe(3);
  });
});

describe('ReliabilityHome', () => {
  it('shows this week against the budget, the streak, and the other three measures', async () => {
    vi.mocked(getReliability).mockResolvedValue(response());
    renderPage();
    expect(await screen.findByText('Within budget')).toBeInTheDocument();
    expect(screen.getByText('In Sentry so far')).toBeInTheDocument();
    expect(screen.getByText('5 more to the exit')).toBeInTheDocument();
    // The slowest busy route leads with its p95, not its mean (the same
    // figure also sits in the slowest-routes table below).
    expect(screen.getAllByText('2.5 s').length).toBeGreaterThan(0);
    expect(screen.queryByText('900 ms')).toBeInTheDocument();
    expect(screen.getByText('p95 · GET /rides/:id')).toBeInTheDocument();
    expect(screen.getByText('97%')).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('57 of 60 · 2 no-show · 1 never closed')).toBeInTheDocument();
    expect(getReliability).toHaveBeenCalledWith(7);
  });

  it('says Sentry is not connected rather than showing zero errors', async () => {
    vi.mocked(getReliability).mockResolvedValue(
      response({
        sentry: { configured: false, issues: [] },
        errors: { thisWeek: null, serverErrorsThisWeek: 2, weeks: [week({ sentryErrors: null, underBudget: null })], consecutiveWeeksUnderBudget: null },
      }),
    );
    renderPage();
    expect((await screen.findAllByText('Sentry is not connected')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Within budget')).not.toBeInTheDocument();
    expect(screen.queryByText('Over budget')).not.toBeInTheDocument();
    expect(screen.getByText('Server errors this week')).toBeInTheDocument();
  });

  it('calls the week over budget when it is', async () => {
    vi.mocked(getReliability).mockResolvedValue(response({ errors: { ...response().errors, thisWeek: 14 } }));
    renderPage();
    expect(await screen.findByText('Over budget')).toBeInTheDocument();
  });
});
