import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), apiFetch: fetchMock }));

import { PlatformSupportInbox, type InboxRequest } from '@/pages/support/PlatformSupportInbox';

const req = (o: Partial<InboxRequest>): InboxRequest => ({
  id: 'r1',
  tenant: 'Acme Hotels',
  requester: 'gm@acme.example',
  category: 'PROBLEM',
  subject: 'Kiosk will not pair',
  body: 'The front desk kiosk shows an error on pairing.',
  pageUrl: '/time-attendance/kiosk',
  appVersion: '2026.10.15',
  status: 'OPEN',
  reply: null,
  createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  resolvedAt: null,
  ...o,
});

const OPEN = [req({}), req({ id: 'r2', tenant: 'Bayside Inn', category: 'BILLING', subject: 'Invoice question', requester: 'ap@bayside.example' })];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return { id: 'r1', status: 'RESOLVED' };
    if (path === '/support/inbox?status=OPEN') return { requests: OPEN, counts: { OPEN: 2, IN_PROGRESS: 0, RESOLVED: 5 } };
    if (path === '/support/inbox?status=RESOLVED') return { requests: [req({ id: 'r9', status: 'RESOLVED', subject: 'Old thing', resolvedAt: new Date().toISOString() })], counts: { OPEN: 2, IN_PROGRESS: 0, RESOLVED: 5 } };
    return { requests: [], counts: { OPEN: 2, IN_PROGRESS: 0, RESOLVED: 5 } };
  });
});

describe('the platform support inbox (F500 G4)', () => {
  it('is a list — subject, organization, kind, age — with a count on each status', async () => {
    renderAs('HR_ADMINISTRATOR', <PlatformSupportInbox />, '/platform/support');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Kiosk will not pair')).toBeInTheDocument();
    expect(within(table).getByText('Problem')).toBeInTheDocument();
    expect(within(table).getByText('Billing')).toBeInTheDocument();
    expect(within(table).getAllByText('3h ago')).toHaveLength(2);
    // No inline answer boxes: the answer is in the drawer.
    expect(screen.queryByRole('textbox', { name: /Answer/ })).not.toBeInTheDocument();
    const statuses = screen.getByRole('radiogroup', { name: 'Requests by status' });
    expect(within(statuses).getByRole('radio', { name: /Open/ })).toHaveTextContent('2');
    expect(within(statuses).getByRole('radio', { name: /Resolved/ })).toHaveTextContent('5');
  });

  it('filters by organization, and keeps the resolved history a tab away', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <PlatformSupportInbox />, '/platform/support');
    await screen.findByRole('table');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Organization' }), 'Bayside Inn');
    await waitFor(() => expect(screen.queryByText('Kiosk will not pair')).not.toBeInTheDocument());
    expect(screen.getByText('Invoice question')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Resolved/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/support/inbox?status=RESOLVED'));
  });

  it('opens the request the bell linked to (?id=) and resolves it with an answer', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <PlatformSupportInbox />, '/platform/support?id=r1');
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('The front desk kiosk shows an error on pairing.')).toBeInTheDocument();
    await user.type(within(drawer).getByRole('textbox'), 'Re-issue the pairing code.');
    await user.click(within(drawer).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/support/r1', { method: 'PATCH', body: { status: 'RESOLVED', reply: 'Re-issue the pairing code.' } }));
  });
});
