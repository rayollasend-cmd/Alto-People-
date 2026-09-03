import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCw, ScanLine, Wand2 } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { Quad } from '@/lib/docScan';

/**
 * Document standardization step — every image heading into the document
 * vault passes through here, camera shot or file pick alike. The vault
 * and the I-9 verifier used to receive whatever pixels the phone
 * produced: sideways licenses, bedspread backgrounds, 8MB originals.
 * Now every document leaves as the same thing: a fixed-ratio,
 * fixed-size, margined, contrast-normalized color scan.
 *
 * Two paths to that output:
 *
 *  AUTO ("scan"): OpenCV (lazy wasm chunk — see lib/docScan.ts) finds
 *  the document's corners, the user confirms or drags the four handles
 *  (with a magnifier loupe), and the quad is perspective-corrected into
 *  a flat scan. The CamScanner experience.
 *
 *  MANUAL: the profile-photo-style drag/zoom against a fixed-ratio
 *  frame, plus 90° rotation. The always-available fallback — detection
 *  missed, wasm still downloading, or the user prefers hands-on.
 *
 * PDFs never come here — a PDF is already a document.
 */

export type DocShape = 'card' | 'passport' | 'letter';

interface ShapeSpec {
  /** width / height of the OUTPUT (including margins). */
  ratio: number;
  outW: number;
  labelKey: 'docscan.shapeCard' | 'docscan.shapePassport' | 'docscan.shapeLetter';
}

// ID-1 (licenses, SSN-style cards): 85.6 × 53.98 mm. ID-3 passport page:
// 125 × 88 mm. US Letter portrait: 8.5 × 11 in.
const SHAPES: Record<DocShape, ShapeSpec> = {
  card: { ratio: 85.6 / 53.98, outW: 1280, labelKey: 'docscan.shapeCard' },
  passport: { ratio: 125 / 88, outW: 1280, labelKey: 'docscan.shapePassport' },
  letter: { ratio: 8.5 / 11, outW: 1700, labelKey: 'docscan.shapeLetter' },
};

const OUTPUT_QUALITY = 0.87;
/** Uniform white margin around the document, as a fraction of width. */
const MARGIN_FRAC = 0.025;
/** Refuse manual crops that would upscale the source more than this. */
const MAX_UPSCALE = 2;
const MAX_ZOOM_FACTOR = 5;
/** Contain-fit box for the auto-mode corner editor. */
const EDIT_MAX_W = 320;
const EDIT_MAX_H = 340;
const LOUPE_SIZE = 96;
const LOUPE_ZOOM = 3;

/** Infer the crop shape for a document. */
export function shapeForDocument(opts: {
  card?: boolean;
  title?: string | null;
  kind?: string | null;
}): DocShape {
  if (opts.card) return 'card';
  const t = (opts.title ?? '').toLowerCase();
  if (t.includes('passport')) return 'passport';
  if (opts.kind === 'ID' || opts.kind === 'SSN_CARD') return 'card';
  return 'letter';
}

/** Color-safe contrast stretch: same linear map on all channels, anchored
 *  on the 2nd/98th luma percentiles. Turns a dim kitchen-table photo into
 *  something that reads as a scan without shifting hues. */
function scanEnhance(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000;
    hist[Math.min(255, Math.round(y))]++;
  }
  const total = w * h;
  let lo = 0;
  let acc = 0;
  while (lo < 255 && acc < total * 0.02) acc += hist[lo++]!;
  let hi = 255;
  acc = 0;
  while (hi > 0 && acc < total * 0.02) acc += hist[hi--]!;
  if (hi - lo < 24) return; // nearly flat already (or pathological) — skip
  const scale = 255 / (hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, (v - lo) * scale));
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]!]!;
    d[i + 1] = lut[d[i + 1]!]!;
    d[i + 2] = lut[d[i + 2]!]!;
  }
  ctx.putImageData(img, 0, 0);
}

/** Bake `img` onto a canvas (full resolution, no rotation). */
function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return c;
}

