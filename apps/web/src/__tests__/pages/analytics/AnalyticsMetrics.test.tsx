import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { METRICS } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * Analytics names every number by the metric dictionary (packages/shared
 * metrics.ts, deep audit 2026-10-29): "Margin after wages" — not the
 * executive "Gross margin", which also takes out burden and overhead —
 * "Billed at contract rates", the company week's "Hours this week", and
 * "Open shifts" as published-and-unassigned.
 */

vi.mock('@/lib/useViewport', async (orig) => ({ ...(await orig<typeof import('@/lib/useViewport')>()), useMediaQuery: () => false }));
const getDashboardKPIs = vi.fn();
vi.mock('@/lib/analyticsApi', () => ({ getDashboardKPIs: (...a: unknown[]) => getDashboardKPIs(...a) }));
const apiFetch = vi.fn();
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { AnalyticsHome as AnalyticsMetricsPage } from '@/pages/analytics/AnalyticsHome';

const kpis = {
  activeAssociates: 36,
  onTheBooks: 1245,
  activeWindowDays: 14,
  openShiftsNext30d: 1,
  associatesClockedIn: 12,
  pendingOnboardingApplications: 2,
  pendingI9Section2: 0,
  pendingDocumentReviews: 0,
  netPaidLast30d: 1000,
  netPendingDisbursement: 0,
  applicationStatusCounts: {},
  windowDays: 30,
  trends: { hoursWorked: { series: [500, 520, 1065.1, 537.2], delta: 545 }, shiftsScheduled: { series: [100, 110, 4885, 12], delta: 4775 } },
  week: { start: '2026-10-24', end: '2026-10-30', timezone: 'America/New_York', paidHours: 537.2, scheduledHours: 741 },
};
const week = (i: number, revenue: number, wages: number) => ({
  weekStart: `2026-10-${String(3 + i * 7).padStart(2, '0')}`,
  weekEnd: `2026-10-${String(9 + i * 7).padStart(2, '0')}`,
  inProgress: false,
  hours: 1000,
  revenue,
  wages,
  margin: revenue - wages,
  marginPct: (revenue - wages) / revenue,
  unpricedHours: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  getDashboardKPIs.mockResolvedValue(kpis);
  apiFetch.mockImplementation(async (path: string) => {
    if (path === '/finance/overview') return { margin: { weeks: [week(0, 23_000, 16_200), week(1, 23_800, 16_660)] } };
    throw new Error(`unexpected ${path}`);
  });
});

describe('Analytics reads the metric dictionary', () => {
  it('names the people numbers and the shifts by the dictionary, with thousands separators', async () => {
    renderAs('HR_ADMINISTRATOR', <AnalyticsMetricsPage />, '/analytics');
    expect(await screen.findByText(METRICS.onTheBooks.label)).toBeInTheDocument();
    expect(screen.getByText('1,245')).toBeInTheDocument();
    expect(screen.getByText(`${METRICS.working.label} (14 days)`)).toBeInTheDocument();
    expect(screen.getByText(METRICS.onTheFloor.label)).toBeInTheDocument();
    expect(screen.getByText(`${METRICS.openShifts.label} (next 30 days)`)).toBeInTheDocument();
    expect(screen.getByText('4,885')).toBeInTheDocument();
    // The company week, named, with its scheduled hours and its dates — the ops home's number.
    expect(screen.getByText(`${METRICS.hoursThisWeek.label}: 537h of 741h scheduled · Oct 24 – 30, 2026`)).toBeInTheDocument();
  });

  it('calls the Finance home’s money "Billed at contract rates" and "Margin after wages" — never "Gross margin"', async () => {
    renderAs('FINANCE_ACCOUNTANT', <AnalyticsMetricsPage />, '/analytics');
    // The tile, and the chart table's column.
    expect((await screen.findAllByText(METRICS.marginAfterWages.label)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(METRICS.billedAtContractRates.label).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`${METRICS.marginAfterWages.label}, by week`).length).toBeGreaterThan(0);
    expect(screen.getByText('Last week, Oct 10 – 16, 2026')).toBeInTheDocument();
    expect(screen.getAllByText('30%').length).toBeGreaterThan(0);
    expect(screen.queryByText(/gross margin ·/i)).toBeNull();
    expect(screen.queryByText(/^Revenue · /)).toBeNull();
    // The section says how it differs from the executive figure.
    expect(screen.getByText(METRICS.marginAfterWages.definition)).toBeInTheDocument();
  });
});

