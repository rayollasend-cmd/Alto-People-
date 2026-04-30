// One-shot rasterizer: turns the brand mark in apps/web/public/ into the
// PNG icons + screenshots Chrome's installability check wants. PNG at the
// exact requested size always passes (SVG manifest icons are inconsistently
// supported across Chromium versions).
//
// Source: logo-source.jpg — the navy compass-rose / gold A-peak emblem.
// Already sized 1500x1500 with the brand background baked in, so we just
// resize down to each canonical PWA tile size.
//
// Usage:
//   npm -w apps/web run build:pwa-icons
//
// Re-run any time logo-source.jpg changes. The generated PNGs are committed
// to the repo so the prod build doesn't need sharp at runtime.

import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const LOGO = path.join(PUBLIC, 'logo-source.jpg');
// Simplified mark for sub-96px sizes — the full logo's inner ticks /
// baseline detail muddy at favicon scale. See favicon.svg for the
// design rationale.
const FAVICON_SVG = path.join(PUBLIC, 'favicon.svg');

async function rasterizeLogo(outPngName, size) {
  const png = await sharp(LOGO)
    .resize(size, size, { fit: 'cover', position: 'center' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(PUBLIC, outPngName), png);
  console.log(`[pwa-icons] wrote ${outPngName} (${size}x${size}, ${png.length} bytes)`);
}

async function rasterizeFavicon(outPngName, size) {
  const src = await readFile(FAVICON_SVG);
  // density:300 keeps the rasterized strokes crisp at the requested size.
  const png = await sharp(src, { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(PUBLIC, outPngName), png);
  console.log(`[pwa-icons] wrote ${outPngName} (${size}x${size}, ${png.length} bytes, simplified mark)`);
}

// Standard PWA manifest sizes — full logo, has the detail to fill 96px+.
await rasterizeLogo('icon-192.png', 192);
await rasterizeLogo('icon-512.png', 512);
// Apple touch icon — 180x180 is the iOS sweet spot.
await rasterizeLogo('apple-touch-icon.png', 180);
// 96x96 used by manifest "shortcuts" entries — Chrome wants exactly this
// size and warns if it's missing.
await rasterizeLogo('icon-96.png', 96);
// Favicon — sub-96px renders from the simplified SVG mark so the rim
// + peak silhouette stays readable at 16/32px. Modern browsers will
// prefer favicon.svg directly (see index.html); this PNG is the
// legacy-browser fallback.
await rasterizeFavicon('favicon-32.png', 32);

// ---- Screenshots for the richer PWA install dialog -----------------------
// Chrome's "richer install UI" needs at least one screenshot per form factor.
// We composite the logo onto a navy backdrop + product name at the two
// canonical sizes (1280x720 wide for desktop, 720x1280 narrow for mobile).

async function renderSplash(width, height, outName) {
  const logoSize = Math.round(Math.min(width, height) * 0.4);
  const logoBuffer = await sharp(LOGO)
    .resize(logoSize, logoSize, { fit: 'cover' })
    .png()
    .toBuffer();

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#0B1832"/>
      <text x="50%" y="${Math.round(height * 0.78)}" text-anchor="middle"
            font-family="Geist, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.05)}"
            font-weight="400" fill="#FFFFFF" letter-spacing="4">ALTO PEOPLE</text>
      <text x="50%" y="${Math.round(height * 0.84)}" text-anchor="middle"
            font-family="Geist, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.025)}"
            font-weight="400" fill="#9BA3AF">Workforce management for hospitality &amp; staffing</text>
    </svg>
  `;
  const png = await sharp(Buffer.from(svg), { density: 300 })
    .resize(width, height)
    .composite([
      {
        input: logoBuffer,
        top: Math.round(height * 0.3) - Math.round(logoSize / 2),
        left: Math.round(width / 2) - Math.round(logoSize / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(PUBLIC, outName), png);
  console.log(`[pwa-icons] wrote ${outName} (${width}x${height}, ${png.length} bytes)`);
}

await renderSplash(1280, 720, 'screenshot-wide.png');
await renderSplash(720, 1280, 'screenshot-narrow.png');
