import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InboxResponse } from '@alto-people/shared';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { apiFetch } from '@/lib/api';
import { InboxHome } from '@/pages/inbox/InboxHome';

/**
 * The Inbox: every decision waiting on the person, ranked by what it
 * costs to be late (a legal clock above money above routine, soonest
 * deadline first — role walk HR 4), with a link into each queue, the
 * empty queues folded behind one line (ops 20), and a calm empty state
 * when nothing is waiting.
 */

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <InboxHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const inThreeDays = new Date(Date.now() + 3 * 86_400_000).toISOString();
const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();

const busy: InboxResponse = {
  total: 14,
  sources: [
    {
      key: 'fieldglass-setup',
      label: 'Fieldglass setup',
      description: 'People placed at a Fieldglass client with no worker record.',
      count: 3,
      path: '/fieldglass',
      urgency: 'routine',
    },
    {
      key: 'approvals',
      label: 'Approvals',
      description: 'Shift swaps, time off and timesheets waiting for a manager.',
      count: 2,
      path: '/approvals',
      urgency: 'routine',
    },
    {
      key: 'onboarding-review',
      label: 'Applications to review',
      description: 'New hires waiting on HR.',
      count: 7,
      path: '/onboarding',
    },
    {
      key: 'everify-mismatches',
      label: 'E-Verify mismatches to act on',
      description: 'A Tentative Nonconfirmation to hand to the employee.',
      count: 1,
      path: '/compliance?tab=everify',
      urgency: 'legal',
    },
    {
      key: 'ui-claims',
      label: 'Unemployment claims',
      description: 'State notices to answer within 3 days.',
      count: 1,
      path: '/claims/unemployment',
      urgency: 'legal',
      dueAt: inThreeDays,
    },
    {
      key: 'books-bills-due',
      label: 'Bills due this week',
      description: 'Approved vendor bills due in the next seven days, or already overdue.',
      count: 1,
      path: '/books/bills?tab=due',
      urgency: 'money',
      dueAt: lastWeek,
    },
    {
      key: 'hotline',
      label: 'Hotline reports',
      description: 'Anonymous reports under investigation.',
      count: 0,
      path: '/hotline-admin',
    },
    {
      key: 'wc-claims',
      label: 'Workers’ comp reports due',
      description: 'First reports of injury not yet sent.',
      count: 0,
      path: '/claims/workers-comp',
      urgency: 'legal',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InboxHome', () => {
  it('ranks legal clocks above money above routine, soonest deadline first, and says when each is due', async () => {
    vi.mocked(apiFetch).mockResolvedValue(busy);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByText('Every decision waiting on you, in one place.')).toBeInTheDocument();

    // Three bands, in order — the three-item Fieldglass queue is last, not first.
    const bands = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent);
    expect(bands[0]).toMatch(/^Legal deadlines/);
    expect(bands[1]).toMatch(/^Money/);
    expect(bands[2]).toMatch(/^Routine/);

    const lists = screen.getAllByRole('list', { name: 'Decisions waiting on you' });
    expect(lists).toHaveLength(3);
    const legal = within(lists[0]!).getAllByRole('listitem');
    // Within a band the soonest deadline first, then the rest.
    expect(within(legal[0]!).getByRole('heading', { name: /Unemployment claims/ })).toBeInTheDocument();
    expect(within(legal[0]!).getByTestId('inbox-due')).toHaveTextContent(/^Next due /);
    expect(within(legal[1]!).getByRole('heading', { name: /E-Verify mismatches/ })).toBeInTheDocument();

    const money = within(lists[1]!).getAllByRole('listitem');
    expect(within(money[0]!).getByTestId('inbox-due')).toHaveTextContent(/^Overdue/);

    // Routine: biggest queue first; the link carries the way back.
    const routine = within(lists[2]!).getAllByRole('listitem');
    expect(routine.map((r) => within(r).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'Applications to review',
      'Fieldglass setup',
      'Approvals',
    ]);
    expect(within(routine[0]!).getByRole('link', { name: 'Open Applications to review' })).toHaveAttribute(
      'href',
      '/onboarding?from=inbox&inbox=onboarding-review',
    );

    // The empty queues fold behind one line, still named and reachable.
    const fold = screen.getByTestId('inbox-quiet');
    expect(within(fold).getByText('2 queues clear')).toBeInTheDocument();
    expect(fold).not.toHaveAttribute('open');
    const quiet = within(fold).getByRole('list', { name: 'Queues with nothing waiting' });
    expect(within(quiet).getByRole('link', { name: /Hotline reports/ })).toHaveAttribute('href', '/hotline-admin?from=inbox&inbox=hotline');

    expect(screen.queryByText('Nothing is waiting on you.')).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/me/inbox');
  });

  it('an older API with no bands still renders: everything is routine, biggest first', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      total: 9,
      sources: [
        { key: 'approvals', label: 'Approvals', description: 'Waiting for a manager.', count: 2, path: '/approvals' },
        { key: 'onboarding-review', label: 'Applications to review', description: 'New hires waiting on HR.', count: 7, path: '/onboarding' },
      ],
    } satisfies InboxResponse);
    renderPage();

    const list = await screen.findByRole('list', { name: 'Decisions waiting on you' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('heading', { name: 'Applications to review' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-quiet')).not.toBeInTheDocument();
  });

  it('shows the empty state when nothing is waiting', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      total: 0,
      sources: [
        { key: 'approvals', label: 'Approvals', description: 'Waiting for a manager.', count: 0, path: '/approvals' },
      ],
    } satisfies InboxResponse);
    renderPage();

    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Decisions waiting on you' })).not.toBeInTheDocument();
    // The watched-but-empty queue is still reachable, behind the fold.
    expect(screen.getByText('1 queue clear')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Approvals/ })).toHaveAttribute('href', '/approvals?from=inbox&inbox=approvals');
  });

  it('another desk’s company-wide queue sits under "Also watching", outside the count (F500 SH-4)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      total: 3,
      sources: [
        { key: 'approvals', label: 'Shift & time-off approvals', description: 'Swaps, pickups and time off.', count: 3, path: '/approvals' },
        { key: 'pay-schedule-unassigned', label: 'People on no pay schedule', description: 'Hired people no pay schedule covers.', count: 10, path: '/payroll/schedules?view=unassigned', watching: true },
      ],
    } satisfies InboxResponse);
    renderPage();
    const mine = await screen.findByRole('list', { name: 'Decisions waiting on you' });
    expect(within(mine).getByText('Shift & time-off approvals')).toBeInTheDocument();
    expect(within(mine).queryByText('People on no pay schedule')).not.toBeInTheDocument();
    const watching = screen.getByTestId('inbox-watching');
    expect(within(watching).getByText('Also watching · 1')).toBeInTheDocument();
    expect(within(watching).getByText('People on no pay schedule')).toBeInTheDocument();
  });

  it('a date-only deadline sent as UTC midnight reads as its own day, west of UTC too (it read "Jan 30" for a Jan 31 due date)', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      vi.mocked(apiFetch).mockResolvedValue({
        total: 2,
        sources: [
          { key: 'contract-duties', label: 'Contract duties overdue', description: 'Certificates the contract asks for.', count: 2, path: '/compliance', urgency: 'legal', dueAt: '2026-01-31T00:00:00.000Z' },
        ],
      } satisfies InboxResponse);
      renderPage();
      expect(await screen.findByTestId('inbox-due')).toHaveTextContent('Jan 31, 2026');
    } finally {
      process.env.TZ = tz;
    }
  });

  it('offers a retry when the inbox fails to load', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByText(/Couldn’t load your inbox/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
