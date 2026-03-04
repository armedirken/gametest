import * as THREE from 'three';
import { VRButton }    from 'three/addons/webxr/VRButton.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

// Wind Waker–inspired palette (bright, saturated, cheerful)
const COLOR = {
  DEEP:    0x1a6fb5,   // deep ocean blue
  WATER:   0x29b6e8,   // bright cartoon water
  SAND:    0xf5d97a,   // warm sunny sand
  GRASS:   0x4ecb38,   // vibrant lime-green
  FOREST:  0x2e9926,   // rich forest green
  MOUND:   0xa09878,   // warm stone / mountain
  DFLOOR:  0x8c6a45,   // dungeon stone floor
  DWALL:   0x5a4030,   // dark dungeon wall
  PATH:    0xd4a85a,   // golden dirt path
  TRUNK:   0x6b4220,   // warm brown trunk
  LEAF:    0x38b824,   // bright leaf green
  LEAF2:   0x52d93a,   // lighter leaf highlight
  STONE:   0x9090a0,   // blue-grey stone
  SKY:     0x5bc8f5,   // Wind Waker sky blue
  SKY_NIGHT: 0x0a1020, // night sky
  SKY_DAWN:  0xff9c55, // dawn orange
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
// WORLD GENERATION — Hyrule Light World (based on LTTP map)
// ─────────────────────────────────────────────────────────────
let worldMap  = [];
let heightMap = [];
let treeList  = [], rockList = [], starList = [];
let worldSeed = 0;
let stars = [];
const cloudGroups = [];
const pushRocks    = [];
const wallRockData = []; // { imRef, idx, pos, knocked } — lazy physics activation
let rockGeo = null, rockMat = null; // set after GLB load
let treeLists = [[], [], []];             // [forestList, fieldList, mountainList]
const treePartsList = [null, null, null]; // [{geo,mat}[]] per model — preserves multi-material

// Fill a rectangular region with tile type t
function paintRect(x0, z0, x1, z1, t) {
  for (let z = z0; z < Math.min(z1, WORLD); z++)
    for (let x = x0; x < Math.min(x1, WORLD); x++)
      worldMap[z][x] = t;
}

function generateMap() {
  worldSeed = Math.random() * 999;

  // ── Base: fill everything with grass ────────────────────────
  worldMap = [];
  for (let z = 0; z < WORLD; z++) worldMap[z] = new Array(WORLD).fill(T.GRASS);

  // ── Biome zones (painted bottom-to-top, later wins) ─────────

  // Ocean border (impassable edges)
  paintRect(0, 0, WORLD, 2,      T.WATER);
  paintRect(0, WORLD-2, WORLD, WORLD, T.WATER);
  paintRect(0, 0, 2, WORLD,     T.WATER);
  paintRect(WORLD-2, 0, WORLD, WORLD, T.WATER);
  paintRect(0, 0, WORLD, 1,      T.DEEP);
  paintRect(0, WORLD-1, WORLD, WORLD, T.DEEP);
  paintRect(0, 0, 1, WORLD,     T.DEEP);
  paintRect(WORLD-1, 0, WORLD, WORLD, T.DEEP);

  // ── NORTH ─────────────────────────────────────────────────
  // Death Mountain (rocky, north center)
  paintRect(12, 2, 48, 14, T.MOUND);
  paintRect( 8, 2, 12,  9, T.MOUND);  // extends west

  // Lost Woods / Skull Woods (dense forest, northwest)
  paintRect(2, 2, 18, 24, T.FOREST);
  paintRect(2, 24, 8, 40, T.FOREST);  // western forest strip

  // Zora's Domain (water/ice, northeast)
  paintRect(46, 2, 62, 16, T.WATER);

  // ── CENTER ────────────────────────────────────────────────
  // Eastern mountains / Eastern Palace area (right side)
  paintRect(42, 14, 62, 30, T.MOUND);
  paintRect(44, 16, 60, 28, T.FOREST); // forest inside mountains
  paintRect(48, 18, 58, 26, T.MOUND);  // rocky core

  // Kakariko Village area (left-center, open grass)
  paintRect(6, 18, 22, 36, T.GRASS);

  // Southern open Hyrule fields
  paintRect(8, 34, 54, 48, T.GRASS);

  // ── SOUTH ─────────────────────────────────────────────────
  // Desert of Mystery (southwest, sandy)
  paintRect(2, 42, 24, 62, T.SAND);
  paintRect(2, 38, 14, 42, T.SAND);  // sand creeps north

  // Swamp / marshland (south center-left)
  paintRect(18, 50, 30, 62, T.WATER);

  // Lake Hylia (large water body, south center-right)
  paintRect(30, 46, 62, 62, T.WATER);
  paintRect(34, 48, 60, 62, T.DEEP);

  // Small grass island in Lake Hylia (dungeon site)
  paintRect(42, 52, 50, 58, T.GRASS);

  // ── HYRULE CASTLE + MOAT ─────────────────────────────────
  // Moat (water ring around castle, cols 20-42, rows 10-24)
  paintRect(20, 10, 42, 24, T.WATER);

  // Castle: DWALL perimeter, DFLOOR interior (cols 22-40, rows 12-22)
  for (let z = 12; z < 22; z++) {
    for (let x = 22; x < 40; x++) {
      const wall = z === 12 || z === 21 || x === 22 || x === 39;
      worldMap[z][x] = wall ? T.DWALL : T.DFLOOR;
    }
  }
  // South gate (open entrance, center)
  worldMap[21][30] = T.PATH;
  worldMap[21][31] = T.PATH;

  // ── ZORA'S RIVER ─────────────────────────────────────────
  // Diagonal water strip: Zora's Domain (col≈54,row≈10) → Lake Hylia (col≈34,row≈48)
  for (let step = 0; step <= 40; step++) {
    const rz = 10 + Math.round(step * 38 / 40);
    const rx = 54 - Math.round(step * 20 / 40);
    for (let w = 0; w < 2; w++) {
      const tz = rz, tx = rx + w;
      if (tz < WORLD && tx >= 0 && tx < WORLD) {
        const cur = worldMap[tz][tx];
        if (cur !== T.DWALL && cur !== T.DFLOOR && cur !== T.MOUND)
          worldMap[tz][tx] = T.WATER;
      }
    }
  }

  // ── PATHS ────────────────────────────────────────────────
  carvePaths();

  // ── DUNGEONS / PALACES ────────────────────────────────────
  placeDungeons();

  // ── HEIGHT MAP ───────────────────────────────────────────
  heightMap = [];
  for (let z = 0; z < WORLD; z++) {
    heightMap[z] = [];
    for (let x = 0; x < WORLD; x++) {
      const t = worldMap[z][x];
      const n = fbm(x / 18, z / 18, 4, worldSeed + 50);
      switch (t) {
        case T.DEEP:   heightMap[z][x] = -0.5;         break;
        case T.WATER:  heightMap[z][x] = -0.15;        break;
        case T.SAND:   heightMap[z][x] =  0.05;        break;
        case T.GRASS:  heightMap[z][x] =  n * 2.8;       break;
        case T.FOREST: heightMap[z][x] =  0.6 + n*5.0;   break;
        case T.MOUND:  heightMap[z][x] =  1.5 + n*23.5;  break; // rango 1.5-25m
        default:       heightMap[z][x] =  0;            break;
      }
    }
  }

  // ── Plateau pre-blur — meseta amplia para el castillo de Death Mountain ──
  const MFORT_H = 14;
  for (let z = 2; z < 14; z++)
    for (let x = 19; x < 43; x++)
      if (worldMap[z][x] === T.MOUND || worldMap[z][x] === T.FOREST)
        heightMap[z][x] = MFORT_H; // meseta plana antes del blur → pendiente suave al borde

  // ── Blur 3 pasadas — pendientes suaves sin acantilados bruscos ──
  for (let pass = 0; pass < 3; pass++) {
    const blurred = heightMap.map(row => [...row]);
    for (let z = 1; z < WORLD - 1; z++) {
      for (let x = 1; x < WORLD - 1; x++) {
        const t = worldMap[z][x];
        if (t === T.DWALL || t === T.DFLOOR) continue;
        let sum = 0, w = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nt = worldMap[z+dz][x+dx];
          if (nt === T.DWALL || nt === T.DFLOOR) continue;
          const wt = (dz === 0 && dx === 0) ? 4 : (dz === 0 || dx === 0) ? 2 : 1;
          sum += heightMap[z+dz][x+dx] * wt; w += wt;
        }
        blurred[z][x] = sum / w;
      }
    }
    heightMap = blurred;
  }

  // ── Castillo Montaña — castle grande en la meseta (14x7 tiles) ──
  for (let z = 4; z < 11; z++) {
    for (let x = 24; x < 38; x++) {
      const wall = z === 4 || z === 10 || x === 24 || x === 37;
      worldMap[z][x] = wall ? T.DWALL : T.DFLOOR;
      heightMap[z][x] = MFORT_H; // restaurar tras blur
    }
  }
  worldMap[10][30] = T.PATH;
  worldMap[10][31] = T.PATH; // puerta sur (2 tiles de ancho)

  // ── TREE / ROCK / STAR LISTS ─────────────────────────────
  treeList = []; rockList = []; starList = [];
  treeLists = [[], [], []];
  const STAR_TILES = new Set([T.GRASS, T.PATH, T.SAND, T.DFLOOR]);
  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      const t = worldMap[z][x];

      // Tree 0 — dense canopy (Lost Woods, eastern forest, western strip)
      if (t === T.FOREST && hash(x, z, worldSeed+1) > 0.12)
        treeLists[0].push([x, z]);

      // Tree 1 — field / riverside (grass shores + open Hyrule fields)
      if (t === T.GRASS) {
        const nearWater = [[z-1,x],[z+1,x],[z,x-1],[z,x+1]].some(
          ([nz,nx]) => nz>=0&&nz<WORLD&&nx>=0&&nx<WORLD &&
                       (worldMap[nz][nx]===T.WATER||worldMap[nz][nx]===T.DEEP));
        if (hash(x, z, worldSeed+11) > (nearWater ? 0.68 : 0.88))
          treeLists[1].push([x, z]);
      }

      // Tree 0 also covers mountain zones (tree_1 on highlands)
      if (t === T.MOUND && hash(x, z, worldSeed+21) > 0.70)
        treeLists[0].push([x, z]);
      if (t === T.FOREST && (z < 14 || x > 40) && hash(x, z, worldSeed+22) > 0.55)
        treeLists[0].push([x, z]);

      if ((t === T.MOUND || t === T.GRASS) && hash(x, z, worldSeed+2) > 0.87) rockList.push([x, z]);
      if (starList.length < 10 && STAR_TILES.has(t) && hash(x, z, worldSeed+99) > 0.91) starList.push([x, z]);
    }
  }
}

