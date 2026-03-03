import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const TILE  = 3;       // meters per tile
const WORLD = 64;      // grid size
const EYE   = 1.7;     // eye height (m)
const SPEED  = 6;      // movement speed (m/s)

// Tile IDs
const T = Object.freeze({
  DEEP: 0, WATER: 1, SAND: 2, GRASS: 3,
  FOREST: 4, MOUND: 5, DFLOOR: 6, DWALL: 7, PATH: 8
});

// Zelda LTTP-inspired palette
const COLOR = {
  DEEP:   0x0d5a9e,
  WATER:  0x1e8bc3,
  SAND:   0xd4b483,
  GRASS:  0x5da832,
  FOREST: 0x2d6e1f,
  MOUND:  0x8b8b8b,
  DFLOOR: 0x6b4f3a,
  DWALL:  0x4a3628,
  PATH:   0xb08060,
  TRUNK:  0x5c3d1e,
  LEAF:   0x1a5c0e,
  STONE:  0x7a7a7a,
  SKY:    0x89d4f5,
};

// ─────────────────────────────────────────────────────────────
// NOISE
// ─────────────────────────────────────────────────────────────
function hash(x, y, s) {
  const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const ux = xf * xf * (3 - 2 * xf), uy = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s),     b = hash(xi+1, yi, s);
  const c = hash(xi, yi+1, s),   d = hash(xi+1, yi+1, s);
  return a + (b-a)*ux + (c-a)*uy + (a-b-c+d)*ux*uy;
}

function fbm(x, y, oct, s) {
  let v = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < oct; i++) {
    v += vnoise(x*freq, y*freq, s + i*137) * amp;
    max += amp; amp *= 0.5; freq *= 2;
  }
  return v / max;
}

// ─────────────────────────────────────────────────────────────
// WORLD GENERATION
// ─────────────────────────────────────────────────────────────
let worldMap = [];
let treeList = [], rockList = [];
let worldSeed = 0;
const cloudGroups = [];

function generateMap() {
  worldSeed = Math.random() * 999;
  worldMap  = [];

  for (let z = 0; z < WORLD; z++) {
    worldMap[z] = [];
    for (let x = 0; x < WORLD; x++) {
      const nx = x / WORLD, nz = z / WORLD;
      let h = fbm(nx * 4, nz * 4, 7, worldSeed);
      // island falloff
      const d = Math.hypot(nx - 0.5, nz - 0.5) * 2.6;
      h -= d * 0.38;
      if      (h < 0.07) worldMap[z][x] = T.DEEP;
      else if (h < 0.21) worldMap[z][x] = T.WATER;
      else if (h < 0.30) worldMap[z][x] = T.SAND;
      else if (h < 0.53) worldMap[z][x] = T.GRASS;
      else if (h < 0.69) worldMap[z][x] = T.FOREST;
      else               worldMap[z][x] = T.MOUND;
    }
  }

  carvePaths();
  placeDungeons();

  treeList = []; rockList = [];
  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      const t = worldMap[z][x];
      if (t === T.FOREST && hash(x, z, worldSeed+1) > 0.28) treeList.push([x, z]);
      if ((t === T.MOUND || t === T.GRASS) && hash(x, z, worldSeed+2) > 0.87) rockList.push([x, z]);
    }
  }
}

function carvePaths() {
  const cx = WORLD >> 1, cz = WORLD >> 1;
  const LAND = new Set([T.GRASS, T.FOREST, T.SAND, T.MOUND]);
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    for (let step = 0; ; step++) {
      const x = cx + dx * step, z = cz + dz * step;
      if (x < 0 || x >= WORLD || z < 0 || z >= WORLD) break;
      if (LAND.has(worldMap[z][x])) worldMap[z][x] = T.PATH;
    }
  }
}

function placeDungeons() {
  for (let i = 0; i < 5; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const w  = 6 + Math.floor(hash(i, attempt,   worldSeed+3) * 6);
      const h  = 6 + Math.floor(hash(i, attempt+1, worldSeed+4) * 5);
      const rx = 3 + Math.floor(hash(i, attempt+2, worldSeed+5) * (WORLD - w - 5));
      const rz = 3 + Math.floor(hash(i, attempt+3, worldSeed+6) * (WORLD - h - 5));
      const t  = worldMap[rz]?.[rx];
      if (t !== T.GRASS && t !== T.FOREST) continue;
      for (let z = rz; z < rz + h && z < WORLD; z++) {
        for (let x = rx; x < rx + w && x < WORLD; x++) {
          const wall = z===rz || z===rz+h-1 || x===rx || x===rx+w-1;
          worldMap[z][x] = wall ? T.DWALL : T.DFLOOR;
        }
      }
      worldMap[rz + h - 1][rx + Math.floor(w / 2)] = T.PATH;
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLOR.SKY);
scene.fog        = new THREE.Fog(COLOR.SKY, 28, 95);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.xr.enabled        = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// Camera rig (dolly) — move this for locomotion
const rig    = new THREE.Group();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 150);
camera.position.set(0, EYE, 0);
rig.add(camera);
scene.add(rig);

