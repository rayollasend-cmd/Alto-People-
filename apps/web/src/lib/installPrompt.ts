// Module-level capture for Chrome's deferred PWA install prompt.
//
// `beforeinstallprompt` fires ONCE, shortly after the manifest + SW are valid
// and Chrome's engagement heuristic is met. If we wait until a React
// component mounts to add the listener, we miss the event whenever it fires
// while the user is on a screen that doesn't render the install button
// (e.g. /login, before they're authenticated). So we attach the listener at
// module-import time — main.tsx imports this file as a side effect, before
// React mounts.
//
// Subscribers (the InstallAppButton component) get the current state on
// subscribe + every transition, so they work whether they mount before or
// after the event fires.

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

let deferredEvent: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<(available: boolean) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredEvent = e as BeforeInstallPromptEvent;
    subscribers.forEach((s) => s(true));
  });
  window.addEventListener('appinstalled', () => {
    deferredEvent = null;
    subscribers.forEach((s) => s(false));
  });
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS legacy.
  return Boolean((window.navigator as { standalone?: boolean }).standalone);
}

export function subscribeInstallPrompt(cb: (available: boolean) => void): () => void {
  cb(deferredEvent !== null);
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Trigger Chrome's native install dialog. Returns:
 *  - 'accepted' / 'dismissed' — user made a choice
 *  - 'unavailable' — no deferred prompt has been captured (browser doesn't
 *    support beforeinstallprompt, or app is already installed)
 */
export async function triggerInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredEvent) return 'unavailable';
  const event = deferredEvent;
  // Burn the event — Chrome won't let us call prompt() twice on the same one.
  deferredEvent = null;
  subscribers.forEach((s) => s(false));
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  } catch {
    return 'dismissed';
  }
}
