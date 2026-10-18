import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The native bridge's own logic, with Capacitor and its plugins mocked:
 * detection, deep links, NFC records, the Keychain session, push
 * registration and haptics. On the web every function is a no-op.
 */

const store = new Map<string, string>();
const secure = {
  setSynchronize: vi.fn(async () => {}),
  getItem: vi.fn(async (k: string) => store.get(k) ?? null),
  setItem: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  removeItem: vi.fn(async (k: string) => void store.delete(k)),
};
vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: secure }));

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), ApiError: class extends Error {} }));

const pushListeners: Record<string, (e: unknown) => void> = {};
const push = {
  checkPermissions: vi.fn(async () => ({ receive: 'prompt' })),
  requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
  createChannel: vi.fn(async () => {}),
  register: vi.fn(async () => {
    setTimeout(() => pushListeners.registration?.({ value: 'apns-token-from-ios' }), 0);
  }),
  addListener: vi.fn(async (name: string, fn: (e: unknown) => void) => {
    pushListeners[name] = fn;
    return { remove: async () => void delete pushListeners[name] };
  }),
};
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: push }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: async () => ({ version: '1.2.3' }) } }));

const haptics = { impact: vi.fn(async () => {}), notification: vi.fn(async () => {}) };
vi.mock('@capacitor/haptics', () => ({
  Haptics: haptics,
  ImpactStyle: { Light: 'LIGHT' },
  NotificationType: { Success: 'SUCCESS', Error: 'ERROR' },
}));

function asNative(platform: 'ios' | 'android') {
  (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => platform };
}

beforeEach(() => {
  store.clear();
  apiFetch.mockReset();
  vi.clearAllMocks();
});
afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('platform', () => {
  it('is the web until Capacitor says otherwise; the device header follows the phone', async () => {
    const { isNative, nativePlatform, nativeHeaders, setNativeDeviceId } = await import('@/lib/native/platform');
    expect(isNative()).toBe(false);
    expect(nativePlatform()).toBeNull();
    setNativeDeviceId('dev-1');
    expect(nativeHeaders()).toEqual({});
    asNative('android');
    expect(isNative()).toBe(true);
    expect(nativePlatform()).toBe('android');
    expect(nativeHeaders()).toEqual({ 'x-alto-device': 'dev-1' });
    setNativeDeviceId(null);
  });
});

describe('deep links', () => {
  it('turns the handoff code into the exchange, and our links into app paths', async () => {
    const { deepLinkPath } = await import('@/lib/native/shell');
    expect(deepLinkPath('altopeople://auth/complete?code=abc%2B1')).toBe('/api/auth/native-exchange?code=abc%2B1');
    expect(deepLinkPath('altopeople://rides/123?x=1')).toBe('/rides/123?x=1');
    expect(deepLinkPath(`https://${window.location.host}/me/wallet#badge`)).toBe('/me/wallet#badge');
    expect(deepLinkPath('https://evil.example.com/me')).toBeNull();
    expect(deepLinkPath('altopeople://auth/complete')).toBeNull();
  });
});

describe('NFC records', () => {
  const text = (s: string) => {
    const lang = [...new TextEncoder().encode('en')];
    return { tnf: 1, type: [0x54], payload: [lang.length, ...lang, ...new TextEncoder().encode(s)] };
  };
  const uri = (s: string) => ({ tnf: 1, type: [0x55], payload: [0x04, ...new TextEncoder().encode(s)] });

  it('finds the badge in a text record or a link, and ignores other cards', async () => {
    const { badgeFromRecords } = await import('@/lib/native/nfc');
    expect(badgeFromRecords([text('altob1.payload.sig')])).toBe('altob1.payload.sig');
    expect(badgeFromRecords([uri('app.altohr.com/b?badge=altob1.p.s')])).toBe('altob1.p.s');
    expect(badgeFromRecords([text('hello')])).toBeNull();
    expect(badgeFromRecords(undefined)).toBeNull();
  });
});

describe('the Keychain session', () => {
  it('registers this phone, keeps the credential device-only, and re-opens a lost session once', async () => {
    asNative('ios');
    const session = await import('@/lib/native/session');
    apiFetch.mockResolvedValueOnce({ deviceId: 'dev-9', credential: 'altodev1.dev-9.first' });
    expect(await session.registerThisDevice()).toBe('dev-9');
    expect(secure.setSynchronize).toHaveBeenCalledWith(false);
    expect(apiFetch).toHaveBeenCalledWith('/devices', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ platform: 'IOS', credential: true, appVersion: '1.2.3' }) }));
    expect(store.get('alto.deviceCredential')).toBe('altodev1.dev-9.first');

    apiFetch.mockResolvedValueOnce({ credential: 'altodev1.dev-9.second' });
    expect(await session.recoverSession()).toBe(true);
    expect(store.get('alto.deviceCredential')).toBe('altodev1.dev-9.second');

    // Spent / revoked: forget it rather than keep trying.
    apiFetch.mockRejectedValueOnce(new Error('401'));
    expect(await session.recoverSession()).toBe(false);
    expect(store.has('alto.deviceCredential')).toBe(false);

    await session.forgetThisDevice();
    expect(store.size).toBe(0);
  });
});

describe('push', () => {
  it('asks, registers, and hands the token to the server', async () => {
    asNative('ios');
    const { enablePush } = await import('@/lib/native/push');
    apiFetch.mockResolvedValue({ deviceId: 'dev-1', credential: 'altodev1.dev-1.x' });
    expect(await enablePush()).toBe('granted');
    expect(push.requestPermissions).toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith('/devices', expect.objectContaining({ body: expect.objectContaining({ pushToken: 'apns-token-from-ios' }) }));
  });

  it('a "no" at the phone’s prompt is respected', async () => {
    asNative('android');
    push.requestPermissions.mockResolvedValueOnce({ receive: 'denied' });
    const { enablePush } = await import('@/lib/native/push');
    expect(await enablePush()).toBe('denied');
    expect(push.register).not.toHaveBeenCalled();
  });

  it('a tapped notification opens only an in-app path', async () => {
    asNative('ios');
    const { listenForPush } = await import('@/lib/native/push');
    const open = vi.fn();
    await listenForPush(open);
    pushListeners.pushNotificationActionPerformed?.({ notification: { data: { url: '/rides/7' } } });
    pushListeners.pushNotificationActionPerformed?.({ notification: { data: { url: 'https://evil.example.com' } } });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('/rides/7');
  });
});

describe('haptics', () => {
  it('uses the phone’s haptic engine in the app and vibration on the web', async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    const { hapticSuccess, hapticError } = await import('@/lib/haptics');
    hapticSuccess();
    expect(vibrate).toHaveBeenCalled();
    asNative('ios');
    hapticError();
    await new Promise((r) => setTimeout(r, 0));
    expect(haptics.notification).toHaveBeenCalledWith({ type: 'ERROR' });
  });
});
