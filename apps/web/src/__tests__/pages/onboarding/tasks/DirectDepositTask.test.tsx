import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/onboardingApi', () => ({
  submitDirectDeposit: vi.fn(async () => {}),
  // DirectDepositTask mounts and calls getDirectDeposit to hydrate any prior
  // submission. Return the "no payout method yet" shape so the form is blank.
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

import { submitDirectDeposit } from '@/lib/onboardingApi';
import { DirectDepositTask } from '@/pages/onboarding/tasks/DirectDepositTask';

const APP_ID = '00000000-0000-4000-8000-00000000cccc';

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
      <MemoryRouter initialEntries={[`/onboarding/me/${APP_ID}/direct-deposit`]}>
        <Routes>
          <Route path="/onboarding/me/:applicationId/direct-deposit" element={<DirectDepositTask />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(submitDirectDeposit).mockClear();
  vi.mocked(submitDirectDeposit).mockResolvedValue(undefined);
});

describe('<DirectDepositTask>', () => {
  it('default tab is BANK_ACCOUNT and shows routing + account fields', () => {
    renderTask();
    expect(screen.getByLabelText(/routing number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^account number$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/account type/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/branch card id/i)).not.toBeInTheDocument();
  });

  it('switching to Branch card hides bank fields and shows branchCardId', async () => {
    const user = userEvent.setup();
    renderTask();
    await user.click(screen.getByRole('tab', { name: /branch card/i }));
    expect(screen.getByLabelText(/branch card id/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/routing number/i)).not.toBeInTheDocument();
  });

  it('submits a BANK_ACCOUNT payload', async () => {
    const user = userEvent.setup();
    renderTask();

    // Real valid ABA routing # (Wells Fargo CA) — DirectDepositTask now
    // runs the routing # through an ABA-checksum validator before allowing
    // submit, so a synthetic 123456789 placeholder is rejected client-side.
    const ROUTING = '121000248';
    await user.type(screen.getByLabelText(/routing number/i), ROUTING);
    await user.type(screen.getByLabelText(/^account number$/i), '987654321');
    await user.selectOptions(screen.getByLabelText(/account type/i), 'SAVINGS');

    await user.click(screen.getByRole('button', { name: /save payout method/i }));

    await waitFor(() => expect(submitDirectDeposit).toHaveBeenCalledTimes(1));
    expect(submitDirectDeposit).toHaveBeenCalledWith(APP_ID, {
      type: 'BANK_ACCOUNT',
      routingNumber: ROUTING,
      accountNumber: '987654321',
      accountType: 'SAVINGS',
    });
  });

  it('submits a BRANCH_CARD payload', async () => {
    const user = userEvent.setup();
    renderTask();
    await user.click(screen.getByRole('tab', { name: /branch card/i }));
    await user.type(screen.getByLabelText(/branch card id/i), 'BC-12345');
    await user.click(screen.getByRole('button', { name: /save payout method/i }));

    await waitFor(() => expect(submitDirectDeposit).toHaveBeenCalledTimes(1));
    expect(submitDirectDeposit).toHaveBeenCalledWith(APP_ID, {
      type: 'BRANCH_CARD',
      branchCardId: 'BC-12345',
    });
  });
});
