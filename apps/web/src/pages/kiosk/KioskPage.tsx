import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import {
  kioskAttachFace,
  kioskConfig,
  kioskFaceConsent,
  kioskPunch,
  kioskVerifyPin,
  type FaceConsentStatus,
  type KioskPunchAction,
} from '@/lib/kiosk99Api';
import {
  extractDescriptor,
  loadFaceModels,
  getFaceModelsState,
  onFaceModelsStateChange,
  type FaceModelsState,
} from '@/lib/faceMatch';
import { Logo } from '@/components/Logo';
import {
  drainQueue,
  enqueuePunch,
  newIdempotencyKey,
  queueSize,
} from '@/lib/kioskQueue';

/**
 * Phase 99 — Public kiosk page. No auth, no Layout — full-screen UI a
 * shared tablet can sit on all day. Flow:
 *
 *   setup (first run) → idle → pin entry → selfie capture → result → idle
 *
 * The device token is paste-once into localStorage. Reset by clearing
 * site data on the kiosk's browser.
 */

const TOKEN_STORAGE_KEY = 'alto.kiosk.deviceToken';

// A kiosk is bolted to a wall — its position doesn't change during a
// session, so we cache one coarse fix and reuse it across the preflight
// and the punch rather than waking the GPS radio twice per clock-in.
// Refreshed if older than this, purely as a belt-and-suspenders against
// a device that somehow gets relocated without a reload.
const LOCATION_TTL_MS = 5 * 60 * 1000;

// 'consent' — one-time face-verification consent, shown after the first
// successful PIN entry when the associate has never been asked.
// 'submitting' — brief interstitial for the PIN-only path (declined
// consent), which skips the camera and goes straight to the punch.
type Stage =
  | 'setup'
  | 'idle'
  | 'pin'
  | 'consent'
  | 'selfie'
  | 'submitting'
  | 'result'
  | 'error';

interface PunchResult {
  action: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';
  associateName: string;
  at: string;
  /** True when the punch was queued offline rather than sent live. */
  queued?: boolean;
}

type Intent = 'BREAK' | null;

