import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/onboardingApi', () => ({
  createApplication: vi.fn(),
  cancelApplication: vi.fn(async () => ({ mode: 'removed' })),
  listClients: vi.fn(),
  listTemplates: vi.fn(),
}));
vi.mock('@/lib/undoToast', async (orig) => ({
  ...(await orig<typeof import('@/lib/undoToast')>()),
  undoWindowToast: vi.fn(),
}));

import { cancelApplication, createApplication, listClients, listTemplates } from '@/lib/onboardingApi';
import { undoWindowToast } from '@/lib/undoToast';
import { NewApplicationDialog } from '@/pages/onboarding/NewApplicationDialog';

const CLIENT = '00000000-0000-4000-8000-00000000aaaa';
const TPL = '00000000-0000-4000-8000-00000000cccc';

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(listClients).mockResolvedValue({
    clients: [{ id: CLIENT, name: 'Coastal Resort', industry: 'hospitality', status: 'ACTIVE', state: 'CA' }],
  });
  vi.mocked(listTemplates).mockResolvedValue({
    templates: [{ id: TPL, clientId: null, track: 'STANDARD', name: 'Standard onboarding', tasks: [] }],
  });
});

function renderDialog(props: Partial<Parameters<typeof NewApplicationDialog>[0]> = {}) {
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NewApplicationDialog open onOpenChange={vi.fn()} onCreated={onCreated} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onCreated };
}

describe('<NewApplicationDialog> — taking an invite back', () => {
  it('a corrected invite opens with the person already filled in', async () => {
    renderDialog({ prefill: { firstName: 'Dana', lastName: 'Draft', email: 'dana@example.com' } });
    await waitFor(() => expect(screen.getByLabelText(/first name/i)).toHaveValue('Dana'));
    expect(screen.getByLabelText(/last name/i)).toHaveValue('Draft');
    expect(screen.getByLabelText(/^email/i)).toHaveValue('dana@example.com');
  });

  it('the email waits, and Undo cancels it before it goes', async () => {
    vi.mocked(createApplication).mockResolvedValue({
      id: 'app-1',
      invitedUserId: 'user-1',
      inviteUrl: null,
      emailDueAt: new Date(Date.now() + 20_000).toISOString(),
    });
    const { user, onCreated } = renderDialog();
    await waitFor(() => expect(listClients).toHaveBeenCalled());
    await user.type(screen.getByLabelText(/first name/i), 'Dana');
    await user.type(screen.getByLabelText(/last name/i), 'Draft');
    await user.type(screen.getByLabelText(/^email/i), 'dana@example.com');
    await user.selectOptions(screen.getByLabelText(/^client/i), CLIENT);
    await waitFor(() => expect(screen.getByLabelText(/onboarding template/i)).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText(/onboarding template/i), TPL);
    await user.type(screen.getByLabelText(/position/i), 'Server');
    await user.click(screen.getByRole('button', { name: /^create & invite$/i }));

    await waitFor(() => expect(undoWindowToast).toHaveBeenCalled());
    const opts = vi.mocked(undoWindowToast).mock.calls[0]![0];
    expect(opts.message).toMatch(/Invite to Dana Draft goes out in \d+ seconds/);
    await expect(opts.onUndo()).resolves.toBe('Undone — nothing was sent to Dana Draft.');
    expect(cancelApplication).toHaveBeenCalledWith('app-1', { reason: 'SENT_IN_ERROR' });
    expect(onCreated).toHaveBeenCalled();
  });
});
