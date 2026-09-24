/**
 * Real-user web vitals, reported home.
 *
 * Four numbers per page view — LCP (when the biggest thing painted), INP
 * (how long a tap took to answer), CLS (how much the page jumped), TTFB
 * (how long the server took) — measured the way Chrome's own library
 * measures them, with PerformanceObserver, and hand-rolled here because
 * the whole thing is a hundred lines and every phone would otherwise
 * download a dependency to learn how slow it is.
 *
 * Attribution is per SPA route: LCP and TTFB belong to the hard
 * navigation that loaded the app; CLS and INP are measured per route and
 * finalised when the route changes or the tab hides, so "/scheduling
 * jumps around" and "/people is slow to tap" are separate facts. Routes
 * are sent as PATTERNS — ids collapsed to :id — and the server collapses
 * them again; the rollup never learns who looked at whom.
 *
 * Samples ride a beacon on visibilitychange/pagehide (the only reliable
 * moment on mobile), with a keepalive fetch as the fallback. Nothing here
 * can throw into the app: every observer is wrapped, and a browser
 * without the API simply reports nothing.
 */

export type WebVitalMetric = 'LCP' | 'INP' | 'CLS' | 'TTFB';

interface Sample {
  route: string;
  metric: WebVitalMetric;
  value: number;
}

const ENDPOINT = '/api/telemetry/web-vitals';
const BATCH = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d{4,}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{20,}$/;

/** "/clients/9f2e…/statements" → "/clients/:id/statements". */
export function routePattern(pathname: string): string {
  const segments = pathname.split(/[?#]/)[0]!.split('/').filter(Boolean);
  return `/${segments
    .map((s) => (UUID.test(s) || NUMERIC_ID.test(s) || OPAQUE_TOKEN.test(s) ? ':id' : s))
    .join('/')}`;
}

/**
 * INP is the worst interaction, except on busy pages where one outlier
 * per fifty interactions is forgiven — the 98th percentile Chrome uses.
 */
export function inpFromDurations(durations: readonly number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => b - a);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length / 50));
  return sorted[idx]!;
}

/**
 * CLS is the largest "session window" of shifts: shifts less than a
 * second apart, capped at five seconds, add up; the biggest window wins.
 */
export function clsSessionMax(shifts: readonly { value: number; startTime: number }[]): number {
  let max = 0;
  let session = 0;
  let sessionStart = 0;
  let last = 0;
  for (const s of shifts) {
    if (session > 0 && s.startTime - last < 1000 && s.startTime - sessionStart < 5000) {
      session += s.value;
    } else {
      session = s.value;
      sessionStart = s.startTime;
    }
    last = s.startTime;
    if (session > max) max = session;
  }
  return max;
}

let started = false;
let queue: Sample[] = [];
let currentRoute = '/';

// Per-route accumulators, reset on each soft navigation.
let shifts: { value: number; startTime: number }[] = [];
const interactions = new Map<number, number>();
let lcpValue: number | null = null;
let lcpFinal = false;

function send(): void {
  if (queue.length === 0) return;
  const body = JSON.stringify({ samples: queue.splice(0, queue.length) });
  try {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
  } catch {
    // fall through to fetch
  }
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    credentials: 'include',
    keepalive: true,
  }).catch(() => undefined);
}

function enqueue(metric: WebVitalMetric, value: number, route = currentRoute): void {
  if (!Number.isFinite(value) || value < 0) return;
  queue.push({ route, metric, value: Math.round(value * 1000) / 1000 });
  if (queue.length >= BATCH) send();
}

/** Close the books on the current route's CLS and INP. */
function finaliseRoute(): void {
  if (shifts.length > 0 || document.visibilityState === 'hidden') {
    enqueue('CLS', clsSessionMax(shifts));
  }
  const inp = inpFromDurations([...interactions.values()]);
  if (inp !== null) enqueue('INP', inp);
  shifts = [];
  interactions.clear();
}

function finaliseLcp(): void {
  if (lcpFinal || lcpValue === null) return;
  lcpFinal = true;
  enqueue('LCP', lcpValue);
}

function observe(type: string, cb: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}): void {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    const po = new PerformanceObserver((list) => cb(list.getEntries()));
    po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
  } catch {
    // An observer that can't be created reports nothing.
  }
}

/**
 * Start measuring. Called once the person is signed in (the beacon needs
 * the session cookie) and idempotent after that.
 */
export function startWebVitals(pathname: string = window.location.pathname): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;
  currentRoute = routePattern(pathname);

  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.responseStart > 0) enqueue('TTFB', nav.responseStart);
  } catch {
    // no navigation timing — nothing to report
  }

  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last && !lcpFinal) lcpValue = last.startTime;
  });
  observe('layout-shift', (entries) => {
    for (const e of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (!e.hadRecentInput) shifts.push({ value: e.value, startTime: e.startTime });
    }
  });
  const onInteraction = (entries: PerformanceEntry[]) => {
    for (const e of entries as (PerformanceEntry & { interactionId?: number })[]) {
      if (!e.interactionId) continue;
      const prev = interactions.get(e.interactionId) ?? 0;
      if (e.duration > prev) interactions.set(e.interactionId, e.duration);
    }
  };
  observe('event', onInteraction, { durationThreshold: 40 });
  observe('first-input', onInteraction);

  // LCP stops being reportable the moment the person interacts or leaves.
  for (const type of ['keydown', 'click', 'pointerdown']) {
    window.addEventListener(type, finaliseLcp, { once: true, capture: true, passive: true });
  }
  const onHide = () => {
    if (document.visibilityState !== 'hidden') return;
    finaliseLcp();
    finaliseRoute();
    send();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
}

/** A soft navigation: finalise the old route's CLS/INP, start the new one. */
export function noteRouteChange(pathname: string): void {
  if (!started) return;
  const next = routePattern(pathname);
  if (next === currentRoute) return;
  finaliseLcp();
  finaliseRoute();
  currentRoute = next;
  send();
}

/** Test-only. */
export function resetWebVitalsForTests(): void {
  started = false;
  queue = [];
  currentRoute = '/';
  shifts = [];
  interactions.clear();
  lcpValue = null;
  lcpFinal = false;
}
