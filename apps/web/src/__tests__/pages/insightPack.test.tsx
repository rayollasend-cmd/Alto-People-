import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';

vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/useViewport', async (orig) => ({ ...(await orig<typeof import('@/lib/useViewport')>()), useMediaQuery: () => false }));

const getExpirationRisk = vi.fn();
const getExpirations = vi.fn();
vi.mock('@/lib/expirations113Api', () => ({
  getExpirationRisk: (...a: unknown[]) => getExpirationRisk(...a),
  getExpirations: (...a: unknown[]) => getExpirations(...a),
}));
vi.mock('@/lib/qualApi', () => ({ grantAssociateQual: vi.fn() }));
vi.mock('@/pages/transport/TransportDesk', () => ({ TransportExpiringSection: () => null }));

const getPeopleAnalytics = vi.fn();
vi.mock('@/lib/peopleAnalyticsApi', () => ({ getPeopleAnalytics: (...a: unknown[]) => getPeopleAnalytics(...a) }));

const apiFetch = vi.fn();
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const getHeadcountPlan = vi.fn();
vi.mock('@/lib/positionsApi', () => ({ getHeadcountPlan: (...a: unknown[]) => getHeadcountPlan(...a) }));

import { ExpirationsHome } from '@/pages/expirations/ExpirationsHome';
import { PeopleAnalytics } from '@/pages/reports/PeopleAnalytics';
import { HeadcountPlan } from '@/pages/headcount/HeadcountPlan';

const item = (o: Record<string, unknown>) => ({
  id: 'q1',
  associateId: 'a1',
  associateName: 'Ana Lopez',
  associateEmail: 'ana@example.com',
  qualificationId: 'food',
  qualificationCode: 'FOOD',
  qualificationName: 'Food handler',
  isCert: true,
  expiresAt: '2026-10-22',
  daysUntilExpiry: 5,
  storeId: 's1',
  storeName: 'Front Beach',
  clientId: 'c1',
  clientName: 'Coastal',
  nextShift: null,
  blockingShift: null,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  getExpirationRisk.mockResolvedValue({
    asOf: '2026-10-17T12:00:00.000Z',
    days: 90,
    truncated: false,
    items: [
      item({ blockingShift: { id: 'sh1', startsAt: '2026-10-27T13:00:00.000Z', storeId: 's1', storeName: 'Front Beach', position: 'Cook', requiredBy: 'shift' } }),
      item({ id: 'q2', associateId: 'a2', associateName: 'Ben Ortiz', qualificationId: 'fork', qualificationName: 'Forklift', storeId: 's2', storeName: 'Back Bay', expiresAt: '2026-10-29', daysUntilExpiry: 12 }),
    ],
    atRisk: ['q1'],
    weeks: ['2026-10-17', '2026-10-24', '2026-10-31'],
    timeline: [],
    filters: {
      clients: [{ id: 'c1', name: 'Coastal' }],
      stores: [
        { id: 's1', name: 'Front Beach', clientId: 'c1' },
        { id: 's2', name: 'Back Bay', clientId: 'c1' },
      ],
      qualifications: [
        { id: 'food', name: 'Food handler' },
        { id: 'fork', name: 'Forklift' },
      ],
    },
  });
  getExpirations.mockResolvedValue({ days: 60, counts: { expired: 0, dueSoon: 0, dueLater: 0 }, expired: [], dueSoon: [], dueLater: [] });
});