function carvePaths() {
  const SAFE = t => t !== T.DEEP && t !== T.WATER && t !== T.DWALL && t !== T.DFLOOR;

  // N-S main road: from castle south gate down through Hyrule fields
  for (let z = 22; z < 48; z++) {
    if (SAFE(worldMap[z][30])) worldMap[z][30] = T.PATH;
    if (SAFE(worldMap[z][31])) worldMap[z][31] = T.PATH;
  }
  // Road north: castle north gate toward Death Mountain
  for (let z = 2; z < 12; z++) {
    if (SAFE(worldMap[z][30])) worldMap[z][30] = T.PATH;
  }
  // E-W road through central Hyrule
  for (let x = 6; x < 56; x++) {
    if (SAFE(worldMap[34][x])) worldMap[34][x] = T.PATH;
  }
  // Road to Kakariko Village (west branch, row 26)
  for (let x = 6; x < 22; x++) {
    if (SAFE(worldMap[26][x])) worldMap[26][x] = T.PATH;
  }
  // Road east toward Eastern Palace (row 26, east side)
  for (let x = 32; x < 56; x++) {
    if (SAFE(worldMap[26][x])) worldMap[26][x] = T.PATH;
  }

  // ── Caminos a mazmorras ─────────────────────────────────────
  // Skull Woods (NW): camino desde x=7 bajando hasta E-W road
  for (let z = 9; z < 34; z++)
    if (SAFE(worldMap[z][7])) worldMap[z][7] = T.PATH;
  // Eastern Palace (E): desde castillo este hasta palacio
  for (let x = 31; x < 50; x++)
    if (SAFE(worldMap[22][x])) worldMap[22][x] = T.PATH;
  for (let z = 23; z < 34; z++)
    if (SAFE(worldMap[z][50])) worldMap[z][50] = T.PATH;
  // Desert Palace (SW): road este desde el palacio
  for (let x = 9; x < 30; x++)
    if (SAFE(worldMap[50][x])) worldMap[50][x] = T.PATH;
  // Swamp Palace (S-center): camino norte hasta E-W road
  for (let z = 34; z < 52; z++)
    if (SAFE(worldMap[z][23])) worldMap[z][23] = T.PATH;
  // Ice Palace (SE): camino oeste hasta main road
  for (let x = 32; x < 44; x++)
    if (SAFE(worldMap[52][x])) worldMap[52][x] = T.PATH;
}

function placeDungeons() {
  // Fixed palace/dungeon locations — approximate LTTP positions
  const LOCS = [
    { x:  4, z:  4, w: 7, h: 6 },  // Skull Woods (NW forest)
    { x: 46, z: 18, w: 8, h: 7 },  // Eastern Palace (east mountains)
    { x:  4, z: 48, w: 8, h: 6 },  // Desert Palace (SW desert)
    // Ice Palace y Swamp Palace eliminados (estaban en el mar sin acceso)
  ];
  for (const d of LOCS) {
    for (let z = d.z; z < d.z + d.h && z < WORLD; z++) {
      for (let x = d.x; x < d.x + d.w && x < WORLD; x++) {
        const wall = z === d.z || z === d.z + d.h - 1 || x === d.x || x === d.x + d.w - 1;
        worldMap[z][x] = wall ? T.DWALL : T.DFLOOR;
      }
    }
    worldMap[Math.min(d.z + d.h - 1, WORLD-1)][d.x + Math.floor(d.w / 2)] = T.PATH;
  }
}

// ─────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLOR.SKY);
scene.fog        = new THREE.FogExp2(0xd0eaf8, 0.024); // neblina oceánica en el perímetro

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.xr.enabled        = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// Camera rig (dolly) — move this for locomotion
const rig    = new THREE.Group();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(0, EYE, 0);
rig.add(camera);
scene.add(rig);

// Lighting — bright, warm Wind Waker feel
const ambientLight = new THREE.AmbientLight(0xd0eeff, 1.1);
scene.add(ambientLight);
// Fill light (soft blue from opposite side)
const fillLight = new THREE.DirectionalLight(0xaaddff, 0.4);
fillLight.position.set(-40, 30, -60);
scene.add(fillLight);
// Sun (main directional)
const sun = new THREE.DirectionalLight(0xfff2cc, 1.6);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.near = 0.5; sc.far = 220;
sc.left = sc.bottom = -120; sc.right = sc.top = 120;
scene.add(sun);

// ─────────────────────────────────────────────────────────────
// SCENE BUILDING
// ─────────────────────────────────────────────────────────────
const dummy = new THREE.Object3D();

// Biome color per tile type (used for vertex-colored terrain mesh)
const BIOME_HEX = {
  [T.DEEP]:   COLOR.DEEP,   [T.WATER]:  COLOR.WATER,  [T.SAND]:   COLOR.SAND,
  [T.GRASS]:  COLOR.GRASS,  [T.FOREST]: COLOR.FOREST, [T.MOUND]:  COLOR.MOUND,
  [T.DFLOOR]: COLOR.DFLOOR, [T.DWALL]:  COLOR.DFLOOR, [T.PATH]:   COLOR.PATH,
};
function hexToRgb(hex) {
  return [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];
}

