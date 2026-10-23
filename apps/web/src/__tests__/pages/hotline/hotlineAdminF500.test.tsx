import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

/**
 * Hotline reports, F500: the five status tiles are the status filter
 * (neutral at 0, never a red "0 new"), the view lives in ?status=, and a
 * hotline nobody has used says so and hands HR the reporting link.
 */

const listReportQueue = vi.fn();
const getHotlineSummary = vi.fn();
vi.mock('@/lib/anonReport128Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/anonReport128Api')>()),
  listReportQueue: (...a: unknown[]) => listReportQueue(...a),
  getHotlineSummary: () => getHotlineSummary(),
}));

import { HotlineAdmin } from '@/pages/hotline/HotlineAdmin';

const report = (o: Record<string, unknown>) => ({
  id: 'r1',
  trackingCode: 'HX-1001',
  category: 'SAFETY',
  subject: 'Wet floor in receiving',
  status: 'INVESTIGATING',
  assignedToEmail: null,
  createdAt: '2026-10-10T12:00:00.000Z',
  updateCount: 1,
  resolvedAt: null,
  sla: { isOverdue: false, reason: null, ackHoursLeft: null, responseHoursLeft: 40 },
  ...o,
});

let search = '';
function Spy() {
  search = useLocation().search;
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  getHotlineSummary.mockResolvedValue({ newCount: 0, triagingCount: 0, investigatingCount: 2, resolvedCount: 1, closedCount: 0, totalCount: 3, overdueCount: 1 });
  listReportQueue.mockImplementation(async (status?: string) => ({
    reports:
      status === 'RECEIVED'
        ? []
        : [
            report({ id: 'r1', trackingCode: 'HX-1001', sla: { isOverdue: true, reason: 'unacked', ackHoursLeft: null, responseHoursLeft: null } }),
            report({ id: 'r2', trackingCode: 'HX-1002' }),
          ],
  }));
});

describe('<HotlineAdmin>', () => {
  it('tiles are the status filter, neutral at 0', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <><HotlineAdmin /><Spy /></>, '/hotline-admin');
    const group = await screen.findByRole('group', { name: 'Reports by status' });
    const newTile = within(group).getByRole('button', { name: /^New/ });
    expect(newTile).toHaveAttribute('aria-pressed', 'true');
    // Nothing new is a quiet state, not "0" in red.
    expect(newTile.className).not.toMatch(/alert/);
    expect(await screen.findByText('No new reports')).toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: /^Overdue/ }));
    expect(search).toContain('status=OVERDUE');
    expect(await screen.findByText('HX-1001')).toBeInTheDocument();
    // Overdue reads every status and keeps the late ones.
    expect(listReportQueue).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByText('HX-1002')).not.toBeInTheDocument();
  });

  it('a link with ?status= opens that view', async () => {
    renderAs('HR_ADMINISTRATOR', <HotlineAdmin />, '/hotline-admin?status=INVESTIGATING');
    await waitFor(() => expect(listReportQueue).toHaveBeenCalledWith('INVESTIGATING'));
    const group = await screen.findByRole('group', { name: 'Reports by status' });
    expect(within(group).getByRole('button', { name: /^Investigating/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a hotline nobody has used: no tiles, no filters, and the reporting link to share', async () => {
    getHotlineSummary.mockResolvedValue({ newCount: 0, triagingCount: 0, investigatingCount: 0, resolvedCount: 0, closedCount: 0, totalCount: 0, overdueCount: 0 });
    listReportQueue.mockResolvedValue({ reports: [] });
    const user = userEvent.setup();
    // After setup: user-event installs its own clipboard stub.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAs('HR_ADMINISTRATOR', <HotlineAdmin />, '/hotline-admin');
    expect(await screen.findByText('No reports filed yet')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Reports by status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter by status' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy the reporting link' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/hotline`);
  });
});
