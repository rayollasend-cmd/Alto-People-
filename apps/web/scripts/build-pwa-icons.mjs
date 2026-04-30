// One-shot rasterizer: turns the SVG mark in apps/web/public/ into the PNG
// icons Chrome's installability check wants. SVG manifest icons are
// inconsistently supported across Chromium versions — PNG at the exact
// requested size always passes.
//
// Usage:
//   npm -w apps/web run build:pwa-icons
//
// Re-run any time the source SVGs change. The generated PNGs are committed
// to the repo so the prod build doesn't need sharp at runtime.

import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');

async function rasterize(srcSvgName, outPngName, size) {
  const src = await readFile(path.join(PUBLIC, srcSvgName));
  // density:300 keeps the rasterized text crisp at the requested size.
  const png = await sharp(src, { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(PUBLIC, outPngName), png);
  console.log(`[pwa-icons] wrote ${outPngName} (${size}x${size}, ${png.length} bytes)`);
}

await rasterize('icon-192.svg', 'icon-192.png', 192);
await rasterize('icon-512.svg', 'icon-512.png', 512);
// Apple touch icon — 180x180 is the iOS sweet spot.
await rasterize('icon-512.svg', 'apple-touch-icon.png', 180);
