#!/usr/bin/env node
/**
 * Writes the two files that let links to the web app open the native app:
 *
 *   apps/web/public/.well-known/apple-app-site-association   (iOS universal links + passkeys)
 *   apps/web/public/.well-known/assetlinks.json              (Android verified app links)
 *
 * They are served by the web app at https://<host>/.well-known/… (Vite
 * copies public/ into the build). Run with the signing details:
 *
 *   APPLE_TEAM_ID=TEAMID1234 \
 *   IOS_BUNDLE_IDS=com.altohr.people,com.altohr.people.staging \
 *   ANDROID_PACKAGES=com.altohr.people,com.altohr.people.staging \
 *   ANDROID_SHA256=AB:CD:…,12:34:… \
 *   npm run well-known -w @alto-people/mobile
 *
 * ANDROID_SHA256 is the Play App Signing certificate's SHA-256 (Play
 * Console → App integrity), plus your upload key's for internal builds.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../web/public/.well-known');
const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const team = process.env.APPLE_TEAM_ID;
const bundles = list(process.env.IOS_BUNDLE_IDS || 'com.altohr.people');
const packages = list(process.env.ANDROID_PACKAGES || 'com.altohr.people');
const fingerprints = list(process.env.ANDROID_SHA256);

// The pages that open in the app — same list as AndroidManifest.xml.
const PATHS = ['/rides', '/rides/*', '/me', '/me/*', '/shifts', '/shifts/*', '/track/*', '/w/*', '/candidate/*', '/nps/*', '/inbox', '/inbox/*'];

async function main() {
  if (!team || fingerprints.length === 0) {
    console.error('Set APPLE_TEAM_ID and ANDROID_SHA256 (see the comment at the top of this file).');
    process.exit(1);
  }
  await mkdir(out, { recursive: true });
  const appIDs = bundles.map((b) => `${team}.${b}`);
  const aasa = {
    applinks: { details: [{ appIDs, components: PATHS.map((p) => ({ '/': p })) }] },
    webcredentials: { apps: appIDs },
  };
  const assetlinks = packages.map((pkg) => ({
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fingerprints },
  }));
  // No extension: Apple fetches exactly this path and wants JSON.
  await writeFile(path.join(out, 'apple-app-site-association'), `${JSON.stringify(aasa, null, 2)}\n`);
  await writeFile(path.join(out, 'assetlinks.json'), `${JSON.stringify(assetlinks, null, 2)}\n`);
  console.log(`wrote ${out}/apple-app-site-association and assetlinks.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
