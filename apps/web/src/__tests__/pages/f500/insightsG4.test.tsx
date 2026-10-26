import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * F500 G4 — the insights pages: Analytics keeps the operating KPIs (window
 * in the URL, changes in words, retention moved out), People analytics is
 * the one home for retention (closed sites folded, "On the books" named).
 */

vi.mock('@/lib/useViewport', async (orig) => ({ ...(await orig<typeof import('@/lib/useViewport')>()), useMediaQuery: () => false }));

const getDashboardKPIs = vi.fn();
const getRetention = vi.fn();
vi.mock('@/lib/analyticsApi', () => ({
  getDashboardKPIs: (...a: unknown[]) => getDashboardKPIs(...a),
  getRetention: (...a: unknown[]) => getRetention(...a),
}));
const getPeopleAnalytics = vi.fn();
vi.mock('@/lib/peopleAnalyticsApi', () => ({ getPeopleAnalytics: (...a: unknown[]) => getPeopleAnalytics(...a) }));
const listReports = vi.fn();
vi.mock('@/lib/reports96Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports96Api')>()),
  listReports: (...a: unknown[]) => listReports(...a),
}));
vi.mock('@/components/ui/AssociatePicker', () => ({ AssociatePicker: () => null }));
const pa = {
  getActiveUsers: vi.fn(),
  getTraffic: vi.fn(),
  getRouteUsage: vi.fn(),
  getAdoption: vi.fn(),
  getWebVitals: vi.fn(),
  getProductEvents: vi.fn(),
};
vi.mock('@/lib/productAnalyticsApi', () => ({
  getActiveUsers: (...a: unknown[]) => pa.getActiveUsers(...a),
  getTraffic: (...a: unknown[]) => pa.getTraffic(...a),
  getRouteUsage: (...a: unknown[]) => pa.getRouteUsage(...a),
  getAdoption: (...a: unknown[]) => pa.getAdoption(...a),
  getWebVitals: (...a: unknown[]) => pa.getWebVitals(...a),
  getProductEvents: (...a: unknown[]) => pa.getProductEvents(...a),
}));
const listBonusPayouts = vi.fn();
vi.mock('@/lib/marketingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/marketingApi')>()),
  listBonusPayouts: (...a: unknown[]) => listBonusPayouts(...a),
}));

import { AnalyticsHome } from '@/pages/analytics/AnalyticsHome';
import { PeopleAnalytics } from '@/pages/reports/PeopleAnalytics';
import { ReferralBonusDesk } from '@/pages/marketing/ReferralBonusDesk';
import { ReportsHome } from '@/pages/reports/ReportsHome';
import { ProductAnalytics } from '@/pages/analytics/ProductAnalytics';

const kpis = (o: Record<string, unknown> = {}) => ({
  activeAssociates: 4,
  onTheBooks: 22,
  activeWindowDays: 30,
  openShiftsNext30d: 3,
  associatesClockedIn: 1,
  pendingOnboardingApplications: 2,
  pendingI9Section2: 0,
  pendingDocumentReviews: 0,
  netPaidLast30d: 1000,
  netPendingDisbursement: 0,
  applicationStatusCounts: {},
  windowDays: 30,
  trends: { hoursWorked: { series: [10, 20, 40, 5], delta: 20 }, applications: { series: [1, 4, 1, 0], delta: -3 } },
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  getDashboardKPIs.mockImplementation(async (days: number) => kpis({ windowDays: days }));
});

