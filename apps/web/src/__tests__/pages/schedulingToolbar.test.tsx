import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchedulingToolbar, kpiLine } from '@/pages/scheduling/SchedulingToolbar';
import type { SchedulingKpis } from '@/lib/schedulingApi';

/**
 * Role walk, ops 4 — one sticky toolbar carries the view, the period, the
 * scope chips, Build (with the open-shift badge) and Publish; the KPIs
 * read as one line.
 */

afterEach(cleanup);

const kpis: SchedulingKpis = {
  from: '2026-10-19',
  to: '2026-10-25',
  openShifts: 9,
  openUpcoming: 4,
  wentUnfilled: 5,
  assignedShifts: 2,
  draftShifts: 3,
  completedShifts: 0,
  totalShifts: 11,
  fillRatePercent: 18,
  totalScheduledMinutes: 77 * 60,
  projectedLaborCost: 1100,
  shiftsWithoutRate: 0,
};

describe('<SchedulingToolbar>', () => {
  it('is sticky and carries view, period, chips, Build with its badge, and Publish with the draft count', async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    const onBuild = vi.fn();
    const onPublish = vi.fn();
    const onRemove = vi.fn();
    render(
      <SchedulingToolbar
        view="week"
        onView={onView}
        periodLabel="Oct 20 – Oct 26"
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onToday={vi.fn()}
        chips={[{ key: 'client', label: 'The Grand Hotel', onRemove }]}
        canManage
        openToFill={4}
        onBuild={onBuild}
        draftsToPublish={3}
        onPublish={onPublish}
      />,
    );
    const bar = screen.getByTestId('scheduling-toolbar');
    expect(bar.className).toMatch(/sticky/);
    expect(bar.className).toMatch(/h-12/);
    expect(screen.getByTestId('toolbar-period')).toHaveTextContent('Oct 20 – Oct 26');
    expect(screen.getByText('The Grand Hotel')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar-open-badge')).toHaveTextContent('4');
    await user.click(screen.getByRole('radio', { name: 'Day' }));
    expect(onView).toHaveBeenCalledWith('day');
    await user.click(screen.getByRole('button', { name: /clear the grand hotel/i }));
    expect(onRemove).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /publish/i }));
    expect(onPublish).toHaveBeenCalled();
  });

  it('"Edit filters" sits outside the chips scroller, so it never clips', () => {
    render(
      <SchedulingToolbar
        view="week"
        onView={vi.fn()}
        periodLabel="Saturday, Oct 17 – Friday, Oct 23"
        chips={[{ key: 'client', label: 'Coastal Resort Holdings' }]}
        onOpenFilters={vi.fn()}
        canManage
        openToFill={0}
        draftsToPublish={0}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Edit filters' });
    // Outside the chips' scroller: in the toolbar's own group of controls, not inside the chips.
    expect(btn.closest('[data-testid="scheduling-toolbar"]')).toBe(screen.getByTestId('scheduling-toolbar'));
    expect(btn.parentElement!.className).not.toMatch(/overflow-x-auto/);
    expect(btn.className).toMatch(/whitespace-nowrap/);
    expect(btn.className).toMatch(/shrink-0/);
  });

  it('kpiLine reads as one line, with upcoming and unfilled apart, and the forecast beside the hours', () => {
    expect(kpiLine(kpis, null)).toBe('18% filled · 4 open · 5 unfilled · 77.0h · $1,100');
    expect(kpiLine(kpis, 66)).toBe('18% filled · 4 open · 5 unfilled · 77.0h scheduled · 66.0h forecast · $1,100');
    // A client-bound role never sees the dollars.
    expect(kpiLine({ ...kpis, projectedLaborCost: null, wentUnfilled: 0 }, null)).toBe('18% filled · 4 open · 77.0h');
  });
});
