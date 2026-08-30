import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationDetail as ApplicationDetailType } from '@alto-people/shared';

// The e-sign section fetches agreements on mount — out of scope here.
vi.mock('@/pages/onboarding/EsignSection', () => ({
  EsignSection: () => null,
}));
vi.mock('@/lib/onboardingApi', () => ({
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
}));
// HR_ADMINISTRATOR holds both manage:onboarding (Section 2 verify) and
// manage:documents (per-document reject).
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' },
    can: () => true,
  }),
}));

import {
  getApplication,
  getApplicationAudit,
  nextReviewApplication,
} from '@/lib/onboardingApi';
import { getI9Status, listI9Documents, submitI9Section2 } from '@/lib/i9Api';
import { rejectDocument } from '@/lib/documentsApi';
import { ApplicationDetailBody } from '@/pages/onboarding/ApplicationDetail';

const APP_ID = '00000000-0000-4000-8000-00000000aaaa';
const ASSOC_ID = '00000000-0000-4000-8000-00000000cccc';
const CLIENT_ID = '00000000-0000-4000-8000-00000000dddd';
const TASK_ID = '00000000-0000-4000-8000-00000000eeee';
const DOC_PASSPORT = '00000000-0000-4000-8000-0000000d0001';
const DOC_LICENSE = '00000000-0000-4000-8000-0000000d0002';

function detailFixture(): ApplicationDetailType {
  return {
    id: APP_ID,
    associateId: ASSOC_ID,
    clientId: CLIENT_ID,
    associateName: 'Maria Lopez',
    clientName: 'Acme Resort',
    onboardingTrack: 'STANDARD',
    status: 'SUBMITTED',
    position: 'Server',
    startDate: null,
    invitedAt: '2026-08-01T12:00:00.000Z',
    submittedAt: '2026-08-05T12:00:00.000Z',
    percentComplete: 86,
    employmentType: 'W2_EMPLOYEE',
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    hireDate: null,
    tasks: [
      {
        id: TASK_ID,
        kind: 'I9_VERIFICATION',
        status: 'IN_PROGRESS',
        title: 'I-9 verification',
        description: null,
        order: 1,
        documentId: null,
        completedAt: null,
      },
    ],
  };
}

const passportDoc = {
  id: DOC_PASSPORT,
  kind: 'ID' as const,
  filename: 'passport.jpg',
  mimeType: 'image/jpeg',
  size: 100_000,
  status: 'UPLOADED' as const,
  side: null,
  i9DocTitle: 'U.S. Passport or Passport Card',
  i9List: 'A' as const,
  createdAt: '2026-08-05T12:01:00.000Z',
  fileAvailable: true,
};

function section2PendingStatus() {
  return {
    associateId: ASSOC_ID,
    section1: {
      completedAt: '2026-08-05T12:00:00.000Z',
      citizenshipStatus: 'US_CITIZEN' as const,
      workAuthExpiresAt: null,
      hasAlienNumber: false,
      typedName: 'Maria Lopez',
    },
    documentsSubmittedAt: '2026-08-05T12:01:00.000Z',
    section2: null,
  };
}

function renderDrawerBody() {
  // Fresh client per render so cached queries never leak between tests;
  // retry off so mocked failures surface immediately.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/onboarding?applicationId=${APP_ID}`]}>
        <ApplicationDetailBody applicationId={APP_ID} mode="drawer" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApplication).mockResolvedValue(detailFixture());
  vi.mocked(getApplicationAudit).mockResolvedValue({ entries: [] });
  vi.mocked(nextReviewApplication).mockResolvedValue({
    applicationId: null,
    remaining: 0,
  });
  vi.mocked(getI9Status).mockResolvedValue(section2PendingStatus());
  vi.mocked(listI9Documents).mockResolvedValue({ documents: [passportDoc] });
});

