import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import userEvent from '@testing-library/user-event';
import type {
  ApplicationDetail,
  ApplicationStatsResponse,
  ApplicationSummary,
  OnboardingAnalyticsResponse,
  OnboardingTemplate,
} from '@alto-people/shared';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { renderAs } from '../hrPack/harness';

/**
 * F500 G1 — the onboarding desk (2026-10-22):
 *   - /onboarding: five tiles that are the list's filters, one primary and
 *     one secondary in the header with Import/Export in More, the section
 *     strip instead of Analytics/Templates buttons, an Owner column, no
 *     all-dash Start column, the stuck banner's "Nudge all";
 *   - /onboarding/templates: a table with "In use", Delete in the row menu;
 *   - /onboarding/analytics: one unit per duration, no red zero, "too few
 *     to tell" under three, the conversion line;
 *   - the template editor: one line per task until opened;
 *   - in person: "Skipped" is not "Submitted", every open step of theirs.
 */

vi.mock('@/lib/onboardingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/onboardingApi')>()),
  listApplications: vi.fn(),
  getApplicationStats: vi.fn(),
  listTemplates: vi.fn(),
  listClients: vi.fn(async () => ({ clients: [], total: 0, nextCursor: null })),
  listClientOptions: vi.fn(async () => ({ clients: [], total: 0, nextCursor: null })),
  deleteTemplate: vi.fn(),
  getApplication: vi.fn(),
  resendInvite: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/clientsApi')>()),
  listClients: vi.fn(async () => ({ clients: [], total: 0, nextCursor: null })),
}));
vi.mock('@/lib/analyticsApi', () => ({ getOnboardingAnalytics: vi.fn() }));
vi.mock('@/lib/documentsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/documentsApi')>()),
  listAdminDocuments: vi.fn(async () => ({ documents: [] })),
}));
vi.mock('@/pages/onboarding/ApplicationDetail', () => ({ ApplicationDetailBody: () => null }));
vi.mock('@/pages/onboarding/BulkApproveDialog', () => ({ BulkApproveDialog: () => null }));
vi.mock('@/pages/onboarding/BulkInviteDialog', () => ({ BulkInviteDialog: () => null }));
vi.mock('@/pages/onboarding/CsvImportDialog', () => ({ CsvImportDialog: () => null }));
vi.mock('@/pages/onboarding/NewApplicationDialog', () => ({ NewApplicationDialog: () => null }));
vi.mock('@/pages/onboarding/NudgeDialog', () => ({ NudgeDialog: () => null }));

import {
  deleteTemplate,
  getApplication,
  getApplicationStats,
  listApplications,
  listTemplates,
} from '@/lib/onboardingApi';
import { getOnboardingAnalytics } from '@/lib/analyticsApi';
import { ApplicationsList } from '@/pages/onboarding/ApplicationsList';
import { TemplatesList } from '@/pages/onboarding/TemplatesList';
import { TemplateEditor } from '@/pages/onboarding/TemplateEditor';
import { OnboardingAnalytics, fmtDuration, medianPhrase } from '@/pages/onboarding/OnboardingAnalytics';
import { InPersonOnboarding } from '@/pages/onboarding/InPersonOnboarding';
import { Route, Routes, RouterProvider, createMemoryRouter } from 'react-router-dom';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, over: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    id: ID(n),
    associateName: `Hire ${n}`,
    clientName: 'Acme Resort',
    onboardingTrack: 'STANDARD',
    status: 'DRAFT',
    position: 'Server',
    startDate: null,
    invitedAt: '2026-10-01T12:00:00.000Z',
    submittedAt: null,
    percentComplete: 40,
    ownerName: null,
    ...over,
  };
}

const STATS: ApplicationStatsResponse = {
  total: 20,
  byStatus: { DRAFT: 2, SUBMITTED: 1, IN_REVIEW: 1, APPROVED: 15, REJECTED: 1, CANCELLED: 0 } as ApplicationStatsResponse['byStatus'],
  inFlight: 4,
  stale: 1,
  bounced: 1,
  avgPercent: 50,
  staleSamples: [row(9, { associateName: 'Quinn Quiet', lastActivityAt: new Date(Date.now() - 12 * 86_400_000).toISOString() })],
  bouncedSamples: [row(8, { associateName: 'Bo Bounce' })],
  idleDrafts: 1,
  startingSoon: 3,
  startingSoonUnfinished: 2,
};

