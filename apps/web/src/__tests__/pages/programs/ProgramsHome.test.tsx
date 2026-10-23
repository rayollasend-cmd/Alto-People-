import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import type { ProgramSummary, Sponsor } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/programsApi', () => ({
  listPrograms: vi.fn(),
  createProgram: vi.fn(),
  updateProgram: vi.fn(),
  getAssociateProgram: vi.fn(),
  listMyProgramAlerts: vi.fn(),
  getAlertSettings: vi.fn(),
  saveAlertSettings: vi.fn(),
  listSponsors: vi.fn(),
  createSponsor: vi.fn(),
  updateSponsor: vi.fn(),
  getTransitionCalendar: vi.fn(),
  transitionCalendarPdfUrl: vi.fn(() => '/api/programs/calendar?format=pdf'),
  getSponsorReport: vi.fn(),
  sponsorReportUrl: vi.fn(() => '/api/programs/sponsors/x/report'),
}));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn().mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort' }], nextCursor: null }),
  listClientLocations: vi.fn().mockResolvedValue({ locations: [] }),
}));
vi.mock('@/lib/documentsApi', () => ({ getDocumentVault: vi.fn().mockResolvedValue({ documents: [], total: 0, summary: {} }) }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { getAlertSettings, listPrograms, listSponsors, saveAlertSettings } from '@/lib/programsApi';
import { ProgramsHome } from '@/pages/programs/ProgramsHome';

const program: ProgramSummary = {
  id: 'p1',
  associateId: 'a1',
  associateName: 'Maria Lopez',
  associateEmail: 'maria@example.com',
  siteId: 's1',
  siteName: 'Destin',
  clientId: 'c1',
  clientName: 'Coastal Resort',
  type: 'J1_SWT',
  sponsorId: 'sp1',
  sponsorName: 'CIEE',
  ds2019Number: 'N001',
  ds2019IssuedOn: null,
  ds2019ExpiresOn: null,
  visaExpiresOn: null,
  sevisId: null,
  country: 'Turkey',
  programStart: '2026-06-01',
  programEnd: '2026-11-12',
  gracePeriodDays: 30,
  graceEndsOn: '2026-12-12',
  secondJobStatus: 'NOT_REQUESTED',
  h2bPetitionNumber: null,
  petitionClientId: null,
  petitionClientName: null,
  petitionValidFrom: null,
  petitionValidTo: null,
  worksiteArea: null,
  lastSponsorCheckInOn: null,
  nextSponsorCheckInOn: '2026-07-01',
  i9WorkAuthExpiresOn: null,
  notes: null,
  closedAt: null,
  closedReason: null,
  daysUntilEnd: 30,
  status: 'ACTIVE',
  documents: [],
  alerts: [
    {
      kind: 'PROGRAM_END',
      label: 'Program ends',
      dueOn: '2026-11-12',
      daysUntil: 30,
      lead: 30,
      severity: 'warn',
      programId: 'p1',
      associateId: 'a1',
      associateName: 'Maria Lopez',
      siteName: 'Destin',
      clientId: 'c1',
      programType: 'J1_SWT',
    },
  ],
};

const sponsor: Sponsor = {
  id: 'sp1',
  name: 'CIEE',
  programType: 'J1_SWT',
  contactName: 'Jo Park',
  contactEmail: 'jo@ciee.example',
  contactPhone: null,
  website: null,
  checkInCadenceDays: 30,
  checkInRequirements: null,
  reportingCadence: null,
  notes: null,
  isActive: true,
  activeParticipants: 1,
};

const settings = { programEndDays: [60, 30, 14, 7], visaExpiryDays: [60, 30], i9ReverifyDays: [90, 30, 7], sponsorCheckInDays: [7, 0], petitionEndDays: [60, 30] };

function renderPage(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR', path = '/programs') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <ProgramsHome />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(listPrograms).mockResolvedValue({ programs: [program] });
  vi.mocked(listSponsors).mockResolvedValue({ sponsors: [sponsor] });
  vi.mocked(getAlertSettings).mockResolvedValue(settings);
  vi.mocked(saveAlertSettings).mockReset();
  vi.mocked(saveAlertSettings).mockResolvedValue(settings);
});

describe('ProgramsHome', () => {
  it('lists participants with their status and the most urgent date', async () => {
    renderPage();
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/Program ends · in 30d/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add program/i })).toBeInTheDocument();
  });

  it('hides the add button from a read-only role', async () => {
    renderPage('EXECUTIVE_CHAIRMAN');
    await screen.findByText('Maria Lopez');
    expect(screen.queryByRole('button', { name: /add program/i })).not.toBeInTheDocument();
  });

  it('shows the sponsor directory on its tab', async () => {
    renderPage('HR_ADMINISTRATOR', '/programs?tab=sponsors');
    expect(await screen.findByText('CIEE')).toBeInTheDocument();
    expect(screen.getByText(/Jo Park/)).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
  });

  it('saves edited lead times from the Alert settings dialog, as chips', async () => {
    renderPage();
    await screen.findByText('Maria Lopez');
    // Settings are a header action, not a tab of the work.
    expect(screen.queryByRole('tab', { name: /alert settings/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /alert settings/i }));
    const dialog = await screen.findByRole('dialog');
    const field = 'Program end (and grace end)';
    for (const d of [60, 30, 14, 7]) {
      await userEvent.click(within(dialog).getByRole('button', { name: `Remove ${d} days from ${field}` }));
    }
    const add = within(dialog).getByLabelText(`Add a lead time to ${field}, in days`);
    await userEvent.type(add, '10{Enter}');
    await userEvent.type(add, '45{Enter}');
    expect(within(dialog).getByText('45 days')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /save lead times/i }));
    await waitFor(() => expect(saveAlertSettings).toHaveBeenCalled());
    expect(vi.mocked(saveAlertSettings).mock.calls[0]![0]).toMatchObject({ programEndDays: [45, 10], visaExpiryDays: [60, 30] });
  });

  it('an old ?tab=settings link opens the settings dialog', async () => {
    renderPage('HR_ADMINISTRATOR', '/programs?tab=settings');
    const dialog = await screen.findByRole('dialog', { name: /alert lead times/i });
    expect(await within(dialog).findByText('On the day')).toBeInTheDocument();
  });

  it('with nothing on record, the empty state is the page: no zero tiles, no filters, an Add program', async () => {
    vi.mocked(listPrograms).mockResolvedValue({ programs: [] });
    renderPage();
    expect(await screen.findByText('No programs on record')).toBeInTheDocument();
    expect(screen.getByText(/one person through one visa season/)).toBeInTheDocument();
    expect(screen.queryByText('Active programs')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Program type' })).not.toBeInTheDocument();
    // The header's primary and the empty state's own button.
    expect(screen.getAllByRole('button', { name: /add program/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('the header holds Add program; the J-1 ghost link is gone', async () => {
    renderPage();
    await screen.findByText('Maria Lopez');
    expect(screen.queryByRole('link', { name: /J-1 compliance tab/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /add program/i })[0]!);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('the calendar PDF is a quiet button, off when the window is empty', async () => {
    const { getTransitionCalendar } = await import('@/lib/programsApi');
    vi.mocked(getTransitionCalendar).mockResolvedValue({ months: ['2026-10'], cells: [], totals: { arrivals: 0, programEnds: 0, departures: 0 } } as never);
    renderPage('HR_ADMINISTRATOR', '/programs?tab=calendar');
    expect(await screen.findByText('Nothing in this window')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeDisabled();
  });
});
