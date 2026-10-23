import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QboConflictRow, QboSyncStatus } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  QBO_KEY: ['books', 'quickbooks'],
  getQboStatus: vi.fn(),
  startQboConnect: vi.fn(),
  disconnectQbo: vi.fn(),
  pauseQbo: vi.fn(),
  resumeQbo: vi.fn(),
  syncQboNow: vi.fn(),
  relinkQboCharts: vi.fn(),
  importQboHistory: vi.fn(),
  listQboOutbox: vi.fn(),
  retryQboOutbox: vi.fn(),
  retryQboFailed: vi.fn(),
  listQboEvents: vi.fn(),
  listQboConflicts: vi.fn(),
  resolveQboConflict: vi.fn(),
  listQboMappings: vi.fn(),
  listQboAccounts: vi.fn(),
  relinkQboAccount: vi.fn(),
  saveQboSettings: vi.fn(),
}));
vi.mock('@/lib/books/quickbooksApi', () => api);

import { QuickbooksSyncPage } from '@/pages/books/quickbooks/QuickbooksSyncPage';
import { syncSentence } from '@/pages/books/quickbooks/qboWords';

/**
 * Books › QuickBooks sync: before connecting it says what goes each way;
 * connected, it shows who and when, what's waiting, and the decisions —
 * each side field by field, settled with one button. Read-only people see
 * the state but none of the buttons.
 */

const SETTINGS = { classMode: 'CLIENT', locationMode: 'SITE' } as const;
const status = (o: Partial<QboSyncStatus> = {}): QboSyncStatus => ({
  connection: {
    realmId: '9130',
    companyName: 'Alto People LLC',
    status: 'CONNECTED',
    connectedAt: '2026-10-01T12:00:00.000Z',
    lastPushAt: '2026-10-19T12:00:00.000Z',
    lastPullAt: '2026-10-19T12:01:00.000Z',
    pulledThrough: '2026-10-19T12:01:00.000Z',
    lastError: null,
    qboClosingDate: '2026-08-31',
  },
  counts: { pending: 2, failed: 1, conflicts: 1, linked: 120 },
  sandboxOnly: false,
  webhooksOn: true,
  settings: SETTINGS,
  ...o,
});

const conflict: QboConflictRow = {
  id: '00000000-0000-4000-8000-000000000c01',
  localType: 'Vendor',
  localId: '00000000-0000-4000-8000-000000000a01',
  summary: 'The vendor “Enterprise Fleet” was changed on the site and in QuickBooks.',
  reason: 'BOTH_CHANGED',
  fields: [
    { label: 'Name', site: 'Enterprise Fleet Leasing', quickbooks: 'Enterprise Holdings', differs: true },
    { label: 'Active', site: 'Yes', quickbooks: 'Yes', differs: false },
  ],
  qboType: 'Vendor',
  qboId: '58',
  status: 'OPEN',
  resolvedByName: null,
  resolvedAt: null,
  createdAt: '2026-10-19T12:01:00.000Z',
  link: '/books/vendors/00000000-0000-4000-8000-000000000a01',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listQboConflicts.mockResolvedValue({ conflicts: [conflict] });
  api.listQboOutbox.mockResolvedValue({ rows: [] });
  api.listQboEvents.mockResolvedValue({ events: [], nextCursor: null });
  api.listQboMappings.mockResolvedValue({ rows: [] });
});

describe('<QuickbooksSyncPage>', () => {
  it('not connected: says what goes each way and connects', async () => {
    api.getQboStatus.mockResolvedValue(status({ connection: null, counts: { pending: 0, failed: 0, conflicts: 0, linked: 0 }, sandboxOnly: true }));
    api.startQboConnect.mockResolvedValue({ authorizeUrl: '/api/books/quickbooks/callback?code=STUB' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderAs('FINANCE_ACCOUNTANT', <QuickbooksSyncPage />, '/books/quickbooks');
    expect(await screen.findByRole('heading', { name: 'Connect your company’s QuickBooks' })).toBeInTheDocument();
    expect(screen.getByText('From here to QuickBooks')).toBeInTheDocument();
    expect(screen.getByText('From QuickBooks to here')).toBeInTheDocument();
    expect(screen.getByText(/simulated QuickBooks company/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect QuickBooks' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/books/quickbooks/callback?code=STUB'));
    vi.unstubAllGlobals();
  });

  it('connected: the company, the counts, and a decision settled with one button', async () => {
    api.getQboStatus.mockResolvedValue(status());
    api.resolveQboConflict.mockResolvedValue({ ...conflict, status: 'KEPT_QUICKBOOKS' });
    renderAs('FINANCE_ACCOUNTANT', <QuickbooksSyncPage />, '/books/quickbooks');
    expect(await screen.findByText('Alto People LLC')).toBeInTheDocument();
    expect(screen.getByText(/books are closed through/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for a decision')).toBeInTheDocument();
    expect(await screen.findByText(conflict.summary)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'What each side says' });
    expect(within(table).getByText('Enterprise Fleet Leasing')).toBeInTheDocument();
    expect(within(table).getByText('Enterprise Holdings')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep QuickBooks’' }));
    await waitFor(() => expect(api.resolveQboConflict).toHaveBeenCalledWith(conflict.id, 'QUICKBOOKS'));
  });

  it('sync now reports what went each way', async () => {
    api.getQboStatus.mockResolvedValue(status());
    api.syncQboNow.mockResolvedValue({ connected: true, pushed: { sent: 3, skipped: 0, failed: 0, conflicts: 0 }, pulled: { ok: 2, conflicts: 1, errors: 0, skipped: 0 }, error: null });
    renderAs('FINANCE_ACCOUNTANT', <QuickbooksSyncPage />, '/books/quickbooks');
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(api.syncQboNow).toHaveBeenCalled());
    expect(syncSentence({ pushed: { sent: 3, conflicts: 0, failed: 0 }, pulled: { ok: 2, conflicts: 1 } })).toBe('3 sent to QuickBooks, 2 brought in, 1 waiting for a decision.');
  });

  it('needs reconnecting: says so and offers it', async () => {
    api.getQboStatus.mockResolvedValue(status({ connection: { ...status().connection!, status: 'NEEDS_RECONNECT', lastError: 'QuickBooks refused to renew the sign-in.' } }));
    renderAs('FINANCE_ACCOUNTANT', <QuickbooksSyncPage />, '/books/quickbooks');
    expect(await screen.findByText('QuickBooks needs to be reconnected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect QuickBooks' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('the owner reads it all but has none of the buttons', async () => {
    api.getQboStatus.mockResolvedValue(status());
    renderAs('EXECUTIVE_CHAIRMAN', <QuickbooksSyncPage />, '/books/quickbooks');
    expect(await screen.findByText(conflict.summary)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep the version here' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });
});
