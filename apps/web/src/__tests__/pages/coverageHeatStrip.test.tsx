import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssociateLite, Shift } from '@alto-people/shared';
import { hourlyCoverage } from '@/pages/scheduling/weekGridFit';
import { CoverageHeatStrip, worstGap } from '@/pages/scheduling/CoverageHeatStrip';
import { WeekCalendarView } from '@/pages/scheduling/WeekCalendarView';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

/**
 * Role walk, ops 12: the week grid's footer knew each day's peak only; a
 * strip of headcount by hour shows the mid-afternoon hole, and tapping a
 * short hour posts that many open shifts.
 */

const TZ = 'America/New_York';
const shift = (over: Partial<Shift> = {}): Shift =>
  ({
    id: Math.random().toString(36).slice(2),
    clientId: 'c1',
    clientName: 'Grand Hotel',
    position: 'Housekeeper',
    startsAt: '2026-10-22T13:00:00.000Z', // Thu 9a NY
    endsAt: '2026-10-22T21:00:00.000Z', // 5p
    location: null,
    locationId: 'l1',
    locationName: 'Front Beach',
    timezone: TZ,
    hourlyRate: null,
    payRate: null,
    effectivePayRate: null,
    status: 'ASSIGNED',
    notes: null,
    assignedAssociateId: 'a1',
    assignedAssociateName: 'Ana Reyes',
    assignedAt: null,
    cancellationReason: null,
    scheduledMinutes: 480,
    publishedAt: null,
    lateNoticeReason: null,
    acknowledgedAt: null,
    ...over,
  }) as Shift;

