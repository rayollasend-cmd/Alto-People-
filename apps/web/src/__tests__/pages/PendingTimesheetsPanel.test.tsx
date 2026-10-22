import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The Approvals hub's inline timesheets (role walk floor 7, HR 16): clean
 * entries approve in one tap, flagged ones are listed with their reason,
 * the caller's own entries get no Approve, and nothing renders when the
 * count is zero so the hub can fold it.
 */

vi.mock('@/lib/timeApi', () => ({
  approveTimeEntry: vi.fn(async () => ({})),
  bulkApproveTimeEntries: vi.fn(async () => ({ succeeded: 2, failed: 0, results: [] })),
  countAdminTimeEntries: vi.fn(),
  listAdminTimeEntries: vi.fn(),
  rejectTimeEntry: vi.fn(async () => ({})),
}));

import { bulkApproveTimeEntries, countAdminTimeEntries, listAdminTimeEntries, rejectTimeEntry } from '@/lib/timeApi';
import { PendingTimesheetsPanel } from '@/pages/time/PendingTimesheetsPanel';
import { AuthContext } from '@/lib/auth';

const AT = new Date('2026-09-18T13:00:00.000Z');
const entry = (id: string, associateId: string, name: string, anomalies: string[] = []) => ({
  id,
  associateId,
  associateName: name,
  clientId: 'c1',
  clientName: 'Hotel',
  clockInAt: AT.toISOString(),
  clockOutAt: new Date(AT.getTime() + 8 * 3_600_000).toISOString(),
  status: 'COMPLETED',
  notes: null,
  rejectionReason: null,
  approvedById: null,
  approverEmail: null,
  approvedAt: null,
  minutesElapsed: 480,
  anomalies,
});

function renderPanel(associateId: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'dana@example.com', role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', clientId: 'c1', clientName: 'Hotel', associateId },
    role: 'SHIFT_SUPERVISOR',
    capabilities: new Set(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => true,
  } as never;
  render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <PendingTimesheetsPanel />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(countAdminTimeEntries).mockResolvedValue({ count: 4, oldestPendingAt: AT.toISOString(), byPeriod: [] });
  vi.mocked(listAdminTimeEntries).mockResolvedValue({
    entries: [
      entry('c1', 'a-maria', 'Maria Lopez'),
      entry('c2', 'a-jose', 'Jose Ruiz'),
      entry('f1', 'a-ana', 'Ana Diaz', ['FORGOT_CLOCKOUT']),
      entry('mine', 'a-dana', 'Dana Lead', ['FORGOT_CLOCKOUT']),
    ],
    truncated: false,
  } as never);
  vi.mocked(bulkApproveTimeEntries).mockClear();
  vi.mocked(rejectTimeEntry).mockClear();
});

describe('PendingTimesheetsPanel', () => {
  it('renders nothing when nothing is pending', async () => {
    vi.mocked(countAdminTimeEntries).mockResolvedValue({ count: 0, oldestPendingAt: null, byPeriod: [] });
    renderPanel();
    await waitFor(() => expect(vi.mocked(countAdminTimeEntries)).toHaveBeenCalled());
    expect(screen.queryByTestId('pending-timesheets-panel')).toBeNull();
  });

  it('approves the clean ones in one tap and lists the flagged ones with a reason', async () => {
    const user = renderPanel('a-dana');
    await screen.findByText('Ana Diaz');
    // The oldest-first list the panel asked for.
    expect(vi.mocked(listAdminTimeEntries).mock.calls[0]?.[0]).toMatchObject({ status: 'COMPLETED', order: 'asc' });
    expect(screen.getByText(/clean entries/).textContent).toMatch(/^2 clean entries/);
    // Flagged rows carry the reason; Dana's own row has no Approve.
    expect(screen.getAllByTestId('pending-flagged-row')).toHaveLength(2);
    expect(screen.getAllByText('Forgot clock-out').length).toBeGreaterThan(0);
    expect(screen.getByText('Yours — someone else approves it')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    // The queue link carries the window from the oldest pending day.
    const link = screen.getByRole('link', { name: /Open the queue/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toMatch(/^\/time-attendance\?tab=queue&status=COMPLETED&from=2026-09-18&to=\d{4}-\d{2}-\d{2}$/);
    await user.click(screen.getByRole('button', { name: 'Approve all' }));
    await waitFor(() => expect(vi.mocked(bulkApproveTimeEntries)).toHaveBeenCalledWith({ entryIds: ['c1', 'c2'] }));
  });

  it('rejecting a flagged row needs a reason', async () => {
    const user = renderPanel();
    await screen.findByText('Ana Diaz');
    await user.click(screen.getAllByRole('button', { name: 'Reject' })[0]!);
    const box = screen.getByLabelText('Rejection reason');
    await user.type(box, 'Clock out missing — re-submit');
    // The submit sits in the same row as the reason box.
    const row = box.closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(vi.mocked(rejectTimeEntry)).toHaveBeenCalledWith('f1', { reason: 'Clock out missing — re-submit' }));
  });
});
