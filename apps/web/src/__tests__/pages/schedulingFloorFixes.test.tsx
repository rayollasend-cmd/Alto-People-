import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiMock, makeShift, renderSchedule, ASSOC, type ApiWorld } from './scheduling/scheduleHarness';

/**
 * Deep audit 2026-10-29, running the floor — the schedule:
 *   FLOOR-11  a full week fits 1024 with the sidebar open; Build/Publish wrap, never scroll away
 *   FLOOR-12  chips say the position (not one letter) and, across stores, the store
 *   FLOOR-13  phone cards: store first, no client for a one-client viewer, the zone once
 *   FLOOR-18  a shift that is over is read-only, and says when, where and whether it was worked
 *   FLOOR-26  Build and Publish have real names on a phone
 *   FLOOR-31  "N of tomorrow's shifts are held by high-risk attendees" opens on those shifts
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

import { WEEK_DAY_MIN_PX, weekGridColumns } from '@/pages/scheduling/weekGridFit';
import { positionShort, storeTags } from '@/pages/scheduling/chipLabels';
import { SchedulingToolbar, buildLabel } from '@/pages/scheduling/SchedulingToolbar';
import { MobileScheduleList, shiftCardPlace } from '@/pages/scheduling/MobileScheduleList';
import { oneWeekLater, shiftActions, shiftEnded, shiftOutcome } from '@/pages/scheduling/shiftHistory';
import { ShiftActionSheetBody } from '@/pages/scheduling/ShiftActionSheet';
import { AdminSchedulingView } from '@/pages/scheduling/AdminSchedulingView';
import { Dialog, DialogContent } from '@/components/ui/Dialog';
import type { QuickActions } from '@/pages/scheduling/ShiftHoverCard';

const HOUR = 3_600_000;

beforeEach(() => {
  world.calls = [];
  world.shifts = [];
  world.routes = [];
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FLOOR-11 — the week fits a 1024 screen with the sidebar open', () => {
  it('the compact grid needs no more than the ~700px it gets, and keeps the 248px rail when there is room', () => {
    const cols = weekGridColumns(7);
    // 1024 − 255 sidebar − page padding ≈ 702px for the grid.
    expect(cols.minWidthPx).toBeLessThanOrEqual(702);
    // The rail is bounded (it grows first, up to 248), the days flex.
    expect(cols.gridTemplateColumns).toBe(`minmax(150px, 248px) repeat(7, minmax(${WEEK_DAY_MIN_PX}px, 1fr))`);
  });

  it('the time grid fits too, its hour gutter included', () => {
    const cols = weekGridColumns(7, { railMaxPx: 200, betweenPx: 40, dayMinPx: 72 });
    expect(cols.minWidthPx).toBeLessThanOrEqual(702);
    expect(cols.gridTemplateColumns).toBe('minmax(150px, 200px) 40px repeat(7, minmax(72px, 1fr))');
  });

  it('the toolbar wraps on a desk instead of scrolling sideways, Build and Publish in one group', () => {
    render(
      <SchedulingToolbar
        view="week"
        onView={vi.fn()}
        periodLabel="Saturday, Oct 24 – Friday, Oct 30"
        chips={[{ key: 'client', label: 'All clients' }]}
        canManage
        openToFill={1}
        onBuild={vi.fn()}
        draftsToPublish={2}
        onPublish={vi.fn()}
      />,
    );
    const bar = screen.getByTestId('scheduling-toolbar');
    expect(bar.className).not.toMatch(/md:overflow-x-auto/);
    expect(bar.className).not.toMatch(/(^|\s)md:flex-nowrap/);
    const group = screen.getByTestId('toolbar-actions');
    expect(within(group).getByRole('button', { name: /build next week/i })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Publish 2 drafts' })).toBeInTheDocument();
  });
});

describe('FLOOR-26 — Build and Publish say their names on a phone', () => {
  it('Build is "Build next week, 1 open to fill", not the badge "1"; both show a visible word', () => {
    render(
      <SchedulingToolbar view="week" onView={vi.fn()} periodLabel="Oct 24 – Oct 30" chips={[]} canManage openToFill={1} onBuild={vi.fn()} draftsToPublish={0} onPublish={vi.fn()} />,
    );
    const build = screen.getByRole('button', { name: buildLabel(1) });
    expect(build).toHaveAccessibleName('Build next week, 1 open to fill');
    // The visible words are not hidden below sm any more.
    expect(within(build).getByText('Build').className).not.toMatch(/hidden/);
    const publish = screen.getByRole('button', { name: /^publish/i });
    expect(within(publish).getByText('Publish').className).not.toMatch(/hidden/);
    expect(publish).toBeDisabled();
  });
});

describe('FLOOR-12 — what a chip says', () => {
  it('keeps the position whole, less a generic tail', () => {
    expect(positionShort('Cashier')).toBe('Cashier');
    expect(positionShort('Shift Lead')).toBe('Shift Lead');
    expect(positionShort('Deli associate')).toBe('Deli');
    expect(positionShort('GM floor associate')).toBe('GM floor');
    expect(positionShort('Associate')).toBe('Associate');
  });

  it('tags stores only when the week spans more than one, and tells look-alikes apart', () => {
    const one = [{ locationId: 'a', locationName: 'Front Beach 218', location: null }];
    expect(storeTags(one).size).toBe(0);
    const three = [
      { locationId: 'a', locationName: 'Front Beach 218', location: null },
      { locationId: 'b', locationName: 'Destin Harbor 507', location: null },
      { locationId: 'c', locationName: 'Seaside Grand · Tallahassee', location: null },
      { locationId: 'a', locationName: 'Front Beach 218', location: null },
    ];
    // Two letters at most: a day is 78px wide at 1024.
    expect(Object.fromEntries(storeTags(three))).toEqual({ a: 'FB', b: 'DH', c: 'SG' });
    const twins = [
      { locationId: 'a', locationName: 'Front Beach 218', location: null },
      { locationId: 'b', locationName: 'Fort Bragg 9', location: null },
    ];
    expect(Object.fromEntries(storeTags(twins))).toEqual({ a: 'FB218', b: 'FB9' });
  });
});

describe('FLOOR-13 — the phone card', () => {
  const shift = makeShift({
    id: '88888888-8888-4888-8888-888888888888',
    clientName: 'Coastal Resort Holdings',
    locationName: 'Front Beach 218',
    position: 'Shift Lead',
    startsAt: '2026-07-14T11:00:00.000Z',
    endsAt: '2026-07-14T19:00:00.000Z',
    timezone: 'America/Chicago',
  });

  it('names the store first and leaves out the client for a one-client viewer', () => {
    expect(shiftCardPlace(shift, true)).toBe('Front Beach 218 · Shift Lead');
    expect(shiftCardPlace(shift, false)).toBe('Front Beach 218 · Shift Lead · Coastal Resort Holdings');
  });

  it('renders that line, and the zone once after both times', () => {
    render(
      <MobileScheduleList
        shifts={[shift]}
        associates={[]}
        dayAnchor={new Date(2026, 6, 14)}
        displayTimeZone="America/Chicago"
        canManage
        hideClientName
        onShiftClick={() => {}}
        onPrevDay={() => {}}
        onNextDay={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(screen.getByTestId('mobile-shift-place')).toHaveTextContent('Front Beach 218 · Shift Lead');
    expect(screen.queryByText(/Coastal Resort Holdings/)).not.toBeInTheDocument();
    // jsdom's display zone is not Chicago, so the zone shows — once.
    const time = screen.getByText(/6:00 AM–2:00 PM/);
    expect(time.textContent!.match(/C[DS]T/g)).toHaveLength(1);
  });
});

describe('FLOOR-18 — a shift that is over is the record, not a slot', () => {
  const now = new Date('2026-10-29T15:00:00.000Z');
  const ended = { status: 'ASSIGNED' as const, endsAt: '2026-10-28T19:00:00.000Z', assignedAssociateId: ASSOC };

  it('offers only a copy one week on — no edit, reassign, unassign, draft, cancel or delete', () => {
    const a = shiftActions(ended, true, now);
    expect(a.readOnly).toBe(true);
    expect(a.copyNextWeek).toBe(true);
    for (const k of ['edit', 'assign', 'unassign', 'publish', 'unpublish', 'duplicate', 'cancel', 'delete'] as const) expect(a[k]).toBe(false);
  });

  it('an unfilled one closes out; a future one keeps every action; a viewer gets none', () => {
    expect(shiftActions({ ...ended, status: 'OPEN', assignedAssociateId: null }, true, now)).toMatchObject({ closeOut: true, edit: false, delete: false });
    const future = shiftActions({ ...ended, endsAt: '2026-10-30T19:00:00.000Z' }, true, now);
    expect(future).toMatchObject({ edit: true, assign: true, unassign: true, cancel: true, delete: true, readOnly: false });
    expect(shiftActions({ ...ended, endsAt: '2026-10-30T19:00:00.000Z' }, false, now).readOnly).toBe(true);
    expect(shiftEnded({ endsAt: '2026-10-29T15:00:00.000Z' }, now)).toBe(true);
  });

  it('reads worked from the punch tied to the shift, else one overlapping it', () => {
    const s = { id: 's1', status: 'ASSIGNED' as const, startsAt: '2026-10-28T11:00:00.000Z', endsAt: '2026-10-28T19:00:00.000Z', assignedAssociateId: ASSOC };
    expect(shiftOutcome(s, [])).toEqual({ kind: 'no-punch' });
    expect(shiftOutcome(s, [{ shiftId: 's1', clockInAt: '2026-10-28T11:02:00.000Z', clockOutAt: '2026-10-28T19:05:00.000Z' }])).toMatchObject({ kind: 'worked' });
    expect(shiftOutcome(s, [{ shiftId: null, clockInAt: '2026-10-28T10:55:00.000Z', clockOutAt: '2026-10-28T19:00:00.000Z' }])).toMatchObject({ kind: 'worked' });
    // Yesterday's punch is not this shift's.
    expect(shiftOutcome(s, [{ shiftId: null, clockInAt: '2026-10-27T11:00:00.000Z', clockOutAt: '2026-10-27T19:00:00.000Z' }])).toEqual({ kind: 'no-punch' });
    expect(shiftOutcome({ ...s, status: 'CANCELLED' }, [])).toEqual({ kind: 'cancelled' });
  });

  it('copies one week on at the store wall clock across the fall-back weekend', () => {
    // Thu Oct 29 2026, 6 AM CDT (11:00Z) → Thu Nov 5, 6 AM CST (12:00Z).
    const s = makeShift({ id: 's2', startsAt: '2026-10-29T11:00:00.000Z', endsAt: '2026-10-29T19:00:00.000Z', timezone: 'America/Chicago' });
    expect(oneWeekLater(s)).toEqual({ startsAt: '2026-11-05T12:00:00.000Z', endsAt: '2026-11-05T20:00:00.000Z' });
  });

  it('the sheet says when, where, that it ended and that it was worked — and offers no edit', async () => {
    const shift = makeShift({
      id: '99999999-9999-4999-8999-999999999999',
      status: 'ASSIGNED',
      position: 'Shift Lead',
      clientName: 'Coastal Resort Holdings',
      locationName: 'Front Beach 218',
      assignedAssociateId: ASSOC,
      assignedAssociateName: 'Denise Whitaker',
      startsAt: new Date(Date.now() - 30 * HOUR).toISOString(),
      endsAt: new Date(Date.now() - 22 * HOUR).toISOString(),
    });
    world.routes = [
      [
        '/time/admin/entries',
        () => ({
          entries: [
            { id: 'e1', shiftId: shift.id, associateId: ASSOC, clockInAt: shift.startsAt, clockOutAt: shift.endsAt, status: 'APPROVED' },
          ],
        }),
      ],
    ];
    const noop = vi.fn();
    const actions = { onEdit: noop, onAssign: noop, onUnassign: noop, onCancel: noop, onDuplicate: noop, onDuplicateToEmployee: noop, onPublish: noop, onUnpublish: noop, onDelete: noop } as QuickActions;
    renderSchedule(
      <Dialog open>
        <DialogContent>
          <ShiftActionSheetBody shift={shift} canManage hideClientName statusLabel="Assigned" actions={actions} onCloseOut={noop} onCopyNextWeek={noop} onDone={noop} />
        </DialogContent>
      </Dialog>,
    );
    const facts = screen.getByTestId('shift-sheet-facts');
    expect(facts).toHaveTextContent('Front Beach 218');
    expect(facts).not.toHaveTextContent('Coastal Resort Holdings');
    expect(facts).toHaveTextContent(/Ended · Denise Whitaker/);
    expect(facts).toHaveTextContent(/–/);
    await waitFor(() => expect(screen.getByTestId('shift-sheet-outcome')).toHaveTextContent(/^Worked /));
    const sheet = screen.getByTestId('shift-sheet-actions');
    for (const name of [/^edit$/i, /reassign/i, /unassign/i, /move to draft/i, /cancel shift/i, /^delete$/i]) {
      expect(within(sheet).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(within(sheet).getByRole('link', { name: /view their time/i })).toHaveAttribute('href', expect.stringContaining(`associate=${ASSOC}`));
    expect(within(sheet).getByRole('button', { name: /copy to next week/i })).toBeInTheDocument();
  });
});

describe('FLOOR-31 — the high-risk link opens on the high-risk shifts', () => {
  it('?risk=1 shows only the flagged shifts, says how many, and "Show all shifts" brings the day back', async () => {
    const user = userEvent.setup();
    const day = new Date(Date.now() + 24 * HOUR);
    const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).toISOString();
    const risky = makeShift({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', position: 'Stocker', status: 'ASSIGNED', assignedAssociateId: ASSOC, assignedAssociateName: 'Ana Lopez', startsAt: at, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const calm = makeShift({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', position: 'Cashier', status: 'ASSIGNED', assignedAssociateId: ASSOC, assignedAssociateName: 'Ana Lopez', startsAt: at, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    world.shifts = [risky, calm];
    world.routes = [['/scheduling/shifts/high-risk', () => ({ shifts: [{ shiftId: risky.id, points: 3 }] })]];
    renderSchedule(<AdminSchedulingView canManage />, `/scheduling?view=day&risk=1&date=${ymd}`);
    const bar = await screen.findByTestId('risk-lens');
    await waitFor(() => expect(bar).toHaveTextContent('Showing the 1 shift held by a high-risk attendee'));
    expect(world.calls.some((c) => c.url === '/scheduling/shifts/high-risk')).toBe(true);
    await waitFor(() => expect(screen.getAllByText(/Stocker/).length).toBeGreaterThan(0));
    expect(screen.queryAllByText(/Cashier/)).toHaveLength(0);
    await user.click(within(bar).getByRole('button', { name: 'Show all shifts' }));
    await waitFor(() => expect(screen.getAllByText(/Cashier/).length).toBeGreaterThan(0));
    expect(screen.queryByTestId('risk-lens')).not.toBeInTheDocument();
  });
});
