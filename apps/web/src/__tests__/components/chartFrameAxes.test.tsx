import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChartFrame, nothingButZeros } from '@/components/ui/ChartFrame';
import { CONCEPT, CoverageCurve, HoursChart, PALETTE, WeekFillChart, dateHeading, dateTicks, fmtDateTick, parseAxisDate } from '@/components/ui/charts';
import { coverageDomain } from '@/components/ui/charts/coverage';

/**
 * Charts (F500 SH-2): a frame whose every value is zero says "nothing to
 * chart" (unless zero is a reading — a rate), titles wrap, the card can't
 * push a phone sideways; one date-tick formatter; coverage charts keep a
 * scale (and the contract line) on an all-zero day; one colour per concept.
 */

const cols = [
  { key: 'month', label: 'Month' },
  { key: 'profit', label: 'Profit', numeric: true, format: (v: unknown) => `$${String(v)}` },
];

describe('ChartFrame', () => {
  it('six $0 months are nothing to chart, not a blank 320px card', () => {
    const rows = ['Jan', 'Feb', 'Mar'].map((month) => ({ month, profit: 0 }));
    expect(nothingButZeros(cols, rows)).toBe(true);
    render(
      <ChartFrame title="Profit" summary="Flat." columns={cols} rows={rows} csvName="profit">
        <div data-testid="plot" />
      </ChartFrame>,
    );
    expect(screen.getByText('Nothing to chart yet')).toBeInTheDocument();
    expect(screen.queryByTestId('plot')).toBeNull();
    // No Table/CSV over an empty state.
    expect(screen.queryByRole('button', { name: 'Table' })).toBeNull();
  });

  it('one real number is data; null counts as nothing', () => {
    expect(nothingButZeros(cols, [{ month: 'Jan', profit: 0 }, { month: 'Feb', profit: 12 }])).toBe(false);
    expect(nothingButZeros(cols, [{ month: 'Jan', profit: null }, { month: 'Feb', profit: 0 }])).toBe(true);
    // No numeric column marked: every number in the rows is a measure.
    expect(nothingButZeros([{ key: 'w', label: 'Week' }], [{ w: 'Oct 3', n: 0 }])).toBe(true);
    // Nothing numeric at all: can't judge, so it draws.
    expect(nothingButZeros([{ key: 'w', label: 'Week' }], [{ w: 'Oct 3' }])).toBe(false);
  });

  it('a rate at zero is a reading: a percent column keeps drawing, and callers can say so for any measure', () => {
    const rate = [{ key: 'week', label: 'Week' }, { key: 'pct', label: 'Delivered', numeric: true, format: (v: unknown) => `${String(v)}%` }];
    const rows = [{ week: 'Oct 3', pct: 0 }, { week: 'Oct 10', pct: 0 }];
    const r1 = render(
      <ChartFrame title="Delivered" summary="0% every week." columns={rate} rows={rows} csvName="d">
        <div data-testid="plot" />
      </ChartFrame>,
    );
    expect(screen.getByTestId('plot')).toBeInTheDocument();
    r1.unmount();
    const r2 = render(
      <ChartFrame title="Incidents" summary="None." columns={cols} rows={[{ month: 'Jan', profit: 0 }]} csvName="i" zerosMeaningful>
        <div data-testid="plot" />
      </ChartFrame>,
    );
    expect(screen.getByTestId('plot')).toBeInTheDocument();
    r2.unmount();
    render(
      <ChartFrame title="Delivered" summary="x" columns={rate} rows={rows} csvName="d" zerosMeaningful={false}>
        <div data-testid="plot" />
      </ChartFrame>,
    );
    expect(screen.queryByTestId('plot')).toBeNull();
  });

  it('the title wraps (never "Where the funnel lo…"), the card can shrink in a grid, and the buttons go icon-only on a phone', () => {
    const { container } = render(
      <ChartFrame title="Where the funnel loses people, week by week, by source" summary="s" columns={cols} rows={[{ month: 'Jan', profit: 5 }]} csvName="f">
        <div />
      </ChartFrame>,
    );
    const h = screen.getByRole('heading', { name: /Where the funnel loses people/ });
    expect(h).not.toHaveClass('truncate');
    expect(container.firstElementChild).toHaveClass('min-w-0');
    const table = screen.getByRole('button', { name: 'Table' });
    expect(table.querySelector('span.hidden.sm\\:inline')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Download .* as CSV/ })).toBeInTheDocument();
  });
});

