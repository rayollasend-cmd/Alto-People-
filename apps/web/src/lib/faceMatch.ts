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

/**
 * Coarse load-state for the face-api models. Surfaces in the kiosk
 * idle screen so an associate landing during a slow CDN fetch sees
 * "Loading face match…" instead of a silent eight-second wait.
 *
 * - 'idle'    — preload hasn't been called yet.
 * - 'loading' — models are downloading.
 * - 'ready'   — all three models loaded.
 * - 'failed'  — last preload threw; safe to retry.
 */
export type FaceModelsState = 'idle' | 'loading' | 'ready' | 'failed';

let modelsState: FaceModelsState = 'idle';
const stateListeners = new Set<(s: FaceModelsState) => void>();

function setModelsState(s: FaceModelsState): void {
  if (s === modelsState) return;
  modelsState = s;
  for (const l of stateListeners) l(s);
}

export function getFaceModelsState(): FaceModelsState {
  return modelsState;
}

/**
 * Subscribe to load-state transitions. Returns an unsubscribe.
 */
export function onFaceModelsStateChange(
  fn: (s: FaceModelsState) => void,
): () => void {
  stateListeners.add(fn);
  return () => {
    stateListeners.delete(fn);
  };
}

async function loadAllFrom(faceapi: FaceApi, url: string): Promise<void> {
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(url),
    faceapi.nets.faceLandmark68Net.loadFromUri(url),
    faceapi.nets.faceRecognitionNet.loadFromUri(url),
  ]);
}

export function loadFaceModels(): Promise<void> {
  if (modelsPromise) return modelsPromise;
  // Prefer a self-hosted weights dir when configured (set
  // VITE_FACE_MODELS_URL=/face-models after `npm run build:face-models`).
  // Self-hosting avoids the ~6.5MB jsDelivr fetch (and its re-fetches when
  // the tablet cache is evicted), but we fall back to the CDN if the
  // self-hosted files aren't deployed — a missing manifest makes
  // loadFromUri reject, which we catch and retry against jsDelivr. This is
  // less latency-critical now that descriptor extraction runs off the
  // punch's critical path, but a faster, more reliable model load still
  // means the fraud signal attaches sooner.
  const selfHost = (import.meta.env.VITE_FACE_MODELS_URL as string | undefined)?.trim();
  setModelsState('loading');
  modelsPromise = (async () => {
    const faceapi = await getFaceApi();
    if (selfHost) {
      try {
        await loadAllFrom(faceapi, selfHost);
        setModelsState('ready');
        return;
      } catch {
        /* self-hosted weights missing/unreachable — fall back to CDN */
      }
    }
    await loadAllFrom(faceapi, DEFAULT_MODELS_URL);
    setModelsState('ready');
  })().catch((err) => {
    // Reset so the next attempt retries (e.g., user reconnects to wifi).
    modelsPromise = null;
    setModelsState('failed');
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
