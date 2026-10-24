import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAs } from './hrPack/harness';

/**
 * The workforce home (F500 G5): a fill rate below target is never plain
 * white beside "all green", no stores today says so, the hero's labels
 * wrap instead of truncating, and a "Ready to schedule" row says for what,
 * where, and the first open shift they could take.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/lib/attendanceInsightsApi', () => ({
  getAttendanceTrends: vi.fn(async () => ({ generatedAt: '', siteId: null, fillTargetPct: 95, weeks: [] })),
  getAttendanceHeatmap: vi.fn(async () => ({ metric: 'late', from: '', to: '', siteId: null, by: 'site', unit: 'count', days: [], rows: [], max: 0, total: 0 })),
  getAttendanceCalendar: vi.fn(async () => ({ metric: 'callouts', from: '', to: '', siteId: null, firstDay: 6, days: [], total: 0, busiest: null, weekdayTotals: [0, 0, 0, 0, 0, 0, 0] })),
}));

import { apiFetch } from '@/lib/api';
import { WorkforceDashboard } from '@/pages/WorkforceDashboard';

function overview(over: Record<string, unknown> = {}) {
  return {
    generatedAt: new Date().toISOString(),
    now: { onFloor: 0, scheduledNow: 0, people: [], unscheduled: [], unscheduledCount: 0 },
    today: { filled: 0, open: 0, stores: [] },
    exceptionsToday: { count: 0, feed: [] },
    tomorrow: { confirmed: 0, unconfirmed: 0, open: 0 },
    week: { start: '2026-10-17', fillRatePct: 18, filled: 2, total: 11, noCallNoShows: 0, callOuts: 0, lates: 0 },
    incidentsToday: 0,
    needsAttention: 0,
    wire: [],
    close: { pendingApprovals: 0, payday: null },
    readyToSchedule: {
      count: 2,
      rows: [
        {
          associateId: 'a1',
          name: 'Ana Reyes',
          clientName: 'Coastal Resort Holdings',
          approvedAt: '2026-10-19T15:00:00.000Z',
          position: 'Stocker',
          storeName: 'Front Beach 218',
          earliestOpen: { shiftId: 's9', startsAt: '2026-10-24T10:00:00.000Z', position: 'Stocker', storeName: 'Front Beach 218', timezone: 'America/Chicago' },
        },
        { associateId: 'a2', name: 'Ben Ortiz', clientName: null, approvedAt: '2026-10-18T15:00:00.000Z', position: null, storeName: null, earliestOpen: null },
      ],
    },
    rebalance: [],
    dispatch: { openNext48h: 0, upcoming: [] },
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/workforce/overview') return overview() as never;
    if (path === '/workforce/supervisors') return { supervisors: [] } as never;
    if (path.startsWith('/me/decisions')) return { decisions: [] } as never;
    if (path.startsWith('/me/inbox')) return { total: 0, sources: [] } as never;
    return {} as never;
  });
});

describe('the workforce home', () => {
  it('no stores today is "No shifts today", not "All stores green"; 18% fill against 95% is alert, not white', async () => {
    renderAs('WORKFORCE_MANAGER', <WorkforceDashboard />);
    const status = await screen.findByTestId('board-status');
    expect(status).toHaveTextContent('No shifts today');
    expect(status).not.toHaveTextContent(/green/i);
    const fill = screen.getByText('fill this week').closest('a')!;
    expect(within(fill).getByText('18%')).toHaveClass('text-alert');
    // The hero's labels wrap (two lines), never truncate ("stores n…").
    expect(screen.getByText('fill this week')).toHaveClass('line-clamp-2');
    expect(screen.getByText('fill this week')).not.toHaveClass('truncate');
  });

  it('a ready-to-schedule row says for what, where, and the first open shift they could take', async () => {
    renderAs('WORKFORCE_MANAGER', <WorkforceDashboard />);
    const rows = await screen.findAllByTestId('ready-row');
    expect(rows[0]).toHaveTextContent('Stocker · Front Beach 218');
    const first = within(rows[0]).getByRole('link', { name: /First open shift: Sat Oct 24, 5:00 AM · Front Beach 218/ });
    expect(first).toHaveAttribute('href', '/scheduling?shift=s9');
    expect(rows[1]).toHaveTextContent('No open shift for them yet');
  });
});
