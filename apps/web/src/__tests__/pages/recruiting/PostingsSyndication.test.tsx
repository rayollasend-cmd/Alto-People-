import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/recruiting90Api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/recruiting90Api')>();
  return {
    ...real,
    listJobPostings: vi.fn(),
    updateJobPosting: vi.fn(async () => ({ ok: true })),
    listInterviewKits: vi.fn(async () => ({ kits: [] })),
    listOffers: vi.fn(async () => ({ offers: [] })),
    listReferrals: vi.fn(async () => ({ referrals: [] })),
  };
});
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn(async () => ({ clients: [] })) }));

import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { listJobPostings, updateJobPosting } from '@/lib/recruiting90Api';
import { RecruitingExtras } from '@/pages/recruiting/RecruitingExtras';

/**
 * Postings reach job boards through a feed, one link per board so every
 * applicant is credited to where they came from; any posting can be kept
 * to the careers page only.
 */

const POSTING = {
  id: 'post-1',
  clientId: null,
  clientName: 'Walmart',
  title: 'Cashier',
  description: 'x',
  location: 'Destin, FL',
  minSalary: '14.00',
  maxSalary: '17.00',
  currency: 'USD',
  slug: 'cashier-destin',
  status: 'OPEN' as const,
  openings: 2,
  hired: 1,
  schedule: 'PART_TIME' as const,
  payUnit: 'HOUR' as const,
  syndicate: true,
  openedAt: '2026-09-20T12:00:00.000Z',
  closedAt: null,
  createdAt: '2026-09-19T12:00:00.000Z',
};

function renderPostings() {
  const role = 'INTERNAL_RECRUITER' as const;
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'me', email: 'r@altohr.com', role, status: 'ACTIVE', clientId: null, associateId: null },
    role,
    primaryRole: role,
    availableRoles: [role],
    capabilities: ROLE_CAPABILITIES[role],
    can: () => true,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refreshUser: vi.fn(),
    switchRole: vi.fn(),
  };
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={['/recruiting/extras?tab=postings']}>
              <RecruitingExtras />
            </MemoryRouter>
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return userEvent.setup();
}

describe('job-board syndication', () => {
  it('gives each board its own feed link', async () => {
    vi.mocked(listJobPostings).mockResolvedValue({ postings: [POSTING] } as never);
    renderPostings();
    expect(await screen.findByText(/1 of 1 open posting in the feeds/)).toBeInTheDocument();
    for (const [name, key] of [['Indeed', 'indeed'], ['ZipRecruiter', 'ziprecruiter'], ['Glassdoor', 'glassdoor'], ['LinkedIn', 'linkedin']]) {
      expect(screen.getByLabelText(`${name} feed link`)).toHaveValue(
        `${window.location.origin}/api/careers/feed.xml?board=${key}`,
      );
    }
  });

  it('a posting can be kept to the careers page only', async () => {
    vi.mocked(listJobPostings).mockResolvedValue({ postings: [POSTING] } as never);
    const user = renderPostings();
    const table = await screen.findByRole('table', { name: 'Job postings' });
    const toggle = within(table).getByRole('checkbox', { name: 'Cashier: list on job boards' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(updateJobPosting).toHaveBeenCalledWith('post-1', { syndicate: false }));
  });
});
