import { apiFetch } from './api';

/**
 * Web-push subscription plumbing.
 *
 * Flow: user taps "Enable notifications" (must be a user gesture for the
 * permission prompt) → Notification.requestPermission → subscribe on the
 * already-registered service worker with the server's VAPID public key →
 * POST the subscription to the API, which stores it per-user and pushes
 * through it whenever a bell notification is created.
 *
 * Support notes: Android Chrome anywhere; iOS 16.4+ ONLY when the app is
 * installed to the home screen (Safari tabs have no push) — which is why
 * pushSupported() checks for PushManager rather than sniffing platforms.
 */

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Current state for deciding whether to show the enable card. */
export async function getPushStatus(): Promise<
  'unsupported' | 'denied' | 'subscribed' | 'available'
> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'available';
  } catch {
    return 'unsupported';
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  // Explicit ArrayBuffer backing — pushManager.subscribe's BufferSource
  // type rejects the default ArrayBufferLike generic under strict TS.
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Ask permission and register the subscription. Throws on refusal so the
 *  caller can message accordingly. */
export async function subscribeToPush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notifications were not allowed.');
  }
  const { publicKey } = await apiFetch<{ publicKey: string }>(
    '/communications/me/push/public-key',
  );
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = sub.toJSON();
  await apiFetch('/communications/me/push/subscriptions', {
    method: 'POST',
    body: {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    },
  });
}

/** Best-effort teardown (sign-out, user disables). */
export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await apiFetch('/communications/me/push/subscriptions', {
      method: 'DELETE',
      body: { endpoint: sub.endpoint },
    });
    await sub.unsubscribe();
  } catch {
    // Losing a race here just leaves a dead subscription the sender
    // prunes on its first 404/410.
  }
}