export function KioskPage() {
  const [stage, setStage] = useState<Stage>('idle');
  const [token, setToken] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [intent, setIntent] = useState<Intent>(null);
  const [result, setResult] = useState<PunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline wrong-PIN feedback. Shown beneath the dots on the PIN screen
  // and triggers a shake. Distinct from `error` (which is for hard
  // failures like an expired device token that bounce to a full-page
  // error). Cleared the moment the user touches the keypad again.
  const [pinError, setPinError] = useState<string | null>(null);
  // True while a PIN is being verified over the network. Freezes the keypad
  // on this shared device so a second person can't start typing over an
  // in-flight punch.
  const [verifying, setVerifying] = useState(false);
  // What the preflight learned: who this is and what the punch will do.
  // Drives the camera-screen greeting ("Clocking you in, Maria"). Null
  // when the preflight couldn't reach the server (offline flow) — the
  // camera screen falls back to a generic prompt.
  const [preflight, setPreflight] = useState<{
    firstName: string;
    predictedAction: KioskPunchAction;
    faceConsent: FaceConsentStatus | null;
  } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [queued, setQueued] = useState<number>(() => queueSize());
  // Whether this device has a geofence — tri-state on purpose. Boot config
  // resolves it to 'yes'/'no'; until then (or if config failed, e.g. the
  // tablet booted offline) it stays 'unknown'. We only SKIP geolocation
  // when we positively know it's 'no'. The fence is advisory server-side
  // (missing/out-of-fence coords flag for review, never block), so coords
  // are purely a fraud signal — 'unknown' still attempts a coarse,
  // best-effort fix to keep that signal flowing. The latency win holds:
  // config resolves on boot well before anyone walks up to punch.
  const geofenceModeRef = useRef<'unknown' | 'yes' | 'no'>('unknown');
  // Session-cached coarse location, shared by preflight + punch.
  const cachedLocationRef = useRef<{ lat: number; lng: number; at: number } | null>(
    null,
  );

  // Boot: read token from localStorage, otherwise show setup.
  // Also kick off face-api model preload here so by the time someone
  // actually punches, the ~6.5MB of model weights are already cached.
  // Used to fire on the first tap into PIN entry, which only gave the
  // models ~5 seconds before the camera opened — too tight on slow
  // tablets / poor Wi-Fi.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        setToken(stored);
        setStage('idle');
        // Learn whether this kiosk has a geofence so we can skip GPS
        // entirely when it doesn't. Best-effort — on failure we keep
        // attempting coarse fixes, and the server treats the fence as
        // advisory regardless.
        void kioskConfig(stored)
          .then((c) => {
            geofenceModeRef.current = c.geofenceRequired ? 'yes' : 'no';
          })
          .catch(() => {
            /* keep 'unknown' — location stays best-effort either way */
          });
      } else {
        setStage('setup');
      }
    } catch {
      setStage('setup');
    }
    void loadFaceModels().catch(() => {
      /* ignore — face match becomes optional if the CDN is down */
    });
  }, []);

  // Live clock for the idle screen.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Lock down the document while the kiosk is mounted. iOS Safari
  // evaluates pull-to-refresh on `body`'s overscroll-behavior, not on
  // the nested fixed div — so setting `overscrollBehavior: 'contain'`
  // on the page root isn't enough; a downward swipe at the top of the
  // viewport still triggers the browser's refresh gesture mid-punch.
  // We set body to `overscroll-behavior: none` and `overflow: hidden`
  // for the lifetime of the kiosk, restoring on unmount so when an
  // admin closes the tab the rest of the SPA isn't permanently
  // affected. touchAction at the body level kills double-tap zoom on
  // any element a finger lands on before bubbling to the kiosk root.
  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const prev = {
      bodyOverscroll: body.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyTouchAction: body.style.touchAction,
      htmlOverscroll: html.style.overscrollBehavior,
    };
    body.style.overscrollBehavior = 'none';
    body.style.overflow = 'hidden';
    body.style.touchAction = 'manipulation';
    html.style.overscrollBehavior = 'none';
    return () => {
      body.style.overscrollBehavior = prev.bodyOverscroll;
      body.style.overflow = prev.bodyOverflow;
      body.style.touchAction = prev.bodyTouchAction;
      html.style.overscrollBehavior = prev.htmlOverscroll;
    };
  }, []);

  // Phase 102 — drain the queue: on first idle, on browser online event,
  // and on a 30s timer (handles flaky networks where 'online' doesn't
  // fire because the radio thinks it's connected to a captive portal).
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void drainQueue()
        .then((r) => {
          if (cancelled) return;
          setQueued(r.remaining);
        })
        .catch(() => {
          /* swallow — next tick retries */
        });
    };
    tick();
    const onOnline = () => tick();
    window.addEventListener('online', onOnline);
    const t = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.clearInterval(t);
    };
  }, []);

  // Auto-return-to-idle timer for the result/error screens. Tracked in a
  // ref so a tap-to-dismiss can cancel it — otherwise a stale timer fires
  // mid-way through the NEXT person's PIN entry and wipes their input.
  const resetTimerRef = useRef<number | null>(null);
  const reset = () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setPin('');
    setIntent(null);
    setResult(null);
    setError(null);
    setPinError(null);
    setPreflight(null);
    setStage('idle');
  };
  const scheduleReset = (ms: number) => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(reset, ms);
  };
  // Hard errors auto-dismiss after long enough to actually read them —
  // ~60ms/char (slow reading speed under stress), floored at 6s. A flat
  // 3s used to cut off "registered to a different site…" mid-sentence.
  const errorDwellMs = (msg: string) => Math.max(6_000, msg.length * 60);

  // Best-effort geolocation, tuned for a stationary wall-mounted tablet:
  //
  //  - Skipped entirely unless this kiosk actually has a geofence — most
  //    don't, and waking the GPS radio for coords the server ignores was
  //    several wasted seconds per clock-in.
  //  - `enableHighAccuracy: false` — coarse Wi-Fi/cell positioning is
  //    plenty for a geofence radius and resolves near-instantly instead of
  //    spinning up GPS hardware for a first fix.
  //  - Cached for the session and reused across the preflight and the
  //    punch, so a single clock-in never fetches twice.
  //
  // On denial/timeout we resolve null. The geofence is advisory
  // server-side, so missing coords never block — the punch just carries
  // no distance for the review queue.
  const tryGetLocation = (): Promise<{ lat: number; lng: number } | null> => {
    if (geofenceModeRef.current === 'no') return Promise.resolve(null);
    const cached = cachedLocationRef.current;
    if (cached && Date.now() - cached.at < LOCATION_TTL_MS) {
      return Promise.resolve({ lat: cached.lat, lng: cached.lng });
    }
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          cachedLocationRef.current = { ...loc, at: Date.now() };
          resolve(loc);
        },
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 300_000 },
      );
    });
  };

  // Upload the deferred selfie + face descriptor off the punch's critical
  // path. The selfie is the biggest payload in the flow (~50-200KB base64),
  // so keeping it out of the punch request is what makes a clock-in feel
  // instant on slow Wi-Fi; descriptor extraction is CPU-heavy on top. Both
  // are audit/flag-only on the server (a mismatch still reaches the review
  // queue, just a beat later), so this whole thing is best-effort — the
  // associate is already on the result screen.
  const attachSelfieAndFace = async (
    selfieData: string,
    punchId: string,
    deviceToken: string,
  ) => {
    let faceDescriptor: number[] | null = null;
    try {
      await loadFaceModels();
      const img = new Image();
      img.src = selfieData;
      await img.decode();
      faceDescriptor = await extractDescriptor(img);
    } catch {
      /* face match is optional — still upload the selfie below */
    }
    try {
      await kioskAttachFace({ deviceToken, punchId, selfie: selfieData, faceDescriptor });
    } catch {
      /* best-effort — the punch already succeeded */
    }
  };

  const submit = async (selfieData: string | null) => {
    if (!token) {
      setStage('setup');
      return;
    }
    const idempotencyKey = newIdempotencyKey();
    const capturedAt = new Date().toISOString();
    const loc = await tryGetLocation();
    const payload = {
      deviceToken: token,
      pin,
      // Deferred to the background attach (see attachSelfieAndFace) so the
      // large selfie upload + CPU-heavy descriptor extraction don't sit in
      // front of the result screen. Kept tiny, the punch returns fast even
      // on a slow uplink.
      selfie: null,
      latitude: loc?.lat ?? null,
      longitude: loc?.lng ?? null,
      faceDescriptor: null,
      idempotencyKey,
      clientPunchedAt: capturedAt,
      intent,
    };
    try {
      const r = await kioskPunch(payload);
      setResult({
        action: r.action,
        associateName: r.associateName,
        at: r.at,
      });
      setStage('result');
      scheduleReset(4000);
      // Fire-and-forget: upload the selfie + attach the descriptor now that
      // the associate is already clocked in.
      if (selfieData) void attachSelfieAndFace(selfieData, r.punchId, token);
    } catch (err) {
      // Server rejected (4xx) → real error, show it. Network failure →
      // queue and tell the user "saved offline". 429 (throttle collision,
      // e.g. an offline-queue drain stamped the bucket a beat before this
      // live punch) is NOT fatal: fall through to the queue — the punch
      // carries an idempotencyKey and clientPunchedAt, so the next drain
      // records it with the original timestamp.
      if (
        err instanceof ApiError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 429
      ) {
        // Device-token expired or revoked: self-heal by clearing the
        // local copy so the next render lands on the setup screen.
        // HR pastes a freshly-rotated token from the admin page.
        if (err.code === 'device_token_expired' || err.code === 'invalid_device') {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          setToken(null);
          setError(
            err.code === 'device_token_expired'
              ? 'This kiosk\'s token expired. Get a fresh one from the admin page.'
              : err.message,
          );
          setStage('setup');
          return;
        }
        // Wrong-PIN at the punch step (race: PIN rotated between
        // preflight and submit). Drop the user back at the keypad with
        // an inline message instead of a full-page red error so they
        // can retype immediately. Same UX as the preflight rejection.
        if (err.code === 'invalid_pin') {
          setPin('');
          setPinError('Wrong PIN. Try again.');
          setStage('pin');
          return;
        }
        setError(err.message);
        setStage('error');
        scheduleReset(errorDwellMs(err.message));
        return;
      }
      enqueuePunch({
        idempotencyKey,
        deviceToken: token,
        pin,
        selfie: selfieData,
        // Offline punches skip face capture — it's a best-effort fraud
        // signal and the selfie image is still queued for HR review.
        faceDescriptor: null,
        latitude: loc?.lat ?? null,
        longitude: loc?.lng ?? null,
        capturedAt,
        intent,
      });
      setQueued(queueSize());
      // Optimistic display — we don't actually know CLOCK_IN vs CLOCK_OUT
      // until the server resolves it, so use a neutral verb.
      setResult({
        action: 'CLOCK_IN',
        associateName: 'Saved',
        at: capturedAt,
        queued: true,
      });
      setStage('result');
      scheduleReset(4000);
    }
  };

  if (stage === 'setup') {
    return <SetupScreen onSaved={(t) => { setToken(t); setStage('idle'); }} />;
  }

  return (
    <div
      className="fixed inset-0 bg-midnight text-white flex flex-col items-center justify-center select-none"
      style={{
        // Tablet hardening: no pinch-to-zoom, no double-tap-zoom (the
        // PIN pad would otherwise zoom on a rapid double-tap), no
        // pull-to-refresh on iOS/Android Chrome which would dismiss
        // mid-punch. Selection is already blocked via select-none.
        touchAction: 'manipulation',
        // `none` (not `contain`) — `contain` only blocks scroll
        // chaining; `none` also kills the browser refresh gesture if
        // the body-level lock above somehow doesn't apply (older WebViews).
        overscrollBehavior: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Brand anchor — a thin gold bar across the top of the kiosk
          says "this is the Alto system" without competing with the
          gold tap-to-clock-in surface. Sits below any safe-area inset
          so an iPad notch doesn't clip it. */}
      <div
        className="fixed left-0 right-0 z-50 h-1 bg-gradient-to-r from-transparent via-gold to-transparent opacity-80"
        style={{ top: 'env(safe-area-inset-top)' }}
        aria-hidden="true"
      />
      {stage === 'idle' && (
        <IdleScreen
          now={now}
          onTap={() => {
            // Models were pre-warmed on mount — just open the pad.
            setStage('pin');
          }}
        />
      )}
      {stage === 'pin' && (
        <PinPad
          pin={pin}
          onChange={(p) => {
            setPin(p);
            // Any keypad activity dismisses the inline error so the
            // next attempt starts clean.
            if (pinError) setPinError(null);
          }}
          intent={intent}
          onIntent={(i) => {
            setIntent(i);
            // Toggling break is "keypad activity" too — clear any stale
            // inline error (e.g. not_clocked_in tells them to do exactly
            // this, so the message shouldn't linger once they have).
            if (pinError) setPinError(null);
          }}
          error={pinError}
          submitting={verifying}
          onSubmit={async () => {
            // Preflight the PIN before opening the camera. A made-up
            // code stops here instead of showing the user themselves
            // on a selfie countdown. Network failure falls through so
            // the regular offline-queue flow still works.
            if (!token || verifying) return;
            setVerifying(true);
            try {
            const verify = (loc: { lat: number; lng: number } | null) =>
              kioskVerifyPin({
                deviceToken: token,
                pin,
                latitude: loc?.lat ?? null,
                longitude: loc?.lng ?? null,
                intent,
              });
            try {
              // Coords are best-effort. The geofence is advisory
              // server-side — out-of-fence (or coordinate-less) punches
              // succeed and get flagged for HR review — so a denied
              // location permission never blocks a clock-in.
              const loc = await tryGetLocation();
              const v = await verify(loc);
              // Carry who this is + what the punch will do into the
              // camera screen ("Clocking you in, Maria"). Also the
              // associate's chance to catch a typo'd PIN that landed on
              // someone ELSE's valid code — a wrong name on screen is
              // the only tell.
              setPreflight({
                firstName: v.associateFirstName,
                predictedAction: v.predictedAction,
                faceConsent: v.faceConsent,
              });
              // Route by consent: never asked → one-time consent
              // screen; declined → PIN-only, no camera; granted →
              // selfie as usual.
              if (v.faceConsent === null) {
                setStage('consent');
              } else if (v.faceConsent === 'DECLINED') {
                setStage('submitting');
                void submit(null);
              } else {
                setStage('selfie');
              }
            } catch (err) {
              if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
                if (err.code === 'device_token_expired' || err.code === 'invalid_device') {
                  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
                  setToken(null);
                  setError(err.message);
                  setStage('setup');
                  return;
                }
                // Wrong PIN: stay on the keypad with an inline message
                // + shake. The associate retypes without losing place
                // or having to wait out a full-page error timeout.
                if (err.code === 'invalid_pin') {
                  setPin('');
                  setPinError('Wrong PIN. Try again.');
                  return;
                }
                // Break toggle while not clocked in — caught at the
                // keypad now (predictPunchAction), not after a selfie.
                // Keep the PIN; turning the toggle off clears this.
                if (err.code === 'not_clocked_in') {
                  setPinError("You're not clocked in — turn off break to clock in.");
                  return;
                }
                // Throttle collision — e.g. the previous associate's
                // preflight landed under a second ago, or a queue drain
                // stamped the bucket. The typed PIN is fine; keep it and
                // let them just tap submit again.
                if (err.status === 429) {
                  setPinError('One at a time — wait a second, then tap ✓ again.');
                  return;
                }
                setError(err.message);
                setStage('error');
                scheduleReset(errorDwellMs(err.message));
                return;
              }
              // Network failure / kiosk timeout → assume offline; let
              // the user proceed to selfie and the punch will land in
              // the offline queue. No preflight info in this path, so
              // the camera screen shows its generic prompt.
              setStage('selfie');
            }
            } finally {
              setVerifying(false);
            }
          }}
          onCancel={reset}
        />
      )}
      {stage === 'consent' && preflight && (
        <ConsentScreen
          firstName={preflight.firstName}
          onChoice={(agree) => {
            // Record best-effort: a network failure must not block this
            // punch — the decision just stays unrecorded and the kiosk
            // asks again next time.
            if (token) {
              void kioskFaceConsent({
                deviceToken: token,
                pin,
                consent: agree,
              }).catch(() => {});
            }
            if (agree) {
              setStage('selfie');
            } else {
              setStage('submitting');
              void submit(null);
            }
          }}
          onCancel={reset}
        />
      )}
      {stage === 'selfie' && (
        <SelfieCapture
          preflight={preflight}
          onCaptured={(data) => void submit(data)}
          onSkip={() => void submit(null)}
          onCancel={reset}
        />
      )}
      {stage === 'submitting' && (
        <div className="text-center">
          <div className="text-gold text-4xl animate-pulse mb-4">⋯</div>
          <div className="text-2xl text-silver">One moment…</div>
        </div>
      )}
      {/* Result + error screens dismiss on tap-anywhere so the next
          person in line doesn't have to wait out the auto-reset timer. */}
      {stage === 'result' && result && (
        <button
          type="button"
          onClick={reset}
          aria-label="Done — return to clock"
          className="fixed inset-0 flex items-center justify-center focus:outline-none"
        >
          <ResultScreen result={result} />
        </button>
      )}
      {stage === 'error' && (
        <button
          type="button"
          onClick={reset}
          className="fixed inset-0 flex flex-col items-center justify-center text-center focus:outline-none"
        >
          <div className="text-6xl mb-6">⚠️</div>
          <div className="text-3xl text-alert max-w-2xl px-8">{error}</div>
          <div className="mt-8 text-base text-silver/80">Tap anywhere to dismiss</div>
        </button>
      )}
      {/* Phase 102 — queued punch indicator. Only shown when there's a
          backlog so the normal idle screen stays clean. */}
      {queued > 0 && (
        <div className="fixed top-4 left-4 px-3 py-1.5 bg-warning/20 border border-warning/40 rounded-full text-warning text-xs">
          {queued} punch{queued === 1 ? '' : 'es'} waiting to sync
        </div>
      )}
      {/* Reset hidden affordance: triple-tap top-right corner unlocks setup. */}
      <ResetCorner
        onReset={() => {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          setToken(null);
          setStage('setup');
        }}
      />
    </div>
  );
}

