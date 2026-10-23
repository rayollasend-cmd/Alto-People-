import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { InboxResponse } from '@alto-people/shared';
import { renderAs } from './hrPack/harness';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';
import { InboxHome } from '@/pages/inbox/InboxHome';

/**
 * The Inbox, F500 G5: a calendar-day deadline is that day; a small queue
 * names its items; a band says queues and items; the whole row opens the
 * queue; an associate gets no triage bands and no "queues clear" footer.
 */

const data: InboxResponse = {
  total: 9,
  sources: [
    {
      key: 'contract-duties',
      label: 'Contract duties overdue',
      description: 'Confirm each on the compliance scorecard once it is filed.',
      count: 2,
      path: '/compliance?tab=scorecard',
      urgency: 'legal',
      dueAt: null,
      dueDate: '2026-01-31',
      preview: ["Workers' comp certificate of insurance", 'General liability certificate of insurance'],
    },
    { key: 'everify', label: 'E-Verify mismatches', description: 'x', count: 7, path: '/compliance', urgency: 'legal', dueAt: null },
    { key: 'my-notifications', label: 'Unread notices', description: 'Notices you have not opened yet.', count: 6, path: '/communications', urgency: 'routine', dueAt: null },
    { key: 'quiet', label: 'Quiet queue', description: 'x', count: 0, path: '/x', urgency: 'routine', dueAt: null },
  ],
};

describe('InboxHome (F500)', () => {
  it('a date-only due date reads as its own day, and a small queue names what is in it', async () => {
    vi.mocked(apiFetch).mockResolvedValue(data as never);
    renderAs('HR_ADMINISTRATOR', <InboxHome />, '/inbox');
    const row = (await screen.findAllByTestId('inbox-row'))[0]!;
    expect(within(row).getByTestId('inbox-due')).toHaveTextContent('Overdue · Jan 31, 2026');
    expect(within(row).getByTestId('inbox-preview')).toHaveTextContent("Workers' comp certificate of insurance");
    // The whole row opens the queue.
    expect(row).toHaveAttribute('href', expect.stringContaining('/compliance?tab=scorecard'));
    // The band header counts queues and items (the badge counts items).
    expect(screen.getAllByTestId('inbox-band-count')[0]).toHaveTextContent('2 queues · 9 items');
    expect(screen.getByTestId('inbox-quiet')).toBeInTheDocument();
  });

  it('an associate sees their own tasks — no severity header, no "queues clear" footer', async () => {
    vi.mocked(apiFetch).mockResolvedValue(data as never);
    renderAs('ASSOCIATE', <InboxHome />, '/inbox');
    expect(await screen.findByText('Unread notices')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-band-count')).toBeNull();
    expect(screen.queryByText(/Legal deadlines/i)).toBeNull();
    expect(screen.queryByTestId('inbox-quiet')).toBeNull();
  });
});
