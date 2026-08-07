import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSelection } from '@/lib/useSelection';

describe('useSelection', () => {
  it('toggle flips a single id in and out', () => {
    const { result } = renderHook(() => useSelection(['a', 'b']));
    expect(result.current.count).toBe(0);
    expect(result.current.isSelected('a')).toBe(false);

    act(() => result.current.toggle('a'));
    expect(result.current.isSelected('a')).toBe(true);
    expect(result.current.count).toBe(1);

    act(() => result.current.toggle('a'));
    expect(result.current.isSelected('a')).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('selectAll replaces the selection; clear empties it', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']));
    act(() => result.current.toggle('a'));
    act(() => result.current.selectAll(['b', 'c']));
    expect(result.current.isSelected('a')).toBe(false);
    expect(result.current.isSelected('b')).toBe(true);
    expect(result.current.isSelected('c')).toBe(true);
    expect(result.current.count).toBe(2);

    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
  });

  it('setMany adds and removes batches without touching other ids', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']));
    act(() => result.current.toggle('a'));
    act(() => result.current.setMany(['b', 'c'], true));
    expect(result.current.count).toBe(3);

    act(() => result.current.setMany(['a', 'b'], false));
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected('c')).toBe(true);
  });

  it('tri-state: allSelected / someSelected track the selectable ids', () => {
    const { result } = renderHook(() => useSelection(['a', 'b']));
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(false);

    act(() => result.current.toggle('a'));
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(true);

    act(() => result.current.toggle('b'));
    expect(result.current.allSelected).toBe(true);
    expect(result.current.someSelected).toBe(false);
  });

  it('toggleAll selects every selectable id, then clears', () => {
    const { result } = renderHook(() => useSelection(['a', 'b']));
    act(() => result.current.toggleAll());
    expect(result.current.allSelected).toBe(true);
    expect(result.current.count).toBe(2);

    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(0);
  });

  it('toggleAll from a partial selection completes it (tri-state click)', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggleAll());
    expect(result.current.allSelected).toBe(true);
    expect(result.current.count).toBe(3);
  });

  it('allSelected stays false when nothing is selectable', () => {
    const { result } = renderHook(() => useSelection([]));
    expect(result.current.allSelected).toBe(false);
    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(0);
  });

  it('extra selected ids (stale rows) do not break the tri-state', () => {
    // Simulate a refetch shrinking the selectable list under a selection.
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useSelection(ids),
      { initialProps: { ids: ['a', 'b'] } },
    );
    act(() => result.current.toggleAll());
    rerender({ ids: ['a'] });
    // 'b' is still selected but no longer selectable; 'a' covers the list.
    expect(result.current.allSelected).toBe(true);
  });
});
