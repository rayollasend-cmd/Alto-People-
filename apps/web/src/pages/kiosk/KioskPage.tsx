import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { kioskPunch } from '@/lib/kiosk99Api';
import { extractDescriptor, loadFaceModels } from '@/lib/faceMatch';

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

type Stage = 'setup' | 'idle' | 'pin' | 'selfie' | 'result' | 'error';

interface PunchResult {
  action: 'CLOCK_IN' | 'CLOCK_OUT';
  associateName: string;
  at: string;
}

export function KioskPage() {
  const [stage, setStage] = useState<Stage>('idle');
  const [token, setToken] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [result, setResult] = useState<PunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Boot: read token from localStorage, otherwise show setup.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        setToken(stored);
        setStage('idle');
      } else {
        setStage('setup');
      }
    } catch {
      setStage('setup');
    }
  }, []);

  // Live clock for the idle screen.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const reset = () => {
    setPin('');
    setResult(null);
    setError(null);
    setStage('idle');
  };

  // Best-effort geolocation. We try once per punch (not cached at boot)
  // so a kiosk that gets moved doesn't punch with stale coords. If the
  // browser denies or it times out, we send null and let the server
  // decide — the server enforces required-or-not based on the device's
  // configured geofence.
  const tryGetLocation = (): Promise<{ lat: number; lng: number } | null> =>
    new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 60_000 },
      );
    });

  const submit = async (
    selfieData: string | null,
    faceDescriptor: number[] | null,
  ) => {
    if (!token) {
      setStage('setup');
      return;
    }
    try {
      const loc = await tryGetLocation();
      const r = await kioskPunch({
        deviceToken: token,
        pin,
        selfie: selfieData,
        latitude: loc?.lat ?? null,
        longitude: loc?.lng ?? null,
        faceDescriptor,
      });
      setResult({
        action: r.action,
        associateName: r.associateName,
        at: r.at,
      });
      setStage('result');
      window.setTimeout(reset, 4000);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Network error.';
      setError(msg);
      setStage('error');
      window.setTimeout(reset, 3000);
    }
  };

  if (stage === 'setup') {
    return <SetupScreen onSaved={(t) => { setToken(t); setStage('idle'); }} />;
  }

  return (
    <div className="fixed inset-0 bg-midnight text-white flex flex-col items-center justify-center select-none">
      {stage === 'idle' && (
        <IdleScreen
          now={now}
          onTap={() => {
            // Warm up face-api models in the background while the user
            // taps in their PIN — usually fully loaded by the time the
            // selfie stage opens.
            void loadFaceModels().catch(() => {
              /* ignore — face match becomes optional */
            });
            setStage('pin');
          }}
        />
      )}
      {stage === 'pin' && (
        <PinPad
          pin={pin}
          onChange={setPin}
          onSubmit={() => setStage('selfie')}
          onCancel={reset}
        />
      )}
      {stage === 'selfie' && (
        <SelfieCapture
          onCaptured={(data, descriptor) => void submit(data, descriptor)}
          onSkip={() => void submit(null, null)}
          onCancel={reset}
        />
      )}
      {stage === 'result' && result && <ResultScreen result={result} />}
      {stage === 'error' && (
        <div className="text-center">
          <div className="text-6xl mb-6">⚠️</div>
          <div className="text-3xl text-red-400">{error}</div>
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
  const onSave = () => {
    const t = val.trim();
    if (!t.startsWith('altokiosk_')) {
      alert('Token should start with altokiosk_');
      return;
    }
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, t);
      onSaved(t);
    } catch {
      alert('Could not save token. Check browser storage settings.');
    }
  };
  return (
    <div className="fixed inset-0 bg-midnight text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-navy-secondary border border-navy-secondary rounded-2xl p-8 shadow-2xl">
        <div className="text-cyan-400 text-sm uppercase tracking-widest mb-2">
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
          onChange={(e) => setVal(e.target.value)}
          placeholder="altokiosk_..."
          autoFocus
        />
        <button
          onClick={onSave}
          className="mt-4 w-full bg-cyan-600 hover:bg-cyan-500 transition rounded-md py-3 font-medium"
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
  return (
    <button
      onClick={onTap}
      className="w-full h-full flex flex-col items-center justify-center"
    >
      <div className="text-cyan-400 text-sm uppercase tracking-widest mb-4">
        Alto Kiosk
      </div>
      <div className="text-9xl font-serif font-light tracking-tight">{time}</div>
      <div className="text-2xl text-silver mt-3">{date}</div>
      <div className="mt-16 px-12 py-6 bg-cyan-600/20 border-2 border-cyan-500 rounded-full text-2xl font-medium animate-pulse">
        Tap to clock in / out
      </div>
    </button>
  );
}

function PinPad({
  pin,
  onChange,
  onSubmit,
  onCancel,
}: {
  pin: string;
  onChange: (p: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  // Auto-advance once 4 digits are entered.
  useEffect(() => {
    if (pin.length === 4) {
      const t = window.setTimeout(onSubmit, 150);
      return () => clearTimeout(t);
    }
  }, [pin, onSubmit]);

  const press = (d: string) => {
    if (pin.length < 4) onChange(pin + d);
  };
  const back = () => onChange(pin.slice(0, -1));

  return (
    <div className="flex flex-col items-center w-full max-w-sm px-4">
      <div className="text-2xl text-silver mb-6">Enter your 4-digit PIN</div>
      <div className="flex gap-4 mb-10">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-16 h-20 rounded-xl border-2 flex items-center justify-center text-4xl ${
              pin.length > i
                ? 'bg-cyan-500 border-cyan-400 text-navy-secondary'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver'
            }`}
          >
            {pin.length > i ? '•' : ''}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3 w-full">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            onClick={() => press(d)}
            className="aspect-square bg-navy-secondary hover:bg-navy-secondary/70 rounded-2xl text-4xl font-light transition active:scale-95"
          >
            {d}
          </button>
        ))}
        <button
          onClick={onCancel}
          className="aspect-square bg-navy-secondary/40 hover:bg-navy-secondary/70 rounded-2xl text-sm text-silver transition active:scale-95"
        >
          Cancel
        </button>
        <button
          onClick={() => press('0')}
          className="aspect-square bg-navy-secondary hover:bg-navy-secondary/70 rounded-2xl text-4xl font-light transition active:scale-95"
        >
          0
        </button>
        <button
          onClick={back}
          className="aspect-square bg-navy-secondary/40 hover:bg-navy-secondary/70 rounded-2xl text-2xl text-silver transition active:scale-95"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

function SelfieCapture({
  onCaptured,
  onSkip,
  onCancel,
}: {
  onCaptured: (dataUrl: string, descriptor: number[] | null) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

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
        // Auto-snap after 2 seconds (gives the user time to position).
        setCountdown(2);
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
      // Extract descriptor from the captured frame. Best-effort — if the
      // models didn't load (offline kiosk) or no face is found, we still
      // submit the punch with descriptor=null.
      setAnalyzing(true);
      (async () => {
        let descriptor: number[] | null = null;
        try {
          await loadFaceModels();
          descriptor = await extractDescriptor(c);
        } catch {
          /* swallow — face match is optional */
        }
        onCaptured(data, descriptor);
      })();
      return;
    }
    const t = window.setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, onCaptured]);

  if (streamErr) {
    return (
      <div className="text-center max-w-md px-4">
        <div className="text-2xl mb-4">Camera unavailable</div>
        <div className="text-silver text-sm mb-6">{streamErr}</div>
        <div className="flex gap-3 justify-center">
          <button
            onClick={onSkip}
            className="px-6 py-3 bg-cyan-600 hover:bg-cyan-500 rounded-md font-medium transition"
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
      <div className="text-xl text-silver mb-4">
        {analyzing ? 'Verifying…' : 'Smile for the camera'}
      </div>
      <div className="relative">
        <video
          ref={videoRef}
          className="w-96 h-72 rounded-2xl bg-black object-cover scale-x-[-1]"
          muted
          playsInline
        />
        {countdown !== null && countdown > 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-9xl font-bold text-white drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)]">
            {countdown}
          </div>
        )}
        {analyzing && (
          <div className="absolute inset-0 flex items-center justify-center bg-midnight/60 rounded-2xl">
            <div className="text-cyan-400 text-2xl animate-pulse">⋯</div>
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <button
        onClick={onCancel}
        className="mt-6 text-silver text-sm hover:text-white transition"
      >
        Cancel
      </button>
    </div>
  );
}

function ResultScreen({ result }: { result: PunchResult }) {
  const verb = result.action === 'CLOCK_IN' ? 'Clocked in' : 'Clocked out';
  const color = result.action === 'CLOCK_IN' ? 'text-emerald-400' : 'text-cyan-400';
  const time = new Date(result.at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <div className="text-center">
      <div className={`text-9xl mb-6 ${color}`}>✓</div>
      <div className="text-5xl font-serif mb-3">{verb}</div>
      <div className="text-3xl text-silver">{result.associateName}</div>
      <div className="text-xl text-silver mt-2">at {time}</div>
    </div>
  );
}

function ResetCorner({ onReset }: { onReset: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    const t = window.setTimeout(() => setCount(0), 800);
    return () => clearTimeout(t);
  }, [count]);
  return (
    <button
      aria-label="Settings"
      onClick={() => {
        const next = count + 1;
        if (next >= 3) {
          if (window.confirm('Unpair this kiosk and clear the device token?')) {
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