describe('Expirations', () => {
  it('opens on what blocks a shift, says what requires it, and filters by store', async () => {
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations');
    const list = await screen.findByRole('list', { name: /lapses that block a scheduled shift/i });
    expect(within(list).getByText('Ana Lopez')).toBeInTheDocument();
    expect(within(list).getByText(/Required on this shift/)).toBeInTheDocument();
    expect(screen.getByText(/1 lapse blocks a scheduled shift/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Store'), 's2');
    expect(await screen.findByText('Nobody’s shifts are at risk')).toBeInTheDocument();
  });

  it('the timeline: weeks across, stores down; a cell opens who; the chart has its table', async () => {
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations?view=timeline');
    const cell = await screen.findByRole('button', { name: /1 lapsing at Back Bay the week of/i });
    await userEvent.click(cell);
    expect(await screen.findByText(/1 at Back Bay/)).toBeInTheDocument();
    // The chart frame: Table switches the picture for its numbers.
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    // The button now names the view it switches back to.
    expect(screen.getByRole('button', { name: 'Chart' })).toBeInTheDocument();
  });

  it('the full list is still one click away', async () => {
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations?view=list');
    expect(await screen.findByText('Nothing expired.')).toBeInTheDocument();
    expect(getExpirations).toHaveBeenCalled();
  });
});

describe('People analytics', () => {
  it('draws the trend with its table, and the early-leaver grid by store', async () => {
    getPeopleAnalytics.mockResolvedValue({
      months: 12,
      since: '2025-11-01',
      headcount: [
        { month: '2026-09', headcount: 10, hires: 3, separations: 1, voluntary: 1, involuntary: 0 },
        { month: '2026-10', headcount: 12, hires: 2, separations: 0, voluntary: 0, involuntary: 0 },
      ],
      turnover: { annualizedPct: 20, separations: 1, averageHeadcount: 11, byTenure: [{ label: 'Under 90 days', headcount: 5, separations: 1, annualizedTurnoverPct: 40 }], bySite: [], byManager: [] },
      cohorts: [],
      timeToFill: { filled: 0, medianDays: null, averageDays: null, byDepartment: [], byClient: [], byPosition: [] },
      absence: { scheduledShiftDays: 100, absenceDays: 4, absenceRatePct: 3.8, byCategory: [] },
      headcountByStore: [],
      turnoverGrid: { bands: [{ key: 'week1', label: 'First week' }, { key: 'weeks2to4', label: 'Weeks 2–4' }, { key: 'months2to3', label: 'Months 2–3' }, { key: 'later', label: '3 months and more' }], rows: [{ storeId: 's1', storeName: 'Front Beach', clientName: 'Coastal', hires: 3, separations: 1, bands: [1, 0, 0, 0] }] },
      survival: [],
      absenceTrend: [{ month: '2026-09', absenceDays: 2, scheduledShiftDays: 50, absenceRatePct: 3.8 }],
    });
    renderAs('HR_ADMINISTRATOR', <PeopleAnalytics />, '/reports/people');
    expect(await screen.findByRole('img', { name: /Headcount went from 10 to 12/ })).toBeInTheDocument();
    const grid = screen.getByRole('table', { name: /separations by store and tenure/i });
    expect(within(grid).getByText('Front Beach')).toBeInTheDocument();
    // Every chart's numbers are in the page for a screen reader.
    expect(screen.getAllByRole('table', { name: 'Headcount, month by month', hidden: true }).length).toBeGreaterThan(0);
  });
});

describe('Headcount plan', () => {
  it('leads with staffing: required against in place, gaps called out; office seats on the second tab', async () => {
    apiFetch.mockImplementation((path: string) =>
      path.startsWith('/headcount/staffing-plan')
        ? Promise.resolve({
            weeks: ['2026-10-17', '2026-10-24'],
            stores: [
              {
                storeId: 's1',
                storeName: 'Front Beach',
                clientId: 'c1',
                clientName: 'Coastal',
                placed: 2,
                weeks: [
                  { week: '2026-10-17', required: 16, placed: 2, scheduled: 2, gap: 14, hours: 560, budget: 14000, source: 'targets' },
                  { week: '2026-10-24', required: 2, placed: 2, scheduled: 1, gap: 0, hours: 70, budget: 1750, source: 'targets' },
                ],
              },
            ],
            totals: [
              { week: '2026-10-17', required: 16, placed: 2, scheduled: 2, gap: 14, budget: 14000 },
              { week: '2026-10-24', required: 2, placed: 2, scheduled: 1, gap: 0, budget: 1750 },
            ],
            priced: 1,
          })
        : Promise.resolve({}),
    );
    getHeadcountPlan.mockResolvedValue({ year: 2026, positions: [], departments: [], totals: { positions: 0, filled: 0, budget: 0, projected: 0, paidYearToDate: 0, unbudgeted: 0, variance: 0 } });
    renderAs('HR_ADMINISTRATOR', <HeadcountPlan />, '/headcount/plan');
    expect(await screen.findByLabelText(/Front Beach, week of .*16 required, 14 short/)).toBeInTheDocument();
    expect(screen.getByText('Staffing targets')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Office seats' }));
    await waitFor(() => expect(getHeadcountPlan).toHaveBeenCalled());
  });
});
