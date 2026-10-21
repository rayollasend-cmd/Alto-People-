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
 * The Inbox: every decision waiting on the person, ranked, with a link
 * into each queue — and a calm empty state when nothing is.
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

const busy: InboxResponse = {
  total: 9,
  sources: [
    {
      key: 'approvals',
      label: 'Approvals',
      description: 'Shift swaps, time off and timesheets waiting for a manager.',
      count: 2,
      path: '/approvals',
    },
    {
      key: 'onboarding-review',
      label: 'Applications to review',
      description: 'New hires waiting on HR.',
      count: 7,
      path: '/onboarding',
    },
    {
      key: 'hotline',
      label: 'Hotline reports',
      description: 'Anonymous reports under investigation.',
      count: 0,
      path: '/hotline-admin',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InboxHome', () => {
  it('ranks the queues with something waiting, links into each, and folds the empty ones', async () => {
    vi.mocked(apiFetch).mockResolvedValue(busy);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByText('Every decision waiting on you, in one place.')).toBeInTheDocument();

    // Biggest queue first.
    const list = await screen.findByRole('list', { name: 'Decisions waiting on you' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('heading', { name: 'Applications to review' })).toBeInTheDocument();
    expect(within(rows[0]).getByText('7')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('link', { name: 'Open Applications to review' })).toHaveAttribute(
      'href',
      // The link carries the way back (components/InboxReturnBar).
      '/onboarding?from=inbox&inbox=onboarding-review',
    );
    expect(within(rows[1]).getByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link', { name: 'Open Approvals' })).toHaveAttribute('href', '/approvals?from=inbox&inbox=approvals');

    // The empty queue is still named, under "All clear".
    expect(screen.getByRole('heading', { name: 'All clear' })).toBeInTheDocument();
    const quiet = screen.getByRole('list', { name: 'Queues with nothing waiting' });
    expect(within(quiet).getByRole('link', { name: /Hotline reports/ })).toHaveAttribute('href', '/hotline-admin?from=inbox&inbox=hotline');

    expect(screen.queryByText('Nothing is waiting on you.')).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/me/inbox');
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
    // The watched-but-empty queue is still reachable.
    expect(screen.getByRole('link', { name: /Approvals/ })).toHaveAttribute('href', '/approvals?from=inbox&inbox=approvals');
  });

  it('offers a retry when the inbox fails to load', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByText(/Couldn’t load your inbox/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
