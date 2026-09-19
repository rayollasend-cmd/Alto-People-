import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useState } from 'react';
import { useOverlayBackButton } from '@/lib/useOverlayBackButton';

/**
 * Back closes what's on top. On a phone, Back is the system gesture, and in
 * a web page it pops the URL — so an open dialog would take the whole page
 * with it. These check that the sentinel history entry is parked while an
 * overlay is open, popped by Back instead of the page, and taken back off
 * when the overlay is dismissed some other way.
 */

function Overlay({
  open,
  onBack,
}: {
  open: boolean;
  onBack: () => boolean | void;
}) {
  useOverlayBackButton(open, onBack);
  return <div>{open ? 'open' : 'closed'}</div>;
}

function back() {
  // jsdom's history.back() is async and doesn't dispatch popstate itself.
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/people');
});

describe('Back closes the overlay, not the page', () => {
  it('parks an entry while open, and Back closes the overlay instead of navigating', () => {
    const onBack = vi.fn();
    const { rerender } = render(<Overlay open={false} onBack={onBack} />);
    const before = window.location.pathname;

    rerender(<Overlay open onBack={onBack} />);
    // The sentinel sits on the stack at the same URL — nothing navigated.
    expect(window.history.state).toMatchObject({ altoOverlay: true });
    expect(window.location.pathname).toBe(before);

    act(() => back());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(before);
  });

  it('puts the entry back when the close is refused, so the next Back tries again', () => {
    // A dirty form answers "true" — it showed a discard prompt instead.
    const onBack = vi.fn(() => true as const);
    render(<Overlay open onBack={onBack} />);

    act(() => back());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(window.history.state).toMatchObject({ altoOverlay: true });

    act(() => back());
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('takes its entry back off when the overlay closes some other way', () => {
    const spy = vi.spyOn(window.history, 'back');
    const { rerender } = render(<Overlay open onBack={() => {}} />);
    // Closed by Esc / the X / a successful save — not by Back.
    rerender(<Overlay open={false} onBack={() => {}} />);
    // Otherwise Back would need pressing twice to leave the page.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('leaves the entry alone when the user navigated while it was open', () => {
    const spy = vi.spyOn(window.history, 'back');
    const { rerender } = render(<Overlay open onBack={() => {}} />);
    // A link inside the overlay took them elsewhere; our sentinel is buried
    // now, and popping it would undo their navigation.
    window.history.pushState(null, '', '/scheduling');
    rerender(<Overlay open={false} onBack={() => {}} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('unwinds nested overlays newest-first', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Nested() {
      const [innerOpen, setInnerOpen] = useState(true);
      useOverlayBackButton(true, outer);
      useOverlayBackButton(innerOpen, () => {
        inner();
        setInnerOpen(false);
      });
      return null;
    }
    render(<Nested />);
    act(() => back());
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
