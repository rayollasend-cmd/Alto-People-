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
 * the first time someone reaches the selfie step.
 *
 * Weights are self-hosted first: `/face-models` (populated by the
 * best-effort `prebuild` fetch script) is tried by default, with
 * VITE_FACE_MODELS_URL as an override for a different path/CDN. jsDelivr
 * stays as the runtime fallback ONLY — if the self-hosted weights are
 * missing (the build ran without outbound network), tablets silently
 * fall back rather than breaking. Same-origin-first matters here: these
 * are the ML weights for a biometric feature, and store tablets
 * shouldn't depend on a public CDN at punch time.
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
  // Same-origin `/face-models` is the default source (populated by the
  // best-effort prebuild fetch); VITE_FACE_MODELS_URL overrides it. A
  // missing manifest makes loadFromUri reject, which we catch and retry
  // against jsDelivr — so a build that couldn't reach the CDN degrades
  // to the old behavior instead of breaking the kiosk.
  const selfHost =
    (import.meta.env.VITE_FACE_MODELS_URL as string | undefined)?.trim() ||
    '/face-models';
  setModelsState('loading');
  modelsPromise = (async () => {
    const faceapi = await getFaceApi();
    try {
      await loadAllFrom(faceapi, selfHost);
      setModelsState('ready');
      return;
    } catch {
      /* self-hosted weights missing/unreachable — fall back to CDN */
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
