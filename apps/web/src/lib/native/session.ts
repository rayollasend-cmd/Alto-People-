import { apiFetch } from '@/lib/api';
import { isNative, nativePlatform, setNativeDeviceId } from './platform';

/**
 * This phone's identity and its Keychain / Keystore credential.
 *
 *   deviceId      the NativeDevice row — kept so re-registering updates the
 *                 same row (and sent as x-alto-device on every request).
 *   credential    a refresh credential (server stores only its hash) that
 *                 re-opens a session the web view lost — the phone purged
 *                 its cookies, or the app was away longer than the cookie.
 *                 Device-only: never synced to iCloud Keychain.
 *   biometricLock whether the person asked for Face ID / fingerprint to
 *                 open the app.
 */

const KEY_DEVICE = 'alto.deviceId';
const KEY_CREDENTIAL = 'alto.deviceCredential';
const KEY_BIOMETRIC = 'alto.biometricLock';

async function storage() {
  const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
  // Device-only: a credential must not follow an iCloud Keychain backup to another phone.
  await SecureStorage.setSynchronize(false);
  return SecureStorage;
}

export async function readStoredDeviceId(): Promise<string | null> {
  if (!isNative()) return null;
  try {
    const s = await storage();
    const id = await s.getItem(KEY_DEVICE);
    setNativeDeviceId(id);
    return id;
  } catch {
    return null;
  }
}

export async function readCredential(): Promise<string | null> {
  if (!isNative()) return null;
  try {
    return await (await storage()).getItem(KEY_CREDENTIAL);
  } catch {
    return null;
  }
}

async function writeCredential(value: string | null): Promise<void> {
  const s = await storage();
  if (value) await s.setItem(KEY_CREDENTIAL, value);
  else await s.removeItem(KEY_CREDENTIAL);
}

export async function biometricLockEnabled(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return (await (await storage()).getItem(KEY_BIOMETRIC)) === '1';
  } catch {
    return false;
  }
}

export async function setBiometricLock(on: boolean): Promise<void> {
  const s = await storage();
  if (on) await s.setItem(KEY_BIOMETRIC, '1');
  else await s.removeItem(KEY_BIOMETRIC);
  const id = await readStoredDeviceId();
  if (id) await apiFetch(`/devices/${id}`, { method: 'PATCH', body: { biometricLock: on } }).catch(() => {});
}

interface DeviceInfo {
  deviceName: string | null;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
}

async function deviceInfo(): Promise<DeviceInfo> {
  let appVersion: string | null = null;
  try {
    const { App } = await import('@capacitor/app');
    appVersion = (await App.getInfo()).version;
  } catch {
    /* web or older shell */
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const model = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (ua.match(/Android [\d.]+; ([^;)]+)/)?.[1] ?? 'Android phone') : null;
  const os = ua.match(/OS (\d+[_\d]*)/)?.[1]?.replace(/_/g, '.') ?? ua.match(/Android ([\d.]+)/)?.[1] ?? null;
  return { deviceName: null, deviceModel: model, osVersion: os, appVersion };
}

/**
 * Register (or refresh) this phone for the signed-in person, and keep a
 * fresh credential in the Keychain. Safe to call on every sign-in.
 */
export async function registerThisDevice(pushToken?: string | null): Promise<string | null> {
  const platform = nativePlatform();
  if (!platform) return null;
  const existing = await readStoredDeviceId();
  const info = await deviceInfo();
  const res = await apiFetch<{ deviceId: string; credential: string | null }>('/devices', {
    method: 'POST',
    body: {
      ...(existing ? { deviceId: existing } : {}),
      platform: platform === 'ios' ? 'IOS' : 'ANDROID',
      ...(pushToken !== undefined ? { pushToken } : {}),
      ...info,
      credential: true,
    },
  });
  const s = await storage();
  await s.setItem(KEY_DEVICE, res.deviceId);
  setNativeDeviceId(res.deviceId);
  if (res.credential) await writeCredential(res.credential);
  return res.deviceId;
}

/**
 * The web view has no session: try the Keychain credential. True when a
 * session was re-opened (the caller refreshes the signed-in user).
 */
export async function recoverSession(): Promise<boolean> {
  const credential = await readCredential();
  if (!credential) return false;
  try {
    const res = await apiFetch<{ credential: string }>('/auth/device-session', { method: 'POST', body: { credential } });
    await writeCredential(res.credential);
    return true;
  } catch {
    // Spent, expired or revoked: forget it so we don't keep trying.
    await writeCredential(null).catch(() => {});
    return false;
  }
}

/** On sign-out (the server already revoked the row via x-alto-device). */
export async function forgetThisDevice(): Promise<void> {
  if (!isNative()) return;
  try {
    const s = await storage();
    await s.removeItem(KEY_CREDENTIAL);
    await s.removeItem(KEY_BIOMETRIC);
    await s.removeItem(KEY_DEVICE);
  } catch {
    /* nothing stored */
  }
  setNativeDeviceId(null);
}