describe('Analytics', () => {
  it('reads the window from ?days= and writes it back when changed', async () => {
    renderAs('HR_ADMINISTRATOR', <AnalyticsHome />, '/analytics?days=7');
    expect(await screen.findByText('Open shifts (next 7 days)')).toBeInTheDocument();
    expect(getDashboardKPIs).toHaveBeenCalledWith(7);
    await userEvent.click(screen.getByRole('radio', { name: '90 days' }));
    await waitFor(() => expect(getDashboardKPIs).toHaveBeenCalledWith(90));
    expect(await screen.findByText('Open shifts (next 90 days)')).toBeInTheDocument();
  });

  it('shows the two named people numbers, changes in words, and links retention to People analytics', async () => {
    renderAs('HR_ADMINISTRATOR', <AnalyticsHome />, '/analytics');
    expect(await screen.findByText('On the books')).toBeInTheDocument();
    expect(screen.getByText('Working (30 days)')).toBeInTheDocument();
    // Hours: last complete week 40h against 20h the week before — in words, no undated sparkline.
    expect(screen.getByText('40h')).toBeInTheDocument();
    expect(screen.getAllByText(/vs the week before/).length).toBeGreaterThan(0);
    // No repeated "View details" line under every tile: the whole tile is the link.
    expect(screen.queryByText(/view details/i)).toBeNull();
    // Retention lives on People analytics now; this page links there and never loads it.
    expect(screen.getByRole('link', { name: /People analytics/ })).toHaveAttribute('href', '/reports/people');
    expect(screen.queryByText('Monthly turnover')).toBeNull();
    expect(getRetention).not.toHaveBeenCalled();
  });
});

const analytics = (o: Record<string, unknown> = {}) => ({
  months: 12,
  since: '2025-11-01',
  headcount: [
    { month: '2026-09', headcount: 10, hires: 3, separations: 1, voluntary: 1, involuntary: 0 },
    { month: '2026-10', headcount: 12, hires: 2, separations: 0, voluntary: 0, involuntary: 0 },
  ],
  turnover: {
    annualizedPct: 20,
    separations: 1,
    averageHeadcount: 11,
    byTenure: [{ label: 'Under 90 days', headcount: 0, separations: 0, annualizedTurnoverPct: null }],
    bySite: [
      { key: 's1', label: 'Coastal · Front Beach', headcount: 8, separations: 1, annualizedTurnoverPct: 12 },
      { key: 'inactive', label: 'Inactive sites', headcount: 8, separations: 0, annualizedTurnoverPct: 0, inactive: true, siteCount: 8 },
    ],
    byManager: [],
  },
  cohorts: [],
  timeToFill: { filled: 0, medianDays: null, averageDays: null, byDepartment: [], byClient: [], byPosition: [] },
  absence: { scheduledShiftDays: 0, absenceDays: 0, absenceRatePct: null, byCategory: [] },
  headcountByStore: [],
  turnoverGrid: {
    bands: [{ key: 'week1', label: 'First week' }, { key: 'weeks2to4', label: 'Weeks 2–4' }, { key: 'months2to3', label: 'Months 2–3' }, { key: 'later', label: '3 months and more' }],
    rows: [
      { storeId: 's1', storeName: 'Front Beach', clientName: 'Coastal', hires: 3, separations: 1, bands: [1, 0, 0, 0] },
      { storeId: 'inactive', storeName: 'Inactive sites', clientName: null, inactive: true, siteCount: 8, hires: 8, separations: 0, bands: [0, 0, 0, 0] },
    ],
  },
  // A cohort too young to have reached any milestone: nothing to draw.
  survival: [{ month: '2026-10', hires: 2, points: [{ day: 0, pct: null }, { day: 7, pct: null }] }],
  absenceTrend: [{ month: '2026-10', absenceDays: 0, scheduledShiftDays: 0, absenceRatePct: null }],
  ...o,
});

