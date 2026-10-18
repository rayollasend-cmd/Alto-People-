#!/usr/bin/env node
/**
 * Every image the native apps and the Wallet badge need, from the one brand
 * source (apps/web/public/logo-source.jpg — the navy compass-rose / gold
 * A-peak emblem, 1500×1500 with the brand navy baked in).
 *
 *   apps/mobile/resources/        icon.png (1024), icon-foreground.png,
 *                                 icon-background.png, splash.png,
 *                                 splash-dark.png (2732) — the inputs
 *                                 `npm run assets` (capacitor-assets) turns
 *                                 into every iOS / Android size.
 *   apps/api/assets/wallet/       icon.png @1x/@2x/@3x, logo.png @1x/@2x —
 *                                 the Apple Wallet pass images.
 *   apps/web/public/brand/        wallet-logo.png — the public logo Google
 *                                 Wallet fetches by URL.
 *
 * Re-run whenever the logo changes: `node apps/mobile/scripts/brand-assets.mjs`.
 * The outputs are committed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const SOURCE = path.join(root, 'apps/web/public/logo-source.jpg');
const RES = path.join(root, 'apps/mobile/resources');
const WALLET = path.join(root, 'apps/api/assets/wallet');
const PUBLIC_BRAND = path.join(root, 'apps/web/public/brand');

// Brand tokens (apps/web/src/index.css, dark theme): navy #0B1832, the
// emblem's own baked background is a touch deeper — sample it so the
// canvases are seamless around the mark.
const PAPER = '#F7F5F0';

async function main() {
  await Promise.all([mkdir(RES, { recursive: true }), mkdir(WALLET, { recursive: true }), mkdir(PUBLIC_BRAND, { recursive: true })]);
  const src = sharp(SOURCE);
  const meta = await src.metadata();
  const size = Math.min(meta.width ?? 1500, meta.height ?? 1500);
  // The emblem's own background colour, sampled from a corner.
  const { data } = await sharp(SOURCE).extract({ left: 4, top: 4, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  const bg = { r: data[0], g: data[1], b: data[2], alpha: 1 };
  const bgHex = `#${[data[0], data[1], data[2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

  // The emblem alone, tightly cropped (it sits in roughly the middle half).
  const cropFrac = 0.62;
  const crop = Math.round(size * cropFrac);
  const off = Math.round((size - crop) / 2);
  const emblem = await sharp(SOURCE).extract({ left: off, top: off, width: crop, height: crop }).png().toBuffer();

  // App icon: the full composition (emblem with breathing room on navy).
  await sharp(SOURCE).resize(1024, 1024).png().toFile(path.join(RES, 'icon.png'));
  // Adaptive icon (Android): foreground = emblem inside the 66% safe zone on
  // transparent; background = flat brand navy.
  const fg = await sharp(emblem).resize(560, 560).png().toBuffer();
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fg, gravity: 'center' }])
    .png()
    .toFile(path.join(RES, 'icon-foreground.png'));
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: bg } }).png().toFile(path.join(RES, 'icon-background.png'));

  // Splash: the emblem centred, 24% of the short side — light (paper) and dark (navy).
  const splashEmblem = await sharp(emblem).resize(660, 660).png().toBuffer();
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: bg } })
    .composite([{ input: splashEmblem, gravity: 'center' }])
    .png()
    .toFile(path.join(RES, 'splash-dark.png'));
  // On paper the emblem keeps its navy disc, so it reads as a badge.
  const disc = await sharp(splashEmblem)
    .composite([{ input: Buffer.from(`<svg width="660" height="660"><circle cx="330" cy="330" r="330" fill="#fff"/></svg>`), blend: 'dest-in' }])
    .png()
    .toBuffer();
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: PAPER } })
    .composite([{ input: disc, gravity: 'center' }])
    .png()
    .toFile(path.join(RES, 'splash.png'));

  // Apple Wallet: icon 29/58/87 (the lock-screen and notification glyph),
  // logo 50pt tall (top-left of the pass, beside the logo text).
  for (const [name, px] of [['icon.png', 29], ['icon@2x.png', 58], ['icon@3x.png', 87]]) {
    await sharp(SOURCE).resize(px, px).png().toFile(path.join(WALLET, name));
  }
  for (const [name, px] of [['logo.png', 50], ['logo@2x.png', 100], ['logo@3x.png', 150]]) {
    await sharp(emblem).resize(px, px).png().toFile(path.join(WALLET, name));
  }
  // Google Wallet fetches its logo by public URL: a circular emblem.
  await sharp(emblem)
    .resize(660, 660)
    .composite([{ input: Buffer.from(`<svg width="660" height="660"><circle cx="330" cy="330" r="330" fill="#fff"/></svg>`), blend: 'dest-in' }])
    .png()
    .toFile(path.join(PUBLIC_BRAND, 'wallet-logo.png'));

  console.log(`brand assets written (emblem background ${bgHex})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