const list = (ui: React.ReactNode, route = '/') =>
  renderAs('HR_ADMINISTRATOR', <TooltipProvider>{ui}</TooltipProvider>, route);

describe('/onboarding — the desk list', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getApplicationStats).mockResolvedValue(STATS);
    vi.mocked(listApplications).mockImplementation(async (f) => {
      const applications =
        f.status === 'STARTING_SOON'
          ? [row(3, { associateName: 'Sam Soon', startDate: '2026-10-25', ownerName: 'Ana Recruiter' })]
          : [row(1, { associateName: 'Dana Draft', ownerName: 'Ana Recruiter' }), row(2, { associateName: 'Eli Early' })];
      return { applications, total: applications.length, page: 1, pageSize: 50 };
    });
  });

  it('the tiles count the attention slices and each one is the filter for the list', async () => {
    list(<ApplicationsList />);
    // Generous waits: the tiles count up, and a loaded machine is slow.
    const strip = await screen.findByRole('group', { name: 'Onboarding at a glance' }, { timeout: 5000 });
    const tile = (name: RegExp) => within(strip).getByRole('button', { name });
    await waitFor(() => expect(tile(/^In flight/)).toHaveTextContent('4'), { timeout: 5000 });
    await waitFor(() => expect(tile(/^Starting in 7 days/)).toHaveTextContent('3'), { timeout: 5000 });
    expect(tile(/^To review/)).toHaveTextContent('2');
    expect(tile(/^Stuck/)).toHaveTextContent('1');
    expect(tile(/^Starting in 7 days/)).toHaveTextContent('3');
    expect(tile(/^Starting in 7 days/)).toHaveTextContent('2 still unfinished');
    expect(tile(/^Email bounced/)).toHaveTextContent('1');
    // Total, Approved and the average are gone.
    expect(within(strip).queryByText(/Avg\. complete/i)).toBeNull();
    expect(within(strip).queryByText(/^Approved$/i)).toBeNull();
    // The stats ask for the caller's own day.
    expect(getApplicationStats).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));

    await userEvent.click(tile(/^Starting in 7 days/));
    await waitFor(() =>
      expect(listApplications).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'STARTING_SOON', today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
      ),
    );
    expect(await screen.findByText('Sam Soon')).toBeInTheDocument();
    expect(tile(/^Starting in 7 days/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('the primary leads; Bulk invite, Import and Export in More; siblings are the section strip', async () => {
    list(<ApplicationsList />);
    await screen.findByText('Dana Draft');
    const row_ = screen.getByTestId('page-actions');
    expect(within(row_).getByRole('button', { name: /New application/ })).toBeInTheDocument();
    // F500 2026-10-26: the primary sat between Bulk invite and More — now it leads, alone.
    expect(within(row_).queryByRole('button', { name: /Bulk invite|Import CSV|Export CSV/ })).toBeNull();
    expect(within(row_).queryByRole('link', { name: /Analytics|Templates/ })).toBeNull();
    // The siblings are a section strip (checked before the menu opens — an
    // open menu hides the rest of the page from the accessibility tree).
    const sections = screen.getByRole('navigation', { name: 'Onboarding' });
    expect(within(sections).getByRole('link', { name: 'Applications' })).toHaveAttribute('href', '/onboarding');
    expect(within(sections).getByRole('link', { name: 'Templates' })).toHaveAttribute('href', '/onboarding/templates');
    expect(within(sections).getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/onboarding/analytics');
    await userEvent.click(within(row_).getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Bulk invite/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Import CSV/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Export CSV/ })).toBeInTheDocument();
  });

  it('shows who owns each application, hides a Start column of dashes, and one count', async () => {
    list(<ApplicationsList />);
    await screen.findByText('Dana Draft');
    expect(screen.getByRole('columnheader', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByText('Ana Recruiter')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Start/ })).toBeNull();
    // One count: the grid's, from the filter's real total.
    expect(screen.getByText('2 applications')).toBeInTheDocument();
    expect(screen.queryByText(/shown$/)).toBeNull();
    // The grid's own Export is gone (the header's More has the all-pages one).
    expect(screen.queryByRole('button', { name: /^Export$/ })).toBeNull();
  });

  it('the stuck banner counts idle days from the last activity, and holds "Nudge all"', async () => {
    list(<ApplicationsList />);
    expect(await screen.findByText(/1 application stuck — nothing moved in 7 days/)).toBeInTheDocument();
    expect(screen.getByText('(12d idle)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nudge all \(1\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(listApplications).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'STUCK' })));
  });

  it('an empty default view says nobody is mid-onboarding, not "no match"', async () => {
    vi.mocked(listApplications).mockResolvedValue({ applications: [], total: 0, page: 1, pageSize: 50 });
    list(<ApplicationsList />);
    expect(await screen.findByText('Nobody is mid-onboarding')).toBeInTheDocument();
    expect(screen.getByText(/16 in Archived/)).toBeInTheDocument();
  });
});

