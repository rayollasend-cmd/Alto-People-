/**
 * Getting OpenCV into the page, under a CSP that forbids eval.
 *
 * Two builds can answer this, and they arrive differently:
 *
 *   - `/vendor/opencv/opencv.js` — our own build, compiled with
 *     `-s DYNAMIC_EXECUTION=0` so it generates no code at runtime. It is a
 *     classic UMD script, loaded with a <script> tag rather than imported,
 *     which keeps 11MB out of the JS bundle and avoids asking the bundler
 *     to interpret a UMD file. Same-origin, so `script-src 'self'` allows it.
 *   - the npm package — the fallback when that file isn't deployed. It
 *     cannot actually START under our CSP (that is the whole reason the
 *     vendored build exists), but keeping the path means the scanner
 *     degrades to manual cropping rather than throwing, and the package
 *     stays the source of TYPES either way.
 *
 * Both are Emscripten MODULARIZE output, where the export is a factory or
 * a promise rather than the namespace itself, so everything funnels
 * through one normalizer.
 */

export type CvNamespace = typeof import('@techstark/opencv-js');

const VENDORED_URL = '/vendor/opencv/opencv.js';

/** Emscripten hands back a namespace, a factory, or a promise for one. */
async function normalize(candidate: unknown): Promise<CvNamespace | null> {
  let value = candidate;
  if (typeof value === 'function') {
    value = (value as () => unknown)();
  }
  if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
    value = await value;
  }
  const cv = value as CvNamespace | undefined;
  if (cv && typeof (cv as { Mat?: unknown }).Mat === 'function') return cv;
  // Older builds resolve their own readiness through a callback instead.
  if (cv && 'onRuntimeInitialized' in cv) {
    return new Promise<CvNamespace>((resolve) => {
      (cv as { onRuntimeInitialized: () => void }).onRuntimeInitialized = () => resolve(cv);
    });
  }
  return null;
}

function injectScript(src: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-opencv="${src}"]`);
    if (existing) {
      resolve(existing.dataset.loaded === 'true');
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.dataset.opencv = src;
    el.addEventListener('load', () => {
      el.dataset.loaded = 'true';
      resolve(true);
    });
    // A missing file is the normal state before the build is vendored —
    // not an error worth surfacing, just the fallback path.
    el.addEventListener('error', () => resolve(false));
    document.head.appendChild(el);
  });
}

let pending: Promise<CvNamespace | null> | null = null;

/**
 * Resolves the OpenCV namespace, or null when neither build can start.
 * Cached: the module is megabytes, and one page may ask several times.
 */
export function loadOpenCv(): Promise<CvNamespace | null> {
  if (!pending) {
    pending = (async () => {
      if (await injectScript(VENDORED_URL)) {
        const fromGlobal = await normalize(
          (globalThis as { cv?: unknown }).cv,
        );
        if (fromGlobal) return fromGlobal;
      }
      try {
        const mod = await import('@techstark/opencv-js');
        return await normalize((mod as { default?: unknown }).default ?? mod);
      } catch {
        // Under a strict CSP this is where the npm build dies. The caller
        // falls back to manual cropping.
        return null;
      }
    })();
  }
  return pending;
}
