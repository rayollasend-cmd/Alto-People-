// Hugo in 3D — a soft vinyl toy: navy body turned from his 2D silhouette, gold compass tuft,
// metal headphones (on = working, around the neck = not), mitten hands, and a pose per state.
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

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(2);
renderer.setSize(SIZE, SIZE);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
if (POSE === 'face') { camera.position.set(0, 0.38, 6.3); camera.lookAt(0, 0.3, 0); }
else { camera.position.set(0, 0.35, 8.2); camera.lookAt(0, -0.05, 0); }
if (BG) scene.background = new THREE.Color(BG);

// Lights: warm key, cool rim from behind, soft fill.
const key = new THREE.DirectionalLight(0xfff1dc, 2.4); key.position.set(3, 5, 5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 8; key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
scene.add(key);
const rim = new THREE.DirectionalLight(0x8ab8ff, 3.0); rim.position.set(-4, 2.5, -4); scene.add(rim);
const rim2 = new THREE.DirectionalLight(0xffe2a8, 1.2); rim2.position.set(4, 1.5, -3); scene.add(rim2);
const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-3, 0, 5); scene.add(fill);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: POSE === 'face' ? 0 : 0.28 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -1.13; ground.receiveShadow = true; scene.add(ground);

const offline = POSE === 'offline';
const M = {
  body: new THREE.MeshPhysicalMaterial({ color: offline ? 0x5d6878 : 0x132c5e, roughness: 0.34, clearcoat: 0.9, clearcoatRoughness: 0.2, sheen: 0.3, sheenColor: new THREE.Color(offline ? 0x9aa4b2 : 0x5f7fc4) }),
  arm: new THREE.MeshPhysicalMaterial({ color: offline ? 0x566070 : 0x1b3a73, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
  mitt: new THREE.MeshPhysicalMaterial({ color: offline ? 0xc3cad4 : 0xf2f6fb, roughness: 0.55, sheen: 0.6, sheenColor: new THREE.Color(0xffffff) }),
  gold: new THREE.MeshPhysicalMaterial({ color: offline ? 0xa79f87 : 0xf0c862, metalness: 1, roughness: 0.22, clearcoat: 0.4, envMapIntensity: 1.8 }),
  silver: new THREE.MeshPhysicalMaterial({ color: 0xd3dde9, metalness: 0.9, roughness: 0.25, envMapIntensity: 1.6 }),
  cushion: new THREE.MeshPhysicalMaterial({ color: 0x14233f, roughness: 0.9, sheen: 0.5, sheenColor: new THREE.Color(0x3a5a96) }),
  eye: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.15, clearcoat: 1 }),
  pupil: new THREE.MeshPhysicalMaterial({ color: 0x0a1428, roughness: 0.2, clearcoat: 1 }),
  glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  line: new THREE.MeshPhysicalMaterial({ color: offline ? 0xd5dbe3 : 0xeaf2fb, roughness: 0.4 }),
  cheek: new THREE.MeshPhysicalMaterial({ color: 0xf28b82, roughness: 0.7, transparent: true, opacity: 0.75 }),
  mouth: new THREE.MeshPhysicalMaterial({ color: 0x0a1428, roughness: 0.6 }),
  tongue: new THREE.MeshPhysicalMaterial({ color: 0xf28b82, roughness: 0.5 }),
  teal: new THREE.MeshStandardMaterial({ color: 0x2dd4bf, emissive: 0x2dd4bf, emissiveIntensity: 2.2 }),
  micOff: new THREE.MeshPhysicalMaterial({ color: 0xc9d5e3, metalness: 0.6, roughness: 0.35 }),
  alu: new THREE.MeshPhysicalMaterial({ color: 0x5f6b7c, metalness: 0.75, roughness: 0.34 }),
  paper: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.6 }),
  keys: new THREE.MeshPhysicalMaterial({ color: 0x252d3a, roughness: 0.6 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x0b1832, emissive: 0x1f9a8f, emissiveIntensity: 0.9 }),
  disc: new THREE.MeshPhysicalMaterial({ color: 0x6d93c4, roughness: 0.35, clearcoat: 0.6 }),
};

