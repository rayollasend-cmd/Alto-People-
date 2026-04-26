import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/onboardingApi', () => ({
  createApplication: vi.fn(),
  listClients: vi.fn(),
  listTemplates: vi.fn(),
}));

import {
  createApplication,
  listClients,
  listTemplates,
} from '@/lib/onboardingApi';
import { NewApplicationDialog } from '@/pages/onboarding/NewApplicationDialog';

const CLIENT_A = '00000000-0000-4000-8000-00000000aaaa';
const CLIENT_B = '00000000-0000-4000-8000-00000000bbbb';
const TPL_GLOBAL = '00000000-0000-4000-8000-00000000cccc';
const TPL_CLIENT_A = '00000000-0000-4000-8000-00000000dddd';
const TPL_CLIENT_B = '00000000-0000-4000-8000-00000000eeee';

beforeEach(() => {
  vi.mocked(listClients).mockResolvedValue({
    clients: [
      { id: CLIENT_A, name: 'Coastal Resort', industry: 'hospitality', status: 'ACTIVE', state: 'CA' },
      { id: CLIENT_B, name: 'Mountain Lodge', industry: 'hospitality', status: 'ACTIVE', state: 'CO' },
    ],
  });
  vi.mocked(listTemplates).mockResolvedValue({
    templates: [
      {
        id: TPL_GLOBAL,
        clientId: null,
        track: 'STANDARD',
        name: 'Standard onboarding',
        tasks: [],
      },
      {
        id: TPL_CLIENT_A,
        clientId: CLIENT_A,
        track: 'CLIENT_SPECIFIC',
        name: 'Coastal-specific',
        tasks: [],
      },
      {
        id: TPL_CLIENT_B,
        clientId: CLIENT_B,
        track: 'CLIENT_SPECIFIC',
        name: 'Mountain-specific',
        tasks: [],
      },
    ],
  });
});

function renderDialog(onCreated = vi.fn()) {
  return render(
    <MemoryRouter>
      <NewApplicationDialog open onOpenChange={vi.fn()} onCreated={onCreated} />
    </MemoryRouter>
  );
}

describe('<NewApplicationDialog>', () => {
  it('template picker shows only global + chosen-client templates', async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(listClients).toHaveBeenCalled());
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());

    // No client picked → template picker is disabled.
    const tplSelect = screen.getByLabelText(/onboarding template/i) as HTMLSelectElement;
    expect(tplSelect).toBeDisabled();

    // Pick Coastal → only Standard (global) + Coastal-specific should show.
    await user.selectOptions(screen.getByLabelText(/^client/i), CLIENT_A);
    await waitFor(() => expect(tplSelect).not.toBeDisabled());
    const optionLabels = Array.from(tplSelect.options)
      .map((o) => o.textContent ?? '')
      .filter((t) => !t.startsWith('Pick a template'));
    expect(optionLabels.some((t) => /Standard onboarding/.test(t))).toBe(true);
    expect(optionLabels.some((t) => /Coastal-specific/.test(t))).toBe(true);
    expect(optionLabels.some((t) => /Mountain-specific/.test(t))).toBe(false);
  });

  it('happy path: submits with the entered fields and calls onCreated', async () => {
    vi.mocked(createApplication).mockResolvedValue({
      id: 'app-1',
      invitedUserId: 'user-1',
      inviteUrl: null, // simulate Resend configured
    });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    renderDialog(onCreated);

    await waitFor(() => expect(listClients).toHaveBeenCalled());

    await user.type(screen.getByLabelText(/first name/i), 'Demo');
    await user.type(screen.getByLabelText(/last name/i), 'Hire');
    await user.type(screen.getByLabelText(/^email/i), 'demo.hire@example.com');
    await user.selectOptions(screen.getByLabelText(/^client/i), CLIENT_A);
    await waitFor(() =>
      expect(screen.getByLabelText(/onboarding template/i)).not.toBeDisabled()
    );
    await user.selectOptions(screen.getByLabelText(/onboarding template/i), TPL_GLOBAL);
    await user.type(screen.getByLabelText(/position/i), 'Server');

    await user.click(screen.getByRole('button', { name: /create.*invite/i }));

    await waitFor(() => {
      expect(createApplication).toHaveBeenCalledWith({
        associateFirstName: 'Demo',
        associateLastName: 'Hire',
        associateEmail: 'demo.hire@example.com',
        clientId: CLIENT_A,
        templateId: TPL_GLOBAL,
        position: 'Server',
        startDate: undefined,
      });
      expect(onCreated).toHaveBeenCalled();
    });
  });

  it('dev-stub mode: shows the inviteUrl with a copy button', async () => {
    const stubUrl = 'http://localhost:5173/accept-invite/abc123';
    vi.mocked(createApplication).mockResolvedValue({
      id: 'app-1',
      invitedUserId: 'user-1',
      inviteUrl: stubUrl,
    });
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(listClients).toHaveBeenCalled());

    await user.type(screen.getByLabelText(/first name/i), 'Demo');
    await user.type(screen.getByLabelText(/last name/i), 'Hire');
    await user.type(screen.getByLabelText(/^email/i), 'demo.hire@example.com');
    await user.selectOptions(screen.getByLabelText(/^client/i), CLIENT_A);
    await waitFor(() =>
      expect(screen.getByLabelText(/onboarding template/i)).not.toBeDisabled()
    );
    await user.selectOptions(screen.getByLabelText(/onboarding template/i), TPL_GLOBAL);

    await user.click(screen.getByRole('button', { name: /create.*invite/i }));

    await waitFor(() => {
      expect(screen.getByText(stubUrl)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
    });
  });
});
