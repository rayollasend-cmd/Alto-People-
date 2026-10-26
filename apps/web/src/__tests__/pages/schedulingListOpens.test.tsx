import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiMock, asPhone, makeShift, renderSchedule, type ApiWorld } from './scheduling/scheduleHarness';
import { listRangeDefault, restoredListStatus, unfilledThisWeekRange } from '@/pages/scheduling/listRange';
import { kpiParts } from '@/pages/scheduling/SchedulingToolbar';
import type { SchedulingKpis } from '@/lib/schedulingApi';
import { fmtDateOnlyRange } from '@/lib/format';

/**
 * F500 G2 — the schedule list is the daily planning surface: it opens on
 * today and the next two weeks, soonest first. "Open" means still
 * fillable (the KPI line's "open"); the shifts that ended open are their
 * own chip, "Went unfilled", which the KPI line's "N unfilled" opens and
 * where each row closes out. The chip and the range live in the URL.
 */

const world: ApiWorld = { shifts: [], calls: [] };
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return { ...real, apiFetch: (url: string, init?: { method?: string; body?: unknown }) => apiMock(world)(url, init) };
});
vi.mock('@/lib/storeScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => ({ clientId: '', setClientId: () => {}, clients: [], loading: false }),
}));

import { AdminSchedulingView } from '@/pages/scheduling/AdminSchedulingView';

const HOUR = 3_600_000;
const PAST = '44444444-4444-4444-8444-444444444444';
const FUTURE = '55555555-5555-4555-8555-555555555555';

/** Local midnight of YYYY-MM-DD, as the page sends it. */
const midnightIso = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toISOString();
};
const shiftCalls = () =>
  world.calls
    .filter((c) => c.url.startsWith('/scheduling/shifts?') && !c.url.includes('id='))
    .map((c) => new URLSearchParams(c.url.split('?')[1]));

