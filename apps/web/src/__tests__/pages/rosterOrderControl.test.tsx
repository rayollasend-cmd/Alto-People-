import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssociateLite } from '@alto-people/shared';
import { WeekCalendarView } from '@/pages/scheduling/WeekCalendarView';

/**
 * Audit Tier 3 (roster order): the saved whiteboard order was reachable
 * only by a mouse drag of the grip. The ↑/↓ pair moves a row against its
 * visible neighbour — the same anchor move the server applies.
 */

const associates: AssociateLite[] = [
  { id: 'a1', firstName: 'Ana', lastName: 'Reyes', email: 'ana@x.test' },
  { id: 'a2', firstName: 'Ben', lastName: 'Ortiz', email: 'ben@x.test' },
  { id: 'a3', firstName: 'Cara', lastName: 'Cruz', email: 'cara@x.test' },
];

function renderGrid(onReorderRow?: (associateId: string, neighborId: string, dir: -1 | 1) => void) {
  const noop = async () => {};
  render(
    <WeekCalendarView
      shifts={[]}
      associates={associates}
      weekStart={new Date(2026, 9, 18)}
      canManage
      onShiftClick={vi.fn()}
      selectedIds={new Set()}
      onCellCreate={vi.fn()}
      onShiftMove={noop}
      onShiftResize={noop}
      quickActions={{ onEdit: vi.fn(), onAssign: vi.fn(), onUnassign: noop, onCancel: noop, onDuplicate: noop, onDuplicateToEmployee: vi.fn(), onPublish: noop, onUnpublish: noop, onDelete: noop }}
      onTemplateDrop={vi.fn()}
      showAllAssociates
      onReorderRow={onReorderRow}
    />,
  );
  return userEvent.setup();
}

describe('roster order control', () => {
  it('moves a row against its visible neighbour', async () => {
    const onReorderRow = vi.fn();
    const user = renderGrid(onReorderRow);
    await user.click(screen.getByRole('button', { name: 'Move Ben Ortiz down' }));
    expect(onReorderRow).toHaveBeenCalledWith('a2', 'a3', 1);
    await user.click(screen.getByRole('button', { name: 'Move Ben Ortiz up' }));
    expect(onReorderRow).toHaveBeenCalledWith('a2', 'a1', -1);
  });

  it('has nowhere to go at the ends of the roster', () => {
    renderGrid(vi.fn());
    expect(screen.getByRole('button', { name: 'Move Ana Reyes up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Cara Cruz down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Ana Reyes down' })).toBeEnabled();
  });

  it('shows no control when the view cannot reorder', () => {
    renderGrid(undefined);
    expect(screen.queryByRole('button', { name: /Move .* down/ })).not.toBeInTheDocument();
  });
});
