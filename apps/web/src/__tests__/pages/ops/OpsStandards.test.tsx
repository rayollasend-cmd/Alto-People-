import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpsStandards } from '@/pages/ops/OpsStandards';
import type { getOpsScorecard } from '@/lib/opsApi';

type Scorecard = Awaited<ReturnType<typeof getOpsScorecard>>;

/**
 * Standards used to read "7 shifts · 8 temp checks · 2/60 handovers
 * carried" and file every row under the CLIENT's name. These assert the
 * three things that made it wrong, and the grid that answers the question
 * the board exists for.
 */

const SCORECARD: Scorecard = {
  weeks: 4,
  rows: [
    {
      clientName: 'Coastal Markets',
      storeName: 'Destin',
      locationId: 'loc-destin',
      period: 'OVERNIGHT',
      department: 'Frozen & Dairy',
      shifts: 8,
      sopPct: 72,
      incomplete: 2,
      tempAlerts: 3,
    },
    {
      clientName: 'Coastal Markets',
      storeName: 'Front Beach 218',
      locationId: 'loc-fb',
      period: 'MORNING',
      department: 'Grocery',
      shifts: 10,
      sopPct: 98,
      incomplete: 0,
      tempAlerts: 0,
    },
  ],
  totals: {
    shifts: 18,
    tempChecks: 200,
    tempInRange: 197,
    tempOutOfRange: 3,
    handoverCreated: 60,
    handoverCarried: 2,
    handoverReviewed: 40,
    handoverDismissed: 17,
    handoverPending: 1,
    onTime: 15,
    onTimeOf: 18,
  },
  weekly: [
    { weekKey: '2026-08-29', shifts: 4, sopPct: 80, incomplete: 1, tempAlerts: 0, onTime: 3, onTimeOf: 4 },
    { weekKey: '2026-09-05', shifts: 5, sopPct: 88, incomplete: 0, tempAlerts: 2, onTime: 4, onTimeOf: 5 },
    { weekKey: '2026-09-12', shifts: 4, sopPct: 96, incomplete: 0, tempAlerts: 0, onTime: 4, onTimeOf: 4 },
    { weekKey: '2026-09-19', shifts: 5, sopPct: 91, incomplete: 1, tempAlerts: 1, onTime: 4, onTimeOf: 5 },
  ],
  metricTrends: [],
};

describe('Standards', () => {
  it('names the store, not the chain, and states the handover disposition honestly', async () => {
    render(<OpsStandards scorecard={SCORECARD} onPickStore={vi.fn()} />);

    // "2 of 60 carried" read as a 3% pass rate. What matters is the one
    // item nobody decided, and what became of the other fifty-nine.
    expect(screen.getByText(/never decided by the next/i)).toBeInTheDocument();
    expect(screen.getByText('Reviewed')).toBeInTheDocument();
    expect(screen.getByText('Dismissed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Worst first/i }));
    // The building, not the client — this row printed "Coastal Markets".
    expect(screen.getByText('Destin')).toBeInTheDocument();
    expect(screen.queryByText('Coastal Markets')).not.toBeInTheDocument();
  });

  it('measures on-time submission, which nothing measured before', () => {
    render(<OpsStandards scorecard={SCORECARD} onPickStore={vi.fn()} />);
    expect(screen.getByText('Submitted on time')).toBeInTheDocument();
    expect(screen.getByText('83%')).toBeInTheDocument();
    expect(screen.getByText(/15 of 18 closed before the window ended/)).toBeInTheDocument();
  });

  it('puts store against shift in a grid, and narrows the board from a cell', async () => {
    const onPick = vi.fn();
    render(<OpsStandards scorecard={SCORECARD} onPickStore={onPick} />);

    const grid = screen.getByRole('table', {
      name: /completion by store and shift/i,
    });
    expect(within(grid).getByRole('rowheader', { name: 'Destin' })).toBeInTheDocument();

    await userEvent.click(within(grid).getByRole('button', { name: /Destin · Overnight/ }));
    expect(onPick).toHaveBeenCalledWith('loc-destin', 'OVERNIGHT');
  });

  it('says so rather than drawing an empty scorecard', () => {
    render(
      <OpsStandards
        scorecard={{ ...SCORECARD, totals: { ...SCORECARD.totals, shifts: 0 }, rows: [] }}
        onPickStore={vi.fn()}
      />,
    );
    expect(screen.getByText(/No shifts were submitted in this window/i)).toBeInTheDocument();
  });
});
