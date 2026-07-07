import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/timeApi', () => ({
  adminCreateTimeEntry: vi.fn(),
  adminEditTimeEntry: vi.fn(),
  approveTimeEntry: vi.fn(),
  bulkApproveTimeEntries: vi.fn(),
  bulkRejectTimeEntries: vi.fn(),
  countAdminTimeEntries: vi.fn(async () => ({ count: 0 })),
  exportPayrollSheet: vi.fn(),
  exportTimeEntries: vi.fn(),
  exportTimeSummary: vi.fn(),
  getActiveDashboard: vi.fn(async () => ({ entries: [] })),
  listAdminTimeEntries: vi.fn(async () => ({ entries: [] })),
  listPayPeriods: vi.fn(),
  rejectTimeEntry: vi.fn(),
}));

vi.mock('@/lib/directoryApi', () => ({
  listDirectory: vi.fn(async () => ({ associates: [] })),
}));

vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn(async () => ({ clients: [] })),
  listClientLocations: vi.fn(async () => ({ locations: [] })),
}));

import { listAdminTimeEntries, listPayPeriods } from '@/lib/timeApi';
import { AdminTimeView } from '@/pages/time/AdminTimeView';

// Fixed windows from the MOCKED endpoint — the component only displays
// them, so nothing here rots as the calendar moves.
const PERIODS = [
  { start: '2026-06-29', end: '2026-07-05', current: true, hasRun: false },
  { start: '2026-06-22', end: '2026-06-28', current: false, hasRun: true },
];

function renderQueueTab() {
  render(
    <MemoryRouter>
      <AdminTimeView canManage />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  // The status filter persists; a leaked value would change which chips render.
  localStorage.clear();
  vi.mocked(listPayPeriods).mockResolvedValue({ periods: PERIODS });
  vi.mocked(listAdminTimeEntries).mockClear();
});

describe('<AdminTimeView> pay-period picker', () => {
  it('lists the server periods with current/paid markers', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText(/pay period/i);
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual([
      'Custom range',
      'Jun 29 – Jul 5 · current',
      'Jun 22 – Jun 28 · paid',
    ]);
  });

  it('choosing a period drives the From/To dates and refetches', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText(/pay period/i);
    const callsBefore = vi.mocked(listAdminTimeEntries).mock.calls.length;
    await user.selectOptions(select, '2026-06-22|2026-06-28');

    expect(screen.getByDisplayValue('2026-06-22')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-06-28')).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(listAdminTimeEntries).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('hand-editing a date drops back to Custom range', async () => {
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    const select = await screen.findByLabelText<HTMLSelectElement>(/pay period/i);
    await user.selectOptions(select, '2026-06-22|2026-06-28');
    expect(select.value).toBe('2026-06-22|2026-06-28');

    fireEvent.change(screen.getByDisplayValue('2026-06-22'), {
      target: { value: '2026-06-20' },
    });
    expect(select.value).toBe('');
    expect(screen.getByDisplayValue('2026-06-20')).toBeInTheDocument();
    // The chosen dates stay — dropping to custom must not reset the range.
    expect(screen.getByDisplayValue('2026-06-28')).toBeInTheDocument();
  });

  it('hides the picker when no periods exist (no schedule, no runs)', async () => {
    vi.mocked(listPayPeriods).mockResolvedValue({ periods: [] });
    const user = renderQueueTab();
    await user.click(await screen.findByRole('tab', { name: /approval queue/i }));

    await screen.findByRole('button', { name: /anomalies only/i }); // filter row rendered
    expect(screen.queryByLabelText(/pay period/i)).not.toBeInTheDocument();
  });
});
