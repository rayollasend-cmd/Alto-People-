/**
 * Phase 102 — Offline punch queue.
 *
 * When the kiosk loses connectivity, punches go into localStorage and
 * replay when the server reachable again. Each entry has a UUID
 * idempotencyKey so a server-side dedup short-circuits double-clocks
 * if the original request actually went through but the response was
 * lost.
 *
 * Why localStorage and not IndexedDB: simpler, synchronous, and the
 * payload is small (selfies are base64 JPEGs ~50-200KB each, capped at
 * 1MB; descriptors are 128 floats ~2KB). At ~100 queued punches we'd
 * still be inside a 5MB localStorage budget, which is way more offline
 * runway than any reasonable kiosk needs.
 */
import { kioskPunch } from './kiosk99Api';

const STORAGE_KEY = 'alto.kiosk.queue.v1';
const MAX_QUEUE = 100;

export interface QueuedPunch {
  idempotencyKey: string;
  deviceToken: string;
  pin: string;
  selfie: string | null;
  faceDescriptor: number[] | null;
  latitude: number | null;
  longitude: number | null;
  /** ISO string — when the user actually pressed the button. */
  capturedAt: string;
  /** Phase 105 — null = clock toggle, 'BREAK' = break toggle. */
  intent: 'BREAK' | null;
  attempts: number;
  lastError: string | null;
}

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for ancient browsers. Sufficient uniqueness for our use.
  const r = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const v = c === 'x' ? Math.floor(Math.random() * 16) : (Math.floor(Math.random() * 4) + 8);
    return v.toString(16);
  }).replace(/x/g, r);
}

function readQueue(): QueuedPunch[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedPunch[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedPunch[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(q));
  } catch {
    // Quota exceeded. Drop the oldest half so we keep accepting punches.
    const half = q.slice(Math.floor(q.length / 2));
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(half));
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }
}

export function queueSize(): number {
  return readQueue().length;
}

export function listQueue(): QueuedPunch[] {
  return readQueue();
}

export function newIdempotencyKey(): string {
  return uuidv4();
}

export function enqueuePunch(p: Omit<QueuedPunch, 'attempts' | 'lastError'>): void {
  const q = readQueue();
  if (q.length >= MAX_QUEUE) {
    // Older end is closer to expiry on the server (7-day backdate cap).
    // Drop the oldest to keep room for the newest.
    q.shift();
  }
  q.push({ ...p, attempts: 0, lastError: null });
  writeQueue(q);
}

export function clearQueue(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Try to send all queued punches. Stops on the first network failure —
 * no point hammering an offline server. Returns the count successfully
 * synced. Permanent failures (4xx) drop the entry; transient failures
 * (network / 5xx) leave it in place with attempts++.
 */
export async function drainQueue(): Promise<{
  synced: number;
  remaining: number;
  errors: number;
}> {
  const q = readQueue();
  if (q.length === 0) return { synced: 0, remaining: 0, errors: 0 };

  let synced = 0;
  let errors = 0;
  const remaining: QueuedPunch[] = [];
  let networkDown = false;

  for (const item of q) {
    if (networkDown) {
      remaining.push(item);
      continue;
    }
    try {
      await kioskPunch({
        deviceToken: item.deviceToken,
        pin: item.pin,
        selfie: item.selfie,
        latitude: item.latitude,
        longitude: item.longitude,
        faceDescriptor: item.faceDescriptor,
        idempotencyKey: item.idempotencyKey,
        clientPunchedAt: item.capturedAt,
        intent: item.intent,
      });
      synced++;
    } catch (err: unknown) {
      const status = (err as { status?: number } | undefined)?.status;
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        // Permanent client error (bad PIN, geofence, etc.) — drop the
        // entry, it'll never succeed. The audit log already recorded
        // the rejection on the server side via idempotencyKey.
        errors++;
      } else {
        // Network / 5xx / timeout — keep, mark for retry.
        item.attempts += 1;
        item.lastError = err instanceof Error ? err.message : 'unknown';
        remaining.push(item);
        networkDown = true;
      }
    }
  }

  writeQueue(remaining);
  return { synced, remaining: remaining.length, errors };
}
