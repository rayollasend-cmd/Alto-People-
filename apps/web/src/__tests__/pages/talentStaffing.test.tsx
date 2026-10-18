import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { renderAs } from './hrPack/harness';
import type { CareerPosition } from '@/lib/career126Api';
import type { Goal } from '@/lib/perf84Api';

const listStoreBench = vi.fn();
const updateBench = vi.fn();
const getNineBox = vi.fn();
const ratePotential = vi.fn();
vi.mock('@/lib/successionBenchApi', () => ({
  BENCH_READINESS_LABELS: { READY_NOW: 'Ready now', READY_6_MONTHS: 'In 6 months', READY_12_MONTHS: 'In 12 months' },
  listStoreBench: (...a: unknown[]) => listStoreBench(...a),
  addToBench: vi.fn(),
  updateBench: (...a: unknown[]) => updateBench(...a),
  removeFromBench: vi.fn(),
  getNineBox: (...a: unknown[]) => getNineBox(...a),
  ratePotential: (...a: unknown[]) => ratePotential(...a),
}));

import { CareerLadderView } from '@/pages/career/CareerPosition';
import { NineBox, SuccessionByStore } from '@/pages/succession/SuccessionStores';
import { GoalCascade } from '@/pages/performance/GoalCascade';

const POSITION: CareerPosition = {
  ladder: {
    id: 'l1',
    name: 'Field leadership',
    family: 'Field leadership',
    levels: [
      { id: 'r1', rank: 1, title: 'Crew member', description: null },
      { id: 'r2', rank: 2, title: 'Lead', description: null },
      { id: 'r3', rank: 3, title: 'Shift supervisor', description: null },
    ],
  },
  currentLevelId: 'r1',
  placedBy: 'field',
  next: {
    id: 'r2',
    rank: 2,
    title: 'Lead',
    progressPct: 50,
    requirements: [
      { kind: 'tenure', label: '', met: true, have: 5, need: 3 },
      { kind: 'review', label: '', met: false, have: null, need: 3 },
    ],
  },
  otherLadders: [],
};

describe('career: you are here', () => {
  it('marks your rung, measures the next, and reads to a screen reader', async () => {
    const { container } = render(<CareerLadderView position={POSITION} self />);
    const here = screen.getByText('You are here').closest('li')!;
    expect(here).toHaveAttribute('aria-current', 'step');
    expect(within(here).getByText('Crew member')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: /progress toward lead/i });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('You: 5 months · Needs: 3 months')).toBeInTheDocument();
    expect(screen.getByText('You: No review yet · Needs: 3 of 5')).toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it('says so when someone is not on a ladder', () => {
    render(<CareerLadderView position={{ ...POSITION, ladder: null, currentLevelId: null, next: null }} self={false} />);
    expect(screen.getByText(/not on a career ladder yet/i)).toBeInTheDocument();
  });
});

describe('succession by store and the 9-box', () => {
  beforeEach(() => {
    listStoreBench.mockResolvedValue({
      stores: [
        {
          id: 's1',
          name: 'Front Beach',
          clientId: 'c1',
          clientName: 'Coastal',
          leads: [{ userId: 'u1', associateId: 'a1', name: 'Lee Lead', role: 'SHIFT_SUPERVISOR', photoUrl: null }],
          bench: [{ id: 'b1', associateId: 'a2', name: 'Ana Next', title: null, photoUrl: null, readiness: 'READY_6_MONTHS', notes: null }],
          strength: 'thin',
        },
        { id: 's2', name: 'Bay Point', clientId: 'c1', clientName: 'Coastal', leads: [], bench: [], strength: 'empty' },
      ],
      summary: { stores: 2, covered: 0, thin: 1, empty: 1, withoutLead: 1 },
    });
    updateBench.mockResolvedValue({ ok: true });
    getNineBox.mockResolvedValue({
      people: [
        { associateId: 'a1', name: 'Sia Star', title: null, photoUrl: null, reviewRating: 5, performance: 3, potential: 3, potentialNotes: null },
        { associateId: 'a2', name: 'Fin Fresh', title: null, photoUrl: null, reviewRating: 3, performance: 2, potential: null, potentialNotes: null },
      ],
      truncated: false,
      limit: 2000,
    });
  });

  it('shows each store’s leads and bench, filters to the empty ones, and changes readiness', async () => {
    renderAs('HR_ADMINISTRATOR', <SuccessionByStore />);
    expect(await screen.findByText('Front Beach')).toBeInTheDocument();
    expect(screen.getByText('Lee Lead')).toBeInTheDocument();
    expect(screen.getByText(/^No lead placed at this/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Readiness for Ana Next'), 'READY_NOW');
    await waitFor(() => expect(updateBench).toHaveBeenCalledWith('b1', { readiness: 'READY_NOW' }));
    await userEvent.click(screen.getByRole('button', { name: 'No bench' }));
    expect(screen.queryByText('Front Beach')).toBeNull();
    expect(screen.getByText('Bay Point')).toBeInTheDocument();
  });

  it('the 9-box places people and lists who still needs a potential rating', async () => {
    renderAs('HR_ADMINISTRATOR', <NineBox />);
    const star = await screen.findByRole('gridcell', { name: /^Star: High potential, Exceeds expectations — 1 people/ });
    expect(within(star).getByRole('button', { name: /sia star/i })).toBeInTheDocument();
    expect(screen.getByText(/Not on the grid yet \(1\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rate potential' })).toBeInTheDocument();
  });
});

const goal = (o: Partial<Goal> & Pick<Goal, 'id' | 'title'>): Goal => ({
  associateId: null,
  associateName: null,
  scope: 'PERSON',
  kind: 'GOAL',
  description: null,
  parentGoalId: null,
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  status: 'ACTIVE',
  progressPct: 40,
  keyResults: [],
  ...o,
});

describe('goals cascade', () => {
  it('draws company → team → person as a keyboard tree', () => {
    const onOpen = vi.fn();
    render(
      <GoalCascade
        onOpen={onOpen}
        goals={[
          goal({ id: 'g1', title: '98% fill rate', scope: 'COMPANY' }),
          goal({ id: 'g2', title: 'Front Beach fill rate', scope: 'TEAM', parentGoalId: 'g1', ownerName: 'Lee Lead' }),
          goal({ id: 'g3', title: 'Cover two weekends', scope: 'PERSON', parentGoalId: 'g2', associateId: 'a1', associateName: 'Ana Lopez' }),
        ]}
      />,
    );
    const tree = screen.getByRole('tree', { name: 'Goal cascade' });
    const rows = () => within(tree).getAllByRole('treeitem');
    expect(rows().map((r) => r.getAttribute('aria-level'))).toEqual(['1', '2', '3']);
    const first = rows()[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(rows()).toHaveLength(1);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(rows()[1]!, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'g2' }));
    expect(screen.getByRole('progressbar', { name: '98% fill rate progress' })).toHaveAttribute('aria-valuenow', '40');
  });
});