const hugo = new THREE.Group();
scene.add(hugo);
const add = (mesh, parent = hugo) => { mesh.castShadow = true; parent.add(mesh); return mesh; };

// Body: a lathe of his outline — wider below, rounded top, softly flat base.
const profile = [];
for (let i = 0; i <= 64; i++) {
  const t = i / 64; // 0 bottom → 1 top
  const a = t * Math.PI;
  let r = Math.sin(a) * (1.08 - 0.16 * t);
  let y = -Math.cos(a) * 1.0;
  if (y < -0.86) y = -0.86 + (y + 0.86) * 0.35;
  profile.push(new THREE.Vector2(Math.max(r, 0.0001), y));
}
const bodyGeo = new THREE.LatheGeometry(profile, 128);
bodyGeo.scale(1, 1, 0.9);
const body = add(new THREE.Mesh(bodyGeo, M.body));
body.receiveShadow = true;

// Points on the body's front surface (for the face), found by a ray from the front.
const ray = new THREE.Raycaster();
function onBody(x, y, lift = 0) {
  ray.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
  const hit = ray.intersectObject(body)[0];
  const n = hit.face.normal.clone();
  return { p: hit.point.clone().add(n.clone().multiplyScalar(lift)), n };
}
function place(mesh, x, y, lift = 0) {
  const { p, n } = onBody(x, y, lift);
  mesh.position.copy(p);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  return add(mesh);
}
const ellipsoid = (rx, ry, rz, mat) => { const g = new THREE.SphereGeometry(1, 48, 32); g.scale(rx, ry, rz); return new THREE.Mesh(g, mat); };
const arc = (r, tube, angle, mat) => new THREE.Mesh(new THREE.TorusGeometry(r, tube, 16, 48, angle), mat);
const tube = (pts, radius, mat) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), 64, radius, 16, false), mat);
const cap = (p, r, mat) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat); m.position.set(...p); return m; };

// Tuft: the Alto compass star, in gold.
const star = new THREE.Shape();
[[0, 0.36], [0.07, 0.08], [0.24, 0], [0.07, -0.08], [0, -0.22], [-0.07, -0.08], [-0.24, 0], [-0.07, 0.08]].forEach(([x, y], i) => (i ? star.lineTo(x, y) : star.moveTo(x, y)));
star.closePath();
const starGeo = new THREE.ExtrudeGeometry(star, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 4 });
starGeo.center();
const tuft = add(new THREE.Mesh(starGeo, M.gold));
tuft.scale.setScalar(1.3);
tuft.position.set(0, 1.12, 0.1);
tuft.rotation.x = -0.18;

// The Alto logo, raised in gold: compass ring and its four points, the blue disc, the A peak and its horizon lines.
// Drawn in the logo's own 64-unit space (apps/web/public/favicon.svg), y flipped, centred on 0.
function altoEmblem() {
  const g = new THREE.Group();
  const pt = (x, y) => new THREE.Vector2(x - 32, 32 - y);
  const shape = (pts, holes = []) => { const sh = new THREE.Shape(pts.map(([x, y]) => pt(x, y))); holes.forEach((h) => sh.holes.push(new THREE.Path(h.map(([x, y]) => pt(x, y))))); return sh; };
  const raise = (sh, depth, mat, z = 0) => { const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.35, bevelSegments: 3, curveSegments: 24 }), mat); m.position.z = z; m.castShadow = true; g.add(m); return m; };
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(18.6, 18.6, 1, 64), M.disc); disc.rotation.x = Math.PI / 2; disc.position.z = 0.5; g.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(20, 1.8, 20, 96), M.gold); ring.position.z = 1.2; g.add(ring);
  // Compass points, a little bolder than the favicon's so they read on a lid.
  raise(shape([[32, 1], [28, 15], [32, 12], [36, 15]]), 1.6, M.gold);
  raise(shape([[32, 63], [28, 49], [32, 52], [36, 49]]), 1.6, M.gold);
  raise(shape([[1, 32], [15, 28], [12, 32], [15, 36]]), 1.6, M.gold);
  raise(shape([[63, 32], [49, 28], [52, 32], [49, 36]]), 1.6, M.gold);
  // The peak: an A with its cut-out and bar.
  raise(shape([[32, 17], [45, 41], [19, 41]], [[[32, 26], [24, 39.5], [40, 39.5]]]), 2.2, M.gold, 1);
  raise(shape([[27, 35], [37, 35], [37, 37], [27, 37]]), 2.2, M.gold, 1);
  // Horizon lines under the peak (logo.png).
  raise(shape([[22, 43.5], [42, 43.5], [42, 45.3], [22, 45.3]]), 1.2, M.gold, 1);
  raise(shape([[25.5, 47.5], [38.5, 47.5], [38.5, 49.1], [25.5, 49.1]]), 1.2, M.gold, 1);
  return g;
}

