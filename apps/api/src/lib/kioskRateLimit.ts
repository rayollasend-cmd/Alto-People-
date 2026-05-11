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
 * State is in-memory only — survives within a single process but resets
 * on restart. Single-replica deployments (typical for this app) are
 * unaffected; multi-replica setups should swap in a Redis backend.
 */

const THROTTLE_MS = 1000;
const MAX_FAILED_PIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;

interface DeviceState {
  lastPunchAt: number;
  failedPinAttempts: number;
  lockedUntil: number | null;
}

const state = new Map<string, DeviceState>();

function get(deviceId: string): DeviceState {
  let s = state.get(deviceId);
  if (!s) {
    s = { lastPunchAt: 0, failedPinAttempts: 0, lockedUntil: null };
    state.set(deviceId, s);
  }
  return s;
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
  const s = get(deviceId);

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
}

/**
 * Increment the failed-PIN counter. At MAX_FAILED_PIN_ATTEMPTS, set a
 * LOCKOUT_DURATION_MS lockout window starting now. Idempotent: calling
 * past the threshold just keeps the device locked.
 */
export function recordFailedPinAttempt(deviceId: string): void {
  const s = get(deviceId);
  s.failedPinAttempts += 1;
  if (s.failedPinAttempts >= MAX_FAILED_PIN_ATTEMPTS) {
    s.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
}

/**
 * Clear the failed-PIN counter and any active lockout. Called after a
 * PIN matches a real KioskPin row (i.e. the previous "wrong PIN"
 * attempts on this device were probably just typos, not an attack).
 */
export function recordSuccessfulPinAttempt(deviceId: string): void {
  const s = get(deviceId);
  s.failedPinAttempts = 0;
  s.lockedUntil = null;
}

/** Test/admin helper — wipe everything. Not exposed via HTTP. */
export function _resetKioskRateLimit(): void {
  state.clear();
}
