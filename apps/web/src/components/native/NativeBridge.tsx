import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { isNative } from '@/lib/native/platform';
import {
  handleDeepLinks,
  handleHardwareBack,
  hideSplash,
  onAppStateChange,
  onReconnect,
  syncStatusBar,
  closeSystemBrowser,
} from '@/lib/native/shell';
import { biometricLockEnabled, readStoredDeviceId, recoverSession, registerThisDevice } from '@/lib/native/session';
import { listenForPush, pushPermission, refreshPushToken as renewPushToken } from '@/lib/native/push';
import { BiometricLock } from './BiometricLock';
import { PushPermissionSheet, pushPromptDue } from './PushPermissionSheet';

/**
 * Everything the native app (apps/mobile) adds on top of the web app,
 * mounted once beside the router. Renders nothing in a browser.
 *
 *   chrome      status bar follows the theme; splash hides once we know who
 *               you are; Android back walks the app's history, then minimises
 *   links       https://<host>/… and altopeople://… open the right page; a
 *               system-browser sign-in comes back as a one-time code
 *   session     a lost web-view session re-opens from the Keychain credential
 *               (after Face ID when the person turned that on)
 *   lock        Face ID / fingerprint on launch and after a minute away
 *   push        the phone registers on sign-in; we ask for notifications with
 *               our own explanation first, never cold; a tapped notification
 *               opens its page
 *   offline     reconnecting (or coming back to the app) replays whatever was
 *               queued — kiosk punches, checklist ticks, approvals
 */

const LOCK_AFTER_MS = 60_000;

export function NativeBridge({ navigate }: { navigate: (to: string | number) => void }) {
  if (!isNative()) return null;
  return <NativeBridgeInner navigate={navigate} />;
}

function NativeBridgeInner({ navigate }: { navigate: (to: string | number) => void }) {
  // (refreshUser renamed: it re-reads who's signed in after a session is re-opened.)
  const { user, isInitializing, refreshUser: syncSignedInUser, signOut } = useAuth();
  const { theme } = useTheme();
  const [locked, setLocked] = useState(false);
  const [askPush, setAskPush] = useState(false);
  const backgroundedAt = useRef<number | null>(null);
  const triedRecovery = useRef(false);
  const registeredFor = useRef<string | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Chrome.
  useEffect(() => {
    void syncStatusBar(theme);
  }, [theme]);
  useEffect(() => {
    if (!isInitializing) void hideSplash();
  }, [isInitializing]);
  useEffect(() => {
    void readStoredDeviceId();
  }, []);

  // Back, links, push taps, reconnects, background/foreground — once.
  useEffect(() => {
    const offs: Array<() => void> = [];
    const open = (path: string) => {
      if (path.startsWith('/api/')) {
        // The sign-in handoff: a full navigation so the session cookie lands.
        void closeSystemBrowser();
        window.location.assign(path);
        return;
      }
      navigateRef.current(path);
    };
    const replay = () => window.dispatchEvent(new Event('online'));
    void handleHardwareBack(() => {
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (idx > 0) {
        navigateRef.current(-1);
        return true;
      }
      return false;
    }).then((off) => offs.push(off));
    void handleDeepLinks(open).then((off) => offs.push(off));
    void listenForPush(open).then((off) => offs.push(off));
    void onReconnect(replay).then((off) => offs.push(off));
    void onAppStateChange((active) => {
      if (!active) {
        backgroundedAt.current = Date.now();
        return;
      }
      replay();
      const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
      backgroundedAt.current = null;
      if (away >= LOCK_AFTER_MS) void biometricLockEnabled().then((on) => on && setLocked(true));
    }).then((off) => offs.push(off));
    return () => offs.forEach((off) => off());
  }, []);

  // Cold start: lock first when the person asked for it.
  useEffect(() => {
    void biometricLockEnabled().then((on) => on && setLocked(true));
  }, []);

  // No session in the web view: try the Keychain credential once.
  useEffect(() => {
    if (isInitializing || user || triedRecovery.current) return;
    triedRecovery.current = true;
    void (async () => {
      if (await biometricLockEnabled()) return; // the lock screen recovers after Face ID
      if (await recoverSession()) await syncSignedInUser();
    })();
  }, [isInitializing, user, syncSignedInUser]);

  // Signed in: register this phone, refresh its push token, maybe ask.
  useEffect(() => {
    if (!user || registeredFor.current === user.id) return;
    registeredFor.current = user.id;
    void (async () => {
      try {
        await registerThisDevice();
        const permission = await pushPermission();
        if (permission === 'granted') await renewPushToken();
        else if (permission === 'prompt' && pushPromptDue()) setAskPush(true);
      } catch {
        /* offline — next sign-in or launch tries again */
      }
    })();
  }, [user]);

  return (
    <>
      {locked && (
        <BiometricLock
          signedIn={!!user}
          onUnlocked={async () => {
            setLocked(false);
            if (!user && (await recoverSession())) await syncSignedInUser();
          }}
          onSignInAgain={async () => {
            setLocked(false);
            await signOut();
            navigateRef.current('/login');
          }}
        />
      )}
      <PushPermissionSheet open={askPush && !locked} onClose={() => setAskPush(false)} />
    </>
  );
}
