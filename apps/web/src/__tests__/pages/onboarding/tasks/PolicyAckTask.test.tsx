import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
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

// The page reads through the query layer; every render gets a client.
function withQueryClient({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
}
const render = (ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) =>
  rtlRender(ui, { wrapper: withQueryClient, ...options });

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

// Policies as a list, each read in a sheet (F500 fix-up 2026-10-22). The
// legal posture is the old one: the full text renders, a policy can only be
// acknowledged once its text was read to the end (jsdom has no
// IntersectionObserver, so the read gate fails open when the sheet opens),
// and every acknowledgment is its own POST.
describe('<PolicyAckTask>', () => {
  it('lists every policy as a row (title, version, state) with the text kept out of the list', async () => {
    vi.mocked(getApplicationPolicies).mockResolvedValueOnce({
      policies: [policy('p1', 'Code of Conduct', true), policy('p2', 'Food Safety')],
    });
    renderTask();
    const row1 = await screen.findByTestId('policy-row-p1');
    expect(row1).toHaveTextContent('Code of Conduct');
    expect(row1).toHaveTextContent('v1.0');
    expect(row1).toHaveTextContent('Acknowledged');
    expect(screen.getByTestId('policy-row-p2')).toHaveTextContent('Not read yet');
    // No twelve screens of text: bodies only render in the sheet.
    expect(screen.queryByText('Short policy body for tests.')).toBeNull();
    // The sticky progress says where you are.
    expect(screen.getByTestId('policy-progress')).toHaveTextContent('1 of 2 acknowledged');
  });

  it('opens a policy in a sheet; I acknowledge → one POST → refetch → on to the next', async () => {
    vi.mocked(getApplicationPolicies)
      .mockResolvedValueOnce({ policies: [policy('p1', 'Code of Conduct'), policy('p2', 'Food Safety')] })
      .mockResolvedValueOnce({ policies: [policy('p1', 'Code of Conduct', true), policy('p2', 'Food Safety')] });
    vi.mocked(acknowledgePolicy).mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    renderTask();
    await user.click(await screen.findByTestId('policy-row-p1'));
    const sheet = await screen.findByTestId('policy-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Code of Conduct' })).toBeInTheDocument();
    expect(within(sheet).getByText('Short policy body for tests.')).toBeInTheDocument();
    expect(within(sheet).getByText(/policy 1 of 2/i)).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: /^i acknowledge$/i }));
    await waitFor(() => expect(acknowledgePolicy).toHaveBeenCalledWith(APP_ID, { policyId: 'p1' }));
    await waitFor(() => expect(getApplicationPolicies).toHaveBeenCalledTimes(2));
    // The sheet moves on to the next one still to acknowledge.
    expect(await screen.findByRole('heading', { name: 'Food Safety' })).toBeInTheDocument();
    expect(screen.getByTestId('policy-progress')).toHaveTextContent('1 of 2 acknowledged');
  });

  it('"Acknowledge all I\'ve read" posts only the policies whose text was read', async () => {
    vi.mocked(getApplicationPolicies)
      .mockResolvedValueOnce({
        policies: [policy('p1', 'Code of Conduct', true), policy('p2', 'Food Safety'), policy('p3', 'Attendance')],
      })
      .mockResolvedValueOnce({
        policies: [policy('p1', 'Code of Conduct', true), policy('p2', 'Food Safety', true), policy('p3', 'Attendance')],
      });
    vi.mocked(acknowledgePolicy).mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderTask();
    // Nothing read yet: the bulk action has nothing to do.
    const bulk0 = await screen.findByRole('button', { name: /acknowledge all i've read \(0\)/i });
    expect(bulk0).toBeDisabled();

    // Read Food Safety (open it, close it without acknowledging).
    await user.click(screen.getByTestId('policy-row-p2'));
    await screen.findByTestId('policy-sheet');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('policy-sheet')).toBeNull());
    expect(screen.getByTestId('policy-row-p2')).toHaveTextContent(/read · not yet acknowledged/i);

    await user.click(screen.getByRole('button', { name: /acknowledge all i've read \(1\)/i }));
    await waitFor(() => expect(acknowledgePolicy).toHaveBeenCalledTimes(1));
    // Same per-policy POST as the sheet — one audit record each, and never
    // for Attendance, which was never opened.
    expect(acknowledgePolicy).toHaveBeenCalledWith(APP_ID, { policyId: 'p2' });
    await waitFor(() => expect(screen.getByTestId('policy-progress')).toHaveTextContent('2 of 3 acknowledged'));
  });

  it('once everything is acknowledged the way on is the only action', async () => {
    vi.mocked(getApplicationPolicies).mockResolvedValueOnce({
      policies: [policy('p1', 'Code of Conduct', true), policy('p2', 'Food Safety', true)],
    });
    renderTask();
    expect(await screen.findByRole('button', { name: /done — back to checklist/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acknowledge all/i })).toBeNull();
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

  it('a failed load says so with Retry, not skeletons that keep pulsing', async () => {
    vi.mocked(getApplicationPolicies).mockRejectedValueOnce(new Error('boom'));
    const { container } = renderTask();
    expect(await screen.findByText(/couldn.t load your policies/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0);
  });
});
