import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Nfc, ScanQrCode, X } from 'lucide-react';
import { isNative } from '@/lib/native/platform';
import { NfcError, nfcAvailability, readBadge } from '@/lib/native/nfc';
import { hapticConfirm, hapticError } from '@/lib/haptics';
import { cn } from '@/lib/cn';

/**
 * Clock in with a badge instead of the number: tap an NFC badge (the kiosk
 * running in the native app) or show the badge QR — on a Wallet pass or the
 * app's "Show badge" — to the camera (any kiosk whose browser can read QR
 * codes). Every moment is said plainly: ready, reading, read, and when it
 * doesn't work, what to do instead (the number always works).
 */

export interface BadgeReaderStrings {
  tapBadge: string;
  scanBadge: string;
  badgeHold: string;
  badgeHoldCamera: string;
  badgeReading: string;
  badgeRead: string;
  nfcOff: string;
  badgeTimeout: string;
  notABadge: string;
  cameraBlocked: string;
  orTypeNumber: string;
  cancel: string;
}

type Mode = 'idle' | 'nfc' | 'camera' | 'read';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

function qrSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

const BADGE_PREFIX = 'altob1.';

export function BadgeReader({ t, onBadge, disabled }: { t: BadgeReaderStrings; onBadge: (token: string) => void; disabled?: boolean }) {
  const [nfc, setNfc] = useState<'ready' | 'disabled' | 'unsupported'>('unsupported');
  const [mode, setMode] = useState<Mode>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (isNative()) void nfcAvailability().then(setNfc);
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  };
  useEffect(() => () => stopCamera(), []);

  const succeed = (token: string) => {
    hapticConfirm();
    setMode('read');
    setMessage(null);
    stopCamera();
    // A beat on "Badge read" so the person sees it worked, then the punch flow.
    window.setTimeout(() => {
      setMode('idle');
      onBadge(token);
    }, 450);
  };
  const fail = (text: string) => {
    hapticError();
    stopCamera();
    setMode('idle');
    setMessage(text);
  };

  const tap = async () => {
    setMessage(null);
    setMode('nfc');
    cancelled.current = false;
    try {
      const token = await readBadge({ prompt: t.badgeHold });
      if (!cancelled.current) succeed(token);
    } catch (err) {
      if (cancelled.current) return;
      const code = err instanceof NfcError ? err.code : 'unsupported';
      if (code === 'cancelled') {
        setMode('idle');
        return;
      }
      fail(code === 'timeout' ? t.badgeTimeout : code === 'not_a_badge' ? t.notABadge : t.nfcOff);
    }
  };

  const scan = async () => {
    setMessage(null);
    setMode('camera');
    cancelled.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
      const detector = new Detector({ formats: ['qr_code'] });
      const started = Date.now();
      const tick = async () => {
        if (cancelled.current || !streamRef.current) return;
        try {
          const codes = await detector.detect(video);
          const hit = codes.map((c) => c.rawValue.trim()).find((v) => v.startsWith(BADGE_PREFIX));
          if (hit) return succeed(hit);
          if (codes.length > 0 && !hit) return fail(t.notABadge);
        } catch {
          /* a frame that couldn't be read — keep going */
        }
        if (Date.now() - started > 30_000) return fail(t.badgeTimeout);
        window.setTimeout(() => void tick(), 250);
      };
      void tick();
    } catch {
      fail(t.cameraBlocked);
    }
  };

  const cancel = () => {
    cancelled.current = true;
    stopCamera();
    setMode('idle');
  };

  const canTap = nfc === 'ready';
  const canScan = qrSupported();
  if (!canTap && !canScan && !message) return null;

  return (
    <div className="mt-2 flex w-full max-w-sm flex-col items-center px-4">
      {mode === 'idle' && (canTap || canScan) && (
        <>
          <div className="mb-3 flex w-full items-center gap-3 text-xs uppercase tracking-widest text-ink-muted">
            <span className="h-px flex-1 bg-line" />
            {t.orTypeNumber}
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="flex w-full gap-3">
            {canTap && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void tap()}
                className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-surface-raised text-base font-medium text-ink transition-colors hover:border-accent disabled:opacity-50"
              >
                <Nfc className="h-5 w-5 text-accent" aria-hidden="true" />
                {t.tapBadge}
              </button>
            )}
            {canScan && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void scan()}
                className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-surface-raised text-base font-medium text-ink transition-colors hover:border-accent disabled:opacity-50"
              >
                <ScanQrCode className="h-5 w-5 text-accent" aria-hidden="true" />
                {t.scanBadge}
              </button>
            )}
          </div>
        </>
      )}

      {mode === 'nfc' && (
        <div className="flex w-full flex-col items-center gap-4 overflow-hidden rounded-2xl border border-accent/50 bg-surface-raised p-6" role="status" aria-live="polite">
          <span className="relative grid h-20 w-20 place-items-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-accent/20" aria-hidden="true" />
            <span className="relative grid h-20 w-20 place-items-center rounded-full bg-accent/15">
              <Nfc className="h-10 w-10 text-accent" aria-hidden="true" />
            </span>
          </span>
          <div className="text-center text-lg text-ink">{t.badgeHold}</div>
          <button type="button" onClick={cancel} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
            <X className="h-4 w-4" aria-hidden="true" />
            {t.cancel}
          </button>
        </div>
      )}

      {mode === 'camera' && (
        <div className="flex w-full flex-col items-center gap-3 rounded-2xl border border-accent/50 bg-surface-raised p-4" role="status" aria-live="polite">
          <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} className="h-full w-full -scale-x-100 object-cover" muted playsInline />
            <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-4 border-accent/80" aria-hidden="true" />
          </div>
          <div className="text-center text-base text-ink">{t.badgeHoldCamera}</div>
          <button type="button" onClick={cancel} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
            <X className="h-4 w-4" aria-hidden="true" />
            {t.cancel}
          </button>
        </div>
      )}

      {mode === 'read' && (
        <div className="flex items-center gap-2 py-4 text-lg text-success" role="status" aria-live="polite">
          <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
          {t.badgeRead}
        </div>
      )}

      {message && mode === 'idle' && (
        <p className={cn('mt-3 text-center text-base font-medium text-alert')} role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
