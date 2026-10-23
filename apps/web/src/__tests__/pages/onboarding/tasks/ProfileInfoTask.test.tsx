import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/onboardingApi', () => ({
  submitProfile: vi.fn(async () => {}),
}));
vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));

import { submitProfile } from '@/lib/onboardingApi';
import { suggestAddresses } from '@/lib/geoApi';
import { ProfileInfoTask } from '@/pages/onboarding/tasks/ProfileInfoTask';

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
  // Dev and tests have no type-ahead provider: the street line is a plain box.
  vi.mocked(suggestAddresses).mockReset();
  vi.mocked(suggestAddresses).mockResolvedValue({ available: false, reason: 'not_configured', results: [] });
});

describe('<ProfileInfoTask> — the home address picked, not typed', () => {
  it('a suggestion fills street, unit, city, state and ZIP, and they are what gets saved', async () => {
    vi.mocked(suggestAddresses).mockResolvedValue({
      available: true,
      provider: 'mapbox',
      outage: false,
      results: [
        { label: '1500 NW 7th Avenue Apt 2', address: '1500 NW 7th Avenue Apt 2, Miami, Florida 33136', line1: '1500 NW 7th Avenue', line2: 'Apt 2', city: 'Miami', state: 'FL', zip: '33136', county: 'Miami-Dade County', lat: 25.79, lng: -80.21, precision: 'exact' },
      ],
    });
    const user = userEvent.setup();
    renderTask();
    await user.type(screen.getByLabelText(/first name/i), 'Maria');
    await user.type(screen.getByLabelText(/last name/i), 'Lopez');
    await user.type(screen.getByLabelText(/address line 1/i), '1500 nw 7th apt 2');
    await user.click(await screen.findByRole('option', { name: /1500 NW 7th Avenue/ }));
    expect(screen.getByLabelText(/address line 2/i)).toHaveValue('Apt 2');
    expect(screen.getByLabelText(/^city$/i)).toHaveValue('Miami');

    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(submitProfile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitProfile).mock.calls[0]![1]).toMatchObject({
      addressLine1: '1500 NW 7th Avenue',
      addressLine2: 'Apt 2',
      city: 'Miami',
      state: 'FL',
      zip: '33136',
    });
  });
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
    await user.type(screen.getByLabelText(/date of birth/i), '1998-03-14');
    await user.type(screen.getByLabelText(/phone/i), '+1-850-555-0142');
    // Address line 1 is required now (payroll and the W-2 need the street).
    await user.type(screen.getByLabelText(/address line 1/i), '218 Front Beach Dr');
    await user.type(screen.getByLabelText(/^city$/i), 'Tallahassee');
    await user.type(screen.getByLabelText(/^zip$/i), '32301');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(submitProfile).toHaveBeenCalledTimes(1));
    expect(submitProfile).toHaveBeenCalledWith(
      APP_ID,
      expect.objectContaining({
        firstName: 'Maria',
        lastName: 'Lopez',
        // Must cross the wire as a plain calendar date — the contract is
        // z.string().date() and a timestamp fails the whole submission.
        dob: '1998-03-14',
        phone: '+1-850-555-0142',
        addressLine1: '218 Front Beach Dr',
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
