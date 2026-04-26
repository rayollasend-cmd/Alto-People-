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
  it('renders the list of required policies', async () => {
    vi.mocked(getApplicationPolicies).mockResolvedValueOnce({
      policies: [policy('p1', 'Code of Conduct'), policy('p2', 'Food Safety')],
    });
    renderTask();

    expect(await screen.findByText('Code of Conduct')).toBeInTheDocument();
    expect(screen.getByText('Food Safety')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /acknowledge/i })).toHaveLength(2);
  });

  it('clicks Acknowledge → calls API → re-fetches the list', async () => {
    vi.mocked(getApplicationPolicies)
      .mockResolvedValueOnce({ policies: [policy('p1', 'Code of Conduct')] })
      .mockResolvedValueOnce({ policies: [policy('p1', 'Code of Conduct', true)] });
    vi.mocked(acknowledgePolicy).mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    renderTask();
    const ackButton = await screen.findByRole('button', { name: /acknowledge/i });
    await user.click(ackButton);

    await waitFor(() => expect(acknowledgePolicy).toHaveBeenCalledWith(APP_ID, { policyId: 'p1' }));
    await waitFor(() => expect(getApplicationPolicies).toHaveBeenCalledTimes(2));
    // The "Acknowledge" button is replaced by an "Acknowledged" badge (exact case).
    expect(await screen.findByText('Acknowledged')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^acknowledge$/i })).not.toBeInTheDocument();
  });

  it('shows a loading state until the first fetch resolves', async () => {
    let resolveFn!: (v: { policies: PolicyForApplication[] }) => void;
    vi.mocked(getApplicationPolicies).mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      })
    );
    renderTask();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    resolveFn({ policies: [] });
    await waitFor(() =>
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    );
  });
});
