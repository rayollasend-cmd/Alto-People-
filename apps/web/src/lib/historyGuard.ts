import { captureException } from '@sentry/react';

/**
 * SAFARI'S HISTORY BUDGET, AND WHO IS SPENDING IT.
 *
 * Safari throws `SecurityError: Attempt to use history.replaceState() more
 * than 100 times per 10 seconds` (older builds: per 30 seconds), and because
 * React Router's navigation is async it arrives as an unhandled promise
 * rejection — the router's internals unwinding, not the code that asked.
 *
 * Two things live here, both installed once at boot:
 *
 *   1. The guard. `replaceState` is metered: up to BUDGET real calls per
 *      WINDOW go straight through; past that, calls are coalesced — the
 *      latest one is kept and written the moment the window has room
 *      again. The app's own state is already right by then (React Router
 *      updates its location in memory before touching the browser), so
 *      the only thing that lags is the address bar, by at most a few
 *      seconds, on a page that was misbehaving anyway. `pushState` is
 *      never deferred (an overlay's Back sentinel must land now) but it
 *      counts against the same budget, because Safari's does.
 *
 *   2. The diagnostic. A burst that crosses REPORT_AT attempts in a window
 *      is reported once, with a stack taken while the caller is still on
 *      it — the file and line, not "something on /people writes history a
 *      lot". It reports attempts, not what the guard let through, so a
 *      loop the guard is absorbing is still named.
 */

/** Real calls (push + replace) allowed per window. Under Safari's 100 per
 *  10 s and its older 100 per 30 s alike (3 × 30 = 90). */
const BUDGET = 30;
const WINDOW_MS = 10_000;
/** Attempts per window that count as a burst worth a report. */
const REPORT_AT = 60;

type Method = 'pushState' | 'replaceState';
type Args = Parameters<History['pushState']>;

let installed = false;
let reported = false;

export function guardHistory(): void {
  if (installed || typeof window === 'undefined' || !window.history) return;
  installed = true;

  /** Timestamps of the calls that went through, newest last. */
  const spent: number[] = [];
  /** Every attempt, for the diagnostic. */
  const attempts: number[] = [];
  let pending: Args | null = null;
  let flushTimer: number | null = null;

  const prune = (list: number[], now: number) => {
    while (list.length > 0 && now - list[0]! > WINDOW_MS) list.shift();
  };

  const note = (method: Method, now: number) => {
    attempts.push(now);
    prune(attempts, now);
    if (attempts.length < REPORT_AT || reported) return;
    reported = true;
    // Thrown here, not constructed-and-passed, so the stack starts one
    // frame below the caller we are trying to name.
    const err = new Error(`history.${method} called ${attempts.length} times in ${WINDOW_MS / 1000}s`);
    captureException(err, {
      tags: { churn: method },
      extra: {
        // The path only. Query strings are stripped app-wide before send
        // (see sentry.ts beforeSend) because they carry associate ids.
        pathname: window.location.pathname,
        callsInWindow: attempts.length,
        windowMs: WINDOW_MS,
        deferred: pending !== null,
      },
    });
  };

  const originalPush = window.history.pushState.bind(window.history);
  const originalReplace = window.history.replaceState.bind(window.history);

  const flush = () => {
    flushTimer = null;
    if (!pending) return;
    const now = Date.now();
    prune(spent, now);
    if (spent.length >= BUDGET) {
      schedule(now);
      return;
    }
    const args = pending;
    pending = null;
    spent.push(now);
    try {
      originalReplace(...args);
    } catch {
      // Safari refused anyway — keep the latest and try once the window turns.
      pending = args;
      schedule(now);
    }
  };

  const schedule = (now: number) => {
    if (flushTimer !== null) return;
    const oldest = spent[0] ?? now;
    const wait = Math.max(50, oldest + WINDOW_MS - now + 20);
    flushTimer = window.setTimeout(flush, wait);
  };

  window.history.pushState = function pushState(this: History, ...args: Args) {
    const now = Date.now();
    try {
      note('pushState', now);
      prune(spent, now);
      spent.push(now);
    } catch {
      /* a diagnostic must never be the reason navigation fails */
    }
    return originalPush(...args);
  };

  window.history.replaceState = function replaceState(this: History, ...args: Args) {
    const now = Date.now();
    try {
      note('replaceState', now);
    } catch {
      /* never the reason navigation fails */
    }
    prune(spent, now);
    if (spent.length >= BUDGET || pending !== null) {
      // Over budget: keep the newest, drop the rest, write when there is room.
      pending = args;
      schedule(now);
      return;
    }
    spent.push(now);
    return originalReplace(...args);
  };
}

/** Tests: forget the one-per-page-load report. */
export function __resetHistoryGuardForTests(): void {
  reported = false;
  installed = false;
}
