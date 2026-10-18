import { isNative, nativePlatform } from './platform';

/**
 * The native shell's chrome: status bar, splash, hardware back, deep links,
 * the system browser for sign-ins the web view can't finish, and network
 * changes. Every function is a no-op on the web.
 */

/** Light or dark status bar text to match the app's resolved theme. */
export async function syncStatusBar(theme: 'light' | 'dark'): Promise<void> {
  if (!isNative()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Style.Dark = light text (for a dark app); Style.Light = dark text.
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
    if (nativePlatform() === 'android') {
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.setBackgroundColor({ color: '#00000000' });
    }
  } catch {
    /* older shell */
  }
}

export async function hideSplash(): Promise<void> {
  if (!isNative()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 250 });
  } catch {
    /* already hidden */
  }
}

/**
 * Android's hardware / gesture back: back through the app's own history,
 * and only leave the app from a top-level page (minimise, as native apps
 * do — never kill it).
 */
export async function handleHardwareBack(goBack: () => boolean): Promise<() => void> {
  if (nativePlatform() !== 'android') return () => {};
  const { App } = await import('@capacitor/app');
  const handle = await App.addListener('backButton', () => {
    if (!goBack()) void App.minimizeApp();
  });
  return () => void handle.remove();
}

/**
 * Links that open the app: https://<our host>/rides/… (universal / app
 * links) and altopeople://… (the sign-in handoff). `open` receives an
 * in-app path; the handoff code is traded in the web view itself.
 */
export async function handleDeepLinks(open: (path: string) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const { App } = await import('@capacitor/app');
  const handle = await App.addListener('appUrlOpen', ({ url }) => {
    const path = deepLinkPath(url);
    if (path) open(path);
  });
  return () => void handle.remove();
}

/** The in-app path a deep link means, or null (exported for tests). */
export function deepLinkPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'altopeople:') {
      // altopeople://auth/complete?code=… → the server trades the code for a session cookie.
      if (u.host === 'auth' && u.pathname === '/complete') {
        const code = u.searchParams.get('code');
        return code ? `/api/auth/native-exchange?code=${encodeURIComponent(code)}` : null;
      }
      const path = `/${u.host}${u.pathname}`.replace(/\/+$/, '') || '/';
      return `${path}${u.search}`;
    }
    if (u.protocol === 'https:' && typeof window !== 'undefined' && u.host === window.location.host) {
      return `${u.pathname}${u.search}${u.hash}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** Open a page of ours in the system browser (SSO, passkeys) — it comes back via the handoff deep link. */
export async function openInSystemBrowser(path: string): Promise<void> {
  const url = new URL(path, window.location.origin).toString();
  if (!isNative()) {
    window.location.assign(url);
    return;
  }
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url, presentationStyle: 'popover', toolbarColor: '#0f1827' });
}

export async function closeSystemBrowser(): Promise<void> {
  if (!isNative()) return;
  try {
    const { Browser } = await import('@capacitor/browser');
    await Browser.close();
  } catch {
    /* not open */
  }
}

/** Calls `back` whenever the network comes back. */
export async function onReconnect(back: () => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const { Network } = await import('@capacitor/network');
  let wasOnline = (await Network.getStatus()).connected;
  const handle = await Network.addListener('networkStatusChange', (s) => {
    if (s.connected && !wasOnline) back();
    wasOnline = s.connected;
  });
  return () => void handle.remove();
}

/** Calls `cb(isActive)` when the app goes to the background / comes back. */
export async function onAppStateChange(cb: (active: boolean) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const { App } = await import('@capacitor/app');
  const handle = await App.addListener('appStateChange', ({ isActive }) => cb(isActive));
  return () => void handle.remove();
}