describe('date ticks', () => {
  it('reads every date shape as the calendar day it names — never ISO, never a day early', () => {
    expect(fmtDateTick('2026-10-03')).toBe('Oct 3');
    expect(fmtDateTick('2026-10-03T00:00:00.000Z')).toBe('Oct 3');
    expect(fmtDateTick('2026-09', 'month')).toBe('Sep');
    expect(fmtDateTick('2026-09-14', 'month', { year: true })).toBe('Sep ’26');
    expect(fmtDateTick('2026-08-01', 'quarter')).toBe('Q3 2026');
    expect(fmtDateTick('2026-Q4', 'quarter')).toBe('Q4 2026');
    expect(fmtDateTick('2026-03-01', 'year')).toBe('2026');
    // Not a date: passes through.
    expect(fmtDateTick('Week 3')).toBe('Week 3');
    expect(parseAxisDate(2026)).toBeNull();
    expect(parseAxisDate('8/31')).toBeNull();
  });

  it('a month axis that crosses a year names it on the first tick and on January', () => {
    const months = ['2025-11', '2025-12', '2026-01', '2026-02'];
    const f = dateTicks('month', months);
    expect(months.map((m) => f(m))).toEqual(['Nov ’25', 'Dec', 'Jan ’26', 'Feb']);
    // Within one year: just the month.
    const g = dateTicks('month', ['2026-01', '2026-02']);
    expect(g('2026-01')).toBe('Jan');
    expect(dateTicks('day')('2026-09-23')).toBe('Sep 23');
  });

  it('tooltip headings carry the year', () => {
    expect(dateHeading('2026-10-03')).toBe('Oct 3, 2026');
    expect(dateHeading('2026-10-03', 'week')).toBe('Week of Oct 3, 2026');
    expect(dateHeading('2026-10', 'month')).toBe('Oct 2026');
  });

  describe('west of UTC', () => {
    const tz = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = 'America/Los_Angeles';
    });
    afterEach(() => {
      process.env.TZ = tz;
    });
    it('a date-only value at UTC midnight is still its own day in Pacific time', () => {
      expect(fmtDateTick('2026-01-31T00:00:00.000Z')).toBe('Jan 31');
      expect(fmtDateTick('2026-01-31')).toBe('Jan 31');
    });
  });
});

describe('coverage charts', () => {
  it('always has a scale: zero to a whole-number top 15% above the peak, the target or 1', () => {
    expect(coverageDomain(0, 8)).toEqual([0, 12]);
    expect(coverageDomain(0, null)).toEqual([0, 4]);
    expect(coverageDomain(10, null)).toEqual([0, 12]);
    expect(coverageDomain(20, 8)).toEqual([0, 24]);
    expect(coverageDomain(3, 30)).toEqual([0, 36]);
  });

  const labels = { scheduled: 'Scheduled', open: 'Unfilled', contracted: 'Contracted', now: 'Now', at: (h: string) => h, empty: 'Nothing scheduled today' };
  const points = (n: number) => Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${hour}`, scheduled: hour === 9 ? n : 0, open: 0 }));

  it('an all-zero day says so over the plot, and keeps the contract in the key', () => {
    render(<CoverageCurve points={points(0)} target={8} nowHour={10} labels={labels} />);
    expect(screen.getByText('Nothing scheduled today')).toBeInTheDocument();
    expect(screen.getByText('Contracted')).toBeInTheDocument();
  });

  it('a day with people on it has no overlay', () => {
    render(<CoverageCurve points={points(3)} target={8} nowHour={10} labels={labels} />);
    expect(screen.queryByText('Nothing scheduled today')).toBeNull();
  });

  it('scheduled is one colour in every staffing chart; delivered is the second', () => {
    expect(CONCEPT.scheduled).toBe(PALETTE.primary);
    expect(CONCEPT.delivered).toBe(PALETTE.secondary);
    const swatch = (name: string) => screen.getByText(name).closest('li')!.querySelector('span')!.getAttribute('style') ?? '';
    const hours = render(<HoursChart days={[{ date: '2026-10-03', day: 'Sat', scheduledHours: 8, workedHours: 6 }]} labels={{ scheduled: 'Scheduled', worked: 'Delivered', heading: (d) => d }} />);
    expect(swatch('Scheduled')).toContain('chart-1');
    expect(swatch('Delivered')).toContain('chart-2');
    hours.unmount();
    render(<WeekFillChart days={[{ date: '2026-10-03', day: 'Sat', filled: 3, open: 1 }]} todayKey="2026-10-03" labels={{ filled: 'Scheduled', open: 'Unfilled', heading: (d) => d }} />);
    expect(swatch('Scheduled')).toContain('chart-1');
  });
});
