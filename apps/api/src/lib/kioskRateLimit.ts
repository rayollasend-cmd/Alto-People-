import { HttpError } from '../middleware/error.js';

/**
 * Per-device throttle for /kiosk/punch and /kiosk/verify-pin.
 *
 * Keyed on KioskDevice.id: at most 1 punch per second per device.
 * Two associates simultaneously tapping their PIN at the same kiosk
 * is fine — the second one's submit retries on the next tick.
 *
 * There is intentionally **no** brute-force PIN lockout. An earlier
 * version locked the entire kiosk for 5 minutes after 3 wrong PINs in
 * a row, which routinely broke clock-in for a whole site whenever
 * three associates in a row fat-fingered. The 1-second throttle plus
 * the 4-digit + per-client uniqueness already pushes worst-case
 * blind enumeration of the PIN space beyond 90 days; that's enough
 * latency to keep a real attack mostly theatre, without the
 * everyday-operations failure mode of locking out a busy kiosk.
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

export interface DeviceRateLimitState {
  lastPunchAt: number;
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
  bucket: 'punch' | 'preflight' = 'punch',
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

/** Test/admin helper — wipe everything. Not exposed via HTTP. */
export function _resetKioskRateLimit(): void {
  store.clear();
}