beforeEach(() => {
  world.calls = [];
  world.shifts = [
    makeShift({ id: PAST, startsAt: new Date(Date.now() - 30 * HOUR).toISOString(), endsAt: new Date(Date.now() - 22 * HOUR).toISOString() }),
    makeShift({ id: FUTURE }),
  ];
  // The server answers ?ended= the way the API does.
  world.routes = [
    [
      '/scheduling/shifts?',
      (url) => {
        const p = new URLSearchParams(url.split('?')[1]);
        const ended = p.get('ended');
        const now = Date.now();
        return {
          shifts: world.shifts.filter((s) =>
            ended === 'true' ? Date.parse(s.endsAt) <= now : ended === 'false' ? Date.parse(s.endsAt) > now : true,
          ),
          truncated: false,
        };
      },
    ],
  ];
  window.localStorage.clear();
  // A range left over from the old "this month" default is not where the list opens.
  window.localStorage.setItem('alto:scheduling.anchors.v1', JSON.stringify({ listFrom: '2026-01-01', listTo: '2026-01-31' }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the list opens on what is ahead', () => {
  it('with no chip picked it opens on every shift ahead, never an empty "Open" list (F500 2026-10-26)', async () => {
    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=list');
    await waitFor(() => expect(shiftCalls().length).toBeGreaterThan(0));
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
  });

  it('asks for still-open shifts from today through the next two weeks, and shows no past row', async () => {
    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=list&status=OPEN');
    await waitFor(() => expect(shiftCalls().length).toBeGreaterThan(0));
    const p = shiftCalls().at(-1)!;
    const def = listRangeDefault('OPEN');
    expect(p.get('status')).toBe('OPEN');
    expect(p.get('ended')).toBe('false');
    expect(p.get('from')).toBe(midnightIso(def.from));
    // Inclusive last day → the next midnight as the exclusive bound.
    const end = new Date(midnightIso(def.to));
    end.setDate(end.getDate() + 1);
    expect(p.get('to')).toBe(end.toISOString());
    expect(await screen.findAllByRole('button', { name: /^assign$/i })).toHaveLength(1);
    expect(screen.queryByText('Unfilled')).not.toBeInTheDocument();
    // "Open" is a chip; "Went unfilled" is its own.
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Went unfilled' })).toBeInTheDocument();
    // The KPI line names its window.
    await waitFor(() => expect(screen.getByTestId('kpi-line')).toHaveTextContent(/^This week:/));
  });

  it('"N unfilled" on the KPI line opens the Went unfilled list for this week, where a row closes out', async () => {
    const user = userEvent.setup();
    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=list');
    await user.click(await screen.findByTestId('kpi-unfilled'));

    await waitFor(() => expect(shiftCalls().some((p) => p.get('ended') === 'true')).toBe(true));
    const p = shiftCalls().filter((x) => x.get('ended') === 'true').at(-1)!;
    expect(p.get('status')).toBe('OPEN');
    expect(p.get('from')).toBe(midnightIso(unfilledThisWeekRange().from));
    expect(screen.getByRole('radio', { name: 'Went unfilled' })).toHaveAttribute('aria-checked', 'true');

    // The past row: "Close out", never "Cancel" or "Assign".
    const unfilled = await screen.findByText('Unfilled');
    const row = (unfilled.closest('tr') ?? unfilled.closest('[data-row]') ?? unfilled.parentElement!.parentElement!) as HTMLElement;
    expect(within(row).queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
    // The bulk action is here too, counting the rows in view.
    expect(screen.getByTestId('close-out-unfilled')).toHaveTextContent('Close out 1 unfilled past shift');

    await user.click(within(row).getByRole('button', { name: /^close out$/i }));
    await user.click(await screen.findByRole('button', { name: /^close out$/i, hidden: false }));
    await waitFor(() => expect(world.calls.some((c) => c.url === '/scheduling/shifts/close-out-unfilled')).toBe(true));
    expect(world.calls.find((c) => c.url === '/scheduling/shifts/close-out-unfilled')!.init?.body).toEqual({ shiftIds: [PAST] });
  });

  it('an empty list says which list and which days, with the way to every shift', async () => {
    world.shifts = [world.shifts[0]!]; // only the past one
    const user = userEvent.setup();
    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=list&status=OPEN');
    const def = listRangeDefault('OPEN');
    expect(await screen.findByText(`No open shifts · ${fmtDateOnlyRange(def.from, def.to)}`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show every shift' }));
    await waitFor(() => expect(shiftCalls().at(-1)!.get('status')).toBeNull());
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the chip and the range in the URL, and says the range in words', async () => {
    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=list&status=ASSIGNED&from=2026-11-01&to=2026-11-05');
    await waitFor(() => expect(shiftCalls().length).toBeGreaterThan(0));
    const p = shiftCalls().at(-1)!;
    expect(p.get('status')).toBe('ASSIGNED');
    expect(p.get('ended')).toBeNull();
    expect(p.get('from')).toBe(midnightIso('2026-11-01'));
    expect(screen.getByRole('radio', { name: 'Assigned' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the list chips and their windows', () => {
  it('history chips look back 30 days; the planning chips look two weeks ahead; a stored history chip reopens as All', () => {
    const now = new Date(2026, 9, 22, 15, 0); // Thu Oct 22, 2026
    expect(listRangeDefault('OPEN', now)).toEqual({ from: '2026-10-22', to: '2026-11-04' });
    expect(listRangeDefault('ASSIGNED', now)).toEqual({ from: '2026-10-22', to: '2026-11-04' });
    expect(listRangeDefault('UNFILLED', now)).toEqual({ from: '2026-09-22', to: '2026-10-22' });
    expect(listRangeDefault('CANCELLED', now)).toEqual({ from: '2026-09-22', to: '2026-11-04' });
    // The workweek so far: Sat Oct 17 → today.
    expect(unfilledThisWeekRange(now)).toEqual({ from: '2026-10-17', to: '2026-10-22' });
    // A stored history chip, or none at all, reopens on everything ahead —
    // never on an empty "Open" list nobody picked (F500 2026-10-26).
    expect(restoredListStatus('COMPLETED')).toBe('ALL');
    expect(restoredListStatus('UNFILLED')).toBe('ALL');
    expect(restoredListStatus(null)).toBe('ALL');
    expect(restoredListStatus('OPEN')).toBe('OPEN');
    expect(restoredListStatus('ASSIGNED')).toBe('ASSIGNED');
  });

  it('kpiParts keeps open and unfilled apart, so "unfilled" can be its own link', () => {
    const kpis: SchedulingKpis = {
      from: '', to: '', openShifts: 9, openUpcoming: 0, unfilledPast: 9, assignedShifts: 2, draftShifts: 0, completedShifts: 0,
      totalShifts: 11, fillRatePercent: 18, totalScheduledMinutes: 77 * 60, projectedLaborCost: 1100, shiftsWithoutRate: 0,
    } as SchedulingKpis;
    expect(kpiParts(kpis, null)).toEqual([
      { key: 'filled', text: '18% filled' },
      { key: 'open', text: '0 open' },
      { key: 'unfilled', text: '9 unfilled' },
      { key: 'hours', text: '77.0h' },
      { key: 'cost', text: '$1,100' },
    ]);
  });
});

describe('one navigator on a phone', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = asPhone();
  });
  afterEach(() => restore());

  it('the list view has no day strip over it; the day view strip starts on Saturday, the org week', async () => {
    const first = renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=list');
    await screen.findAllByRole('button', { name: /^assign$/i });
    expect(screen.queryByTestId('mobile-day-strip')).not.toBeInTheDocument();
    first.unmount();

    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=day');
    const strip = await screen.findByTestId('mobile-day-strip');
    const days = within(strip).getAllByRole('tab');
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveTextContent(/^Sat/i);
    expect(days[6]).toHaveTextContent(/^Fri/i);
    // The toolbar's week/day range control is not a second navigator here.
    expect(screen.queryByTestId('toolbar-period')).not.toBeInTheDocument();
  });
});
