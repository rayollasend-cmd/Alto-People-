import { isNative, nativePlatform } from './platform';
import { registerThisDevice } from './session';

/**
 * Native notifications (APNs on iOS, FCM on Android) via
 * @capacitor/push-notifications. The server sends through the same
 * funnel as web push, after quiet hours / digest choices.
 *
 *   pushPermission()   'granted' | 'denied' | 'prompt' (or 'unsupported' off-app)
 *   enablePush()       ask (only after our own explanation sheet), register,
 *                      and hand the token to POST /devices
 *   listenForPush()    a tapped notification opens its page in the app
 */

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

export async function pushPermission(): Promise<PushPermission> {
  if (!isNative()) return 'unsupported';
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const p = await PushNotifications.checkPermissions();
    if (p.receive === 'granted') return 'granted';
    if (p.receive === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unsupported';
  }
}

async function ensureAndroidChannel(): Promise<void> {
  if (nativePlatform() !== 'android') return;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  await PushNotifications.createChannel({
    id: 'alto_default',
    name: 'Shifts, rides and pay',
    description: 'Schedule changes, ride updates, approvals and pay.',
    importance: 4,
    visibility: 1,
    lights: true,
    vibration: true,
  }).catch(() => {});
}

/** The token arrives asynchronously after register(): wait for it (or an error). */
async function registerForToken(): Promise<string> {
  const { PushNotifications } = await import('@capacitor/push-notifications');
  return new Promise<string>((resolve, reject) => {
    const handles: Array<{ remove: () => Promise<void> }> = [];
    const cleanup = () => void Promise.all(handles.map((h) => h.remove())).catch(() => {});
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('push_registration_timeout'));
    }, 20_000);
    void (async () => {
      handles.push(
        await PushNotifications.addListener('registration', (t) => {
          clearTimeout(timer);
          cleanup();
          resolve(t.value);
        }),
      );
      handles.push(
        await PushNotifications.addListener('registrationError', (e) => {
          clearTimeout(timer);
          cleanup();
          reject(new Error(e.error ?? 'push_registration_failed'));
        }),
      );
      await PushNotifications.register();
    })().catch((err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}

/** Ask, register, and tell the server. Resolves with the outcome. */
export async function enablePush(): Promise<PushPermission> {
  if (!isNative()) return 'unsupported';
  const { PushNotifications } = await import('@capacitor/push-notifications');
  let status = await pushPermission();
  if (status === 'prompt') {
    const r = await PushNotifications.requestPermissions();
    status = r.receive === 'granted' ? 'granted' : r.receive === 'denied' ? 'denied' : 'prompt';
  }
  if (status !== 'granted') return status;
  await ensureAndroidChannel();
  const token = await registerForToken();
  await registerThisDevice(token);
  return 'granted';
}

/** Refresh the token silently when permission was already granted (tokens rotate). */
export async function refreshPushToken(): Promise<void> {
  if ((await pushPermission()) !== 'granted') return;
  try {
    await ensureAndroidChannel();
    const token = await registerForToken();
    await registerThisDevice(token);
  } catch {
    /* next launch tries again */
  }
}

/** A tapped notification opens its page. Returns an unsubscribe. */
export async function listenForPush(open: (path: string) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const handle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const url = (action.notification.data as { url?: unknown } | undefined)?.url;
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) open(url);
  });
  return () => void handle.remove();
}
