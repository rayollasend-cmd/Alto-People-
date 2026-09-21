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

/** A desk with two clients, two dates and three people to work. */
const TWO_CLIENTS = {
  generatedAt: '2026-09-19T12:00:00Z',
  queue: [
    {
      kind: 'add',
      associateId: 'b1',
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
    {
      kind: 'add',
      associateId: 'b2',
      name: 'Nia Fournier',
      clientName: 'Pier Park',
      fromClientName: null,
      workerId: null,
      position: 'Front End',
      firstShiftAt: '2026-10-02T03:00:00Z',
      approvedAt: null,
      email: 'nia@example.com',
      phone: null,
      hireDate: null,
      hoursUnbilled: 6,
    },
    {
      kind: 'close',
      associateId: 'b3',
      name: 'Cy Vega',
      clientName: 'Pier Park',
      fromClientName: null,
      workerId: 'WKR3',
      position: null,
      firstShiftAt: null,
      approvedAt: null,
      email: 'cy@example.com',
      phone: null,
      hireDate: '2026-08-01',
      hoursUnbilled: 0,
    },
  ],
  roster: [
    {
      associateId: 'b4',
      name: 'Rosa Vega',
      photoUrl: null,
      clientId: 'c1',
      clientName: 'Walmart Destin',
      workerId: 'WKR00088121',
      addedAt: '2026-07-10T15:00:00Z',
      addedBy: 'Fin Ance',
      separated: false,
      lastWorked: '2026-09-18',
      lastTimesheet: null,
    },
    {
      associateId: 'b5',
      name: 'Ada Mensah',
      photoUrl: null,
      clientId: 'c2',
      clientName: 'Pier Park',
      workerId: 'WKR00088122',
      addedAt: '2026-07-10T15:00:00Z',
      addedBy: 'Fin Ance',
      separated: false,
      lastWorked: '2026-06-02',
      lastTimesheet: null,
    },
  ],
};

function renderWith(data: unknown, initial = '/fieldglass') {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/finance/fieldglass') return data as never;
    throw new Error(`unexpected ${path}`);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>
        <FieldglassSetup />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Fieldglass setup — filters', () => {
  it('narrows the desk to one client, tiles included', async () => {
    renderWith(TWO_CLIENTS);
    expect(await screen.findByRole('radio', { name: 'To do (3)' })).toBeInTheDocument();
    // 34 + 6 unbilled hours across both clients.
    expect(screen.getByText('40.0h')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Client'), 'Pier Park');

    expect(await screen.findByRole('radio', { name: 'To do (2)' })).toBeInTheDocument();
    expect(screen.getByText('6.0h')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nia Fournier/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jay Patel/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 3 waiting on setup/)).toBeInTheDocument();
  });

  it('finds one person by name and clears back to the whole desk', async () => {
    renderWith(TWO_CLIENTS);
    await userEvent.type(await screen.findByLabelText('Search the Fieldglass desk'), 'fournier');

    expect(await screen.findByRole('radio', { name: 'To do (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cy Vega/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect(await screen.findByRole('radio', { name: 'To do (3)' })).toBeInTheDocument();
  });

  it('filters the to-do list by when people start', async () => {
    renderWith(TWO_CLIENTS);
    await screen.findByRole('radio', { name: 'To do (3)' });

    // Only people starting in October.
    await userEvent.type(screen.getByLabelText('Starts on or after'), '2026-10-01');

    expect(await screen.findByRole('radio', { name: 'To do (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nia Fournier/ })).toBeInTheDocument();
  });

  it('keeps only one kind of work on screen', async () => {
    renderWith(TWO_CLIENTS);
    await screen.findByRole('radio', { name: 'To do (3)' });

    await userEvent.click(screen.getByRole('button', { name: 'To close' }));

    expect(await screen.findByRole('radio', { name: 'To do (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cy Vega/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jay Patel/ })).not.toBeInTheDocument();
  });

  it('carries the filters in the URL, and applies them to who is registered', async () => {
    renderWith(TWO_CLIENTS, '/fieldglass?tab=registered&client=Pier+Park');

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Ada Mensah')).toBeInTheDocument();
    expect(within(table).queryByText('Rosa Vega')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'In Fieldglass (1)' })).toBeInTheDocument();

    // The date filter reads "last worked" on this tab.
    await userEvent.type(screen.getByLabelText('Last worked on or after'), '2026-09-01');
    expect(await screen.findByText(/Nobody matches those filters/)).toBeInTheDocument();
  });
});
