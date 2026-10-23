import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ApplicationDetail, Capability, ChecklistTask } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

/**
 * The onboarding task shell after the F500 fix-up (2026-10-22):
 *  - "Step N of M" from the application's own checklist;
 *  - a step that isn't on this hire's checklist says so instead of
 *    rendering a form for it (WOTC, J-1 papers on a Standard hire);
 *  - the continue button is "Save & continue" with "Next: …" under it,
 *    not "Save payout method & continue → Policies" running off a phone.
 */

vi.mock('@/lib/onboardingApi', () => ({
  getApplication: vi.fn(),
  authorizeBackgroundCheck: vi.fn(),
  submitDirectDeposit: vi.fn(async () => {}),
  getDirectDeposit: vi.fn(async () => ({
    hasPayoutMethod: false,
    type: null,
    accountType: null,
    routingMasked: null,
    accountLast4: null,
    branchCardId: null,
    verifiedAt: null,
    updatedAt: null,
  })),
}));

vi.mock('@/lib/taxcompApi', () => ({
  WOTC_QUESTIONS: ['veteran'],
  getWotcApplicant: vi.fn(async () => ({ screening: null })),
  submitWotcApplicant: vi.fn(),
}));

import { getApplication, submitDirectDeposit } from '@/lib/onboardingApi';
import { DirectDepositTask } from '@/pages/onboarding/tasks/DirectDepositTask';
import { WotcScreeningTask } from '@/pages/onboarding/tasks/WotcScreeningTask';
import { BackgroundCheckTask } from '@/pages/onboarding/tasks/BackgroundCheckTask';

const APP_ID = '00000000-0000-4000-8000-00000000eeee';

let n = 0;
function task(kind: string, status: ChecklistTask['status'] = 'PENDING'): ChecklistTask {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    kind: kind as ChecklistTask['kind'],
    status,
    title: kind,
    description: null,
    order: n,
    documentId: null,
    completedAt: null,
  };
}

function application(tasks: ChecklistTask[]): ApplicationDetail {
  return {
    id: APP_ID,
    associateName: 'Maria Lopez',
    clientName: 'Seaside Hospitality Group',
    onboardingTrack: 'STANDARD',
    status: 'DRAFT',
    position: null,
    startDate: null,
    invitedAt: new Date().toISOString(),
    submittedAt: null,
    percentComplete: 25,
    associateId: '00000000-0000-4000-8000-0000000000a1',
    clientId: '00000000-0000-4000-8000-0000000000c1',
    tasks,
    employmentType: 'W2_EMPLOYEE',
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    hireDate: null,
  } as ApplicationDetail;
}

function renderAt(path: string, element: ReactNode) {
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'maria@example.com',
      role: 'ASSOCIATE' as const,
      status: 'ACTIVE' as const,
      clientId: null,
      associateId: 'a',
    },
    role: 'ASSOCIATE' as const,
    capabilities: new Set<Capability>(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => false,
  };
  return rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/onboarding/me/:applicationId/tasks/:kind" element={element} />
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getApplication).mockReset();
  vi.mocked(submitDirectDeposit).mockClear();
});

describe('onboarding task shell (F500)', () => {
  it('says which step this is: "Step 3 of 4"', async () => {
    vi.mocked(getApplication).mockResolvedValue(
      application([task('PROFILE_INFO', 'DONE'), task('W4', 'DONE'), task('DIRECT_DEPOSIT'), task('POLICY_ACK')]),
    );
    renderAt(`/onboarding/me/${APP_ID}/tasks/direct_deposit`, <DirectDepositTask />);
    expect(await screen.findByTestId('task-step')).toHaveTextContent('Step 3 of 4');
  });

  it('puts the next step under the button instead of in it', async () => {
    vi.mocked(getApplication).mockResolvedValue(
      application([task('PROFILE_INFO', 'DONE'), task('DIRECT_DEPOSIT'), task('POLICY_ACK')]),
    );
    renderAt(`/onboarding/me/${APP_ID}/tasks/direct_deposit`, <DirectDepositTask />);
    const button = await screen.findByRole('button', { name: /save & continue/i });
    expect(button).toHaveTextContent('Save & continue');
    expect(button).toHaveTextContent('Next: Policies');
    // The long form that overflowed a 390px screen is gone.
    expect(button).not.toHaveTextContent('Save payout method & continue');
    expect(button).not.toHaveTextContent('→');
    // It shrinks with the screen instead of refusing to wrap past the edge.
    expect(button.className).toMatch(/\bmin-w-0\b/);
    expect(button.className).toMatch(/\bw-full\b/);
  });

  it("keeps the task's own words when nothing follows", async () => {
    vi.mocked(getApplication).mockResolvedValue(application([task('PROFILE_INFO', 'DONE'), task('DIRECT_DEPOSIT')]));
    renderAt(`/onboarding/me/${APP_ID}/tasks/direct_deposit`, <DirectDepositTask />);
    await screen.findByTestId('task-step');
    expect(screen.getByRole('button', { name: /^save payout method$/i })).toBeInTheDocument();
    expect(screen.queryByText(/^next:/i)).toBeNull();
  });

  it('a step that is not on this checklist says so and offers the way back (no form)', async () => {
    vi.mocked(getApplication).mockResolvedValue(application([task('PROFILE_INFO'), task('W4')]));
    renderAt(`/onboarding/me/${APP_ID}/tasks/wotc_screening`, <WotcScreeningTask />);
    expect(await screen.findByText("This step isn't part of your onboarding")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to my onboarding/i })).toHaveAttribute('href', `/onboarding/me/${APP_ID}`);
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
    expect(screen.queryByTestId('task-step')).toBeNull();
  });

  it('never hides the form because the checklist could not be read', async () => {
    vi.mocked(getApplication).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderAt(`/onboarding/me/${APP_ID}/tasks/direct_deposit`, <DirectDepositTask />);
    await waitFor(() => expect(getApplication).toHaveBeenCalled());
    expect(screen.queryByText("This step isn't part of your onboarding")).toBeNull();
    await user.type(screen.getByLabelText(/routing number/i), '121000248');
    expect(screen.getByRole('button', { name: /save payout method/i })).toBeInTheDocument();
  });

  it('background check: the disclosure scrolls inside the one card; Cancel comes before Authorize', async () => {
    vi.mocked(getApplication).mockResolvedValue(application([task('BACKGROUND_CHECK'), task('W4')]));
    renderAt(`/onboarding/me/${APP_ID}/tasks/background_check`, <BackgroundCheckTask />);
    const region = await screen.findByRole('region', { name: /background check disclosure/i });
    expect(region.className).toMatch(/overflow-y-auto/);
    expect(region.className).not.toMatch(/rounded-md border /);
    const cancel = screen.getByRole('link', { name: /cancel/i });
    const authorize = await screen.findByRole('button', { name: /authorize & continue/i });
    expect(authorize).toHaveTextContent('Next: W-4');
    expect(cancel.compareDocumentPosition(authorize) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

