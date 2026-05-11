// Phase 131 hardening — fetch face-api.js model weights into
// apps/web/public/face-models/ at build time so the kiosk loads them
// from the same origin as the rest of the SPA instead of jsDelivr.
//
// Trade-off: the build still hits a remote (GitHub raw) once per fresh
// install. After that, weights are cached on disk under
// apps/web/public/face-models/, get bundled into the Vite build
// output, and shipped through Railway's static-file path. A jsDelivr
// outage at *runtime* no longer breaks the kiosk; a build-time outage
// just means redeploying when the upstream is back up.
//
// The model weights are released by vladmandic/face-api under MIT.
// We pin to a specific commit so a silently-published bad weight
// can't break our kiosks behind our back.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../public/face-models');

// Pin to face-api.js@0.22.2 — same version that ships in our
// node_modules. jsDelivr serves the package's weights directory; the
// raw GitHub URL would also work but jsDelivr's cache-on-CDN gives
// faster, more reliable build-time fetches.
const BASE_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';

// face-api.js splits each model into a JSON manifest + one or more
// binary shards. We need all of them for the three nets the kiosk
// uses: tiny_face_detector, face_landmark_68, face_recognition.
const FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
];

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function download(name) {
  const target = resolve(OUT_DIR, name);
  if (await fileExists(target)) {
    return { name, skipped: true };
  }
  const url = `${BASE_URL}/${name}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(target, buf);
  return { name, skipped: false, bytes: buf.length };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[face-models] Downloading to ${OUT_DIR}`);
  let total = 0;
  for (const name of FILES) {
    const r = await download(name);
    if (r.skipped) {
      console.log(`[face-models]   ${name} (cached)`);
    } else {
      total += r.bytes;
      console.log(`[face-models]   ${name} (${r.bytes} bytes)`);
    }
  }
  console.log(
    `[face-models] Done — ${total > 0 ? `${(total / 1024 / 1024).toFixed(2)} MB downloaded` : 'all cached'}`,
  );
}

main().catch((err) => {
  console.error('[face-models] Failed:', err.message);
  process.exit(1);
});
