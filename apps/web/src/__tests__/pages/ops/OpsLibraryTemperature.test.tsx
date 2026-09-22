import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

vi.mock('@/lib/opsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/opsApi')>()),
  getOpsLibrary: vi.fn(),
  addOpsTemplateTask: vi.fn(),
  patchOpsTemplateTask: vi.fn(),
}));
// The store-shift assignment card fetches its own data; it isn't the
// subject here.
vi.mock('@/pages/ops/StoreShiftSops', () => ({ StoreShiftSops: () => null }));

import {
  addOpsTemplateTask,
  getOpsLibrary,
  patchOpsTemplateTask,
  type OpsLibraryTemplate,
} from '@/lib/opsApi';
import { OpsLibrary } from '@/pages/ops/OpsLibrary';

/** The freezer line of the standard: its allowed band is below zero. */
const template = (): OpsLibraryTemplate => ({
  id: 'tpl1', name: 'Frozen & Dairy — Morning', department: 'Frozen & Dairy',
  period: 'MORNING', description: null, active: true, taskCount: 1, runs28d: 4, avgSopPct: 96,
  tasks: [
    {
      id: 'task1', section: 'Food safety', order: 1, title: 'Freezer case temperature',
      instructions: null, responseType: 'TEMPERATURE', required: true, photoRequired: false,
      tempLabel: 'Freezer °F', tempMin: -30, tempMax: 0, metricKey: null, unit: null,
      followUpOn: 'OUT_OF_RANGE', dueTime: null,
      stats: { runs: 4, done: 4, noCount: 0, partialCount: 0, outOfRange: 1 },
    },
  ],
});

function renderLibrary() {
  vi.mocked(getOpsLibrary).mockResolvedValue({
    departments: ['Frozen & Dairy'],
    templates: [template()],
  });
  vi.mocked(addOpsTemplateTask).mockResolvedValue({ id: 'new' });
  vi.mocked(patchOpsTemplateTask).mockResolvedValue(undefined as never);
  const caps = ROLE_CAPABILITIES.OPERATIONS_MANAGER;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'ops@altohr.com', role: 'OPERATIONS_MANAGER', status: 'ACTIVE', clientId: null, associateId: null },
          role: 'OPERATIONS_MANAGER',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <OpsLibrary />
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('<OpsLibrary> — authoring a band that runs below zero', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the ± types the minus the tablet keypad has not got: a -30–0 freezer band', async () => {
    const user = renderLibrary();
    await user.click(await screen.findByText('Frozen & Dairy — Morning'));

    await user.type(screen.getByPlaceholderText('e.g. Verify cooler door seals'), 'Walk-in freezer temperature');
    const response = screen
      .getAllByRole('combobox')
      .find((el) => (el as HTMLSelectElement).value === 'CHECK')!;
    await user.selectOptions(response, 'TEMPERATURE');

    await user.type(screen.getByRole('textbox', { name: 'Min °F' }), '30');
    const sign = screen.getByRole('button', { name: 'Min °F — below zero (minus)' });
    expect(sign).toHaveAttribute('aria-pressed', 'false');
    await user.click(sign);
    expect(screen.getByRole('textbox', { name: 'Min °F' })).toHaveValue('-30');
    expect(sign).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByRole('textbox', { name: 'Max °F' }), '0');

    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() =>
      expect(addOpsTemplateTask).toHaveBeenCalledWith(
        'tpl1',
        expect.objectContaining({ title: 'Walk-in freezer temperature', tempMin: -30, tempMax: 0 }),
      ),
    );
  });

  it('an existing below-zero band edits and saves without losing its sign', async () => {
    const user = renderLibrary();
    await user.click(await screen.findByText('Frozen & Dairy — Morning'));
    await user.click(screen.getByRole('button', { name: 'Edit "Freezer case temperature"' }));

    const min = screen.getByRole('textbox', { name: 'Min °F' });
    expect(min).toHaveValue('-30');
    expect(screen.getByRole('button', { name: 'Min °F — below zero (minus)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Tighten the band to -20 — still negative, still round-trips.
    await user.clear(min);
    await user.type(min, '20');
    await user.click(screen.getByRole('button', { name: 'Min °F — below zero (minus)' }));

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(patchOpsTemplateTask).toHaveBeenCalledWith(
        'task1',
        expect.objectContaining({ tempMin: -20, tempMax: 0 }),
      ),
    );
  });
});