// The pose.
const P = {
  hello: { phones: 'neck', eyes: 'open', look: [0.02, 0.01], mouth: 'open', armL: 'rest', armR: 'wave' },
  working: { phones: 'on', mic: true, eyes: 'focus', look: [0, -0.04], mouth: 'none', armL: 'typeL', armR: 'typeR', laptop: true },
  listening: { phones: 'on', mic: true, eyes: 'open', look: [-0.035, 0], mouth: 'smile', armL: 'rest', armR: 'ear' },
  thinking: { phones: 'on', mic: false, eyes: 'open', look: [0.035, 0.045], mouth: 'hmm', armL: 'rest', armR: 'chin', extra: 'thought' },
  handoff: { phones: 'on', mic: false, eyes: 'open', look: [0.05, 0], mouth: 'smile', armL: 'rest', armR: 'give', extra: 'envelope' },
  celebrate: { phones: 'neck', eyes: 'happy', mouth: 'open', armL: 'up', armR: 'up', extra: 'confetti' },
  offline: { phones: 'neck', eyes: 'closed', mouth: 'o', armL: 'down', armR: 'down', extra: 'zz', noCheeks: true },
  coffee: { phones: 'neck', eyes: 'content', mouth: 'smile', armL: 'rest', armR: 'mug', extra: 'coffee' },
  reading: { phones: 'on', mic: false, eyes: 'open', look: [0.03, -0.05], mouth: 'smile', armL: 'holdL', armR: 'holdR', extra: 'document' },
  pointing: { phones: 'on', mic: false, eyes: 'open', look: [0.06, 0.01], mouth: 'open', armL: 'rest', armR: 'point' },
  face: { phones: 'on', mic: false, eyes: 'open', look: [0.01, 0.0], mouth: 'smile', armL: null, armR: null },
}[POSE];
if (params.get('blink') === '1') P.eyes = 'closed';

// Eyes.
for (const side of [-1, 1]) {
  const x = side * 0.3, y = 0.16;
  if (P.eyes === 'content') P.eyes = 'happy';
  if (P.eyes === 'happy' || P.eyes === 'closed') {
    const a = arc(0.12, 0.032, Math.PI, M.line);
    place(a, x, y + (P.eyes === 'happy' ? -0.03 : 0.02), 0.01);
    if (P.eyes === 'closed') a.rotateZ(Math.PI);
    continue;
  }
  const ry = P.eyes === 'focus' ? 0.15 : 0.2;
  place(ellipsoid(0.16, ry, 0.07, M.eye), x, y, -0.02);
  const [lx, ly] = P.look || [0, 0];
  place(ellipsoid(0.085, Math.min(0.11, ry - 0.05), 0.05, M.pupil), x + lx + 0.015, y + ly - 0.01, 0.035);
  place(cap([0, 0, 0], 0.028, M.glint), x + lx + 0.05, y + ly + 0.05, 0.075);
}
// Cheeks.
if (!P.noCheeks) for (const side of [-1, 1]) place(ellipsoid(0.11, 0.06, 0.02, M.cheek), side * 0.52, -0.12, 0.0);
// Mouth.
if (P.mouth === 'smile') { const m = arc(0.12, 0.026, Math.PI, M.line); place(m, 0, -0.14, 0.01); m.rotateZ(Math.PI); }
if (P.mouth === 'open') {
  const g = new THREE.CircleGeometry(0.15, 40, Math.PI, Math.PI); const m = new THREE.Mesh(g, M.mouth); place(m, 0, -0.1, 0.012);
  const rimArc = arc(0.15, 0.022, Math.PI, M.line); place(rimArc, 0, -0.1, 0.014); rimArc.rotateZ(Math.PI);
  place(ellipsoid(0.07, 0.035, 0.01, M.tongue), 0, -0.2, 0.02);
}
if (P.mouth === 'hmm') { place(tube([[-0.07, 0, 0], [0.02, 0.008, 0], [0.09, 0.03, 0]], 0.022, M.line), 0.04, -0.15, 0.015); }
if (P.mouth === 'o') { place(arc(0.045, 0.02, Math.PI * 2, M.line), 0, -0.15, 0.012); }

