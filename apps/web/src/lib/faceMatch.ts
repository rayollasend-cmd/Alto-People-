/**
 * Phase 101 — Face descriptor extraction in the browser via face-api.js.
 *
 * face-api.js needs three model files (~6.5MB total) to compute a 128-dim
 * descriptor:
 *   - tiny_face_detector_model      (~190KB)  — lightweight face box
 *   - face_landmark_68_model        (~350KB)  — 68 facial landmarks
 *   - face_recognition_model        (~6MB)    — descriptor net
 *
 * The library itself (~250KB minified) is also lazy-loaded via dynamic
 * import — the kiosk shell paints instantly, and face-api downloads
 * the first time someone reaches the selfie step. Default models URL
 * is jsDelivr; set VITE_FACE_MODELS_URL to override (e.g. `/face-models`
 * after running `npm run build:face-models` for self-hosting).
 *
 * Self-hosting plan (deferred): the build:face-models script pulls
 * the weight files into apps/web/public/face-models/. Switching the
 * default URL to `/face-models` should wait until Railway's build
 * reliably runs it — an earlier attempt to wire it in as `prebuild`
 * broke the web build because Railway couldn't always reach jsDelivr
 * at build time. Keep the runtime fallback on jsDelivr so a kiosk
 * tablet doesn't break the day Railway's outbound hiccups.
 */

const DEFAULT_MODELS_URL =
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';

type FaceApi = typeof import('face-api.js');

let faceApiPromise: Promise<FaceApi> | null = null;

function getFaceApi(): Promise<FaceApi> {
  if (!faceApiPromise) {
    faceApiPromise = import('face-api.js').catch((err) => {
      faceApiPromise = null;
      throw err;
    });
  }
  return faceApiPromise;
}

let modelsPromise: Promise<void> | null = null;

export function loadFaceModels(): Promise<void> {
  if (modelsPromise) return modelsPromise;
  const url =
    (import.meta.env.VITE_FACE_MODELS_URL as string | undefined)?.trim() ||
    DEFAULT_MODELS_URL;
  modelsPromise = (async () => {
    const faceapi = await getFaceApi();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(url),
      faceapi.nets.faceLandmark68Net.loadFromUri(url),
      faceapi.nets.faceRecognitionNet.loadFromUri(url),
    ]);
  })().catch((err) => {
    // Reset so the next attempt retries (e.g., user reconnects to wifi).
    modelsPromise = null;
    throw err;
  });
  return modelsPromise;
}

/**
 * Extract a 128-float descriptor from a video frame. Returns null if no
 * face is detected (out of frame, too dark, masked). Callers should treat
 * null as "skip face match" — never as a punch failure.
 */
export async function extractDescriptor(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
): Promise<number[] | null> {
  const faceapi = await getFaceApi();
  const result = await faceapi
    .detectSingleFace(source, new faceapi.TinyFaceDetectorOptions({
      // Higher threshold = fewer false detections of door frames / posters.
      scoreThreshold: 0.5,
      inputSize: 320,
    }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!result) return null;
  return Array.from(result.descriptor);
}
