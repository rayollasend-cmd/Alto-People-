import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Brief 2-6 step 5 — the support page sends what the person wrote and the
 * page they came from, lists their requests with the platform's answer, and
 * links the status page.
 */

const apiFetch = vi.fn(async (path: string, _opts?: unknown) => {
  if (path === '/support/config') return { statusPageUrl: 'https://status.altohr.test' };
  if (path === '/support/mine') return { requests: [{ id: 'r1', category: 'PROBLEM', subject: 'Kiosk will not pair', status: 'RESOLVED', reply: 'Re-issue the pairing code.', createdAt: '2026-10-15T10:00:00Z' }] };
  if (path === '/support') return { id: 'r2', status: 'OPEN' };
  return {};
});
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: (p: string, o?: unknown) => apiFetch(p, o) }));

import { SupportPage } from '@/pages/support/SupportPage';

describe('SupportPage', () => {
  it('sends a request and shows the answers and the status link', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[{ pathname: '/support', state: { from: '/time-attendance/kiosk' } }]}>
          <SupportPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Re-issue the pairing code.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /system status/i }).getAttribute('href')).toBe('https://status.altohr.test');
    await userEvent.type(screen.getByLabelText(/subject/i), 'Payroll export question');
    await userEvent.type(screen.getByLabelText(/what happened/i), 'Where is the Fieldglass export?');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    const sent = apiFetch.mock.calls.find(([p, o]) => p === '/support' && o);
    expect(sent?.[1]).toMatchObject({ method: 'POST', body: { category: 'QUESTION', subject: 'Payroll export question', pageUrl: '/time-attendance/kiosk' } });
  });
});
