import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InboxResponse } from '@alto-people/shared';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from '@/lib/api';
import { InboxReturnBar } from '@/components/InboxReturnBar';
import { inboxLink } from '@/lib/inboxApi';

/**
 * The way back from a queue opened in the Inbox — and on to the next queue
 * once this one is empty.
 */

const inbox = (approvals: number, bills: number): InboxResponse => ({
  total: approvals + bills,
  sources: [
    { key: 'approvals', label: 'Approvals', description: 'x', count: approvals, path: '/approvals' },
    { key: 'books-bills', label: 'Bills', description: 'x', count: bills, path: '/books/bills?tab=approve' },
  ],
});

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="*" element={<InboxReturnBar />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InboxReturnBar', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(apiFetch).mockReset();
  });

  it('builds the link with the way back, before any hash', () => {
    expect(inboxLink('/approvals', 'approvals')).toBe('/approvals?from=inbox&inbox=approvals');
    expect(inboxLink('/books/bills?tab=approve', 'books-bills')).toBe('/books/bills?tab=approve&from=inbox&inbox=books-bills');
    expect(inboxLink('/relay#lane', 'relay')).toBe('/relay?from=inbox&inbox=relay#lane');
  });

  it('says how many are left in the queue it came from', async () => {
    vi.mocked(apiFetch).mockResolvedValue(inbox(2, 3));
    renderAt('/approvals?from=inbox&inbox=approvals');
    expect(await screen.findByText('Approvals: 2 left')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to inbox/ })).toHaveAttribute('href', '/inbox');
  });

  it('once the queue is empty, offers the next one with work in it', async () => {
    vi.mocked(apiFetch).mockResolvedValue(inbox(0, 3));
    renderAt('/approvals?from=inbox&inbox=approvals');
    const next = await screen.findByRole('link', { name: /Next: Bills \(3\)/ });
    expect(next).toHaveAttribute('href', '/books/bills?tab=approve&from=inbox&inbox=books-bills');
  });

  it('shows nothing for a page not opened from the Inbox', () => {
    vi.mocked(apiFetch).mockResolvedValue(inbox(2, 3));
    renderAt('/approvals');
    expect(screen.queryByText(/Back to inbox/)).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