describe('ApplicationDetail inline Section 2 verifier', () => {
  it('pre-checks the auto-detected List A doc and enables Verify (1 doc)', async () => {
    renderDrawerBody();

    // Grid tile is a checkbox in verify mode, pre-checked by the classifier.
    const tile = await screen.findByRole('checkbox', {
      name: /u\.s\. passport or passport card/i,
    });
    expect(tile).toBeChecked();

    const verify = screen.getByRole('button', {
      name: /verify section 2 \(1 doc\)/i,
    });
    expect(verify).toBeEnabled();

    // List A auto-picked from the classified upload.
    expect(
      screen.getByRole('radio', { name: /list a/i }),
    ).toBeChecked();

    // The full-verifier deep link survives as a secondary affordance and
    // carries a return path to this application (the drawer isn't
    // URL-synced, so drawer mode returns to the canonical detail route).
    const link = screen.getByRole('link', { name: /open section 2 verifier/i });
    expect(link.getAttribute('href')).toContain(
      `return=${encodeURIComponent(`/onboarding/applications/${APP_ID}`)}`,
    );
  });

  it('verify calls the Section 2 endpoint and refreshes the application detail', async () => {
    vi.mocked(submitI9Section2).mockResolvedValue({
      section2CompletedAt: '2026-08-06T15:00:00.000Z',
      documentList: 'LIST_A',
      supportingDocIds: [DOC_PASSPORT],
    });

    const user = userEvent.setup();
    renderDrawerBody();

    await user.click(
      await screen.findByRole('button', { name: /verify section 2 \(1 doc\)/i }),
    );

    await waitFor(() =>
      expect(submitI9Section2).toHaveBeenCalledWith(APP_ID, {
        documentList: 'LIST_A',
        supportingDocIds: [DOC_PASSPORT],
      }),
    );
    // Invalidation refetches the detail (percentComplete / Approve gating)
    // without leaving the drawer.
    await waitFor(() =>
      expect(getApplication).toHaveBeenCalledTimes(2),
    );
  });

  it('hides the inline verifier once Section 2 is complete', async () => {
    vi.mocked(getI9Status).mockResolvedValue({
      ...section2PendingStatus(),
      section2: {
        completedAt: '2026-08-06T15:00:00.000Z',
        verifierEmail: 'hr@altohr.com',
        documentList: 'LIST_A',
        supportingDocIds: [DOC_PASSPORT],
      },
    });

    renderDrawerBody();

    await screen.findByText(/section 2 \(employer\)/i);
    expect(
      screen.queryByRole('button', { name: /verify section 2/i }),
    ).not.toBeInTheDocument();
    // Read-only grid again — no checkboxes.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('rejects a document inline with a preset reason and refreshes the doc list', async () => {
    vi.mocked(rejectDocument).mockResolvedValue({} as never);
    vi.mocked(listI9Documents).mockResolvedValue({
      documents: [
        passportDoc,
        {
          ...passportDoc,
          id: DOC_LICENSE,
          filename: 'license.jpg',
          i9DocTitle: "Driver's license",
          i9List: 'B' as const,
        },
      ],
    });

    const user = userEvent.setup();
    renderDrawerBody();

    // One reject affordance per rejectable (UPLOADED) tile. Matched via the
    // tooltip title — the header also carries a "Reject" (application-level)
    // button.
    const tileRejects = await screen.findAllByTitle(/reject this document/i);
    expect(tileRejects).toHaveLength(2);
    await user.click(tileRejects[1]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('license.jpg')).toBeInTheDocument();
    // Preset fills the required reason field, then confirm.
    await user.click(
      within(dialog).getByRole('button', { name: /blurry \/ unreadable/i }),
    );
    await user.click(within(dialog).getByRole('button', { name: /^reject$/i }));

    await waitFor(() =>
      expect(rejectDocument).toHaveBeenCalledWith(DOC_LICENSE, {
        reason: 'Blurry / unreadable',
      }),
    );
    // Invalidation refetches the I-9 documents and the detail.
    await waitFor(() => expect(listI9Documents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getApplication).toHaveBeenCalledTimes(2));
  });
});
