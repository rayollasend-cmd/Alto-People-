import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationStatsResponse, ApplicationSummary } from '@alto-people/shared';

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
vi.mock('@/pages/onboarding/ApplicationDetail', () => ({ ApplicationDetailBody: () => null }));
vi.mock('@/pages/onboarding/BulkApproveDialog', () => ({ BulkApproveDialog: () => null }));
vi.mock('@/pages/onboarding/BulkInviteDialog', () => ({ BulkInviteDialog: () => null }));
vi.mock('@/pages/onboarding/CsvImportDialog', () => ({ CsvImportDialog: () => null }));
vi.mock('@/pages/onboarding/NewApplicationDialog', () => ({ NewApplicationDialog: () => null }));
vi.mock('@/pages/onboarding/NudgeDialog', () => ({ NudgeDialog: () => null }));

import { getApplicationStats, listApplications } from '@/lib/onboardingApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ApplicationsList } from '@/pages/onboarding/ApplicationsList';

/**
 * Wave 2 (role walk HR 2 / 15): the applications list has an "Idle drafts"
 * filter — drafts nobody has moved in a week — and the Inbox's "drafts gone
 * quiet" link (?status=IDLE_DRAFTS) opens on it, with its count on the chip.
 */

const quiet: ApplicationSummary = {
  id: '00000000-0000-4000-8000-000000000009',
  associateName: 'Quinn Quiet',
  clientName: 'Acme Resort',
  onboardingTrack: 'STANDARD',
  status: 'DRAFT',
  position: 'Server',
  startDate: null,
  invitedAt: '2026-09-01T12:00:00.000Z',
  submittedAt: null,
  percentComplete: 20,
};
const stats: ApplicationStatsResponse = {
  total: 3,
  byStatus: { DRAFT: 2, SUBMITTED: 1 },
  inFlight: 3,
  stale: 1,
  bounced: 0,
  avgPercent: 40,
  staleSamples: [],
  bouncedSamples: [],
  idleDrafts: 1,
};

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(getApplicationStats).mockResolvedValue(stats);
  vi.mocked(listApplications).mockResolvedValue({ applications: [quiet], total: 1, page: 1, pageSize: 50 });
});

// F500 SH-4: "Idle drafts" is now "Stuck" — the one rule the banner, the tile and the rows share.
// An old ?status=IDLE_DRAFTS link still lands on it.
describe('ApplicationsList — stuck', () => {
  it('the Inbox link (old or new) opens the filter, and the chip carries its count', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/onboarding?status=IDLE_DRAFTS']}>
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <ApplicationsList />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Quinn Quiet')).toBeInTheDocument();
    expect(listApplications).toHaveBeenCalledWith(expect.objectContaining({ status: 'STUCK', page: 1 }));
    const chip = await screen.findByRole('button', { name: /^Stuck\s*\d*$/ });
    await waitFor(() => expect(chip).toHaveTextContent('1'));
  });

  it('the chip asks for the stuck applications', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <ApplicationsList />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /^Stuck\s*\d*$/ }));
    await waitFor(() => expect(listApplications).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'STUCK' })));
  });
});
