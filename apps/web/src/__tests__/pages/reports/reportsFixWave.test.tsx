import { StrictMode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { METRICS } from '@alto-people/shared';
import { ConfirmProvider } from '@/lib/confirm';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), message: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', async (orig) => ({ ...(await orig<typeof import('sonner')>()), toast: toastMock }));
vi.mock('@/lib/reports96Api', () => ({
  listReports: vi.fn(),
  getReport: vi.fn(),
  createReport: vi.fn(),
  updateReport: vi.fn(),
  deleteReport: vi.fn(),
  runReport: vi.fn(),
  previewReport: vi.fn(),
  listColumns: vi.fn(),
  listSchedules: vi.fn(),
  createSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
}));
vi.mock('@/components/ui/AssociatePicker', () => ({ AssociatePicker: () => null }));

import { listColumns, listReports, previewReport } from '@/lib/reports96Api';
import { ReportsHome } from '@/pages/reports/ReportsHome';
import { cohortLegendSorter } from '@/pages/reports/PeopleAnalytics.plot';

/**
 * Deep-audit fix wave (2026-10-29), the report builder:
 *  - LEAD-14: in React.StrictMode (dev) every template opened empty — the
 *    entity-reset effect behind a `firstRun` ref ran on StrictMode's second
 *    mount and wiped the seed, so Preview said "Pick at least one column to
 *    group by". The reset is now the entity picker's own job.
 *  - LEAD-9 / PEOPLE-23: the people columns read in the dictionary's words —
 *    `active` is "Working", not account status.
 *  - LEAD-31: the first-90-days legend keeps the cohorts' calendar order.
 */

function renderStrict() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ConfirmProvider>
            <ReportsHome />
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listReports).mockResolvedValue({ reports: [] });
  vi.mocked(listColumns).mockResolvedValue({ entity: 'ASSOCIATE', columns: ['id', 'firstName', 'lastName', 'store', 'client', 'active', 'workStatus', 'onTheBooks', 'placed'] });
  vi.mocked(previewReport).mockResolvedValue({
    entity: 'ASSOCIATE',
    columns: ['store', 'count'],
    rows: [{ store: 'Front Beach', count: 26 }, { store: 'Harbor', count: 10 }],
  });
});

describe('a report template under React.StrictMode (LEAD-14)', () => {
  it('opens with its columns, filter and group-by, and previews', async () => {
    const user = userEvent.setup();
    renderStrict();
    const gallery = await screen.findByRole('region', { name: 'Start from a template' });
    await user.click(within(gallery).getByRole('button', { name: /Headcount by/ }));

    const dialog = await screen.findByRole('dialog');
    // The seed survives StrictMode's mount → unmount → mount.
    await waitFor(() => expect(within(dialog).getByText('Columns (1 selected)')).toBeInTheDocument());
    const groupBy = within(dialog).getByRole('group', { name: 'Group by' });
    // `store` stays the group; the people column reads in the dictionary's word.
    expect(within(groupBy).getByRole('button', { name: 'store' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(groupBy).getByRole('button', { name: METRICS.working.label })).toHaveAttribute('title', METRICS.working.definition);

    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(previewReport).toHaveBeenCalledTimes(1));
    expect(toastMock.error).not.toHaveBeenCalled();
    const sent = vi.mocked(previewReport).mock.calls[0]![0];
    expect(sent.entity).toBe('ASSOCIATE');
    expect(sent.spec.groupBy).toEqual(['store']);
    expect(sent.spec.filters).toEqual([expect.objectContaining({ column: 'active', op: 'eq' })]);
  });

  it('still clears the builder when the person picks another entity', async () => {
    const user = userEvent.setup();
    renderStrict();
    const gallery = await screen.findByRole('region', { name: 'Start from a template' });
    await user.click(within(gallery).getByRole('button', { name: /Headcount by/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('Columns (1 selected)')).toBeInTheDocument());
    await user.selectOptions(within(dialog).getAllByRole('combobox')[0]!, 'PAYROLL_RUN');
    await waitFor(() => expect(within(dialog).getByText('Columns (0 selected)')).toBeInTheDocument());
  });
});

describe('the first-90-days legend (LEAD-31)', () => {
  it('orders the cohorts by month, not alphabetically, and names every one', () => {
    // Oldest first, as the API sends them; the alphabetical sort read Apr, Aug, Jun, Mar, Oct, Sep.
    const cohorts = ['Mar 2026', 'Apr 2026', 'Jun 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026'].map((m) => ({ month: m, dataKey: m }));
    const sorter = cohortLegendSorter(cohorts);
    const alphabetical = [...cohorts].sort((a, b) => a.dataKey.localeCompare(b.dataKey));
    const ordered = [...alphabetical].sort((a, b) => sorter({ dataKey: a.dataKey }) - sorter({ dataKey: b.dataKey }));
    expect(ordered.map((c) => c.dataKey)).toEqual(['Mar 2026', 'Apr 2026', 'Jun 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026']);
    // The sixth (oldest) month has a place in the order too — it used to be left off the legend.
    expect(sorter({ dataKey: 'Mar 2026' })).toBe(0);
  });
});
