// Hugo in 3D — a plush toy: a furry hood with a cream face, bead eyes and rosy cheeks, a fluffy
// collar, stubby arms and legs, in two colourways (design/hugo/sources): blue with a gold collar
// for light mode, gold with a navy collar for dark mode. The Alto lanyard says he's at work.
//
// The fur is shell texturing: each furry part is drawn again in thin shells pushed out along its
// normals, and each shell keeps only the strands that reach it — dense at the root, sparse at the
// tips, so the edges go soft the way the reference photos do.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const params = new URLSearchParams(location.search);
const POSE = params.get('pose') || 'hello';
const SIZE = Number(params.get('size') || 768);
const FRAME = Number(params.get('frame') || 0);
const FRAMES = Number(params.get('frames') || 1);
const PH = FRAMES > 1 ? FRAME / FRAMES : 0; // 0…1 through the loop
const TAU = Math.PI * 2;
const BG = params.get('bg'); // a solid backdrop (WhatsApp's profile photo), else transparent
const VARIANT = params.get('v') === 'gold' ? 'gold' : 'blue';

// The two colourways, sampled from the reference images (sRGB).
const LOOK = {
  blue: { fur: 0x1f63b3, collar: 0xe9a81f, strap: 0x0b1832, stripe: 0xe9a81f, ears: true },
  gold: { fur: 0xdea526, collar: 0x1f4780, strap: 0x0b1832, stripe: 0xf3c65a, ears: false },
}[VARIANT];

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(2);
renderer.setSize(SIZE, SIZE);
renderer.toneMapping = THREE.NeutralToneMapping; // keeps the fur's colour true to the references
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
if (POSE === 'face') { camera.position.set(0, 0.78, 4.1); camera.lookAt(0, 0.66, 0); }
else { camera.position.set(0, 0.45, 8.2); camera.lookAt(0, 0.08, 0); }
if (BG) scene.background = new THREE.Color(BG);

// Soft studio light: a warm key from the front left, a fill, and a gentle rim to lift the fuzz.
const key = new THREE.DirectionalLight(0xfff4e6, 2.1); key.position.set(-1.2, 6, 3.5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 10; key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.9); fill.position.set(3, 1, 5); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.4); rim.position.set(1, 3, -4); scene.add(rim);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.6));

const FLOOR = -1.3;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: POSE === 'face' ? 0 : 0.13 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = FLOOR; ground.receiveShadow = true; scene.add(ground);

const offline = POSE === 'offline';
const grey = (hex, k = 0.85) => { const c = new THREE.Color(hex); const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11; return c.lerp(new THREE.Color(l, l, l), k).multiplyScalar(0.9); };
const tint = (hex) => (offline ? grey(hex) : new THREE.Color(hex));

const M = {
  face: new THREE.MeshPhysicalMaterial({ color: tint(0xf8dfca), roughness: 0.62, sheen: 0.4, sheenColor: new THREE.Color(0xffe9dc), clearcoat: 0.05 }),
  bead: new THREE.MeshPhysicalMaterial({ color: 0x060313, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.6 }),
  glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  line: new THREE.MeshPhysicalMaterial({ color: 0x14101c, roughness: 0.5 }),
  mouth: new THREE.MeshPhysicalMaterial({ color: 0x2a1420, roughness: 0.6 }),
  tongue: new THREE.MeshPhysicalMaterial({ color: 0xf28b8b, roughness: 0.5 }),
  gold: new THREE.MeshPhysicalMaterial({ color: tint(0xf0c862), metalness: 1, roughness: 0.25, clearcoat: 0.4, envMapIntensity: 1.6 }),
  strap: new THREE.MeshPhysicalMaterial({ color: tint(LOOK.strap), roughness: 0.75, sheen: 0.6, sheenColor: new THREE.Color(0x36507f), side: THREE.DoubleSide }),
  stripe: new THREE.MeshPhysicalMaterial({ color: tint(LOOK.stripe), roughness: 0.6, side: THREE.DoubleSide }),
  card: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.35, clearcoat: 0.6 }),
  cardBar: new THREE.MeshPhysicalMaterial({ color: tint(0x0b1832), roughness: 0.5 }),
  cardLine: new THREE.MeshPhysicalMaterial({ color: 0xb6c3d3, roughness: 0.6 }),
  clip: new THREE.MeshPhysicalMaterial({ color: 0xd3dde9, metalness: 0.9, roughness: 0.25, envMapIntensity: 1.6 }),
  alu: new THREE.MeshPhysicalMaterial({ color: 0xc9d0da, metalness: 0.55, roughness: 0.32, envMapIntensity: 1.2 }),
  paper: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.6 }),
  keys: new THREE.MeshPhysicalMaterial({ color: 0x252d3a, roughness: 0.6 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x0b1832, emissive: 0x1f9a8f, emissiveIntensity: 0.9 }),
  disc: new THREE.MeshPhysicalMaterial({ color: 0x6d93c4, roughness: 0.35, clearcoat: 0.6 }),
  wave: new THREE.MeshStandardMaterial({ color: 0x2dd4bf, emissive: 0x2dd4bf, emissiveIntensity: 1.6 }),
};

