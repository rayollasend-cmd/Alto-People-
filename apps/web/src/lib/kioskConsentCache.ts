/**
 * Last-known face-consent per PIN, cached on the kiosk.
 *
 * Exists for one path: the preflight fails (server unreachable) and the
 * kiosk must decide whether to open the camera without being able to ask
 * the server for the associate's consent state. The old behaviour was
 * "assume yes" — everyone got the camera, and a never-asked associate's
 * photo was captured and queued without the consent screen ever having
 * been shown. Capture is the consent-relevant event, not just storage, so
 * the offline default has to be NO camera unless we positively know this
 * PIN's owner said yes — which this cache remembers from the last online
 * punch.
 *
 * Keyed by SHA-256 of the PIN, not the PIN itself, so the kiosk's
 * localStorage never holds raw PINs. (A 4-digit space is trivially
 * reversible offline, but the value it would reveal is only a consent
 * flag — the PIN list itself stays server-side.) Values are only ever
 * 'GRANTED' | 'DECLINED'; unknown PINs are simply absent.
 */

const STORAGE_KEY = 'alto.kiosk.consent.v1';
// A kiosk serves one site's roster; if the map somehow grows past this,
// something is wrong — reset rather than let localStorage bloat.
const MAX_ENTRIES = 500;

type ConsentValue = 'GRANTED' | 'DECLINED';

async function hashPin(pin: string): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(pin),
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    // No secure context / ancient WebView — behave as "unknown", which
    // callers treat as no-camera. Fail closed, not open.
    return null;
  }
}

function readMap(): Record<string, ConsentValue> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, ConsentValue>)
      : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, ConsentValue>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode — cache just doesn't persist */
  }
}

/** Record what the server said about this PIN's consent. Null clears —
 *  a RESET by an admin means the kiosk must re-ask, so a stale GRANTED
 *  here must not keep opening the camera. */
export async function rememberConsent(
  pin: string,
  consent: ConsentValue | null,
): Promise<void> {
  const key = await hashPin(pin);
  if (!key) return;
  const map = readMap();
  if (consent === null) {
    if (!(key in map)) return;
    delete map[key];
  } else {
    map[key] = consent;
  }
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    writeMap({ [key]: map[key] } as Record<string, ConsentValue>);
    return;
  }
  writeMap(map);
}

/** Last-known consent for this PIN, or null when we've never seen it
 *  answered — which callers must treat as "do not open the camera". */
export async function cachedConsent(pin: string): Promise<ConsentValue | null> {
  const key = await hashPin(pin);
  if (!key) return null;
  const map = readMap();
  return map[key] ?? null;
}
