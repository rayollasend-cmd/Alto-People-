import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Shift } from '@alto-people/shared';
import { layoutLanes } from '@/pages/scheduling/dayLanes';
import { DayCalendarView } from '@/pages/scheduling/DayCalendarView';

/**
 * Role walk, ops 9: four open Housekeeper 9a–5p shifts drew as one block.
 * Overlaps get side-by-side lanes; identical open shifts fold into one
 * counted chip that expands on click.
 */

const TZ = 'America/New_York';
let seq = 0;
const shift = (over: Partial<Shift> = {}): Shift =>
  ({
    id: `s${(seq += 1)}`,
    clientId: 'c1',
    clientName: 'Grand Hotel',
    position: 'Housekeeper',
    startsAt: '2026-10-22T13:00:00.000Z', // 9a NY
    endsAt: '2026-10-22T21:00:00.000Z', // 5p
    location: null,
    locationId: 'l1',
    locationName: 'Front Beach',
    timezone: TZ,
    hourlyRate: null,
    payRate: null,
    effectivePayRate: null,
    status: 'OPEN',
    notes: null,
    assignedAssociateId: null,
    assignedAssociateName: null,
    assignedAt: null,
    cancellationReason: null,
    scheduledMinutes: 480,
    publishedAt: null,
    lateNoticeReason: null,
    acknowledgedAt: null,
    ...over,
  }) as Shift;

describe('layoutLanes', () => {
  it('gives overlapping shifts their own lanes and shares the cluster width', () => {
    const a = shift({ position: 'Cook', startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T17:00:00.000Z' });
    const b = shift({ position: 'Server', startsAt: '2026-10-22T15:00:00.000Z', endsAt: '2026-10-22T19:00:00.000Z' });
    const c = shift({ position: 'Host', startsAt: '2026-10-22T17:30:00.000Z', endsAt: '2026-10-22T20:00:00.000Z' });
    const d = shift({ position: 'Closer', startsAt: '2026-10-22T22:00:00.000Z', endsAt: '2026-10-23T02:00:00.000Z' });
    const out = layoutLanes([d, c, b, a]);
    const by = Object.fromEntries(out.map((o) => [o.shift.position, o]));
    expect(by.Cook).toMatchObject({ lane: 0, lanes: 2 });
    expect(by.Server).toMatchObject({ lane: 1, lanes: 2 });
    // Host starts after Cook ends: it reuses lane 0 inside the same cluster.
    expect(by.Host).toMatchObject({ lane: 0, lanes: 2 });
    // Closer is its own cluster.
    expect(by.Closer).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('folds identical open shifts into one counted chip, and unfolds a key on request', () => {
    const four = [shift(), shift(), shift(), shift()];
    const folded = layoutLanes(four);
    expect(folded).toHaveLength(1);
    expect(folded[0].group).toHaveLength(4);
    expect(folded[0].lanes).toBe(1);
    const open = layoutLanes(four, { unfoldKeys: new Set([folded[0].foldKey!]) });
    expect(open).toHaveLength(4);
    expect(open.every((o) => o.lanes === 4)).toBe(true);
    expect(new Set(open.map((o) => o.lane)).size).toBe(4);
  });

  it('never folds assigned shifts, even when identical', () => {
    const out = layoutLanes([shift({ assignedAssociateId: 'a1', status: 'ASSIGNED' }), shift({ assignedAssociateId: 'a2', status: 'ASSIGNED' })]);
    expect(out).toHaveLength(2);
    expect(out[0].lanes).toBe(2);
  });
});

describe('<DayCalendarView> lanes', () => {
  it('shows four identical open shifts as one "4 ×" chip that expands into four lanes', async () => {
    const user = userEvent.setup();
    const noop = async () => {};
    const four = [shift(), shift(), shift(), shift()];
    const onShiftClick = vi.fn();
    render(
      <DayCalendarView
        shifts={four}
        associates={[]}
        dayAnchor={new Date(2026, 9, 22)}
        displayTimeZone={TZ}
        canManage
        showAllAssociates={false}
        onShiftClick={onShiftClick}
        onCellCreate={vi.fn()}
        onShiftMove={noop}
        onShiftResize={noop}
        quickActions={{ onEdit: vi.fn(), onAssign: vi.fn(), onUnassign: noop, onCancel: noop, onDuplicate: noop, onDuplicateToEmployee: vi.fn(), onPublish: noop, onUnpublish: noop, onDelete: noop }}
      />,
    );
    const chip = screen.getByRole('button', { name: /4 × Housekeeper/ });
    expect(chip).toHaveAttribute('title', expect.stringContaining('4 × Housekeeper 9:00 AM–5:00 PM'));
    expect(document.querySelectorAll('[data-group-count="4"]')).toHaveLength(1);
    await user.click(chip);
    expect(onShiftClick).not.toHaveBeenCalled();
    const lanes = document.querySelectorAll('[data-lanes="4"]');
    expect(lanes).toHaveLength(4);
    expect(new Set(Array.from(lanes).map((el) => el.getAttribute('data-lane'))).size).toBe(4);
  });
});