// Headphones.
if (P.phones === 'on') {
  const band = add(arc(1.06, 0.065, Math.PI, M.silver)); band.position.set(0, 0.06, 0.05);
  for (const side of [-1, 1]) {
    const cup = add(new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.2, 48), M.gold)); cup.rotation.z = Math.PI / 2; cup.position.set(side * 1.07, 0.04, 0.05);
    const pad = add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.075, 16, 48), M.cushion)); pad.rotation.y = Math.PI / 2; pad.position.set(side * 0.96, 0.04, 0.05);
    const capm = add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 40), M.silver)); capm.rotation.z = Math.PI / 2; capm.position.set(side * 1.18, 0.04, 0.05);
  }
  add(tube([[-1.05, -0.18, 0.18], [-0.95, -0.46, 0.5], [-0.62, -0.5, 0.78], [-0.4, -0.38, 0.86]], 0.026, M.silver));
  const mic = add(cap([-0.37, -0.37, 0.88], 0.075, P.mic ? M.teal : M.micOff));
  if (P.mic) { const glow = new THREE.PointLight(0x2dd4bf, 0.5, 1.4); glow.position.set(-0.45, -0.45, 1.2); scene.add(glow); }
} else {
  // Around the neck (as in the 2D Hugo): the band hangs under his chin, the cups up by his jaw.
  add(tube([[-0.74, -0.36, 0.66], [-0.5, -0.62, 0.86], [0, -0.72, 0.98], [0.5, -0.62, 0.86], [0.74, -0.36, 0.66]], 0.05, M.silver));
  for (const side of [-1, 1]) {
    const cup = add(new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.14, 40), M.gold));
    cup.position.set(side * 0.8, -0.3, 0.6); cup.rotation.set(Math.PI / 2, 0, side * 0.9);
    cup.rotateX(-0.15);
  }
}