function SetupScreen({ onSaved }: { onSaved: (token: string) => void }) {
  const [val, setVal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onSave = () => {
    const t = val.trim();
    if (!t.startsWith('altokiosk_')) {
      setError('Token should start with altokiosk_');
      return;
    }
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, t);
      onSaved(t);
    } catch {
      setError('Could not save token. Check browser storage settings.');
    }
  };
  return (
    <div className="fixed inset-0 bg-midnight text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-navy-secondary border border-navy-secondary rounded-2xl p-8 shadow-2xl">
        <div className="text-gold text-sm uppercase tracking-widest mb-2">
          Alto Kiosk
        </div>
        <h1 className="text-3xl font-serif mb-4">Pair this device</h1>
        <p className="text-silver text-sm mb-6">
          Paste the device token from HR's kiosk admin page. The token
          starts with <code className="font-mono">altokiosk_</code>.
        </p>
        <textarea
          className="w-full h-32 bg-midnight border border-navy-secondary rounded-md p-3 font-mono text-xs text-white"
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            if (error) setError(null);
          }}
          placeholder="altokiosk_..."
          autoFocus
        />
        {error && (
          <p
            role="alert"
            className="mt-3 text-sm text-alert px-3 py-2 rounded-md border border-alert/40 bg-alert/10"
          >
            {error}
          </p>
        )}
        <button
          onClick={onSave}
          className="mt-4 w-full bg-gold hover:bg-gold-bright text-navy transition-colors rounded-md py-3 font-medium"
        >
          Pair device
        </button>
      </div>
    </div>
  );
}

