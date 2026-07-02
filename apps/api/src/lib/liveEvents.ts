import type { Response } from 'express';

/**
 * In-process SSE registry: userId → open event-stream responses.
 *
 * Purpose: the web app polls the bell every 30s and the approvals badge
 * every 60s; this pushes a "something changed for you" nudge the moment
 * an in-app notification lands, so those surfaces refetch instantly.
 * Events carry NO payload data — just a type — so there's nothing
 * sensitive in the stream and the client's normal (authorized) fetch
 * paths stay the single source of truth.
 *
 * In-memory by design: the deployment is a single Railway replica (see
 * MULTI_REPLICA in config/env.ts). Under multiple replicas a user's
 * stream may live on a different instance than the one emitting — the
 * client's polling fallback still catches up within a minute, so this
 * degrades gracefully rather than breaking.
 */

const MAX_STREAMS_PER_USER = 3;
const PING_INTERVAL_MS = 25_000;

const streams = new Map<string, Set<Response>>();

export type LiveEventType = 'notification';

export function registerLiveStream(userId: string, res: Response): void {
  let set = streams.get(userId);
  if (!set) {
    set = new Set();
    streams.set(userId, set);
  }
  // Cap per-user streams (multiple tabs): evict the oldest so a tab
  // leak can't accumulate sockets.
  if (set.size >= MAX_STREAMS_PER_USER) {
    const oldest = set.values().next().value as Response | undefined;
    if (oldest) {
      set.delete(oldest);
      try {
        oldest.end();
      } catch {
        /* already gone */
      }
    }
  }
  set.add(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, PING_INTERVAL_MS);
  ping.unref?.();

  const cleanup = () => {
    clearInterval(ping);
    const s = streams.get(userId);
    if (s) {
      s.delete(res);
      if (s.size === 0) streams.delete(userId);
    }
  };
  res.on('close', cleanup);
}

/** Fire-and-forget nudge to every open stream of one user. */
export function emitLiveEvent(userId: string, type: LiveEventType): void {
  const set = streams.get(userId);
  if (!set || set.size === 0) return;
  const frame = `event: ${type}\ndata: {}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}

/** Test/ops introspection. */
export function liveStreamCount(): number {
  let n = 0;
  for (const s of streams.values()) n += s.size;
  return n;
}