// Lighting
scene.add(new THREE.AmbientLight(0xcce8ff, 0.75));
const sun = new THREE.DirectionalLight(0xfff4c8, 1.2);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.near = 0.5; sc.far = 200;
sc.left = sc.bottom = -100; sc.right = sc.top = 100;
scene.add(sun);

// ─────────────────────────────────────────────────────────────
// SCENE BUILDING
// ─────────────────────────────────────────────────────────────
const GEO_FLOOR = new THREE.BoxGeometry(TILE, 0.3,  TILE);
const GEO_WALL  = new THREE.BoxGeometry(TILE, 3.5,  TILE);
const GEO_MOUND = new THREE.BoxGeometry(TILE, 2.0,  TILE);
const dummy      = new THREE.Object3D();

const TILE_MAT = {
  [T.DEEP]:   new THREE.MeshLambertMaterial({ color: COLOR.DEEP   }),
  [T.WATER]:  new THREE.MeshLambertMaterial({ color: COLOR.WATER  }),
  [T.SAND]:   new THREE.MeshLambertMaterial({ color: COLOR.SAND   }),
  [T.GRASS]:  new THREE.MeshLambertMaterial({ color: COLOR.GRASS  }),
  [T.FOREST]: new THREE.MeshLambertMaterial({ color: COLOR.FOREST }),
  [T.MOUND]:  new THREE.MeshLambertMaterial({ color: COLOR.MOUND  }),
  [T.DFLOOR]: new THREE.MeshLambertMaterial({ color: COLOR.DFLOOR }),
  [T.DWALL]:  new THREE.MeshLambertMaterial({ color: COLOR.DWALL  }),
  [T.PATH]:   new THREE.MeshLambertMaterial({ color: COLOR.PATH   }),
};

