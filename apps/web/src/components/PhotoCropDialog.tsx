import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';

/**
 * Square crop step for profile photos — the fix for "I uploaded a picture
 * and it shows my shoulder": raw uploads used to be stored verbatim and
 * blind-center-cropped by the round Avatar, so any portrait with the face
 * off-center displayed wrong everywhere, forever.
 *
 * Drag to position, slider (or wheel/pinch-scroll) to zoom, live circular
 * mask preview of exactly what every Avatar will show. Exports a 512×512
 * JPEG (~50–150KB) so the directory stops downloading multi-MB originals
 * into 32px circles. Pure canvas — no cropper dependency.
 */

const OUTPUT_SIZE = 512;
const OUTPUT_QUALITY = 0.85;
/** Display size of the square crop viewport, in CSS px. */
const VIEW = 288;
const MAX_ZOOM_FACTOR = 4;

export function PhotoCropDialog({
  file,
  onCancel,
  onCropped,
}: {
  /** The picked source image. The dialog owns its object URL lifecycle. */
  file: File;
  onCancel: () => void;
  /** Receives the cropped square as a JPEG blob. */
  onCropped: (blob: Blob) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  // k = CSS pixels per source pixel; offset = top-left of the scaled image
  // relative to the viewport (always <= 0 so the frame stays covered).
  const [k, setK] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [exporting, setExporting] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setLoadError(true);
    el.src = url;
  }, [url]);

  // Cover the viewport: the image may never be smaller than the frame in
  // either axis, so there's no way to crop in blank space.
  const kMin = img ? Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight) : 1;

  // Center the image at minimum zoom once it loads.
  useEffect(() => {
    if (!img) return;
    setK(kMin);
    setOffset({
      x: (VIEW - img.naturalWidth * kMin) / 2,
      y: (VIEW - img.naturalHeight * kMin) / 2,
    });
  }, [img, kMin]);

  const clamp = (o: { x: number; y: number }, scale: number) => {
    if (!img) return o;
    return {
      x: Math.min(0, Math.max(VIEW - img.naturalWidth * scale, o.x)),
      y: Math.min(0, Math.max(VIEW - img.naturalHeight * scale, o.y)),
    };
  };

  // Zoom around the viewport center so the subject stays put.
  const setZoom = (next: number) => {
    if (!img) return;
    const nk = Math.min(kMin * MAX_ZOOM_FACTOR, Math.max(kMin, next));
    const cx = VIEW / 2;
    const cy = VIEW / 2;
    setOffset((o) =>
      clamp(
        {
          x: cx - ((cx - o.x) / k) * nk,
          y: cy - ((cy - o.y) / k) * nk,
        },
        nk,
      ),
    );
    setK(nk);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const d = drag.current;
    setOffset(
      clamp({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, k),
    );
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    setZoom(k * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  };

  const exportCrop = () => {
    if (!img || exporting) return;
    setExporting(true);
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setExporting(false);
      return;
    }
    // JPEG has no alpha — flatten transparent PNGs onto white, not black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      img,
      -offset.x / k,
      -offset.y / k,
      VIEW / k,
      VIEW / k,
      0,
      0,
      OUTPUT_SIZE,
      OUTPUT_SIZE,
    );
    canvas.toBlob(
      (blob) => {
        setExporting(false);
        if (blob) onCropped(blob);
      },
      'image/jpeg',
      OUTPUT_QUALITY,
    );
  };

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Position your photo</DialogTitle>
          <DialogDescription>
            Drag to position, zoom until your face fills the circle — this is
            exactly how it will appear across the app.
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <div className="text-sm text-alert">
            That image couldn&rsquo;t be read — try a different file.
          </div>
        ) : (
          <div className="grid gap-4 justify-items-center">
            <div
              className="relative overflow-hidden rounded-md border border-navy-secondary bg-navy-secondary/40 touch-none cursor-grab active:cursor-grabbing select-none"
              style={{ width: VIEW, height: VIEW }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            >
              {img && (
                <img
                  src={url}
                  alt=""
                  draggable={false}
                  className="absolute left-0 top-0 max-w-none origin-top-left pointer-events-none"
                  style={{
                    width: img.naturalWidth * k,
                    height: img.naturalHeight * k,
                    transform: `translate(${offset.x}px, ${offset.y}px)`,
                  }}
                />
              )}
              {/* Circular mask — dim everything the round Avatar won't show. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'radial-gradient(circle at center, transparent 49.5%, rgba(6,10,25,0.65) 50%)',
                }}
              />
            </div>
            <input
              type="range"
              aria-label="Zoom"
              className="w-64 accent-gold"
              min={kMin}
              max={kMin * MAX_ZOOM_FACTOR}
              step={kMin / 50}
              value={k}
              onChange={(e) => setZoom(Number(e.target.value))}
              disabled={!img}
            />
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={exportCrop}
            disabled={!img || loadError || exporting}
          >
            {exporting ? 'Saving…' : 'Use photo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
