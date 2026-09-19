import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { FieldglassSetup } from '@/pages/fieldglass/FieldglassSetup';

/**
 * Fieldglass setup, its own page: how many to add, move and close, the
 * hours that can't be billed yet, the whole queue — and everyone already
 * in Fieldglass, with their Worker ID fixed in place.
 */

const SETUP = {
  generatedAt: '2026-09-19T12:00:00Z',
  queue: [
    {
      kind: 'close',
      associateId: 'a3',
      name: 'Cy Vega',
      clientName: 'Walmart Destin',
      fromClientName: null,
      workerId: 'WKR3',
      position: null,
      firstShiftAt: null,
      approvedAt: null,
      email: 'cy@example.com',
      phone: null,
      hireDate: null,
      hoursUnbilled: 0,
    },
    {
      kind: 'add',
      associateId: 'a2',
      name: 'Jay Patel',
      clientName: 'Walmart Destin',
      fromClientName: null,
      workerId: null,
      position: 'Stocker',
      firstShiftAt: '2026-09-14T03:00:00Z',
      approvedAt: null,
      email: 'jay@example.com',
      phone: null,
      hireDate: null,
      hoursUnbilled: 34,
    },
  ],
  roster: [
    {
      associateId: 'a1',
      name: 'Rosa Vega',
      photoUrl: null,
      clientId: 'c1',
      clientName: 'Walmart Destin',
      workerId: 'WKR00088121',
      addedAt: '2026-07-10T15:00:00Z',
      addedBy: 'Fin Ance',
      separated: false,
      lastWorked: '2026-09-18',
      lastTimesheet: { weekEnd: '2026-09-11', status: 'SUBMITTED', entered: true },
    },
    {
      associateId: 'a4',
      name: 'Pat Nguyen',
      photoUrl: null,
      clientId: 'c1',
      clientName: 'Walmart Destin',
      workerId: null,
      addedAt: '2026-09-01T15:00:00Z',
      addedBy: null,
      separated: false,
      lastWorked: null,
      lastTimesheet: null,
    },
  ],
};

function renderPage(initial = '/fieldglass') {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/finance/fieldglass') return SETUP as never;
    if (path === '/finance/fieldglass/a4') return { ok: true, workerId: 'WKR00099001' } as never;
    throw new Error(`unexpected ${path}`);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>
        <FieldglassSetup />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('Fieldglass setup', () => {
  it('the counts, and the whole queue to work', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Fieldglass setup' })).toBeInTheDocument();
    expect(await screen.findByText('34.0h')).toBeInTheDocument();
    expect(screen.getByText('worked by 1 not in Fieldglass')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'To do (2)' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /Jay Patel/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cy Vega/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Fieldglass timesheets/ })).toHaveAttribute('href', '/time-attendance/timesheets');
  });

  it('everyone in Fieldglass: their latest timesheet, their history — and a missing Worker ID added in place', async () => {
    const calls = renderPage();
    await userEvent.click(await screen.findByRole('radio', { name: 'In Fieldglass (2)' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('WKR00088121')).toBeInTheDocument();
    expect(within(table).getByText('Submitted')).toBeInTheDocument();
    expect(within(table).getByText('week ending 09/11/2026')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: /Rosa Vega/ })).toHaveAttribute('href', '/time-attendance/timesheets/history/a1');

    await userEvent.click(screen.getByRole('button', { name: 'Missing a Worker ID (1)' }));
    expect(within(table).queryByText('Rosa Vega')).not.toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Add Worker ID' }));
    const input = within(table).getByLabelText('Pat Nguyen’s Fieldglass Worker ID');
    await userEvent.type(input, 'bad id');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(input);
    await userEvent.type(input, 'WKR00099001');
    await userEvent.click(within(table).getByRole('button', { name: 'Save Worker ID' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/finance/fieldglass/a4')).toMatchObject({ method: 'PATCH', body: { workerId: 'WKR00099001' } }),
    );
  });
});
