import { ApiError, NetworkError, TimeoutError, apiFetch } from './api';
import { onApiConnectivity } from './sessionEvents';

/**
 * Access pack — offline writes beyond the kiosk punch.
 *
 *   Reads already work offline (the persisted query cache) and the kiosk
 *   queues its punches. Two more things a floor lead does with no signal
 *   — ticking an SOP checklist, deciding an approval — now queue the same
 *   way: the request is stored here, the screen says "saved offline", and
 *   the queue replays in order the moment the API answers again.
 *
 *   Conflicts are the server's call: a replayed decision on a request
 *   someone else already decided, or a tick on a shift that was since
 *   submitted, comes back 409 (or any 4xx) and is DROPPED with a message
 *   naming it, never retried — a stale decision must not win because it
 *   arrived late. A network failure during replay keeps the item for next
 *   time.
 *
 *   localStorage, like the kiosk queue: small payloads, synchronous, and
 *   survives a reload.
 */

const KEY = 'alto.offline.writes.v1';
const MAX = 200;

export interface QueuedWrite {
  id: string;
  /** What the person did, for the banner and the conflict message. */
  label: string;
  /** A kind the UI can group on ("sop-task", "time-off"). */
  kind: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
  queuedAt: string;
  attempts: number;
}

export interface QueuedResult {
  queued: true;
  id: string;
}

type Listener = (queue: QueuedWrite[]) => void;
const listeners = new Set<Listener>();

function read(): QueuedWrite[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
  } catch {
    return [];
  }
}

function write(q: QueuedWrite[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(q.slice(-MAX)));
  } catch {
    /* storage is a convenience */
  }
  for (const l of listeners) l(q);
}

export function listQueuedWrites(): QueuedWrite[] {
  return read();
}

export function onQueueChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** True for the failures that mean "no signal", not "the server said no". */
export function isConnectivityFailure(err: unknown): boolean {
  if (err instanceof NetworkError || err instanceof TimeoutError) return true;
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function enqueueWrite(w: Omit<QueuedWrite, 'id' | 'queuedAt' | 'attempts'>): QueuedResult {
  const item: QueuedWrite = { ...w, id: newId(), queuedAt: new Date().toISOString(), attempts: 0 };
  write([...read(), item]);
  return { queued: true, id: item.id };
}

/**
 * Run `send`; when it fails for want of a network, queue the request
 * instead and answer `{ queued: true }`. Everything else (a 409, a 400)
 * throws as before — the person is online and the server has spoken.
 */
export async function withOfflineQueue<T>(
  send: () => Promise<T>,
  request: Omit<QueuedWrite, 'id' | 'queuedAt' | 'attempts'>,
): Promise<T | QueuedResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return enqueueWrite(request);
  try {
    return await send();
  } catch (err) {
    if (isConnectivityFailure(err)) return enqueueWrite(request);
    throw err;
  }
}

export function isQueued(r: unknown): r is QueuedResult {
  return !!r && typeof r === 'object' && (r as QueuedResult).queued === true;
}

export interface ReplayOutcome {
  sent: number;
  dropped: Array<{ item: QueuedWrite; message: string }>;
  remaining: number;
}

let replaying: Promise<ReplayOutcome> | null = null;

/** Send what is queued, in order. Stops at the first network failure. */
export function replayQueuedWrites(): Promise<ReplayOutcome> {
  if (replaying) return replaying;
  replaying = (async () => {
    const out: ReplayOutcome = { sent: 0, dropped: [], remaining: 0 };
    let queue = read();
    while (queue.length > 0) {
      const item = queue[0]!;
      try {
        await apiFetch(item.path, { method: item.method, body: item.body as Record<string, unknown> });
        out.sent += 1;
        queue = queue.slice(1);
        write(queue);
      } catch (err) {
        if (isConnectivityFailure(err)) {
          write(queue.map((q, i) => (i === 0 ? { ...q, attempts: q.attempts + 1 } : q)));
          break;
        }
        // The server answered: a conflict or a refusal. Drop it, say so.
        const message = err instanceof ApiError ? err.message : 'The server refused it.';
        out.dropped.push({ item, message });
        queue = queue.slice(1);
        write(queue);
      }
    }
    out.remaining = queue.length;
    return out;
  })().finally(() => {
    replaying = null;
  });
  return replaying;
}

let armed = false;

/** Replay whenever the network comes back (once per app). */
export function armOfflineQueueReplay(onOutcome: (o: ReplayOutcome) => void): () => void {
  if (armed) return () => undefined;
  armed = true;
  const run = () => {
    if (read().length === 0) return;
    void replayQueuedWrites().then(onOutcome);
  };
  const onOnline = () => run();
  window.addEventListener('online', onOnline);
  const off = onApiConnectivity((state) => {
    if (state === 'online') run();
  });
  run();
  return () => {
    armed = false;
    window.removeEventListener('online', onOnline);
    off();
  };
}