export function DocumentCropDialog({
  file,
  initialShape,
  onCancel,
  onCropped,
}: {
  /** Picked or captured source image. The dialog owns its object URL. */
  file: File | Blob;
  initialShape: DocShape;
  onCancel: () => void;
  /** Receives the standardized document as a JPEG file. */
  onCropped: (file: File) => void;
}) {
  const { t } = useI18n();
  const [shape, setShape] = useState<DocShape>(initialShape);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [enhance, setEnhance] = useState(true);
  const [exporting, setExporting] = useState(false);

  // ---- scan (auto) state --------------------------------------------------
  const [mode, setMode] = useState<'detecting' | 'auto' | 'manual'>('detecting');
  const [quad, setQuad] = useState<Quad | null>(null);
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);

  // ---- manual state ---------------------------------------------------
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [k, setK] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setLoadError(true);
    el.src = url;
  }, [url]);

  const sourceCanvas = useMemo(() => (img ? imageToCanvas(img) : null), [img]);

  // Kick off detection once the image is in. Failure of any kind — wasm
  // unavailable, nothing found, low contrast — quietly lands in manual.
  useEffect(() => {
    if (!sourceCanvas) return;
    let cancelled = false;
    (async () => {
      try {
        const scan = await import('@/lib/docScan');
        const found = await scan.detectDocumentQuad(sourceCanvas);
        if (cancelled) return;
        if (found) {
          setQuad(found);
          setMode('auto');
        } else {
          setMode('manual');
        }
      } catch {
        if (!cancelled) setMode('manual');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceCanvas]);

  const spec = SHAPES[shape];

  /* =====================  AUTO (corner editor)  ===================== */

  const editFit = useMemo(() => {
    if (!img) return null;
    const s = Math.min(
      EDIT_MAX_W / img.naturalWidth,
      EDIT_MAX_H / img.naturalHeight,
      1,
    );
    return {
      scale: s,
      w: Math.round(img.naturalWidth * s),
      h: Math.round(img.naturalHeight * s),
    };
  }, [img]);

  const cornerDrag = (index: number) => (e: React.PointerEvent) => {
    if (!editFit || !img) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setActiveCorner(index);
    const box = (e.currentTarget as HTMLElement)
      .closest('[data-quad-editor]')!
      .getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const x = Math.min(
        img.naturalWidth,
        Math.max(0, (ev.clientX - box.left) / editFit.scale),
      );
      const y = Math.min(
        img.naturalHeight,
        Math.max(0, (ev.clientY - box.top) / editFit.scale),
      );
      setQuad((q) => {
        if (!q) return q;
        const next = [...q] as Quad;
        next[index] = { x, y };
        return next;
      });
    };
    const up = () => {
      setActiveCorner(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Magnifier loupe — a 3× zoom around the corner being dragged, so a
  // thumb isn't covering the exact pixel being placed.
  useEffect(() => {
    const c = loupeRef.current;
    if (!c || activeCorner === null || !quad || !sourceCanvas) return;
    const p = quad[activeCorner]!;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const srcSpan = LOUPE_SIZE / LOUPE_ZOOM;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.drawImage(
      sourceCanvas,
      p.x - srcSpan / 2,
      p.y - srcSpan / 2,
      srcSpan,
      srcSpan,
      0,
      0,
      LOUPE_SIZE,
      LOUPE_SIZE,
    );
    // Crosshair.
    ctx.strokeStyle = 'rgba(255, 200, 80, 0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE_SIZE / 2, 0);
    ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
    ctx.moveTo(0, LOUPE_SIZE / 2);
    ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
    ctx.stroke();
  }, [activeCorner, quad, sourceCanvas]);

  const finishExport = (canvas: HTMLCanvasElement) => {
    canvas.toBlob(
      (blob) => {
        setExporting(false);
        if (!blob) return;
        onCropped(
          new File([blob], `document-${Date.now()}.jpg`, { type: 'image/jpeg' }),
        );
      },
      'image/jpeg',
      OUTPUT_QUALITY,
    );
  };

  const exportAuto = async () => {
    if (!sourceCanvas || !quad || exporting) return;
    setExporting(true);
    try {
      const scan = await import('@/lib/docScan');
      const outW = spec.outW;
      const outH = Math.round(outW / spec.ratio);
      const margin = Math.round(outW * MARGIN_FRAC);
      const doc = await scan.warpQuadToCanvas(
        sourceCanvas,
        quad,
        outW - margin * 2,
        outH - margin * 2,
      );
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setExporting(false);
        return;
      }
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(doc, margin, margin);
      if (enhance) {
        try {
          scanEnhance(ctx, outW, outH);
        } catch {
          /* cosmetic only */
        }
      }
      finishExport(canvas);
    } catch {
      // Warp failed — fall back to manual rather than dead-ending.
      setExporting(false);
      setMode('manual');
    }
  };

  /* =====================  MANUAL (frame crop)  ====================== */

  // Rotation is applied by re-baking the source onto an offscreen canvas;
  // all pan/zoom math then works on the rotated pixels.
  const rotated = useMemo(() => {
    if (!img) return null;
    const swap = rotation === 90 || rotation === 270;
    const c = document.createElement('canvas');
    c.width = swap ? img.naturalHeight : img.naturalWidth;
    c.height = swap ? img.naturalWidth : img.naturalHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return { canvas: c, url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height };
  }, [img, rotation]);

  const VIEW_W = 320;
  const viewH = Math.round(VIEW_W / spec.ratio);
  const kMin = rotated ? Math.max(VIEW_W / rotated.w, viewH / rotated.h) : 1;

  useEffect(() => {
    if (!rotated) return;
    setK(kMin);
    setOffset({
      x: (VIEW_W - rotated.w * kMin) / 2,
      y: (viewH - rotated.h * kMin) / 2,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotated, shape]);

  const clamp = (o: { x: number; y: number }, scale: number) => {
    if (!rotated) return o;
    return {
      x: Math.min(0, Math.max(VIEW_W - rotated.w * scale, o.x)),
      y: Math.min(0, Math.max(viewH - rotated.h * scale, o.y)),
    };
  };

  const setZoom = (next: number) => {
    if (!rotated) return;
    const nk = Math.min(kMin * MAX_ZOOM_FACTOR, Math.max(kMin, next));
    const cx = VIEW_W / 2;
    const cy = viewH / 2;
    setOffset((o) =>
      clamp({ x: cx - ((cx - o.x) / k) * nk, y: cy - ((cy - o.y) / k) * nk }, nk),
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
    setOffset(clamp({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, k));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: React.WheelEvent) => setZoom(k * (e.deltaY < 0 ? 1.08 : 1 / 1.08));

  const srcRegionW = VIEW_W / k;
  const tooSmall =
    mode === 'manual' && rotated ? srcRegionW * MAX_UPSCALE < spec.outW : false;

  const exportManual = () => {
    if (!rotated || exporting || tooSmall) return;
    setExporting(true);
    const outW = spec.outW;
    const outH = Math.round(outW / spec.ratio);
    const margin = Math.round(outW * MARGIN_FRAC);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setExporting(false);
      return;
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      rotated.canvas,
      -offset.x / k,
      -offset.y / k,
      VIEW_W / k,
      viewH / k,
      margin,
      margin,
      outW - margin * 2,
      outH - margin * 2,
    );
    if (enhance) {
      try {
        scanEnhance(ctx, outW, outH);
      } catch {
        /* cosmetic only */
      }
    }
    finishExport(canvas);
  };

  /* ==========================  render  ============================== */

  const shapePicker = (
    <div className="flex gap-2">
      {(Object.keys(SHAPES) as DocShape[]).map((s) => (
        <Button
          key={s}
          type="button"
          size="sm"
          variant={s === shape ? 'secondary' : 'ghost'}
          className={s === shape ? 'border-gold/60 bg-gold/15 text-white' : ''}
          onClick={() => setShape(s)}
        >
          {t(SHAPES[s].labelKey)}
        </Button>
      ))}
    </div>
  );

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'auto' ? t('docscan.autoTitle') : t('docscan.title')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'auto' ? t('docscan.autoSubtitle') : t('docscan.subtitle')}
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <div className="text-sm text-alert">{t('docscan.badImage')}</div>
        ) : mode === 'detecting' ? (
          <div className="grid place-items-center gap-3 py-10 text-silver">
            <ScanLine className="h-8 w-8 animate-pulse text-gold" aria-hidden="true" />
            <div className="text-sm">{t('docscan.detecting')}</div>
          </div>
        ) : mode === 'auto' && img && editFit && quad ? (
          <div className="grid gap-3 justify-items-center">
            {shapePicker}
            <div
              data-quad-editor
              className="relative select-none touch-none rounded-md overflow-hidden bg-black"
              style={{ width: editFit.w, height: editFit.h }}
            >
              <img
                src={url}
                alt=""
                draggable={false}
                className="absolute inset-0 h-full w-full pointer-events-none"
              />
              <svg
                className="absolute inset-0 h-full w-full pointer-events-none"
                viewBox={`0 0 ${editFit.w} ${editFit.h}`}
              >
                {/* Dim everything OUTSIDE the detected document. */}
                <path
                  fillRule="evenodd"
                  fill="rgba(6,10,25,0.55)"
                  d={`M0 0H${editFit.w}V${editFit.h}H0Z M${quad
                    .map((p) => `${p.x * editFit.scale} ${p.y * editFit.scale}`)
                    .join(' L')} Z`}
                />
                <polygon
                  points={quad
                    .map((p) => `${p.x * editFit.scale},${p.y * editFit.scale}`)
                    .join(' ')}
                  fill="none"
                  stroke="rgb(212, 175, 55)"
                  strokeWidth={2}
                />
              </svg>
              {quad.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onPointerDown={cornerDrag(i)}
                  aria-label={t('docscan.corner')}
                  className="absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-gold bg-navy/80 shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  style={{
                    left: p.x * editFit.scale,
                    top: p.y * editFit.scale,
                  }}
                />
              ))}
              {activeCorner !== null && (
                <canvas
                  ref={loupeRef}
                  width={LOUPE_SIZE}
                  height={LOUPE_SIZE}
                  className="absolute right-2 top-2 rounded-full border-2 border-gold shadow-lg"
                  aria-hidden="true"
                />
              )}
            </div>
            <p className="text-xs text-silver text-center max-w-[320px]">
              {t('docscan.dragCorners')}
            </p>
            <label className="flex items-center gap-2 text-xs text-silver select-none">
              <input
                type="checkbox"
                checked={enhance}
                onChange={(e) => setEnhance(e.target.checked)}
              />
              {t('docscan.enhance')}
            </label>
          </div>
        ) : (
          <div className="grid gap-3 justify-items-center">
            {shapePicker}
            <div
              className="relative overflow-hidden rounded-md border-2 border-gold/60 bg-navy-secondary/40 touch-none cursor-grab active:cursor-grabbing select-none"
              style={{ width: VIEW_W, height: viewH }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            >
              {rotated && (
                <img
                  src={rotated.url}
                  alt=""
                  draggable={false}
                  className="absolute left-0 top-0 max-w-none origin-top-left pointer-events-none"
                  style={{
                    width: rotated.w * k,
                    height: rotated.h * k,
                    transform: `translate(${offset.x}px, ${offset.y}px)`,
                  }}
                />
              )}
            </div>
            {tooSmall && (
              <p role="alert" className="text-xs text-alert text-center max-w-[320px]">
                {t('docscan.tooSmall')}
              </p>
            )}
            <div className="flex w-full max-w-[320px] items-center gap-3">
              <input
                type="range"
                aria-label={t('docscan.zoom')}
                className="flex-1 accent-gold"
                min={kMin}
                max={kMin * MAX_ZOOM_FACTOR}
                step={kMin / 50}
                value={k}
                onChange={(e) => setZoom(Number(e.target.value))}
                disabled={!rotated}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRotation((r) => ((r + 90) % 360) as 0 | 90 | 180 | 270)}
                aria-label={t('docscan.rotate')}
              >
                <RotateCw className="h-4 w-4" />
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-silver select-none">
              <input
                type="checkbox"
                checked={enhance}
                onChange={(e) => setEnhance(e.target.checked)}
              />
              {t('docscan.enhance')}
            </label>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {mode === 'auto' && (
            <Button type="button" variant="outline" onClick={() => setMode('manual')}>
              {t('docscan.adjustManually')}
            </Button>
          )}
          {mode === 'manual' && quad && (
            <Button type="button" variant="outline" onClick={() => setMode('auto')}>
              <Wand2 className="h-4 w-4" />
              {t('docscan.backToAuto')}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => (mode === 'auto' ? void exportAuto() : exportManual())}
            disabled={
              loadError ||
              exporting ||
              mode === 'detecting' ||
              (mode === 'auto' ? !quad : !rotated || tooSmall)
            }
          >
            {exporting
              ? t('docscan.saving')
              : mode === 'auto'
                ? t('docscan.scan')
                : t('docscan.use')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
