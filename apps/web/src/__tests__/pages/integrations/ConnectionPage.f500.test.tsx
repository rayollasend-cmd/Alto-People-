import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { IntegrationConnectionSummary, IntegrationSyncRunSummary } from '@alto-people/shared';
import { ConfirmProvider } from '@/lib/confirm';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/integrationsApi', () => ({
  getIntegrationConnection: vi.fn(),
  listIntegrationRunErrors: vi.fn(async () => ({ errors: [] })),
  patchIntegrationConnection: vi.fn(async () => ({})),
  deleteIntegrationConnection: vi.fn(async () => undefined),
  syncIntegrationConnection: vi.fn(async () => ({})),
  testIntegrationConnection: vi.fn(async () => ({})),
  listIntegrationVendors: vi.fn(async () => ({ vendors: [] })),
  createIntegrationConnection: vi.fn(),
}));

import { deleteIntegrationConnection, getIntegrationConnection, syncIntegrationConnection } from '@/lib/integrationsApi';
import { ConnectionPage } from '@/pages/integrations/connections/ConnectionPage';

const run = (o: Partial<IntegrationSyncRunSummary>): IntegrationSyncRunSummary => ({
  id: 'r1',
  capability: 'pushTimesheets',
  direction: 'PUSH',
  status: 'SUCCEEDED',
  trigger: 'manual',
  eventType: null,
  startedAt: '2026-10-20T15:00:00.000Z',
  finishedAt: '2026-10-20T15:01:00.000Z',
  total: 10,
  succeeded: 10,
  failed: 0,
  summary: null,
  ...o,
});

const connection: IntegrationConnectionSummary = {
  id: 'c1',
  vendor: 'FIELDGLASS',
  name: 'Fieldglass',
  status: 'CONNECTED',
  sandbox: false,
  hasCredentials: true,
  capabilities: ['pushTimesheets', 'pullWorkOrders'],
  mapping: {},
  scheduleMinutes: 60,
  eventDriven: true,
  lastSyncAt: '2026-10-20T15:00:00.000Z',
  nextSyncAt: '2026-10-20T16:00:00.000Z',
  lastError: null,
  recentErrors: 3,
  lastRun: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(getIntegrationConnection).mockResolvedValue({
    connection,
    vendor: { vendor: 'FIELDGLASS', label: 'SAP Fieldglass', what: '', capabilities: ['pushTimesheets', 'pullWorkOrders'], credentialFields: [], defaultMapping: {}, apiNote: '' },
    runs: [run({}), run({ id: 'r2', status: 'FAILED', failed: 3, succeeded: 7 }), run({ id: 'r3', status: 'PARTIAL', failed: 0 })],
  } as never);
});

function renderPage() {
  return renderAs(
    'HR_ADMINISTRATOR',
    <ConfirmProvider>
      <Routes>
        <Route path="/integrations/connections/:id" element={<ConnectionPage />} />
        <Route path="/integrations" element={<p>Integrations</p>} />
      </Routes>
    </ConfirmProvider>,
    '/integrations/connections/c1',
  );
}

describe('a connection (F500 G4)', () => {
  it('leads with Sync now; Disconnect sits in More, behind its confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Fieldglass' })).toBeInTheDocument();
    const actions = screen.getByTestId('page-actions');
    expect(within(actions).getByRole('button', { name: 'Sync now' }).className).toMatch(/btn-gold/);
    expect(within(actions).getByRole('button', { name: 'Sandbox test' })).toBeInTheDocument();
    expect(within(actions).queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    await user.click(within(actions).getByRole('button', { name: /More/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Disconnect/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Disconnect Fieldglass?' });
    expect(confirm).toHaveTextContent('Disconnect Fieldglass?');
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(deleteIntegrationConnection).toHaveBeenCalledWith('c1'));
  });

  it('Sync now asks which capability when the vendor has more than one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('What to run'), 'pullWorkOrders');
    await user.click(within(dialog).getByRole('button', { name: /Run/ }));
    await waitFor(() => expect(syncIntegrationConnection).toHaveBeenCalledWith('c1', { capability: 'pullWorkOrders' }));
  });

  it('counts the rejected records exactly and filters the log to the failed runs', async () => {
    const user = userEvent.setup();
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Connection at a glance' });
    const rejected = within(strip).getByRole('button', { name: /Rejected · last 10 runs/ });
    await waitFor(() => expect(rejected).toHaveTextContent(/runs3/), { timeout: 4000 });
    const table = screen.getByRole('table', { name: /Sync log/ });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    await user.click(rejected);
    await waitFor(() => expect(within(screen.getByRole('table', { name: /Sync log/ })).getAllByRole('row')).toHaveLength(2));
    expect(screen.getByText('3 rejected')).toBeInTheDocument();
  });
});
