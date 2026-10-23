import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  listMyPayNotices: vi.fn(),
  getMyPayNotice: vi.fn(),
  acknowledgeMyPayNotice: vi.fn(),
}));
vi.mock('@/lib/payComplianceApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payComplianceApi')>()), ...api }));
import { ApiError } from '@/lib/api';
import { PayNotices } from '@/pages/me/PayNotices';

/** A pay notice's page is about that notice; a removed one says so (F500 G5). */

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/me/pay-notices/:id" element={<PayNotices />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('pay notice detail', () => {
  it('is headed by the notice — state, sent date, status — and says to read, then sign', async () => {
    api.getMyPayNotice.mockResolvedValue({
      notice: { id: 'n1', state: 'NY', trigger: 'HIRE', status: 'SENT', sentAt: '2026-10-12T15:00:00.000Z', acknowledgedAt: null, signedName: null },
      sections: [{ language: 'es', lines: [{ label: 'Tarifa', value: '$15.00' }] }, { language: 'en', lines: [{ label: 'Rate', value: '$15.00' }] }],
    });
    renderAt('/me/pay-notices/n1');
    expect(await screen.findByRole('heading', { level: 1, name: 'New job' })).toBeInTheDocument();
    expect(screen.getByText('NY · sent Oct 12, 2026')).toBeInTheDocument();
    expect(screen.getAllByText('Needs your signature').length).toBeGreaterThan(0);
    expect(screen.getByTestId('pay-notice-read-first')).toHaveTextContent('Read the notice below, then sign at the end.');
  });

  it('a notice that is gone (404) says so and links back — no "Try again"', async () => {
    api.getMyPayNotice.mockRejectedValue(new ApiError(404, 'not_found', 'Not found'));
    renderAt('/me/pay-notices/zzz');
    expect(await screen.findByText('This notice isn’t available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All pay notices' })).toHaveAttribute('href', '/me/pay-notices');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