function buildScene() {
  // ── Océano extendido — plano enorme debajo del mapa ──────────
  const seaPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshLambertMaterial({ color: COLOR.WATER })
  );
  seaPlane.rotation.x = -Math.PI / 2;
  seaPlane.position.set(WORLD * TILE / 2, -0.25, WORLD * TILE / 2);
  scene.add(seaPlane);

  // ── Smooth terrain mesh (vertex-colored BufferGeometry) ──────
  const V = WORLD + 1; // vertices per side
  const positions = new Float32Array(V * V * 3);
  const colors    = new Float32Array(V * V * 3);
  const indices   = [];

  for (let iz = 0; iz < V; iz++) {
    for (let ix = 0; ix < V; ix++) {
      const vi = iz * V + ix;
      // Average height + color from the 4 tiles that share this corner
      let sumH = 0, sumR = 0, sumG = 0, sumB = 0, cnt = 0;
      for (const [tz, tx] of [[iz-1,ix-1],[iz-1,ix],[iz,ix-1],[iz,ix]]) {
        if (tz < 0 || tz >= WORLD || tx < 0 || tx >= WORLD) continue;
        const t  = worldMap[tz][tx];
        const h  = heightMap[tz][tx]; // DWALL usa heightMap real (0 o plateau)
        let [r, g, b] = hexToRgb(BIOME_HEX[t] ?? COLOR.GRASS);
        // Nieve en cimas: blending vertex color → blanco a partir de 15m
        if (t === T.MOUND && h > 15) {
          const s = Math.min((h - 15) / 7, 1);
          r += (0.92 - r) * s; g += (0.96 - g) * s; b += (1.0 - b) * s;
        }
        sumH += h; sumR += r; sumG += g; sumB += b; cnt++;
      }
      if (cnt === 0) cnt = 1;
      positions[vi*3]   = ix * TILE;
      positions[vi*3+1] = sumH / cnt;
      positions[vi*3+2] = iz * TILE;
      colors[vi*3]   = sumR / cnt;
      colors[vi*3+1] = sumG / cnt;
      colors[vi*3+2] = sumB / cnt;
    }
  }
  // Two triangles per tile quad
  for (let iz = 0; iz < WORLD; iz++) {
    for (let ix = 0; ix < WORLD; ix++) {
      const tl = iz*V+ix, tr = tl+1, bl = tl+V, br = bl+1;
      indices.push(tl, bl, tr,  tr, bl, br);
    }
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  terrainGeo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
  terrainGeo.setIndex(indices);
  terrainGeo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(
    terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true })
  );
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // ── Water surface (animated wave mesh) ──────────────────────
  waterMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD * TILE, WORLD * TILE, 32, 32),
    new THREE.MeshLambertMaterial({ color: COLOR.WATER, transparent: true, opacity: 0.78 })
  );
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.position.set(WORLD * TILE / 2, -0.10, WORLD * TILE / 2);
  scene.add(waterMesh);
  // Save base XY (geo-space) for per-vertex wave displacement
  { const wp = waterMesh.geometry.attributes.position;
    wBaseX = new Float32Array(wp.count);
    wBaseY = new Float32Array(wp.count);
    for (let i = 0; i < wp.count; i++) { wBaseX[i] = wp.getX(i); wBaseY[i] = wp.getY(i); } }

  // Foam eliminado — causaba cuadrados grises cerca de la costa

  // ── DWALL — GLB rock stacks ───────────────────────────────────
  const dwalls = [];
  for (let z = 0; z < WORLD; z++)
    for (let x = 0; x < WORLD; x++)
      if (worldMap[z][x] === T.DWALL) dwalls.push([x, z]);
  if (dwalls.length && rockGeo) {
    const WLAYERS = 5;                     // layers per wall tile
    const ROCKS_PER_ROW = 3;               // rocks side-by-side per layer
    // Geo after reshape: XZ = 0.85*0.80 = 0.68 m, Y = 0.85*1.20 = 1.02 m
    const ROCK_XZ = 0.68, ROCK_Y = 1.02;
    // Scale so 3 rocks exactly fill tile width, height stays proportional
    const WSCALE  = TILE / (ROCKS_PER_ROW * ROCK_XZ); // ≈ 1.47
    const LAYER_H = ROCK_Y * WSCALE;                  // ≈ 1.50 m per layer

    // Classify each tile: corner (neighbours in both X and Z) vs straight
    const dwallSet = new Set(dwalls.map(([x, z]) => `${x},${z}`));
    const CORNER_ROCKS    = 4;            // 2×2 grid per corner layer
    const CORNER_SCALE_XZ = TILE / (2 * ROCK_XZ); // ≈ 2.21 → 2 rocks fill tile

    const tileTypes = dwalls.map(([x, z]) => {
      const inX = dwallSet.has(`${x-1},${z}`) || dwallSet.has(`${x+1},${z}`);
      const inZ = dwallSet.has(`${x},${z-1}`) || dwallSet.has(`${x},${z+1}`);
      return (inX && inZ) ? 'corner' : (inZ ? 'z' : 'x');
    });

    const totalInst = dwalls.reduce((sum, _, i) =>
      sum + WLAYERS * (tileTypes[i] === 'corner' ? CORNER_ROCKS : ROCKS_PER_ROW), 0);
    const wallIM = new THREE.InstancedMesh(rockGeo, rockMat, totalInst);
    wallIM.castShadow = wallIM.receiveShadow = true;
    let wi = 0;

    dwalls.forEach(([x, z], ti) => {
      const cx = x * TILE + TILE / 2, cz = z * TILE + TILE / 2;
      const type   = tileTypes[ti];
      const count  = type === 'corner' ? CORNER_ROCKS : ROCKS_PER_ROW;
      const alongZ = type === 'z';

      for (let ly = 0; ly < WLAYERS; ly++) {
        const brickOff = (ly & 1) ? TILE / 6 : 0;
        for (let ri = 0; ri < count; ri++) {
          let px, pz;
          if (type === 'corner') {
            // 2×2 grid fills the corner in both axes
            px = cx + (ri % 2       - 0.5) * (TILE / 2);
            pz = cz + (Math.floor(ri / 2) - 0.5) * (TILE / 2);
          } else {
            const step = (ri - 1) * (TILE / 3) + brickOff;
            px = cx + (alongZ ? 0    : step);
            pz = cz + (alongZ ? step : 0);
          }
          px += (hash(x + ri * 5, z + ly,       worldSeed + 60) - 0.5) * 0.05;
          pz += (hash(x,          z + ri + ly*3, worldSeed + 61) - 0.5) * 0.05;
          const baseH = heightMap[z][x] ?? 0;
          const py = baseH + LAYER_H * ly;
          dummy.position.set(px, py, pz);
          dummy.rotation.set(0, 0, 0);
          if (type === 'corner') dummy.scale.set(CORNER_SCALE_XZ, WSCALE, CORNER_SCALE_XZ);
          else                   dummy.scale.setScalar(WSCALE);
          dummy.updateMatrix();
          wallIM.setMatrixAt(wi, dummy.matrix);
          wallRockData.push({ imRef: wallIM, idx: wi,
            pos: new THREE.Vector3(px, py, pz), knocked: false });
          wi++;
        }
      }
    });
    wallIM.instanceMatrix.needsUpdate = true;
    scene.add(wallIM);

    // ── Battlements — merlons on top of each wall ───────────────
    // Pattern: even wall-tiles get 2 merlons (positions 0 & 2), odd get 1 (center)
    // Corners get 1 centered merlon
    const MERLON_BOTTOM   = LAYER_H * WLAYERS; // just above last layer top
    const MERLON_SCALE_XZ = WSCALE;                    // same width as wall rocks
    const MERLON_SCALE_Y  = WSCALE * 1.4;              // 40 % taller than wall rocks

    const merlonCount = dwalls.reduce((sum, [x, z], i) => {
      if (tileTypes[i] === 'corner') return sum + 1;
      const coord = tileTypes[i] === 'z' ? z : x;
      return sum + (coord % 2 === 0 ? 2 : 1);
    }, 0);

    if (merlonCount > 0) {
      const merIM = new THREE.InstancedMesh(rockGeo, rockMat, merlonCount);
      merIM.castShadow = true;
      let mi = 0;

      dwalls.forEach(([x, z], ti) => {
        const cx = x * TILE + TILE / 2, cz = z * TILE + TILE / 2;
        const type   = tileTypes[ti];
        const alongZ = type === 'z';

        const tileBaseH = heightMap[z][x] ?? 0;
        const placeM = (px, pz) => {
          dummy.position.set(px, tileBaseH + MERLON_BOTTOM, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(MERLON_SCALE_XZ, MERLON_SCALE_Y, MERLON_SCALE_XZ);
          dummy.updateMatrix();
          merIM.setMatrixAt(mi++, dummy.matrix);
        };

        if (type === 'corner') {
          placeM(cx, cz);
        } else {
          const coord   = alongZ ? z : x;
          const offsets = coord % 2 === 0 ? [-1, 1] : [0];
          for (const off of offsets) {
            const step = off * (TILE / 3);
            placeM(cx + (alongZ ? 0 : step), cz + (alongZ ? step : 0));
          }
        }
      });
      merIM.instanceMatrix.needsUpdate = true;
      scene.add(merIM);
    }
  }

  // ── DFLOOR — flat GLB rock slabs (same geo as walls) ─────────
  if (rockGeo) {
    const dfloors = [];
    for (let z = 0; z < WORLD; z++)
      for (let x = 0; x < WORLD; x++)
        if (worldMap[z][x] === T.DFLOOR) dfloors.push([x, z]);
    if (dfloors.length) {
      // Geo XZ = 0.68 m — scale to fill TILE; very flat in Y
      const FSCALE_XZ = (TILE * 0.97) / 0.68; // ≈ 4.28
      const floorIM = new THREE.InstancedMesh(rockGeo, rockMat, dfloors.length);
      floorIM.receiveShadow = true;
      dfloors.forEach(([x, z], i) => {
        const thick = 0.14 + hash(x, z, worldSeed + 44) * 0.07; // slab thickness variety
        // Rotate 0°/90°/180°/270° to break up repetition
        const ry = Math.round(hash(x, z, worldSeed + 45) * 3) * (Math.PI / 2);
        dummy.position.set(x * TILE + TILE / 2, heightMap[z][x] ?? 0, z * TILE + TILE / 2);
        dummy.rotation.set(0, ry, 0);
        dummy.scale.set(FSCALE_XZ, thick, FSCALE_XZ);
        dummy.updateMatrix();
        floorIM.setMatrixAt(i, dummy.matrix);
      });
      floorIM.instanceMatrix.needsUpdate = true;
      scene.add(floorIM);
    }
  }

  // ── Trees — 3 GLB models placed by biome ────────────────────
  const TREE_BASE = [2.5, 1.8, 2.5]; // min size
  const TREE_VARY = [5.0, 4.5, 5.0]; // +random → wide range small→large

  treeLists.forEach((list, mi) => {
    const parts = treePartsList[mi];
    if (!list.length || !parts?.length) return;
    // One InstancedMesh per GLB mesh-part so each part keeps its original material
    parts.forEach(({ geo, mat }) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      im.castShadow = im.receiveShadow = true;
      list.forEach(([x, z], i) => {
        const wx = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
        const sc = TREE_BASE[mi] + hash(x, z, worldSeed + 77 + mi * 13) * TREE_VARY[mi];
        const ry = hash(x, z, worldSeed + 7  + mi * 17) * Math.PI * 2;
        dummy.position.set(wx, groundAt(wx, wz) - sc * 0.06, wz); // bury roots slightly
        dummy.rotation.set(0, ry, 0);
        dummy.scale.setScalar(sc);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      scene.add(im);
    });
  });

  // ── Rocks ────────────────────────────────────────────────────
  if (rockList.length) {
    const rIM = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(0.38, 0),
      new THREE.MeshLambertMaterial({ color: COLOR.STONE }), rockList.length);
    rIM.castShadow = true;
    rockList.forEach(([x, z], i) => {
      dummy.position.set(x*TILE + TILE/2, heightMap[z][x] + 0.28, z*TILE + TILE/2);
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

  // ── Monedas — cilindros dorados giratorios ───────────────────
  stars = [];
  if (starList.length) {
    const coinGeo = new THREE.CylinderGeometry(0.66, 0.66, 0.18, 16); // moneda gruesa
    const coinMat = new THREE.MeshLambertMaterial({
      color: 0xffd700, emissive: 0xcc8800, emissiveIntensity: 0.6
    });
    for (const [x, z] of starList) {
      const mesh = new THREE.Mesh(coinGeo, coinMat);
      const baseY = groundAt(x * TILE + TILE/2, z * TILE + TILE/2) + 1.0;
      mesh.position.set(x * TILE + TILE/2, baseY, z * TILE + TILE/2);
      mesh.castShadow = true;
      scene.add(mesh);
      stars.push({ mesh, collected: false, baseY, phase: hash(x, z, worldSeed+55) * Math.PI * 2 });
    }
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

function rightStick() {
  const session = renderer.xr.getSession();
  if (!session) return [0, 0];
  for (const src of session.inputSources) {
    if (src.gamepad && src.handedness === 'right') {
      const a = src.gamepad.axes;
      if (a.length >= 4) return [a[2], a[3]];
    }
  }
  return [0, 0];
}

const TURN_SPEED = 1.6; // rad/s for smooth VR turning

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
  g.rotation.x = -Math.PI / 2;
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
const sword  = createSword();
const shield = createShield();

// gripMeshes[i] holds the right/left grip reference for sword tip world pos
const gripRefs = {};

for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  rig.add(ctrl);
  rig.add(grip);

  ctrl.addEventListener('connected', (ev) => {
    const hand = ev.data.handedness;
    if (hand === 'right') { grip.add(sword);  gripRefs.right = grip; }
    if (hand === 'left')  { grip.add(shield); gripRefs.left  = grip; }
  });
  ctrl.addEventListener('disconnected', () => {
    grip.remove(sword);
    grip.remove(shield);
  });
}

// ─────────────────────────────────────────────────────────────
// MOVEMENT + COLLISION + TERRAIN
// ─────────────────────────────────────────────────────────────
const SOLID = new Set([T.DWALL, T.DEEP]);
let stepTimer = 0;

function tileAt(wx, wz) {
  const tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
  return worldMap[tz]?.[tx] ?? T.DEEP;
}
// Mesh vertex height — same averaging logic as the terrain BufferGeometry
function vertexH(ix, iz) {
  let sumH = 0, cnt = 0;
  for (const [tz, tx] of [[iz-1,ix-1],[iz-1,ix],[iz,ix-1],[iz,ix]]) {
    if (tz < 0 || tz >= WORLD || tx < 0 || tx >= WORLD) continue;
    const t = worldMap[tz][tx];
    sumH += (t === T.DWALL) ? 0 : (heightMap[tz][tx] ?? 0);
    cnt++;
  }
  return cnt ? sumH / cnt : 0;
}
// Bilinear interpolation of vertex heights — matches visible terrain surface
function groundAt(wx, wz) {
  const tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
  if (tz < 0 || tz >= WORLD || tx < 0 || tx >= WORLD) return 0;
  const fx = (wx - tx * TILE) / TILE;
  const fz = (wz - tz * TILE) / TILE;
  return vertexH(tx,   tz  ) * (1-fx) * (1-fz)
       + vertexH(tx+1, tz  ) *    fx  * (1-fz)
       + vertexH(tx,   tz+1) * (1-fx) *    fz
       + vertexH(tx+1, tz+1) *    fx  *    fz;
}

function move(dt) {
  let mx = 0, mz = 0;
  if (keys['KeyW']  || keys['ArrowUp'])    mz = -1;
  if (keys['KeyS']  || keys['ArrowDown'])  mz =  1;
  if (keys['KeyA']  || keys['ArrowLeft'])  mx = -1;
  if (keys['KeyD']  || keys['ArrowRight']) mx =  1;

  const [ax, az] = leftStick();
  if (Math.abs(ax) > 0.12) mx += ax;
  if (Math.abs(az) > 0.12) mz += az;

  // Right stick — smooth turn (VR only; desktop uses mouse)
  if (renderer.xr.isPresenting) {
    const [rx] = rightStick();
    if (Math.abs(rx) > 0.15) rig.rotation.y -= rx * TURN_SPEED * dt;
  }

  stepTimer = Math.max(0, stepTimer - dt);

  if (mx !== 0 || mz !== 0) {
    let hy = yaw;
    if (renderer.xr.isPresenting) {
      const q = new THREE.Quaternion();
      camera.getWorldQuaternion(q);
      hy = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    }

    const dir = new THREE.Vector3(mx, 0, mz)
      .normalize()
      .applyEuler(new THREE.Euler(0, hy, 0));

    const prevX = rig.position.x, prevZ = rig.position.z;
    const maxW  = (WORLD - 1) * TILE;

    // Swim at half speed in shallow water
    const inWater = tileAt(rig.position.x, rig.position.z) === T.WATER;
    const spd = inWater ? SPEED * 0.5 : SPEED;

    rig.position.x = Math.max(1, Math.min(maxW, rig.position.x + dir.x * spd * dt));
    rig.position.z = Math.max(1, Math.min(maxW, rig.position.z + dir.z * spd * dt));

    // Wall collision — push back if solid tile
    if (SOLID.has(tileAt(rig.position.x, rig.position.z))) {
      rig.position.x = prevX;
      rig.position.z = prevZ;
    }

    // Footstep sound
    if (stepTimer === 0) { stepTimer = 0.42; sfx.footstep(); }
  }

  // Terrain following — smoothly match ground height
  const targetY = groundAt(rig.position.x, rig.position.z);
  rig.position.y += (targetY - rig.position.y) * Math.min(1, dt * 8);
}

// ─────────────────────────────────────────────────────────────
// AUDIO  (SFX sintetizados + música de fondo opcional)
// ─────────────────────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window['webkitAudioContext'])();
  return audioCtx;
}

const sfx = {
  swing() {
    const ctx = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(); osc.stop(ctx.currentTime + 0.18);
  },
  hit() {
    const ctx  = getAudioCtx();
    const size = Math.floor(ctx.sampleRate * 0.12);
    const buf  = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size);
    const src    = ctx.createBufferSource();
    src.buffer   = buf;
    const filter = ctx.createBiquadFilter();
    filter.type  = 'lowpass'; filter.frequency.value = 500;
    const gain   = ctx.createGain();
    gain.gain.setValueAtTime(0.6, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start();
  },
  death() {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(320, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.45);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.start(); osc.stop(ctx.currentTime + 0.45);
  },
  footstep() {
    const ctx  = getAudioCtx();
    const size = Math.floor(ctx.sampleRate * 0.04);
    const buf  = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size) * 0.4;
    const src    = ctx.createBufferSource();
    src.buffer   = buf;
    const filter = ctx.createBiquadFilter();
    filter.type  = 'lowpass'; filter.frequency.value = 250;
    const gain   = ctx.createGain();
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start();
  },
  starCollect() {
    const ctx  = getAudioCtx();
    const notes = [880, 1100, 1320];
    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      const t0 = ctx.currentTime + i * 0.09;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.35, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
      osc.start(t0); osc.stop(t0 + 0.25);
    });
  },
};

