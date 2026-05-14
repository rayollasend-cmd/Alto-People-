import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RotateCcw, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Document camera capture. Opens the user's webcam / phone camera via
 * getUserMedia, shows a live preview, snapshots to a canvas on capture,
 * and hands the result back to the parent as a File for upload.
 *
 * Used by in-person onboarding (admin scans an associate's ID with the
 * laptop webcam) and the associate's mobile camera for self-service
 * document upload.
 *
 * Defaults to the back camera (`facingMode: 'environment'`) since the
 * primary use case is photographing a physical document held in front
 * of the device. Mirror the preview ourselves only when `mirror` is set
 * — for documents we want a true (un-mirrored) view so the operator
 * sees the doc as it actually reads.
 *
 * Two completion paths:
 *   - `onCapture(file)` — user clicks the Use-this-photo button.
 *     Parent uploads.
 *   - `onCancel()` — user backs out.
 */

interface DocumentCaptureProps {
  /** Filename stem (will get `-<timestamp>.jpg` appended). */
  filenameBase?: string;
  /** Preferred camera: 'environment' (rear, default) or 'user' (front). */
  facingMode?: 'environment' | 'user';
  /** Mirror the preview horizontally. Off by default for documents. */
  mirror?: boolean;
  onCapture: (file: File) => void;
  onCancel?: () => void;
}

export function DocumentCapture({
  filenameBase = 'scan',
  facingMode = 'environment',
  mirror = false,
  onCapture,
  onCancel,
}: DocumentCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  // Open the camera on mount. Falls back from 'environment' (rear) to
  // 'user' (front / webcam) if the rear camera isn't available — most
  // laptops only have the front-facing webcam and would otherwise fail
  // outright. Tear down the stream on unmount so the indicator light
  // turns off the moment the dialog closes.
  useEffect(() => {
    let cancelled = false;
    async function open() {
      setStarting(true);
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        }).catch(async (err) => {
          // OverconstrainedError when the requested facingMode isn't
          // available — retry without the constraint so a webcam still
          // works.
          if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
            return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          }
          throw err;
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play();
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : 'Camera unavailable. Check browser permissions.',
        );
      } finally {
        if (!cancelled) setStarting(false);
      }
    }
    void open();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facingMode]);

  const capture = useCallback(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // Mirroring is an aesthetic choice for the live preview; the
    // captured snapshot is always un-mirrored so a document scan reads
    // correctly when downloaded later.
    ctx.drawImage(v, 0, 0);
    const url = c.toDataURL('image/jpeg', 0.92);
    setSnapshot(url);
  }, []);

  const retake = useCallback(() => setSnapshot(null), []);

  const upload = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !snapshot) return;
    c.toBlob(
      (blob) => {
        if (!blob) {
          setError('Capture failed — try again.');
          return;
        }
        const filename = `${filenameBase}-${Date.now()}.jpg`;
        const file = new File([blob], filename, { type: 'image/jpeg' });
        onCapture(file);
      },
      'image/jpeg',
      0.92,
    );
  }, [snapshot, filenameBase, onCapture]);

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-md border border-alert/40 bg-alert/[0.06] p-4 text-sm">
          <div className="text-alert font-medium mb-1">Camera unavailable</div>
          <div className="text-silver">{error}</div>
        </div>
      ) : (
        <div className="relative bg-black rounded-md overflow-hidden aspect-video">
          {/* The video element is always mounted so capture() can read
              from it; we hide it when a snapshot is showing so the
              preview doesn't double up under a still frame. */}
          <video
            ref={videoRef}
            className={cn(
              'w-full h-full object-cover',
              mirror && 'scale-x-[-1]',
              snapshot && 'opacity-0',
            )}
            muted
            playsInline
          />
          {snapshot && (
            <img
              src={snapshot}
              alt="Captured document preview"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
          {starting && (
            <div className="absolute inset-0 grid place-items-center text-silver text-sm">
              Opening camera…
            </div>
          )}
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />

      {!error && (
        <div className="flex items-center justify-between gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              <X className="h-4 w-4" />
              Cancel
            </Button>
          )}
          <div className="flex items-center gap-2 ml-auto">
            {snapshot ? (
              <>
                <Button variant="secondary" onClick={retake}>
                  <RotateCcw className="h-4 w-4" />
                  Retake
                </Button>
                <Button onClick={upload}>
                  <Upload className="h-4 w-4" />
                  Use this photo
                </Button>
              </>
            ) : (
              <Button onClick={capture} disabled={starting}>
                <Camera className="h-4 w-4" />
                Capture
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
