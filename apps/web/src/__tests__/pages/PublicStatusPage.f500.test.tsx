import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicStatus, StatusDayPublic } from '@alto-people/shared';

vi.mock('@/lib/statusApi', () => ({
  getPublicStatus: vi.fn(),
  subscribeToStatus: vi.fn(async () => ({ ok: true })),
  confirmStatusSubscription: vi.fn(async () => ({ ok: true })),
  unsubscribeFromStatus: vi.fn(async () => ({ ok: true })),
}));
import { confirmStatusSubscription, getPublicStatus, subscribeToStatus } from '@/lib/statusApi';
import { PublicStatusPage } from '@/pages/status/PublicStatusPage';

/** The status page (F500 G5): a 90-cell daily bar per component, and incident updates by email (double opt-in). */

const days: StatusDayPublic[] = Array.from({ length: 90 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 6, 18 + i)).toISOString().slice(0, 10);
  return { date, state: i === 88 ? 'OUTAGE' : i % 2 ? 'OPERATIONAL' : 'UNMEASURED', pct: i === 88 ? 95 : i % 2 ? 100 : null };
});
const status: PublicStatus = {
  generatedAt: '2026-10-15T12:00:00.000Z',
  product: 'Alto People',
  overall: 'OPERATIONAL',
  components: [{ key: 'API', label: 'Platform API', what: 'x', state: 'OPERATIONAL', note: 'ok', uptime90d: 97.8, days }],
  incidents: [],
};

function renderAt(path = '/status') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <PublicStatusPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the status page (F500 G5)', () => {
  it('draws 90 days as cells, coloured by the day, with the date and rate on each', async () => {
    vi.mocked(getPublicStatus).mockResolvedValue(status);
    renderAt();
    const bar = await screen.findByTestId('uptime-bar');
    const cells = bar.querySelectorAll('span');
    expect(cells).toHaveLength(90);
    expect(cells[88]).toHaveAttribute('data-state', 'OUTAGE');
    expect(cells[88]!.getAttribute('title')).toMatch(/· 95%$/);
    expect(bar).toHaveAttribute('aria-label', expect.stringContaining('1 down'));
  });

  it('asks for email updates and says to confirm; a confirm link lands back here', async () => {
    vi.mocked(getPublicStatus).mockResolvedValue(status);
    renderAt();
    await userEvent.type(await screen.findByLabelText('Email for status updates'), 'buyer@example.com');
    await userEvent.click(screen.getByRole('button', { name: /Get updates/ }));
    expect(subscribeToStatus).toHaveBeenCalledWith('buyer@example.com');
    expect(await screen.findByTestId('status-subscribe-done')).toHaveTextContent('we sent a link to confirm buyer@example.com');
  });

  it('?confirm= confirms the subscription', async () => {
    vi.mocked(getPublicStatus).mockResolvedValue(status);
    renderAt('/status?confirm=abc.def-token');
    await waitFor(() => expect(confirmStatusSubscription).toHaveBeenCalledWith('abc.def-token'));
    expect(within(await screen.findByTestId('status-link-result')).getByText(/You’re subscribed/)).toBeInTheDocument();
  });
});