// ── Background music (coloca soundtrack.mp3 en assets/audio/) ─
const bgMusic = new Audio('assets/audio/soundtrack.mp3');
bgMusic.loop   = true;
bgMusic.volume = 0.35;

// Los navegadores requieren interacción del usuario para reproducir audio
document.addEventListener('click', () => {
  getAudioCtx(); // desbloquear contexto
  if (bgMusic.src && bgMusic.paused) bgMusic.play().catch(() => {});
}, { once: true });

// ─────────────────────────────────────────────────────────────
// ENEMIES
// ─────────────────────────────────────────────────────────────
let playerHP = 5;
const enemies = [];
const swordTipWorld = new THREE.Vector3();
let   swordPrevPos  = new THREE.Vector3();
let   swordVel      = 0;

const ENEMY_MAT_BODY  = new THREE.MeshLambertMaterial({ color: 0x2e7d32 });
const ENEMY_MAT_DMGD  = new THREE.MeshLambertMaterial({ color: 0xff2222 });
const ENEMY_MAT_EYE   = new THREE.MeshLambertMaterial({ color: 0xffffff });
const ENEMY_MAT_PUPIL = new THREE.MeshLambertMaterial({ color: 0x111111 });

function createEnemy(gx, gz) {
  const g     = new THREE.Group();
  const body  = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), ENEMY_MAT_BODY);
  body.scale.y = 0.65;
  body.position.y = 0.3;
  body.castShadow = true;
  g.add(body);

  for (const sx of [-0.16, 0.16]) {
    const eye   = new THREE.Mesh(new THREE.SphereGeometry(0.1,  6, 4), ENEMY_MAT_EYE);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055,4, 3), ENEMY_MAT_PUPIL);
    eye.position.set(sx, 0.46, 0.33);
    pupil.position.set(sx, 0.46, 0.43);
    g.add(eye, pupil);
  }

  const wy = groundAt(gx * TILE + TILE/2, gz * TILE + TILE/2);
  g.position.set(gx * TILE + TILE/2, wy, gz * TILE + TILE/2);
  scene.add(g);

  return {
    mesh: g, hp: 3, hitCooldown: 0, dead: false, deathT: 0,
    spawnX: gx * TILE + TILE/2, spawnZ: gz * TILE + TILE/2, aggroed: false,
    // Patrol
    patrolTarget: null,
    patrolPause:  hash(gx, gz, worldSeed + 44) * 1.5,
    patrolStep:   Math.floor(hash(gx, gz, worldSeed + 45) * 99),
    // Lunge-attack cycle  ('cooldown' | 'wait' | 'lunge' | 'retreat')
    lungePhase:   'cooldown',
    lungeT:       hash(gx, gz, worldSeed + 41) * 1.2,  // stagger first attack
    lungeDir:     new THREE.Vector3(),
    lungeDamaged: false,
    // Per-enemy animation phase offset
    phase: hash(gx, gz, worldSeed + 42) * Math.PI * 2,
  };
}