function buildScene() {
  // ── Tiles (InstancedMesh per type) ──────────────────────────
  const count = {};
  for (let z = 0; z < WORLD; z++)
    for (let x = 0; x < WORLD; x++)
      count[worldMap[z][x]] = (count[worldMap[z][x]] || 0) + 1;

  const imeshes = {}, iidx = {};
  for (const [tStr, n] of Object.entries(count)) {
    const t = +tStr;
    const geo = t === T.DWALL ? GEO_WALL : t === T.MOUND ? GEO_MOUND : GEO_FLOOR;
    const im = new THREE.InstancedMesh(geo, TILE_MAT[t], n);
    im.receiveShadow = true;
    im.castShadow    = (t === T.DWALL || t === T.MOUND);
    imeshes[t] = im; iidx[t] = 0;
    scene.add(im);
  }

  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      const t = worldMap[z][x];
      let y = 0;
      if (t === T.DEEP)  y = -0.4;
      if (t === T.WATER) y = -0.15;
      if (t === T.DWALL) y =  1.75;
      if (t === T.MOUND) y =  1.0;
      dummy.position.set(x * TILE + TILE/2, y, z * TILE + TILE/2);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      imeshes[t].setMatrixAt(iidx[t]++, dummy.matrix);
    }
  }
  for (const im of Object.values(imeshes)) im.instanceMatrix.needsUpdate = true;

  // ── Trees ────────────────────────────────────────────────────
  if (treeList.length) {
    const trunkIM  = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.22, 0.32, 1.8, 7),
      new THREE.MeshLambertMaterial({ color: COLOR.TRUNK }), treeList.length);
    const leavesIM = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.15, 2.8, 7),
      new THREE.MeshLambertMaterial({ color: COLOR.LEAF  }), treeList.length);
    trunkIM.castShadow = leavesIM.castShadow = true;

    treeList.forEach(([x, z], i) => {
      const wx = x * TILE + TILE/2, wz = z * TILE + TILE/2;
      dummy.position.set(wx, 1.05, wz);
      dummy.rotation.y = hash(x, z, worldSeed+7) * Math.PI * 2;
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      trunkIM.setMatrixAt(i, dummy.matrix);
      dummy.position.y = 2.9;
      dummy.updateMatrix();
      leavesIM.setMatrixAt(i, dummy.matrix);
    });
    trunkIM.instanceMatrix.needsUpdate  = true;
    leavesIM.instanceMatrix.needsUpdate = true;
    scene.add(trunkIM, leavesIM);
  }

  // ── Rocks ────────────────────────────────────────────────────
  if (rockList.length) {
    const rIM = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(0.38, 0),
      new THREE.MeshLambertMaterial({ color: COLOR.STONE }), rockList.length);
    rIM.castShadow = true;
    rockList.forEach(([x, z], i) => {
      dummy.position.set(x*TILE + TILE/2, 0.28, z*TILE + TILE/2);
      dummy.rotation.set(
        hash(x, z, worldSeed+8) * Math.PI,
        hash(x, z, worldSeed+9) * Math.PI, 0);
      dummy.scale.setScalar(0.5 + hash(x, z, worldSeed+10) * 0.9);
      dummy.updateMatrix();
      rIM.setMatrixAt(i, dummy.matrix);
    });
    rIM.instanceMatrix.needsUpdate = true;
    scene.add(rIM);
  }

  // ── Dungeon torches ──────────────────────────────────────────
  const torchMat  = new THREE.MeshLambertMaterial({ color: 0x5c3a1e });
  const flameMat  = new THREE.MeshLambertMaterial({ color: 0xff6600, emissive: 0xff3300, emissiveIntensity: 1 });
  const torchGeo  = new THREE.CylinderGeometry(0.06, 0.08, 0.7, 6);
  const flameGeo  = new THREE.SphereGeometry(0.12, 5, 4);
  const torches = [];

  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      if (worldMap[z][x] === T.DFLOOR && hash(x, z, worldSeed+20) > 0.92) {
        torches.push([x, z]);
      }
    }
  }

  if (torches.length) {
    const tIM = new THREE.InstancedMesh(torchGeo, torchMat, torches.length);
    const fIM = new THREE.InstancedMesh(flameGeo, flameMat, torches.length);
    torches.forEach(([x, z], i) => {
      dummy.position.set(x*TILE + TILE/2, 1.5, z*TILE + TILE/2);
      dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1);
      dummy.updateMatrix();
      tIM.setMatrixAt(i, dummy.matrix);
      dummy.position.y = 1.9;
      dummy.updateMatrix();
      fIM.setMatrixAt(i, dummy.matrix);
    });
    tIM.instanceMatrix.needsUpdate = true;
    fIM.instanceMatrix.needsUpdate = true;
    scene.add(tIM, fIM);

    // Point lights in dungeons (a few, not all — for perf)
    torches.slice(0, 20).forEach(([x, z]) => {
      const pl = new THREE.PointLight(0xff8800, 1.5, 8);
      pl.position.set(x*TILE + TILE/2, 1.9, z*TILE + TILE/2);
      scene.add(pl);
    });
  }

  // ── Clouds ───────────────────────────────────────────────────
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 });
  for (let i = 0; i < 18; i++) {
    const g = new THREE.Group();
    const n = 3 + Math.floor(hash(i, 0, worldSeed+11) * 3);
    for (let j = 0; j < n; j++) {
      const r = 2 + hash(i, j, worldSeed+12) * 3.5;
      const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 6, 5), cloudMat);
      blob.position.set(j * r * 1.3, hash(i, j, worldSeed+13) * 2, 0);
      g.add(blob);
    }
    g.position.set(
      hash(i, 0, worldSeed+14) * WORLD * TILE,
      30 + hash(i, 1, worldSeed+15) * 20,
      hash(i, 2, worldSeed+16) * WORLD * TILE
    );
    g.userData.spd = 0.4 + hash(i, 3, worldSeed+17) * 1.2;
    scene.add(g);
    cloudGroups.push(g);
  }

  // ── Sun sphere ───────────────────────────────────────────────
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(5, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff176 })
  );
  sunMesh.position.set(140, 180, 100);
  scene.add(sunMesh);
}

