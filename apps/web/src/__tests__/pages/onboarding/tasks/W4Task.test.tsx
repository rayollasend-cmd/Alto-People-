import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/onboardingApi', () => ({
  submitW4: vi.fn(async () => {}),
}));

import { submitW4 } from '@/lib/onboardingApi';
import { W4Task } from '@/pages/onboarding/tasks/W4Task';

const APP_ID = '00000000-0000-4000-8000-00000000bbbb';

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
      <MemoryRouter initialEntries={[`/onboarding/me/${APP_ID}/w4`]}>
        <Routes>
          <Route path="/onboarding/me/:applicationId/w4" element={<W4Task />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(submitW4).mockClear();
  vi.mocked(submitW4).mockResolvedValue(undefined);
});

describe('<W4Task>', () => {
  it('submits with default filing status (SINGLE) and zero amounts', async () => {
    const user = userEvent.setup();
    renderTask();
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));

    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
    expect(submitW4).toHaveBeenCalledWith(
      APP_ID,
      expect.objectContaining({
        filingStatus: 'SINGLE',
        multipleJobs: false,
        dependentsAmount: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
        ssn: undefined,
      })
    );
  });

  it('passes the SSN through verbatim when typed (server strips dashes + encrypts)', async () => {
    const user = userEvent.setup();
    renderTask();
    const ssnField = screen.getByLabelText(/social security/i);
    await user.type(ssnField, '123-45-6789');

    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalledTimes(1));
    expect(submitW4.mock.calls[0][1]).toMatchObject({ ssn: '123-45-6789' });
  });

  it('does not log SSN to the console (regression guard for an obvious leak)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderTask();
    await user.type(screen.getByLabelText(/social security/i), '123456789');
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalled());

    const allCalls = [...spy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
    expect(allCalls).not.toContain('123456789');
    spy.mockRestore();
    errSpy.mockRestore();
  });

  it('changes filing status when the select is updated', async () => {
    const user = userEvent.setup();
    renderTask();
    await user.selectOptions(screen.getByLabelText(/filing status/i), 'HEAD_OF_HOUSEHOLD');
    await user.click(screen.getByRole('button', { name: /submit w-4/i }));
    await waitFor(() => expect(submitW4).toHaveBeenCalled());
    expect(submitW4.mock.calls[0][1]).toMatchObject({ filingStatus: 'HEAD_OF_HOUSEHOLD' });
  });
});
