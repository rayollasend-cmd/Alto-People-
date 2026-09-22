import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

vi.mock('@/lib/opsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/opsApi')>()),
  getOpsOpenOptions: vi.fn(),
  openOpsShift: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn() }));

import { getOpsOpenOptions, openOpsShift } from '@/lib/opsApi';
import { listClients } from '@/lib/clientsApi';
import { OpsRunner } from '@/pages/ops/OpsRunner';

function withAuth(ui: React.ReactElement, role: Role, clientId: string | null) {
  const caps = ROLE_CAPABILITIES[role];
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE', clientId, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        {ui}
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

function renderPicker(role: Role = 'SHIFT_SUPERVISOR', clientId: string | null = 'c1') {
  vi.mocked(getOpsOpenOptions).mockResolvedValue({
    clientId: 'c1',
    dateKey: '2026-09-17',
    resumeShift: null,
    positions: [
      { position: 'F&D Morning Shift', scheduledCount: 6, department: 'F&D', period: 'MORNING' },
      { position: 'Pool Attendant', scheduledCount: 2, department: null, period: 'EVENING' },
    ],
    departments: ['F&D', 'Grocery'],
  });
  vi.mocked(openOpsShift).mockResolvedValue({ shiftId: 's1' } as never);
  return render(
    withAuth(
      <ConfirmProvider>
        <MemoryRouter>
          <OpsRunner />
        </MemoryRouter>
      </ConfirmProvider>,
      role,
      clientId,
    ),
  );
}

describe('<OpsRunner> — starting a shift', () => {
  it('frames the day the way the floor says it', async () => {
    renderPicker();
    expect(await screen.findByText(/Your floor · Thursday, Sep 17/)).toBeInTheDocument();
  });

  it('asks for a department only when an unlinked position is opened', async () => {
    const user = userEvent.setup();
    renderPicker();
    await screen.findByText('Pool Attendant');
    // No picker in the grid until someone opens that position.
    expect(screen.queryByLabelText('Department for Pool Attendant')).not.toBeInTheDocument();
    expect(screen.getByText('No SOP department yet')).toBeInTheDocument();

    const opens = screen.getAllByRole('button', { name: /open shift/i });
    await user.click(opens[1]!);
    const picker = screen.getByLabelText('Department for Pool Attendant');
    const confirm = screen.getByRole('button', { name: /open with this department/i });
    expect(confirm).toBeDisabled();
    await user.selectOptions(picker, 'Grocery');
    await user.click(confirm);
    await waitFor(() =>
      expect(openOpsShift).toHaveBeenCalledWith({ position: 'Pool Attendant', department: 'Grocery' }),
    );
  });

  it('opens a linked position in one tap', async () => {
    const user = userEvent.setup();
    renderPicker();
    await screen.findByText('F&D Morning Shift');
    await user.click(screen.getAllByRole('button', { name: /open shift/i })[0]!);
    await waitFor(() => expect(openOpsShift).toHaveBeenCalledWith({ position: 'F&D Morning Shift' }));
  });
});

describe('<OpsRunner> — an org-wide role covering a floor', () => {
  beforeEach(() => {
    localStorage.removeItem('alto.ops.client');
    vi.mocked(getOpsOpenOptions).mockClear();
    vi.mocked(openOpsShift).mockClear();
    vi.mocked(listClients).mockResolvedValue({
      clients: [
        { id: 'c1', name: 'Coastal Resort Holdings' },
        { id: 'c2', name: 'Seaside Hospitality Group' },
      ],
    } as never);
  });

  it('asks whose floor first — never "clientId is required." — then runs that client', async () => {
    const user = userEvent.setup();
    renderPicker('HR_ADMINISTRATOR', null);
    expect(await screen.findByText('Whose floor are you running?')).toBeInTheDocument();
    expect(getOpsOpenOptions).not.toHaveBeenCalled();

    await user.selectOptions(await screen.findByLabelText('Floor'), 'c2');
    expect(await screen.findByText('F&D Morning Shift')).toBeInTheDocument();
    expect(getOpsOpenOptions).toHaveBeenLastCalledWith('c2');

    await user.click(screen.getAllByRole('button', { name: /open shift/i })[0]!);
    await waitFor(() =>
      expect(openOpsShift).toHaveBeenCalledWith({ clientId: 'c2', position: 'F&D Morning Shift' }),
    );
    // The pick is remembered for next time.
    expect(localStorage.getItem('alto.ops.client')).toBe('c2');
  });

  it('starts on their home client when they have one', async () => {
    renderPicker('OPERATIONS_MANAGER', 'c1');
    expect(await screen.findByText('F&D Morning Shift')).toBeInTheDocument();
    expect(getOpsOpenOptions).toHaveBeenCalledWith('c1');
  });
});
