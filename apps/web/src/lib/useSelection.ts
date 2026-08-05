import { useCallback, useMemo, useState } from 'react';

/**
 * Set-based row selection for bulk queues (approvals, time review,
 * documents, W-4 re-collection). One mechanic everywhere; each page keeps
 * its own RULES by passing the ids that are currently selectable —
 * the tri-state header helpers (`allSelected` / `someSelected` /
 * `toggleAll`) are computed against exactly that list.
 *
 *   const ids = useMemo(() => rows.filter(canPick).map((r) => r.id), [rows]);
 *   const sel = useSelection(ids);
 *   <input type="checkbox" checked={sel.allSelected}
 *          ref={(el) => { if (el) el.indeterminate = sel.someSelected; }}
 *          onChange={sel.toggleAll} />
 */
export interface Selection {
  /** The selected ids. */
  selected: ReadonlySet<string>;
  /** `selected.size` — convenience for "(n)" button labels. */
  count: number;
  isSelected: (id: string) => boolean;
  /** Flip one id. */
  toggle: (id: string) => void;
  /** Add or remove a batch (e.g. a day-group header checkbox). */
  setMany: (ids: readonly string[], select: boolean) => void;
  /** Replace the selection with exactly these ids. */
  selectAll: (ids: readonly string[]) => void;
  clear: () => void;
  /** Every selectable id is selected (false when none are selectable). */
  allSelected: boolean;
  /** Something is selected, but not everything — drive `indeterminate`. */
  someSelected: boolean;
  /** Header-checkbox behavior: clear when all selected, else select all. */
  toggleAll: () => void;
}

export function useSelection(selectableIds: readonly string[] = []): Selection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: readonly string[], select: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: readonly string[]) => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const allSelected = useMemo(
    () => selectableIds.length > 0 && selectableIds.every((id) => selected.has(id)),
    [selectableIds, selected],
  );
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    if (allSelected) clear();
    else selectAll(selectableIds);
  }, [allSelected, clear, selectAll, selectableIds]);

  return {
    selected,
    count: selected.size,
    isSelected,
    toggle,
    setMany,
    selectAll,
    clear,
    allSelected,
    someSelected,
    toggleAll,
  };
}
