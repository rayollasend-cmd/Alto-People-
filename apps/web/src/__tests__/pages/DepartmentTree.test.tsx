import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Department } from '@alto-people/shared';
import { renderAsAdmin } from './admin/orgAdminHarness';
import { DepartmentTree } from '@/pages/org/DepartmentTree';

const dept = (o: Partial<Department> & Pick<Department, 'id' | 'name'>): Department =>
  ({ clientId: 'c1', code: null, parentId: null, description: null, associateCount: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...o }) as Department;

const ROWS: Department[] = [
  dept({ id: 'ops', name: 'Operations', associateCount: 4 }),
  dept({ id: 'hk', name: 'Housekeeping', parentId: 'ops', code: 'HK', associateCount: 12 }),
  dept({ id: 'ln', name: 'Laundry', parentId: 'hk', associateCount: 3 }),
  dept({ id: 'fin', name: 'Finance', associateCount: 2 }),
];

describe('<DepartmentTree>', () => {
  it('draws the departments as a tree, with counts, and opens one', async () => {
    const onOpen = vi.fn();
    renderAsAdmin(<DepartmentTree rows={ROWS} onOpen={onOpen} />);
    const tree = screen.getByRole('tree', { name: 'Departments' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '1', '2', '3']);
    expect(within(tree).getByText('12 associates')).toBeInTheDocument();
    await userEvent.click(within(tree).getByRole('button', { name: /Laundry/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'ln' }));
  });

  it('search keeps every match and the path down to it', async () => {
    renderAsAdmin(<DepartmentTree rows={ROWS} onOpen={vi.fn()} />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search departments' }), 'laundry');
    const names = within(screen.getByRole('tree')).getAllByRole('treeitem').map((i) => i.textContent);
    expect(names.some((t) => t?.includes('Operations'))).toBe(true);
    expect(names.some((t) => t?.includes('Housekeeping'))).toBe(true);
    expect(names.some((t) => t?.includes('Laundry'))).toBe(true);
    expect(names.some((t) => t?.includes('Finance'))).toBe(false);
  });

  it('is a real tree from the keyboard: left closes, right opens, down moves, Enter opens', () => {
    const onOpen = vi.fn();
    renderAsAdmin(<DepartmentTree rows={ROWS} onOpen={onOpen} />);
    const tree = screen.getByRole('tree');
    const rows = () => within(tree).getAllByRole('treeitem');
    const ops = rows()[1]!; // Finance sorts first, then Operations
    expect(ops).toHaveTextContent('Operations');
    ops.focus();
    fireEvent.keyDown(ops, { key: 'ArrowLeft' });
    expect(ops).toHaveAttribute('aria-expanded', 'false');
    expect(rows()).toHaveLength(2);
    fireEvent.keyDown(ops, { key: 'ArrowRight' });
    expect(rows()).toHaveLength(4);
    fireEvent.keyDown(ops, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Housekeeping');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'hk' }));
  });
});
