import { HttpError } from '../middleware/error.js';

/**
 * In-memory rate limit + PIN lockout for /kiosk/punch.
 *
 * Two protections, both keyed on KioskDevice.id:
 *
 *  1. Throttle — at most 1 punch per second per device. Two associates
 *     simultaneously tapping their PIN at the same kiosk is fine because
 *     the 1s window is tiny; the second one retries.
 *
 *  2. PIN lockout — after MAX_FAILED_PIN_ATTEMPTS wrong PINs in a row,
 *     the device is locked out for LOCKOUT_DURATION_MS. This slows a
 *     brute-force attack on the 10k PIN space from "seconds" to ~12 days.
 *     A successful PIN clears the counter.
 *
 * **Multi-replica caveat:** the default store keeps state per-process.
 * On Railway / Render / Fly with a single replica that's exactly what
 * we want — survives requests, resets on redeploy. If you scale to
 * multiple replicas behind a load balancer, an attacker can defeat the
 * lockout by spraying attempts across replicas. Either pin the
 * deployment to one replica (status quo) or install a shared backend
 * via setKioskRateLimitStore() at boot before any request hits the
 * router (e.g., a Redis-backed adapter). The interface below is
 * intentionally narrow so swapping is a tiny lift.
 */

const THROTTLE_MS = 1000;
const MAX_FAILED_PIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;

export interface DeviceRateLimitState {
  lastPunchAt: number;
  failedPinAttempts: number;
  lockedUntil: number | null;
}

/**
 * Swappable backend. The in-memory default works for single-replica
 * deployments; a Redis adapter implementing the same three methods
 * gives multi-replica safety. All three calls are best-effort fast
 * (no IO in the hot path on the in-memory backend; <5ms expected
 * round-trip on Redis).
 */
export interface KioskRateLimitStore {
  read(deviceId: string): DeviceRateLimitState;
  write(deviceId: string, state: DeviceRateLimitState): void;
  clear(): void;
}

class InMemoryStore implements KioskRateLimitStore {
  private map = new Map<string, DeviceRateLimitState>();

  read(deviceId: string): DeviceRateLimitState {
    let s = this.map.get(deviceId);
    if (!s) {
      s = { lastPunchAt: 0, failedPinAttempts: 0, lockedUntil: null };
      this.map.set(deviceId, s);
    }
    return s;
  }

  write(deviceId: string, state: DeviceRateLimitState): void {
    this.map.set(deviceId, state);
  }

  clear(): void {
    this.map.clear();
  }
}

let store: KioskRateLimitStore = new InMemoryStore();

/**
 * Replace the active store. Call at boot, before any request hits the
 * router. Subsequent calls overwrite — the runtime supports one
 * backend at a time.
 */
export function setKioskRateLimitStore(next: KioskRateLimitStore): void {
  store = next;
}

/**
 * Throws 429 if the device is in a throttle or lockout window. Stamps
 * the device's lastPunchAt so the next call within THROTTLE_MS trips
 * the throttle. Call this AFTER device-token verification (so an
 * attacker can't burn cycles with garbage tokens) but BEFORE any DB
 * work — the rate limit is the cheap gate.
 */
export function enforcePunchRateLimit(deviceId: string): void {
  const now = Date.now();
  const s = store.read(deviceId);

  if (s.lockedUntil && s.lockedUntil > now) {
    const retryAfter = Math.ceil((s.lockedUntil - now) / 1000);
    throw new HttpError(
      429,
      'device_locked',
      `Too many failed PIN attempts. Try again in ${retryAfter}s.`,
      { retryAfter },
    );
  }
  if (s.lockedUntil && s.lockedUntil <= now) {
    // Lockout expired — clear the counter so the next 3 attempts get a
    // fresh budget.
    s.lockedUntil = null;
    s.failedPinAttempts = 0;
  }

  if (s.lastPunchAt && now - s.lastPunchAt < THROTTLE_MS) {
    throw new HttpError(
      429,
      'too_fast',
      'Slow down — one punch per second per kiosk.',
    );
  }
  s.lastPunchAt = now;
  store.write(deviceId, s);
}

/**
 * Increment the failed-PIN counter. At MAX_FAILED_PIN_ATTEMPTS, set a
 * LOCKOUT_DURATION_MS lockout window starting now. Idempotent: calling
 * past the threshold just keeps the device locked.
 */
export function recordFailedPinAttempt(deviceId: string): void {
  const s = store.read(deviceId);
  s.failedPinAttempts += 1;
  if (s.failedPinAttempts >= MAX_FAILED_PIN_ATTEMPTS) {
    s.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  store.write(deviceId, s);
}

/**
 * Clear the failed-PIN counter and any active lockout. Called after a
 * PIN matches a real KioskPin row (i.e. the previous "wrong PIN"
 * attempts on this device were probably just typos, not an attack).
 */
export function recordSuccessfulPinAttempt(deviceId: string): void {
  const s = store.read(deviceId);
  s.failedPinAttempts = 0;
  s.lockedUntil = null;
  store.write(deviceId, s);
}

/** Test/admin helper — wipe everything. Not exposed via HTTP. */
export function _resetKioskRateLimit(): void {
  store.clear();
}