// ─────────────────────────────────────────────────────────────
// SPAWN PLAYER
// ─────────────────────────────────────────────────────────────
function spawnPlayer() {
  const cx = WORLD >> 1, cz = WORLD >> 1;
  const land = new Set([T.GRASS, T.PATH, T.SAND]);
  outer:
  for (let r = 0; r < WORLD / 2; r++) {
    for (let z = Math.max(0, cz-r); z <= Math.min(WORLD-1, cz+r); z++) {
      for (let x = Math.max(0, cx-r); x <= Math.min(WORLD-1, cx+r); x++) {
        if (land.has(worldMap[z]?.[x])) {
          rig.position.set(x * TILE + TILE/2, 0, z * TILE + TILE/2);
          break outer;
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CONTROLS — KEYBOARD + MOUSE
// ─────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup',   e => { delete keys[e.code]; });

let yaw = 0, pitch = 0, pointerLocked = false;

renderer.domElement.addEventListener('click', () => {
  if (!renderer.xr.isPresenting) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', e => {
  if (!pointerLocked) return;
  yaw   = (yaw - e.movementX * 0.002) % (Math.PI * 2);
  pitch = Math.max(-1.3, Math.min(1.3, pitch - e.movementY * 0.002));
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);
});

// ─────────────────────────────────────────────────────────────
// CONTROLS — VR CONTROLLERS
// ─────────────────────────────────────────────────────────────
function leftStick() {
  const session = renderer.xr.getSession();
  if (!session) return [0, 0];
  for (const src of session.inputSources) {
    if (src.gamepad && src.handedness === 'left') {
      const a = src.gamepad.axes;
      if (a.length >= 4) return [a[2], a[3]];
    }
  }
  return [0, 0];
}

renderer.xr.addEventListener('sessionstart', () => { camera.position.set(0, 0, 0); });
renderer.xr.addEventListener('sessionend',   () => { camera.position.set(0, EYE, 0); });

// ─────────────────────────────────────────────────────────────
// WEAPONS
// ─────────────────────────────────────────────────────────────
function createSword() {
  const g = new THREE.Group();

  // Blade
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.7, 0.008),
    new THREE.MeshLambertMaterial({ color: 0xd4d4d4 })
  );
  blade.position.y = 0.42;
  g.add(blade);

  // Edge highlight (white stripe along blade)
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(0.01, 0.7, 0.012),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  edge.position.set(0.02, 0.42, 0);
  g.add(edge);

  // Guard
  const guard = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.05, 0.025),
    new THREE.MeshLambertMaterial({ color: 0xffd700 })
  );
  g.add(guard);

  // Handle
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.019, 0.023, 0.2, 8),
    new THREE.MeshLambertMaterial({ color: 0x5c2a0e })
  );
  handle.position.y = -0.12;
  g.add(handle);

  // Pommel
  const pommel = new THREE.Mesh(
    new THREE.SphereGeometry(0.038, 8, 6),
    new THREE.MeshLambertMaterial({ color: 0xffd700 })
  );
  pommel.position.y = -0.24;
  g.add(pommel);

  // Rotate so blade points forward (-Z = trigger direction in grip space)
  g.rotation.x = Math.PI / 2;
  return g;
}

function createShield() {
  const g = new THREE.Group();

  // Body disc (blue)
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.04, 16),
    new THREE.MeshLambertMaterial({ color: 0x1a237e })
  );
  body.rotation.x = Math.PI / 2;
  g.add(body);

  // Gold rim
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.022, 8, 20),
    new THREE.MeshLambertMaterial({ color: 0xffd700 })
  );
  g.add(rim);

  // Triforce emblem (3 triangles)
  const triMat = new THREE.MeshLambertMaterial({
    color: 0xffc107, emissive: 0xff8800, emissiveIntensity: 0.4
  });
  for (const [ox, oy] of [[0, 0.08], [-0.055, -0.015], [0.055, -0.015]]) {
    const tri = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.02, 3), triMat);
    tri.rotation.x = -Math.PI / 2; // lay flat facing front of shield
    tri.position.set(ox, oy, -0.04);
    g.add(tri);
  }

  // Slight forward offset so it doesn't clip the controller model
  g.position.z = -0.05;
  return g;
}

// ── Controller setup ─────────────────────────────────────────
const ctrlFac = new XRControllerModelFactory();
const sword   = createSword();
const shield  = createShield();

for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(ctrlFac.createControllerModel(grip));
  rig.add(ctrl);
  rig.add(grip);

  // Attach weapon based on which hand this controller is
  ctrl.addEventListener('connected', (ev) => {
    if (ev.data.handedness === 'right') grip.add(sword);
    if (ev.data.handedness === 'left')  grip.add(shield);
  });
  ctrl.addEventListener('disconnected', () => {
    grip.remove(sword);
    grip.remove(shield);
  });
}