const TEMPLATES: OnboardingTemplate[] = [
  {
    id: ID(11),
    clientId: null,
    track: 'STANDARD',
    name: 'Standard onboarding',
    updatedAt: '2026-09-18T15:00:00.000Z',
    inUse: 3,
    tasks: [
      { id: ID(21), kind: 'PROFILE_INFO', title: 'Profile', description: null, order: 0 },
      { id: ID(22), kind: 'W4', title: 'W-4', description: null, order: 1 },
    ],
  },
  { id: ID(12), clientId: null, track: 'J1', name: 'J-1 onboarding', updatedAt: '2026-08-01T15:00:00.000Z', inUse: 0, tasks: [] },
];

describe('/onboarding/templates — a table', () => {
  beforeEach(() => {
    vi.mocked(listTemplates).mockResolvedValue({ templates: TEMPLATES });
    vi.mocked(deleteTemplate).mockResolvedValue(undefined as never);
  });

  it('lists name, track, client, tasks, in use and last edited; Delete is in the row menu behind a confirm', async () => {
    list(<TemplatesList />);
    expect(await screen.findByText('Standard onboarding')).toBeInTheDocument();
    for (const h of ['Track', 'Client', 'Tasks', 'In use', 'Last edited']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(h) })).toBeInTheDocument();
    }
    expect(screen.getByText('3 in flight')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    // No trash can on the row itself.
    expect(screen.queryByRole('button', { name: /Delete template/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for J-1 onboarding' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith(ID(12)));
  });
});

describe('the template editor — one line per task until opened', () => {
  it('collapses tasks to kind, title and due; opening one shows its fields', async () => {
    vi.mocked(listTemplates).mockResolvedValue({ templates: TEMPLATES });
    // The editor guards unsaved changes (useBlocker): a data router, like production.
    const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
    const router = createMemoryRouter(
      [
        {
          path: '/onboarding/templates/:id',
          element: (
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
              <AuthContext.Provider
                value={{
                  isInitializing: false,
                  isOffline: false,
                  user: { id: 'u1', email: 'hr@example.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null } as never,
                  role: 'HR_ADMINISTRATOR',
                  primaryRole: 'HR_ADMINISTRATOR',
                  availableRoles: ['HR_ADMINISTRATOR'],
                  capabilities: caps,
                  tenant: DEFAULT_TENANT,
                  signIn: vi.fn(),
                  submitMfaChallenge: vi.fn(),
                  signOut: vi.fn(),
                  refreshUser: vi.fn(),
                  switchRole: vi.fn(),
                  can: (c: Capability) => caps.has(c),
                }}
              >
                <TemplateEditor />
              </AuthContext.Provider>
            </QueryClientProvider>
          ),
        },
      ],
      { initialEntries: [`/onboarding/templates/${ID(11)}`] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText('Each client can have one template per hiring track.');
    const first = screen.getAllByRole('button').find((b) => b.getAttribute('aria-expanded') !== null && /Profile · Profile information/.test(b.textContent ?? ''))!;
    expect(first).toBeTruthy();
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Title')).toBeNull();
    await userEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(/Title/)).toHaveValue('Profile');
  });
});

const ANALYTICS: OnboardingAnalyticsResponse = {
  windowDays: 90,
  byStatus: { DRAFT: 2, SUBMITTED: 1, IN_REVIEW: 0, APPROVED: 6, REJECTED: 0, CANCELLED: 1 },
  completion: { medianDays: 0.125, p90Days: 4.24, sample: 7 },
  byTrack: [{ track: 'STANDARD', count: 10, medianDays: 1.5, completed: 7 }],
  byClient: [
    { clientId: ID(31), clientName: 'Few Finished Co', count: 4, medianDays: 2, completed: 2 },
    { clientId: ID(32), clientName: 'Nobody Yet Inc', count: 2, medianDays: null, completed: 0 },
  ],
  monthly: [],
};

describe('/onboarding/analytics', () => {
  it('formats durations with one unit each', () => {
    expect(fmtDuration(0.125)).toBe('3 h');
    expect(fmtDuration(0.01)).toBe('Under 1 h');
    expect(fmtDuration(4.24)).toBe('4.2 days');
    expect(fmtDuration(1)).toBe('1.0 day');
    expect(fmtDuration(null)).toBe('—');
    expect(medianPhrase(2, 2)).toBe('2 finished · too few to tell');
    expect(medianPhrase(null, 0)).toBe('none finished yet');
    expect(medianPhrase(1.5, 7)).toBe('median 1.5 days');
  });

  it('labels the median in words, never reds a zero, and draws the conversion line', async () => {
    vi.mocked(getOnboardingAnalytics).mockResolvedValue(ANALYTICS);
    list(<OnboardingAnalytics />);
    expect(await screen.findByText('Time to complete (median)')).toBeInTheDocument();
    expect(screen.getByText('3 h')).toBeInTheDocument();
    expect(screen.getByText('4.2 days')).toBeInTheDocument();
    const funnel = screen.getByRole('group', { name: 'Applications by status' });
    const rejected = within(funnel).getByRole('link', { name: /Rejected/ });
    expect(rejected).toHaveAttribute('href', '/onboarding?status=REJECTED');
    expect(rejected.querySelector('.text-alert')).toBeNull();
    // 10 invited → 7 reached HR (submitted 1 + approved 6) → 6 approved.
    expect(screen.getByTestId('onboarding-conversion')).toHaveTextContent('10 invited7 reached HR (70%)6 approved (86% of those)');
    expect(screen.getByText(/2 finished · too few to tell/)).toBeInTheDocument();
    expect(screen.getByText(/none finished yet/)).toBeInTheDocument();
  });
});

function detail(over: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return {
    ...row(5, { associateName: 'Maria Lopez', status: 'DRAFT', percentComplete: 38 }),
    associateId: ID(41),
    clientId: ID(42),
    employmentType: 'W2_EMPLOYEE',
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    hireDate: null,
    tasks: [
      { id: ID(51), kind: 'PROFILE_INFO', status: 'PENDING', title: 'Profile', description: null, order: 0, documentId: null, completedAt: null },
      { id: ID(52), kind: 'PROFILE_PHOTO', status: 'PENDING', title: 'Photo', description: null, order: 1, documentId: null, completedAt: null },
      { id: ID(53), kind: 'DOCUMENT_UPLOAD', status: 'SKIPPED', title: 'IDs', description: null, order: 2, documentId: null, completedAt: null },
      { id: ID(54), kind: 'W4', status: 'PENDING', title: 'W-4', description: null, order: 3, documentId: null, completedAt: null },
      { id: ID(55), kind: 'POLICY_ACK', status: 'PENDING', title: 'Policies', description: null, order: 4, documentId: null, completedAt: null },
    ],
    ...over,
  } as ApplicationDetail;
}

describe('/onboarding/in-person/:id', () => {
  it('a skipped document step says Skipped, and the hand-off lists every open step of theirs', async () => {
    vi.mocked(getApplication).mockResolvedValue(detail());
    renderAs(
      'HR_ADMINISTRATOR',
      <Routes>
        <Route path="/onboarding/in-person/:applicationId" element={<InPersonOnboarding />} />
      </Routes>,
      `/onboarding/in-person/${ID(5)}`,
    );
    expect(await screen.findByText('1. Scan identity documents')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.queryByText('Submitted')).toBeNull();
    // Profile, photo and policies are theirs too — not only the signatures.
    for (const label of ['Profile info', 'Profile photo', 'W-4 tax form', 'Policy acknowledgement']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Sign out and hand over/ })).toBeInTheDocument();
  });

  it('hands the device over by signing HR out after a confirm', async () => {
    vi.mocked(getApplication).mockResolvedValue(detail());
    const view = renderAs(
      'HR_ADMINISTRATOR',
      <Routes>
        <Route path="/onboarding/in-person/:applicationId" element={<InPersonOnboarding />} />
        <Route path="/login" element={<p>Sign-in page</p>} />
      </Routes>,
      `/onboarding/in-person/${ID(5)}`,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Sign out and hand over/ }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out and hand over' }));
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    view.unmount();
  });
});
