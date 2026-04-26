import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/onboardingApi', () => ({
  submitProfile: vi.fn(async () => {}),
}));

import { submitProfile } from '@/lib/onboardingApi';
import { ProfileInfoTask } from '@/pages/onboarding/tasks/ProfileInfoTask';

const APP_ID = '00000000-0000-4000-8000-00000000aaaa';

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
      <MemoryRouter initialEntries={[`/onboarding/me/${APP_ID}/profile`]}>
        <Routes>
          <Route path="/onboarding/me/:applicationId/profile" element={<ProfileInfoTask />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(submitProfile).mockClear();
  vi.mocked(submitProfile).mockResolvedValue(undefined);
});

describe('<ProfileInfoTask>', () => {
  it('renders the required fields', () => {
    renderTask();
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/last name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/state/i)).toBeInTheDocument();
  });

  it('submits the form with the typed values and navigates back to the checklist', async () => {
    const user = userEvent.setup();
    renderTask();

    await user.type(screen.getByLabelText(/first name/i), 'Maria');
    await user.type(screen.getByLabelText(/last name/i), 'Lopez');
    await user.type(screen.getByLabelText(/phone/i), '+1-850-555-0142');
    await user.type(screen.getByLabelText(/^city$/i), 'Tallahassee');
    await user.type(screen.getByLabelText(/^zip$/i), '32301');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(submitProfile).toHaveBeenCalledTimes(1));
    expect(submitProfile).toHaveBeenCalledWith(
      APP_ID,
      expect.objectContaining({
        firstName: 'Maria',
        lastName: 'Lopez',
        phone: '+1-850-555-0142',
        city: 'Tallahassee',
        zip: '32301',
        state: 'FL',
      })
    );

    // After submit, we navigate to the associate's checklist page (the
    // route isn't mounted here, so the catch-all renders instead).
    await screen.findByTestId('elsewhere');
  });

  it('does not submit when first/last name are empty (HTML5 required blocks it)', async () => {
    const user = userEvent.setup();
    renderTask();
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(submitProfile).not.toHaveBeenCalled();
  });
});
