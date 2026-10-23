import type { NotificationPushReach } from '@alto-people/shared';
import type { MessageKey } from './i18n';
import { getPushStatus, subscribeToPush } from './push';
import { isNative } from './native/platform';
import { enablePush, pushPermission, type PushPermission } from './native/push';

/**
 * Push on THIS device, whichever kind it is: inside the phone app it is the
 * app's own notifications (APNs / FCM, lib/native/push); in a browser it is
 * web push (lib/push). Settings › Notifications asks this before its Push
 * column says anything about what will arrive here.
 *
 *   subscribed   this device is set up to receive
 *   available    it can be, with one tap (and the system prompt)
 *   denied       the person blocked it in the browser or phone settings
 *   unsupported  this browser cannot do push at all (an iPhone Safari tab)
 */
export type DevicePushStatus = 'unsupported' | 'denied' | 'subscribed' | 'available';

/** True inside the phone app (its notifications are the phone's, not the browser's). */
export function pushIsNativeHere(): boolean {
  return isNative();
}

function fromNative(p: PushPermission): DevicePushStatus {
  if (p === 'granted') return 'subscribed';
  if (p === 'prompt') return 'available';
  return p;
}

export async function thisDevicePushStatus(): Promise<DevicePushStatus> {
  if (isNative()) return fromNative(await pushPermission());
  return getPushStatus();
}

/**
 * Turn push on here: the permission prompt (it must follow a tap), then the
 * subscription or the phone's token goes to the server. Resolves with the
 * state afterwards; throws when the browser refuses so the caller can say so.
 */
export async function turnOnPushHere(): Promise<DevicePushStatus> {
  if (isNative()) return fromNative(await enablePush());
  await subscribeToPush();
  return 'subscribed';
}

/**
 * What the Push column's header has to say about THIS device, or null when
 * a push would reach it and there is nothing to explain. Pure, so the
 * states are tested one by one. Never claims a push will arrive: with no
 * reachable device the note says nothing arrives by push yet.
 *
 * `reach` null = an older server that doesn't report it; then only the
 * device's own state speaks.
 */
export function pushColumnNote(
  device: DevicePushStatus | 'loading',
  reach: NotificationPushReach | null,
  native: boolean,
): { lead: MessageKey; tail: MessageKey | null; canTurnOn: boolean } | null {
  if (reach && !reach.web && !reach.native) {
    return { lead: 'settingsPage.notif.pushNoneServer', tail: null, canTurnOn: false };
  }
  if (device === 'loading') {
    // This device is still being read (a browser whose service worker never
    // answers stays here): the server's count alone must still keep the
    // column from promising anything.
    return reach && reach.devices === 0 ? { lead: 'settingsPage.notif.pushNoDevice', tail: null, canTurnOn: false } : null;
  }
  const here = device === 'subscribed' ? 1 : 0;
  const others = reach ? Math.max(0, reach.devices - here) : 0;
  const tail: MessageKey | null = !reach
    ? null
    : others > 0
      ? 'settingsPage.notif.pushOthersGet'
      : 'settingsPage.notif.pushNoDevice';
  if (reach && !(native ? reach.native : reach.web)) {
    return { lead: 'settingsPage.notif.pushKindNotConnected', tail, canTurnOn: false };
  }
  if (device === 'subscribed') {
    // The server reaches none of their devices: this one's subscription was
    // dropped (a push service retired it). Turning it on again re-registers.
    if (reach && reach.devices === 0) {
      return { lead: 'settingsPage.notif.pushOffHere', tail: 'settingsPage.notif.pushNoDevice', canTurnOn: true };
    }
    return null;
  }
  if (device === 'available') return { lead: 'settingsPage.notif.pushOffHere', tail, canTurnOn: true };
  if (device === 'denied') {
    return { lead: native ? 'settingsPage.notif.pushBlockedApp' : 'settingsPage.notif.pushBlockedHere', tail, canTurnOn: false };
  }
  return { lead: 'settingsPage.notif.pushUnsupportedHere', tail, canTurnOn: false };
}
