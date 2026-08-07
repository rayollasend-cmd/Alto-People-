import { HttpError } from '../middleware/error.js';

/**
 * Per-device throttle for /kiosk/punch and /kiosk/verify-pin.
 *
 * Keyed on KioskDevice.id: at most 1 punch per second per device.
 * Two associates simultaneously tapping their PIN at the same kiosk
 * is fine — the second one's submit retries on the next tick.
 *
 * There is intentionally **no** hard brute-force lockout. An earlier
 * version locked the entire kiosk for 5 minutes after 3 wrong PINs in
 * a row, which routinely broke clock-in for a whole site whenever
 * three associates in a row fat-fingered.
 *
 * The 1-second throttle alone was NOT enough, though: the earlier note
 * here claimed ">90 days" to enumerate on the grounds that PINs are
 * unique per client. They are not — `KioskPin.pinHmac` is globally
 * unique, so the whole keyspace is 10,000 values, and 1/sec sweeps it
 * in under three hours (faster still across buckets and devices).
 *
 * So failures now carry an ESCALATING backoff (see enforcePinBackoff):
 * consecutive wrong PINs on a device double the required wait. A
 * correct PIN walks the streak back ONE step (not to zero — a full
 * reset let an insider interleave their own PIN between guesses,
 * fail-fail-success, and sweep the keyspace with the backoff pinned at
 * zero). A real associate mistyping once or twice barely notices, and
 * a streak older than PIN_STREAK_TTL_MS ages out entirely, so a busy
 * kiosk with legitimate traffic never locks up — the failure mode that
 * killed the old hard-lockout design.
 *
 * **Multi-replica caveat:** the default store keeps state per-process.
 * On Railway / Render / Fly with a single replica that's exactly what
 * we want — survives requests, resets on redeploy. If you scale to
 * multiple replicas behind a load balancer, the throttle becomes
 * fuzzy (an attacker can get N punches/sec where N = replica count).
 * Either pin the deployment to one replica (status quo) or install a
 * shared backend via setKioskRateLimitStore() at boot before any
 * request hits the router (e.g., a Redis-backed adapter).
 */

const THROTTLE_MS = 1000;

// Escalating wait after consecutive PIN failures: 0s, 1s, 2s, 4s, 8s …
// capped. The cap keeps a wrong-PIN storm from bricking a kiosk for an
// entire shift while still making enumeration hopeless.
const PIN_BACKOFF_BASE_MS = 1000;
const PIN_BACKOFF_MAX_MS = 60_000;
// Consecutive failures before any delay applies — covers the honest
// fat-finger without giving an attacker meaningful free attempts.
const PIN_BACKOFF_FREE_ATTEMPTS = 2;
// A streak this stale is forgiven wholesale — yesterday's typos must not
// slow down today's clock-ins.
const PIN_STREAK_TTL_MS = 30 * 60_000;

export interface DeviceRateLimitState {
  lastPunchAt: number;
  /** Consecutive failed PIN attempts; reset on any success. */
  pinFailures?: number;
  /** When the most recent failure was recorded. */
  lastFailureAt?: number;
}

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
      s = { lastPunchAt: 0 };
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
 * Throws 429 if the device acted within the last THROTTLE_MS, then stamps
 * the timestamp. Call after device-token verification so an attacker can't
 * burn cycles with garbage tokens.
 *
 * `bucket` namespaces the throttle. A clock-in fires TWO requests a beat
 * apart — the preflight (verify-pin) and the punch itself — so they must
 * NOT share a bucket: a shared one means the preflight's stamp can trip a
 * spurious 429 on the punch that follows ~1s later (worse now that the
 * selfie countdown is 1s). Separate buckets keep each independently
 * throttled against its own rapid-fire without cross-interference.
 */
export function enforcePunchRateLimit(
  deviceId: string,
  bucket: 'punch' | 'preflight' | 'face' = 'punch',
): void {
  const now = Date.now();
  const key = `${bucket}:${deviceId}`;
  const s = store.read(key);

  if (s.lastPunchAt && now - s.lastPunchAt < THROTTLE_MS) {
    throw new HttpError(
      429,
      'too_fast',
      'Slow down — one punch per second per kiosk.',
    );
  }
  s.lastPunchAt = now;
  store.write(key, s);
}

const FAIL_KEY = (deviceId: string) => `pinfail:${deviceId}`;

function backoffMsFor(failures: number): number {
  const over = failures - PIN_BACKOFF_FREE_ATTEMPTS;
  if (over <= 0) return 0;
  return Math.min(PIN_BACKOFF_MAX_MS, PIN_BACKOFF_BASE_MS * 2 ** (over - 1));
}

/**
 * Throws 429 while a device is still serving its post-failure backoff.
 * Call BEFORE looking up the submitted PIN, on every endpoint that takes
 * one. Pairs with recordPinFailure / clearPinFailures below.
 */
export function enforcePinBackoff(deviceId: string): void {
  const s = store.read(FAIL_KEY(deviceId));
  const wait = backoffMsFor(s.pinFailures ?? 0);
  if (!wait || !s.lastFailureAt) return;
  const remaining = s.lastFailureAt + wait - Date.now();
  if (remaining > 0) {
    throw new HttpError(
      429,
      'too_many_pin_attempts',
      `Too many incorrect PINs. Try again in ${Math.ceil(remaining / 1000)}s.`,
    );
  }
}

/** Record a wrong PIN — escalates this device's backoff. A stale streak
 *  (no failure within PIN_STREAK_TTL_MS) restarts from 1. */
export function recordPinFailure(deviceId: string): void {
  const key = FAIL_KEY(deviceId);
  const s = store.read(key);
  const now = Date.now();
  const stale = s.lastFailureAt !== undefined && now - s.lastFailureAt > PIN_STREAK_TTL_MS;
  s.pinFailures = stale ? 1 : (s.pinFailures ?? 0) + 1;
  s.lastFailureAt = now;
  store.write(key, s);
}

/**
 * A correct PIN walks the streak back one step instead of clearing it.
 * Clearing let anyone who knows ONE valid PIN (their own) interleave it
 * between guesses and keep the backoff at zero forever; decrementing
 * makes each guess cost net progress while honest typos (below the free
 * attempts, walked off by the successes that follow) still never wait.
 */
export function clearPinFailures(deviceId: string): void {
  const key = FAIL_KEY(deviceId);
  const s = store.read(key);
  const n = s.pinFailures ?? 0;
  if (n === 0) return;
  s.pinFailures = n - 1;
  if (s.pinFailures === 0) s.lastFailureAt = undefined;
  store.write(key, s);
}

/** Test/admin helper — wipe everything. Not exposed via HTTP. */
export function _resetKioskRateLimit(): void {
  store.clear();
}
