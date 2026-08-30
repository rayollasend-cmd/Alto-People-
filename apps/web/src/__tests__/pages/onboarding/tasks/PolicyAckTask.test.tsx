import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability, PolicyForApplication } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/onboardingApi', () => ({
  getApplicationPolicies: vi.fn(),
  acknowledgePolicy: vi.fn(),
}));

import { acknowledgePolicy, getApplicationPolicies } from '@/lib/onboardingApi';
import { PolicyAckTask } from '@/pages/onboarding/tasks/PolicyAckTask';

const APP_ID = '00000000-0000-4000-8000-00000000dddd';

const policy = (id: string, title: string, acknowledged = false): PolicyForApplication => ({
  id,
  title,
  version: 'v1.0',
  industry: null,
  bodyUrl: null,
  body: 'Short policy body for tests.',
  acknowledged,
  acknowledgedAt: acknowledged ? new Date().toISOString() : null,
});

function renderTask() {
  const value = {
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
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[`/onboarding/me/${APP_ID}/policy-ack`]}>
        <Routes>
          <Route path="/onboarding/me/:applicationId/policy-ack" element={<PolicyAckTask />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(getApplicationPolicies).mockReset();
  vi.mocked(acknowledgePolicy).mockReset();
});

describe('<PolicyAckTask>', () => {
  it('renders every unacknowledged policy body in one continuous flow', async () => {
    vi.mocked(getApplicationPolicies).mockResolvedValueOnce({
      policies: [policy('p1', 'Code of Conduct'), policy('p2', 'Food Safety')],
    });
    renderTask();

    // Each policy is a numbered section with its full body already visible —
    // no expand step.
    expect(
      await screen.findByRole('heading', { name: /code of conduct/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /food safety/i })).toBeInTheDocument();
    expect(screen.getByText('Policy 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Policy 2 of 2')).toBeInTheDocument();
    expect(screen.getAllByText('Short policy body for tests.')).toHaveLength(2);
    // One inline Acknowledge checkpoint per section.
    expect(screen.getAllByRole('button', { name: /^acknowledge$/i })).toHaveLength(2);
  });

  it('clicks an inline Acknowledge → calls API → re-fetches the list', async () => {
    vi.mocked(getApplicationPolicies)
      .mockResolvedValueOnce({ policies: [policy('p1', 'Code of Conduct')] })
      .mockResolvedValueOnce({ policies: [policy('p1', 'Code of Conduct', true)] });
    vi.mocked(acknowledgePolicy).mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    renderTask();
    // jsdom has no IntersectionObserver, so the read-gate fails open and
    // the per-section Acknowledge button is enabled immediately.
    const ackButton = await screen.findByRole('button', { name: /^acknowledge$/i });
    await user.click(ackButton);

    await waitFor(() => expect(acknowledgePolicy).toHaveBeenCalledWith(APP_ID, { policyId: 'p1' }));
    await waitFor(() => expect(getApplicationPolicies).toHaveBeenCalledTimes(2));
    // The checkpoint flips to an "Acknowledged" state (exact case).
    expect(await screen.findByText('Acknowledged')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^acknowledge$/i })).not.toBeInTheDocument();
  });

  it('"Acknowledge all remaining" fires one POST per unacknowledged policy', async () => {
    vi.mocked(getApplicationPolicies)
      .mockResolvedValueOnce({
        policies: [
          policy('p1', 'Code of Conduct', true),
          policy('p2', 'Food Safety'),
          policy('p3', 'Attendance'),
        ],
      })
      .mockResolvedValueOnce({
        policies: [
          policy('p1', 'Code of Conduct', true),
          policy('p2', 'Food Safety', true),
          policy('p3', 'Attendance', true),
        ],
      });
    vi.mocked(acknowledgePolicy).mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderTask();

    const bulk = await screen.findByRole('button', {
      name: /acknowledge all remaining \(2\)/i,
    });
    await user.click(bulk);

    await waitFor(() => expect(acknowledgePolicy).toHaveBeenCalledTimes(2));
    // Same per-policy POST as the inline checkpoints — one audit record each.
    expect(acknowledgePolicy).toHaveBeenNthCalledWith(1, APP_ID, { policyId: 'p2' });
    expect(acknowledgePolicy).toHaveBeenNthCalledWith(2, APP_ID, { policyId: 'p3' });
    await waitFor(() => expect(getApplicationPolicies).toHaveBeenCalledTimes(2));
    expect(screen.getByText('3 of 3 acknowledged')).toBeInTheDocument();
  });

  it('collapses policies acknowledged before this visit to one-line rows', async () => {
    vi.mocked(getApplicationPolicies).mockResolvedValueOnce({
      policies: [policy('p1', 'Code of Conduct', true), policy('p2', 'Food Safety')],
    });
    renderTask();

    await screen.findByRole('heading', { name: /food safety/i });
    // The already-acked policy renders as a collapsed row, not a section —
    // its body is not repeated in the reading flow.
    expect(screen.queryByRole('heading', { name: /code of conduct/i })).toBeNull();
    expect(screen.getByText('Code of Conduct')).toBeInTheDocument();
    expect(screen.getAllByText('Short policy body for tests.')).toHaveLength(1);
  });

  it('shows a skeleton loading state until the first fetch resolves', async () => {
    let resolveFn!: (v: { policies: PolicyForApplication[] }) => void;
    vi.mocked(getApplicationPolicies).mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      })
    );
    const { container } = renderTask();
    // SkeletonRows renders elements with aria-busy="true" while loading.
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    resolveFn({ policies: [] });
    await waitFor(() =>
      expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0)
    );
  });
});