function IdleScreen({ now, onTap }: { now: Date; onTap: () => void }) {
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  // Surface face-model preload state so an associate landing while
  // the ~6.5MB weights are still downloading sees a status hint
  // instead of hitting an "unavailable" error mid-selfie. The actual
  // capture step also handles the not-ready case, this is just nicer
  // upfront feedback for the operator setting up a new tablet.
  const [faceState, setFaceState] = useState<FaceModelsState>(
    getFaceModelsState(),
  );
  useEffect(() => onFaceModelsStateChange(setFaceState), []);

  return (
    <button
      onClick={onTap}
      className="w-full h-full flex flex-col items-center justify-center"
    >
      <Logo size="xl" className="mb-6 rounded-xl" alt="Alto HR" />
      <div className="text-gold text-sm uppercase tracking-[0.25em] mb-4 inline-flex items-center gap-2">
        <span className="h-px w-6 bg-gold/60" aria-hidden="true" />
        Alto Kiosk
        <span className="h-px w-6 bg-gold/60" aria-hidden="true" />
      </div>
      <div className="text-9xl font-serif font-light tracking-tight">{time}</div>
      <div className="text-2xl text-silver mt-3">{date}</div>
      <div className="mt-16 px-12 py-6 bg-gold/15 border border-gold/60 text-gold rounded-full text-2xl font-medium animate-pulse">
        Tap to clock in / out
      </div>
      {faceState === 'loading' && (
        <div className="mt-6 text-sm text-silver/80 inline-flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-gold animate-pulse" />
          Preparing face match…
        </div>
      )}
      {faceState === 'failed' && (
        <div className="mt-6 text-sm text-warning">
          Face match unavailable — PIN-only mode.
        </div>
      )}
    </button>
  );
}

