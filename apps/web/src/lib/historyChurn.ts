import { captureException } from '@sentry/react';

/**
 * WHO IS WRITING TO history 100 TIMES A SECOND.
 *
 * Safari throws `SecurityError: Attempt to use history.replaceState() more
 * than 100 times per 10 seconds`, and because React Router's navigation is
 * async it arrives as an unhandled promise REJECTION — so the stack Sentry
 * gets is the router's internals unwinding, not the code that asked. The
 * app frame it does keep is the route chunk, which narrows it to a page
 * and no further.
 *
 * That is not enough to fix anything. This trips deliberately BELOW
 * Safari's limit and captures a stack at the moment the churn starts,
 * while the caller is still on it — the difference between "something on
 * /people writes history a lot" and a file and line.
 *
 * It is a diagnostic, not a fix: it changes no behaviour, and the throttle
 * it reports is Safari's, not ours. Delete it once the culprit is named.
 */

/** Safari's ceiling is 100 per 10s. Trip early enough to beat it, high
 *  enough that ordinary use — filter changes, a tab switch — never does. */
const LIMIT = 60;
const WINDOW_MS = 10_000;

/** One report per page load: the whole point is that it repeats. */
let reported = false;

export function watchHistoryChurn(): void {
  if (typeof window === 'undefined' || !window.history) return;

  const calls: number[] = [];

  const note = (method: 'pushState' | 'replaceState') => {
    const now = Date.now();
    calls.push(now);
    // Drop anything older than the window; the array stays small.
    while (calls.length > 0 && now - calls[0]! > WINDOW_MS) calls.shift();
    if (calls.length < LIMIT || reported) return;
    reported = true;
    // Thrown, not constructed-and-passed, so the stack starts HERE — one
    // frame below the caller we are trying to name.
    const err = new Error(
      `history.${method} called ${calls.length} times in ${WINDOW_MS / 1000}s`,
    );
    captureException(err, {
      tags: { churn: method },
      extra: {
        // The path only. Query strings are stripped app-wide before send
        // (see sentry.ts beforeSend) because they carry associate ids.
        pathname: window.location.pathname,
        callsInWindow: calls.length,
        windowMs: WINDOW_MS,
      },
    });
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = function patched(
      this: History,
      ...args: Parameters<History['pushState']>
    ) {
      // Count first, then delegate: if the delegate throws (Safari's
      // throttle), we have already recorded the call that broke it.
      try {
        note(method);
      } catch {
        /* a diagnostic must never be the reason navigation fails */
      }
      return original(...args);
    };
  }
}
