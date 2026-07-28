import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ShiftStatus } from '@alto-people/shared';
import {
  SHIFT_STATUS_LABEL,
  StatusMark,
  StatusMarkLegend,
  TILE_DENSITY,
  statusLabelClass,
  statusTileClass,
} from '@/pages/scheduling/shiftTile';

const ALL_STATUSES: ShiftStatus[] = [
  'DRAFT',
  'OPEN',
  'ASSIGNED',
  'COMPLETED',
  'CANCELLED',
];

describe('<StatusMark>', () => {
  // The regression this component exists to prevent: the calendar chips used
  // to render `status[0]`, so COMPLETED and CANCELLED — a shift that was
  // worked and a shift that was pulled — both showed "C", told apart only by
  // badge hue. Colour-only encoding fails WCAG 1.4.1 and fails anyone
  // glancing at a dense grid.
  it('gives every status a distinct, non-colour-dependent name', () => {
    const names = ALL_STATUSES.map((status) => {
      const { unmount } = render(<StatusMark status={status} />);
      const name = screen.getByText(SHIFT_STATUS_LABEL[status]).textContent;
      unmount();
      return name;
    });
    expect(new Set(names).size).toBe(ALL_STATUSES.length);
  });

  it('separates COMPLETED from CANCELLED in the accessible name', () => {
    const { unmount } = render(<StatusMark status="COMPLETED" />);
    expect(screen.getByText('Worked')).toBeInTheDocument();
    unmount();

    render(<StatusMark status="CANCELLED" />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Worked')).not.toBeInTheDocument();
  });

  it('exposes the status as a title so mouse users get it too', () => {
    render(<StatusMark status="OPEN" />);
    expect(screen.getByTitle('Open')).toBeInTheDocument();
  });
});

describe('tile status treatments', () => {
  // Second cue, layered under the mark: status survives even when a very
  // short tile clips the shape.
  it('marks drafts with a dashed border and cancelled shifts as struck', () => {
    expect(statusTileClass('DRAFT')).toContain('border-dashed');
    expect(statusLabelClass('CANCELLED')).toContain('line-through');
  });

  it('leaves ordinary shifts untouched', () => {
    expect(statusTileClass('ASSIGNED')).toBe('');
    expect(statusLabelClass('ASSIGNED')).toBe('');
    expect(statusLabelClass('COMPLETED')).toBe('');
  });
});

describe('<StatusMarkLegend>', () => {
  it('documents every status the grid can render', () => {
    render(<StatusMarkLegend />);
    for (const status of ALL_STATUSES) {
      // Label appears twice per row (sr-only span + visible text); getAllBy
      // keeps the assertion honest about that without over-specifying.
      expect(
        screen.getAllByText(SHIFT_STATUS_LABEL[status]).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe('tile density', () => {
  // The week grid is associate-rows × day-columns, so its height is driven by
  // roster size rather than tile height — comfortable has to be the default
  // or the legibility win never reaches anyone.
  it('gives comfortable more room than compact', () => {
    expect(TILE_DENSITY.comfortable.minH).toBe('min-h-[34px]');
    expect(TILE_DENSITY.compact.minH).toBe('min-h-[26px]');
  });

  it('keeps every tile at or above the 24px WCAG 2.2 target minimum', () => {
    for (const key of ['comfortable', 'compact'] as const) {
      const px = Number(
        /min-h-\[(\d+)px\]/.exec(TILE_DENSITY[key].minH)?.[1] ?? '0',
      );
      expect(px).toBeGreaterThanOrEqual(24);
    }
  });
});