function spawnEnemies() {
  const SPAWN = new Set([T.GRASS, T.FOREST]);
  for (let z = 2; z < WORLD - 2; z++) {
    for (let x = 2; x < WORLD - 2; x++) {
      if (SPAWN.has(worldMap[z][x]) && hash(x, z, worldSeed + 30) > 0.91) {
        enemies.push(createEnemy(x, z));
      }
    }
  }
}

function updateEnemies(dt) {
  const px = rig.position.x, pz = rig.position.z;

  // Sword tip world position (blade tip in sword local = (0, 0.77, 0))
  const hasSword = !!gripRefs.right;
  if (hasSword) {
    swordTipWorld.set(0, 0.77, 0);
    sword.localToWorld(swordTipWorld);
    swordVel = swordTipWorld.distanceTo(swordPrevPos) / dt;
    swordPrevPos.copy(swordTipWorld);
  }

  const LUNGE_RANGE = 2.6; // distance at which lunge cycle begins

  for (const e of enemies) {
    if (e.dead) {
      e.deathT += dt;
      e.mesh.scale.setScalar(Math.max(0, 1 - e.deathT / 0.35));
      if (e.deathT > 0.4) scene.remove(e.mesh);
      continue;
    }

    // Horizontal distance to player
    const dx = px - e.mesh.position.x, dz = pz - e.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Aggro transitions
    if (!e.aggroed && dist < 8)  { e.aggroed = true; e.patrolTarget = null; }
    if (e.aggroed  && dist > 12) {
      e.aggroed = false;
      e.lungePhase = 'cooldown'; e.lungeT = 0.4;
      e.mesh.rotation.x = 0; e.mesh.rotation.z = 0;
    }

    // Ground snap — smooth interpolation avoids popping on terrain edges
    const gY = groundAt(e.mesh.position.x, e.mesh.position.z);
    e.mesh.position.y += (gY - e.mesh.position.y) * Math.min(1, dt * 12);
    const body = e.mesh.children[0]; // body sphere

    // Three.js lookAt points -Z toward target, but enemies face +Z (eyes at z=0.33).
    // Use atan2 directly so +Z faces the target.
    const faceToward = (tx, tz) => {
      e.mesh.rotation.y = Math.atan2(tx - e.mesh.position.x, tz - e.mesh.position.z);
    };

    if (e.aggroed) {
      // ── AGGROED ──────────────────────────────────────────────
      if (dist > LUNGE_RANGE) {
        // Chase — walk towards player with bounce
        const spd = 2.2 * dt;
        e.mesh.position.x += dx / dist * spd;
        e.mesh.position.z += dz / dist * spd;
        faceToward(px, pz);
        e.mesh.rotation.x = 0; e.mesh.rotation.z = 0;
        body.position.y = 0.3 + Math.abs(Math.sin(elapsed * 9 + e.phase)) * 0.09;
        if (e.lungePhase !== 'cooldown') { e.lungePhase = 'cooldown'; e.lungeT = 0.3; }
      } else {
        // In lunge range — run lunge cycle
        e.lungeT -= dt;

        if (e.lungePhase === 'cooldown') {
          faceToward(px, pz);
          e.mesh.rotation.x = 0;
          body.position.y = 0.3 + Math.sin(elapsed * 5 + e.phase) * 0.03;
          if (e.lungeT <= 0) { e.lungePhase = 'wait'; e.lungeT = 0.45; }

        } else if (e.lungePhase === 'wait') {
          // Wind-up: rapid head bob, lean forward
          faceToward(px, pz);
          const bob = Math.sin(elapsed * 14 + e.phase);
          body.position.y = 0.3 + bob * 0.07;
          e.mesh.rotation.x = -0.12 + bob * 0.05;
          if (e.lungeT <= 0) {
            e.lungePhase = 'lunge';
            e.lungeT = 0.22;
            e.lungeDamaged = false;
            e.lungeDir.set(dx, 0, dz).normalize();
          }

        } else if (e.lungePhase === 'lunge') {
          // Dash forward — salta a la altura del jugador para poder golpearlo
          e.mesh.rotation.x = -0.28;
          body.position.y = 0.3;
          const targetY = rig.position.y + EYE * 0.55; // pecho del jugador
          e.mesh.position.y += (targetY - e.mesh.position.y) * Math.min(1, 12 * dt);
          const newX = e.mesh.position.x + e.lungeDir.x * 7 * dt;
          const newZ = e.mesh.position.z + e.lungeDir.z * 7 * dt;
          if (tileAt(newX, newZ) !== T.DEEP) {
            e.mesh.position.x = newX;
            e.mesh.position.z = newZ;
          }
          if (!e.lungeDamaged && dist < 1.4) {
            e.lungeDamaged = true;
            playerHP = Math.max(0, playerHP - 1);
            updateHPBar();
          }
          if (e.lungeT <= 0) {
            e.lungePhase = 'retreat';
            e.lungeT = 0.38;
            e.lungeDir.negate();
            e.mesh.rotation.x = 0;
          }

        } else if (e.lungePhase === 'retreat') {
          // Vuelve al suelo y retrocede
          const groundY = groundAt(e.mesh.position.x, e.mesh.position.z);
          e.mesh.position.y += (groundY - e.mesh.position.y) * Math.min(1, 10 * dt);
          const newX = e.mesh.position.x + e.lungeDir.x * 4.5 * dt;
          const newZ = e.mesh.position.z + e.lungeDir.z * 4.5 * dt;
          if (tileAt(newX, newZ) !== T.DEEP) {
            e.mesh.position.x = newX;
            e.mesh.position.z = newZ;
          }
          body.position.y = 0.3;
          if (e.lungeT <= 0) {
            e.lungePhase = 'cooldown';
            e.lungeT = 0.5 + hash(e.spawnX, e.spawnZ, ++e.patrolStep) * 0.5;
          }
        }
      }

    } else {
      // ── PATROL ───────────────────────────────────────────────
      e.mesh.rotation.x = 0; e.mesh.rotation.z = 0;

      if (e.patrolPause > 0) {
        e.patrolPause -= dt;
        body.position.y = 0.3 + Math.sin(elapsed * 2.5 + e.phase) * 0.02;
        e.mesh.rotation.z = Math.sin(elapsed * 1.8 + e.phase) * 0.04;
      } else {
        if (!e.patrolTarget) {
          const a = hash(e.spawnX, e.spawnZ, ++e.patrolStep) * Math.PI * 2;
          const r = 2 + hash(e.spawnZ, e.patrolStep, e.spawnX) * 4;
          e.patrolTarget = {
            x: Math.max(TILE, Math.min((WORLD-1)*TILE, e.spawnX + Math.cos(a) * r)),
            z: Math.max(TILE, Math.min((WORLD-1)*TILE, e.spawnZ + Math.sin(a) * r)),
          };
        }
        const ptdx = e.patrolTarget.x - e.mesh.position.x;
        const ptdz = e.patrolTarget.z - e.mesh.position.z;
        const ptDist = Math.sqrt(ptdx * ptdx + ptdz * ptdz);
        if (ptDist > 0.35) {
          const spd = 1.3 * dt;
          e.mesh.position.x += ptdx / ptDist * spd;
          e.mesh.position.z += ptdz / ptDist * spd;
          e.mesh.rotation.y = Math.atan2(ptdx, ptdz); // face patrol direction (+Z forward)
          e.mesh.rotation.z = 0;
          body.position.y = 0.3 + Math.abs(Math.sin(elapsed * 5 + e.phase)) * 0.06;
        } else {
          e.patrolTarget = null;
          e.patrolPause = 1.0 + hash(e.patrolStep, e.spawnX, e.spawnZ) * 1.5;
        }
      }
    }

    // ── Sword hit ──────────────────────────────────────────────
    e.hitCooldown = Math.max(0, e.hitCooldown - dt);
    if (hasSword && e.hitCooldown === 0) {
      const tipDist = swordTipWorld.distanceTo(e.mesh.position);
      if (tipDist < 1.2 && swordVel > 1.5) {
        e.hp--; e.hitCooldown = 0.4; sfx.hit();
        e.mesh.children[0].material = ENEMY_MAT_DMGD;
        setTimeout(() => { if (!e.dead) e.mesh.children[0].material = ENEMY_MAT_BODY; }, 200);
        if (e.hp <= 0) { e.dead = true; sfx.death(); }
      }
    }
    // Space key hit (desktop)
    if (keys['Space'] && dist < 2.5 && e.hitCooldown === 0) {
      e.hp--; e.hitCooldown = 0.5; sfx.hit();
      if (e.hp <= 0) { e.dead = true; sfx.death(); }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// PUSH ROCKS — large boulders with simple physics
// ─────────────────────────────────────────────────────────────
const ROCK_SCALE = 5;                    // push rocks son 5x más grandes
const ROCK_HALF  = 0.34 * ROCK_SCALE;   // 1.70 m (base offset)
const ROCK_R     = 0.50 * ROCK_SCALE;   // 2.50 m collision radius
const hearts = [];                       // corazones de vida en el suelo

function knockWallRock(wr, impulseX, impulseZ) {
  if (wr.knocked) return;
  wr.knocked = true;
  // Hide the instanced rock by zeroing its scale
  const zero = new THREE.Object3D();
  zero.scale.set(0, 0, 0);
  zero.updateMatrix();
  wr.imRef.setMatrixAt(wr.idx, zero.matrix);
  wr.imRef.instanceMatrix.needsUpdate = true;
  // Spawn a physics mesh at the same position
  const mesh = new THREE.Mesh(rockGeo, rockMat);
  mesh.castShadow = true;
  mesh.position.copy(wr.pos);
  scene.add(mesh);
  pushRocks.push({ mesh, vx: impulseX, vz: impulseZ, hitCooldown: 0.35 });
}

function spawnPushRocks() {
  if (!rockGeo) return;
  const VALID = new Set([T.GRASS, T.MOUND, T.SAND]);
  for (let z = 2; z < WORLD - 2; z++) {
    for (let x = 2; x < WORLD - 2; x++) {
      if (VALID.has(worldMap[z][x]) && hash(x, z, worldSeed + 88) > 0.988) {
        const wx = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
        const mesh = new THREE.Mesh(rockGeo, rockMat);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.scale.setScalar(ROCK_SCALE);
        mesh.rotation.y = hash(x, z, worldSeed + 33) * Math.PI * 2;
        mesh.position.set(wx, groundAt(wx, wz) + ROCK_HALF, wz);
        scene.add(mesh);
        pushRocks.push({ mesh, vx: 0, vz: 0, hitCooldown: 0, broken: false });
      }
    }
  }
}

function updatePushRocks(dt) {
  const hasSword = !!gripRefs.right;

  // ── Wall rock hit detection ─────────────────────────────────
  if (hasSword && swordVel > 2 && wallRockData.length) {
    for (const wr of wallRockData) {
      if (wr.knocked) continue;
      const dx = wr.pos.x - swordTipWorld.x;
      const dz = wr.pos.z - swordTipWorld.z;
      if (dx * dx + dz * dz < 1.8 * 1.8) {
        const d = Math.sqrt(dx * dx + dz * dz) || 0.01;
        const impulse = Math.min(swordVel * 0.25, 7);
        knockWallRock(wr, dx / d * impulse, dz / d * impulse);
        sfx.hit();
        break; // one per frame
      }
    }
  }

  if (!pushRocks.length) return;

  // Función que rompe una roca y suelta un corazón
  function breakRock(r) {
    if (r.broken) return;
    r.broken = true;
    scene.remove(r.mesh);
    sfx.hit();
    // Spawn corazón en la posición de la roca
    const hMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0xff2244, emissive: 0xaa0022, emissiveIntensity: 0.7 })
    );
    hMesh.position.copy(r.mesh.position);
    hMesh.position.y = groundAt(r.mesh.position.x, r.mesh.position.z) + 0.6;
    scene.add(hMesh);
    hearts.push({ mesh: hMesh, baseY: hMesh.position.y, phase: Math.random() * Math.PI * 2 });
  }

  for (const r of pushRocks) {
    if (r.broken) continue;
    r.hitCooldown = Math.max(0, r.hitCooldown - dt);

    // ── Hit detection — rompe la roca al primer golpe ───────────
    if (r.hitCooldown === 0) {
      let hit = false;
      if (hasSword) {
        const tipDist = swordTipWorld.distanceTo(r.mesh.position);
        if (tipDist < ROCK_R && swordVel > 1.5) hit = true;
      }
      if (!hit && keys['Space']) {
        const dx = r.mesh.position.x - rig.position.x;
        const dz = r.mesh.position.z - rig.position.z;
        if (dx * dx + dz * dz < (ROCK_R + 1) * (ROCK_R + 1)) hit = true;
      }
      if (hit) { breakRock(r); continue; }
    }

    // Stop when barely moving
    if (Math.sqrt(r.vx * r.vx + r.vz * r.vz) < 0.06) { r.vx = 0; r.vz = 0; }
    if (r.vx === 0 && r.vz === 0) continue;

    // ── Move + tile collision ──────────────────────────────────
    const nx = r.mesh.position.x + r.vx * dt;
    const nz = r.mesh.position.z + r.vz * dt;
    const txn = tileAt(nx, r.mesh.position.z);
    const tzn = tileAt(r.mesh.position.x, nz);
    if (!SOLID.has(txn) && txn !== T.DEEP) r.mesh.position.x = nx; else r.vx *= -0.25;
    if (!SOLID.has(tzn) && tzn !== T.DEEP) r.mesh.position.z = nz; else r.vz *= -0.25;

    // ── Ground follow ──────────────────────────────────────────
    r.mesh.position.y = groundAt(r.mesh.position.x, r.mesh.position.z) + ROCK_HALF;

    // ── Rolling rotation ───────────────────────────────────────
    r.mesh.rotation.x -= r.vz * dt * 0.55;
    r.mesh.rotation.z += r.vx * dt * 0.55;

    // ── Friction ───────────────────────────────────────────────
    r.vx *= Math.max(0, 1 - 4.5 * dt);
    r.vz *= Math.max(0, 1 - 4.5 * dt);

    // ── Rock–rock collisions ───────────────────────────────────
    for (const other of pushRocks) {
      if (other === r) continue;
      const cx = other.mesh.position.x - r.mesh.position.x;
      const cz = other.mesh.position.z - r.mesh.position.z;
      const dist = Math.sqrt(cx * cx + cz * cz);
      if (dist < ROCK_R * 2 && dist > 0.001) {
        const ux = cx / dist, uz = cz / dist;
        const relV = (r.vx - other.vx) * ux + (r.vz - other.vz) * uz;
        if (relV > 0) {
          r.vx     -= relV * 0.75 * ux;  r.vz     -= relV * 0.75 * uz;
          other.vx += relV * 0.75 * ux;  other.vz += relV * 0.75 * uz;
        }
        const pen = (ROCK_R * 2 - dist) * 0.5;
        r.mesh.position.x     -= ux * pen;  r.mesh.position.z     -= uz * pen;
        other.mesh.position.x += ux * pen;  other.mesh.position.z += uz * pen;
      }
    }

    // ── Moving rock damages enemies ────────────────────────────
    const curSpd = Math.sqrt(r.vx * r.vx + r.vz * r.vz);
    if (curSpd > 2) {
      for (const e of enemies) {
        if (e.dead || e.hitCooldown > 0) continue;
        const ex = e.mesh.position.x - r.mesh.position.x;
        const ez = e.mesh.position.z - r.mesh.position.z;
        if (ex * ex + ez * ez < ROCK_R * ROCK_R) {
          e.hp--; e.hitCooldown = 0.5; sfx.hit();
          if (e.hp <= 0) { e.dead = true; sfx.death(); }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// GAME OVER / VICTORY / STARS
// ─────────────────────────────────────────────────────────────
let gameEnded = false;

function showGameOver() {
  if (gameEnded) return;
  gameEnded = true;
  // HTML overlay (desktop)
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:200;color:#fff;font-family:monospace';
  el.innerHTML = `
    <div style="font-size:52px;color:#ff4444;margin-bottom:16px;text-shadow:0 0 20px #f00">GAME OVER</div>
    <div style="font-size:20px;margin-bottom:32px;opacity:.8">Fuiste derrotado...</div>
    <button onclick="location.reload()" style="font-size:18px;padding:12px 36px;background:#ff4444;color:#fff;border:none;border-radius:8px;cursor:pointer">▶ Jugar de nuevo</button>
  `;
  document.body.appendChild(el);
  // 3D overlay visible inside VR headset
  show3DOverlay('GAME OVER', 'Fuiste derrotado...', '#ff4444');
}

function showVictory() {
  if (gameEnded) return;
  gameEnded = true;
  // HTML overlay (desktop)
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:200;color:#fff;font-family:monospace';
  el.innerHTML = `
    <div style="font-size:52px;color:#ffd700;margin-bottom:16px;text-shadow:0 0 20px #fa0">★ VICTORIA ★</div>
    <div style="font-size:20px;margin-bottom:8px;opacity:.8">¡Recolectaste todas las estrellas!</div>
    <div style="font-size:15px;margin-bottom:32px;color:#ffd700;opacity:.7">${stars.length} / ${stars.length} estrellas</div>
    <button onclick="location.reload()" style="font-size:18px;padding:12px 36px;background:#ffd700;color:#000;border:none;border-radius:8px;cursor:pointer">▶ Jugar de nuevo</button>
  `;
  document.body.appendChild(el);
  // 3D overlay visible inside VR headset
  show3DOverlay('VICTORIA', '¡Recolectaste todas las estrellas!', '#ffd700');
}

let starEl;
function updateStarCounter() {
  if (starEl) {
    const collected = stars.filter(s => s.collected).length;
    starEl.textContent = '\u2605 ' + collected + ' / ' + stars.length;
  }
  drawHUD3d();
}

function checkStarCollection() {
  if (gameEnded) return;
  const px = rig.position.x, pz = rig.position.z;
  let anyNew = false;
  for (const s of stars) {
    if (s.collected) continue;
    const dx = s.mesh.position.x - px;
    const dz = s.mesh.position.z - pz;
    if (dx * dx + dz * dz < 1.5 * 1.5) {
      s.collected = true;
      scene.remove(s.mesh);
      sfx.starCollect();
      anyNew = true;
    }
  }
  if (anyNew) {
    updateStarCounter();
    if (stars.length > 0 && stars.every(s => s.collected)) showVictory();
  }
}

// ─────────────────────────────────────────────────────────────
// DAY / NIGHT CYCLE  (full day = 10 real minutes)
// ─────────────────────────────────────────────────────────────
let dayTime = 0.35; // start mid-morning (0=midnight, 0.5=noon, 1=midnight again)
const DAY_SPEED = 1 / 600; // 600 seconds per full cycle

const _skyDay   = new THREE.Color(COLOR.SKY);
const _skyDawn  = new THREE.Color(COLOR.SKY_DAWN);
const _skyNight = new THREE.Color(COLOR.SKY_NIGHT);
const _sunColor = new THREE.Color();

function updateDayNight(dt) {
  dayTime = (dayTime + DAY_SPEED * dt) % 1;

  // t01: 0 at dawn(0.25)/dusk(0.75), 1 at noon(0.5)
  const angle  = dayTime * Math.PI * 2; // full circle
  const sinT   = Math.sin(angle);       // +1 at noon, -1 at midnight

  // Sky color: blend night→dawn→day→dusk→night
  let skyCol;
  if (dayTime < 0.25) {
    // midnight → dawn
    skyCol = _skyNight.clone().lerp(_skyDawn, dayTime / 0.25);
  } else if (dayTime < 0.35) {
    // dawn → day
    skyCol = _skyDawn.clone().lerp(_skyDay, (dayTime - 0.25) / 0.10);
  } else if (dayTime < 0.65) {
    // day (full brightness)
    skyCol = _skyDay.clone();
  } else if (dayTime < 0.75) {
    // day → dusk
    skyCol = _skyDay.clone().lerp(_skyDawn, (dayTime - 0.65) / 0.10);
  } else {
    // dusk → night
    skyCol = _skyDawn.clone().lerp(_skyNight, (dayTime - 0.75) / 0.25);
  }
  scene.background = skyCol;
  scene.fog.color.copy(skyCol);

  // Sun brightness: bright at noon, dark at night
  const brightness = Math.max(0, sinT); // 0 at night, 1 at noon
  sun.intensity = brightness * 1.8;
  ambientLight.intensity = 0.3 + brightness * 0.9;

  // Sun position circles overhead
  const sunDist = 100;
  sun.position.set(
    Math.cos(angle) * sunDist,
    Math.sin(angle) * sunDist,
    40
  );

  // Sun color: warm white at day, orange-red at dusk/dawn
  const duskAmount = 1 - Math.min(1, brightness * 3);
  _sunColor.setHex(0xfff2cc).lerp(new THREE.Color(0xff6600), duskAmount * 0.6);
  sun.color.copy(_sunColor);

  // Update rain chance on day boundary
  if (isRaining && brightness < 0.01) stopRain();
}

// ─────────────────────────────────────────────────────────────
// RAIN SYSTEM
// ─────────────────────────────────────────────────────────────
let isRaining = false;
let rainMesh = null;
let rainTimer = 30 + Math.random() * 60; // first rain in 30-90s

// Water animation refs (set in buildScene)
let waterMesh = null, wBaseX = null, wBaseY = null;

const RAIN_COUNT = 1800;
const rainPositions = new Float32Array(RAIN_COUNT * 3);
const rainVelocities = new Float32Array(RAIN_COUNT);

function startRain() {
  if (isRaining) return;
  isRaining = true;
  const geo = new THREE.BufferGeometry();
  for (let i = 0; i < RAIN_COUNT; i++) {
    rainPositions[i*3]   = (Math.random() - 0.5) * 80;
    rainPositions[i*3+1] = Math.random() * 30;
    rainPositions[i*3+2] = (Math.random() - 0.5) * 80;
    rainVelocities[i] = 8 + Math.random() * 6;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xaaddff, size: 0.08, transparent: true, opacity: 0.55
  });
  rainMesh = new THREE.Points(geo, mat);
  scene.add(rainMesh);
  ambientLight.intensity *= 0.65;
}

function stopRain() {
  if (!isRaining || !rainMesh) return;
  scene.remove(rainMesh);
  rainMesh.geometry.dispose();
  rainMesh = null;
  isRaining = false;
}

function updateWater(t) {
  if (!waterMesh || !wBaseX) return;
  const pos = waterMesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // geo-space Z = world Y (height) after rotation.x = -PI/2
    pos.setZ(i,
      Math.sin(wBaseX[i] * 0.18 + t * 1.6) * 0.12 +
      Math.cos(wBaseY[i] * 0.15 + t * 1.2) * 0.09
    );
  }
  pos.needsUpdate = true;
  waterMesh.geometry.computeVertexNormals();
}

function updateRain(dt) {
  rainTimer -= dt;
  if (rainTimer <= 0) {
    if (!isRaining) {
      startRain();
      rainTimer = 20 + Math.random() * 40; // rain lasts 20-60s
    } else {
      stopRain();
      rainTimer = 60 + Math.random() * 120; // dry period 60-180s
    }
  }
  if (!isRaining || !rainMesh) return;
  const pos = rainMesh.geometry.attributes.position;
  const cx = rig.position.x, cz = rig.position.z;
  for (let i = 0; i < RAIN_COUNT; i++) {
    pos.array[i*3+1] -= rainVelocities[i] * dt;
    if (pos.array[i*3+1] < -2) {
      pos.array[i*3]   = cx + (Math.random() - 0.5) * 80;
      pos.array[i*3+1] = 25 + Math.random() * 10;
      pos.array[i*3+2] = cz + (Math.random() - 0.5) * 80;
    }
  }
  pos.needsUpdate = true;
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
  if (mmTex3d) mmTex3d.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────
// HUD
// ─────────────────────────────────────────────────────────────
let hpBarEl;
// 3D HUD canvas — works in desktop and VR
let hudCtx3d = null, hudTex3d = null, mmTex3d = null;

function drawHUD3d() {
  if (!hudCtx3d) return;
  const ctx = hudCtx3d;
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  if (ctx.roundRect) { ctx.roundRect(2, 2, 508, 124, 14); ctx.fill(); }
  else ctx.fillRect(2, 2, 508, 124);
  // Corazones
  ctx.font = 'bold 54px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i < playerHP ? '#ff3344' : '#44222a';
    ctx.fillText('♥', 12 + i * 62, 64);
  }
  // Monedas
  const col = stars.filter(s => s.collected).length;
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText('● ' + col + ' / ' + stars.length, 326, 64);
  if (hudTex3d) hudTex3d.needsUpdate = true;
}

function updateHPBar() {
  if (hpBarEl) {
    hpBarEl.textContent = '♥'.repeat(playerHP) + '♡'.repeat(Math.max(0, 5 - playerHP));
    hpBarEl.style.color = playerHP <= 1 ? '#ff4444' : '#ff8888';
  }
  drawHUD3d();
  if (playerHP === 0) showGameOver();
}

// Floating 3D overlay — attached to camera so it works in VR
function show3DOverlay(titleText, subText, titleColor) {
  const oc = document.createElement('canvas');
  oc.width = 512; oc.height = 256;
  const ctx = oc.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.88)';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = titleColor;
  ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleText, 256, 88);
  ctx.fillStyle = '#ffffff';
  ctx.font = '30px sans-serif';
  ctx.fillText(subText, 256, 158);
  ctx.fillStyle = '#aaaaaa';
  ctx.font = '22px sans-serif';
  ctx.fillText('Reiniciando en 4s…', 256, 212);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.8),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(oc), transparent: true, depthTest: false })
  );
  mesh.position.set(0, 0.05, -1.5);
  mesh.renderOrder = 1000;
  camera.add(mesh);
  setTimeout(() => location.reload(), 4000);
}

