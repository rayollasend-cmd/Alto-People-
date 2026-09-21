import { useEffect, useRef } from 'react';

/**
 * BACK CLOSES WHAT'S ON TOP.
 *
 * On a phone, Back is a gesture, not a button: the Android system back and
 * the iOS edge-swipe. In a web page those pop the URL stack, so a user with
 * a dialog open who swipes back doesn't close the dialog — they leave the
 * page underneath it and the dialog goes with it. Every native app does the
 * opposite: Back dismisses the topmost thing first.
 *
 * So while an overlay is open we park a sentinel entry on the history stack.
 * Back pops the sentinel, we hear `popstate`, and we close the overlay
 * instead of navigating. If the overlay is closed any other way — Esc, the
 * X, tapping Save — the cleanup takes the sentinel back off, so Back still
 * means "leave this page" and never needs pressing twice.
 *
 * `popstate` is a window event, so every open overlay would hear the same
 * press and a dialog-over-a-drawer would collapse both at once. Hence the
 * shared stack below and the single listener: one press, one dismissal,
 * newest first.
 */

interface ParkedOverlay {
  onBack: () => boolean | void;
  parked: boolean;
}

const stack: ParkedOverlay[] = [];
let wired = false;
/**
 * Pops WE caused, which must not be mistaken for the user pressing Back.
 *
 * Closing an overlay any other way (Save, Esc, the X) calls history.back()
 * in cleanup to take its own sentinel off. That is asynchronous and fires
 * a popstate like any other — and by the time it arrives the overlay has
 * already removed itself from the stack, so the listener reads the NEXT
 * overlay down and dismisses it too.
 *
 * Nested overlays are where that bites: confirming the pin inside the ride
 * booking closed the booking as well, losing the whole form.
 *
 * A queue of tokens rather than a counter: two overlays can unmount in one
 * commit, and each needs to retire ITS OWN entry. A bare count lets a
 * late safety-timeout decrement somebody else's pending pop and swallow a
 * real Back press.
 */
const selfPops: Array<{ done: boolean }> = [];

function park(entry: ParkedOverlay) {
  window.history.pushState({ ...window.history.state, altoOverlay: true }, '');
  entry.parked = true;
}

function ensureWired() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('popstate', () => {
    // Our own cleanup pop, not the user. Retire the oldest and swallow it.
    const mine = selfPops.shift();
    if (mine) {
      mine.done = true;
      return;
    }
    // Only the topmost overlay answers; anything below keeps its sentinel.
    // An empty stack means this Back belongs to the router, not to us.
    const top = stack[stack.length - 1];
    if (!top?.parked) return;
    top.parked = false; // the browser has already removed the entry
    if (top.onBack() === true) park(top); // refused — let Back try again
  });
}

/**
 * @param open  whether the overlay is currently showing
 * @param onBack called when Back was pressed. Return `true` to say the close
 *   was refused (an unsaved-changes prompt, say) — the sentinel is then put
 *   back so the next Back tries again.
 */
/**
 * Test-only. The pending-pop queue is module state, and jsdom does NOT
 * dispatch popstate for history.back() the way a browser does — so a
 * token pushed by one test's cleanup would still be sitting there for the
 * next test to swallow a real Back with. Clears between tests.
 */
export function __resetOverlayBackForTests(): void {
  selfPops.length = 0;
  stack.length = 0;
}

export function useOverlayBackButton(open: boolean, onBack: () => boolean | void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!open || typeof window === 'undefined' || !window.history) return;
    ensureWired();

    // The URL we parked at. If it has changed by cleanup time the user
    // navigated while the overlay was open, so our sentinel is buried and
    // popping it would undo their navigation — we leave it alone instead.
    const parkedAt = window.location.href;
    const entry: ParkedOverlay = { onBack: () => onBackRef.current(), parked: false };
    stack.push(entry);
    park(entry);

    return () => {
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      if (entry.parked && window.location.href === parkedAt) {
        entry.parked = false;
        const token = { done: false };
        selfPops.push(token);
        window.history.back();
        // If that pop never arrives (a browser that declines to go back),
        // the token would sit there and swallow the user's next real Back.
        // Retire it — and only it — after a beat. popstate lands well
        // inside this window in practice.
        window.setTimeout(() => {
          if (token.done) return;
          const i = selfPops.indexOf(token);
          if (i !== -1) selfPops.splice(i, 1);
        }, 500);
      }
    };
  }, [open]);
}
