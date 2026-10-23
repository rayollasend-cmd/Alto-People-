import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Safety & EEO reporting (/compliance/osha), F500: it opened on the first
 * client ("Alto HR — Internal Hires": "No OSHA incidents") while the
 * scorecard that links here counted two open recordables at another
 * client. It now opens on every client, keeps its tab and client in the
 * URL, and holds the injury rates back until the hours make them mean
 * something.
 */

vi.mock('@/lib/useClients', () => ({
  useClients: () => ({
    clients: [
      { id: '00000000-0000-4000-8000-0000000000c1', name: 'Alto HR — Internal Hires' },
      { id: '00000000-0000-4000-8000-0000000000c2', name: 'Coastal Resort Holdings' },
    ],
  }),
}));
vi.mock('@/lib/clientsApi', () => ({ listClientLocations: vi.fn(async () => ({ locations: [] })) }));
vi.mock('@/lib/complianceApi', () => ({
  getEeoApplicantReport: vi.fn(async () => ({ applicants: 0, responses: 0, declined: 0, from: '2026-01-01', to: '2026-10-22', gender: {}, ethnicity: {}, veteranStatus: {}, disabilityStatus: {} })),
}));
vi.mock('@/lib/oshaWcEeoApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/oshaWcEeoApi')>()),
  listOshaIncidents: vi.fn(),
  get300A: vi.fn(),
  getEeoReport: vi.fn(async () => ({ total: 0, buckets: [] })),
  listWcClassCodes: vi.fn(async () => ({ codes: [] })),
}));

import { get300A, getEeoReport, listOshaIncidents } from '@/lib/oshaWcEeoApi';
import { OshaWcEeoHome } from '@/pages/compliance/OshaWcEeoHome';

let lastSearch = '';
function Spy() {
  lastSearch = useLocation().search;
  return null;
}
function renderPage(path = '/compliance/osha') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <OshaWcEeoHome />
        <Spy />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listOshaIncidents).mockResolvedValue({
    incidents: [
      {
        id: '00000000-0000-4000-8000-0000000000a1',
        clientId: '00000000-0000-4000-8000-0000000000c2',
        clientName: 'Coastal Resort Holdings',
        associateId: null,
        associateName: 'Gerodney Lee',
        occurredAt: '2026-10-16T14:00:00.000Z',
        reportedAt: '2026-10-16T15:00:00.000Z',
        location: null,
        description: 'Cut hand',
        bodyPart: 'Hand',
        severity: 'MEDICAL_TREATMENT',
        daysAway: 0,
        daysRestricted: 0,
        isRecordable: true,
        status: 'REPORTED',
        resolutionNote: null,
        resolvedAt: null,
      },
    ],
  } as never);
  vi.mocked(get300A).mockResolvedValue({
    totalCases: 2,
    fatalities: 0,
    daysAwayCases: 1,
    restrictedCases: 0,
    otherRecordable: 1,
    totalDaysAway: 3,
    totalDaysRestricted: 0,
    hoursWorked: 1239,
    trir: 322.95,
    dart: 161.47,
  });
});

describe('<OshaWcEeoHome>', () => {
  it('opens on every client, titled in plain words, with each incident’s client shown', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Safety & EEO reporting' })).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Client' });
    expect(select).toHaveValue('');
    expect(within(select).getByRole('option', { name: 'All clients' })).toBeInTheDocument();
    await waitFor(() => expect(listOshaIncidents).toHaveBeenCalledWith(''));
    expect(get300A).toHaveBeenCalledWith('', new Date().getFullYear());
    expect(await screen.findAllByText('Coastal Resort Holdings')).not.toHaveLength(0);
    expect(screen.getByRole('columnheader', { name: /Client/ })).toBeInTheDocument();
  });

  it('keeps the client and the tab in the URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Client' }), '00000000-0000-4000-8000-0000000000c2');
    expect(lastSearch).toContain('client=00000000-0000-4000-8000-0000000000c2');
    await waitFor(() => expect(listOshaIncidents).toHaveBeenLastCalledWith('00000000-0000-4000-8000-0000000000c2'));
    await user.click(screen.getByRole('tab', { name: 'EEO-1 report' }));
    expect(lastSearch).toContain('tab=eeo');
    await waitFor(() => expect(getEeoReport).toHaveBeenLastCalledWith('00000000-0000-4000-8000-0000000000c2'));
  });

  it('a link straight to the EEO-1 tab for every client lands there', async () => {
    renderPage('/compliance/osha?tab=eeo');
    expect(screen.getByRole('tab', { name: 'EEO-1 report' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(getEeoReport).toHaveBeenCalledWith(''));
  });

  it('holds TRIR/DART back on 1,239 hours; picks the year from a list', async () => {
    renderPage();
    expect(await screen.findByText('Shown after 20,000 hours worked')).toBeInTheDocument();
    expect(screen.queryByText('322.95')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Year' })).toHaveValue(String(new Date().getFullYear()));
  });
});
