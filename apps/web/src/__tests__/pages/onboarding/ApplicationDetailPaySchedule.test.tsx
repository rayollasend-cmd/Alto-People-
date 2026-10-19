import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationDetail as ApplicationDetailType } from '@alto-people/shared';

/**
 * One-click approve and the hire's pay schedule: a hire the rules put on a
 * schedule is approved in one click that names it; a hire no schedule
 * covers goes through the dialog, where one is chosen.
 */

// The e-sign section fetches agreements on mount — out of scope here.
vi.mock('@/pages/onboarding/EsignSection', () => ({
  EsignSection: () => null,
}));
vi.mock('@/lib/onboardingApi', () => ({
  CANCEL_REASON_LABEL: {},
  cancelApplication: vi.fn(),
  reopenApplication: vi.fn(),
  approveApplication: vi.fn(),
  compliancePacketUrl: (id: string) =>
    `/api/onboarding/applications/${id}/compliance-packet`,
  getApplication: vi.fn(),
  getApplicationAudit: vi.fn(),
  getApplicationPolicies: vi.fn(),
  getDirectDeposit: vi.fn(),
  getProfile: vi.fn(),
  getW4: vi.fn(),
  nextReviewApplication: vi.fn(),
  rejectApplication: vi.fn(),
  resendInvite: vi.fn(),
  skipTask: vi.fn(),
  skipTaskWithReason: vi.fn(),
}));
vi.mock('@/lib/payScheduleFlowApi', () => ({
  PAY_SCHEDULES_FLOW_KEY: ['payScheduleFlow', 'list'],
  getAssociatePaySchedule: vi.fn(),
  setAssociatePaySchedule: vi.fn(),
  getPayScheduleCalendarForFlow: vi.fn(async () => ({ periods: [] })),
  listPaySchedulesForFlow: vi.fn(async () => ({ schedules: [] })),
}));
vi.mock('@/lib/clientsApi', () => ({ listClientLocations: vi.fn(async () => ({ locations: [] })) }));
vi.mock('@/lib/i9Api', () => ({
  getI9Status: vi.fn(),
  listI9Documents: vi.fn(),
  submitI9Section2: vi.fn(),
}));
vi.mock('@/lib/documentsApi', () => ({
  previewDocumentUrl: (id: string) => `/api/documents/${id}/download?inline=1`,
  downloadAllDocumentsUrl: () => '/api/documents/admin/all.zip',
  isPreviewable: () => true,
  rejectDocument: vi.fn(),
  DOCUMENT_KIND_LABEL: { ID: 'ID', I9_SUPPORTING: 'I-9 supporting' },
}));
// HR_ADMINISTRATOR holds both manage:onboarding (Section 2 verify) and
// manage:documents (per-document reject).
vi.mock('@/lib/auth', async () => {
  const shared = await import('@alto-people/shared');
  const alto = shared.defaultTenantProfile('WORKFORCE_PROVIDER');
  const terms = shared.termsIn(alto, 'en');
  const useTerm = () => (k: keyof typeof terms) => terms[k];
  const useTenant = () => ({ id: '', ...alto, moduleOn: (m: keyof typeof alto.modules) => alto.modules[m] });
  return {
    useAuth: () => ({
      user: { role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' },
      can: () => true,
    }),
    useTerm,
    useTenant,
  };
});

import { getApplication, getApplicationAudit, nextReviewApplication } from '@/lib/onboardingApi';
import { getI9Status, listI9Documents } from '@/lib/i9Api';
import { getAssociatePaySchedule } from '@/lib/payScheduleFlowApi';
import { ApplicationDetailBody } from '@/pages/onboarding/ApplicationDetail';

const APP_ID = '00000000-0000-4000-8000-00000000aaaa';
const ASSOC_ID = '00000000-0000-4000-8000-00000000cccc';
const SCHED_ID = '00000000-0000-4000-8000-00000000ffff';

function detailFixture(): ApplicationDetailType {
  return {
    id: APP_ID,
    associateId: ASSOC_ID,
    clientId: '00000000-0000-4000-8000-00000000dddd',
    associateName: 'Maria Lopez',
    clientName: 'Acme Resort',
    onboardingTrack: 'STANDARD',
    status: 'SUBMITTED',
    position: 'Server',
    startDate: '2099-11-02T00:00:00.000Z',
    invitedAt: '2026-08-01T12:00:00.000Z',
    submittedAt: '2026-08-05T12:00:00.000Z',
    percentComplete: 100,
    employmentType: 'W2_EMPLOYEE',
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    hireDate: null,
    tasks: [],
  };
}

function renderBody() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/onboarding/applications/${APP_ID}`]}>
        <ApplicationDetailBody applicationId={APP_ID} mode="page" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApplication).mockResolvedValue(detailFixture());
  vi.mocked(getApplicationAudit).mockResolvedValue({ entries: [] });
  vi.mocked(nextReviewApplication).mockResolvedValue({ applicationId: null, remaining: 0 });
  vi.mocked(getI9Status).mockResolvedValue({ associateId: ASSOC_ID, section1: null, documentsSubmittedAt: null, section2: null });
  vi.mocked(listI9Documents).mockResolvedValue({ documents: [] });
});

describe('one-click approve and the hire’s pay schedule', () => {
  it('names the schedule the rules put the hire on', async () => {
    vi.mocked(getAssociatePaySchedule).mockResolvedValue({
      current: null,
      pending: null,
      ruleDefault: { scheduleId: SCHED_ID, name: 'Weekly Hourly', because: 'Client: Acme Resort' },
      nextPayDate: null,
    });
    renderBody();
    const approve = await screen.findByRole('button', { name: /Approve · starts/ });
    await waitFor(() => expect(approve).toHaveAttribute('title', expect.stringContaining('paid on Weekly Hourly')));
  });

  it('a hire no schedule covers is approved through the dialog, where a schedule is chosen', async () => {
    vi.mocked(getAssociatePaySchedule).mockResolvedValue({ current: null, pending: null, ruleDefault: null, nextPayDate: null });
    const user = userEvent.setup();
    renderBody();
    const approve = await screen.findByRole('button', { name: /^Approve$/ });
    expect(approve).toHaveAttribute('title', expect.stringMatching(/No pay schedule covers this hire/));
    expect(screen.queryByRole('button', { name: /Approve · starts/ })).not.toBeInTheDocument();
    await user.click(approve);
    const dialog = await screen.findByRole('dialog', { name: 'Approve onboarding' });
    expect(within(dialog).getByText(/No pay schedule covers this hire — choose one/)).toBeInTheDocument();
  });
});
