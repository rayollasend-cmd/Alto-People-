import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoverageHeatmap } from '@/pages/portal/portalCharts';

/**
 * The week heatmap on a phone: hover tooltips never fire on touch, so a
 * tapped cell must read its figure out below the grid, and tapping it
 * again clears it. The day labels stay pinned while the 24 hours scroll.
 */

const hours = (n: number) => Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 14 ? n : 0));

function renderHeat() {
  return render(
    <CoverageHeatmap
      days={[
        { date: '2026-09-12', label: 'Sat 12', scheduled: hours(3), open: hours(1) },
        { date: '2026-09-13', label: 'Sun 13', scheduled: hours(2), open: hours(0) },
      ]}
      target={4}
      todayKey="2026-09-13"
      labels={{
        cell: (day, hour, scheduled, open) => `${day} ${hour}: ${scheduled} scheduled, ${open} open`,
        scale: { low: 'Fewer', high: 'More' },
        unfilled: 'Unfilled',
        belowTarget: 'Below 4',
        swipe: 'Swipe for later hours',
      }}
    />,
  );
}

describe('<CoverageHeatmap> on touch', () => {
  it('reads a tapped cell out loud, and clears it on a second tap', async () => {
    renderHeat();
    const user = userEvent.setup();
    const cell = screen.getByRole('button', { name: 'Sat 12 6a: 3 scheduled, 1 open' });
    await user.click(cell);
    const live = screen.getByText('Sat 12 6a: 3 scheduled, 1 open', { selector: 'div' });
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live.className).toContain('opacity-100');
    await user.click(cell);
    expect(live.className).toContain('opacity-0');
  });

  it('keeps the day labels pinned and shows the swipe hint', () => {
    renderHeat();
    expect(screen.getByText('Sat 12').className).toContain('sticky');
    expect(screen.getByText('Sun 13').className).toContain('text-gold');
    expect(screen.getByText('Swipe for later hours')).toBeInTheDocument();
  });
});
