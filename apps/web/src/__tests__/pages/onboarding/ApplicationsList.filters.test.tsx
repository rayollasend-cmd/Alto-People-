import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationStatsResponse, ApplicationSummary } from '@alto-people/shared';

// DataGrid reads AuthContext directly (per-user column preferences), so the
// mock exports the context as well as the hook.
vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth };
});
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('@/lib/onboardingApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onboardingApi')>()),
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
      const submittedOnly = filters.status === 'SUBMITTED';
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

    await userEvent.click(screen.getByRole('button', { name: /^Submitted/ }));

    await waitFor(() =>
      expect(listApplications).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'SUBMITTED', page: 1 })),
    );
    expect(await screen.findByText('Sam Submitted')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Dana Draft')).not.toBeInTheDocument());
  });
});
