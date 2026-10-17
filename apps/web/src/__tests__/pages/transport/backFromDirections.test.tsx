import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBackFromDirections } from '@/pages/transport/DriverHome';

/**
 * A map app can't hand the driver back, so the stop card notices the
 * return: Navigate notes the stop, coming back to the tab asks "At {stop}?",
 * and marking the stop arrived clears it.
 */

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  window.sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('back from directions', () => {
  it('asks only after the driver left for directions and came back', () => {
    const { result } = renderHook(({ arrived }) => useBackFromDirections('run1:r1', arrived), { initialProps: { arrived: false } });
    expect(result.current.back).toBe(false);

    act(() => result.current.leaving());
    act(() => setVisibility('hidden'));
    expect(result.current.back).toBe(false);
    act(() => setVisibility('visible'));
    expect(result.current.back).toBe(true);

    act(() => result.current.dismiss());
    expect(result.current.back).toBe(false);
  });

  it('survives the tab reloading while the map had the screen, and clears on arrival', () => {
    window.sessionStorage.setItem('alto:drive:nav:run1:r1', '1');
    const { result, rerender } = renderHook(({ arrived }) => useBackFromDirections('run1:r1', arrived), { initialProps: { arrived: false } });
    expect(result.current.back).toBe(true);
    rerender({ arrived: true });
    expect(result.current.back).toBe(false);
    expect(window.sessionStorage.getItem('alto:drive:nav:run1:r1')).toBeNull();
  });
});
