/**
 * The three behaviour events (ux-upgrade §6), reported home like the web
 * vitals: a session's start, each decision a person takes, the first decision
 * with how long the session took to reach it, and a palette search that ended
 * on a settings page ("I could not find it"). A session is the browser tab's
 * sessionStorage life: sign-in to close. Nothing per person leaves the browser;
 * the server rolls the events up by role.
 */

export type ProductEventKind = 'session_start' | 'decision' | 'first_decision' | 'settings_search';

const ENDPOINT = '/api/telemetry/product-events';
const STARTED_KEY = 'alto.productSession.startedAt';
const FIRST_KEY = 'alto.productSession.firstDecisionAt';

let queue: Array<{ kind: ProductEventKind; value?: number }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function send(): void {
  flushTimer = null;
  if (queue.length === 0) return;
  const body = JSON.stringify({ events: queue.splice(0, queue.length) });
  try {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
  } catch {
    // fall through to fetch
  }
  void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'include', keepalive: true }).catch(() => undefined);
}

function enqueue(kind: ProductEventKind, value?: number): void {
  queue.push(value === undefined ? { kind } : { kind, value });
  if (queue.length >= 20) send();
  else if (!flushTimer) flushTimer = setTimeout(send, 2_000);
}

/** Once per browser session, when a signed-in shell mounts. Idempotent. */
export function startProductSession(now: number = Date.now()): void {
  const s = store();
  if (!s) return;
  if (s.getItem(STARTED_KEY)) return;
  s.setItem(STARTED_KEY, String(now));
  s.removeItem(FIRST_KEY);
  enqueue('session_start');
}

/** A decision taken: approve, decline, assign, acknowledge. The first one in a session also reports how long it took. */
export function noteDecision(now: number = Date.now()): void {
  enqueue('decision');
  const s = store();
  if (!s) return;
  const started = Number(s.getItem(STARTED_KEY));
  if (!started || s.getItem(FIRST_KEY)) return;
  s.setItem(FIRST_KEY, String(now));
  enqueue('first_decision', Math.max(0, now - started));
}

const SETTINGS_PATH = /^\/(admin|settings)(\/|\?|#|$)/;

/** True for the pages a search "ending on a settings page" means: the Settings & trust area and the account settings. */
export function isSettingsPath(path: string): boolean {
  return SETTINGS_PATH.test(path);
}

/** A palette search (two or more characters) whose chosen result opened a settings page. */
export function noteSearchLanded(query: string, path: string): void {
  if (query.trim().length < 2) return;
  if (!isSettingsPath(path)) return;
  enqueue('settings_search');
}

/** Test-only. */
export function resetProductEventsForTests(): void {
  queue = [];
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  store()?.removeItem(STARTED_KEY);
  store()?.removeItem(FIRST_KEY);
}

export function flushProductEventsForTests(): void {
  send();
}