const hugo = new THREE.Group();
scene.add(hugo);
const add = (mesh, parent = hugo) => { mesh.castShadow = true; parent.add(mesh); return mesh; };
// Things in the air (sound, thoughts, confetti, z's) cast no shadow on the floor.
const float = (mesh, parent = hugo) => { parent.add(mesh); return mesh; };

/* ------------------------------------------------------------------ fur */

// Strand density follows the render size, so the fur never turns into sub-pixel noise that
// shimmers from frame to frame in the small loops.
const DENSITY = Math.min(230, Math.max(70, SIZE * 0.3));
const SHELLS = SIZE >= 512 ? 36 : 24;
const FUR_LEN = 0.095;

/**
 * A furry part: the dense undercoat plus SHELLS shells. `mask` keeps the fur off a region in the
 * part's own space (the face): [cx, cy, rx, ry], front-facing points only.
 */
function furry(geometry, hex, { len = FUR_LEN, mask = null, droop = 0.35 } = {}) {
  const g = new THREE.Group();
  const base = new THREE.Color(tint(hex));
  for (let i = 0; i <= SHELLS; i++) {
    const shell = i / SHELLS;
    const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.95, metalness: 0 });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        uShell: { value: shell }, uLen: { value: len }, uDensity: { value: DENSITY }, uDroop: { value: droop },
        uMask: { value: mask ? new THREE.Vector4(...mask) : new THREE.Vector4(0, 0, 0, 0) },
      });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uShell; uniform float uLen; uniform float uDroop; varying vec3 vBase; varying vec3 vBaseN;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vBase = position; vBaseN = normal;
          transformed += normal * uLen * uShell + vec3(0.0, -1.0, 0.0) * uLen * uDroop * uShell * uShell;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uShell; uniform float uDensity; uniform vec4 uMask; varying vec3 vBase; varying vec3 vBaseN;
          float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`)
        .replace('#include <alphatest_fragment>', `
          vec3 q = vBase * uDensity;
          vec3 cell = floor(q);
          float rnd = h31(cell + 7.3);
          if (uMask.z > 0.0 && vBase.z > 0.0) {
            vec2 d = (vBase.xy - uMask.xy) / uMask.zw;
            if (dot(d, d) < 1.0 + (rnd - 0.5) * 0.12) discard;
          }
          if (uShell > 0.0) {
            vec3 j = vec3(h31(cell), h31(cell + 17.1), h31(cell + 31.7)) * 0.6 + 0.2;
            vec3 r = fract(q) - j;
            // Distance across the surface only: where the skin runs along a plane of cells, the
            // depth inside the cell would otherwise draw rings.
            vec3 nn = normalize(vBaseN);
            r -= nn * dot(r, nn);
            // Strands of different lengths, thinning toward their tips.
            float reach = 0.45 + 0.55 * rnd;
            if (uShell > reach) discard;
            float t = uShell / reach;
            float rad = 0.66 * (1.0 - t * t * 0.85) * (1.0 - t * 0.35);
            if (dot(r, r) > rad * rad) discard;
          }
          #include <alphatest_fragment>`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Roots in each other's shade, tips catching the light, each strand a touch different.
          diffuseColor.rgb *= mix(0.62, 1.1, uShell) * (0.9 + 0.2 * h31(floor(vBase * uDensity) + 3.1));`);
    };
    // One program for every shell of every part: each material keeps its own uniforms (shell, mask).
    m.customProgramCacheKey = () => 'fur';
    const mesh = new THREE.Mesh(geometry, m);
    if (i === 0) { mesh.castShadow = true; mesh.receiveShadow = true; }
    g.add(mesh);
  }
  return g;
}
const ellipsoidGeo = (rx, ry, rz, w = 96, h = 64) => { const geo = new THREE.SphereGeometry(1, w, h); geo.scale(rx, ry, rz); geo.computeVertexNormals(); return geo; };
const ellipsoid = (rx, ry, rz, mat) => new THREE.Mesh(ellipsoidGeo(rx, ry, rz, 48, 32), mat);
const arc = (r, tube, angle, mat) => new THREE.Mesh(new THREE.TorusGeometry(r, tube, 16, 48, angle), mat);
const tube = (pts, radius, mat, closed = false) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), 64, radius, 24, closed), mat);
const cap = (p, r, mat) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat); m.position.set(...p); return m; };

/* ----------------------------------------------------------------- body */

// The shape, from the references: a round head-hood a little narrower than the belly, the collar
// where they meet, two stubby legs, and (blue) two round ears.
const HEAD = { y: 0.74, rx: 0.64, ry: 0.6, rz: 0.56 };
const BODY = { y: -0.4, rx: 0.8, ry: 0.8, rz: 0.66 };
const FACE = { cx: 0, cy: -0.08, rx: 0.42, ry: 0.35 }; // in the head's own space

const headGroup = new THREE.Group(); headGroup.position.y = HEAD.y; hugo.add(headGroup);
const headGeo = ellipsoidGeo(HEAD.rx, HEAD.ry, HEAD.rz);
headGroup.add(furry(headGeo, LOOK.fur, { mask: [FACE.cx, FACE.cy, FACE.rx * 0.9, FACE.ry * 0.9] }));
const headSolid = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ visible: false })); headGroup.add(headSolid);
if (LOOK.ears) for (const s of [-1, 1]) {
  const ear = furry(ellipsoidGeo(0.16, 0.15, 0.12, 48, 32), LOOK.fur, { len: 0.07 });
  ear.position.set(s * 0.44, 0.47, -0.05); ear.rotation.z = -s * 0.35; headGroup.add(ear);
}
const bodyGroup = new THREE.Group(); bodyGroup.position.y = BODY.y; hugo.add(bodyGroup);
const bodyGeo = ellipsoidGeo(BODY.rx, BODY.ry, BODY.rz);
bodyGroup.add(furry(bodyGeo, LOOK.fur));
const bodySolid = new THREE.Mesh(bodyGeo, new THREE.MeshBasicMaterial({ visible: false })); bodyGroup.add(bodySolid);
for (const s of [-1, 1]) {
  const leg = furry(new THREE.CapsuleGeometry(0.22, 0.12, 12, 32), LOOK.fur, { len: 0.06, droop: 0 });
  leg.position.set(s * 0.33, FLOOR + 0.31, 0.04); hugo.add(leg);
}
// The collar: a fluffy ring where the head meets the body.
const collar = furry(new THREE.TorusGeometry(0.6, 0.12, 32, 96), LOOK.collar, { len: 0.085, droop: 0.15 });
collar.rotation.x = Math.PI / 2 - 0.08; collar.position.set(0, 0.2, 0.03); collar.scale.set(1, 0.92, 1);
hugo.add(collar);

// Points on a surface, found by a ray from the front.
const ray = new THREE.Raycaster();
function onSurface(solid, x, y, lift = 0) {
  solid.updateMatrixWorld(true);
  ray.set(new THREE.Vector3(x, y, 6), new THREE.Vector3(0, 0, -1));
  const hit = ray.intersectObject(solid)[0];
  const n = hit.face.normal.clone().transformDirection(solid.matrixWorld);
  return { p: hit.point.clone().add(n.clone().multiplyScalar(lift)), n };
}

/* ----------------------------------------------------------------- face */

// The face: a smooth cream oval set into the hood, a touch proud of the fur's roots.
const faceMesh = new THREE.Mesh(ellipsoidGeo(FACE.rx, FACE.ry, 0.12, 64, 48), M.face);
faceMesh.position.set(FACE.cx, FACE.cy, HEAD.rz - 0.075); faceMesh.receiveShadow = true;
headGroup.add(faceMesh);
hugo.updateMatrixWorld(true);
function place(mesh, x, y, lift = 0) {
  // x, y are on the face, from its centre; the mesh sits on the face's surface, facing out.
  const centre = new THREE.Vector3(FACE.cx, FACE.cy + HEAD.y, 0);
  const { p, n } = onSurface(faceMesh, centre.x + x, centre.y + y, lift);
  mesh.position.copy(p);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  return add(mesh);
}

// Rosy cheeks: a soft radial blush.
const blushTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d'); const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(247,160,160,0.95)'); g.addColorStop(0.55, 'rgba(247,168,167,0.55)'); g.addColorStop(1, 'rgba(247,168,167,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const blush = () => new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.16), new THREE.MeshBasicMaterial({ map: blushTex, transparent: true, depthWrite: false, toneMapped: false }));

/* ---------------------------------------------------------------- poses */

// at: wears the Alto lanyard — he's at work. Off duty (hello, celebrate, coffee, offline), no lanyard.
const P = {
  hello: { at: false, eyes: 'open', look: [0.01, 0.01], mouth: 'smile', armL: 'rest', armR: 'wave' },
  working: { at: true, eyes: 'focus', look: [0, -0.025], mouth: 'smile', armL: 'typeL', armR: 'typeR', laptop: true },
  listening: { at: true, eyes: 'open', look: [-0.02, 0], mouth: 'smile', armL: 'rest', armR: 'ear', extra: 'sound' },
  thinking: { at: true, eyes: 'open', look: [0.02, 0.03], mouth: 'hmm', armL: 'rest', armR: 'chin', extra: 'thought' },
  handoff: { at: true, eyes: 'open', look: [0.03, 0], mouth: 'smile', armL: 'rest', armR: 'give', extra: 'envelope' },
  celebrate: { at: false, eyes: 'happy', mouth: 'open', armL: 'up', armR: 'up', extra: 'confetti' },
  offline: { at: false, eyes: 'closed', mouth: 'o', armL: 'down', armR: 'down', extra: 'zz', noCheeks: true },
  coffee: { at: false, eyes: 'content', mouth: 'smile', armL: 'rest', armR: 'mug', extra: 'coffee' },
  reading: { at: true, eyes: 'open', look: [0.02, -0.03], mouth: 'smile', armL: 'holdL', armR: 'holdR', extra: 'document' },
  pointing: { at: true, eyes: 'open', look: [0.035, 0.01], mouth: 'open', armL: 'rest', armR: 'point' },
  face: { at: true, eyes: 'open', look: [0.005, 0], mouth: 'smile', armL: null, armR: null },
  talking: { at: true, eyes: 'open', look: [0, 0.008], mouth: 'talk', armL: 'rest', armR: 'gesture' },
}[POSE];
// Motion that reads at 56 px: each loop names its blink frame and its eyes' path.
const F = (n) => FRAMES > 1 && FRAME === n;
if (POSE === 'hello' && F(9)) P.eyes = 'closed';
if (POSE === 'listening' && F(8)) P.eyes = 'closed';
if (POSE === 'talking') { P.mouth = FRAME % 2 === 0 ? 'talk' : 'smile'; if (F(6)) P.eyes = 'closed'; }
if (POSE === 'reading' && FRAMES > 1) { const line = Math.floor(PH * 3); const x = ((PH * 3) % 1) * 0.05 - 0.025; P.look = [x, -0.02 - line * 0.008]; if (F(9)) P.eyes = 'closed'; }
if (POSE === 'thinking' && FRAMES > 1) P.look = [Math.sin(PH * TAU) * 0.03, 0.03];
if (POSE === 'coffee' && FRAMES > 1) { const sip = Math.sin(PH * Math.PI); P.sip = sip; P.eyes = sip > 0.45 ? 'happy' : 'open'; P.look = [0.02, 0.01]; }
if (POSE === 'face' && F(1)) P.eyes = 'closed';
if (params.get('blink') === '1') P.eyes = 'closed';

// Eyes: glossy black beads with two highlights, as in the references.
for (const side of [-1, 1]) {
  const x = side * 0.175, y = 0.07;
  if (P.eyes === 'content') P.eyes = 'happy';
  if (P.eyes === 'happy' || P.eyes === 'closed') {
    const a = arc(0.055, 0.014, Math.PI, M.line);
    place(a, x, y + (P.eyes === 'happy' ? -0.015 : 0.0), 0.006);
    if (P.eyes === 'closed') a.rotateZ(Math.PI);
    continue;
  }
  const [lx, ly] = P.look || [0, 0];
  const ry = P.eyes === 'focus' ? 0.056 : 0.07;
  place(ellipsoid(0.063, ry, 0.035, M.bead), x + lx, y + ly, 0.004);
  place(cap([0, 0, 0], 0.017, M.glint), x + lx - 0.016, y + ly + 0.022, 0.03);
  place(cap([0, 0, 0], 0.008, M.glint), x + lx + 0.02, y + ly - 0.018, 0.028);
}
// Cheeks.
if (!P.noCheeks) for (const side of [-1, 1]) place(blush(), side * 0.285, -0.1, 0.004);
// Mouth: a small U smile; open, talking and thinking shapes for the poses that need them.
if (P.mouth === 'smile') { const m = arc(0.045, 0.011, Math.PI, M.line); place(m, 0, -0.055, 0.005); m.rotateZ(Math.PI); }
if (P.mouth === 'open') {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.055, 40, Math.PI, Math.PI), M.mouth); place(m, 0, -0.03, 0.006);
  place(ellipsoid(0.028, 0.013, 0.004, M.tongue), 0, -0.068, 0.009);
}
if (P.mouth === 'hmm') place(tube([[-0.03, 0, 0], [0.01, 0.004, 0], [0.04, 0.014, 0]], 0.01, M.line), 0.015, -0.055, 0.006);
if (P.mouth === 'o') place(arc(0.018, 0.009, TAU, M.line), 0, -0.05, 0.006);
if (P.mouth === 'talk') {
  place(ellipsoid(0.04, 0.032, 0.006, M.mouth), 0, -0.05, 0.003);
  place(ellipsoid(0.02, 0.009, 0.004, M.tongue), 0, -0.064, 0.008);
}

/* -------------------------------------------------------------- lanyard */

// The Alto lanyard: a navy strap from under the collar, a clip, and a white card with the Alto
// mark — Hugo at work. Drawn in the references' spirit; the lanyard photo, when it comes, is the
// source of truth.
function altoEmblem() {
  const g = new THREE.Group();
  const pt = (x, y) => new THREE.Vector2(x - 32, 32 - y);
  const shape = (pts, holes = []) => { const sh = new THREE.Shape(pts.map(([x, y]) => pt(x, y))); holes.forEach((h) => sh.holes.push(new THREE.Path(h.map(([x, y]) => pt(x, y))))); return sh; };
  const raise = (sh, depth, mat, z = 0) => { const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.35, bevelSegments: 3, curveSegments: 24 }), mat); m.position.z = z; g.add(m); return m; };
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(18.6, 18.6, 1, 64), M.disc); disc.rotation.x = Math.PI / 2; disc.position.z = 0.5; g.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(20, 1.8, 20, 96), M.gold); ring.position.z = 1.2; g.add(ring);
  raise(shape([[32, 1], [28, 15], [32, 12], [36, 15]]), 1.6, M.gold);
  raise(shape([[32, 63], [28, 49], [32, 52], [36, 49]]), 1.6, M.gold);
  raise(shape([[1, 32], [15, 28], [12, 32], [15, 36]]), 1.6, M.gold);
  raise(shape([[63, 32], [49, 28], [52, 32], [49, 36]]), 1.6, M.gold);
  raise(shape([[32, 17], [45, 41], [19, 41]], [[[32, 26], [24, 39.5], [40, 39.5]]]), 2.2, M.gold, 1);
  raise(shape([[27, 35], [37, 35], [37, 37], [27, 37]]), 2.2, M.gold, 1);
  raise(shape([[22, 43.5], [42, 43.5], [42, 45.3], [22, 45.3]]), 1.2, M.gold, 1);
  raise(shape([[25.5, 47.5], [38.5, 47.5], [38.5, 49.1], [25.5, 49.1]]), 1.2, M.gold, 1);
  return g;
}
if (P.at) {
  // The strap follows the belly: sampled on the body's surface, a little proud of the fur.
  const sway = Math.sin(PH * TAU) * 0.012;
  const strapPts = (s) => [0.12, 0.02, -0.08, -0.17].map((y, i) => {
    const x = s * (0.3 - i * 0.085) + sway * i;
    return onSurface(bodySolid, x, y, FUR_LEN * 0.9).p;
  });
  for (const s of [-1, 1]) {
    const pts = strapPts(s);
    const curve = new THREE.CatmullRomCurve3(pts);
    const strap = add(new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.022, 8, false), M.strap)); strap.scale.set(1, 1, 1);
    const stripe = add(new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.0235, 8, false), M.stripe)); stripe.scale.set(0.98, 1, 1.002);
    stripe.visible = false; // a flat strap reads better than a striped one at 56 px
  }
  const clipAt = onSurface(bodySolid, sway * 3, -0.21, FUR_LEN * 1.0).p;
  const clip = add(new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.012, 12, 24), M.clip)); clip.position.copy(clipAt);
  const card = new THREE.Group();
  const cardAt = onSurface(bodySolid, sway * 4, -0.44, FUR_LEN * 1.15);
  card.position.copy(cardAt.p); card.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cardAt.n); card.rotateX(0.12); card.rotateZ(sway * 3);
  add(card);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.018), M.card), card);
  const bar = add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.075, 0.02), M.cardBar), card); bar.position.set(0, 0.182, 0.001);
  const emblem = altoEmblem(); emblem.scale.setScalar(0.0042); emblem.position.set(0, 0.03, 0.012); card.add(emblem);
  [-0.12, -0.165].forEach((y, i) => { const l = add(new THREE.Mesh(new THREE.BoxGeometry(i ? 0.14 : 0.2, 0.022, 0.004), M.cardLine), card); l.position.set(0, y, 0.011); });
}

/* ----------------------------------------------------------------- arms */

// Stubby plush arms: a fat curve from the shoulder, rounded at the end (no separate hands).
const SH = { L: [-0.5, 0.06, 0.02], R: [0.5, 0.06, 0.02] };
const ARMS = {
  rest: (s) => [[s * 0.84, -0.36, 0.1], [s * 0.86, -0.66, 0.2]],
  down: (s) => [[s * 0.84, -0.4, 0.08], [s * 0.84, -0.74, 0.14]],
  wave: (s) => [[s * 0.98, 0.18, 0.12], [s * 1.06, 0.58, 0.18]],
  up: (s) => [[s * 0.95, 0.25, 0.1], [s * 1.02, 0.7, 0.12]],
  ear: (s) => [[s * 0.95, 0.1, 0.25], [s * 0.86, 0.6, 0.3]],
  chin: (s) => [[s * 0.78, -0.32, 0.5], [s * 0.3, 0.2, 0.7]],
  give: (s) => [[s * 0.95, -0.22, 0.4], [s * 1.22, -0.12, 0.6]],
  typeL: (s) => [[s * 0.7, -0.5, 0.55], [s * 0.26, -0.82, 0.98]],
  typeR: (s) => [[s * 0.7, -0.5, 0.55], [s * 0.26, -0.82, 0.98]],
  mug: (s) => [[s * 0.8, -0.32, 0.5], [s * 0.42, -0.2, 0.86]],
  holdL: (s) => [[s * 0.74, -0.36, 0.52], [s * 0.3, -0.36, 0.95]],
  holdR: (s) => [[s * 0.74, -0.36, 0.52], [s * 0.3, -0.36, 0.95]],
  point: (s) => [[s * 0.98, 0.0, 0.35], [s * 1.3, 0.18, 0.5]],
  gesture: (s) => [[s * 0.95, -0.22, 0.4], [s * 1.0, 0.05, 0.6]],
};
// Animation: the wave swings, typing hands bob in turn, celebrating arms pump.
function animate(name, side, pts) {
  const [mid, hand] = pts;
  if (name === 'wave') { const a = Math.sin(PH * TAU) * 0.26; return [[mid[0] + a * 0.3, mid[1], mid[2]], [hand[0] + a, hand[1] - Math.abs(a) * 0.25, hand[2]]]; }
  if (name === 'gesture') { const d = Math.sin(PH * TAU * 2) * 0.08; return [mid, [hand[0] + d * 0.4, hand[1] + d, hand[2]]]; }
  if (name === 'mug' && P.sip !== undefined) { const k = P.sip; return [[mid[0], mid[1] + k * 0.1, mid[2]], [hand[0] - k * 0.1, hand[1] + k * 0.16, hand[2] + k * 0.05]]; }
  if (name === 'give') { const d = Math.sin(PH * TAU) * 0.1; return [mid, [hand[0] + Math.max(0, d), hand[1], hand[2]]]; }
  if (name === 'typeL' || name === 'typeR') { const d = Math.sin(PH * TAU * 2 + (side < 0 ? 0 : Math.PI)) * 0.04; return [mid, [hand[0], hand[1] + Math.max(0, d), hand[2]]]; }
  if (name === 'up') { const d = Math.sin(PH * TAU) * 0.1; return [[mid[0], mid[1] + d, mid[2]], [hand[0], hand[1] + d * 1.6, hand[2]]]; }
  if (name === 'point') { const d = Math.max(0, Math.sin(PH * TAU)) * 0.1; return [mid, [hand[0] + d, hand[1] + d * 0.4, hand[2]]]; }
  if (name === 'ear') { const d = Math.sin(PH * TAU) * 0.02; return [mid, [hand[0], hand[1] + d, hand[2]]]; }
  return pts;
}
for (const [name, side] of [['armL', -1], ['armR', 1]]) {
  if (!P[name]) continue;
  const [mid, hand] = animate(P[name], side, ARMS[P[name]](side));
  const shoulder = SH[side < 0 ? 'L' : 'R'];
  const curve = new THREE.CatmullRomCurve3([shoulder, mid, hand].map((p) => new THREE.Vector3(...p)));
  // A tapered tube would pinch; the plush arm is one width, with a round end.
  const armGeo = new THREE.TubeGeometry(curve, 48, 0.19, 32, false);
  hugo.add(furry(armGeo, LOOK.fur, { len: 0.06, droop: 0.2 }));
  const end = furry(new THREE.SphereGeometry(0.19, 48, 32), LOOK.fur, { len: 0.06, droop: 0.2 }); end.position.set(...hand); hugo.add(end);
  if (P[name] === 'point') {
    const dir = new THREE.Vector3(...hand).sub(new THREE.Vector3(...mid)).normalize();
    const nub = furry(ellipsoidGeo(0.07, 0.07, 0.13, 32, 24), LOOK.fur, { len: 0.04, droop: 0 });
    nub.position.copy(new THREE.Vector3(...hand).add(dir.clone().multiplyScalar(0.2)));
    nub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir); hugo.add(nub);
  }
}

/* ---------------------------------------------------------------- props */

if (P.laptop) {
  // He sits behind it, as anyone does: the keyboard on his side, the lid's back — with the Alto
  // logo — toward us.
  const hingeZ = 1.22, baseY = -0.92;
  const base = add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.045, 0.46), M.alu)); base.position.set(0, baseY, hingeZ - 0.23);
  const keys = add(new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.01, 0.25), M.keys)); keys.position.set(0, baseY + 0.027, hingeZ - 0.28);
  const lid = new THREE.Group(); lid.position.set(0, baseY + 0.022, hingeZ); lid.rotation.x = 0.2; add(lid);
  const lidBox = add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.03), M.alu), lid); lidBox.position.set(0, 0.25, 0);
  const screen = add(new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.42), M.screen), lid); screen.position.set(0, 0.26, -0.016); screen.rotation.y = Math.PI;
  const emblem = altoEmblem(); emblem.scale.setScalar(0.0056); emblem.position.set(0, 0.26, 0.016); lid.add(emblem);
}
if (P.extra === 'sound') {
  // Listening: sound coming in, by the raised arm.
  [0.12, 0.22, 0.32].forEach((r, i) => {
    const k = (PH + i / 3) % 1;
    const m = new THREE.MeshStandardMaterial({ color: 0x2dd4bf, emissive: 0x2dd4bf, emissiveIntensity: 1.4, transparent: true, opacity: 0.25 + 0.7 * (1 - Math.abs(k - 0.5) * 2) });
    const a = float(new THREE.Mesh(new THREE.TorusGeometry(r, 0.022, 12, 32, Math.PI * 0.6), m)); a.position.set(1.12, 0.62, 0.3); a.rotation.z = -Math.PI * 0.3;
  });
}
if (P.extra === 'thought') [[0.72, 1.18, 0.05], [0.9, 1.36, 0.07], [1.12, 1.56, 0.095]].forEach(([x, y, r], i) => {
  const bob = Math.sin((PH + i * 0.22) * TAU) * 0.04;
  float(cap([x, y + bob, 0.2], r * (1 + 0.12 * Math.sin((PH + i * 0.3) * TAU)), M.gold));
});
if (P.extra === 'coffee') {
  const sip = P.sip ?? 0;
  const mug = new THREE.Group(); mug.position.set(0.4 - sip * 0.14, -0.14 + sip * 0.16, 0.95 + sip * 0.04); mug.rotation.set(0.1, -0.3, sip * 0.5); mug.scale.setScalar(1.05); add(mug);
  const cup = add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.32, 40, 1, true), M.paper), mug); cup.material.side = THREE.DoubleSide;
  const coffee = add(new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), new THREE.MeshPhysicalMaterial({ color: 0x5b3a22, roughness: 0.3 })), mug); coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.13;
  const handle = add(new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.025, 12, 24), M.paper), mug); handle.position.set(0.18, 0, 0); handle.rotation.y = Math.PI / 2;
  const band = add(new THREE.Mesh(new THREE.CylinderGeometry(0.168, 0.158, 0.06, 40, 1, true), M.gold), mug); band.position.y = -0.02;
  for (let i = 0; i < 3; i++) {
    const t = (PH + i / 3) % 1;
    const wisp = tube([[0, 0, 0], [0.04 * Math.sin(t * TAU), 0.12, 0], [-0.04, 0.24, 0], [0.03, 0.34, 0]], 0.016, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 * (1 - t) }));
    wisp.position.set(0.38 + (i - 1) * 0.07, 0.04 + t * 0.3, 0.98); float(wisp);
  }
}
if (P.extra === 'document') {
  const doc = new THREE.Group(); doc.position.set(0, -0.42, 1.05); doc.rotation.set(-0.35, 0, 0); add(doc);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.78, 0.012), M.paper), doc);
  [0.24, 0.14, 0.05, -0.04, -0.13].forEach((y, i) => { const l = add(new THREE.Mesh(new THREE.BoxGeometry(i === 0 ? 0.34 : 0.45, 0.024, 0.004), i === 0 ? M.gold : M.cardLine), doc); l.position.set(i === 0 ? -0.04 : 0, y, 0.01); });
  const seal = add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.016, 32), M.gold), doc); seal.rotation.x = Math.PI / 2; seal.position.set(0.18, -0.27, 0.012);
}
if (P.extra === 'envelope') {
  const out = Math.max(0, Math.sin(PH * TAU)) * 0.1;
  const env = new THREE.Group(); env.position.set(1.32 + out, -0.02 + Math.sin(PH * TAU * 2) * 0.025, 0.72); env.rotation.set(0.1, -0.5, -0.15 + Math.sin(PH * TAU * 2) * 0.07); add(env);
  // Cream paper with a gold edge: plain white vanished against the light theme.
  add(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.31, 0.02), M.gold), env);
  const sheet = add(new THREE.Mesh(new THREE.BoxGeometry(0.41, 0.28, 0.026), new THREE.MeshPhysicalMaterial({ color: 0xfff1d6, roughness: 0.6 })), env); sheet.position.z = 0.002;
  add(tube([[-0.19, 0.13, 0.018], [0, -0.02, 0.018], [0.19, 0.13, 0.018]], 0.013, M.gold), env);
}
if (P.extra === 'confetti') {
  const colors = [0xe3bd5f, 0x2dd4bf, 0xf28b82, 0xa78bfa, 0xe3bd5f, 0x2dd4bf];
  [[-1.25, 1.45, 0.2], [1.3, 1.55, 0.1], [-0.65, 1.75, -0.2], [0.7, 1.82, 0.3], [-1.55, 0.6, 0.5], [1.6, 0.75, 0.4]].forEach((p, i) => {
    const c = float(new THREE.Mesh(i % 2 ? new THREE.BoxGeometry(0.08, 0.18, 0.02) : new THREE.OctahedronGeometry(0.09), new THREE.MeshPhysicalMaterial({ color: colors[i], metalness: i % 3 === 0 ? 1 : 0, roughness: 0.3 })));
    const fall = ((PH + i / 6) % 1) * 0.5;
    c.position.set(p[0], p[1] - fall, p[2]); c.rotation.set(i + PH * TAU, i * 0.7 + PH * TAU, i * 1.3);
  });
}

// Whole-body motion.
if (POSE === 'working') { hugo.position.y = Math.abs(Math.sin(PH * TAU * 2)) * 0.025; hugo.rotation.x = Math.sin(PH * TAU * 2) * 0.02; }
if (POSE === 'celebrate') hugo.position.y = Math.abs(Math.sin(PH * TAU)) * 0.14;
if (POSE === 'listening') hugo.rotation.z = Math.sin(PH * TAU) * 0.04;
if (POSE === 'talking') { hugo.position.y = Math.abs(Math.sin(PH * TAU * 2)) * 0.02; hugo.rotation.z = Math.sin(PH * TAU) * 0.025; }
if (POSE === 'hello') hugo.position.y = Math.abs(Math.sin(PH * TAU)) * 0.025;
if (POSE === 'offline') hugo.scale.setScalar(1 + Math.sin(PH * TAU) * 0.012);

hugo.rotation.y = POSE === 'face' ? -0.08 : -0.2; // a gentle three-quarter view, as in the references

async function finish() {
  if (P.extra === 'zz') {
    const font = await new FontLoader().loadAsync('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json');
    [['z', 0.8, 1.4, 0.24], ['z', 1.1, 1.72, 0.18]].forEach(([s, x, y, size], i) => {
      const g = new TextGeometry(s, { font, size, depth: 0.05, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008 });
      const drift = ((PH + i * 0.5) % 1) * 0.16;
      const m = float(new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ color: 0xeaf2fb, roughness: 0.4 }))); m.position.set(x + drift * 0.4, y + drift, 0.2);
    });
  }
  renderer.render(scene, camera);
  window.__done = true;
}
window.exportGLB = () => new Promise((resolve) => new GLTFExporter().parse(scene, (glb) => resolve(Array.from(new Uint8Array(glb))), (e) => resolve(String(e)), { binary: true }));
finish();
