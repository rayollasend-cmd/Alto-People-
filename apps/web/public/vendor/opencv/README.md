# OpenCV.js, built to run under our CSP

Document scanning — the automatic edge detection and deskew behind the ID
and void-cheque capture — runs OpenCV compiled to WebAssembly.

Every published OpenCV.js build generates JavaScript at runtime: embind
constructs its invoker functions from strings as the module starts. Our
Content-Security-Policy allows WebAssembly (`'wasm-unsafe-eval'`) and
nothing else, so the module throws before the scanner takes a single
frame, and every capture silently falls back to manual cropping.

Adding `'unsafe-eval'` would fix it by removing the protection, on the
pages that handle passports and visas. We are not doing that.

Emscripten has the way out: with `-sDYNAMIC_EXECUTION=0`, embind uses
closure-based invokers and generates no code at all. OpenCV's own
`build_js.py` forwards build flags, so this is a build, not a patch.

## Getting the file

1. Actions → **Build OpenCV.js (strict CSP)** → Run workflow. It builds
   OpenCV from source with `-s DYNAMIC_EXECUTION=0` and refuses to upload
   a build that still generates code. By default it also commits the
   result to a branch and opens a PR, so steps 2–4 are only needed if you
   turn that input off.

   The module set is the build script's default. Trimming it to the three
   modules the scanner uses (`core`, `imgproc`, `calib3d`) needs a
   matching custom export config, since the bindings generator's list is
   written against the default set — worth doing as a measured follow-up
   once a working build exists, not as part of getting one.
2. Download the artifact and put `opencv.js` in
   `apps/web/public/vendor/opencv/`. If the build emitted a separate
   `opencv_js.wasm`, put it there too.

   It lives under `public/` and is loaded with a `<script>` tag at
   runtime, not imported. The build is a classic UMD file whose export is
   an Emscripten factory, so bundling it would mean teaching the bundler
   to interpret UMD — and would put 11MB inside a JS chunk. As a static
   file it is same-origin (so `script-src 'self'` allows it), it is
   fetched only on the scan surfaces, and the bundler never looks at it.
3. Verify what you are about to ship:

   ```
   node apps/web/scripts/verify-opencv-csp.mjs apps/web/public/vendor/opencv/opencv.js
   ```

   It must report no runtime code generation. Do not skip this: minified
   Emscripten builds reach the `Function` constructor through a helper, so
   grepping for `new Function(` by hand reads clean on builds that are not.

4. Build the web app. `lib/opencvLoader.ts` tries this file first and
   falls back to the npm package when it is absent, so no importing
   module changes and nothing breaks while it is missing.

## Checking it actually works

The failure this fixes is invisible from the app: the scanner just never
finds a document. After deploying, open the ID capture on a phone and
confirm the live edge outline appears. In the browser console there must
be no CSP violation naming `script-src`.

## Why not the alternatives

- **A sandboxed page with a relaxed CSP.** Works, but it means a page
  handling passport and visa images is the one place protection was
  deliberately weakened. Second choice, and only if the build proves
  unworkable.
- **A hand-written detector.** Edge detection on a phone photo of a
  passport on a bedspread is exactly the problem that looks solved in
  testing and is not.
- **A Web Worker.** Does not help: workers inherit the document's CSP.
