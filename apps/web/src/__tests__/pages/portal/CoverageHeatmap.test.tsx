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

describe('<CoverageHeatmap> with the contract hour by hour (F500 G5)', () => {
  it('marks every contracted hour short of the contract — also an hour with nothing scheduled — and no hour outside it', () => {
    // Contract: 8 from 6 AM to 2 PM; the day has nothing scheduled at all.
    const contract = Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 14 ? 8 : 0));
    render(
      <CoverageHeatmap
        days={[{ date: '2026-09-12', label: 'Sat 12', scheduled: Array(24).fill(0), open: Array(24).fill(0), target: contract }]}
        target={null}
        todayKey="2026-09-13"
        labels={{
          cell: (day, hour, scheduled, open) => `${day} ${hour}: ${scheduled} scheduled, ${open} open`,
          scale: { low: 'Fewer', high: 'More' },
          unfilled: 'Unfilled',
          belowTarget: 'Below the contract',
        }}
      />,
    );
    // Eight contracted hours, all short; the other sixteen are not marked.
    expect(screen.getAllByTestId('heat-below')).toHaveLength(8);
    expect(screen.getByText('Below the contract')).toBeInTheDocument();
  });

  it('without per-hour targets keeps its old rule: only hours with a slot can be below the single target', () => {
    renderHeat();
    // Sat 6a–2p: 3 < 4 (8 hours); Sun 6a–2p: 2 < 4 (8 hours); empty hours unmarked.
    expect(screen.getAllByTestId('heat-below')).toHaveLength(16);
  });
});
