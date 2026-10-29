import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationDetail as ApplicationDetailType } from '@alto-people/shared';

/**
 * PEOPLE-17: a task card says DONE only when its evidence is on file. A W-4
 * marked done with no W-4 behind it reads "Marked done — nothing on file",
 * and Approve — even the one-click approve — lists it first.
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
  getFirstDay: vi.fn(),
  patchFirstDay: vi.fn(),
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

import { getApplication, getApplicationAudit, getFirstDay, getW4, nextReviewApplication } from '@/lib/onboardingApi';
import { getI9Status, listI9Documents } from '@/lib/i9Api';
import { getAssociatePaySchedule } from '@/lib/payScheduleFlowApi';
import { ApplicationDetailBody, missingEvidenceWarnings } from '@/pages/onboarding/ApplicationDetail';

const APP_ID = '00000000-0000-4000-8000-00000000aaaa';
const ASSOC_ID = '00000000-0000-4000-8000-00000000cccc';

const TASKS = [
  { id: 't1', kind: 'W4', status: 'DONE', title: 'W-4', description: null, order: 0, documentId: null, completedAt: '2026-08-02T12:00:00.000Z', evidence: 'missing' },
  { id: 't2', kind: 'PROFILE_INFO', status: 'DONE', title: 'Profile', description: null, order: 1, documentId: null, completedAt: '2026-08-02T12:00:00.000Z', evidence: 'on_file' },
] as ApplicationDetailType['tasks'];

function detailFixture(): ApplicationDetailType {
  return {
    id: APP_ID,
    associateId: ASSOC_ID,
    clientId: '00000000-0000-4000-8000-00000000dddd',
    associateName: 'Sophia Delgado',
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
    tasks: TASKS,
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
  vi.mocked(getW4).mockResolvedValue({ hasSubmission: false } as never);
  vi.mocked(getAssociatePaySchedule).mockResolvedValue({
    current: null,
    pending: null,
    ruleDefault: { scheduleId: '00000000-0000-4000-8000-00000000ffff', name: 'Weekly', because: 'Client: Acme Resort' },
    nextPayDate: null,
  });
  vi.mocked(getFirstDay).mockResolvedValue({
    startDate: null,
    store: null,
    stores: [],
    manager: null,
    employeeNumber: { issued: false, clientId: null, validAtClient: false },
    firstShift: null,
    i9: { section1CompletedAt: null, section2CompletedAt: null, section2DueBy: null },
  });
});

describe('task status from the evidence (PEOPLE-17)', () => {
  it('a DONE W-4 with nothing on file reads "Marked done — nothing on file"; one with evidence reads Done', async () => {
    renderBody();
    const badge = await screen.findByText('Marked done — nothing on file');
    expect(badge).toHaveAttribute('data-evidence', 'missing');
    expect(screen.getByText(/Someone marked this done, but nothing is on file yet/)).toBeInTheDocument();
    // The profile's evidence is there: plain Done.
    expect(document.querySelector('[data-evidence="on_file"]')).toHaveTextContent('Done');
  });

  it('Approve (the one-click one too) lists what is missing before it goes through', async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(await screen.findByRole('button', { name: /Approve · starts/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve onboarding' });
    expect(within(dialog).getByText('W-4 tax withholding is marked done, but nothing is on file.')).toBeInTheDocument();
  });

  it('says one line per unbacked task, in the page’s words', () => {
    expect(missingEvidenceWarnings(TASKS)).toEqual(['W-4 tax withholding is marked done, but nothing is on file.']);
  });
});