describe('People analytics', () => {
  it('folds closed sites into one row, names headcount "On the books", and empties charts with nothing to draw', async () => {
    getPeopleAnalytics.mockResolvedValue(analytics());
    renderAs('HR_ADMINISTRATOR', <PeopleAnalytics />, '/reports/people');
    expect(await screen.findByRole('img', { name: /On the books went from 10 to 12/ })).toBeInTheDocument();
    const grid = screen.getByRole('table', { name: /separations by store and tenure/i });
    expect(within(grid).getByText('Inactive stores (8)')).toBeInTheDocument();
    expect(within(grid).queryByText('Inactive sites')).toBeNull();
    // "Client · Site" for the turnover table, the closed sites once.
    expect(screen.getAllByText('Coastal · Front Beach').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Inactive stores (8)').length).toBeGreaterThan(0);
    // No cohort has reached a milestone, nobody in a tenure band, no shifts: one line each, not an empty axis.
    expect(screen.getAllByText('Nobody was hired in this window.')).toHaveLength(2); // first 90 days + hiring cohorts
    expect(screen.getByText('No one on the books or leaving in this window.')).toBeInTheDocument();
    expect(screen.getByText('No shifts or days off in this window.')).toBeInTheDocument();
  });

  it('keeps the window in the URL (?months=6) and links back to the report builder instead of a back button', async () => {
    getPeopleAnalytics.mockResolvedValue(analytics({ months: 6 }));
    renderAs('HR_ADMINISTRATOR', <PeopleAnalytics />, '/reports/people?months=6');
    await screen.findByRole('img', { name: /On the books went from/ });
    expect(getPeopleAnalytics).toHaveBeenCalledWith(6);
    expect(screen.getByRole('link', { name: 'Report builder' })).toHaveAttribute('href', '/reports');
    expect(screen.queryByRole('button', { name: /Report builder/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: '24 months' }));
    await waitFor(() => expect(getPeopleAnalytics).toHaveBeenCalledWith(24));
  });
});

describe('Referral bonuses', () => {
  const payout = (o: Record<string, unknown>) => ({
    id: 'b1', referralId: 'r1', campaignId: null, amount: 250, status: 'PROPOSED', referrerName: 'Ana Lopez', referrerEmail: 'ana@example.com',
    candidateName: 'Ben Ortiz', campaignName: null, note: null, decisionNote: null, decidedBy: null, decidedAt: null, payrollRunId: null,
    createdAt: '2026-10-01T12:00:00.000Z', ...o,
  });

  it('Finance (no marketing access) is trailed from Pay & finance, never to a Marketing page it cannot open', async () => {
    listBonusPayouts.mockResolvedValue({ payouts: [payout({})], draftRuns: [] });
    renderAs('FINANCE_ACCOUNTANT', <ReferralBonusDesk />, '/marketing/bonuses');
    expect(await screen.findByRole('link', { name: 'Pay & finance' })).toHaveAttribute('href', '/payroll');
    expect(screen.queryByRole('link', { name: 'Marketing' })).toBeNull();
  });

  it('with nothing proposed, one empty state and the year\'s totals — no "Pick a bonus" pane', async () => {
    listBonusPayouts.mockResolvedValue({ payouts: [], draftRuns: [] });
    renderAs('FINANCE_ACCOUNTANT', <ReferralBonusDesk />, '/marketing/bonuses');
    expect(await screen.findByText('No referral bonus proposed yet')).toBeInTheDocument();
    expect(screen.queryByText('Pick a bonus')).toBeNull();
    expect(screen.getByText('To decide')).toBeInTheDocument();
    expect(screen.getByText('$0.00 · 0 bonuses')).toBeInTheDocument();
  });

  it('sums this year\'s approvals in the header', async () => {
    const thisYear = new Date().getFullYear();
    listBonusPayouts.mockResolvedValue({
      payouts: [
        payout({ id: 'b1' }),
        payout({ id: 'b2', status: 'APPROVED', amount: 100, decidedAt: `${thisYear}-03-01T12:00:00.000Z` }),
        payout({ id: 'b3', status: 'APPROVED', amount: 150, decidedAt: `${thisYear}-04-01T12:00:00.000Z` }),
        payout({ id: 'b4', status: 'APPROVED', amount: 999, decidedAt: `${thisYear - 1}-12-01T12:00:00.000Z` }),
      ],
      draftRuns: [],
    });
    renderAs('FINANCE_ACCOUNTANT', <ReferralBonusDesk />, '/marketing/bonuses');
    expect(await screen.findByText('$250.00 · 2 bonuses')).toBeInTheDocument();
  });
});

describe('Reports', () => {
  const report = (o: Record<string, unknown>) => ({
    id: 'r1', name: 'New hires', description: null, entity: 'ASSOCIATE', isPublic: true, period: null, createdAt: '2026-09-01T12:00:00.000Z',
    ownerName: 'Hana Reyes', mine: false, lastRunAt: '2026-10-20T15:30:00.000Z', scheduleCount: 1, cadences: ['WEEKLY'], ...o,
  });

  it('puts saved reports first with owner, last run and schedule; templates fold under them', async () => {
    listReports.mockResolvedValue({ reports: [report({}), report({ id: 'r2', name: 'Pay changes', entity: 'PAY_CHANGE', mine: true, lastRunAt: null, scheduleCount: 0, cadences: [] })] });
    renderAs('HR_ADMINISTRATOR', <ReportsHome />, '/reports');
    const grid = await screen.findByRole('table', { name: /Saved reports/ });
    expect(within(grid).getByText('Hana Reyes')).toBeInTheDocument();
    expect(within(grid).getByText('You')).toBeInTheDocument();
    expect(within(grid).getByText('Not run yet')).toBeInTheDocument();
    expect(within(grid).getByRole('button', { name: 'Weekly' })).toBeInTheDocument();
    expect(within(grid).getByText('None')).toBeInTheDocument();
    // The template gallery is a closed disclosure after the list.
    const details = screen.getByText('Start from a template').closest('details')!;
    expect(details.open).toBe(false);
    expect(grid.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // People analytics is a sibling page: a link, not a button.
    expect(screen.getByRole('link', { name: 'People analytics' })).toHaveAttribute('href', '/reports/people');
  });

  it('reads the entity filter from ?entity=', async () => {
    listReports.mockResolvedValue({ reports: [report({}), report({ id: 'r2', name: 'Pay changes', entity: 'PAY_CHANGE' })] });
    renderAs('HR_ADMINISTRATOR', <ReportsHome />, '/reports?entity=PAY_CHANGE');
    const grid = await screen.findByRole('table', { name: /Saved reports/ });
    expect(within(grid).getByText('Pay changes')).toBeInTheDocument();
    expect(within(grid).queryByText('New hires')).toBeNull();
  });

  it('with nothing saved, the templates lead (open) above the empty state', async () => {
    listReports.mockResolvedValue({ reports: [] });
    renderAs('HR_ADMINISTRATOR', <ReportsHome />, '/reports');
    expect(await screen.findByText('No saved reports')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Start from a template' })).toBeInTheDocument();
    expect(screen.getByText('Start from a template', { selector: 'h2,h3,div,span,p' }).closest('details')).toBeNull();
  });
});

describe('Product usage', () => {
  beforeEach(() => {
    pa.getActiveUsers.mockResolvedValue({ dau: 3, wau: 5, mau: 5, stickiness: 1, series: [] });
    pa.getTraffic.mockResolvedValue({ series: [] });
    pa.getRouteUsage.mockResolvedValue({ busiest: [], failing: [] });
    pa.getAdoption.mockResolvedValue({ neverSignedIn: 0, dormant30d: 0, funnel: { created: 4, activated: 0, activationRate: 0 }, signups: [], activeByRole: [{ role: 'HR_ADMINISTRATOR', users: 2 }, { role: 'CLIENT_PORTAL', users: 1 }] });
    pa.getWebVitals.mockResolvedValue({ metrics: [{ metric: 'LCP', p75: 400, rating: 'good', samples: 12 }], routes: [] });
    pa.getProductEvents.mockResolvedValue({ firstDecision: { avgMs: null, sessions: 0 }, decisionsPerSession: [{ role: 'HR_ADMINISTRATOR', sessions: 3, decisions: 0, perSession: 0 }], settingsSearches: { count: 0, sessions: 3, perHundredSessions: 0 } });
  });

  it('has its own heading, reads ?days=, names roles properly, and rounds what is bucketed or tiny', async () => {
    renderAs('HR_ADMINISTRATOR', <ProductAnalytics />, '/product-analytics?days=7');
    expect(await screen.findByRole('heading', { level: 1, name: 'Product usage' })).toBeInTheDocument();
    expect(pa.getActiveUsers).toHaveBeenCalledWith(7);
    expect(await screen.findByText('HR administrator')).toBeInTheDocument();
    expect(screen.getByText('Client portal')).toBeInTheDocument();
    // Whole percentages; a bucketed vital reads as "at or under".
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(await screen.findByText('≤400 ms')).toBeInTheDocument();
    // Nothing decided and nothing searched: one line, not a table of zeros.
    expect(screen.getByText('Do people find what they came for?')).toBeInTheDocument();
    expect(screen.getByText('No decisions or settings searches recorded in this window yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /Decisions a session by role/ })).toBeNull();
  });
});
