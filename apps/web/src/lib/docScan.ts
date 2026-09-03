import cv from '@techstark/opencv-js';

/**
 * Document scanning engine — OpenCV (WebAssembly) behind a tiny facade.
 *
 * IMPORT RULE: never import this module statically from a component.
 * Always `await import('@/lib/docScan')` — the OpenCV wasm chunk is
 * ~10MB raw (~2.5MB over the wire) and must load lazily, only on the
 * scan surfaces, exactly like the kiosk's face-api chunk. Vite splits
 * it automatically as long as every import is dynamic.
 *
 * Capabilities:
 *   - detectDocumentQuad(): find the document's four corners in a photo
 *     (edge detection → contours → largest convex quadrilateral).
 *   - warpQuadToCanvas(): perspective-correct ("deskew") the quad into a
 *     flat rectangle, auto-choosing orientation to match a target ratio.
 *
 * Every cv.Mat is deleted on all paths — wasm memory never garbage
 * collects itself.
 */

export interface Point {
  x: number;
  y: number;
}
/** Corners ordered TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

let readyPromise: Promise<void> | null = null;

/** Resolves when the wasm runtime is initialized. Safe to call often. */
export function cvReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = new Promise<void>((resolve) => {
      // Depending on load timing, the runtime may already be up.
      if (typeof cv.Mat === 'function') {
        resolve();
        return;
      }
      cv.onRuntimeInitialized = () => resolve();
    });
  }
  return readyPromise;
}

/** Order 4 arbitrary corners as TL, TR, BR, BL. */
function orderQuad(pts: Point[]): Quad {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0]!;
  const br = bySum[3]!;
  const byDiff = [...pts].sort((a, b) => a.x - a.y - (b.x - b.y));
  const bl = byDiff[0]!;
  const tr = byDiff[3]!;
  return [tl, tr, br, bl];
}

function quadArea(q: Quad): number {
  // Shoelace.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Find the document quad in a canvas. Runs on a downscaled copy
 * (≤500px) for speed; returns corners in FULL-RESOLUTION coordinates,
 * or null when nothing document-like is found (low contrast, busy
 * background) — callers fall back to manual crop.
 */
export async function detectDocumentQuad(
  source: HTMLCanvasElement | HTMLVideoElement,
): Promise<Quad | null> {
  await cvReady();
  const srcW =
    source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const srcH =
    source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (!srcW || !srcH) return null;

  const MAX_DIM = 500;
  const scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);

  const src = cv.imread(work);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    // Dilation closes small gaps in the document border so the contour
    // reads as one closed shape.
    cv.dilate(edges, dilated, kernel);
    cv.findContours(
      dilated,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    let best: Quad | null = null;
    let bestArea = 0;
    const minArea = w * h * 0.12; // the document must dominate the photo
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const peri = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * peri, true);
      try {
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts: Point[] = [];
          for (let r = 0; r < 4; r++) {
            pts.push({
              x: approx.data32S[r * 2]!,
              y: approx.data32S[r * 2 + 1]!,
            });
          }
          const quad = orderQuad(pts);
          const area = quadArea(quad);
          if (area >= minArea && area > bestArea) {
            bestArea = area;
            best = quad;
          }
        }
      } finally {
        approx.delete();
        contour.delete();
      }
    }
    if (!best) return null;
    // Back to full-resolution coordinates.
    return best.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad;
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    dilated.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * Perspective-correct `quad` (full-res coords on `source`) into a flat
 * rectangle of exactly outW×outH. If the quad is oriented crosswise to
 * the target ratio (a landscape card photographed in a portrait photo),
 * it is warped to the transposed size and rotated 90° so the document
 * always comes out upright relative to its own long edge.
 */
export async function warpQuadToCanvas(
  source: HTMLCanvasElement,
  quad: Quad,
  outW: number,
  outH: number,
): Promise<HTMLCanvasElement> {
  await cvReady();
  const [tl, tr, br, bl] = quad;
  const topLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftLen = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightLen = Math.hypot(br.x - tr.x, br.y - tr.y);
  const quadW = (topLen + bottomLen) / 2;
  const quadH = (leftLen + rightLen) / 2;
  const quadLandscape = quadW >= quadH;
  const targetLandscape = outW >= outH;
  const crosswise = quadLandscape !== targetLandscape;
  const dstW = crosswise ? outH : outW;
  const dstH = crosswise ? outW : outH;

  const src = cv.imread(source);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, dstW, 0, dstW, dstH, 0, dstH,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const out = document.createElement('canvas');
  try {
    cv.warpPerspective(
      src,
      dst,
      M,
      new cv.Size(dstW, dstH),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
    out.width = dstW;
    out.height = dstH;
    cv.imshow(out, dst);
  } finally {
    src.delete();
    dst.delete();
    srcTri.delete();
    dstTri.delete();
    M.delete();
  }
  if (!crosswise) return out;
  // Rotate 90° so the long edges line up with the target orientation.
  const rotatedOut = document.createElement('canvas');
  rotatedOut.width = outW;
  rotatedOut.height = outH;
  const rctx = rotatedOut.getContext('2d');
  if (!rctx) return out;
  rctx.translate(outW / 2, outH / 2);
  rctx.rotate(Math.PI / 2);
  rctx.drawImage(out, -out.width / 2, -out.height / 2);
  return rotatedOut;
}
