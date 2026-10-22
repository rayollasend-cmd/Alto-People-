import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '@/lib/confirm';

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

import { createReport, listColumns, listReports, previewReport } from '@/lib/reports96Api';
import { ReportsHome } from '@/pages/reports/ReportsHome';

/**
 * The report builder can summarize: group rows by up to four columns and
 * put a count or a total beside each group. The spec it sends is the
 * server's (groupBy + aggregates with fn/column/alias), and the preview
 * shows the summary's own columns, not the list's.
 */

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConfirmProvider>
          <ReportsHome />
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listReports).mockResolvedValue({ reports: [] });
  vi.mocked(listColumns).mockResolvedValue({ entity: 'PAYROLL_ITEM', columns: ['id', 'runId', 'associateId', 'grossAmount', 'netAmount'] });
  vi.mocked(previewReport).mockResolvedValue({
    entity: 'PAYROLL_ITEM',
    columns: ['runId', 'count', 'sum_grossAmount'],
    rows: [{ runId: 'run-1', count: 12, sum_grossAmount: 4200.5 }],
  });
  vi.mocked(createReport).mockResolvedValue({ id: 'r1' });
});

describe('<ReportsHome> — summarize', () => {
  it('groups by a column, totals a number column, previews the summary and saves the grouped spec', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: /New report/ }))[0]!);

    const dialog = await screen.findByRole('dialog');
    // The builder's first field is the name, its first select the entity.
    await user.type(within(dialog).getAllByRole('textbox')[0]!, 'Gross by run');
    await user.selectOptions(within(dialog).getAllByRole('combobox')[0]!, 'PAYROLL_ITEM');

    // Off by default: a list of rows. On: group by + totals appear.
    expect(within(dialog).queryByRole('group', { name: 'Group by' })).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Summarize' }));
    const groupBy = within(dialog).getByRole('group', { name: 'Group by' });
    await user.click(within(groupBy).getByRole('button', { name: 'runId' }));
    expect(within(groupBy).getByRole('button', { name: 'runId' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(dialog).getByRole('button', { name: /Add total/ }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Total 1 function' }), 'sum');
    // Only number columns are offered for a total.
    const colSelect = within(dialog).getByRole('combobox', { name: 'Total 1 column' });
    expect(within(colSelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['grossAmount', 'netAmount']);

    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect(previewReport).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'PAYROLL_ITEM',
        spec: expect.objectContaining({
          groupBy: ['runId'],
          aggregates: [{ fn: 'sum', column: 'grossAmount', alias: null }],
          columns: ['runId'],
        }),
      }),
    );
    // The preview shows the summary's columns.
    const preview = await screen.findByRole('dialog', { name: /Gross by run \(preview\)/ });
    expect(within(preview).getByText('sum_grossAmount')).toBeInTheDocument();
    expect(within(preview).getByText('4200.5')).toBeInTheDocument();
    // The drawer's X and its footer button both read Close; the footer one is last.
    await user.click(within(preview).getAllByRole('button', { name: 'Close' }).at(-1)!);

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Gross by run', spec: expect.objectContaining({ groupBy: ['runId'] }) }),
    );
  });

  it('refuses a summary with nothing to group by', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: /New report/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Summarize' }));
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect(previewReport).not.toHaveBeenCalled();
  });
});

describe('<ReportsHome> — templates (HR walk 17)', () => {
  it('a template opens the builder pre-filled with its entity, name and summary', async () => {
    const user = userEvent.setup();
    vi.mocked(listColumns).mockResolvedValue({ entity: 'SEPARATION', columns: ['id', 'associateId', 'reason', 'status', 'lastDayWorked', 'finalPaycheckDate', 'createdAt'] });
    renderPage();
    const gallery = await screen.findByRole('region', { name: 'Start from a template' });
    expect(within(gallery).getAllByRole('button').length).toBeGreaterThanOrEqual(10);
    await user.click(within(gallery).getByRole('button', { name: /Terminations by reason/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByRole('textbox')[0]).toHaveValue('Terminations by reason, last quarter');
    expect(within(dialog).getAllByRole('combobox')[0]).toHaveValue('SEPARATION');
    expect(within(dialog).getByRole('checkbox', { name: 'Summarize' })).toBeChecked();
    // Nothing saved by opening a template.
    expect(createReport).not.toHaveBeenCalled();
  });
});