function buildHUD() {
  // HTML overlay (desktop)
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
    <div style="color:#7fff7f;font-size:15px;margin-bottom:3px">&#9876; Hyrule — Light World</div>
    <div>WASD / Arrows &mdash; Move</div>
    <div>Click canvas &mdash; Mouse look &nbsp;|&nbsp; Space &mdash; Attack</div>
    <div>Left stick &mdash; Move (VR) &nbsp;|&nbsp; Swing right &mdash; Slash</div>
    <div id="hp" style="margin-top:6px;font-size:16px;color:#ff8888">♥♥♥♥♥</div>
    <div id="stars" style="font-size:14px;color:#ffd700;margin-top:3px">&#9733; 0 / 0</div>
  `;
  document.body.appendChild(el);
  hpBarEl = document.getElementById('hp');
  starEl  = document.getElementById('stars');

  // 3D HUD — visible in VR headset, attached to camera
  const hc = document.createElement('canvas');
  hc.width = 512; hc.height = 128;
  hudCtx3d = hc.getContext('2d');
  hudTex3d = new THREE.CanvasTexture(hc);
  const hm = new THREE.Mesh(
    new THREE.PlaneGeometry(0.85, 0.21),
    new THREE.MeshBasicMaterial({ map: hudTex3d, transparent: true, depthTest: false })
  );
  hm.position.set(0, -0.30, -0.75);
  hm.renderOrder = 999;
  camera.add(hm);

  // Minimapa 3D en VR — esquina superior izquierda
  mmTex3d = new THREE.CanvasTexture(mmDisp);
  const mmMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.20, 0.20),
    new THREE.MeshBasicMaterial({ map: mmTex3d, depthTest: false })
  );
  mmMesh.position.set(-0.40, 0.22, -0.75);
  mmMesh.renderOrder = 999;
  camera.add(mmMesh);

  drawHUD3d();
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
  if (!worldMap.length) return; // wait for GLB load + initGame
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (!gameEnded) {
    move(dt);
    updateEnemies(dt);
    updatePushRocks(dt);
    checkStarCollection();
    updateDayNight(dt);
    updateRain(dt);
  }
  updateWater(elapsed);
  drawMinimap();

  // Animate coins (bob + spin)
  for (const s of stars) {
    if (!s.collected) {
      s.mesh.position.y = s.baseY + Math.sin(elapsed * 2.5 + s.phase) * 0.18;
      s.mesh.rotation.y += dt * 1.8;
    }
  }

  // Animate hearts + pickup
  for (let i = hearts.length - 1; i >= 0; i--) {
    const h = hearts[i];
    h.mesh.position.y = h.baseY + Math.sin(elapsed * 3.5 + h.phase) * 0.12;
    const dx = h.mesh.position.x - rig.position.x;
    const dz = h.mesh.position.z - rig.position.z;
    if (dx * dx + dz * dz < 1.4 * 1.4) {
      scene.remove(h.mesh);
      hearts.splice(i, 1);
      playerHP = Math.min(5, playerHP + 1);
      updateHPBar();
      sfx.hit();
    }
  }

  for (const g of cloudGroups) {
    g.position.x += g.userData.spd * dt;
    if (g.position.x > WORLD * TILE + 20) g.position.x = -20;
  }

  renderer.render(scene, camera);
});

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
function initGame() {
  generateMap();
  buildScene();
  spawnPlayer();
  spawnEnemies();
  spawnPushRocks();
  buildMinimap();
  buildHUD();
  updateStarCounter();
}

// ── Asset loading — all 4 GLBs in parallel, start when done ──
let _assetsLeft = 3; // rock + tree_1 + tree_2
function _onAsset() { if (--_assetsLeft === 0) initGame(); }

// Normalize a geometry to unit size with bottom at y = 0
function _normGeo(gltf, { cubeReshape = false } = {}) {
  const geos = [];
  gltf.scene.traverse(child => {
    if (child.isMesh) {
      // Local space only — no matrixWorld so export rotations are not baked in
      geos.push(child.geometry.clone());
    }
  });
  if (!geos.length) return null;
  let geo;
  try { geo = geos.length === 1 ? geos[0] : mergeGeometries(geos); }
  catch { geo = geos[0]; }
  if (!geo) return null;
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z);
  geo.computeBoundingBox();
  const sz = new THREE.Vector3();
  geo.boundingBox.getSize(sz);

  // Trees only: auto-correct if model is lying on its side (Y is not tallest axis)
  if (!cubeReshape) {
    if (sz.z > sz.y + 0.05) {
      // Trunk along Z → rotate -90° around X to stand upright
      geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      geo.computeBoundingBox();
      geo.boundingBox.getSize(sz);
    } else if (sz.x > sz.y + 0.05) {
      // Trunk along X → rotate 90° around Z
      geo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
      geo.computeBoundingBox();
      geo.boundingBox.getSize(sz);
    }
  }

  if (cubeReshape) {
    // Rock: force each axis to 0.85 m then narrow XZ / stretch Y
    geo.scale(0.85 / sz.x, 0.85 / sz.y, 0.85 / sz.z);
    geo.scale(0.80, 1.20, 0.80);
  } else {
    // Tree: uniform scale → 1 m unit cube
    const s = 1.0 / Math.max(sz.x, sz.y, sz.z);
    geo.scale(s, s, s);
  }
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  return geo;
}

const _loader = new GLTFLoader();

// Rock
_loader.load('assets/models/low_poly_rock.glb', gltf => {
  rockGeo = _normGeo(gltf, { cubeReshape: true }) ?? new THREE.BoxGeometry(0.85, 0.85, 0.85);
  rockMat = new THREE.MeshLambertMaterial({ color: 0x9a8870 });
  _onAsset();
}, undefined, () => {
  rockGeo = new THREE.BoxGeometry(0.85, 0.85, 0.85);
  rockMat = new THREE.MeshLambertMaterial({ color: 0x9a8870 });
  _onAsset();
});

// Fix material for non-PBR lighting: if MeshStandardMaterial, clone and zero metalness
// so diffuse color/texture/vertex-colors render correctly under ambient+directional lights.
function _fixMat(mat) {
  if (!mat.isMeshStandardMaterial) return mat;
  const m = mat.clone();
  m.metalness = 0;
  m.roughness  = 0.8;
  return m;
}

// Trees — preserve all per-mesh materials by keeping parts separate (no mergeGeometries)
function _normTreeParts(gltf) {
  const sceneInv = new THREE.Matrix4().copy(gltf.scene.matrixWorld).invert();
  const parts = [];
  gltf.scene.traverse(child => {
    if (!child.isMesh) return;
    const geo = child.geometry.clone();
    // Put geometry in scene-root space (strips root export rotation, keeps relative positions)
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(sceneInv, child.matrixWorld));
    parts.push({ geo, mat: _fixMat(child.material) });
  });
  if (!parts.length) return null;

  function combinedBox() {
    const b = new THREE.Box3();
    parts.forEach(p => { p.geo.computeBoundingBox(); b.union(p.geo.boundingBox); });
    return b;
  }

  // Auto-correct if model is lying on its side
  let box = combinedBox();
  const sz = new THREE.Vector3(); box.getSize(sz);
  let fix = null;
  if (sz.z > sz.y + 0.05)      fix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  else if (sz.x > sz.y + 0.05) fix = new THREE.Matrix4().makeRotationZ( Math.PI / 2);
  if (fix) {
    parts.forEach(p => p.geo.applyMatrix4(fix));
    box = combinedBox(); box.getSize(sz);
  }

  // Center and uniform scale to 1 m unit
  const c = new THREE.Vector3(); box.getCenter(c);
  const s = 1.0 / Math.max(sz.x, sz.y, sz.z);
  parts.forEach(p => { p.geo.translate(-c.x, -c.y, -c.z); p.geo.scale(s, s, s); });

  // Bottom at y = 0
  box = combinedBox();
  const minY = box.min.y;
  parts.forEach(p => p.geo.translate(0, -minY, 0));

  return parts;
}

const _fbColors = [0x2d8c18, 0x5ab830];
['low_poly_tree_1.glb', 'low_poly_tree_2.glb'].forEach((name, i) => {
  _loader.load(`assets/models/${name}`, gltf => {
    treePartsList[i] = _normTreeParts(gltf) ??
      [{ geo: new THREE.CylinderGeometry(0.15, 0.25, 1, 6),
         mat: new THREE.MeshLambertMaterial({ color: _fbColors[i] }) }];
    _onAsset();
  }, undefined, () => {
    treePartsList[i] = [{ geo: new THREE.CylinderGeometry(0.15, 0.25, 1, 6),
                          mat: new THREE.MeshLambertMaterial({ color: _fbColors[i] }) }];
    _onAsset();
  });
});