function PinPad({
  pin,
  onChange,
  intent,
  onIntent,
  onSubmit,
  onCancel,
  error,
  submitting = false,
}: {
  pin: string;
  onChange: (p: string) => void;
  intent: Intent;
  onIntent: (i: Intent) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error?: string | null;
  submitting?: boolean;
}) {
  // Auto-advance once 4 digits are entered — but not while a previous
  // verify is still in flight, so we never fire two punches.
  useEffect(() => {
    if (pin.length === 4 && !submitting) {
      const t = window.setTimeout(onSubmit, 150);
      return () => clearTimeout(t);
    }
  }, [pin, onSubmit, submitting]);

  // Shake the dots row whenever a new error arrives. Keyed on the
  // error string so two consecutive wrong PINs both re-trigger.
  const [shakeKey, setShakeKey] = useState(0);
  useEffect(() => {
    if (error) setShakeKey((k) => k + 1);
  }, [error]);

  const press = (d: string) => {
    if (!submitting && pin.length < 4) onChange(pin + d);
  };
  const back = () => {
    if (!submitting) onChange(pin.slice(0, -1));
  };

  return (
    <div className="flex flex-col items-center w-full max-w-sm px-4">
      <style>{`@keyframes kiosk-shake {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-10px); }
        40%, 80% { transform: translateX(10px); }
      }`}</style>
      <div className="text-2xl text-silver mb-3">
        {intent === 'BREAK'
          ? 'Break — enter your 4-digit PIN'
          : 'Enter your 4-digit PIN'}
      </div>
      {/* min-h 44px — this pill is the only path into the break flow,
          so it gets a full-size touch target, not a caption-sized one. */}
      <button
        onClick={() => onIntent(intent === 'BREAK' ? null : 'BREAK')}
        className={`mb-6 min-h-[44px] px-5 py-2.5 rounded-full text-base border transition-colors ${
          intent === 'BREAK'
            ? 'bg-warning/20 border-warning/60 text-warning'
            : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
        }`}
      >
        {intent === 'BREAK' ? '☕ On break' : 'Going on break?'}
      </button>
      <div
        key={shakeKey}
        className="flex gap-4 mb-3"
        style={
          error
            ? { animation: 'kiosk-shake 0.4s cubic-bezier(.36,.07,.19,.97) both' }
            : undefined
        }
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-16 h-20 rounded-xl border-2 flex items-center justify-center text-4xl transition-colors ${
              pin.length > i
                ? intent === 'BREAK'
                  ? 'bg-warning border-warning text-navy-secondary'
                  : 'bg-gold border-gold-bright text-navy'
                : error
                  ? 'bg-navy-secondary/40 border-alert/60 text-silver'
                  : 'bg-navy-secondary/40 border-navy-secondary text-silver'
            }`}
          >
            {pin.length > i ? '•' : ''}
          </div>
        ))}
      </div>
      <div className="h-7 mb-4 flex items-center justify-center">
        {error ? (
          <span className="text-alert text-base font-medium" aria-live="polite">
            {error}
          </span>
        ) : null}
      </div>
      <div
        className={`grid grid-cols-3 gap-3 w-full transition-opacity ${
          submitting ? 'opacity-40 pointer-events-none' : ''
        }`}
        aria-busy={submitting}
      >
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            onClick={() => press(d)}
            disabled={submitting}
            className="aspect-square bg-navy-secondary hover:bg-navy-secondary/70 rounded-2xl text-4xl font-light transition-transform active:scale-95"
          >
            {d}
          </button>
        ))}
        <button
          onClick={onCancel}
          disabled={submitting}
          className="aspect-square bg-navy-secondary/40 hover:bg-navy-secondary/70 rounded-2xl text-sm text-silver transition-transform active:scale-95"
        >
          Cancel
        </button>
        <button
          onClick={() => press('0')}
          disabled={submitting}
          className="aspect-square bg-navy-secondary hover:bg-navy-secondary/70 rounded-2xl text-4xl font-light transition-transform active:scale-95"
        >
          0
        </button>
        <button
          onClick={back}
          disabled={submitting}
          className="aspect-square bg-navy-secondary/40 hover:bg-navy-secondary/70 rounded-2xl text-2xl text-silver transition-transform active:scale-95"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

// One-time biometric consent. Shown after the first valid PIN entry for
// an associate who has never been asked (faceConsent === null). Both
// choices are first-class: declining means PIN-only punches forever
// (the camera never opens for them) until they change their mind via HR.
function ConsentScreen({
  firstName,
  onChoice,
  onCancel,
}: {
  firstName: string;
  onChoice: (agree: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col items-center max-w-lg px-6 text-center">
      <div className="text-3xl text-white mb-3">
        Quick question, <span className="text-gold-bright">{firstName}</span>
      </div>
      <p className="text-silver text-lg mb-2">
        This kiosk can take a quick photo at each punch to confirm it&rsquo;s
        really you (it stops anyone else clocking in with your number).
      </p>
      <p className="text-silver/80 text-sm mb-8">
        Photos are used only to verify your punches and are deleted after 90
        days. If you&rsquo;d rather not, you can clock in with just your number —
        no photo, ever. You can change this later through your manager.
      </p>
      <button
        onClick={() => onChoice(true)}
        className="w-full min-h-[56px] bg-gold hover:bg-gold-bright text-navy rounded-xl py-4 text-xl font-medium transition-colors"
      >
        OK — use photo verification
      </button>
      <button
        onClick={() => onChoice(false)}
        className="w-full min-h-[56px] mt-3 bg-navy-secondary hover:bg-navy-secondary/70 text-white rounded-xl py-4 text-xl transition-colors"
      >
        No thanks — number only
      </button>
      <button
        onClick={onCancel}
        className="mt-6 min-h-[44px] px-6 text-silver text-base hover:text-white transition"
      >
        Cancel
      </button>
    </div>
  );
}

// Action-specific greeting for the camera screen. Saying WHAT the punch
// will do (and to WHOM) before the snap is the associate's only chance
// to catch two classes of mistake: a punch about to go the wrong
// direction, and a typo'd PIN that landed on someone else's valid code.
const PREDICTED_GREETING: Record<KioskPunchAction, string> = {
  CLOCK_IN: 'Clocking you in',
  CLOCK_OUT: 'Clocking you out',
  BREAK_START: 'Starting your break',
  BREAK_END: 'Ending your break',
};

function SelfieCapture({
  preflight,
  onCaptured,
  onSkip,
  onCancel,
}: {
  preflight: { firstName: string; predictedAction: KioskPunchAction } | null;
  onCaptured: (dataUrl: string) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Latch the callback in a ref so the countdown effect below doesn't
  // depend on it. The parent re-renders every second (its idle clock
  // ticks even while the selfie screen is up), which produces a new
  // onCaptured arrow on every render. Listing it as a dep made the
  // 1-second setTimeout get cleared + restarted before it could fire,
  // so the countdown sat at 2 forever and the capture never happened.
  const onCapturedRef = useRef(onCaptured);
  useEffect(() => {
    onCapturedRef.current = onCaptured;
  }, [onCaptured]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: 640, height: 480 },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        // Auto-snap after 1 second — enough to position without making a
        // clock-in feel slow. (Was 2s; the extra second was dead time.)
        setCountdown(1);
      } catch (err) {
        setStreamErr(
          err instanceof Error ? err.message : 'Camera access denied.',
        );
      }
    })();
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      // Capture frame.
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c) return;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0);
      const data = c.toDataURL('image/jpeg', 0.7);
      // Submit immediately. The selfie upload + descriptor extraction run
      // off the critical path in the parent (attachSelfieAndFace) so the
      // associate isn't held on the camera — both are audit/flag-only and
      // never gate the punch.
      setAnalyzing(true);
      onCapturedRef.current(data);
      return;
    }
    const t = window.setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  if (streamErr) {
    return (
      <div className="text-center max-w-md px-4">
        <div className="text-2xl mb-4">Camera unavailable</div>
        <div className="text-silver text-sm mb-6">{streamErr}</div>
        <div className="flex gap-3 justify-center">
          <button
            onClick={onSkip}
            className="px-6 py-3 bg-gold hover:bg-gold-bright text-navy rounded-md font-medium transition-colors"
          >
            Continue without selfie
          </button>
          <button
            onClick={onCancel}
            className="px-6 py-3 bg-navy-secondary rounded-md text-silver transition"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      {/* Identity + direction check. Big and personal on purpose: if the
          name is wrong (typo'd PIN hit someone else's code) or the
          direction is wrong (expected clock-in, says clock-out), Cancel
          is right below. */}
      {analyzing ? (
        <div className="text-2xl text-silver mb-4">Verifying…</div>
      ) : preflight ? (
        <div className="text-center mb-4">
          <div className="text-3xl text-white">
            {PREDICTED_GREETING[preflight.predictedAction]},{' '}
            <span className="text-gold-bright">{preflight.firstName}</span>
          </div>
          <div className="text-base text-silver mt-1">
            Not you? Tap Cancel below.
          </div>
        </div>
      ) : (
        <div className="text-2xl text-silver mb-4">Smile for the camera</div>
      )}
      <div className="relative">
        <video
          ref={videoRef}
          className="w-96 h-72 rounded-2xl bg-black object-cover scale-x-[-1]"
          muted
          playsInline
        />
        {/* Soft vignette + face-framing oval. The countdown is short, so
            the oval does the positioning work — associates learn where to
            stand after a punch or two, which keeps face-match quality up
            (and the admin review queue quiet) without slowing the line. */}
        {countdown !== null && countdown > 0 && (
          <div className="absolute inset-0 rounded-2xl bg-black/30">
            <div
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-52 rounded-[50%] border-2 border-dashed border-white/70"
            />
            <div className="absolute top-2 right-2 w-14 h-14 rounded-full border-2 border-gold/80 bg-black/50 flex items-center justify-center text-3xl font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
              {countdown}
            </div>
            <div className="absolute bottom-2 inset-x-0 text-center text-sm text-white/90 drop-shadow">
              Center your face in the oval
            </div>
          </div>
        )}
        {analyzing && (
          <div className="absolute inset-0 flex items-center justify-center bg-midnight/60 rounded-2xl">
            <div className="text-gold text-2xl animate-pulse">⋯</div>
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      {/* Plain-language privacy note — the photo appears with zero
          warning otherwise. (Biometric-consent law compliance, e.g.
          BIPA, is a policy matter handled outside this screen.) */}
      <div className="mt-4 text-sm text-silver/80 max-w-sm text-center">
        Your photo is used only to verify this time punch.
      </div>
      <button
        onClick={onCancel}
        className="mt-4 min-h-[44px] px-6 text-silver text-base hover:text-white transition"
      >
        Cancel
      </button>
    </div>
  );
}

function ResultScreen({ result }: { result: PunchResult }) {
  const time = new Date(result.at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (result.queued) {
    return (
      <div className="relative text-center px-6">
        <style>{`@keyframes kiosk-celebrate-in {
          0% { transform: scale(0.7); opacity: 0; }
          60% { transform: scale(1.05); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }`}</style>
        <div
          style={{ animation: 'kiosk-celebrate-in 0.5s cubic-bezier(.34,1.56,.64,1) both' }}
        >
          <div className="text-7xl mb-5 text-warning">⏱</div>
          <div className="text-sm uppercase tracking-[0.3em] text-silver/80 mb-3">
            Punch saved
          </div>
          <div className="font-display text-7xl md:text-8xl leading-none text-white">
            Saved offline
          </div>
          <div className="mt-6 text-2xl text-silver">
            We'll sync when the network comes back.
          </div>
          <div className="mt-2 text-3xl text-gold-bright tabular-nums">{time}</div>
        </div>
      </div>
    );
  }
  // First name only on the result greeting — "Welcome back, Kaal" reads
  // warmer than full-legal-name on a wall-mounted tablet. Falls back to
  // whatever the server sent if the split is empty (single-name records).
  const firstName = result.associateName.split(' ')[0] || result.associateName;
  const greeting =
    result.action === 'CLOCK_IN'
      ? `Welcome, ${firstName}`
      : result.action === 'CLOCK_OUT'
        ? `See you later, ${firstName}`
        : result.action === 'BREAK_START'
          ? `Enjoy your break, ${firstName}`
          : `Welcome back, ${firstName}`;
  const verb =
    result.action === 'CLOCK_IN'
      ? 'Clocked in'
      : result.action === 'CLOCK_OUT'
        ? 'Clocked out'
        : result.action === 'BREAK_START'
          ? 'On break'
          : 'Back from break';
  const accent =
    result.action === 'CLOCK_IN'
      ? 'text-success'
      : result.action === 'CLOCK_OUT'
        ? 'text-gold'
        : 'text-warning';
  const halo =
    result.action === 'CLOCK_IN'
      ? 'bg-success/20'
      : result.action === 'CLOCK_OUT'
        ? 'bg-gold/20'
        : 'bg-warning/20';
  return (
    <div className="relative text-center px-6">
      <style>{`@keyframes kiosk-celebrate-in {
        0% { transform: scale(0.6); opacity: 0; }
        60% { transform: scale(1.06); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes kiosk-halo {
        0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.55; }
        50% { transform: translate(-50%, -50%) scale(1.08); opacity: 0.9; }
      }`}</style>
      {/* Soft action-tinted halo behind the verb. Sits below the content
          layer so the text reads cleanly while still feeling lit-from-within. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-1/2 h-[28rem] w-[28rem] rounded-full ${halo} blur-3xl`}
        style={{ animation: 'kiosk-halo 2.4s ease-in-out infinite' }}
      />
      <div
        className="relative"
        style={{ animation: 'kiosk-celebrate-in 0.55s cubic-bezier(.34,1.56,.64,1) both' }}
      >
        <div className={`text-7xl mb-5 ${accent}`}>✓</div>
        <div className="text-sm uppercase tracking-[0.3em] text-silver/80 mb-3">
          {greeting}
        </div>
        <div className={`font-display text-7xl md:text-8xl leading-none ${accent}`}>
          {verb}
        </div>
        <div className="mt-6 text-3xl text-gold-bright tabular-nums">{time}</div>
      </div>
    </div>
  );
}

function ResetCorner({ onReset }: { onReset: () => void }) {
  const confirm = useConfirm();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    const t = window.setTimeout(() => setCount(0), 800);
    return () => clearTimeout(t);
  }, [count]);
  return (
    <button
      aria-label="Settings"
      onClick={async () => {
        const next = count + 1;
        if (next >= 3) {
          if (await confirm({ title: 'Unpair this kiosk and clear the device token?', destructive: true })) {
            onReset();
          }
          setCount(0);
        } else {
          setCount(next);
        }
      }}
      className="fixed top-0 right-0 w-12 h-12 opacity-0"
    />
  );
}
