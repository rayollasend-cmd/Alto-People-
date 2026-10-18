/**
 * Are we inside the native app (apps/mobile, Capacitor)?
 *
 * The native shell loads this same web app from its real origin, and
 * Capacitor injects `window.Capacitor` before any script runs. Reading the
 * global — not importing @capacitor/core — keeps the web bundle free of any
 * native code: every plugin is a dynamic import behind isNative().
 *
 * The device id (this phone's NativeDevice row) rides every API call as
 * `x-alto-device`, so the server can mark "this phone" in the device list
 * and end its push and Keychain credential on sign-out.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function cap(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isNative(): boolean {
  try {
    return cap()?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

export type NativePlatform = 'ios' | 'android';

export function nativePlatform(): NativePlatform | null {
  if (!isNative()) return null;
  const p = cap()?.getPlatform?.();
  return p === 'ios' || p === 'android' ? p : null;
}

let deviceId: string | null = null;

export function setNativeDeviceId(id: string | null): void {
  deviceId = id;
}

export function nativeDeviceId(): string | null {
  return deviceId;
}

/** Extra headers apiFetch adds inside the app. Empty on the web. */
export function nativeHeaders(): Record<string, string> {
  return deviceId && isNative() ? { 'x-alto-device': deviceId } : {};
}