// Arms and mitts: a shoulder on each side, a bent tube to the hand.
const SH = { L: [-0.92, -0.32, 0.18], R: [0.92, -0.32, 0.18] };
const ARMS = {
  rest: (s) => [[s * 1.12, -0.6, 0.3], [s * 1.1, -0.86, 0.48]],
  down: (s) => [[s * 1.12, -0.62, 0.3], [s * 1.12, -0.95, 0.42]],
  wave: (s) => [[s * 1.35, -0.1, 0.35], [s * 1.42, 0.45, 0.45]],
  up: (s) => [[s * 1.3, 0.05, 0.3], [s * 1.36, 0.62, 0.35]],
  ear: (s) => [[s * 1.3, -0.35, 0.5], [s * 1.28, 0.02, 0.45]],
  chin: (s) => [[s * 1.0, -0.72, 0.7], [s * 0.38, -0.36, 0.98]],
  give: (s) => [[s * 1.3, -0.45, 0.55], [s * 1.62, -0.36, 0.72]],
  typeL: (s) => [[s * 0.98, -0.72, 0.8], [s * 0.34, -0.9, 1.2]],
  typeR: (s) => [[s * 0.98, -0.72, 0.8], [s * 0.34, -0.9, 1.2]],
  mug: (s) => [[s * 1.12, -0.62, 0.62], [s * 0.62, -0.42, 1.08]],
  holdL: (s) => [[s * 1.05, -0.66, 0.6], [s * 0.42, -0.62, 1.22]],
  holdR: (s) => [[s * 1.05, -0.66, 0.6], [s * 0.42, -0.62, 1.22]],
  point: (s) => [[s * 1.35, -0.2, 0.5], [s * 1.72, 0.1, 0.62]],
};
// Animation: the wave swings, typing hands bob in turn, celebrating arms pump.
function animate(name, side, pts) {
  const [mid, hand] = pts;
  if (name === 'wave') { const a = Math.sin(PH * TAU) * 0.22; return [[mid[0] + a * 0.3, mid[1], mid[2]], [hand[0] + a, hand[1] - Math.abs(a) * 0.25, hand[2]]]; }
  if (name === 'typeL' || name === 'typeR') { const d = Math.sin(PH * TAU * 2 + (side < 0 ? 0 : Math.PI)) * 0.05; return [mid, [hand[0], hand[1] + Math.max(0, d), hand[2]]]; }
  if (name === 'up') { const d = Math.sin(PH * TAU) * 0.08; return [[mid[0], mid[1] + d, mid[2]], [hand[0], hand[1] + d * 1.6, hand[2]]]; }
  if (name === 'point') { const d = Math.sin(PH * TAU) * 0.05; return [mid, [hand[0] + d, hand[1] + d * 0.5, hand[2]]]; }
  return pts;
}
for (const [name, side] of [['armL', -1], ['armR', 1]]) {
  if (!P[name]) continue;
  const [mid, hand] = animate(P[name], side, ARMS[P[name]](side));
  const shoulder = SH[side < 0 ? 'L' : 'R'];
  add(tube([shoulder, mid, hand], 0.1, M.arm));
  const mitt = add(ellipsoid(0.18, 0.17, 0.16, M.mitt)); mitt.position.set(...hand);
  if (P[name] === 'point') {
    // A pointing finger, out along the arm's direction.
    const dir = new THREE.Vector3(...hand).sub(new THREE.Vector3(...mid)).normalize();
    const finger = add(ellipsoid(0.055, 0.055, 0.15, M.mitt));
    finger.position.copy(new THREE.Vector3(...hand).add(dir.clone().multiplyScalar(0.2)));
    finger.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  }
}

