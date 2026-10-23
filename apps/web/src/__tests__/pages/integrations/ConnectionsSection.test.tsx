import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IntegrationConnectionSummary } from '@alto-people/shared';

vi.mock('@/lib/integrationsApi', () => ({
  listIntegrationConnections: vi.fn(),
  listIntegrationVendors: vi.fn().mockResolvedValue({ vendors: [] }),
  createIntegrationConnection: vi.fn(),
  patchIntegrationConnection: vi.fn(),
  testIntegrationConnection: vi.fn(),
}));

import { listIntegrationConnections } from '@/lib/integrationsApi';
import { ConnectionsSection } from '@/pages/integrations/connections/ConnectionsSection';

/**
 * Brief 3-5: the connections list on Settings & Trust › Integrations — an
 * honest empty state, one row per connection with its state in one badge,
 * the rejected count only when there is one, and a load failure that can
 * be retried.
 */

const connection = (over: Partial<IntegrationConnectionSummary>): IntegrationConnectionSummary => ({
  id: 'c1',
  vendor: 'FIELDGLASS',
  name: 'Fieldglass',
  status: 'CONNECTED',
  sandbox: true,
  hasCredentials: false,
  capabilities: ['pushTimesheets', 'pullWorkOrders'],
  mapping: {},
  scheduleMinutes: 60,
  eventDriven: true,
  lastSyncAt: '2026-10-15T18:00:00.000Z',
  nextSyncAt: '2026-10-15T19:00:00.000Z',
  lastError: null,
  recentErrors: 0,
  lastRun: null,
  createdAt: '2026-10-15T17:00:00.000Z',
  ...over,
});

function renderSection(canManage = true) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ConnectionsSection canManage={canManage} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ConnectionsSection', () => {
  it('says plainly when nothing is connected and offers the first connection to a manager', async () => {
    vi.mocked(listIntegrationConnections).mockResolvedValue({ connections: [] });
    renderSection();
    expect(await screen.findByText('No HR or VMS system connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect a system/i })).toBeInTheDocument();
  });

  it('lists each connection with its vendor, one state badge, and the rejected count only when there is one', async () => {
    vi.mocked(listIntegrationConnections).mockResolvedValue({
      connections: [
        connection({}),
        connection({ id: 'c2', vendor: 'ADP', name: 'ADP payroll', sandbox: false, hasCredentials: true, recentErrors: 3, status: 'ERROR', lastError: '3 of 56 records rejected' }),
        connection({ id: 'c3', vendor: 'WORKDAY', name: 'Workday', status: 'PAUSED', scheduleMinutes: null, eventDriven: false }),
      ],
    });
    renderSection(false);
    const list = await screen.findByRole('list', { name: 'HR and VMS connections' });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    // One vocabulary (F500 G4): Working · Needs attention · Failing; sandbox and paused are said beside it.
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText(/SAP Fieldglass · Sandbox/)).toBeInTheDocument();
    expect(screen.getByText(/· Paused ·/)).toBeInTheDocument();
    expect(screen.getByText('3 rejected')).toBeInTheDocument();
    expect(screen.getByText(/SAP Fieldglass/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ADP payroll/ })).toHaveAttribute('href', '/integrations/connections/c2');
    // A viewer gets no connect button.
    expect(screen.queryByRole('button', { name: /connect a system/i })).not.toBeInTheDocument();
  });

  it('a failed load says so and offers a retry', async () => {
    vi.mocked(listIntegrationConnections).mockRejectedValue(new Error('boom'));
    renderSection();
    expect(await screen.findByText(/couldn’t load the connections/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
