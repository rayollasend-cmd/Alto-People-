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

import { ApiError, apiFetch } from './api';

export interface LiveEventDetail {
  type: string;
}

let source: EventSource | null = null;
let retryMs = 2_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped by stopLiveEvents, so a session check still in flight can't reconnect a stopped channel.
let generation = 0;

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
  es.addEventListener('message', () => dispatch('message'));
  // A van moved (a rider's, the desk's, a store's) — its map refetches now.
  es.addEventListener('transport', () => dispatch('transport'));
  // Hugo's work moved (a task stepped, a note came or went) — the badge and the Tasks tab refetch.
  es.addEventListener('hugo', () => dispatch('hugo'));
  es.onerror = () => {
    // EventSource retries by itself for transient blips; for hard
    // failures (auth expired, server down) it closes.
    if (es.readyState !== EventSource.CLOSED) return;
    es.close();
    if (source === es) source = null;
    // It can't read the status it was refused with. A dead session (an idle
    // policy timing out a hidden tab that had stopped polling) was refused
    // with a 401 and retried every minute for days: Nov 2026, 3,259
    // refusals from three tabs, 61% of the stream's traffic. Ask once. A
    // 401 here ends the session the app's usual way (lib/auth → sign-in),
    // and the channel stays down; anything else is a server blip, retried
    // with backoff so we don't hammer a restarting server.
    const gen = generation;
    void apiFetch('/auth/me').then(
      () => retryLater(gen),
      (err: unknown) => {
        if (!(err instanceof ApiError && err.status === 401)) retryLater(gen);
      },
    );
  };
}

function retryLater(gen: number): void {
  if (gen !== generation) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 60_000);
}

/** Start (idempotent). Call from the authed shell. */
export function startLiveEvents(): void {
  if (typeof EventSource === 'undefined') return; // ancient browser / SSR
  connect();
}

/** Stop and drop the connection (sign-out / shell unmount). */
export function stopLiveEvents(): void {
  generation += 1;
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
