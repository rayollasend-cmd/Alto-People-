import { useEffect, useRef, useState } from 'react';
import { LocateFixed, LocateOff } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { rememberDriverFix } from '@/lib/driverPosition';
import { sendVanLocation } from '@/lib/transportApi';
import '@/lib/i18n/en/drive';

/* ----- The van's location, from this phone ------------------------------- */

export type SharingState = 'locating' | 'on' | 'denied' | 'unsupported';

const SEND_EVERY_MS = 10_000;

/**
 * While the run is on the road: watch the phone's GPS and send the van's
 * position every ~10 seconds (sooner after a big move), and keep the
 * screen awake so the phone doesn't stop sharing mid-route.
 */
export function useShareVanLocation(runId: string, active: boolean): SharingState {
  const [state, setState] = useState<SharingState>('locating');
  const latest = useRef<GeolocationPosition | null>(null);
  const lastSent = useRef<{ at: number; lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('unsupported');
      return;
    }
    let stopped = false;
    const send = (pos: GeolocationPosition) => {
      const c = pos.coords;
      lastSent.current = { at: Date.now(), lat: c.latitude, lng: c.longitude };
      void sendVanLocation(runId, {
        lat: c.latitude,
        lng: c.longitude,
        heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
        speed: c.speed !== null && Number.isFinite(c.speed) ? c.speed : null,
        accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
      }).catch(() => {
        /* the next tick retries */
      });
    };
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        if (stopped) return;
        latest.current = pos;
        // Floor walk 17: the taps carry where the van is.
        rememberDriverFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null });
        setState('on');
        const prev = lastSent.current;
        const moved = prev ? Math.hypot(pos.coords.latitude - prev.lat, pos.coords.longitude - prev.lng) > 0.0008 : true;
        if (!prev || Date.now() - prev.at >= SEND_EVERY_MS || (moved && Date.now() - prev.at >= 5_000)) send(pos);
      },
      (err) => {
        if (!stopped) setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'locating');
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
    // Parked at a stop, the GPS may go quiet — keep the riders' map fresh.
    const tick = window.setInterval(() => {
      if (latest.current && (!lastSent.current || Date.now() - lastSent.current.at >= SEND_EVERY_MS)) send(latest.current);
    }, SEND_EVERY_MS);

    // Keep the screen on while driving the route.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const holdScreen = () => {
      if (!stopped && document.visibilityState === 'visible' && nav.wakeLock) {
        nav.wakeLock
          .request('screen')
          .then((l) => {
            // The run ended (or the page left) while the lock was on its way:
            // let it go now, or the screen stays awake with nobody holding it (CODE-29).
            if (stopped) {
              void l.release().catch(() => {});
              return;
            }
            lock = l;
          })
          .catch(() => {});
      }
    };
    holdScreen();
    document.addEventListener('visibilitychange', holdScreen);

    return () => {
      stopped = true;
      navigator.geolocation.clearWatch(watch);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', holdScreen);
      void lock?.release().catch(() => {});
    };
  }, [runId, active]);

  return state;
}

/** Whether the riders can see the van — one quiet line, loud only when they can't. */
export function SharingLine({ state }: { state: SharingState }) {
  const { t } = useI18n();
  const on = state === 'on';
  const off = state === 'denied' || state === 'unsupported';
  return (
    <p
      role="status"
      className={cn(
        'flex items-center gap-2 text-sm',
        on ? 'text-positive-800' : off ? 'rounded-md border border-caution-300 bg-caution-50 px-3 py-2 text-caution-800' : 'text-ink-muted',
      )}
    >
      {off ? <LocateOff className="h-4 w-4 shrink-0" aria-hidden="true" /> : <LocateFixed className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {on ? t('drive.sharing') : state === 'locating' ? t('drive.locating') : state === 'denied' ? t('drive.locationOff') : t('drive.locationUnsupported')}
    </p>
  );
}
