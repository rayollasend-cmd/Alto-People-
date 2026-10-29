import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationStatsResponse, ApplicationSummary } from '@alto-people/shared';

// DataGrid reads AuthContext directly (per-user column preferences), so the
// mock exports the context as well as the hook.
vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true };
  const shared = await import('@alto-people/shared');
  const alto = shared.defaultTenantProfile('WORKFORCE_PROVIDER');
  const terms = shared.termsIn(alto, 'en');
  const useTerm = () => (k: keyof typeof terms) => terms[k];
  const useTenant = () => ({ id: '', ...alto, moduleOn: (m: keyof typeof alto.modules) => alto.modules[m] });
  return { AuthContext: React.createContext(auth), useAuth: () => auth, useTerm, useTenant };
});
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('@/lib/onboardingApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onboardingApi')>()),
  // The invite-scoped client picker (GET /clients/options).
  listClientOptions: vi.fn(async () => ({ clients: [] })),
  listApplications: vi.fn(),
  getApplicationStats: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/clientsApi')>()),
  listClients: vi.fn(async () => ({ clients: [], total: 0, nextCursor: null })),
}));
// Dialogs and the detail drawer carry their own queries and tests.
vi.mock('@/pages/onboarding/ApplicationDetail', () => ({ ApplicationDetailBody: () => null }));
vi.mock('@/pages/onboarding/BulkApproveDialog', () => ({ BulkApproveDialog: () => null }));
vi.mock('@/pages/onboarding/BulkInviteDialog', () => ({ BulkInviteDialog: () => null }));
vi.mock('@/pages/onboarding/CsvImportDialog', () => ({ CsvImportDialog: () => null }));
vi.mock('@/pages/onboarding/NewApplicationDialog', () => ({ NewApplicationDialog: () => null }));
vi.mock('@/pages/onboarding/NudgeDialog', () => ({ NudgeDialog: () => null }));

import { getApplicationStats, listApplications } from '@/lib/onboardingApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ApplicationsList } from '@/pages/onboarding/ApplicationsList';

function summary(id: string, associateName: string, status: ApplicationSummary['status']): ApplicationSummary {
  return {
    id,
    associateName,
    clientName: 'Acme Resort',
    onboardingTrack: 'STANDARD',
    status,
    position: 'Server',
    startDate: null,
    invitedAt: '2026-09-01T12:00:00.000Z',
    submittedAt: status === 'SUBMITTED' ? '2026-09-02T12:00:00.000Z' : null,
    percentComplete: status === 'SUBMITTED' ? 100 : 40,
  };
}

const stats: ApplicationStatsResponse = {
  total: 2,
  byStatus: { DRAFT: 1, SUBMITTED: 1 },
  inFlight: 2,
  stale: 0,
  bounced: 0,
  avgPercent: 70,
  staleSamples: [],
  bouncedSamples: [],
};

/**
 * The list's query was keyed ['ApplicationsList', 'items'] with none of its
 * five filters in it (9fab056f), so picking a status fetched nothing and the
 * grid kept showing the previous answer. The key now carries every input:
 * a status chip is a new request, and the rows are that request's rows.
 */
describe('ApplicationsList — filters drive the fetch', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getApplicationStats).mockResolvedValue(stats);
    vi.mocked(listApplications).mockImplementation(async (filters) => {
      const submittedOnly = filters.status === 'TO_REVIEW';
      const applications = submittedOnly
        ? [summary('00000000-0000-4000-8000-000000000002', 'Sam Submitted', 'SUBMITTED')]
        : [
            summary('00000000-0000-4000-8000-000000000001', 'Dana Draft', 'DRAFT'),
            summary('00000000-0000-4000-8000-000000000002', 'Sam Submitted', 'SUBMITTED'),
          ];
      return { applications, total: applications.length, page: 1, pageSize: 50 };
    });
  });

  it('a status chip issues a new request and shows only its rows', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <ApplicationsList />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Dana Draft')).toBeInTheDocument();
    expect(listApplications).toHaveBeenCalledWith(expect.objectContaining({ status: 'ACTIVE', page: 1 }));

    // F500 G1: "Submitted" and "In review" are one chip, "To review" (the Inbox's count).
    await userEvent.click(within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name: /^To review/ }));

    await waitFor(() =>
      expect(listApplications).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'TO_REVIEW', page: 1 })),
    );
    expect(await screen.findByText('Sam Submitted')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Dana Draft')).not.toBeInTheDocument());
  });
});

/**
 * Role walk HR 15: on a phone the filters (client, status, invited, saved
 * views) took the whole first screen before the single row. Below sm they
 * sit behind one "Filters (n)" chip that opens a bottom sheet; the search
 * stays on the page and the rows are the first screen.
 */
describe('ApplicationsList — on a phone the filters sit behind one chip', () => {
  const original = window.matchMedia;
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getApplicationStats).mockResolvedValue(stats);
    vi.mocked(listApplications).mockImplementation(async (filters) => {
      const applications =
        filters.status === 'TO_REVIEW'
          ? [summary('00000000-0000-4000-8000-000000000002', 'Sam Submitted', 'SUBMITTED')]
          : [summary('00000000-0000-4000-8000-000000000001', 'Dana Draft', 'DRAFT')];
      return { applications, total: applications.length, page: 1, pageSize: 50 };
    });
    // jsdom's matchMedia stub matches every min-width; a phone matches none.
    window.matchMedia = ((query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  const renderList = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    return render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <ApplicationsList />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  };

  it('shows the rows and the search, with the filters folded into "Filters"', async () => {
    renderList();
    expect(await screen.findByText('Dana Draft')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search by name or email…')).toBeInTheDocument();
    // No status chips and no invited-date picker on the page itself.
    expect(screen.queryByRole('group', { name: 'Filter by status' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Filter by invite date' })).toBeNull();
    const chip = screen.getByTestId('onboarding-filter-chip');
    expect(chip).toHaveTextContent(/^Filters$/);
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('the chip opens a sheet holding the filters; picking one narrows the list and the chip counts it', async () => {
    renderList();
    await screen.findByText('Dana Draft');
    await userEvent.click(screen.getByTestId('onboarding-filter-chip'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('combobox', { name: 'Filter by invite date' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: /^To review/ }));
    await waitFor(() =>
      expect(listApplications).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'TO_REVIEW', page: 1 })),
    );
    await userEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Sam Submitted')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-filter-chip')).toHaveTextContent('Filters (1)');
  });
});