// Props.
if (P.laptop) {
  // He sits behind it, as anyone does: the keyboard on his side, the screen facing him,
  // and the lid's back — with the Alto logo — toward us.
  const hingeZ = 1.6, baseY = -0.98;
  const base = add(new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.06, 0.66), M.alu)); base.position.set(0, baseY, hingeZ - 0.33);
  const keys = add(new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.012, 0.36), M.keys)); keys.position.set(0, baseY + 0.034, hingeZ - 0.4);
  const lid = new THREE.Group(); lid.position.set(0, baseY + 0.03, hingeZ); lid.rotation.x = 0.16; add(lid);
  const lidBox = add(new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.8, 0.045), M.alu), lid); lidBox.position.set(0, 0.4, 0);
  const screen = add(new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.68), M.screen), lid); screen.position.set(0, 0.41, -0.024); screen.rotation.y = Math.PI;
  const emblem = altoEmblem(); emblem.scale.setScalar(0.0082); emblem.position.set(0, 0.41, 0.024); lid.add(emblem);
  const screenGlow = new THREE.PointLight(0x2dd4bf, 1.3, 1.9); screenGlow.position.set(0, -0.42, 1.25); scene.add(screenGlow);
}
if (P.extra === 'thought') [[0.95, 0.95, 0.06], [1.2, 1.2, 0.085], [1.5, 1.48, 0.11]].forEach(([x, y, r], i) => {
  const bob = Math.sin((PH + i * 0.22) * TAU) * 0.05;
  add(cap([x, y + bob, 0.3], r * (1 + 0.12 * Math.sin((PH + i * 0.3) * TAU)), M.gold));
});
if (P.extra === 'coffee') {
  const mug = new THREE.Group(); mug.position.set(0.58, -0.36, 1.18); mug.rotation.set(0.1, -0.3, 0); mug.scale.setScalar(1.3); add(mug);
  const cup = add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.32, 40, 1, true), M.paper), mug); cup.material.side = THREE.DoubleSide;
  add(new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), new THREE.MeshPhysicalMaterial({ color: 0x5b3a22, roughness: 0.3 })), mug).rotation.x = -Math.PI / 2;
  mug.children[mug.children.length - 1].position.y = 0.13;
  const handle = add(new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.025, 12, 24), M.paper), mug); handle.position.set(0.18, 0, 0); handle.rotation.y = Math.PI / 2;
  const band = add(new THREE.Mesh(new THREE.CylinderGeometry(0.168, 0.158, 0.06, 40, 1, true), M.gold), mug); band.position.y = -0.02;
  for (let i = 0; i < 3; i++) {
    const t = (PH + i / 3) % 1;
    const wisp = tube([[0, 0, 0], [0.04 * Math.sin(t * TAU), 0.12, 0], [-0.04, 0.24, 0], [0.03, 0.34, 0]], 0.018, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 * (1 - t) }));
    wisp.position.set(0.55 + (i - 1) * 0.07, -0.18 + t * 0.35, 1.2); add(wisp);
  }
}
if (P.extra === 'document') {
  const doc = new THREE.Group(); doc.position.set(0, -0.48, 1.3); doc.rotation.set(-0.35, 0, 0); add(doc);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.98, 0.015), M.paper), doc);
  [0.3, 0.18, 0.06, -0.06, -0.18].forEach((y, i) => { const l = add(new THREE.Mesh(new THREE.BoxGeometry(i === 0 ? 0.42 : 0.56, 0.028, 0.005), i === 0 ? M.gold : new THREE.MeshPhysicalMaterial({ color: 0xb6c3d3, roughness: 0.6 })), doc); l.position.set(i === 0 ? -0.05 : 0, y, 0.012); });
  const seal = add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 32), M.gold), doc); seal.rotation.x = Math.PI / 2; seal.position.set(0.22, -0.34, 0.015);
}
if (POSE === 'working') hugo.position.y = Math.abs(Math.sin(PH * TAU * 2)) * 0.012;
if (P.extra === 'envelope') {
  const env = new THREE.Group(); env.position.set(1.72, -0.12, 0.8); env.rotation.set(0.1, -0.5, -0.15); add(env);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.32, 0.03), M.paper), env);
  add(tube([[-0.21, 0.14, 0.02], [0, -0.02, 0.02], [0.21, 0.14, 0.02]], 0.012, M.gold), env);
}
if (P.extra === 'confetti') {
  const colors = [0xe3bd5f, 0x2dd4bf, 0xf28b82, 0xa78bfa, 0xe3bd5f, 0x2dd4bf];
  [[-1.3, 1.25, 0.2], [1.25, 1.35, 0.1], [-0.7, 1.55, -0.2], [0.65, 1.6, 0.3], [-1.6, 0.4, 0.5], [1.65, 0.55, 0.4]].forEach((p, i) => {
    const c = add(new THREE.Mesh(i % 2 ? new THREE.BoxGeometry(0.08, 0.18, 0.02) : new THREE.OctahedronGeometry(0.09), new THREE.MeshPhysicalMaterial({ color: colors[i], metalness: i % 3 === 0 ? 1 : 0, roughness: 0.3 })));
    const fall = ((PH + i / 6) % 1) * 0.5;
    c.position.set(p[0], p[1] - fall, p[2]); c.rotation.set(i + PH * TAU, i * 0.7 + PH * TAU, i * 1.3);
  });
}

hugo.rotation.y = POSE === 'face' ? -0.12 : -0.28; // a three-quarter view, so he reads as a 3D object

async function finish() {
  if (P.extra === 'zz') {
    const font = await new FontLoader().loadAsync('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json');
    [['z', 0.95, 1.05, 0.26], ['z', 1.28, 1.42, 0.2]].forEach(([s, x, y, size], i) => {
      const g = new TextGeometry(s, { font, size, depth: 0.05, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008 });
      const drift = ((PH + i * 0.5) % 1) * 0.18;
      const m = add(new THREE.Mesh(g, M.line)); m.position.set(x + drift * 0.4, y + drift, 0.2);
    });
  }
  renderer.render(scene, camera);
  window.__done = true;
}
window.exportGLB = () => new Promise((resolve) => new GLTFExporter().parse(scene, (glb) => resolve(Array.from(new Uint8Array(glb))), (e) => resolve(String(e)), { binary: true }));
finish();
