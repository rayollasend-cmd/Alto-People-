import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com', associateId: null }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth, useTerm: () => (k: string) => (k === 'worker' ? 'Associate' : k) };
});
vi.mock('@/lib/timeOffApi', () => ({
  getTimeOffSummary: vi.fn(),
  listAdminRequests: vi.fn(),
  approveAdminRequest: vi.fn(),
  denyAdminRequest: vi.fn(),
  bulkDecideRequests: vi.fn(),
}));
vi.mock('@/pages/timeoff/TimeOffPoliciesView', () => ({ TimeOffPoliciesView: () => <div>Policies view</div> }));
vi.mock('@/pages/timeoff/AdminTimeOffEntitlementsView', () => ({ AdminTimeOffEntitlementsView: () => <div>Entitlements view</div> }));
vi.mock('@/pages/timeoff/AssociateTimeOffView', () => ({ AssociateTimeOffView: () => <div>Mine</div> }));

import { getTimeOffSummary, listAdminRequests } from '@/lib/timeOffApi';
import { TimeOffHome } from '@/pages/timeoff/TimeOffHome';
import { ConfirmProvider } from '@/lib/confirm';
import { stripDays } from '@/pages/timeoff/WhosOffStrip';

/**
 * F500 G2 — the manager's Time off: who is out (today, this week, waiting,
 * starting soon) above the tabs, a two-week "Who's off" strip, the empty
 * queue pointing to it, and the tab and status in the URL.
 */

let lastSearch = '';
function Spy() {
  lastSearch = useLocation().search;
  return null;
}

function renderHome(entry = '/time-off') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <ConfirmProvider>
          <TimeOffHome />
        </ConfirmProvider>
        <Spy />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getTimeOffSummary).mockResolvedValue({
    today: '2026-10-22',
    weekStart: '2026-10-17',
    weekEnd: '2026-10-23',
    horizonEnd: '2026-11-04',
    outToday: 2,
    outThisWeek: 3,
    pending: 0,
    upcoming: 1,
    whosOff: [
      { id: 'r1', associateId: 'a1', name: 'Ann Lee', category: 'VACATION', startDate: '2026-10-21', endDate: '2026-10-23' },
      { id: 'r2', associateId: 'a2', name: 'Ben Cruz', category: 'SICK', startDate: '2026-10-22', endDate: '2026-10-22' },
      { id: 'r3', associateId: 'a1', name: 'Ann Lee', category: 'PTO', startDate: '2026-10-30', endDate: '2026-10-30' },
    ],
  });
  vi.mocked(listAdminRequests).mockResolvedValue({ requests: [], total: 0 });
});

describe('<TimeOffHome> manager view (F500 G2)', () => {
  it('leads with who is out, from the summary', async () => {
    renderHome();
    expect(await screen.findByText('Out today')).toBeInTheDocument();
    const strip = screen.getByLabelText('Who is out');
    // The tiles count up; wait for the settled numbers.
    await waitFor(() => expect(strip).toHaveTextContent(/Out today\s*2/));
    await waitFor(() => expect(strip).toHaveTextContent(/Out this week\s*3/));
    expect(strip).toHaveTextContent('Oct 17 – Oct 23');
    expect(strip).toHaveTextContent('Nothing to decide');
  });

  it("draws one row per person in the two-week strip, with a count per day", async () => {
    renderHome();
    const table = await screen.findByTestId('whos-off');
    const rows = within(table).getAllByRole('row');
    // Header, Ann, Ben, and the "Out" foot.
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('Ann Lee');
    expect(rows[2]).toHaveTextContent('Ben Cruz');
    const foot = rows[3]!;
    const counts = within(foot).getAllByRole('cell').map((c) => c.textContent);
    // Oct 22: Ann + Ben; Oct 23: Ann; Oct 24…29: none; Oct 30: Ann.
    expect(counts.slice(0, 3)).toEqual(['2', '1', '0']);
    expect(counts[8]).toBe('1');
  });

  it('the empty queue points to who is off', async () => {
    renderHome();
    expect(await screen.findByText('Nothing to approve')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /See who's off this week/ })).toBeInTheDocument();
  });

  it('keeps the tab and the status in the URL', async () => {
    const user = userEvent.setup();
    renderHome('/time-off?status=APPROVED');
    await screen.findByText('Nothing in this queue');
    expect(vi.mocked(listAdminRequests)).toHaveBeenCalledWith('APPROVED');
    expect(screen.getByRole('radio', { name: 'Approved' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('tab', { name: 'Entitlements' }));
    expect(await screen.findByText('Entitlements view')).toBeInTheDocument();
    expect(lastSearch).toContain('tab=entitlements');
  });
});

describe('stripDays', () => {
  it('fourteen calendar keys from today, across a month end', () => {
    const d = stripDays('2026-10-25');
    expect(d).toHaveLength(14);
    expect(d[0]).toBe('2026-10-25');
    expect(d[7]).toBe('2026-11-01');
  });
});
