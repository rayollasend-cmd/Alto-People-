#!/usr/bin/env node
/* global process, console */
/**
 * Local entry point for the visual regression suite (README.md beside this).
 *
 *   node e2e/visual/run.mjs             build, then compare inside the Playwright image
 *   node e2e/visual/run.mjs --update    build, then rewrite the baselines (same image)
 *   node e2e/visual/run.mjs --record    build, then re-record the HARs on this machine
 *                                        (needs the API on :3001 with alto_dev's demo data)
 *   ... --no-build                       reuse the last build in e2e-results/visual-dist
 *   ... -- <playwright args>             passed through (e.g. -- -g "Clients list")
 *
 * Why a container: a screenshot is only comparable with one drawn by the same
 * browser, fonts and rasteriser. The replay always runs in
 * mcr.microsoft.com/playwright:v<installed @playwright/test>-noble on
 * linux/amd64 — the image the CI job uses — so a baseline made on a laptop
 * matches CI pixel for pixel.
 *
 * The app is built on the host (the host's node_modules hold macOS binaries
 * that cannot run in Linux). The container gets the repository mounted, with
 * its own node_modules volume holding only @playwright/test, installed there.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../..');
const REPO = path.resolve(WEB, '../..');
const DIST = 'e2e-results/visual-dist';

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const own = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
const passthrough = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
const mode = own.includes('--record') ? 'record' : own.includes('--update') ? 'update' : 'test';
const build = !own.includes('--no-build');

const require = createRequire(import.meta.url);
const PW_VERSION = require('@playwright/test/package.json').version;
const IMAGE = process.env.VISUAL_IMAGE ?? `mcr.microsoft.com/playwright:v${PW_VERSION}-noble`;
const PLATFORM = process.env.VISUAL_PLATFORM ?? 'linux/amd64';

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

if (build) {
  // vite alone (no tsc -b, no face-model fetch): the pages are what matter
  // here, and the CI build job already typechecks. Its own outDir, so a
  // concurrent `npm run build` never swaps the bundle mid-run.
  const status = run('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn'], { cwd: WEB });
  if (status !== 0) process.exit(status);
}

if (mode === 'record') {
  // Recording happens on the host: it needs the local API, and a HAR holds
  // responses, not pixels, so the platform does not matter.
  const status = run(
    'npx',
    ['playwright', 'test', '-c', 'e2e/visual/playwright.config.ts', ...passthrough],
    { cwd: WEB, env: { ...process.env, E2E_FULLSTACK: '1', VISUAL_RECORD: '1', VISUAL_DIST: DIST } },
  );
  process.exit(status);
}

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
if (docker.status !== 0) {
  console.error('The visual suite renders inside the Playwright Docker image, and Docker is not running.');
  process.exit(1);
}

const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
const pwArgs = ['test', '-c', 'e2e/visual/playwright.config.ts', ...(mode === 'update' ? ['--update-snapshots=changed'] : []), ...passthrough]
  .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
  .join(' ');

// Inside the container: put @playwright/test (the same version as the image)
// into the container-only node_modules volume once, run the replay, and hand
// the files it wrote back to the host user (a Linux host would see root).
const script = `
set -e
want=${PW_VERSION}
have=$(node -p "require('/repo/node_modules/@playwright/test/package.json').version" 2>/dev/null || true)
if [ "$have" != "$want" ]; then
  echo "installing @playwright/test@$want into the container's node_modules volume"
  mkdir -p /tmp/pw && cd /tmp/pw && npm init -y >/dev/null
  npm install --no-audit --no-fund --loglevel=error @playwright/test@$want
  cp -a /tmp/pw/node_modules/. /repo/node_modules/
fi
cd /repo/apps/web
status=0
node /repo/node_modules/@playwright/test/cli.js ${pwArgs} || status=$?
chown -R ${uid}:${gid} e2e/visual/__screenshots__ e2e-results/visual 2>/dev/null || true
exit $status
`;

const status = run('docker', [
  'run', '--rm',
  '--platform', PLATFORM,
  '--ipc=host',
  '-v', `${REPO}:/repo`,
  // Container-only node_modules: the host's are macOS builds.
  '-v', `alto-visual-node-modules-${PLATFORM.replace('/', '-')}:/repo/node_modules`,
  '-e', `VISUAL_DIST=${DIST}`,
  '-e', 'CI',
  '-w', '/repo/apps/web',
  IMAGE,
  'bash', '-c', script,
]);
if (status !== 0) {
  console.log('\nThe report (expected / actual / diff): apps/web/e2e-results/visual/report/index.html');
}
process.exit(status);
