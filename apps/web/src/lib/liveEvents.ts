/**
 * Client side of the live-nudge channel (see api lib/liveEvents.ts).
 *
 * One EventSource per authed session against /api/events/stream; every
 * received event re-dispatches as a window CustomEvent('alto:live')
 * so any surface (bell, approvals badge) can subscribe without holding
 * a reference to the source. Polling everywhere stays in place as the
 * fallback — this only makes the happy path instant.
 *
 * EventSource auto-reconnects on drop; we add exponential backoff for
 * the "server restarting" case where reconnects would otherwise hammer.
 */

export interface LiveEventDetail {
  type: string;
}

let source: EventSource | null = null;
let retryMs = 2_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function dispatch(type: string): void {
  window.dispatchEvent(
    new CustomEvent<LiveEventDetail>('alto:live', { detail: { type } }),
  );
}

function connect(): void {
  if (source) return;
  const es = new EventSource('/api/events/stream');
  source = es;

  es.onopen = () => {
    retryMs = 2_000;
  };
  es.addEventListener('notification', () => dispatch('notification'));
  es.onerror = () => {
    // EventSource retries by itself for transient blips; for hard
    // failures (auth expired, server down) it closes — reschedule with
    // backoff so we don't hammer a restarting server.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      if (source === es) source = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    }
  };
}

/** Start (idempotent). Call from the authed shell. */
export function startLiveEvents(): void {
  if (typeof EventSource === 'undefined') return; // ancient browser / SSR
  connect();
}

/** Stop and drop the connection (sign-out / shell unmount). */
export function stopLiveEvents(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  source?.close();
  source = null;
}

/** Subscribe to live nudges; returns the unsubscribe function. */
export function onLiveEvent(
  type: string,
  handler: () => void,
): () => void {
  const listener = (e: Event) => {
    if ((e as CustomEvent<LiveEventDetail>).detail?.type === type) handler();
  };
  window.addEventListener('alto:live', listener);
  return () => window.removeEventListener('alto:live', listener);
}
