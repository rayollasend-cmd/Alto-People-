// One-shot rasterizer: turns the SVG mark in apps/web/public/ into the PNG
// icons + screenshots Chrome's installability check wants. SVG manifest
// icons are inconsistently supported across Chromium versions — PNG at the
// exact requested size always passes.
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
// 96x96 used by manifest "shortcuts" entries — Chrome wants exactly this
// size and warns if it's missing.
await rasterize('icon-192.svg', 'icon-96.png', 96);

// ---- Screenshots for the richer PWA install dialog -----------------------
// Chrome's "richer install UI" needs at least one screenshot per form factor.
// We don't have product screenshots here, so we render a brand-mark splash —
// solid navy backdrop + the gold "A" mark + product name — at the two
// canonical sizes (1280x720 wide for desktop, 720x1280 narrow for mobile).
// Replace these with real app screenshots when you have them.

async function renderSplash(width, height, outName) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#0B1832"/>
      <text x="50%" y="${Math.round(height * 0.5)}" text-anchor="middle"
            font-family="Cormorant Garamond, serif" font-size="${Math.round(Math.min(width, height) * 0.35)}"
            font-weight="700" fill="#D4AF37">A</text>
      <text x="50%" y="${Math.round(height * 0.72)}" text-anchor="middle"
            font-family="Geist, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.05)}"
            font-weight="400" fill="#FFFFFF" letter-spacing="4">ALTO PEOPLE</text>
      <text x="50%" y="${Math.round(height * 0.78)}" text-anchor="middle"
            font-family="Geist, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.025)}"
            font-weight="400" fill="#9BA3AF">Workforce management for hospitality &amp; staffing</text>
    </svg>
  `;
  const png = await sharp(Buffer.from(svg), { density: 300 })
    .resize(width, height)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(PUBLIC, outName), png);
  console.log(`[pwa-icons] wrote ${outName} (${width}x${height}, ${png.length} bytes)`);
}

await renderSplash(1280, 720, 'screenshot-wide.png');
await renderSplash(720, 1280, 'screenshot-narrow.png');