describe('hourlyCoverage', () => {
  it('counts heads at the top of every hour in the store zone, open ones apart', () => {
    const cov = hourlyCoverage(
      [
        shift({ assignedAssociateId: 'a1' }),
        shift({ assignedAssociateId: null, status: 'OPEN', startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T21:00:00.000Z' }), // 1p–5p open
        shift({ status: 'CANCELLED' }),
      ],
      ['2026-10-22'],
      TZ,
    );
    const day = cov.get('2026-10-22')!;
    expect(day.scheduled[8]).toBe(0);
    expect(day.scheduled[9]).toBe(1);
    expect(day.scheduled[13]).toBe(2);
    expect(day.open[13]).toBe(1);
    expect(day.scheduled[16]).toBe(2);
    expect(day.scheduled[17]).toBe(0);
  });

  it('carries an overnight shift into the next day', () => {
    const cov = hourlyCoverage(
      [shift({ startsAt: '2026-10-23T02:00:00.000Z', endsAt: '2026-10-23T10:00:00.000Z' })], // Thu 10p – Fri 6a NY
      ['2026-10-22', '2026-10-23'],
      TZ,
    );
    expect(cov.get('2026-10-22')!.scheduled[22]).toBe(1);
    expect(cov.get('2026-10-22')!.scheduled[23]).toBe(1);
    expect(cov.get('2026-10-23')!.scheduled[0]).toBe(1);
    expect(cov.get('2026-10-23')!.scheduled[5]).toBe(1);
    expect(cov.get('2026-10-23')!.scheduled[6]).toBe(0);
  });

  it('names the deepest shortfall and how many hours are short', () => {
    const scheduled = Array(24).fill(3);
    scheduled[14] = 1;
    scheduled[15] = 2;
    expect(worstGap({ scheduled, open: Array(24).fill(0) }, 3)).toEqual({ hours: 2, gap: 2 });
  });
});

describe('<CoverageHeatStrip>', () => {
  it('marks short hours and posts the gap on click', async () => {
    const user = userEvent.setup();
    const onGap = vi.fn();
    const scheduled = Array(24).fill(4);
    scheduled[14] = 2;
    render(
      <CoverageHeatStrip
        days={[{ dayKey: '2026-10-22', dayStart: new Date(2026, 9, 22), label: 'Thu Oct 22', coverage: { scheduled, open: Array(24).fill(0) } }]}
        target={4}
        onCoverageGap={onGap}
      />,
    );
    const short = screen.getByRole('button', { name: /Thu Oct 22 2p: 2 scheduled vs 4 — 2 short/ });
    expect(short).toHaveAttribute('data-short', 'true');
    await user.click(short);
    expect(onGap).toHaveBeenCalledWith(new Date(2026, 9, 22), 2);
    // A covered hour is not a control.
    expect(screen.getByRole('button', { name: /Thu Oct 22 9a: 4 scheduled vs 4$/ })).toBeDisabled();
    expect(screen.getByText(/1 of 1 days run under the floor target of 4/)).toBeInTheDocument();
  });
});

describe('<WeekCalendarView> coverage strip and past columns', () => {
  const associates: AssociateLite[] = [{ id: 'a1', firstName: 'Ana', lastName: 'Reyes', email: 'ana@x.test' }];
  const noop = async () => {};
  const quickActions = {
    onEdit: vi.fn(),
    onAssign: vi.fn(),
    onUnassign: noop,
    onCancel: noop,
    onDuplicate: noop,
    onDuplicateToEmployee: vi.fn(),
    onPublish: noop,
    onUnpublish: noop,
    onDelete: noop,
  };

  it('renders the strip under the grid when a target is set and dims days that ended', () => {
    const weekStart = new Date(2026, 9, 18); // Sun Oct 18 (local)
    render(
      <WeekCalendarView
        shifts={[shift({ startsAt: '2026-10-19T13:00:00.000Z', endsAt: '2026-10-19T21:00:00.000Z', status: 'OPEN', assignedAssociateId: null, assignedAssociateName: null })]}
        associates={associates}
        weekStart={weekStart}
        canManage
        onShiftClick={vi.fn()}
        selectedIds={new Set()}
        onCellCreate={vi.fn()}
        onShiftMove={noop}
        onShiftResize={noop}
        quickActions={quickActions}
        onTemplateDrop={vi.fn()}
        showAllAssociates
        coverageTarget={2}
        onCoverageGap={vi.fn()}
      />,
    );
    expect(screen.getByTestId('coverage-heat-strip')).toBeInTheDocument();
    expect(screen.getAllByText('Coverage by hour').length).toBeGreaterThan(0);
    // Oct 19 2026 is long over: the column is dimmed and its open shift went unfilled.
    expect(document.querySelectorAll('[data-past="true"]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('unfilled-tag')).toHaveTextContent('Unfilled');
    // F500 G2: the tag is its own line inside the tile (it truncates there)
    // instead of a pill pushed past the tile's edge.
    const tag = screen.getByTestId('unfilled-tag');
    expect(tag.className).toMatch(/truncate/);
    expect(tag.closest('button')).not.toBeNull();
    // Coverage rows read "Mon 19", one line; the full date is the tooltip.
    const label = within(screen.getByTestId('coverage-heat-strip')).getByText('Mon 19');
    expect(label.getAttribute('title')).toMatch(/Mon/);
    expect(label.className).toMatch(/whitespace-nowrap/);
  });

  it('says what "off the roster" means, and offers someone who can place people the way to', () => {
    const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
    render(
      <AuthContext.Provider value={{ can: (c: Capability) => caps.has(c) } as never}>
        <MemoryRouter>
          <WeekCalendarView
            shifts={[shift({ startsAt: '2026-10-19T13:00:00.000Z', endsAt: '2026-10-19T21:00:00.000Z', assignedAssociateId: 'gone', assignedAssociateName: 'Maria Lopez' })]}
            associates={associates}
            weekStart={new Date(2026, 9, 18)}
            canManage
            onShiftClick={vi.fn()}
            selectedIds={new Set()}
            onCellCreate={vi.fn()}
            onShiftMove={noop}
            onShiftResize={noop}
            quickActions={quickActions}
            onTemplateDrop={vi.fn()}
            showAllAssociates
          />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    const note = screen.getByTestId('off-roster');
    expect(note).toHaveTextContent('Not on this store’s roster');
    expect(note.getAttribute('title')).toMatch(/Not placed at this store/);
    expect(screen.getByRole('link', { name: 'Place here' })).toHaveAttribute('href', '/people?associateId=gone&return=%2Fscheduling');
  });
});