// ─────────────────────────────────────────────────────────────
// MOVEMENT
// ─────────────────────────────────────────────────────────────
function move(dt) {
  let mx = 0, mz = 0;
  if (keys['KeyW']  || keys['ArrowUp'])    mz = -1;
  if (keys['KeyS']  || keys['ArrowDown'])  mz =  1;
  if (keys['KeyA']  || keys['ArrowLeft'])  mx = -1;
  if (keys['KeyD']  || keys['ArrowRight']) mx =  1;

  const [ax, az] = leftStick();
  if (Math.abs(ax) > 0.12) mx += ax;
  if (Math.abs(az) > 0.12) mz += az;

  if (mx === 0 && mz === 0) return;

  // Determine horizontal heading
  let hy = yaw;
  if (renderer.xr.isPresenting) {
    const q = new THREE.Quaternion();
    camera.getWorldQuaternion(q);
    hy = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
  }

  const dir = new THREE.Vector3(mx, 0, mz)
    .normalize()
    .applyEuler(new THREE.Euler(0, hy, 0));

  rig.position.x += dir.x * SPEED * dt;
  rig.position.z += dir.z * SPEED * dt;

  const maxW = (WORLD - 1) * TILE;
  rig.position.x = Math.max(1, Math.min(maxW, rig.position.x));
  rig.position.z = Math.max(1, Math.min(maxW, rig.position.z));
}

// ─────────────────────────────────────────────────────────────
// MINIMAP
// ─────────────────────────────────────────────────────────────
const mmBuf = document.createElement('canvas');
mmBuf.width = mmBuf.height = WORLD;

const mmDisp = document.createElement('canvas');
mmDisp.width = mmDisp.height = WORLD;
mmDisp.style.cssText = [
  'position:fixed', 'bottom:16px', 'left:16px',
  'width:160px', 'height:160px',
  'border:2px solid rgba(255,255,255,.75)',
  'border-radius:4px', 'z-index:10',
  'image-rendering:pixelated',
].join(';');
document.body.appendChild(mmDisp);

const MM_PALETTE = {
  [T.DEEP]:   [13,  90, 158],
  [T.WATER]:  [30, 139, 195],
  [T.SAND]:   [212,180, 131],
  [T.GRASS]:  [93, 168,  50],
  [T.FOREST]: [45, 110,  31],
  [T.MOUND]:  [139,139, 139],
  [T.DFLOOR]: [107, 79,  58],
  [T.DWALL]:  [74,  54,  40],
  [T.PATH]:   [176,128,  96],
};

function buildMinimap() {
  const ctx = mmBuf.getContext('2d');
  const id  = ctx.createImageData(WORLD, WORLD);
  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      const [r, g, b] = MM_PALETTE[worldMap[z][x]] || [0,0,0];
      const i = (z * WORLD + x) * 4;
      id.data[i] = r; id.data[i+1] = g; id.data[i+2] = b; id.data[i+3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
}

function drawMinimap() {
  const ctx = mmDisp.getContext('2d');
  ctx.drawImage(mmBuf, 0, 0);
  const px = rig.position.x / (WORLD * TILE) * WORLD;
  const pz = rig.position.z / (WORLD * TILE) * WORLD;
  ctx.fillStyle = '#ff3333';
  ctx.fillRect(px - 1.5, pz - 1.5, 3, 3);
}

// ─────────────────────────────────────────────────────────────
// HUD
// ─────────────────────────────────────────────────────────────
function buildHUD() {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'top:12px', 'left:12px',
    'color:#fff', 'font:bold 13px/1.6 monospace',
    'background:rgba(0,0,0,.6)',
    'padding:8px 14px', 'border-radius:6px',
    'z-index:10', 'text-shadow:1px 1px 2px #000',
    'pointer-events:none',
  ].join(';');
  el.innerHTML = `
    <div style="color:#7fff7f;font-size:15px;margin-bottom:3px">&#9876; VR Zelda World</div>
    <div>WASD / Arrows &mdash; Move</div>
    <div>Click canvas &mdash; Mouse look</div>
    <div>Left stick &mdash; Move (VR)</div>
    <div style="margin-top:4px;color:#adf">Explore the island!</div>
  `;
  document.body.appendChild(el);
}

// ─────────────────────────────────────────────────────────────
// RESIZE
// ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─────────────────────────────────────────────────────────────
// ANIMATION LOOP
// ─────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let elapsed = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  move(dt);
  drawMinimap();

  // Drift clouds
  for (const g of cloudGroups) {
    g.position.x += g.userData.spd * dt;
    if (g.position.x > WORLD * TILE + 20) g.position.x = -20;
  }

  renderer.render(scene, camera);
});

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
generateMap();
buildScene();
spawnPlayer();
buildMinimap();
buildHUD();
