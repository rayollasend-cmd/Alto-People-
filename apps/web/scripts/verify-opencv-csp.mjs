// Does this OpenCV.js build run under a CSP with no 'unsafe-eval'?
//
// Exits non-zero if the bundle can generate code at runtime. Used two
// ways: as the gate on the build workflow (a build that still generates
// code is worse than no build, because it looks fixed), and against the
// vendored copy so an innocent dependency bump can't quietly bring the
// old behaviour back.
//
//   node apps/web/scripts/verify-opencv-csp.mjs <path-to-opencv.js>
//
// Grepping for `new Function(` alone is not enough and gives false
// confidence: minified Emscripten builds call it through its own helper,
// `newFunc(Function, args)`, which does `new (Function.bind.apply(...))`.
// Four of the fourteen published builds surveyed read as clean that way
// and are not. So this looks for the constructor reaching embind's
// invoker path in any of its spellings.

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: verify-opencv-csp.mjs <path-to-opencv.js>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(2);
}

const source = fs.readFileSync(file, 'latin1');

const PATTERNS = [
  { name: 'new Function(', re: /new\s+Function\s*\(/g },
  { name: 'Function.bind.apply (Emscripten newFunc helper)', re: /Function\s*\.\s*bind\s*\.\s*apply/g },
  { name: 'bare eval(', re: /(^|[^.\w$])eval\s*\(/g },
  { name: 'Function constructor via global', re: /globalThis\s*\[\s*["']Function["']\s*\]/g },
];

let failed = false;
for (const { name, re } of PATTERNS) {
  const hits = source.match(re);
  if (hits && hits.length > 0) {
    failed = true;
    console.error(`FAIL  ${hits.length.toString().padStart(4)}×  ${name}`);
  } else {
    console.log(`ok       0×  ${name}`);
  }
}

const mb = (fs.statSync(file).size / (1024 * 1024)).toFixed(2);
console.log(`\n${file} — ${mb} MB`);

if (failed) {
  console.error(
    '\nThis build generates code at runtime, so it cannot run under a CSP\n' +
      "without 'unsafe-eval'. Rebuild with -sDYNAMIC_EXECUTION=0 (or\n" +
      '-sEMBIND_AOT=1); do not ship it.',
  );
  process.exit(1);
}
console.log('\nNo runtime code generation. Safe under script-src with wasm-unsafe-eval.');
