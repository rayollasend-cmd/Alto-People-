import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { __resetOverlayBackForTests, useOverlayBackButton } from '@/lib/useOverlayBackButton';

/**
 * The overlay Back sentinel, and the one race it has to survive: an
 * overlay closing while another opens in the same commit. history.back()
 * is asynchronous, so the new sentinel must wait for the old one's pop to
 * land — pushed in the same tick it ends up as a forward entry, and the
 * new overlay's own close then pops the page itself (the kiosk "number
 * issued" reveal sent HR back to whatever page they came from).
 *
 * jsdom never fires popstate for history.back(), so the tests dispatch
 * the pop by hand — that is the browser's "it landed".
 */

const realPush = window.history.pushState.bind(window.history);
let pushes: unknown[][];
let backs: number;

beforeEach(() => {
  __resetOverlayBackForTests();
  vi.useFakeTimers();
  pushes = [];
  backs = 0;
  window.history.pushState = ((...args: unknown[]) => {
    pushes.push(args);
  }) as History['pushState'];
  window.history.back = () => {
    backs += 1;
  };
});

afterEach(() => {
  vi.useRealTimers();
  window.history.pushState = realPush;
});

const landed = () => act(() => void window.dispatchEvent(new PopStateEvent('popstate')));

function overlay(open: boolean, onBack: () => boolean | void = () => undefined) {
  return renderHook(({ open }) => useOverlayBackButton(open, onBack), { initialProps: { open } });
}

describe('overlay Back sentinel', () => {
  it('parks a sentinel while open and pops it on close', () => {
    const a = overlay(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]![0]).toMatchObject({ altoOverlay: true });
    a.rerender({ open: false });
    expect(backs).toBe(1);
  });

  it('Back closes the topmost overlay instead of leaving the page', () => {
    const onBack = vi.fn();
    overlay(true, onBack);
    landed();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('an overlay that opens while the last one’s pop is in flight parks only once it lands', () => {
    const form = overlay(true);
    expect(pushes).toHaveLength(1);
    // Save: the form closes and the reveal opens, same commit.
    form.rerender({ open: false });
    const reveal = overlay(true);
    expect(backs).toBe(1);
    expect(pushes).toHaveLength(1); // not yet — the pop hasn't landed
    landed(); // the form's own pop, swallowed, and the reveal parks
    expect(pushes).toHaveLength(2);
    // Done on the reveal: pops ITS sentinel, and only that.
    reveal.rerender({ open: false });
    expect(backs).toBe(2);
  });

  it('the swallowed pop never counts as the user pressing Back', () => {
    const form = overlay(true);
    form.rerender({ open: false });
    const onBack = vi.fn();
    overlay(true, onBack);
    landed();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('when the pop never lands, the waiting overlay parks after the safety timeout', () => {
    const form = overlay(true);
    form.rerender({ open: false });
    overlay(true);
    expect(pushes).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(500));
    expect(pushes).toHaveLength(2);
  });

  it('an overlay closed again before the pop lands never parks and never pops', () => {
    const form = overlay(true);
    form.rerender({ open: false });
    const flash = overlay(true);
    flash.rerender({ open: false });
    landed();
    expect(pushes).toHaveLength(1);
    expect(backs).toBe(1);
  });
});
