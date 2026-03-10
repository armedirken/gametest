import * as THREE from 'three';
import { VRButton }        from 'three/addons/webxr/VRButton.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const TILE  = 12;      // meters per tile (4× escala mundo)
const WORLD = 64;      // grid size
const EYE   = 1.65;    // eye height (m)
const SPEED  = 20;     // movement speed (m/s)

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
// WORLD GENERATION — Eryndell (mundo abierto original)
// ─────────────────────────────────────────────────────────────
let worldMap  = [];
let heightMap = [];
let starList = [];
let worldSeed = 0;
const _occupied = new Set(); // tiles ocupados: árboles + casas NPC → evitar intersecciones
let stars = [];

const pushRocks       = [];
const towerObstacles  = []; // reservado (colisiones manejadas por Rapier)
const castleTowerWalls = []; // reservado (colisiones manejadas por Rapier)
const dragonRoosts    = []; // { x, z, topY } — cima de cada torre con dragón
const dragons         = []; // objetos dragón activos
const fireBalls       = []; // { mesh, vx, vy, vz, life } — bolas de fuego

// ── NPCs y sistema de misiones ────────────────────────────────
const npcs = [];
// ── Aldea de Eryndell — configuración circular ────────────────
const VILLAGE_CX         = 27;              // tile centro X
const VILLAGE_CZ         = 33;              // tile centro Z
const VILLAGE_R          = 2;               // radio del suelo (tiles) — aldea pequeña
const VILLAGE_WALL_R     = 3;               // radio del muro  (tiles)
// 3 entradas: Sur, Noroeste, Noreste (ángulos desde +X en plano XZ)
const VILLAGE_ENT_ANGLES = [Math.PI / 2, Math.PI * 4 / 3, Math.PI * 5 / 3];
const VILLAGE_ENT_HALF   = 0.22;            // semi-apertura por entrada (rad)

// Posiciones en anillo circular radio=5 alrededor de (VILLAGE_CX=27, VILLAGE_CZ=33)
// Ángulos: 0° E, 72° SE, 144° SW, 216° NW, 288° NE
const NPC_DEFS = [
  { tx:28, tz:33, name:'Aldeana',  color:0xff9999, questId:0 }, // E
  { tx:27, tz:34, name:'Herrero',  color:0xaaaaff, questId:1 }, // SE
  { tx:26, tz:34, name:'Maga',     color:0xcc88ff, questId:2 }, // SW
  { tx:27, tz:32, name:'Mercader', color:0xffcc66, questId:3 }, // NW
  { tx:28, tz:32, name:'Ermitaño', color:0x99ffcc, questId:4 }, // NE
  { tx:26, tz:33, name:'Alcalde',  color:0xffd700, questId:5 }, // O — alcalde da misión del boss
];
const QUEST_DEFS = [
  { id:0, title:'Las Monedas Perdidas',    desc:'Recoge 30 monedas doradas\nesparcidas por el mundo.',   goal:30, type:'coins',   reward:'un amuleto de suerte' },
  { id:1, title:'Caza de Monstruos',       desc:'Elimina 5 slimes verdes\nque amenazan la aldea.',       goal:5,  type:'kills',   reward:'una espada mejorada' },
  { id:2, title:'Las Cuatro Torres',       desc:'Visita las 4 torres\nde piedra del mundo.',             goal:4,  type:'towers',  reward:'un libro de hechizos' },
  { id:3, title:'El Gran Explorador',      desc:'Llega al interior\nde la Ciudadela Eryndell.',          goal:1,  type:'castle',  reward:'una bolsa de monedas' },
  { id:4, title:'El Último Superviviente', desc:'Sobrevive 60 segundos\ncon enemigos cerca.',            goal:60, type:'survive', reward:'el escudo legendario' },
  { id:5, title:'El Señor del Castillo',   desc:'Sube al techo del castillo\ny derrota al Slime Gigante.', goal:1, type:'boss', reward:'la Gran Moneda del Boss' },
];
let activeQuestId   = -1;
let questProgress   = 0;
let questComplete   = false;
let questsCompleted = 0; // total de misiones entregadas
let npcDialogEl    = null;
let dialogNPC      = null;
let surviveTimer   = 0;
let towersVisited  = new Set();
let castleEntered  = false;
let questHudEl     = null;
let npcDlgCtx = null, npcDlgTex = null, npcDlgMesh = null;
let _vrAWas   = false;

// ── Salto y física ────────────────────────────────────────────
let jumpVY      = 0;
let onGround    = true;
let jumpPressed = false;
const JUMP_VY   = 22;   // impulso inicial al saltar (m/s)
const GRAVITY   = 50;   // aceleración gravitatoria (m/s²)

// ── Rapier physics ────────────────────────────────────────────
let rapierWorld    = null;
let playerBody     = null;
let playerCollider = null;
let charCtrl       = null;
const CAPSULE_HALF = 0.6;   // halfHeight de la cápsula
const CAPSULE_RAD  = 0.45;  // radio de la cápsula
const CAPS_OFFSET  = CAPSULE_HALF + CAPSULE_RAD; // offset capsule center vs feet = 1.05m

// ── Indicador de bioma ────────────────────────────────────────
let biomeEl        = null;
let lastBiome      = '';
let biomeHideTimer = 0;

// ── Mejoras globales ──────────────────────────────────────────
let playerShadow   = null;
let stamina        = 1.0;
let lastDamageTime = 0;
let regenTimer     = 0;
let comboCount     = 0;
let comboTimer     = 0;
let comboEl        = null;
let questOverlayTimeout = null;
let minimapZoom    = 1;   // 1 = normal, 2 = zoom out
let fireflyList    = [];  // luciérnagas en bosque
let enemyAlertList = [];  // { mesh, timer } — '!' sobre slimes aggroed
let dmgParticles   = [];  // partículas de muerte de enemigos
let rockParticles  = [];  // partículas al romper roca
const rockGeo = _makeRockGeo(42);
const rockMat = new THREE.MeshLambertMaterial({ map: _makeRockTex(), flatShading: true });

// ── Contadores y estado global ────────────────────────────────
let coinsCollected = 0;    // monedas recogidas (evita filter() por frame)
let enemiesKilled  = 0;    // para pantalla de victoria

let coinIM         = null; // InstancedMesh de monedas (30 → 1 draw call)
let bossCoin       = null; // Moneda grande del boss (vale 5, Mesh propio)
let dmgFlashEl     = null; // div de flash rojo al recibir daño
let mazeObstacles  = [];   // obstáculos móviles del laberinto
let mazeKey        = null; // llave del laberinto { mesh, wx, wz, collected }
let hasKey         = false;
let mazeDmgCooldown = 0;   // cooldown para daño de obstáculos del laberinto
let towerDoor      = null; // puerta de la torre { mesh, rb, opened, opening, openT, ... }
let doorMsgCooldown = 0;  // evita spam del mensaje "necesitas la llave"

// ── Sistema de chunks — mundo infinito ──────────────────────
const chunkMap = new Map(); // "cx,cz" → {map, hmap, mesh, collider, trees, biome}
const CHUNK_R  = 1;         // radio de carga (chunks) — 3×3=9; fog limita visión a ~200m
let  _chunkTick = 0;        // throttle
const _chunkBuildQ = [];    // cola asíncrona: construir 1 chunk por frame

// Vectores temporales reutilizables — elimina allocations por frame en move()
const _tmpQ  = new THREE.Quaternion();
const _tmpE  = new THREE.Euler();
const _tmpV3 = new THREE.Vector3();
const coinDummy = new THREE.Object3D(); // reutilizado para actualizar coinIM
let treeLists = [[], [], []];  // [forestList, fieldList, mountainList]
const treePartsList = [
  [_buildTreeParts(42,0), _buildTreeParts(42,1), _buildTreeParts(42,2)],      // bosque
  [_buildTreeParts(97,0), _buildTreeParts(97,1), _buildTreeParts(97,2)],      // pradera
  [_buildSnowTreeParts(13,0), _buildSnowTreeParts(13,1), _buildSnowTreeParts(13,2)], // montaña nevada
  [_buildCactusParts(7), _buildCactusParts(23), _buildCactusParts(41)],       // desierto
];

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


  // ── NORTH ─────────────────────────────────────────────────
  // Monte Sombrío (rocoso, norte centro)
  paintRect(12, 2, 48, 14, T.MOUND);
  paintRect( 8, 2, 12,  9, T.MOUND);  // extends west

  // Bosque Eterno / Bosque Marchito (denso, noroeste)
  paintRect(2, 2, 18, 24, T.FOREST);
  paintRect(2, 24, 8, 40, T.FOREST);  // western forest strip

  // Lago Cristal (agua/hielo, noreste)
  paintRect(46, 2, 62, 16, T.WATER);

  // Meseta NE — montaña natural (castillo NE eliminado)
  paintRect(40, 2, 60, 12, T.MOUND);

  // ── CENTER ────────────────────────────────────────────────
  // Montañas del Este / Palacio de Piedra (lado derecho)
  paintRect(42, 14, 62, 30, T.MOUND);
  paintRect(44, 16, 60, 28, T.FOREST); // forest inside mountains
  paintRect(48, 18, 58, 26, T.MOUND);  // rocky core

  // Aldea Piedraverde (centro-izquierda, pradera abierta)
  paintRect(6, 18, 22, 36, T.GRASS);

  // Llanos del Sur de Eryndell
  paintRect(8, 34, 54, 48, T.GRASS);

  // ── SOUTH ─────────────────────────────────────────────────
  // Desert of Mystery (southwest, sandy)
  paintRect(2, 42, 24, 62, T.SAND);
  paintRect(2, 38, 14, 42, T.SAND);  // sand creeps north

  // Swamp / marshland (south center-left)
  paintRect(18, 50, 30, 62, T.WATER);

  // Lago Esmeralda (gran masa de agua, sur centro-derecha)
  paintRect(30, 46, 62, 62, T.WATER);
  paintRect(34, 48, 60, 62, T.DEEP);

  // Islote en Lago Esmeralda (antigua mazmorra)
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

  // ── RÍO PLATEADO ─────────────────────────────────────────
  // Franja diagonal: Lago Cristal (col≈54,row≈10) → Lago Esmeralda (col≈34,row≈48)
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

  // ── ALDEA DE ERYNDELL — suelo PATH circular plano ────────
  for (let z = VILLAGE_CZ - VILLAGE_R - 1; z <= VILLAGE_CZ + VILLAGE_R + 1; z++)
    for (let x = VILLAGE_CX - VILLAGE_R - 1; x <= VILLAGE_CX + VILLAGE_R + 1; x++) {
      const _dx = x - VILLAGE_CX, _dz = z - VILLAGE_CZ;
      if (_dx*_dx + _dz*_dz <= VILLAGE_R * VILLAGE_R) worldMap[z][x] = T.PATH;
    }

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
        case T.GRASS:  heightMap[z][x] =  n * 9.0;        break; // colinas pronunciadas
        case T.FOREST: heightMap[z][x] =  0.8 + n*13.0;  break; // bosques con relieve
        case T.MOUND:  heightMap[z][x] =  2.0 + n*28.0;  break; // montañas altas
        default:       heightMap[z][x] =  0;            break;
      }
    }
  }

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

  // ── Planicie del Castillo Principal — aplicada POST-blur para no ser anulada ──
  for (let z = 7; z < 27; z++)
    for (let x = 17; x < 45; x++) {
      if (worldMap[z][x] === T.DWALL || worldMap[z][x] === T.DFLOOR)
        heightMap[z][x] = 0; // piso plano exacto para castillo
      else
        heightMap[z][x] = 0.3; // entorno plano
    }

  // ── Elevar suelo circular de la aldea — mínimo 0.5m para evitar filtración del océano ──
  for (let z = VILLAGE_CZ - VILLAGE_R - 1; z <= VILLAGE_CZ + VILLAGE_R + 1; z++)
    for (let x = VILLAGE_CX - VILLAGE_R - 1; x <= VILLAGE_CX + VILLAGE_R + 1; x++) {
      if (z < 0 || z >= WORLD || x < 0 || x >= WORLD) continue;
      const _dx = x - VILLAGE_CX, _dz = z - VILLAGE_CZ;
      if (_dx*_dx + _dz*_dz <= VILLAGE_R * VILLAGE_R)
        heightMap[z][x] = Math.max(heightMap[z][x], 0.5);
    }

  // ── TREE / ROCK / STAR LISTS ─────────────────────────────
  starList = [];
  treeLists = [[], [], []];
  _occupied.clear();

  // Pre-bloquear área circular de la aldea + margen (sin árboles ni rocas adentro)
  for (let z = VILLAGE_CZ - VILLAGE_R - 2; z <= VILLAGE_CZ + VILLAGE_R + 2; z++)
    for (let x = VILLAGE_CX - VILLAGE_R - 2; x <= VILLAGE_CX + VILLAGE_R + 2; x++) {
      const _dx = x - VILLAGE_CX, _dz = z - VILLAGE_CZ;
      if (_dx*_dx + _dz*_dz <= (VILLAGE_R + 1) * (VILLAGE_R + 1)) _occupied.add(x + ',' + z);
    }

  const STAR_TILES  = new Set([T.GRASS, T.PATH, T.SAND, T.DFLOOR]);
  const PUSH_TILES  = new Set([T.GRASS, T.MOUND, T.SAND]);
  const TOWER_TILES = new Set([T.GRASS, T.MOUND, T.SAND]);

  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      const t   = worldMap[z][x];
      const key = x + ',' + z;

      // Trees — múltiples árboles por tile con offsets sub-tile (×10 densidad)
      // Offsets en fracciones de tile: 4 posiciones por tile
      const treeOffsets = [[0,0],[0.45,0.2],[0.2,0.45],[-0.3,0.35]];

      // Excluir árboles dentro de las torres (radio ~3 tiles alrededor de cada una)
      const nearTower = (Math.abs(x - 17) < 3 && Math.abs(z - 24) < 3)
                     || (Math.abs(x - 44) < 3 && Math.abs(z - 24) < 3);

      if (t === T.FOREST && !nearTower) {
        for (let ti = 0; ti < treeOffsets.length; ti++) {
          const tk = key + '_' + ti;
          if (!_occupied.has(tk) && hash(x + ti * 7, z + ti * 11, worldSeed + 1 + ti * 50) > 0.05) {
            treeLists[0].push([x + treeOffsets[ti][0], z + treeOffsets[ti][1]]);
            _occupied.add(tk);
          }
        }
        _occupied.add(key); // bloquea coins/rocas en este tile
      }

      if (t === T.GRASS && !_occupied.has(key) && !nearTower) {
        const nearWater = [[z-1,x],[z+1,x],[z,x-1],[z,x+1]].some(
          ([nz,nx]) => nz>=0&&nz<WORLD&&nx>=0&&nx<WORLD &&
                       (worldMap[nz][nx]===T.WATER||worldMap[nz][nx]===T.DEEP));
        const thr = nearWater ? 0.30 : 0.45;
        for (let ti = 0; ti < treeOffsets.length; ti++) {
          if (hash(x + ti * 9, z + ti * 13, worldSeed + 11 + ti * 50) > thr) {
            treeLists[1].push([x + treeOffsets[ti][0], z + treeOffsets[ti][1]]);
          }
        }
        if (hash(x, z, worldSeed + 11) > thr) _occupied.add(key);
      }

      // Montaña — 3 árboles por tile
      if (t === T.MOUND && !_occupied.has(key) && !nearTower) {
        for (let ti = 0; ti < 3; ti++) {
          if (hash(x + ti * 5, z + ti * 7, worldSeed + 21 + ti * 50) > 0.20) {
            treeLists[0].push([x + treeOffsets[ti][0], z + treeOffsets[ti][1]]);
          }
        }
        _occupied.add(key);
      }

      // rockList decorativo eliminado — las rocas "balón" (DodecahedronGeometry) ya no se usan

      // Monedas: saltar tiles con árbol, roca empujable o torre
      if (starList.length < 30 && STAR_TILES.has(t) && !_occupied.has(key)
          && hash(x, z, worldSeed+99) > 0.91
          && !(PUSH_TILES.has(t)  && hash(x, z, worldSeed+88)  > 0.988)
          && !(TOWER_TILES.has(t) && hash(x, z, worldSeed+777) > 0.988)) {
        starList.push([x, z]);
      }
    }
  }
}

function carvePaths() {
  const SAFE = t => t !== T.DEEP && t !== T.WATER && t !== T.DWALL && t !== T.DFLOOR;

  // Camino N-S: desde la puerta sur de la Ciudadela hacia los Llanos del Sur
  for (let z = 22; z < 48; z++) {
    if (SAFE(worldMap[z][30])) worldMap[z][30] = T.PATH;
    if (SAFE(worldMap[z][31])) worldMap[z][31] = T.PATH;
  }
  // Camino norte: puerta norte de la Ciudadela hacia Monte Sombrío
  for (let z = 2; z < 12; z++) {
    if (SAFE(worldMap[z][30])) worldMap[z][30] = T.PATH;
  }
  // Camino E-O central de Eryndell
  for (let x = 6; x < 56; x++) {
    if (SAFE(worldMap[34][x])) worldMap[34][x] = T.PATH;
  }
  // Camino a Aldea Piedraverde (ramal oeste)
  for (let x = 6; x < 22; x++) {
    if (SAFE(worldMap[26][x])) worldMap[26][x] = T.PATH;
  }
  // Camino este hacia Palacio de Piedra (fila 26, lado este)
  for (let x = 32; x < 56; x++) {
    if (SAFE(worldMap[26][x])) worldMap[26][x] = T.PATH;
  }

  // ── Caminos a mazmorras ─────────────────────────────────────
  // Bosque Marchito (NO): camino desde x=7 bajando hasta camino E-O
  for (let z = 9; z < 34; z++)
    if (SAFE(worldMap[z][7])) worldMap[z][7] = T.PATH;
  // Palacio de Piedra (E): desde castillo este hasta palacio
  for (let x = 31; x < 50; x++)
    if (SAFE(worldMap[22][x])) worldMap[22][x] = T.PATH;
  for (let z = 23; z < 34; z++)
    if (SAFE(worldMap[z][50])) worldMap[z][50] = T.PATH;
  // Torre de Arena (SO): camino este desde el palacio
  for (let x = 9; x < 30; x++)
    if (SAFE(worldMap[50][x])) worldMap[50][x] = T.PATH;
  // Swamp Palace (S-center): camino norte hasta E-W road
  for (let z = 34; z < 52; z++)
    if (SAFE(worldMap[z][23])) worldMap[z][23] = T.PATH;
  // Ice Palace (SE): camino oeste hasta main road
  for (let x = 32; x < 44; x++)
    if (SAFE(worldMap[52][x])) worldMap[52][x] = T.PATH;

  // ── Ríos adicionales — serpentean por la isla ───────────────
  // Río del Bosque: baja desde el norte por el bosque oeste (x≈14) hasta el sur
  for (let z = 5; z < 40; z++) {
    const rx = 14 + Math.round(Math.sin(z * 0.4) * 2);
    for (let w = 0; w < 2; w++) {
      const tx = rx + w;
      if (tx >= 0 && tx < WORLD && SAFE(worldMap[z][tx]))
        worldMap[z][tx] = T.WATER;
    }
  }
  // Río del Este: baja desde montañas este hacia el lago del sur
  for (let z = 18; z < 48; z++) {
    const rx = 44 + Math.round(Math.sin(z * 0.35) * 3);
    for (let w = 0; w < 2; w++) {
      const tx = rx + w;
      if (tx >= 0 && tx < WORLD && SAFE(worldMap[z][tx]))
        worldMap[z][tx] = T.WATER;
    }
  }
  // Río del Sur: cruce horizontal entre desierto y pradera
  for (let x = 6; x < 36; x++) {
    const rz = 44 + Math.round(Math.sin(x * 0.5) * 2);
    if (rz >= 0 && rz < WORLD && SAFE(worldMap[rz][x]))
      worldMap[rz][x] = T.WATER;
  }
}

function placeDungeons() {
  // Ubicaciones fijas de palacios/mazmorras de Eryndell
  const LOCS = [
    { x:  4, z:  4, w: 7, h: 6 },  // Bosque Marchito (bosque NO)
    { x: 46, z: 18, w: 8, h: 7 },  // Palacio de Piedra (montañas este)
    { x:  4, z: 48, w: 8, h: 6 },  // Torre de Arena (desierto SO)
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
// PLAYER SHADOW (mejora #2) — declarada aquí, creada en buildScene
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLOR.SKY);
scene.fog        = new THREE.FogExp2(0x9ec8e8, 0.007);  // niebla atmosférica — efecto enormidad

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFShadowMap; // PCFSoft demasiado costoso en móvil
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

// Linterna nocturna — se activa automáticamente al anochecer
const nightLantern = new THREE.PointLight(0xffcc66, 0, 35);
nightLantern.position.set(0, EYE * 0.8, 0);
rig.add(nightLantern);

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
sun.shadow.mapSize.set(1024, 1024); // 2048 demasiado pesado en Quest 2
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
  // (fog ya configurado en setup global)

  // ── Smooth terrain mesh (vertex-colored BufferGeometry) ──────
  const V = WORLD + 1; // vertices per side
  const positions = new Float32Array(V * V * 3);
  const colors    = new Float32Array(V * V * 3);
  // Pre-aloca Uint32Array — evita ~24k push() calls (mejora #13)
  const idxCount = WORLD * WORLD * 6;
  const idxArr   = new Uint32Array(idxCount);
  let   ii       = 0;

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
  // Two triangles per tile quad (Uint32Array pre-aloc — sin push)
  for (let iz = 0; iz < WORLD; iz++) {
    for (let ix = 0; ix < WORLD; ix++) {
      const tl = iz*V+ix, tr = tl+1, bl = tl+V, br = bl+1;
      idxArr[ii++]=tl; idxArr[ii++]=bl; idxArr[ii++]=tr;
      idxArr[ii++]=tr; idxArr[ii++]=bl; idxArr[ii++]=br;
    }
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  terrainGeo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
  terrainGeo.setIndex(new THREE.BufferAttribute(idxArr, 1));
  terrainGeo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(
    terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true })
  );
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // ── Water surface — shader realista con olas geométricas + normales per-pixel ──
  {
    // Malla densa y cercana: 1600m × 1600m, 130×130 vértices → quad ~12m (= TILE)
    // Las olas geométricas son visibles de cerca; el fog oculta el borde
    const _wVert = `
      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vec3 pos = position;
        // Olas grandes (escala geométrica) — amplitud aumentada para que se vean
        float w1 = sin(pos.x * 0.10 + uTime * 1.20) * 0.70;
        float w2 = cos(pos.y * 0.08 + uTime * 0.90) * 0.50;
        float w3 = sin((pos.x + pos.y) * 0.055 + uTime * 0.70) * 0.35;
        float w4 = cos((pos.x - pos.y) * 0.045 + uTime * 1.10) * 0.22;
        pos.z += w1 + w2 + w3 + w4;
        // Derivadas para normal de vértice
        float dx = cos(pos.x * 0.10 + uTime * 1.20) * 0.10 * 0.70
                 + cos((pos.x + pos.y) * 0.055 + uTime * 0.70) * 0.055 * 0.35
                 - sin((pos.x - pos.y) * 0.045 + uTime * 1.10) * 0.045 * 0.22;
        float dy = -sin(pos.y * 0.08 + uTime * 0.90) * 0.08 * 0.50
                 + cos((pos.x + pos.y) * 0.055 + uTime * 0.70) * 0.055 * 0.35
                 + sin((pos.x - pos.y) * 0.045 + uTime * 1.10) * 0.045 * 0.22;
        vWorldNormal = normalize(mat3(modelMatrix) * normalize(vec3(-dx, -dy, 1.0)));
        vec4 worldPos = modelMatrix * vec4(pos, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }`;
    const _wFrag = `
      uniform float uTime;
      uniform vec3  uSunDir;
      uniform float uFogDensity;
      uniform vec3  uFogColor;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      // Normal per-pixel de micro-ondas (alta frecuencia, sin coste geométrico)
      vec3 microNormal() {
        float mx = cos(vWorldPos.x*0.55 + uTime*2.10)*0.55*0.18
                 + cos((vWorldPos.x-vWorldPos.z)*0.38 + uTime*2.60)*0.38*0.12;
        float mz = cos(vWorldPos.z*0.44 + uTime*1.80)*0.44*0.20
                 + sin((vWorldPos.x+vWorldPos.z)*0.32 + uTime*1.50)*0.32*0.15;
        return normalize(vec3(-mx, 1.0, -mz));
      }

      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float dist   = length(vWorldPos - cameraPosition);

        // Mezcla normal de vértice (olas grandes) con micro-normal (detalle cercano)
        float microW = 1.0 - smoothstep(8.0, 60.0, dist);
        vec3  N      = normalize(mix(vWorldNormal, microNormal(), microW * 0.65));

        float NdotV  = max(dot(N, viewDir), 0.0);
        float fresnel = pow(1.0 - NdotV, 2.2);

        // Color por profundidad / ángulo
        vec3 deep    = vec3(0.03, 0.12, 0.38);
        vec3 shallow = vec3(0.08, 0.52, 0.70);
        vec3 col     = mix(deep, shallow, fresnel * 0.55 + 0.12);

        // Specular solar
        vec3 halfV = normalize(uSunDir + viewDir);
        float spec = pow(max(dot(N, halfV), 0.0), 110.0);
        col += vec3(1.0, 0.97, 0.88) * spec * 1.1;

        // Segundo lóbulo specular más suave (brillo difuso del sol)
        float spec2 = pow(max(dot(N, halfV), 0.0), 18.0);
        col += vec3(0.4, 0.65, 0.9) * spec2 * 0.12;

        // Cáusticas animadas
        float s1 = sin(vWorldPos.x*0.28+uTime*2.1) * sin(vWorldPos.z*0.28+uTime*1.7);
        float s2 = sin(vWorldPos.x*0.17+uTime*1.4+1.0) * sin(vWorldPos.z*0.21+uTime*1.9);
        col += vec3(0.35, 0.6, 0.9) * clamp(s1*0.5+s2*0.35+0.5, 0.0, 1.0) * 0.07;

        float alpha = mix(0.65, 0.94, fresnel);
        float fogF  = 1.0 - exp(-uFogDensity * dist);
        gl_FragColor = vec4(mix(col, uFogColor, fogF), alpha);
      }`;
    waterMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1600, 130, 130),
      new THREE.ShaderMaterial({
        uniforms: {
          uTime:       { value: 0 },
          uSunDir:     { value: new THREE.Vector3(0.6, 0.8, 0.3).normalize() },
          uFogDensity: { value: 0.007 },
          uFogColor:   { value: new THREE.Color(0x9ec8e8) },
        },
        vertexShader:   _wVert,
        fragmentShader: _wFrag,
        transparent: true,
      })
    );
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.set(0, -0.08, 0);
    scene.add(waterMesh);
  }

  // Foam eliminado — causaba cuadrados grises cerca de la costa

  // ── DWALL — GLB rock stacks ───────────────────────────────────
  const dwalls = [];
  for (let z = 0; z < WORLD; z++)
    for (let x = 0; x < WORLD; x++)
      if (worldMap[z][x] === T.DWALL) dwalls.push([x, z]);
  if (dwalls.length) {
    const WLAYERS = 7;                     // layers per wall tile (+40% altura)
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
          // Variación sutil por roca: altura y rotación Y ligeramente distintas
          const hVar = 0.90 + hash(x + ri * 3, z + ly * 7, worldSeed + 66) * 0.20;
          const ry   = (hash(x + ri, z + ly + ri, worldSeed + 67) - 0.5) * 0.15;
          dummy.position.set(px, py, pz);
          dummy.rotation.set(0, ry, 0);
          if (type === 'corner') dummy.scale.set(CORNER_SCALE_XZ, WSCALE * hVar, CORNER_SCALE_XZ);
          else                   dummy.scale.set(WSCALE, WSCALE * hVar, WSCALE);
          dummy.updateMatrix();
          wallIM.setMatrixAt(wi, dummy.matrix);
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

  // ── DFLOOR — losas de roca (cubos planos)
  { const dfloors = [];
    for (let z = 0; z < WORLD; z++)
      for (let x = 0; x < WORLD; x++)
        if (worldMap[z][x] === T.DFLOOR) dfloors.push([x, z]);
    if (dfloors.length) {
      const FSCALE_XZ = (TILE * 0.97) / 0.68; // ≈ 4.28
      const floorIM = new THREE.InstancedMesh(rockGeo, rockMat, dfloors.length);
      floorIM.receiveShadow = true;
      dfloors.forEach(([x, z], i) => {
        const thick = 0.14 + hash(x, z, worldSeed + 44) * 0.07;
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

  // ── Trees — árboles low-poly proceduales por bioma ───────────
  const TREE_BASE = [1.2, 1.2, 1.2]; // tamaño mínimo
  const TREE_VARY = [8.0, 7.0, 8.0]; // rango → 1.2 a 9.2 m

  treeLists.forEach((list, mi) => {
    const partsArr = treePartsList[mi];
    if (!list.length || !partsArr) return;

    // Clasificar árboles por tamaño: 0=pequeño(<3.5), 1=mediano(3.5-6.5), 2=grande(>6.5)
    const buckets = [[], [], []];
    list.forEach(([x, z]) => {
      const sc = TREE_BASE[mi] + hash(x, z, worldSeed + 77 + mi * 13) * TREE_VARY[mi];
      const cls = sc < 3.5 ? 0 : sc < 6.5 ? 1 : 2;
      buckets[cls].push([x, z]);
    });

    buckets.forEach((bucket, cls) => {
      if (!bucket.length) return;
      const parts = partsArr[cls];
      parts.forEach(({ geo, mat }) => {
        const im = new THREE.InstancedMesh(geo, mat, bucket.length);
        im.castShadow = im.receiveShadow = true;
        bucket.forEach(([x, z], i) => {
          const wx = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
          const sc = TREE_BASE[mi] + hash(x, z, worldSeed + 77 + mi * 13) * TREE_VARY[mi];
          const ry = hash(x, z, worldSeed + 7  + mi * 17) * Math.PI * 2;
          const lx = (hash(x, z, worldSeed + 91) - 0.5) * 0.18;
          const lz = (hash(x, z, worldSeed + 92) - 0.5) * 0.18;
          dummy.position.set(wx, groundAt(wx, wz) - sc * 0.06, wz);
          dummy.rotation.set(lx, ry, lz);
          dummy.scale.setScalar(sc);
          dummy.updateMatrix();
          im.setMatrixAt(i, dummy.matrix);
        });
        im.instanceMatrix.needsUpdate = true;
        scene.add(im);
      });
    });
  });

  // Rocas decorativas eliminadas (DodecahedronGeometry parecía balón de fútbol)

  // ── Monedas — InstancedMesh (30 meshes → 1 draw call, mejora #15) ──
  stars = [];
  coinsCollected = 0;
  if (starList.length) {
    const coinGeo = new THREE.CylinderGeometry(0.66, 0.66, 0.18, 16);
    const coinMat = new THREE.MeshLambertMaterial({
      color: 0xffd700, emissive: 0xcc8800, emissiveIntensity: 0.6
    });
    coinIM = new THREE.InstancedMesh(coinGeo, coinMat, starList.length);
    coinIM.castShadow = true;
    scene.add(coinIM);
    starList.forEach(([x, z], i) => {
      const wx = x * TILE + TILE/2, wz = z * TILE + TILE/2;
      const baseY = groundAt(wx, wz) + 1.0;
      coinDummy.position.set(wx, baseY, wz);
      coinDummy.rotation.set(0, 0, 0);
      coinDummy.scale.setScalar(1);
      coinDummy.updateMatrix();
      coinIM.setMatrixAt(i, coinDummy.matrix);
      stars.push({ instIdx: i, collected: false, rising: false, riseT: 0,
                   wx, wz, baseY, phase: hash(x, z, worldSeed+55) * Math.PI * 2 });
    });
    coinIM.instanceMatrix.needsUpdate = true;
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
      const ty = groundAt(x*TILE + TILE/2, z*TILE + TILE/2) + 1.5; // usa heightMap real
      dummy.position.set(x*TILE + TILE/2, ty, z*TILE + TILE/2);
      dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1);
      dummy.updateMatrix();
      tIM.setMatrixAt(i, dummy.matrix);
      dummy.position.y = ty + 0.4;
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

  // ── Sun sphere ───────────────────────────────────────────────
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(5, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff176 })
  );
  sunMesh.position.set(140, 180, 100);
  scene.add(sunMesh);

  // ── Player shadow (mejora #2) ────────────────────────────────
  const shadowGeo = new THREE.CircleGeometry(0.35, 8);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.3, transparent: true });
  playerShadow = new THREE.Mesh(shadowGeo, shadowMat);
  playerShadow.rotation.x = -Math.PI / 2;
  playerShadow.position.y = 0.01;
  scene.add(playerShadow);

  // ── Fireflies en bosque (mejora #12) ────────────────────────
  fireflyList = [];
  const ffGeo = new THREE.SphereGeometry(0.06, 4, 3);
  const ffMat = new THREE.MeshBasicMaterial({ color: 0xaaffaa, transparent: true, opacity: 0.85 });
  let ffCount = 0;
  for (let z = 2; z < WORLD - 2 && ffCount < 30; z++) {
    for (let x = 2; x < WORLD - 2 && ffCount < 30; x++) {
      if (worldMap[z][x] === T.FOREST && hash(x, z, worldSeed + 333) > 0.95) {
        const wx = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
        const ff = new THREE.Mesh(ffGeo, ffMat);
        const baseY = groundAt(wx, wz) + 1.0 + hash(x, z, worldSeed + 334) * 1.5;
        ff.position.set(wx, baseY, wz);
        scene.add(ff);
        fireflyList.push({ mesh: ff, baseY, phase: hash(x, z, worldSeed + 335) * Math.PI * 2,
                           wx, wz });
        ffCount++;
      }
    }
  }

  // ── Moon (mejora #7) ─────────────────────────────────────────
  const moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(3, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xeeeebb })
  );
  moonMesh.position.set(-140, 180, -100);
  moonMesh.name = 'moon';
  scene.add(moonMesh);

  // Stars (mejora #7) — pequeños puntos fijos
  const starFieldGeo = new THREE.BufferGeometry();
  const sfPos = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.random() * Math.PI;
    const r     = 280;
    sfPos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    sfPos[i*3+1] = Math.abs(r * Math.cos(phi)) + 20;
    sfPos[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
  }
  starFieldGeo.setAttribute('position', new THREE.BufferAttribute(sfPos, 3));
  const starFieldMesh = new THREE.Points(starFieldGeo,
    new THREE.PointsMaterial({ color: 0xffffff, size: 1.8, sizeAttenuation: true }));
  starFieldMesh.name = 'starfield';
  starFieldMesh.visible = false;
  scene.add(starFieldMesh);
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
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  switch (e.code) {
    case 'KeyE':
      if (dialogNPC) {
        if (activeQuestId !== dialogNPC.questId && !questComplete) acceptQuest(dialogNPC);
        else closeDialog();
      }
      break;
    case 'KeyM':
      minimapZoom = minimapZoom === 1 ? 2 : 1;
      break;
  }
});
window.addEventListener('keyup',   e => { delete keys[e.code]; });

let yaw = 0, pitch = 0, pointerLocked = false;
let mouseAttack = false, mouseShield = false;
let pcSword = null, pcShield = null, pcSwordSwingT = 0;

renderer.domElement.addEventListener('click', () => {
  if (!renderer.xr.isPresenting) renderer.domElement.requestPointerLock();
});
renderer.domElement.addEventListener('mousedown', e => {
  if (!pointerLocked) return;
  if (e.button === 0) { mouseAttack = true; setTimeout(() => { mouseAttack = false; }, 180); sfx.swing(); pcSwordSwingT = 0.22; }
  if (e.button === 2) mouseShield = true;
});
renderer.domElement.addEventListener('mouseup', e => {
  if (e.button === 2) mouseShield = false;
});
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
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

renderer.xr.addEventListener('sessionstart', () => {
  camera.position.set(0, 0, 0);
  // ── Optimizaciones Quest 2 ─────────────────────────────────
  renderer.shadowMap.enabled      = false;
  renderer.toneMapping            = THREE.LinearToneMapping;
  renderer.toneMappingExposure    = 1.0;
  renderer.setPixelRatio(1);
  if (isRaining) stopRain();
  rainTimer = 999999;
  // Ocultar HUD HTML — usar solo el HUD 3D en VR
  const dh = document.getElementById('desktop-hud');
  if (dh) dh.style.display = 'none';
  if (hudMesh3d) hudMesh3d.visible = true;
  if (mmMesh3d)  mmMesh3d.visible  = true;
  if (npcDlgMesh) npcDlgMesh.visible = !!dialogNPC;
  if (pcSword)  pcSword.visible  = false;
  if (pcShield) pcShield.visible = false;
  mmDisp.style.display  = 'none';
  mmInfoEl.style.display = 'none';
});
renderer.xr.addEventListener('sessionend', () => {
  camera.position.set(0, EYE, 0);
  renderer.shadowMap.enabled      = true;
  renderer.toneMapping            = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure    = 1.1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  rainTimer = 60 + Math.random() * 60;
  // Restaurar HUD HTML — ocultar HUD 3D en desktop
  const dh = document.getElementById('desktop-hud');
  if (dh) dh.style.display = '';
  if (hudMesh3d) hudMesh3d.visible = false;
  if (mmMesh3d)  mmMesh3d.visible  = false;
  if (pcSword)  pcSword.visible  = true;
  if (pcShield) pcShield.visible = true;
  mmDisp.style.display  = '';
  mmInfoEl.style.display = '';
});

// ─────────────────────────────────────────────────────────────
// WEAPONS
// ─────────────────────────────────────────────────────────────
function createSword() {
  const g = new THREE.Group();

  // Blade — bottom edge at y=0.025 (top of guard) so no gap
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.7, 0.008),
    new THREE.MeshLambertMaterial({ color: 0xd4d4d4 })
  );
  blade.position.y = 0.375;
  g.add(blade);

  // Edge highlight (white stripe along blade)
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(0.01, 0.7, 0.012),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  edge.position.set(0.02, 0.375, 0);
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

  // Estrella de Eryndell — símbolo propio (8 puntas, canvas texture)
  const _ec = document.createElement('canvas');
  _ec.width = _ec.height = 128;
  const _ectx = _ec.getContext('2d');
  _ectx.clearRect(0, 0, 128, 128);
  _ectx.save();
  _ectx.translate(64, 64);
  // 8 puntas grandes
  _ectx.fillStyle = '#ffd700';
  for (let i = 0; i < 8; i++) {
    _ectx.save();
    _ectx.rotate(i * Math.PI / 4);
    _ectx.beginPath();
    _ectx.moveTo(0, -46);
    _ectx.lineTo(7, -18);
    _ectx.lineTo(0, -12);
    _ectx.lineTo(-7, -18);
    _ectx.closePath();
    _ectx.fill();
    _ectx.restore();
  }
  // círculo central
  _ectx.beginPath();
  _ectx.arc(0, 0, 11, 0, Math.PI * 2);
  _ectx.fill();
  // aro interior dorado más oscuro
  _ectx.strokeStyle = '#b8860b';
  _ectx.lineWidth = 2;
  _ectx.beginPath();
  _ectx.arc(0, 0, 11, 0, Math.PI * 2);
  _ectx.stroke();
  _ectx.restore();
  const _emblemTex = new THREE.CanvasTexture(_ec);
  // plano del emblema — solo cara delantera (FrontSide), queda en la cara del escudo
  const emblemPlane = new THREE.Mesh(
    new THREE.CircleGeometry(0.19, 24),
    new THREE.MeshBasicMaterial({ map: _emblemTex, transparent: true, depthWrite: false, side: THREE.FrontSide })
  );
  emblemPlane.position.z = -0.022;
  g.add(emblemPlane);

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
  const gtx = Math.floor(wx / TILE), gtz = Math.floor(wz / TILE);
  const cx  = Math.floor(gtx / WORLD), cz  = Math.floor(gtz / WORLD);
  const tx  = gtx - cx * WORLD,        tz  = gtz - cz * WORLD;
  const ch  = chunkMap.get(`${cx},${cz}`);
  return ch?.map[tz]?.[tx] ?? T.GRASS;
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
// Vertex height across all chunks (multi-chunk aware)
function worldVertexH(gx, gz) {
  let sumH = 0, cnt = 0;
  for (const [dz, dx] of [[-1,-1],[-1,0],[0,-1],[0,0]]) {
    const tgx = gx + dx, tgz = gz + dz;
    const cx  = Math.floor(tgx / WORLD), cz = Math.floor(tgz / WORLD);
    const tx  = tgx - cx * WORLD,        tz  = tgz - cz * WORLD;
    if (tx < 0 || tx >= WORLD || tz < 0 || tz >= WORLD) continue;
    const ch = chunkMap.get(`${cx},${cz}`);
    if (!ch) continue;
    const t = ch.map[tz]?.[tx];
    if (t === undefined) continue;
    sumH += (t === T.DWALL) ? 0 : (ch.hmap[tz][tx] ?? 0);
    cnt++;
  }
  return cnt ? sumH / cnt : 0;
}
// Interpolación de altura que reproduce EXACTAMENTE la misma triangulación
// que usa buildChunkMesh (tl,bl,tr / tr,bl,br) — evita que árboles/objetos
// se hundan en terreno empinado
function groundAt(wx, wz) {
  const gtx = Math.floor(wx / TILE), gtz = Math.floor(wz / TILE);
  const fx  = (wx - gtx * TILE) / TILE;   // 0-1 dentro del tile
  const fz  = (wz - gtz * TILE) / TILE;   // 0-1 dentro del tile
  const TL = worldVertexH(gtx,   gtz);
  const TR = worldVertexH(gtx+1, gtz);
  const BL = worldVertexH(gtx,   gtz+1);
  const BR = worldVertexH(gtx+1, gtz+1);
  // El mesh divide cada tile con la diagonal TL→BR:
  //   Triángulo 1 (TL,BL,TR): fx+fz <= 1
  //   Triángulo 2 (TR,BL,BR): fx+fz >  1
  if (fx + fz <= 1) {
    return TL + (TR - TL) * fx + (BL - TL) * fz;
  } else {
    return TR + (1 - fx) * (BL - TR) + (fx + fz - 1) * (BR - TR);
  }
}


// ─────────────────────────────────────────────────────────────
// RAPIER PHYSICS
// ─────────────────────────────────────────────────────────────
async function initPhysics() {
  await RAPIER.init();
  rapierWorld = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });

  // Character controller
  charCtrl = rapierWorld.createCharacterController(0.05);
  charCtrl.setSlideEnabled(true);
  charCtrl.setMaxSlopeClimbAngle(55 * Math.PI / 180);
  charCtrl.setMinSlopeSlideAngle(45 * Math.PI / 180);
  charCtrl.enableSnapToGround(0.5);
  charCtrl.enableAutostep(0.5, 0.2, true); // auto-sube hasta 0.5m (terreno); escalones 1.2m requieren salto

  // Player capsule (kinematic)
  const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
  playerBody = rapierWorld.createRigidBody(bodyDesc);
  const capsDesc = RAPIER.ColliderDesc.capsule(CAPSULE_HALF, CAPSULE_RAD);
  playerCollider = rapierWorld.createCollider(capsDesc, playerBody);
}

function addTerrainCollider() {
  const W = WORLD;
  const V = W + 1; // 65 vértices por lado

  // Vértices: exactamente iguales al terrain mesh visual
  const verts = new Float32Array(V * V * 3);
  for (let iz = 0; iz < V; iz++) {
    for (let ix = 0; ix < V; ix++) {
      const vi = iz * V + ix;
      verts[vi * 3]     = ix * TILE;
      verts[vi * 3 + 1] = vertexH(ix, iz);
      verts[vi * 3 + 2] = iz * TILE;
    }
  }

  // Índices: mismos triángulos que el terrain mesh visual
  const indices = new Uint32Array(W * W * 6);
  let ii = 0;
  for (let iz = 0; iz < W; iz++) {
    for (let ix = 0; ix < W; ix++) {
      const tl = iz * V + ix,       tr = iz * V + ix + 1;
      const bl = (iz + 1) * V + ix, br = (iz + 1) * V + ix + 1;
      indices[ii++] = tl; indices[ii++] = bl; indices[ii++] = tr;
      indices[ii++] = tr; indices[ii++] = bl; indices[ii++] = br;
    }
  }

  rapierWorld.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices));
}

function addWallColliders() {
  const wallH  = 7 * (1.02 * TILE / (3 * 0.68)); // WLAYERS * LAYER_H ≈ 42m
  const hHalf  = wallH / 2;
  const tHalf  = TILE / 2;
  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      if (worldMap[z][x] !== T.DWALL) continue;
      const wx = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
      const bh = heightMap[z][x] ?? 0;
      rapierWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(tHalf, hHalf, tHalf)
          .setTranslation(wx, bh + hHalf, wz)
      );
    }
  }
}

// Helper: quaternion desde rotación Y (para colliders rotados)
function _yRotQuat(angle) {
  const h = angle / 2;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
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

  const isMoving = mx !== 0 || mz !== 0;

  // Sprint (mejora #4) — Shift acelera, drena stamina
  const isSprinting = (keys['ShiftLeft'] || keys['ShiftRight']) && stamina > 0.05 && isMoving && !renderer.xr.isPresenting;
  if (isSprinting) stamina = Math.max(0, stamina - dt * 0.5);
  else stamina = Math.min(1, stamina + dt * 0.25);

  // Castle quest progress (mejora #3)
  if (activeQuestId === 3 && !questComplete) {
    const curTile = tileAt(rig.position.x, rig.position.z);
    if (curTile === T.DFLOOR && !castleEntered) {
      castleEntered = true; questProgress = 1; questComplete = true; updateQuestHUD();
    }
  }

  // Camera bob (mejora #1)
  if (!renderer.xr.isPresenting) {
    const bobAmt = isMoving ? Math.sin(elapsed * 8) * 0.04 : 0;
    camera.position.y = EYE + bobAmt;
  }

  let wdx = 0, wdz = 0; // desplazamiento horizontal deseado (se pasa a Rapier abajo)

  if (isMoving) {
    let hy = yaw;
    if (renderer.xr.isPresenting) {
      // Reutilizar _tmpQ/_tmpE — sin new por frame (mejora #14)
      camera.getWorldQuaternion(_tmpQ);
      hy = _tmpE.setFromQuaternion(_tmpQ, 'YXZ').y;
    }

    // Reutilizar _tmpV3 — sin new Three.Vector3 por frame
    _tmpV3.set(mx, 0, mz).normalize().applyEuler(_tmpE.set(0, hy, 0));

    // Swim at half speed in shallow water; sprint multiplier; boost on PATH
    const curMoveTile = tileAt(rig.position.x, rig.position.z);
    const inWater  = curMoveTile === T.WATER;
    const onPath   = curMoveTile === T.PATH;
    const spd = (inWater ? SPEED * 0.5 : SPEED) * (isSprinting ? 1.6 : 1.0) * (onPath ? 1.25 : 1.0);

    wdx = _tmpV3.x * spd * dt;
    wdz = _tmpV3.z * spd * dt;

    // Footstep sound — tono varía según terreno (mejora #8)
    if (stepTimer === 0) {
      stepTimer = 0.42;
      const ft = tileAt(rig.position.x, rig.position.z);
      const stepFreq = ft === T.WATER  ? 130
                     : ft === T.SAND   ? 190
                     : ft === T.MOUND || ft === T.DFLOOR ? 380 + Math.random() * 80
                     : 210 + Math.random() * 110;
      sfx.footstep(stepFreq);
    }
  }

  // ── Física (Rapier) — movimiento XZ + Y en una sola llamada ──
  if (rapierWorld && playerBody) {
    const wantsJump = keys['Space'] || (renderer.xr.isPresenting && _vrAWas);
    if (onGround && wantsJump && !jumpPressed) {
      jumpVY = JUMP_VY; onGround = false; jumpPressed = true; sfx.jump();
    }
    if (!onGround) jumpVY -= GRAVITY * dt;
    // Cuando está en suelo, fuerza pequeña hacia abajo para que computedGrounded() funcione
    const yMov = onGround ? -0.5 : jumpVY * dt;

    charCtrl.computeColliderMovement(
      playerCollider,
      { x: wdx, y: yMov, z: wdz },
      true, null, (col) => col !== playerCollider
    );
    const cm  = charCtrl.computedMovement();
    const pos = playerBody.translation();
    playerBody.setNextKinematicTranslation({ x: pos.x + cm.x, y: pos.y + cm.y, z: pos.z + cm.z });

    const wasInAir = !onGround;
    onGround = charCtrl.computedGrounded();
    if (onGround && wasInAir) {
      if (jumpVY < -28) { playerHP = Math.max(0, playerHP - 1); updateHPBar(); flashDamage(); }
      sfx.land(); _shakeT = 0.12;
    }
    if (onGround) jumpVY = 0;
    if (!keys['Space']) jumpPressed = false;

    // Sincronizar rig con el cuerpo físico
    rig.position.x = pos.x + cm.x;
    rig.position.z = pos.z + cm.z;
    rig.position.y = pos.y + cm.y - CAPS_OFFSET;
  }

  // ── Indicador de bioma ────────────────────────────────────────
  if (biomeEl) {
    const BNAME = {
      [T.WATER]: 'AGUA', [T.SAND]: 'DESIERTO', [T.GRASS]: 'PRADERA',
      [T.FOREST]: 'BOSQUE', [T.MOUND]: 'MONTAÑA',
      [T.DFLOOR]: 'CIUDADELA', [T.PATH]: 'CAMINO', [T.DEEP]: 'MAR PROFUNDO'
    };
    const curB = BNAME[tileAt(rig.position.x, rig.position.z)] || '';
    if (curB && curB !== lastBiome) {
      lastBiome = curB;
      biomeEl.textContent = curB;
      biomeEl.style.opacity = '1';
      biomeHideTimer = 2.5;
    }
    if (biomeHideTimer > 0) {
      biomeHideTimer -= dt;
      if (biomeHideTimer <= 0) biomeEl.style.opacity = '0';
    }
  }
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
  footstep(freq = 250) {
    const ctx  = getAudioCtx();
    const size = Math.floor(ctx.sampleRate * 0.05);
    const buf  = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size) * 0.4;
    const src    = ctx.createBufferSource();
    src.buffer   = buf;
    const filter = ctx.createBiquadFilter();
    filter.type  = 'lowpass'; filter.frequency.value = freq;
    const gain   = ctx.createGain();
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start();
  },
  squeak() {
    // Gruñido/chillido del sapo al aggrarse
    const ctx = getAudioCtx(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(550, t);
    o.frequency.exponentialRampToValueAtTime(920, t + 0.07);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.12);
  },
  birdScreech() {
    // Chillido del ave fénix al despegar
    const ctx = getAudioCtx(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(800, t);
    o.frequency.exponentialRampToValueAtTime(1600, t + 0.06);
    o.frequency.exponentialRampToValueAtTime(700, t + 0.22);
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.30);
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
  questAccept() {
    const ctx = getAudioCtx(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(440, t);
    o.frequency.setValueAtTime(550, t + 0.1);
    o.frequency.setValueAtTime(660, t + 0.2);
    g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.45);
  },
  questComplete() {
    const ctx = getAudioCtx(), t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.22, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.4);
      o.connect(g); g.connect(ctx.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.45);
    });
  },
  heartPickup() {
    const ctx = getAudioCtx(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(330, t);
    o.frequency.exponentialRampToValueAtTime(660, t + 0.25);
    g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.38);
  },
  jump() {
    const ctx = getAudioCtx(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(480, t + 0.08);
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.18);
  },
  land() {
    const ctx  = getAudioCtx(), t = ctx.currentTime;
    const size = Math.floor(ctx.sampleRate * 0.07);
    const buf  = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size) * 0.7;
    const src  = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 220;
    const gain = ctx.createGain(); gain.gain.setValueAtTime(0.55, t);
    src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    src.start(t);
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
    // Knockback + squash
    vx: 0, vz: 0, squashT: 0, hitFlashT: 0,
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
  const SPAWN      = new Set([T.GRASS, T.FOREST]);
  const PUSH_TILES = new Set([T.GRASS, T.MOUND, T.SAND]);
  for (let z = 2; z < WORLD - 2; z++) {
    for (let x = 2; x < WORLD - 2; x++) {
      const t   = worldMap[z][x];
      const key = x + ',' + z;
      if (!SPAWN.has(t)) continue;
      if (_occupied.has(key)) continue;                              // árbol o casa NPC
      if (PUSH_TILES.has(t) && hash(x, z, worldSeed + 88)  > 0.988) continue; // roca empujable
      if (PUSH_TILES.has(t) && hash(x, z, worldSeed + 777) > 0.988) continue; // torre
      if (hash(x, z, worldSeed + 30) > 0.91) enemies.push(createEnemy(x, z));
    }
  }
}

function updateEnemies(dt) {
  const px = rig.position.x, pz = rig.position.z;

  // Sword tip world position (blade tip in sword local = (0, 0.77, 0))
  const hasSword = !!gripRefs.right;
  if (hasSword) {
    swordTipWorld.set(0, 0.725, 0);
    sword.localToWorld(swordTipWorld);
    swordVel = swordTipWorld.distanceTo(swordPrevPos) / dt;
    swordPrevPos.copy(swordTipWorld);
  }

  const LUNGE_RANGE = 2.6; // distance at which lunge cycle begins

  for (const e of enemies) {
    if (e.dead) {
      e.deathT += dt;
      e.mesh.scale.setScalar(Math.max(0, 1 - e.deathT / 0.35));
      if (e.deathT > 0.4) {
        scene.remove(e.mesh);
        if (e.bossRBody && rapierWorld) { rapierWorld.removeRigidBody(e.bossRBody); e.bossRBody = null; }
      }
      continue;
    }

    // Horizontal distance to player
    const dx = px - e.mesh.position.x, dz = pz - e.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Aggro transitions
    const aggroR = e.aggroRange ?? 8;
    if (!e.aggroed && dist < aggroR)  {
      e.aggroed = true; e.patrolTarget = null; sfx.squeak();
      // Alert icon (mejora #8)
      const alertGeo = new THREE.SphereGeometry(0.10, 5, 4);
      const alertMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true });
      const alertMesh = new THREE.Mesh(alertGeo, alertMat);
      alertMesh.position.copy(e.mesh.position);
      alertMesh.position.y += 1.2;
      scene.add(alertMesh);
      enemyAlertList.push({ mesh: alertMesh, timer: 0.8 });
    }
    if (e.aggroed  && dist > aggroR * 1.5) {
      e.aggroed = false;
      e.lungePhase = 'cooldown'; e.lungeT = 0.4;
      e.mesh.rotation.x = 0; e.mesh.rotation.z = 0;
    }

    // Knockback amortiguado (mejora #5)
    if (e.vx !== 0 || e.vz !== 0) {
      e.mesh.position.x += e.vx * dt;
      e.mesh.position.z += e.vz * dt;
      const damp = 1 - Math.min(1, 9 * dt);
      e.vx *= damp; e.vz *= damp;
      if (Math.abs(e.vx) < 0.01) e.vx = 0;
      if (Math.abs(e.vz) < 0.01) e.vz = 0;
    }

    // Flash de daño: cambiar material por timer (mejora #9 — sin setTimeout)
    if (e.hitFlashT > 0) {
      e.hitFlashT -= dt;
      e.mesh.children[0].material = ENEMY_MAT_DMGD;
      if (e.hitFlashT <= 0) e.mesh.children[0].material = e._bossMat || ENEMY_MAT_BODY;
    }

    // Ground snap — usa fixedY para el boss (sobre el techo), groundAt para el resto
    const gY = (e.fixedY !== undefined) ? e.fixedY : groundAt(e.mesh.position.x, e.mesh.position.z);
    e.mesh.position.y += (gY - e.mesh.position.y) * Math.min(1, dt * 12);
    const body = e.mesh.children[0]; // body sphere

    // Squash animado al recibir golpe (mejora #5)
    if (e.squashT > 0) {
      e.squashT = Math.max(0, e.squashT - dt);
      body.scale.y = 0.65 + (1 - e.squashT / 0.12) * (0.65 - 0.38); // rebota de vuelta
    } else {
      body.scale.y = 0.65;
    }

    // Three.js lookAt points -Z toward target, but enemies face +Z (eyes at z=0.33).
    // Use atan2 directly so +Z faces the target.
    const faceToward = (tx, tz) => {
      e.mesh.rotation.y = Math.atan2(tx - e.mesh.position.x, tz - e.mesh.position.z);
    };

    if (e.aggroed) {
      // ── AGGROED ──────────────────────────────────────────────
      const lungeR = e.lungeRange ?? LUNGE_RANGE;
      if (dist > lungeR) {
        // Chase — walk towards player with bounce
        const spd = (e.chaseSpeed ?? 2.2) * dt;
        e.mesh.position.x += dx / dist * spd;
        e.mesh.position.z += dz / dist * spd;
        // Boss se queda en el techo (DFLOOR del castillo)
        if (e._bossScale) {
          e.mesh.position.x = Math.max(23*TILE+6, Math.min(38*TILE+6, e.mesh.position.x));
          e.mesh.position.z = Math.max(13*TILE+6, Math.min(20*TILE+6, e.mesh.position.z));
        }
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
          // Dash forward
          e.mesh.rotation.x = -0.28;
          body.position.y = 0.3;
          // Boss mantiene su altura (fixedY), no persigue al jugador verticalmente
          if (!e._bossScale) {
            const targetY = rig.position.y + EYE * 0.55;
            e.mesh.position.y += (targetY - e.mesh.position.y) * Math.min(1, 12 * dt);
          }
          const newX = e.mesh.position.x + e.lungeDir.x * (e.lungeSpeed ?? 7) * dt;
          const newZ = e.mesh.position.z + e.lungeDir.z * (e.lungeSpeed ?? 7) * dt;
          const canMove = e._bossScale
            ? (worldMap[Math.floor(newZ/TILE)]?.[Math.floor(newX/TILE)] === T.DFLOOR)
            : (tileAt(newX, newZ) !== T.DEEP);
          if (canMove) {
            e.mesh.position.x = newX;
            e.mesh.position.z = newZ;
          }
          if (!e.lungeDamaged && dist < (e.hitRange ?? 1.4)) {
            e.lungeDamaged = true;
            if (!isShieldActive()) {        // mejora #20: escudo bloquea daño
              playerHP = Math.max(0, playerHP - 1);
              updateHPBar();
              flashDamage();               // mejora #4: flash rojo en pantalla
              lastDamageTime = elapsed;
              regenTimer = 0;
              // Floating damage number (mejora #5)
              showFloatingDmg();
            }
          }
          if (e.lungeT <= 0) {
            e.lungePhase = 'retreat';
            e.lungeT = 0.38;
            e.lungeDir.negate();
            e.mesh.rotation.x = 0;
          }

        } else if (e.lungePhase === 'retreat') {
          // Vuelve al suelo y retrocede (usa fixedY para el boss)
          const groundY = (e.fixedY !== undefined) ? e.fixedY : groundAt(e.mesh.position.x, e.mesh.position.z);
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

    // ── Actualizar colisionador cinemático del boss ─────────────
    if (e.bossRBody && rapierWorld) {
      e.bossRBody.setNextKinematicTranslation({
        x: e.mesh.position.x,
        y: e.mesh.position.y,
        z: e.mesh.position.z,
      });
    }

    // ── Sword hit ──────────────────────────────────────────────
    e.hitCooldown = Math.max(0, e.hitCooldown - dt);
    if (hasSword && e.hitCooldown === 0) {
      const tipDist = swordTipWorld.distanceTo(e.mesh.position);
      // Para el boss: verificar que la espada esté a su altura (evita golpear desde abajo del techo)
      const tipYOk = !e._bossScale ||
        Math.abs(swordTipWorld.y - (e.mesh.position.y + 0.3 * e._bossScale)) < 14;
      if (tipDist < (e.swordHitRange ?? 1.2) && swordVel > 1.5 && tipYOk) {
        e.hp--; e.hitCooldown = 0.4; sfx.hit();
        e.hitFlashT = 0.20; // timer-based (no setTimeout)
        e.squashT   = 0.12; // squash visual
        // Knockback en dirección del golpe
        const kd = tipDist || 1;
        e.vx = (e.mesh.position.x - swordTipWorld.x) / kd * 5.5;
        e.vz = (e.mesh.position.z - swordTipWorld.z) / kd * 5.5;
        if (e.hp <= 0) {
          e.dead = true; sfx.death(); enemiesKilled++;
          spawnDeathParticles(e.mesh.position);
          if (e._bossScale) spawnBossCoin(e.mesh.position);
          onEnemyKilled(e);
        }
      }
    }
    // Mouse click hit (desktop) — Space es para saltar
    if (mouseAttack && dist < (e.hitRange ?? 2.5) && e.hitCooldown === 0) {
      e.hp--; e.hitCooldown = 0.5; sfx.hit();
      e.hitFlashT = 0.20; e.squashT = 0.12;
      if (e.hp <= 0) {
        e.dead = true; sfx.death(); enemiesKilled++;
        spawnDeathParticles(e.mesh.position);
        if (e._bossScale) spawnBossCoin(e.mesh.position);
        onEnemyKilled(e);
      }
    }
  }
}

function onEnemyKilled(e) {
  // Quest kills (slimes normales)
  if (activeQuestId === 1) {
    questProgress = enemiesKilled;
    updateQuestHUD();
    if (enemiesKilled >= 5) { questComplete = true; updateQuestHUD(); }
  }
  // Quest boss
  if (activeQuestId === 5 && e._bossScale) {
    questProgress = 1; questComplete = true; updateQuestHUD();
  }
  // Combo (mejora #15)
  comboTimer = 3.0;
  comboCount++;
  if (comboCount >= 2 && comboEl) {
    comboEl.textContent = 'COMBO x' + comboCount + '!';
    comboEl.style.display = 'block';
    comboEl.style.opacity = '1';
  }
}

function spawnBossCoin(pos) {
  const geo = new THREE.CylinderGeometry(2.0, 2.0, 0.55, 16);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffd700, emissive: 0xff8800, emissiveIntensity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  const baseY = pos.y + 3.0;
  mesh.position.set(pos.x, baseY, pos.z);
  scene.add(mesh);
  bossCoin = { wx: pos.x, wz: pos.z, baseY, collected: false, rising: false, riseT: 0, worth: 5, mesh };
}

function spawnDeathParticles(pos) {
  const pGeo = new THREE.SphereGeometry(0.08, 4, 3);
  const pMat = new THREE.MeshBasicMaterial({ color: 0x33ff33, transparent: true });
  for (let i = 0; i < 5; i++) {
    const pm = new THREE.Mesh(pGeo, pMat);
    pm.position.copy(pos);
    pm.position.y += 0.3;
    scene.add(pm);
    const angle = (i / 5) * Math.PI * 2;
    dmgParticles.push({ mesh: pm, vx: Math.cos(angle) * 3, vy: 2 + Math.random() * 2,
                        vz: Math.sin(angle) * 3, life: 0.5 });
  }
}

// Floating damage number (mejora #5)
let _floatDmgEl = null;
function showFloatingDmg() {
  if (!_floatDmgEl) {
    _floatDmgEl = document.createElement('div');
    _floatDmgEl.style.cssText = 'position:fixed;left:50%;top:42%;transform:translateX(-50%);color:#ff4444;font-family:monospace;font-size:28px;font-weight:bold;pointer-events:none;z-index:150;text-shadow:0 0 8px #f00;transition:opacity 0.6s';
    document.body.appendChild(_floatDmgEl);
  }
  _floatDmgEl.textContent = '-1';
  _floatDmgEl.style.opacity = '1';
  clearTimeout(_floatDmgEl._t);
  _floatDmgEl._t = setTimeout(() => { _floatDmgEl.style.opacity = '0'; }, 400);
}

// ─────────────────────────────────────────────────────────────
// PUSH ROCKS — large boulders with simple physics
// ─────────────────────────────────────────────────────────────
const ROCK_SCALE = 5;                    // push rocks son 5x más grandes
const ROCK_R     = 0.50 * ROCK_SCALE;   // 2.50 m collision radius
const hearts = [];                       // corazones de vida en el suelo

function spawnPushRocks() {
  const VALID = new Set([T.GRASS, T.MOUND, T.SAND]);
  for (let z = 2; z < WORLD - 2; z++) {
    for (let x = 2; x < WORLD - 2; x++) {
      if (VALID.has(worldMap[z][x]) && hash(x, z, worldSeed + 88) > 0.988
          && !_occupied.has(x + ',' + z)) {
        const wx = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
        const mesh = new THREE.Mesh(rockGeo, rockMat);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.scale.setScalar(ROCK_SCALE);
        mesh.rotation.y = hash(x, z, worldSeed + 33) * Math.PI * 2;
        mesh.position.set(wx, groundAt(wx, wz), wz);
        scene.add(mesh);
        pushRocks.push({ mesh, vx: 0, vz: 0, hitCooldown: 0, broken: false, tipping: false, tipT: 0 });
      }
    }
  }
}

function updatePushRocks(dt) {
  const hasSword = !!gripRefs.right;

  if (!pushRocks.length) return;

  // Inicia volcado en la dirección del golpe (dirX, dirZ = vector normalizado desde golpeador)
  function breakRock(r, dirX, dirZ) {
    if (r.broken) return;
    r.broken = true;
    r.tipping = true;
    r.tipT = 0;
    r.tipDirX = dirX || 1;
    r.tipDirZ = dirZ || 0;
    r.mesh.rotation.x = 0; // limpiar rotación acumulada del rodado
    r.mesh.rotation.z = 0;
    r.vx = 0; r.vz = 0;
    sfx.hit();
    // Partículas de polvo al romper roca (mejora #19)
    const dustGeo = new THREE.SphereGeometry(0.12, 4, 3);
    const dustMat = new THREE.MeshBasicMaterial({ color: 0xbbaa88, transparent: true, opacity: 0.7 });
    for (let i = 0; i < 6; i++) {
      const dm = new THREE.Mesh(dustGeo, dustMat);
      dm.position.copy(r.mesh.position);
      dm.position.y += 1.0;
      scene.add(dm);
      const angle = (i / 6) * Math.PI * 2;
      rockParticles.push({ mesh: dm, vx: Math.cos(angle) * 2.5, vy: 1.5 + Math.random(),
                           vz: Math.sin(angle) * 2.5, life: 0.6 });
    }
  }

  for (const r of pushRocks) {
    // Roca completamente eliminada
    if (r.broken && !r.tipping) continue;

    // Animación de volcado en la dirección del golpe
    if (r.tipping) {
      r.tipT += dt;
      const prog  = Math.min(r.tipT / 0.45, 1);
      const angle = prog * (Math.PI / 2);
      // Rotar alrededor del eje perpendicular a la dirección de caída
      r.mesh.rotation.x = angle * (-r.tipDirZ);
      r.mesh.rotation.z = angle * (-r.tipDirX);
      r.mesh.position.y = groundAt(r.mesh.position.x, r.mesh.position.z)
                          + Math.max(0, (1 - prog) * 0.3);
      if (prog >= 1) {
        r.tipping = false;
        scene.remove(r.mesh);
        const hMesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.35, 8, 6),
          new THREE.MeshLambertMaterial({ color: 0xff2244, emissive: 0xaa0022, emissiveIntensity: 0.7 })
        );
        hMesh.position.set(r.mesh.position.x,
          groundAt(r.mesh.position.x, r.mesh.position.z) + 0.6,
          r.mesh.position.z);
        scene.add(hMesh);
        hearts.push({ mesh: hMesh, baseY: hMesh.position.y, phase: Math.random() * Math.PI * 2 });
      }
      continue;
    }
    r.hitCooldown = Math.max(0, r.hitCooldown - dt);

    // ── Hit detection — rompe la roca en la dirección del golpe ─
    if (r.hitCooldown === 0) {
      let hit = false, hdx = 1, hdz = 0;
      if (hasSword) {
        const tipDist = swordTipWorld.distanceTo(r.mesh.position);
        if (tipDist < ROCK_R && swordVel > 1.5) {
          const d = tipDist || 1;
          hdx = (r.mesh.position.x - swordTipWorld.x) / d;
          hdz = (r.mesh.position.z - swordTipWorld.z) / d;
          hit = true;
        }
      }
      if (!hit && mouseAttack) {
        const dx = r.mesh.position.x - rig.position.x;
        const dz = r.mesh.position.z - rig.position.z;
        const d  = Math.sqrt(dx * dx + dz * dz) || 1;
        if (dx * dx + dz * dz < (ROCK_R + 1) * (ROCK_R + 1)) {
          hdx = dx / d; hdz = dz / d; hit = true;
        }
      }
      if (hit) { breakRock(r, hdx, hdz); continue; }
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
    r.mesh.position.y = groundAt(r.mesh.position.x, r.mesh.position.z);

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

// Flash rojo en pantalla al recibir daño (mejora #4) + shake (mejora #13)
let _shakeT = 0;
function flashDamage() {
  if (!dmgFlashEl) return;
  dmgFlashEl.style.opacity = '0.45';
  setTimeout(() => { if (dmgFlashEl) dmgFlashEl.style.opacity = '0'; }, 60);
  _shakeT = 0.25; // segundos de camera shake
}

function updateCameraShake(dt) {
  if (_shakeT > 0 && !renderer.xr.isPresenting) {
    _shakeT = Math.max(0, _shakeT - dt);
    const s = _shakeT * 0.035;
    camera.position.x = (Math.random() - 0.5) * s;
    camera.position.z = (Math.random() - 0.5) * s;
  } else if (!renderer.xr.isPresenting && _shakeT <= 0) {
    camera.position.x = 0;
    camera.position.z = 0;
  }
}

// Escudo activo: grip izquierdo en VR o Shift en desktop (mejora #20)
function isShieldActive() {
  if (renderer.xr.isPresenting && gripRefs.left) {
    const session = renderer.xr.getSession();
    if (session?.inputSources) {
      for (const s of session.inputSources) {
        if (s.handedness === 'left' && s.gamepad?.buttons[1]?.pressed) return true;
      }
    }
  }
  return keys['ShiftLeft'] || keys['ShiftRight'] || mouseShield;
}

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
  if (renderer.xr.isPresenting) show3DOverlay('GAME OVER', 'Fuiste derrotado...', '#ff4444');
}

function showVictory() {
  if (gameEnded) return;
  gameEnded = true;
  // HTML overlay (desktop)
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:200;color:#fff;font-family:monospace';
  const mins = Math.floor(elapsed / 60), secs = Math.floor(elapsed % 60);
  el.innerHTML = `
    <div style="font-size:52px;color:#ffd700;margin-bottom:16px;text-shadow:0 0 20px #fa0">★ VICTORIA ★</div>
    <div style="font-size:20px;margin-bottom:8px;opacity:.8">¡Completaste todas las misiones!</div>
    <div style="font-size:15px;margin-bottom:4px;color:#ffd700;opacity:.7">Enemigos derrotados: ${enemiesKilled}</div>
    <div style="font-size:15px;margin-bottom:32px;color:#aaf;opacity:.8">Tiempo: ${mins}m ${secs}s</div>
    <button onclick="location.reload()" style="font-size:18px;padding:12px 36px;background:#ffd700;color:#000;border:none;border-radius:8px;cursor:pointer">▶ Jugar de nuevo</button>
  `;
  document.body.appendChild(el);
  if (renderer.xr.isPresenting) show3DOverlay('VICTORIA', `Enemigos: ${enemiesKilled} | ${mins}m ${secs}s`, '#ffd700');
}

let starEl;
function updateStarCounter() {
  if (starEl) starEl.textContent = '\u2605 ' + coinsCollected + ' / ' + stars.length;
  drawHUD3d();
}

function checkStarCollection() {
  if (gameEnded) return;
  const px = rig.position.x, pz = rig.position.z;
  let anyNew = false;
  for (const s of stars) {
    if (s.collected) continue;
    const dx = s.wx - px, dz = s.wz - pz;
    const d2 = dx * dx + dz * dz;
    // Coin magnet (mejora #6): acerca la moneda al jugador si está a <2.5m
    if (d2 < 2.5 * 2.5 && d2 > 1.2 * 1.2) {
      const d = Math.sqrt(d2) || 1;
      s.wx += (px - s.wx) / d * 4 * (1 / 60); // paso suave
      s.wz += (pz - s.wz) / d * 4 * (1 / 60);
    }
    if (d2 < 1.5 * 1.5) {
      s.collected = true;
      s.rising = true; s.riseT = 0;  // mejora #18: animación de subida
      coinsCollected++;               // mejora #12: contador directo
      sfx.starCollect();
      anyNew = true;
      // Quest monedas
      if (activeQuestId === 0) {
        questProgress = coinsCollected;
        updateQuestHUD();
        if (coinsCollected >= 30) { questComplete = true; updateQuestHUD(); }
      }
    }
  }
  if (anyNew) {
    updateStarCounter();
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

  // Dirección solar para el shader del agua
  if (waterMesh) waterMesh.material.uniforms.uSunDir.value.copy(sun.position).normalize();

  // Sun color: warm white at day, orange-red at dusk/dawn
  const duskAmount = 1 - Math.min(1, brightness * 3);
  _sunColor.setHex(0xfff2cc).lerp(new THREE.Color(0xff6600), duskAmount * 0.6);
  sun.color.copy(_sunColor);

  // Update rain chance on day boundary
  if (isRaining && brightness < 0.01) stopRain();

  // Moon & starfield (mejora #7)
  const moonObj = scene.getObjectByName('moon');
  const sfObj   = scene.getObjectByName('starfield');
  const isNight = dayTime < 0.25 || dayTime > 0.75;
  if (moonObj) moonObj.visible = isNight;
  if (sfObj)   sfObj.visible   = isNight;

  // Linterna nocturna — intensidad inversa a la luz del día
  nightLantern.intensity = Math.max(0, 1.8 - brightness * 4.5);
}

// ─────────────────────────────────────────────────────────────
// RAIN SYSTEM
// ─────────────────────────────────────────────────────────────
let isRaining = false;
let rainMesh = null;
let rainTimer = 30 + Math.random() * 60; // first rain in 30-90s

// Water animation refs (set in buildScene)
let waterMesh = null;

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
  if (!waterMesh) return;
  const u = waterMesh.material.uniforms;
  u.uTime.value = t;
  // Centrar en el jugador para cubrir siempre el área visible
  waterMesh.position.x = rig.position.x;
  waterMesh.position.z = rig.position.z;
  // Sincronizar color de niebla con el cielo
  if (scene.fog) u.uFogColor.value.copy(scene.fog.color);
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
  'position:fixed', 'bottom:36px', 'left:16px',
  'width:160px', 'height:160px',
  'border:2px solid rgba(255,255,255,.75)',
  'border-radius:4px 4px 0 0', 'z-index:10',
  'image-rendering:pixelated',
].join(';');
document.body.appendChild(mmDisp);

// Barra de coordenadas y brújula bajo el minimapa
const mmInfoEl = document.createElement('div');
mmInfoEl.style.cssText = [
  'position:fixed', 'bottom:16px', 'left:16px',
  'width:160px', 'height:20px',
  'background:rgba(0,0,0,0.70)',
  'border:2px solid rgba(255,255,255,.75)', 'border-top:none',
  'border-radius:0 0 4px 4px',
  'color:#ffd700', 'font:bold 11px monospace',
  'display:flex', 'align-items:center', 'justify-content:center',
  'z-index:10', 'letter-spacing:0.5px',
].join(';');
document.body.appendChild(mmInfoEl);

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

function buildMinimap() { /* no-op — ahora drawMinimap lee chunkMap en tiempo real */ }

function drawMinimap() {
  const MM   = WORLD;       // 64px
  const HALF = MM >> 1;     // 32 — jugador siempre en el centro

  // Tile donde está el jugador
  const ptx = Math.floor(rig.position.x / TILE);
  const ptz = Math.floor(rig.position.z / TILE);

  // Reconstruir imagen desde chunkMap centrada en el jugador
  const ctx = mmDisp.getContext('2d');
  const id  = ctx.createImageData(MM, MM);
  for (let dz = 0; dz < MM; dz++) {
    for (let dx = 0; dx < MM; dx++) {
      const gtx = ptx - HALF + dx;
      const gtz = ptz - HALF + dz;
      const cx  = Math.floor(gtx / WORLD);
      const cz  = Math.floor(gtz / WORLD);
      const lx  = ((gtx % WORLD) + WORLD) % WORLD;
      const lz  = ((gtz % WORLD) + WORLD) % WORLD;
      const ch  = chunkMap.get(`${cx},${cz}`);
      const t   = ch ? (ch.map[lz]?.[lx] ?? T.GRASS) : -1;
      const [r, g, b] = t < 0 ? [15,15,15] : (MM_PALETTE[t] || [80,80,80]);
      const i = (dz * MM + dx) * 4;
      id.data[i]=r; id.data[i+1]=g; id.data[i+2]=b; id.data[i+3]=255;
    }
  }
  ctx.putImageData(id, 0, 0);

  // Marcadores NPC (solo los visibles en el área)
  ctx.fillStyle = '#ffff00';
  for (const n of npcs) {
    const nx = Math.floor(n.wx / TILE) - ptx + HALF;
    const nz = Math.floor(n.wz / TILE) - ptz + HALF;
    if (nx >= 0 && nx < MM && nz >= 0 && nz < MM) {
      ctx.beginPath(); ctx.arc(nx, nz, 1.8, 0, Math.PI*2); ctx.fill();
    }
  }

  // Jugador — punto rojo en el centro
  ctx.fillStyle = '#ff3333';
  ctx.fillRect(HALF - 1.5, HALF - 1.5, 3, 3);

  if (mmTex3d) mmTex3d.needsUpdate = true;

  // Barra de coordenadas y brújula
  const _DIRS = ['N','NO','O','SO','S','SE','E','NE'];
  const _yawNorm = ((yaw % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
  mmInfoEl.textContent = `X:${ptx} Z:${ptz}  ${_DIRS[Math.round(_yawNorm/(Math.PI/4))%8]}`;
}

// ─────────────────────────────────────────────────────────────
// HUD
// ─────────────────────────────────────────────────────────────
let hpBarEl;
// 3D HUD canvas — works in desktop and VR
let hudCtx3d = null, hudTex3d = null, mmTex3d = null, hudMesh3d = null, mmMesh3d = null;

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
  const col = coinsCollected;
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText('● ' + col + ' / ' + stars.length, 326, 64);
  // Misión activa (línea pequeña bajo las monedas)
  if (activeQuestId !== -1) {
    const q = QUEST_DEFS[activeQuestId];
    const pct = Math.min(1, questProgress / q.goal);
    const filled = Math.round(pct * 10);
    ctx.font = '18px monospace';
    ctx.fillStyle = questComplete ? '#44ff88' : '#ffd700';
    ctx.fillText(q.title.slice(0, 22) + '  [' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '] ' + questProgress + '/' + q.goal, 12, 110);
  }
  if (hudTex3d) hudTex3d.needsUpdate = true;
}

function drawVRDialog(npc, isActive, isComplete) {
  if (!npcDlgCtx) return;
  const ctx = npcDlgCtx, W = 512, H = 256;
  ctx.clearRect(0, 0, W, H);
  // Fondo
  ctx.fillStyle = 'rgba(0,0,0,0.88)';
  if (ctx.roundRect) { ctx.roundRect(4, 4, W - 8, H - 8, 18); ctx.fill(); }
  else ctx.fillRect(4, 4, W - 8, H - 8);
  // Borde dorado
  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 3;
  if (ctx.roundRect) { ctx.roundRect(4, 4, W - 8, H - 8, 18); ctx.stroke(); }
  const q = QUEST_DEFS[npc.questId];
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  // Nombre NPC
  ctx.fillStyle = '#ffd700'; ctx.font = 'bold 36px sans-serif';
  ctx.fillText(npc.name, W / 2, 14);
  // Título misión
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px sans-serif';
  ctx.fillText(q.title, W / 2, 60);
  if (isComplete) {
    ctx.fillStyle = '#44ff88'; ctx.font = 'bold 24px sans-serif';
    ctx.fillText('¡Misión completada!', W / 2, 102);
    ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif';
    ctx.fillText('Recompensa: ' + q.reward, W / 2, 140);
    ctx.fillStyle = '#aaaaaa'; ctx.font = '18px sans-serif';
    ctx.fillText('[Trigger] Cerrar', W / 2, 218);
  } else if (isActive) {
    const pct = Math.min(1, questProgress / q.goal);
    const filled = Math.round(pct * 16);
    ctx.fillStyle = '#ffd700'; ctx.font = '20px monospace';
    ctx.fillText('[' + '█'.repeat(filled) + '░'.repeat(16 - filled) + ']', W / 2, 104);
    ctx.fillStyle = '#cccccc'; ctx.font = '20px sans-serif';
    ctx.fillText(questProgress + ' / ' + q.goal, W / 2, 138);
    ctx.fillStyle = '#aaaaaa'; ctx.font = '18px sans-serif';
    ctx.fillText('[Trigger] Cerrar', W / 2, 218);
  } else {
    // Descripción con word-wrap
    const words = q.desc.split(' ');
    let line = '', y = 100;
    ctx.fillStyle = '#cccccc'; ctx.font = '19px sans-serif';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > 460) { ctx.fillText(line, W / 2, y); line = w; y += 26; }
      else line = test;
    }
    if (line) ctx.fillText(line, W / 2, y);
    ctx.fillStyle = '#ffd700'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('[Trigger] Aceptar', W / 2, 218);
  }
  if (npcDlgTex) npcDlgTex.needsUpdate = true;
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

function updateQuestHUD() {
  if (questHudEl) {
    if (activeQuestId === -1) { questHudEl.style.display = 'none'; }
    else {
      const q = QUEST_DEFS[activeQuestId];
      questHudEl.style.display = 'block';
      const pct = Math.min(1, questProgress / q.goal);
      const filled = Math.round(pct * 12);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(12 - filled);
      questHudEl.textContent = q.title + '  [' + bar + ']  ' + questProgress + '/' + q.goal;
    }
  }
  drawHUD3d(); // actualiza barra de misión en HUD 3D (visible en VR)
}

function openDialog(npc) {
  if (dialogNPC === npc) { closeDialog(); return; }
  dialogNPC = npc;
  const q = QUEST_DEFS[npc.questId];
  const isActive   = activeQuestId === q.id;
  const isComplete = isActive && questComplete;
  // Mostrar diálogo 3D solo en VR; en desktop usa el div HTML
  if (npcDlgMesh && renderer.xr.isPresenting) { drawVRDialog(npc, isActive, isComplete); npcDlgMesh.visible = true; }
  let html = '<b style="color:#ffd700">' + npc.name + '</b><br><br>';
  if (isComplete) {
    html += '<b style="color:#44ff44">Mision completada!</b><br>Recibe: <i>' + q.reward + '</i>';
    sfx.questComplete();
    activeQuestId = -1; questProgress = 0; questComplete = false;
    questsCompleted++;
    updateQuestHUD();
    showQuestCompleteOverlay(q);
    if (questsCompleted >= QUEST_DEFS.length) showVictory();
  } else if (isActive) {
    html += '<b>' + q.title + '</b><br><br>' + q.desc.replace(/\n/g, '<br>') + '<br><br>Progreso: ' + questProgress + '/' + q.goal;
  } else {
    html += '<b>' + q.title + '</b><br><br>' + q.desc.replace(/\n/g, '<br>') + '<br><br><i style="color:#aaa">Presiona E para aceptar</i>';
  }
  if (npcDialogEl) {
    npcDialogEl.innerHTML = html;
    npcDialogEl.style.display = 'block';
  }
}

function closeDialog() {
  dialogNPC = null;
  if (npcDialogEl) npcDialogEl.style.display = 'none';
  if (npcDlgMesh) npcDlgMesh.visible = false;
}

function acceptQuest(npc) {
  if (activeQuestId !== -1 && activeQuestId !== npc.questId) return;
  if (questComplete) return;
  activeQuestId = npc.questId;
  questProgress = 0;
  questComplete = false;
  surviveTimer  = 0;
  towersVisited.clear();
  castleEntered = false;
  closeDialog();
  updateQuestHUD();
  sfx.questAccept();
}

function showQuestCompleteOverlay(q) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;left:50%;top:30%;transform:translateX(-50%);background:rgba(0,0,0,0.88);color:#ffd700;font-family:monospace;font-size:22px;padding:28px 40px;border-radius:14px;border:2px solid #ffd700;text-align:center;z-index:300;pointer-events:none';
  ov.innerHTML = '<b>Mision completada!</b><br><br>' + q.title + '<br><span style="color:#fff;font-size:16px">Recompensa: ' + q.reward + '</span>';
  document.body.appendChild(ov);
  clearTimeout(questOverlayTimeout);
  questOverlayTimeout = setTimeout(() => ov.remove(), 3000);
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
  el.id = 'desktop-hud';
  el.innerHTML = `
    <div style="color:#7fff7f;font-size:15px;margin-bottom:3px">&#9876; Eryndell</div>
    <div>WASD / Arrows &mdash; Move &nbsp;|&nbsp; Click &mdash; Mouse look</div>
    <div>Clic izq &mdash; Atacar &nbsp;|&nbsp; Clic der &mdash; Escudo &nbsp;|&nbsp; E &mdash; Hablar &nbsp;|&nbsp; M &mdash; Mapa</div>
    <div id="hp" style="margin-top:6px;font-size:16px;color:#ff8888">♥♥♥♥♥</div>
    <div id="stars" style="font-size:14px;color:#ffd700;margin-top:3px">&#9733; 0 / 0</div>
  `;
  document.body.appendChild(el);
  hpBarEl = document.getElementById('hp');
  starEl  = document.getElementById('stars');

  // Flash rojo al recibir daño (mejora #4)
  dmgFlashEl = document.createElement('div');
  dmgFlashEl.style.cssText = 'position:fixed;inset:0;background:#ff0000;opacity:0;pointer-events:none;z-index:100;transition:opacity 0.35s ease-out';
  document.body.appendChild(dmgFlashEl);

  // Indicador de bioma — aparece al entrar a una zona nueva
  biomeEl = document.createElement('div');
  biomeEl.style.cssText = 'position:fixed;top:15%;left:50%;transform:translateX(-50%);font:bold 20px monospace;color:#fff;text-shadow:1px 1px 4px #000,0 0 8px #000;letter-spacing:3px;opacity:0;transition:opacity 0.6s;pointer-events:none;z-index:50';
  document.body.appendChild(biomeEl);

  // NPC dialog
  npcDialogEl = document.createElement('div');
  npcDialogEl.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:18%',
    'transform:translateX(-50%)',
    'background:rgba(0,0,0,0.85)', 'color:#fff',
    'font-family:monospace', 'font-size:16px',
    'padding:18px 28px', 'border-radius:10px',
    'border:2px solid #ffd700', 'max-width:420px',
    'text-align:center', 'display:none',
    'z-index:200', 'pointer-events:none', 'line-height:1.6',
  ].join(';');
  document.body.appendChild(npcDialogEl);

  // Quest HUD
  questHudEl = document.createElement('div');
  questHudEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:#ffd700;font-family:monospace;font-size:14px;padding:8px 18px;border-radius:8px;display:none;z-index:150;text-align:center';
  document.body.appendChild(questHudEl);

  // Combo counter (mejora #15)
  comboEl = document.createElement('div');
  comboEl.style.cssText = 'position:fixed;right:24px;top:80px;color:#ffaa00;font-family:monospace;font-size:22px;font-weight:bold;display:none;z-index:150;text-shadow:0 0 8px #ff6600;pointer-events:none';
  document.body.appendChild(comboEl);

  // 3D HUD — visible in VR headset, attached to camera
  const hc = document.createElement('canvas');
  hc.width = 512; hc.height = 128;
  hudCtx3d = hc.getContext('2d');
  hudTex3d = new THREE.CanvasTexture(hc);
  hudMesh3d = new THREE.Mesh(
    new THREE.PlaneGeometry(0.85, 0.21),
    new THREE.MeshBasicMaterial({ map: hudTex3d, transparent: true, depthTest: false })
  );
  hudMesh3d.position.set(0, -0.30, -0.75);
  hudMesh3d.renderOrder = 999;
  hudMesh3d.visible = false; // solo visible en VR
  camera.add(hudMesh3d);

  // Minimapa 3D en VR — esquina superior izquierda (oculto en PC)
  mmTex3d = new THREE.CanvasTexture(mmDisp);
  mmMesh3d = new THREE.Mesh(
    new THREE.PlaneGeometry(0.20, 0.20),
    new THREE.MeshBasicMaterial({ map: mmTex3d, depthTest: false })
  );
  mmMesh3d.position.set(-0.40, 0.22, -0.75);
  mmMesh3d.renderOrder = 999;
  mmMesh3d.visible = false; // solo visible en VR
  camera.add(mmMesh3d);

  // 3D NPC dialog — visible in VR headset, attached to camera above HUD
  const dc = document.createElement('canvas');
  dc.width = 512; dc.height = 256;
  npcDlgCtx = dc.getContext('2d');
  npcDlgTex = new THREE.CanvasTexture(dc);
  npcDlgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.85, 0.43),
    new THREE.MeshBasicMaterial({ map: npcDlgTex, transparent: true, depthTest: false })
  );
  npcDlgMesh.position.set(0, 0.08, -0.75);
  npcDlgMesh.renderOrder = 999;
  npcDlgMesh.visible = false;
  camera.add(npcDlgMesh);

  drawHUD3d();

  // ── Armas de PC (solo visibles en desktop, ocultas en VR) ────
  pcSword = createSword();
  // createSword ya aplica rotation.x = -PI/2; solo ajustamos Y y Z
  pcSword.rotation.y = -0.18;
  pcSword.rotation.z =  0.12;
  pcSword.position.set(0.32, -0.36, -0.55);
  // Siempre por encima de la escena (sin depth test)
  pcSword.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.depthTest = false; o.renderOrder = 998; } });
  camera.add(pcSword);

  pcShield = createShield();
  // En PC el jugador ve la parte trasera del escudo (el emblema queda hacia los enemigos)
  pcShield.rotation.y = 0.35 + Math.PI;
  pcShield.position.set(-0.38, -0.30, -0.52);
  pcShield.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.depthTest = false; o.renderOrder = 998; } });
  // Ocultar explícitamente el plano del emblema en vista PC (ya está al otro lado)
  pcShield.traverse(o => { if (o.isMesh && o.material && o.material.map) o.visible = false; });
  camera.add(pcShield);
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

let gameReady = false;

renderer.setAnimationLoop(() => {
  if (!gameReady) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (rapierWorld) {
    rapierWorld.timestep = Math.min(dt, 1 / 30);
    rapierWorld.step();
  }

  // Procesar 1 chunk de la cola por frame — evita freeze en hilo principal
  if (_chunkBuildQ.length > 0) {
    const item = _chunkBuildQ.shift();
    const ch = chunkMap.get(item.key);
    if (ch && !ch.mesh) buildChunkMesh(item.cx, item.cz);
  }

  if (!gameEnded) {
    move(dt);
    if (++_chunkTick % 45 === 0) updateChunks(); // verificar chunks cada 45 frames
    updateEnemies(dt);
    updatePushRocks(dt);
    updateDragons(dt);
    updateNPCs(dt);
    checkStarCollection();
    updateDayNight(dt);
    updateRain(dt);
    updateCameraShake(dt);
  }
  // Agua: cada 3 frames en desktop, omitir en VR
  updateWater(elapsed); // solo actualiza uniforms — sin coste CPU
  // Minimapa: en VR actualizar cada 6 frames, en desktop cada frame
  if (!renderer.xr.isPresenting || Math.round(elapsed * 10) % 6 === 0) drawMinimap();

  // Animate coins — InstancedMesh (coin magnet + rise animation)
  if (coinIM) {
    let coinChanged = false;
    for (const s of stars) {
      if (s.rising) {
        s.riseT += dt;
        const prog = Math.min(s.riseT / 0.40, 1);
        coinDummy.position.set(s.wx, s.baseY + 1.0 + prog * 1.5, s.wz);
        coinDummy.scale.setScalar(1 - prog);
        coinDummy.rotation.set(0, 0, 0);
        if (prog >= 1) s.rising = false;
        coinChanged = true;
      } else if (s.collected) {
        coinDummy.scale.setScalar(0);
        coinDummy.position.set(s.wx, s.baseY, s.wz);
        coinDummy.rotation.set(0, 0, 0);
        coinChanged = true;
      } else {
        coinDummy.position.set(s.wx, s.baseY + Math.sin(elapsed * 2.5 + s.phase) * 0.18, s.wz);
        coinDummy.rotation.set(elapsed * 1.8 + s.phase, 0, 0);
        coinDummy.scale.setScalar(1);
        coinChanged = true;
      }
      coinDummy.updateMatrix();
      coinIM.setMatrixAt(s.instIdx, coinDummy.matrix);
    }
    // Only flag needsUpdate when coins actually changed (optimización Part 3)
    if (coinChanged) coinIM.instanceMatrix.needsUpdate = true;
  }

  // Gran Moneda del Boss — animación flotante y recogida
  if (bossCoin && !bossCoin.collected) {
    const bc = bossCoin;
    if (bc.rising) {
      bc.riseT += dt;
      const prog = Math.min(bc.riseT / 0.55, 1);
      bc.mesh.position.set(bc.wx, bc.baseY + prog * 2.5, bc.wz);
      bc.mesh.scale.setScalar(1 - prog * 0.9);
      bc.mesh.rotation.y += dt * 3;
      if (prog >= 1) { bc.collected = true; scene.remove(bc.mesh); }
    } else {
      bc.mesh.position.set(bc.wx, bc.baseY + Math.sin(elapsed * 2) * 0.4, bc.wz);
      bc.mesh.rotation.y += dt * 1.8;
      const bdx = bc.wx - rig.position.x, bdz = bc.wz - rig.position.z;
      if (bdx * bdx + bdz * bdz < 4.0 * 4.0) {
        bc.rising = true; bc.riseT = 0;
        coinsCollected += bc.worth;
        sfx.starCollect();
        updateStarCounter();
      }
    }
  }

  // ── Obstáculos del laberinto: mover + daño al jugador ────────
  mazeDmgCooldown = Math.max(0, mazeDmgCooldown - dt);
  for (const obs of mazeObstacles) {
    let wx, wy, wz, qx = 0, qy = 0, qz = 0, qw = 1;

    if (obs.type === 'updown') {
      // Sube y baja entre y=0.5 y y=6 con período ~2.8s
      const t = obs.phase + elapsed * 2.2;
      wy = 3.0 + Math.sin(t) * 2.8;
      wx = obs.cx; wz = obs.cz;
      obs.mesh.position.set(wx, wy, wz);
      // Daño si la piedra está baja y el jugador está debajo
      const ddx = obs.cx - rig.position.x, ddz = obs.cz - rig.position.z;
      if (wy < 2.5 && ddx * ddx + ddz * ddz < (obs.OBS_SZ + 1) * (obs.OBS_SZ + 1)) {
        if (mazeDmgCooldown === 0) {
          playerHP = Math.max(0, playerHP - 1); updateHPBar();
          flashDamage(); mazeDmgCooldown = 1.2;
          lastDamageTime = elapsed; regenTimer = 0;
        }
      }
    } else {
      // Brazo giratorio: gira en Y alrededor del centro
      const angle = obs.phase + elapsed * 1.5;
      wy = 2.8; wx = obs.cx; wz = obs.cz;
      obs.mesh.position.set(wx, wy, wz);
      obs.mesh.rotation.y = angle;
      // Extremo del brazo: longitud = OBS_SZ * 1.4
      const armX = wx + Math.cos(angle) * obs.OBS_SZ * 1.4;
      const armZ = wz + Math.sin(angle) * obs.OBS_SZ * 1.4;
      const adx = armX - rig.position.x, adz = armZ - rig.position.z;
      if (adx * adx + adz * adz < (obs.OBS_SZ * 0.8) * (obs.OBS_SZ * 0.8)) {
        if (mazeDmgCooldown === 0) {
          playerHP = Math.max(0, playerHP - 1); updateHPBar();
          flashDamage(); mazeDmgCooldown = 1.2;
          lastDamageTime = elapsed; regenTimer = 0;
        }
      }
      // Rapier sigue la rotación del brazo
      const halfAngle = angle / 2;
      qy = Math.sin(halfAngle); qw = Math.cos(halfAngle);
    }

    if (obs.rb && rapierWorld) {
      obs.rb.setNextKinematicTranslation({ x: wx, y: wy, z: wz });
      obs.rb.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw });
    }
  }

  // ── Llave del laberinto ───────────────────────────────────────
  if (mazeKey && !mazeKey.collected) {
    mazeKey.mesh.position.y = 1.8 + Math.sin(elapsed * 2.5) * 0.3;
    mazeKey.mesh.rotation.y += dt * 1.4;
    const kdx = mazeKey.wx - rig.position.x, kdz = mazeKey.wz - rig.position.z;
    if (kdx * kdx + kdz * kdz < 3.5 * 3.5) {
      mazeKey.collected = true; hasKey = true;
      scene.remove(mazeKey.mesh);
      sfx.starCollect();
      // Mostrar mensaje
      const el = document.getElementById('biome-indicator') || document.createElement('div');
      const orig = el.textContent;
      el.textContent = '🗝 ¡Llave encontrada!';
      el.style.opacity = '1';
      setTimeout(() => { el.textContent = orig; }, 2800);
    }
  }

  // ── Puerta de la torre (requiere llave) ──────────────────────
  if (towerDoor && !towerDoor.opened) {
    doorMsgCooldown = Math.max(0, doorMsgCooldown - dt);
    const tdx = towerDoor.doorX - rig.position.x;
    const tdz = towerDoor.doorZ - rig.position.z;
    const tdy = towerDoor.doorBaseY - rig.position.y;
    const tdist2 = tdx * tdx + tdz * tdz + tdy * tdy;

    if (towerDoor.opening) {
      // Portcullis sube hasta desaparecer
      towerDoor.openT += dt;
      const prog = Math.min(towerDoor.openT / 1.0, 1);
      towerDoor.mesh.position.y = towerDoor.doorBaseY + towerDoor.DOOR_H / 2
                                 + prog * (towerDoor.DOOR_H + 2);
      if (prog >= 1) {
        towerDoor.opened = true;
        scene.remove(towerDoor.mesh);
        if (towerDoor.rb && rapierWorld) {
          rapierWorld.removeRigidBody(towerDoor.rb);
          towerDoor.rb = null;
        }
      }
    } else if (tdist2 < 7 * 7) {
      if (hasKey) {
        towerDoor.opening = true;
        sfx.starCollect();
      } else if (doorMsgCooldown === 0) {
        doorMsgCooldown = 3.0;
        const el = document.getElementById('biome-indicator');
        if (el) {
          el.textContent = '🔒 Necesitas la llave del castillo';
          el.style.opacity = '1';
          setTimeout(() => { el.style.opacity = '0'; }, 2500);
        }
      }
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
      sfx.heartPickup();
      // Flash verde al curar
      if (dmgFlashEl) {
        dmgFlashEl.style.background = '#00ee44';
        dmgFlashEl.style.opacity = '0.28';
        setTimeout(() => { if (dmgFlashEl) { dmgFlashEl.style.opacity = '0'; setTimeout(() => { dmgFlashEl.style.background = '#ff0000'; }, 400); } }, 180);
      }
    }
  }

  // ── Animación armas PC ────────────────────────────────────
  if (!renderer.xr.isPresenting && pcSword) {
    // Swing al atacar (solo clic izq — Space reservado para salto)
    if (mouseAttack && pcSwordSwingT <= 0) pcSwordSwingT = 0.22;
    if (pcSwordSwingT > 0) {
      pcSwordSwingT = Math.max(0, pcSwordSwingT - dt);
      const t = 1 - pcSwordSwingT / 0.22; // 0 → 1
      if (t < 0.20) {
        // Wind-up: subir la espada y echar atrás
        const p = t / 0.20;
        pcSword.position.set(0.32, -0.36 + p * 0.45, -0.55 + p * 0.06);
        pcSword.rotation.y = -0.18 - p * 0.25;
        pcSword.rotation.z =  0.12 + p * 0.35;
      } else {
        // Tajo: bajar rápido y al frente
        const p = (t - 0.20) / 0.80;
        const ep = 1 - Math.pow(1 - p, 2); // ease-out para velocidad inicial alta
        pcSword.position.set(0.32, 0.09 - ep * 0.60, -0.49 - ep * 0.12);
        pcSword.rotation.y = -0.43 + ep * 0.30;
        pcSword.rotation.z =  0.47 - ep * 1.25;
      }
    } else {
      pcSword.position.set(0.32, -0.36, -0.55);
      pcSword.rotation.y = -0.18;
      pcSword.rotation.z =  0.12;
    }
    // Escudo: sube y se centra al bloquear
    if (pcShield) {
      const blocking = mouseShield || keys['ShiftLeft'] || keys['ShiftRight'];
      const tY  = blocking ? -0.12 : -0.30;
      const tRY = blocking ?  0.05 :  0.35;
      pcShield.position.y += (tY  - pcShield.position.y) * Math.min(1, dt * 14);
      pcShield.rotation.y += (tRY - pcShield.rotation.y) * Math.min(1, dt * 14);
    }
  }

  renderer.render(scene, camera);
});

// ─────────────────────────────────────────────────────────────
// ROCK TOWERS — torres cilíndricas de rocas GLB decorativas
// ─────────────────────────────────────────────────────────────
function spawnRockTowers() {
  const TOW_SC  = 1.6;                     // escala de cada roca de torre
  const ROCK_H  = 0.85 * 1.20 * TOW_SC;   // ≈ 1.63 m alto por roca escalada
  const VALID   = new Set([T.GRASS, T.MOUND, T.SAND]);

  // Recopilar posiciones candidatas (evitar zonas de castillos)
  const spots = [];
  for (let z = 4; z < WORLD - 4; z++) {
    for (let x = 4; x < WORLD - 4; x++) {
      if (!VALID.has(worldMap[z][x])) continue;
      if (hash(x, z, worldSeed + 777) <= 0.988) continue;
      let nearCastle = false;
      for (let dz = -3; dz <= 3 && !nearCastle; dz++)
        for (let dx = -3; dx <= 3 && !nearCastle; dx++) {
          const t = worldMap[z + dz]?.[x + dx];
          if (t === T.DWALL || t === T.DFLOOR) nearCastle = true;
        }
      if (!nearCastle && !_occupied.has(x + ',' + z)) spots.push([x, z]);
    }
  }
  if (!spots.length) return;

  // Calcular total de rocas a instanciar
  const towerData = spots.map(([x, z]) => ({
    x, z,
    layers:   3 + Math.floor(hash(x, z, worldSeed + 500) * 3),  // 3-5 capas
    perLayer: 4 + Math.floor(hash(x, z, worldSeed + 501) * 3),  // 4-6 rocas por capa
  }));
  const totalRocks = towerData.reduce((s, t) => s + t.layers * t.perLayer, 0);
  if (!totalRocks) return;

  const towIM = new THREE.InstancedMesh(rockGeo, rockMat, totalRocks);
  towIM.castShadow = towIM.receiveShadow = true;
  let ti = 0;

  towerData.forEach(({ x, z, layers, perLayer }) => {
    const wx     = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
    const baseY  = groundAt(wx, wz);
    const radius = 1.0 + hash(x, z, worldSeed + 502) * 0.8; // 1.0–1.8 m
    // Collider físico de la torre (cápsula cilíndrica) y cima para el dragón
    const towColR = radius + TOW_SC * 0.34 + 0.4;
    if (rapierWorld) {
      rapierWorld.createCollider(
        RAPIER.ColliderDesc.capsule(ROCK_H * layers / 2, towColR)
          .setTranslation(wx, baseY + ROCK_H * layers / 2, wz)
      );
    }
    dragonRoosts.push({ x: wx, z: wz, topY: baseY + ROCK_H * layers });
    for (let ly = 0; ly < layers; ly++) {
      const off = (ly & 1) ? Math.PI / perLayer : 0; // capas alternas rotadas
      for (let ri = 0; ri < perLayer; ri++) {
        const angle = (ri / perLayer) * Math.PI * 2 + off;
        dummy.position.set(wx + Math.cos(angle) * radius,
                           baseY + ROCK_H * ly,
                           wz + Math.sin(angle) * radius);
        dummy.rotation.set(0, angle, 0);
        dummy.scale.setScalar(TOW_SC);
        dummy.updateMatrix();
        towIM.setMatrixAt(ti++, dummy.matrix);
      }
    }
  });
  towIM.instanceMatrix.needsUpdate = true;
  scene.add(towIM);
}

// ─────────────────────────────────────────────────────────────
// AVE FÉNIX — despega de torres y dispara bolas de fuego
// ─────────────────────────────────────────────────────────────
const _BMAT_BODY  = new THREE.MeshLambertMaterial({ color: 0xcc3300 });
const _BMAT_BELLY = new THREE.MeshLambertMaterial({ color: 0xff8800 });
const _BMAT_HEAD  = new THREE.MeshLambertMaterial({ color: 0xdd2200 });
const _BMAT_WING  = new THREE.MeshLambertMaterial({ color: 0xff4400, side: THREE.DoubleSide });
const _BMAT_BEAK  = new THREE.MeshLambertMaterial({ color: 0xffcc00 });
const _BMAT_EYE_W = new THREE.MeshLambertMaterial({ color: 0xffffff });          // sclera blanca
const _BMAT_EYE_P = new THREE.MeshLambertMaterial({ color: 0x111111 });          // pupila negra
const _BMAT_EYE_S = new THREE.MeshLambertMaterial({ color: 0xffffff,            // brillo pupila
  emissive: 0xffffff, emissiveIntensity: 1.0 });
const _BMAT_CREST = new THREE.MeshLambertMaterial({ color: 0xff2200 });
const _BMAT_TAIL  = new THREE.MeshLambertMaterial({ color: 0xff5500, side: THREE.DoubleSide });
const _FIRE_MAT   = new THREE.MeshLambertMaterial({ color: 0xff6600, emissive: 0xff2200, emissiveIntensity: 1.2 });
const _FIRE_GEO   = new THREE.SphereGeometry(0.22, 6, 4);

function _createBirdMesh() {
  const g = new THREE.Group();

  // ── Cuerpo — huevo compacto (mejora #1) ──────────────────
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.36, 9, 6), _BMAT_BODY);
  body.scale.set(0.80, 0.72, 1.55);
  g.add(body);

  // Pecho — naranja más claro
  const breast = new THREE.Mesh(new THREE.SphereGeometry(0.28, 7, 5), _BMAT_BELLY);
  breast.scale.set(0.70, 0.52, 1.30);
  breast.position.set(0, -0.10, 0.08);
  g.add(breast);

  // ── Cuello corto ─────────────────────────────────────────
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, 0.28, 6), _BMAT_BODY);
  neck.rotation.x = -0.48;
  neck.position.set(0, 0.16, 0.50);
  g.add(neck);

  // ── Cabeza grande y redonda (mejora #1) ──────────────────
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 9, 7), _BMAT_HEAD);
  head.position.set(0, 0.30, 0.68);
  g.add(head);

  // Cresta — 3 plumas en la coronilla
  [[-0.06, 0.00, -0.05], [0, 0.06, 0.0], [0.06, 0.00, -0.05]].forEach(([ox, oy, rz]) => {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.18, 4), _BMAT_CREST);
    c.position.set(ox, 0.56 + oy, 0.64);
    c.rotation.set(-0.20, 0, rz);
    g.add(c);
  });

  // ── Pico dorado (apunta en +Z) ───────────────────────────
  const beakU = new THREE.Mesh(new THREE.ConeGeometry(0.040, 0.19, 5), _BMAT_BEAK);
  beakU.rotation.x = Math.PI / 2;
  beakU.position.set(0, 0.32, 0.93);
  g.add(beakU);

  const beakL = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.12, 4), _BMAT_BEAK);
  beakL.rotation.x = Math.PI / 2 + 0.28;
  beakL.position.set(0, 0.24, 0.91);
  g.add(beakL);

  // ── Ojos expresivos: sclera + pupila (técnica del sapo, mejora #2) ──
  for (const sx of [-0.175, 0.175]) {
    // Sclera blanca
    const sclera = new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 5), _BMAT_EYE_W);
    sclera.position.set(sx, 0.34, 0.78);
    g.add(sclera);
    // Pupila negra — 0.09m adelante de la sclera
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.046, 6, 4), _BMAT_EYE_P);
    pupil.position.set(sx, 0.34, 0.87);
    g.add(pupil);
    // Punto de brillo pequeño
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.016, 4, 3), _BMAT_EYE_S);
    shine.position.set(sx + (sx > 0 ? -0.02 : 0.02), 0.36, 0.895);
    g.add(shine);
  }

  // ── Alas de ave (BufferGeometry barrida horizontalmente) ──
  function makeBirdWingGeo() {
    const p = new Float32Array([
       0.0,  0.0,  0.20,  // 0 raíz delantera
       0.0,  0.0, -0.18,  // 1 raíz trasera
       1.85, 0.24,-0.82,  // 2 codo / punta trasera
       2.55, 0.08,  0.0,  // 3 punta primaria
       1.75,-0.08,  0.44, // 4 punta inferior
       0.32,-0.07,  0.28, // 5 raíz inferior
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setIndex([0,2,1, 0,3,2, 0,4,3, 0,5,4]);
    geo.computeVertexNormals();
    return geo;
  }
  const wGeo = makeBirdWingGeo();

  const lWing = new THREE.Mesh(wGeo, _BMAT_WING);
  lWing.position.set(0.29, 0.05, 0.0);
  g.add(lWing);

  const rWing = new THREE.Mesh(wGeo, _BMAT_WING);
  rWing.position.set(-0.29, 0.05, 0.0);
  rWing.scale.x = -1;
  g.add(rWing);

  // ── Cola en abanico (3 plumas) ────────────────────────────
  [[-0.28, 0], [0, 0], [0.28, 0]].forEach(([rz]) => {
    const feather = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.80), _BMAT_TAIL);
    feather.rotation.set(Math.PI / 2, 0, rz);
    feather.position.set(0, -0.05, -0.90);
    g.add(feather);
  });

  g.scale.setScalar(0.80);  // más pequeño y compacto (mejora #1)
  const beakTip = new THREE.Vector3(0, 0.32, 1.03); // punta del pico para fireball
  return { group: g, lWing, rWing, beakTip };
}

function spawnDragons() {
  for (const roost of dragonRoosts) {
    const { group, lWing, rWing, beakTip } = _createBirdMesh();
    group.rotation.order = 'YXZ';
    const startAngle = Math.random() * Math.PI * 2;
    group.position.set(
      roost.x + Math.cos(startAngle) * 6.5,
      roost.topY + 5.0,
      roost.z + Math.sin(startAngle) * 6.5
    );
    scene.add(group);
    dragons.push({
      mesh: group, lWing, rWing, beakTip, roost,
      state: 'circling',      // circling only — siempre volando
      stateT: 0,
      orbitAngle: startAngle,
      shootCooldown: 1.5 + Math.random() * 2,
    });
  }
}

function updateDragons(dt) {
  const px = rig.position.x, pz = rig.position.z;
  const playerWorldY = rig.position.y + EYE;

  for (const d of dragons) {
    d.stateT += dt;
    const rx = px - d.roost.x, rz = pz - d.roost.z;
    const distRoost = Math.sqrt(rx * rx + rz * rz);

    // Aleteo continuo en vuelo
    const flapVal = Math.sin(elapsed * 7.0 + d.orbitAngle) * 0.5;
    d.lWing.rotation.z =  flapVal;
    d.rWing.rotation.z = -flapVal;

    // Siempre en estado circling — orbita torre (lejos) o jugador (cerca)
    const nearPlayer = distRoost < 16;
    const cx  = nearPlayer ? px                           : d.roost.x;
    const cz  = nearPlayer ? pz                           : d.roost.z;
    const oR  = nearPlayer ? 5.5                          : 6.5;
    const oY  = nearPlayer ? groundAt(px, pz) + EYE + 3.5 : d.roost.topY + 5.0;
    const spd = nearPlayer ? 1.1                          : 0.65;

    d.orbitAngle += dt * spd;
    const tX = cx + Math.cos(d.orbitAngle) * oR;
    const tZ = cz + Math.sin(d.orbitAngle) * oR;
    d.mesh.position.x += (tX - d.mesh.position.x) * Math.min(1, dt * 4.5);
    d.mesh.position.y += (oY - d.mesh.position.y) * Math.min(1, dt * 2.5);
    d.mesh.position.z += (tZ - d.mesh.position.z) * Math.min(1, dt * 4.5);
    // Mira en la dirección de vuelo (tangente al círculo)
    d.mesh.rotation.y = d.orbitAngle - Math.PI / 2;
    d.mesh.rotation.x = 0.07;   // leve nariz abajo
    d.mesh.rotation.z = -0.30;  // banco hacia adentro del viraje

    // Torres visitadas (quest #2)
    if (activeQuestId === 2 && !questComplete && distRoost < 8) {
      towersVisited.add(d.roost.x + ',' + d.roost.z);
      questProgress = towersVisited.size;
      updateQuestHUD();
      if (towersVisited.size >= 4) { questComplete = true; updateQuestHUD(); }
    }

    // Disparo — solo cuando orbita al jugador
    if (nearPlayer) d.shootCooldown -= dt;
    if (nearPlayer && d.shootCooldown <= 0) {
      d.shootCooldown = 2.0 + Math.random() * 1.5;
      const fMesh = new THREE.Mesh(_FIRE_GEO, _FIRE_MAT);
      const beakWorld = d.mesh.localToWorld(d.beakTip.clone());
      fMesh.position.copy(beakWorld);
      scene.add(fMesh);
      const fdx = px - fMesh.position.x;
      const fdy = playerWorldY - fMesh.position.y;
      const fdz = pz - fMesh.position.z;
      const fd  = Math.sqrt(fdx*fdx + fdy*fdy + fdz*fdz) || 1;
      const fspd = 11;
      fireBalls.push({ mesh: fMesh,
        vx: fdx/fd*fspd, vy: fdy/fd*fspd, vz: fdz/fd*fspd, life: 3.5 });
    }
  }

  // ── Bolas de fuego ────────────────────────────────────────
  for (let i = fireBalls.length - 1; i >= 0; i--) {
    const f = fireBalls[i];
    f.life -= dt;
    if (f.life <= 0) { scene.remove(f.mesh); fireBalls.splice(i, 1); continue; }
    f.vy -= 4.5 * dt;               // mejora #6: gravedad — arco parabólico
    f.mesh.position.x += f.vx * dt;
    f.mesh.position.y += f.vy * dt;
    f.mesh.position.z += f.vz * dt;
    f.mesh.scale.setScalar(0.5 + (f.life / 3.5) * 0.8);
    // Impacto con el jugador
    const hx = f.mesh.position.x - px;
    const hy = f.mesh.position.y - playerWorldY;
    const hz = f.mesh.position.z - pz;
    if (hx*hx + hy*hy + hz*hz < 0.9 * 0.9 && !gameEnded) {
      scene.remove(f.mesh); fireBalls.splice(i, 1);
      if (!isShieldActive()) {          // mejora #20: escudo bloquea bola de fuego
        playerHP = Math.max(0, playerHP - 1);
        updateHPBar();
        flashDamage();                  // mejora #4: flash rojo
        lastDamageTime = elapsed;
        regenTimer = 0;
        showFloatingDmg();
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
// NPCs — casas y personajes
// ─────────────────────────────────────────────────────────────
function spawnNPCs() {
  npcs.length = 0;
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x2d5a1b, flatShading: true });
  const doorMat = new THREE.MeshLambertMaterial({ color: 0x1a0f00 });
  const eyeWMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const eyePMat = new THREE.MeshLambertMaterial({ color: 0x111111 });

  NPC_DEFS.forEach((def, idx) => {
    const wx = def.tx * TILE + TILE / 2;
    const wz = def.tz * TILE + TILE / 2;
    const gy = groundAt(wx, wz);

    // ── Casa ──────────────────────────────────────────────────
    // Rotar para que la puerta (+Z local) apunte al centro de la aldea
    const _vcx = VILLAGE_CX * TILE + TILE / 2;
    const _vcz = VILLAGE_CZ * TILE + TILE / 2;
    const _hrot = Math.atan2(_vcx - wx, _vcz - wz); // atan2(dX, dZ) para rotación Y

    // Escalar en conjunto para que los ojos del NPC queden a la altura del jugador
    const S = EYE / 1.51;

    const houseGroup = new THREE.Group();
    houseGroup.position.set(wx, gy, wz);
    houseGroup.rotation.y = _hrot;
    houseGroup.scale.setScalar(S);

    const wallConfigs = [
      { pos:[0, 1.2, -2.2], rot:[0, 0, 0],              scl:[3.8, 2.4, 0.5] },
      { pos:[0, 1.2,  2.2], rot:[0, Math.PI, 0],        scl:[3.8, 2.4, 0.5] },
      { pos:[-2.2, 1.2, 0], rot:[0, Math.PI/2, 0],      scl:[3.8, 2.4, 0.5] },
      { pos:[ 2.2, 1.2, 0], rot:[0, -Math.PI/2, 0],     scl:[3.8, 2.4, 0.5] },
    ];
    wallConfigs.forEach(({ pos, rot, scl }) => {
      const w = new THREE.Mesh(rockGeo, rockMat);
      w.position.set(...pos);
      w.rotation.set(...rot);
      w.scale.set(...scl);
      w.castShadow = w.receiveShadow = true;
      houseGroup.add(w);
    });

    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.5), doorMat);
    door.position.set(0, 0.75, 2.21);
    door.rotation.set(0, Math.PI, 0);
    houseGroup.add(door);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 2.0, 4, 1), roofMat);
    roof.position.set(0, 3.2, 0);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    houseGroup.add(roof);

    scene.add(houseGroup);

    // ── Personaje NPC ─────────────────────────────────────────
    const npcGroup = new THREE.Group();
    const bodyMat  = new THREE.MeshLambertMaterial({ color: def.color });

    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), bodyMat);
    bodyMesh.position.y = 0.85;
    npcGroup.add(bodyMesh);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 7, 5), bodyMat);
    head.position.y = 1.48;
    npcGroup.add(head);

    [[-0.11, 0], [0.11, 0]].forEach(([ox]) => {
      const sc = new THREE.Mesh(new THREE.SphereGeometry(0.07, 5, 4), eyeWMat);
      sc.position.set(ox, 1.51, 0.22);
      npcGroup.add(sc);
      const pu = new THREE.Mesh(new THREE.SphereGeometry(0.042, 4, 3), eyePMat);
      pu.position.set(ox, 1.51, 0.27);
      npcGroup.add(pu);
    });

    const indGeo = new THREE.SphereGeometry(0.12, 5, 4);
    const indMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
    const indicator = new THREE.Mesh(indGeo, indMat);
    indicator.position.y = 2.1;
    npcGroup.add(indicator);

    // Posicionar frente a la puerta (en la dirección que apunta la puerta)
    const _dsx = Math.sin(_hrot), _dsz = Math.cos(_hrot);
    const npcOffX = wx + _dsx * 3.2 * S;
    const npcOffZ = wz + _dsz * 3.2 * S;
    npcGroup.position.set(npcOffX, gy, npcOffZ);
    npcGroup.rotation.y = _hrot + Math.PI; // NPC mira hacia la puerta
    npcGroup.scale.setScalar(S);
    scene.add(npcGroup);

    npcs.push({
      mesh: npcGroup, indicator, body: bodyMesh,
      wx: npcOffX, wz: npcOffZ,
      questId: def.questId, name: def.name,
      bobPhase: idx * 1.3,
    });
  });
}

// ─────────────────────────────────────────────────────────────
// ALDEA DE ERYNDELL — muro perimetral, entradas y carteles
// ─────────────────────────────────────────────────────────────
function _makeSignTex() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 80;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6b3d0e';
  ctx.fillRect(0, 0, 256, 80);
  ctx.strokeStyle = '#3d1a00';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, 248, 72);
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 17px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('★ ALDEA DE ERYNDELL ★', 128, 26);
  ctx.fillStyle = '#ffeeaa';
  ctx.font = '13px serif';
  ctx.fillText('Bienvenido, viajero', 128, 56);
  return new THREE.CanvasTexture(c);
}


// ─────────────────────────────────────────────────────────────
// LABERINTO DEL CASTILLO
// Paredes de piedra, trampas móviles y una llave escondida
// Interior del castillo: x∈[276,468], z∈[156,252], suelo y=0
// Entrada sur: x∈[360,384] (tiles PATH 30-31), z=252
// ─────────────────────────────────────────────────────────────
function spawnCastleMaze() {
  const WALL_H = 8.5;
  const TH     = 1.5;   // semi-grosor de muros
  const BASE   = 0;

  function placeWall(cx, cz, hx, hz) {
    const m = new THREE.Mesh(rockGeo, rockMat);
    m.position.set(cx, BASE + WALL_H / 2, cz);
    m.scale.set((hx * 2) / 0.68, WALL_H / 1.02, (hz * 2) / 0.68);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    if (rapierWorld)
      rapierWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, WALL_H / 2, hz)
          .setTranslation(cx, BASE + WALL_H / 2, cz)
      );
  }

  // ════════════════════════════════════════════════════════════
  // LABERINTO EN SERPENTINA — 4 vueltas obligatorias
  //
  // Interior: x∈[276,468]  z∈[156,252]
  // Entrada:  x≈372,       z=252  (sur, centro)
  // Llave:    x≈450,       z=161  (NE, tras 4 vueltas)
  //
  // Camino correcto:
  //  Entrada → ir al OESTE (x<312) → cruzar B1 →
  //  ir al ESTE  (x>432) → cruzar B2 →
  //  ir al OESTE (x<312) → cruzar B3 →
  //  ir al ESTE  (x>432) → cruzar B4 → LLAVE
  //
  // Cada tramo obliga a recorrer ~156 m de pasillo.
  // ════════════════════════════════════════════════════════════

  // ── B1 (z=228): gap OESTE x:276-312 ──────────────────────────
  placeWall(390, 228, 78, TH);   // bloquea x:312-468

  // ── B2 (z=210): gap ESTE  x:432-468 ──────────────────────────
  placeWall(354, 210, 78, TH);   // bloquea x:276-432

  // ── B3 (z=186): gap OESTE x:276-312 ──────────────────────────
  placeWall(390, 186, 78, TH);   // bloquea x:312-468

  // ── B4 (z=168): gap ESTE  x:432-468 → llave ──────────────────
  placeWall(354, 168, 78, TH);   // bloquea x:276-432

  // ── Salas falsas: alcobas sin salida para despistar ───────────

  // Zona entrada (z:228-252): sala este — dead end al explorar derecha
  placeWall(432, 240, TH, 12);   // x=432, z:228-252

  // Zona B1-B2 (z:210-228, 18m): alcoba NE — parece salida al este
  placeWall(432, 223, TH, 4.5);  // x=432, z:218.5-227.5  (mitad norte)
  //   → jugador puede cruzar x=432 por z:210-218.5 (mitad sur, libre)

  // Zona B2-B3 (z:186-210, 24m): dos alcobas opuestas
  placeWall(348, 204, TH, 6);    // x=348, z:198-210  (NW alcoba, mitad norte)
  //   → jugador cruza x=348 por z:186-198 (mitad sur, libre)
  placeWall(432, 192, TH, 6);    // x=432, z:186-198  (SE alcoba, mitad sur)
  //   → jugador cruza x=432 por z:198-210 (mitad norte, libre)

  // Zona B3-B4 (z:168-186, 18m): alcoba SW — falsa promesa al oeste
  placeWall(348, 172, TH, 4.5);  // x=348, z:167.5-176.5 (mitad sur)
  //   → jugador cruza x=348 por z:176.5-186 (mitad norte, libre)

  // ── Obstáculos móviles en cada gap ───────────────────────────
  _addMazeObs(294, 228, 'orbit',  0);            // B1 gap oeste
  _addMazeObs(450, 210, 'updown', 0);            // B2 gap este
  _addMazeObs(294, 186, 'updown', Math.PI);      // B3 gap oeste
  _addMazeObs(450, 168, 'orbit',  Math.PI * 0.5); // B4 gap este (guarda llave)

  // ── Llave: sala NE, tras superar B4 ──────────────────────────
  const kMat = new THREE.MeshLambertMaterial({
    color: 0xffd700, emissive: 0xcc7700, emissiveIntensity: 0.7,
  });
  const kGroup = new THREE.Group();

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 2.2, 8), kMat);
  shaft.rotation.z = Math.PI / 2;
  kGroup.add(shaft);

  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.60, 0.20, 7, 12), kMat);
  bow.position.x = -1.2; bow.rotation.x = Math.PI / 2;
  kGroup.add(bow);

  for (let i = 0; i < 3; i++) {
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.38, 0.18), kMat);
    tooth.position.set(0.1 + i * 0.5, -0.42, 0);
    kGroup.add(tooth);
  }

  kGroup.position.set(450, 1.8, 161);
  kGroup.scale.setScalar(2.2);
  scene.add(kGroup);
  mazeKey = { mesh: kGroup, wx: 450, wz: 161, collected: false };
}

function _addMazeObs(cx, cz, type, phase) {
  const OBS_SZ = 4.8;  // metros de lado del bloque
  const mat = new THREE.MeshLambertMaterial({ color: 0x5c3a1e, flatShading: true });

  let mesh;
  if (type === 'orbit') {
    // Brazo largo que gira horizontalmente
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(OBS_SZ * 2.8, OBS_SZ * 0.7, OBS_SZ * 0.7),
      mat
    );
  } else {
    mesh = new THREE.Mesh(rockGeo, mat);
    mesh.scale.setScalar(OBS_SZ / 0.68);
  }
  mesh.castShadow = true;
  scene.add(mesh);

  let rb = null;
  if (rapierWorld) {
    const rbd = RAPIER.RigidBodyDesc.kinematicPositionBased();
    rb = rapierWorld.createRigidBody(rbd);
    const hx = type === 'orbit' ? OBS_SZ * 1.4 : OBS_SZ / 2;
    const hy = type === 'orbit' ? OBS_SZ * 0.35 : OBS_SZ / 2;
    const hz = type === 'orbit' ? OBS_SZ * 0.35 : OBS_SZ / 2;
    rapierWorld.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz), rb);
  }

  mazeObstacles.push({ mesh, rb, type, cx, cz, phase, OBS_SZ });
}

// ─────────────────────────────────────────────────────────────
// TECHO DE ROCA DEL CASTILLO
// Losas planas sobre los tiles DFLOOR a la altura del tope de las paredes
// ─────────────────────────────────────────────────────────────
function spawnCastleRoof() {
  // Mismas constantes que buildTiles() para coincidir con la altura real de los muros
  const WLAYERS = 7;
  const WSCALE  = TILE / (3 * 0.68);          // ≈ 5.88
  const LAYER_H = 1.02 * WSCALE;              // ≈ 6.0 m por capa
  const roofY   = (WLAYERS - 1) * LAYER_H;    // 1 capa abajo del tope — almenas visibles sobre el techo
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x3d2e1e, flatShading: true });
  const FSCALE_XZ = (TILE * 0.97) / 0.68;    // igual que losas de suelo
  const FSCALE_Y  = 0.6;                      // losa muy plana

  const dfloors = [];
  for (let z = 13; z < 21; z++)
    for (let x = 23; x < 39; x++)
      if (worldMap[z][x] === T.DFLOOR) dfloors.push([x, z]);

  if (!dfloors.length) return;

  const roofIM = new THREE.InstancedMesh(rockGeo, roofMat, dfloors.length);
  roofIM.castShadow = roofIM.receiveShadow = true;
  dfloors.forEach(([x, z], i) => {
    const cx = x * TILE + TILE / 2, cz = z * TILE + TILE / 2;
    const ry = (hash(x, z, worldSeed + 77) - 0.5) * 0.10;
    dummy.position.set(cx, roofY, cz);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.set(FSCALE_XZ, FSCALE_Y, FSCALE_XZ);
    dummy.updateMatrix();
    roofIM.setMatrixAt(i, dummy.matrix);
  });
  roofIM.instanceMatrix.needsUpdate = true;
  scene.add(roofIM);

  // Física: un cuboid por tile del techo para que el jugador pueda caminar encima
  if (rapierWorld) {
    dfloors.forEach(([x, z]) => {
      const cx = x * TILE + TILE / 2, cz = z * TILE + TILE / 2;
      rapierWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(TILE / 2, 0.6, TILE / 2)
          .setTranslation(cx, roofY, cz)
      );
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SLIME GIGANTE BOSS — techo del castillo
// ─────────────────────────────────────────────────────────────
function spawnBossSlime() {
  const WLAYERS = 7, WSCALE = TILE / (3 * 0.68), LAYER_H = 1.02 * WSCALE;
  const roofY = (WLAYERS - 1) * LAYER_H;
  const SC = 20.0; // escala respecto al slime normal

  const bx = 31 * TILE + TILE / 2;
  const bz = 17 * TILE + TILE / 2;

  const bossMat = new THREE.MeshLambertMaterial({ color: 0x1b5e20, flatShading: true });
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.42 * SC, 12, 8), bossMat);
  body.scale.y = 0.65;
  body.position.y = 0.3 * SC;
  body.castShadow = true;
  g.add(body);

  for (const sx of [-0.16 * SC, 0.16 * SC]) {
    const eye   = new THREE.Mesh(new THREE.SphereGeometry(0.10 * SC, 7, 5), ENEMY_MAT_EYE);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055 * SC, 5, 4), ENEMY_MAT_PUPIL);
    eye.position.set(sx,   0.46 * SC, 0.33 * SC);
    pupil.position.set(sx, 0.46 * SC, 0.43 * SC);
    g.add(eye, pupil);
  }

  const bossFloorY = roofY + 0.6;   // top surface of roof physics collider
  g.position.set(bx, bossFloorY, bz);
  scene.add(g);

  // Colisionador cinemático — sigue al boss cada frame (igual que el del jugador)
  let bossRBody = null;
  if (rapierWorld) {
    const bodyR = 0.42 * SC;
    const bodyH = bodyR * 0.65;
    const rbDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(bx, bossFloorY, bz);
    bossRBody = rapierWorld.createRigidBody(rbDesc);
    rapierWorld.createCollider(
      RAPIER.ColliderDesc.cylinder(bodyH * 1.1, bodyR * 1.05)
        .setTranslation(0, 0.3 * SC, 0),  // centrado en el cuerpo (offset local)
      bossRBody
    );
  }

  enemies.push({
    mesh: g, hp: 30, hitCooldown: 0, dead: false, deathT: 0,
    spawnX: bx, spawnZ: bz, aggroed: false,
    vx: 0, vz: 0, squashT: 0, hitFlashT: 0,
    patrolTarget: null, patrolPause: 2.5, patrolStep: 0,
    lungePhase: 'cooldown', lungeT: 2.0,
    lungeDir: new THREE.Vector3(), lungeDamaged: false,
    phase: 0,
    fixedY: bossFloorY,   // no usar groundAt — siempre sobre el techo
    aggroRange: 55,        // ve al jugador desde lejos
    lungeRange: 11.0,      // inicia ciclo de ataque (> radio colisionador 8.82m)
    hitRange:   10.5,      // boss golpea jugador al contacto con su cuerpo
    swordHitRange: 10.0,  // espada alcanza la superficie del boss desde el borde
    chaseSpeed: 4.5,       // m/s persecución
    lungeSpeed: 16.0,      // m/s durante el lunge
    _bossMat: bossMat, _bossBody: body, _bossScale: SC,
    bossRBody,           // kinematic Rapier body — se actualiza cada frame
  });
}

// ─────────────────────────────────────────────────────────────
// ESCALERAS HELICOIDALES ALREDEDOR DE LAS TORRES
// ─────────────────────────────────────────────────────────────
function spawnSpiralStairs() {
  // Plataformas discretas de salto dentro de las torres.
  // Cada plataforma es un bloque ancho; el jugador debe SALTAR de una a otra.
  const WALL_D   = TILE * 0.55;
  const towerR   = TILE * 1.3;
  const innerR   = towerR - WALL_D / 2;

  const N_PLAT      = 64;               // número de plataformas
  const N_TURNS     = 8;                // vueltas totales de la espiral
  const STEP_H_RISE = 1.2;             // altura por escalón
  const PLAT_D      = 3.0;             // profundidad radial (m)
  const PLAT_R      = innerR - PLAT_D; // más adentro: borde exterior 1.5m libre del muro
  const PLAT_W      = 14.0;            // ancho amplio: peldaños se solapan, sin huecos
  const PLAT_T      = 0.9;             // grosor/alto del bloque (m)

  const SX = PLAT_W / 0.68;
  const SY = PLAT_T / 1.02;
  const SZ = PLAT_D / 0.68;

  const CASTLE_CX = 31 * TILE + TILE * 0.5;
  const CASTLE_CZ = 17 * TILE + TILE * 0.5;

  const positions = [
    { tx: 17, tz: 24 },
    { tx: 44, tz: 24 },
  ];

  const stairMat = new THREE.MeshLambertMaterial({ color: 0x7a6050, flatShading: true });
  const stairIM  = new THREE.InstancedMesh(rockGeo, stairMat, positions.length * N_PLAT);
  stairIM.castShadow = stairIM.receiveShadow = true;
  const sd = new THREE.Object3D();
  let si = 0;

  positions.forEach(({ tx, tz }) => {
    const wx = tx * TILE + TILE * 0.5;
    const wz = tz * TILE + TILE * 0.5;
    const bh = groundAt(wx, wz);
    // Empezar 120° después de la puerta para que el primer escalón sea accesible desde dentro
    const doorAngle  = Math.atan2(CASTLE_CZ - wz, CASTLE_CX - wx);
    const startAngle = doorAngle + Math.PI * 0.67;

    for (let s = 0; s < N_PLAT; s++) {
      const frac  = s / (N_PLAT - 1);
      const angle = startAngle + frac * Math.PI * 2 * N_TURNS;
      const platY = bh + (s + 1) * STEP_H_RISE;
      const platX = wx + Math.cos(angle) * PLAT_R;
      const platZ = wz + Math.sin(angle) * PLAT_R;

      sd.position.set(platX, platY - PLAT_T * 0.5, platZ);
      sd.rotation.set(0, -(Math.PI / 2 + angle), 0);
      sd.scale.set(SX, SY, SZ);
      sd.updateMatrix();
      stairIM.setMatrixAt(si++, sd.matrix);

      // Collider físico del peldaño
      if (rapierWorld) {
        rapierWorld.createCollider(
          RAPIER.ColliderDesc.cuboid(PLAT_W / 2, PLAT_T / 2, PLAT_D / 2)
            .setTranslation(platX, platY - PLAT_T / 2, platZ)
            .setRotation(_yRotQuat(-(Math.PI / 2 + angle)))
        );
      }
    }
  });

  stairIM.instanceMatrix.needsUpdate = true;
  scene.add(stairIM);
}

// ─────────────────────────────────────────────────────────────
// PUENTE — Torre SW → cima muro castillo
// ─────────────────────────────────────────────────────────────
function spawnTowerDoor() {
  // Mismas constantes que spawnCastleTowers() para coincidir con la geometría del arco
  const towerR = TILE * 1.3, WALL_D = TILE * 0.55, BLOCK_H = TILE * 0.52;
  const outerR  = towerR + WALL_D / 2;
  const ROCKS_RING = 24, DOOR_SEGS = 4, DOOR_LAYERS = 3;
  const segAngle = (2 * Math.PI) / ROCKS_RING;
  const CASTLE_CX = 31 * TILE + TILE * 0.5, CASTLE_CZ = 17 * TILE + TILE * 0.5;
  const wx = 17 * TILE + TILE * 0.5, wz = 24 * TILE + TILE * 0.5;
  const bh = groundAt(wx, wz);
  const doorAngle = Math.atan2(CASTLE_CZ - wz, CASTLE_CX - wx);
  const cdx = Math.cos(doorAngle), cdz = Math.sin(doorAngle);

  // Posición: centrada en el espesor del muro (towerR), a nivel del suelo
  const doorX = wx + cdx * towerR;
  const doorZ = wz + cdz * towerR;
  const doorBaseY = bh;  // nivel del suelo — entrada baja de la torre
  // Dimensiones que cubren todo el hueco del arco (cuerda al radio exterior × margen)
  const DOOR_W = segAngle * DOOR_SEGS * outerR * 1.10;  // cubre el ancho total del arco
  const DOOR_H = DOOR_LAYERS * BLOCK_H;                  // ≈ alto del arco
  const DOOR_T = WALL_D * 1.05;                          // tan gruesa como el muro

  // Rotación: cara de la puerta perpendicular al puente (bloquea el paso)
  const faceQ = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(cdx, 0, cdz)
  );

  const doorMat = new THREE.MeshLambertMaterial({ color: 0x1a0f00, flatShading: true });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W, DOOR_H, DOOR_T), doorMat);
  mesh.position.set(doorX, doorBaseY + DOOR_H / 2, doorZ);
  mesh.quaternion.copy(faceQ);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);

  // Barrotes verticales y travesaños para que parezca una reja/portcullis
  const barMat = new THREE.MeshLambertMaterial({ color: 0x3a1f00 });
  const N_VBARS = 7;
  for (let i = 0; i < N_VBARS; i++) {
    const bx = (i / (N_VBARS - 1) - 0.5) * DOOR_W * 0.88;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.35, DOOR_H * 0.96, DOOR_T * 1.05), barMat);
    bar.position.set(bx, 0, 0);
    mesh.add(bar);
  }
  const N_HBARS = 5;
  for (let j = 0; j < N_HBARS; j++) {
    const by = (j / (N_HBARS - 1) - 0.5) * DOOR_H * 0.88;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W * 0.92, 0.30, DOOR_T * 1.05), barMat);
    rail.position.set(0, by, 0);
    mesh.add(rail);
  }

  // Rapier: kinematic body → se puede eliminar al abrir
  let rb = null;
  if (rapierWorld) {
    const rbd = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(doorX, doorBaseY + DOOR_H / 2, doorZ)
      .setRotation({ x: faceQ.x, y: faceQ.y, z: faceQ.z, w: faceQ.w });
    rb = rapierWorld.createRigidBody(rbd);
    rapierWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(DOOR_W / 2, DOOR_H / 2, DOOR_T / 2), rb
    );
  }

  towerDoor = { mesh, rb, doorX, doorZ, doorBaseY, DOOR_H, opened: false, opening: false, openT: 0 };
}

function spawnBridge() {
  const WLAYERS = 7, WSCALE = TILE / (3 * 0.68), LAYER_H = 1.02 * WSCALE;
  const towerR = TILE * 1.3, WALL_D = TILE * 0.55, BLOCK_H = TILE * 0.52;
  const innerR = towerR - WALL_D / 2;
  const CASTLE_CX = 31 * TILE + TILE * 0.5, CASTLE_CZ = 17 * TILE + TILE * 0.5;

  const wx = 17 * TILE + TILE * 0.5, wz = 24 * TILE + TILE * 0.5;
  const bh = groundAt(wx, wz);
  const doorAngle = Math.atan2(CASTLE_CZ - wz, CASTLE_CX - wx);
  const cdx = Math.cos(doorAngle), cdz = Math.sin(doorAngle);
  const px = -cdz, pz = cdx; // perpendicular al puente

  const startX = wx + cdx * innerR, startZ = wz + cdz * innerR;
  const startY = bh + BLOCK_H * 10;
  const endXTarget = 22 * TILE + TILE * 0.5;
  const tLen = (endXTarget - startX) / cdx;
  const endX = endXTarget, endZ = startZ + tLen * cdz;
  const endY = groundAt(endX, endZ) + WLAYERS * LAYER_H;
  const bridgeLen = Math.hypot(endX - startX, endZ - startZ);

  // Curva del arco: y(t) = lerp + ARCH_H * sin(π*t)  — sube, luego baja
  const ARCH_H = 10.0;
  const archY = t => startY + (endY - startY) * t + ARCH_H * Math.sin(Math.PI * t);
  // Ángulo tangente en cada punto del arco para inclinar los bloques
  const archSlope = t => Math.atan2(
    (endY - startY) + ARCH_H * Math.PI * Math.cos(Math.PI * t),
    bridgeLen
  );

  const BRIDGE_W = 4.5, BRIDGE_D = 2.4, BRIDGE_H = 1.4;
  const N = Math.max(6, Math.ceil(bridgeLen / BRIDGE_D));
  const rotY = -(Math.PI / 2 + doorAngle);

  // Quaternions reutilizables (evita garbage en el loop)
  const _axY = new THREE.Vector3(0, 1, 0), _axX = new THREE.Vector3(1, 0, 0);
  const _qYb = new THREE.Quaternion().setFromAxisAngle(_axY, rotY);
  const _qXt = new THREE.Quaternion(), _qFn = new THREE.Quaternion();

  // ── Suelo del puente — rockMat igual que muros del castillo ─────────
  const floorIM = new THREE.InstancedMesh(rockGeo, rockMat, N);
  floorIM.castShadow = floorIM.receiveShadow = true;
  const fd = new THREE.Object3D();

  for (let i = 0; i < N; i++) {
    const f  = (i + 0.5) / N;
    const bx = startX + (endX - startX) * f;
    const bz = startZ + (endZ - startZ) * f;
    const sa = archSlope(f);
    const by = archY(f) - BRIDGE_H * 0.5;

    _qXt.setFromAxisAngle(_axX, sa);
    _qFn.copy(_qYb).multiply(_qXt);

    fd.position.set(bx, by, bz);
    fd.quaternion.copy(_qFn);
    fd.scale.set(BRIDGE_W / 0.68, BRIDGE_H / 1.02, BRIDGE_D / 0.68);
    fd.updateMatrix();
    floorIM.setMatrixAt(i, fd.matrix);

    if (rapierWorld) {
      rapierWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(BRIDGE_W / 2, BRIDGE_H / 2, BRIDGE_D / 2)
          .setTranslation(bx, by, bz)
          .setRotation({ x: _qFn.x, y: _qFn.y, z: _qFn.z, w: _qFn.w })
      );
    }
  }
  floorIM.instanceMatrix.needsUpdate = true;
  scene.add(floorIM);

  // ── Almenas (merlones) en los bordes — cada 2 bloques, igual que castillo ──
  const MERL_W = 1.3, MERL_H = 2.2, MERL_D = 1.6;
  const railOff = (BRIDGE_W - MERL_W) * 0.5;
  const merlPerSide = Math.ceil(N / 2);
  const merlIM = new THREE.InstancedMesh(rockGeo, rockMat, merlPerSide * 2);
  merlIM.castShadow = merlIM.receiveShadow = true;
  const rd = new THREE.Object3D();
  let ri = 0;

  for (const side of [-1, 1]) {
    for (let i = 0; i < N; i += 2) {
      const f   = (i + 0.5) / N;
      const bx  = startX + (endX - startX) * f + px * railOff * side;
      const bz  = startZ + (endZ - startZ) * f + pz * railOff * side;
      const sa  = archSlope(f);
      const top = archY(f);
      const by  = top + MERL_H * 0.5;

      _qXt.setFromAxisAngle(_axX, sa);
      _qFn.copy(_qYb).multiply(_qXt);

      rd.position.set(bx, by, bz);
      rd.quaternion.copy(_qFn);
      rd.scale.set(MERL_W / 0.68, MERL_H / 1.02, MERL_D / 0.68);
      rd.updateMatrix();
      if (ri < merlIM.count) merlIM.setMatrixAt(ri++, rd.matrix);
    }
  }
  merlIM.instanceMatrix.needsUpdate = true;
  scene.add(merlIM);
}

function spawnCastleTowers() {
  const TOW_LAYERS = 12;
  const ROCKS_RING = 24;                         // más bloques → sin huecos visibles
  const towerR  = TILE * 1.3;
  const WALL_D  = TILE * 0.55;
  const BLOCK_H = TILE * 0.52;
  const segAngle = (2 * Math.PI) / ROCKS_RING;
  const outerR  = towerR + WALL_D / 2;
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x2a4020, flatShading: true });
  const merMat  = new THREE.MeshLambertMaterial({ color: 0x5a3828, flatShading: true });

  // SX basado en arco exterior para que los bloques se toquen sin huecos por fuera
  const arcW = outerR * segAngle;
  const SX = arcW    / 0.68;
  const SY = BLOCK_H / 1.02;
  const SZ = WALL_D  / 0.68;

  // Torres alejadas del cuerpo principal del castillo
  const CASTLE_CX = 31 * TILE + TILE * 0.5;
  const CASTLE_CZ = 17 * TILE + TILE * 0.5;
  const positions = [
    { tx: 17, tz: 24 }, // SW — fuera del foso
    { tx: 44, tz: 24 }, // SE — fuera del foso
  ];

  // Puerta: bloques eliminados en los primeros pisos (×2 respecto a ROCKS_RING=12)
  const DOOR_SEGS   = 4;   // mantiene mismo ángulo de apertura que antes
  const DOOR_LAYERS = 3;
  // Ventana mirando al castillo en los últimos pisos (sobre el techo del castillo)
  const WIN_LAYERS_START = 10;
  const WIN_LAYERS_END   = 12;
  const WIN_SEGS    = 4;

  const bodyInst = positions.length * TOW_LAYERS * ROCKS_RING;
  const merlInst = positions.length * ROCKS_RING;
  const bIM = new THREE.InstancedMesh(rockGeo, rockMat, bodyInst);
  const mIM = new THREE.InstancedMesh(rockGeo, merMat, merlInst);
  bIM.castShadow = bIM.receiveShadow = true;
  mIM.castShadow = mIM.receiveShadow = true;
  const td = new THREE.Object3D();
  let bIdx = 0, mIdx = 0;

  positions.forEach(({ tx, tz }) => {
    const wx = tx * TILE + TILE * 0.5;
    const wz = tz * TILE + TILE * 0.5;
    const bh = groundAt(wx, wz);
    const towerTop = bh + BLOCK_H * TOW_LAYERS;

    // Ángulo de la puerta apuntando hacia el castillo
    const doorAngle = Math.atan2(CASTLE_CZ - wz, CASTLE_CX - wx);

    for (let ly = 0; ly < TOW_LAYERS; ly++) {
      const stagger = (ly & 1) ? segAngle * 0.5 : 0;
      for (let ri = 0; ri < ROCKS_RING; ri++) {
        const a = ri * segAngle + stagger;

        // Hueco de puerta: los DOOR_SEGS bloques más cercanos al doorAngle
        // se eliminan en los DOOR_LAYERS primeros pisos
        if (ly < DOOR_LAYERS) {
          let diff = Math.abs(a - doorAngle);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff < segAngle * (DOOR_SEGS / 2 + 0.3)) {
            td.scale.setScalar(0); td.updateMatrix();
            bIM.setMatrixAt(bIdx++, td.matrix);
            continue;
          }
        }

        // Ventana superior mirando al castillo — misma dirección que la puerta
        if (ly >= WIN_LAYERS_START && ly < WIN_LAYERS_END) {
          const windowAngle = doorAngle;
          let diff = Math.abs(a - windowAngle);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff < segAngle * (WIN_SEGS / 2 + 0.3)) {
            td.scale.setScalar(0); td.updateMatrix();
            bIM.setMatrixAt(bIdx++, td.matrix);
            continue;
          }
        }

        td.position.set(
          wx + Math.cos(a) * towerR,
          bh + BLOCK_H * (ly + 0.5),
          wz + Math.sin(a) * towerR
        );
        td.rotation.set(0, -(Math.PI / 2 + a), 0);
        td.scale.set(SX, SY, SZ);
        td.updateMatrix();
        bIM.setMatrixAt(bIdx++, td.matrix);

        // Collider físico para este bloque
        if (rapierWorld) {
          rapierWorld.createCollider(
            RAPIER.ColliderDesc.cuboid(arcW / 2, BLOCK_H / 2, WALL_D / 2)
              .setTranslation(
                wx + Math.cos(a) * towerR,
                bh + BLOCK_H * (ly + 0.5),
                wz + Math.sin(a) * towerR
              )
              .setRotation(_yRotQuat(-(Math.PI / 2 + a)))
          );
        }
      }
    }

    // Almenas
    const merSY = (BLOCK_H * 1.5) / 1.02;
    for (let ri = 0; ri < ROCKS_RING; ri++) {
      if (ri % 2 !== 0) {
        td.scale.setScalar(0); td.updateMatrix();
        mIM.setMatrixAt(mIdx++, td.matrix);
        continue;
      }
      const a = ri * segAngle;
      td.position.set(
        wx + Math.cos(a) * towerR,
        towerTop + BLOCK_H * 1.5 * 0.5,
        wz + Math.sin(a) * towerR
      );
      td.rotation.set(0, -(Math.PI / 2 + a), 0);
      td.scale.set(SX, merSY, SZ);
      td.updateMatrix();
      mIM.setMatrixAt(mIdx++, td.matrix);
    }

    // Colliders físicos del muro (ya fueron creados bloque a bloque en el loop de arriba)
    // (los bloques con scale=0 no tienen collider — ver loop principal)

    // Techo cónico
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(outerR * 1.05, BLOCK_H * 7, 10),
      roofMat
    );
    cone.position.set(wx, towerTop + BLOCK_H * 3.5, wz);
    cone.castShadow = true;
    scene.add(cone);
  });

  bIM.instanceMatrix.needsUpdate = true;
  mIM.instanceMatrix.needsUpdate = true;
  scene.add(bIM);
  scene.add(mIM);
}

// ─────────────────────────────────────────────────────────────
// SISTEMA DE CHUNKS — MUNDO INFINITO PROCEDURAL
// ─────────────────────────────────────────────────────────────

// ── Altura global continua (coordenadas de tile globales) ─────────────────
// Usa SOLO coordenadas globales → idéntica en todo chunk → sin costuras
function _globalH(gx, gz) {
  // Escala grande: define zonas de montaña / llanura / desierto
  const nC = fbm(gx / 55, gz / 55, 4, worldSeed + 111); // 0-1 formas continentales
  // Escala media: colinas y valles
  const nM = fbm(gx / 18, gz / 18, 4, worldSeed + 222); // 0-1
  // Escala fina: detalle local
  const nF = fbm(gx / 7,  gz / 7,  3, worldSeed + 333); // 0-1

  // Máscara de montañas — transición suave
  const mW = Math.max(0, Math.min(1, (nC - 0.50) / 0.22));
  // Máscara de desierto (excluye zonas de montaña)
  const dN = fbm(gx / 70, gz / 70, 2, worldSeed + 444);
  const dW = Math.max(0, Math.min(1, (dN - 0.62) / 0.20)) * (1 - mW);

  const hFlat = nM * 13 + nF * 5;          // llanura ondulada  0–18 m
  const hDune = 1  + nM * 11 + nF * 6;     // dunas              1–18 m
  const hMtn  = 12 + nC * 72 + nM * 30;    // montañas          12–114 m

  return hFlat * (1 - mW - dW) + hDune * dW + hMtn * mW;
}

// ── Tipo de tile a partir de coordenadas globales y altura ────────────────
function _globalTile(gx, gz, h) {
  const nF    = fbm(gx / 7,  gz / 7,  3, worldSeed + 333);
  const dN    = fbm(gx / 70, gz / 70, 2, worldSeed + 444);
  const dW    = Math.max(0, Math.min(1, (dN - 0.62) / 0.20));
  const swN   = fbm(gx / 45, gz / 45, 2, worldSeed + 555);
  const swW   = Math.max(0, Math.min(1, (swN - 0.66) / 0.16));
  const frstN = fbm(gx / 22, gz / 22, 2, worldSeed + 666);

  // Lagos: cuencas bajas con ruido de baja frecuencia
  const lakeN = fbm(gx / 32, gz / 32, 2, worldSeed + 888);
  if (lakeN < 0.22 && h < 13 && dW < 0.2) return T.WATER;

  // Ríos: bandas estrechas serpenteantes en tierra baja
  const riverN = fbm(gx / 30, gz / 30, 3, worldSeed + 777);
  if (Math.abs(riverN - 0.50) < 0.020 && h < 20 && dW < 0.15) return T.WATER;

  if (h < 0.4 || nF < 0.055) return T.WATER;
  if (h > 30)  return T.MOUND;
  if (dW > 0.35)              return T.SAND;
  if (swW > 0.4 && h < 9)    return T.FOREST; // ciénaga
  if (frstN > 0.52)           return T.FOREST;
  return T.GRASS;
}

// ── Etiqueta de bioma por chunk (solo para densidad de árboles) ───────────
function _chunkBiome(cx, cz) {
  if (cx === 0 && cz === 0) return 'home';
  const gx = cx * WORLD + WORLD / 2, gz = cz * WORLD + WORLD / 2;
  const nC = fbm(gx / 55, gz / 55, 4, worldSeed + 111);
  const mW = Math.max(0, Math.min(1, (nC - 0.50) / 0.22));
  if (mW > 0.4) return 'mountains';
  const dN = fbm(gx / 70, gz / 70, 2, worldSeed + 444);
  if (dN > 0.62) return 'desert';
  const swN = fbm(gx / 45, gz / 45, 2, worldSeed + 555);
  if (swN > 0.66) return 'swamp';
  const frstN = fbm(gx / 22, gz / 22, 2, worldSeed + 666);
  if (frstN > 0.58) return 'forest';
  return 'plains';
}

// ── Erosión hidráulica — simula gotas de lluvia sobre el heightmap ────────
function _hydraulicErosion(hmap, map, W) {
  const DROPS = 90, STEPS = 55;
  const INERTIA = 0.08, DEPOSIT = 0.32, ERODE = 0.26, EVAP = 0.018;
  for (let d = 0; d < DROPS; d++) {
    let px = 1 + Math.random() * (W - 3);
    let pz = 1 + Math.random() * (W - 3);
    let vx = 0, vz = 0, water = 1, sed = 0;
    for (let s = 0; s < STEPS; s++) {
      const ix = Math.floor(px), iz = Math.floor(pz);
      if (ix < 1 || ix >= W - 1 || iz < 1 || iz >= W - 1) break;
      if (map[iz][ix] === T.WATER) break;
      // Gradiente por diferencias centradas
      const gxg = (hmap[iz][ix + 1] - hmap[iz][ix - 1]) * 0.5;
      const gzg = (hmap[iz + 1][ix] - hmap[iz - 1][ix]) * 0.5;
      vx = vx * INERTIA - gxg * (1 - INERTIA);
      vz = vz * INERTIA - gzg * (1 - INERTIA);
      const len = Math.sqrt(vx * vx + vz * vz) || 1;
      vx /= len; vz /= len;
      const nx = px + vx, nz = pz + vz;
      const nix = Math.floor(nx), niz = Math.floor(nz);
      if (nix < 1 || nix >= W - 1 || niz < 1 || niz >= W - 1) break;
      const dh = hmap[niz][nix] - hmap[iz][ix];
      const speed = Math.sqrt(vx * vx + vz * vz);
      const cap = Math.max(0.01, -dh) * speed * water;
      if (dh > 0) {
        // subiendo: depositar sedimento
        const dep = Math.min(sed, dh * 0.5);
        hmap[iz][ix] += dep; sed -= dep;
      } else if (sed > cap) {
        const dep = (sed - cap) * DEPOSIT;
        hmap[iz][ix] += dep; sed -= dep;
      } else {
        const ero = Math.min((cap - sed) * ERODE, -dh * 0.45);
        hmap[iz][ix] = Math.max(0, hmap[iz][ix] - ero); sed += ero;
      }
      water *= (1 - EVAP);
      if (water < 0.02) break;
      px = nx; pz = nz;
    }
  }
}

function generateChunkData(cx, cz) {
  const biome = _chunkBiome(cx, cz);
  const map  = Array.from({length: WORLD}, () => new Array(WORLD).fill(T.GRASS));
  const hmap = Array.from({length: WORLD}, () => new Array(WORLD).fill(0));

  for (let z = 0; z < WORLD; z++) {
    for (let x = 0; x < WORLD; x++) {
      const gx = cx * WORLD + x, gz = cz * WORLD + z;
      const h  = _globalH(gx, gz);
      const t  = _globalTile(gx, gz, h);
      map[z][x]  = t;
      hmap[z][x] = (t === T.WATER) ? 0 : Math.max(0, h);
    }
  }
  // Gaussian blur — 1 paso (preserva picos de montaña)
  const bl = hmap.map(r => [...r]);
  for (let z = 1; z < WORLD - 1; z++) for (let x = 1; x < WORLD - 1; x++) {
    if (map[z][x] === T.WATER) continue;
    let sum = 0, w = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (map[z+dz][x+dx] === T.WATER) continue;
      const wt = (dz===0&&dx===0)?4:(dz===0||dx===0)?2:1;
      sum += hmap[z+dz][x+dx]*wt; w += wt;
    }
    bl[z][x] = sum / w;
  }
  for (let z = 0; z < WORLD; z++) for (let x = 0; x < WORLD; x++) hmap[z][x] = bl[z][x];
  // Erosión hidráulica
  _hydraulicErosion(hmap, map, WORLD);
  return { map, hmap, biome, mesh: null, collider: null, trees: [] };
}

function buildChunkMesh(cx, cz) {
  const chunk = chunkMap.get(`${cx},${cz}`);
  if (!chunk || chunk.mesh) return;

  // Pre-generar datos de los 8 vecinos para que las costuras del borde queden a la misma altura
  for (let dcz=-1;dcz<=1;dcz++) for (let dcx=-1;dcx<=1;dcx++) {
    if (!dcx&&!dcz) continue;
    const nk=`${cx+dcx},${cz+dcz}`;
    if (!chunkMap.has(nk)) {
      const ncx=cx+dcx, ncz=cz+dcz;
      chunkMap.set(nk, (ncx===0&&ncz===0)
        ? {map:worldMap,hmap:heightMap,mesh:null,collider:null,trees:[],biome:'home'}
        : generateChunkData(ncx,ncz));
    }
  }

  const offsetX = cx * WORLD * TILE, offsetZ = cz * WORLD * TILE;
  const V = WORLD + 1;
  const positions = new Float32Array(V * V * 3);
  const colors    = new Float32Array(V * V * 3);
  const idxArr    = new Uint32Array(WORLD * WORLD * 6);
  let ii = 0;

  for (let iz = 0; iz < V; iz++) {
    for (let ix = 0; ix < V; ix++) {
      const vi  = iz * V + ix;
      const gx  = cx * WORLD + ix, gz = cz * WORLD + iz;
      const h   = worldVertexH(gx, gz);
      let sr=0, sg=0, sb=0, cnt=0;
      for (const [dz,dx] of [[-1,-1],[-1,0],[0,-1],[0,0]]) {
        const tgx=gx+dx, tgz=gz+dz;
        const tcx=Math.floor(tgx/WORLD), tcz=Math.floor(tgz/WORLD);
        const tx=tgx-tcx*WORLD, tz=tgz-tcz*WORLD;
        if (tx<0||tx>=WORLD||tz<0||tz>=WORLD) continue;
        const ch2 = chunkMap.get(`${tcx},${tcz}`);
        if (!ch2) continue;
        const t = ch2.map[tz]?.[tx] ?? T.GRASS;
        const mh = ch2.hmap[tz]?.[tx] ?? 0;
        let [r,g,b] = hexToRgb(BIOME_HEX[t] ?? COLOR.GRASS);
        if (t===T.MOUND && mh>15) { const s=Math.min((mh-15)/7,1); r+=(0.92-r)*s; g+=(0.96-g)*s; b+=(1.0-b)*s; }
        sr+=r; sg+=g; sb+=b; cnt++;
      }
      if (!cnt){sr=0.3;sg=0.65;sb=0.3;cnt=1;}
      positions[vi*3]=offsetX+ix*TILE; positions[vi*3+1]=h; positions[vi*3+2]=offsetZ+iz*TILE;
      colors[vi*3]=sr/cnt; colors[vi*3+1]=sg/cnt; colors[vi*3+2]=sb/cnt;
    }
  }
  for (let iz=0;iz<WORLD;iz++) for (let ix=0;ix<WORLD;ix++) {
    const tl=iz*V+ix,tr=tl+1,bl=tl+V,br=bl+1;
    idxArr[ii++]=tl;idxArr[ii++]=bl;idxArr[ii++]=tr;
    idxArr[ii++]=tr;idxArr[ii++]=bl;idxArr[ii++]=br;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors,3));
  geo.setIndex(new THREE.BufferAttribute(idxArr,1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({vertexColors:true}));
  mesh.receiveShadow = true;
  scene.add(mesh);
  chunk.mesh = mesh;
  if (rapierWorld) {
    chunk.collider = rapierWorld.createCollider(RAPIER.ColliderDesc.trimesh(positions, idxArr));
  }
  // Trees
  _buildChunkTrees(cx, cz, chunk, offsetX, offsetZ);
}

function _buildChunkTrees(cx, cz, chunk, offsetX, offsetZ) {
  // Chunk 0,0 ya tiene árboles colocados en buildScene — evitar duplicados
  if (cx === 0 && cz === 0) return;

  const forestList=[], grassList=[], snowList=[], cactusList=[];
  const offs = [[0.15,0.15],[0.6,0.2],[0.25,0.65],[-0.1,0.45]];
  for (let z=0;z<WORLD;z++) for (let x=0;x<WORLD;x++) {
    const t  = chunk.map[z][x];
    const h  = chunk.hmap[z][x];
    const gx = cx*WORLD+x, gz = cz*WORLD+z;
    if (t === T.FOREST) {
      for (let ti=0;ti<4;ti++)
        if (hash(gx*3+ti*13,gz*3+ti*17,worldSeed+33+ti*7)>0.12)
          forestList.push([x+offs[ti][0], z+offs[ti][1]]);
    } else if (t === T.MOUND && h > 20 && hash(gx,gz,worldSeed+21)>0.30) {
      // Árboles nevados en montañas altas
      for (let ti=0;ti<2;ti++)
        if (hash(gx*3+ti*13,gz*3+ti*17,worldSeed+77+ti*7)>0.22)
          snowList.push([x+offs[ti][0], z+offs[ti][1]]);
    } else if (t === T.GRASS && hash(gx,gz,worldSeed+44)>0.60) {
      grassList.push([x+0.5, z+0.5]);
    } else if (t === T.SAND && hash(gx,gz,worldSeed+88)>0.83) {
      // Cactus en desierto (poco densos)
      cactusList.push([x+0.5, z+0.5]);
    }
  }

  // [lista, índice treePartsList, escala base, rango escala]
  const groups = [
    [forestList, 0, 3.2, 3.5],
    [grassList,  1, 2.5, 2.0],
    [snowList,   2, 3.0, 3.0],
    [cactusList, 3, 1.4, 1.0],
  ];
  for (const [list, mi, scBase, scRange] of groups) {
    if (!list.length || !treePartsList[mi]) continue;
    const parts = treePartsList[mi][1];
    for (const {geo,mat} of parts) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      // Sin sombras en árboles de chunks — demasiado caro con miles de instancias
      const td = new THREE.Object3D();
      list.forEach(([lx,lz],i) => {
        const wx = offsetX+lx*TILE, wz = offsetZ+lz*TILE;
        const gy = groundAt(wx,wz);
        const sc = scBase + hash(cx*WORLD+Math.floor(lx), cz*WORLD+Math.floor(lz), worldSeed+55) * scRange;
        td.position.set(wx,gy,wz); td.scale.setScalar(sc);
        td.rotation.y = hash(cx*WORLD+Math.floor(lx), cz*WORLD+Math.floor(lz), worldSeed+66) * Math.PI*2;
        td.updateMatrix(); im.setMatrixAt(i,td.matrix);
      });
      im.instanceMatrix.needsUpdate=true; scene.add(im); chunk.trees.push(im);
    }
  }
}

function unloadChunk(cx, cz) {
  if (cx===0&&cz===0) return;
  const ch=chunkMap.get(`${cx},${cz}`); if (!ch) return;
  if (ch.mesh){ scene.remove(ch.mesh); ch.mesh.geometry.dispose(); ch.mesh=null; }
  if (ch.collider&&rapierWorld){ rapierWorld.removeCollider(ch.collider,false); ch.collider=null; }
  ch.trees.forEach(im=>{scene.remove(im); im.geometry?.dispose();});
  ch.trees=[];
  chunkMap.delete(`${cx},${cz}`);
}

function updateChunks() {
  const px=rig.position.x, pz=rig.position.z;
  const pcx=Math.floor(px/(WORLD*TILE)), pcz=Math.floor(pz/(WORLD*TILE));
  for (let dcz=-CHUNK_R;dcz<=CHUNK_R;dcz++) for (let dcx=-CHUNK_R;dcx<=CHUNK_R;dcx++) {
    const cx=pcx+dcx, cz=pcz+dcz;
    const key=`${cx},${cz}`;
    if (!chunkMap.has(key)) {
      chunkMap.set(key, cx===0&&cz===0
        ? {map:worldMap,hmap:heightMap,mesh:null,collider:null,trees:[],biome:'home'}
        : generateChunkData(cx,cz));
    }
    // Encolar si aún no tiene mesh y no está ya en la cola
    const ch = chunkMap.get(key);
    if (!ch.mesh && !_chunkBuildQ.find(q=>q.key===key)) {
      _chunkBuildQ.push({ key, cx, cz, dist: Math.abs(dcx)+Math.abs(dcz) });
    }
  }
  // Ordenar por distancia al jugador (los más cercanos primero)
  _chunkBuildQ.sort((a,b)=>a.dist-b.dist);
  // Unload far chunks
  for (const key of [...chunkMap.keys()]) {
    const [cx,cz]=key.split(',').map(Number);
    if (cx===0&&cz===0) continue;
    if (Math.abs(cx-pcx)>CHUNK_R+1||Math.abs(cz-pcz)>CHUNK_R+1) {
      const qi=_chunkBuildQ.findIndex(q=>q.key===key);
      if (qi>=0) _chunkBuildQ.splice(qi,1);
      unloadChunk(cx,cz);
    }
  }
}

function spawnVillage() {
  const VCX = VILLAGE_CX * TILE + TILE / 2; // centro mundo X
  const VCZ = VILLAGE_CZ * TILE + TILE / 2; // centro mundo Z
  const wallWorldR = VILLAGE_WALL_R * TILE * 0.8; // radio del muro (−20%)

  // ── Muro circular — 3 capas apiladas, sin huecos ─────────────
  // Cada bloque: 2.5m ancho × 1.8m alto × 1.8m fondo
  const WALL_W = 2.5, LAYER_H = 1.8, WALL_D = 1.8;
  const WALL_LAYERS = 3;
  const SX = WALL_W / 0.68;
  const SY = LAYER_H / 1.02;
  const SZ = WALL_D / 0.68;

  // N_SEGS: cubrir el perímetro exactamente (leve solapado del 5%)
  const N_SEGS = Math.ceil((2 * Math.PI * wallWorldR) / (WALL_W * 0.95));
  const wallAngles = [];
  for (let i = 0; i < N_SEGS; i++) {
    const angle = (i / N_SEGS) * Math.PI * 2;
    const nearEnt = VILLAGE_ENT_ANGLES.some(ea => {
      let d = Math.abs(angle - ea);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d < VILLAGE_ENT_HALF;
    });
    if (!nearEnt) wallAngles.push(angle);
  }

  const totalWallInst = wallAngles.length * WALL_LAYERS;
  const wIM = new THREE.InstancedMesh(rockGeo, rockMat, totalWallInst);
  wIM.castShadow = wIM.receiveShadow = true;
  const wd = new THREE.Object3D();
  let wIdx = 0;
  wallAngles.forEach(angle => {
    const wx = VCX + wallWorldR * Math.cos(angle);
    const wz = VCZ + wallWorldR * Math.sin(angle);
    const baseH = groundAt(wx, wz);
    for (let ly = 0; ly < WALL_LAYERS; ly++) {
      wd.position.set(wx, baseH + LAYER_H * (ly + 0.5), wz);
      // Rotación correcta: eje local X apunta en dirección tangente (-sin a, 0, cos a)
      wd.rotation.set(0, -(Math.PI / 2 + angle), 0);
      wd.scale.set(SX, SY, SZ);
      wd.updateMatrix();
      wIM.setMatrixAt(wIdx++, wd.matrix);

      // Solo primera capa para colisión (capas superiores no son accesibles)
      if (rapierWorld && ly === 0) {
        rapierWorld.createCollider(
          RAPIER.ColliderDesc.cuboid(WALL_W / 2, LAYER_H * WALL_LAYERS / 2, WALL_D / 2)
            .setTranslation(wx, baseH + LAYER_H * WALL_LAYERS / 2, wz)
            .setRotation(_yRotQuat(-(Math.PI / 2 + angle)))
        );
      }
    }
  });
  wIM.instanceMatrix.needsUpdate = true;
  scene.add(wIM);

  // ── Almenas (merlones) en la cima del muro circular ──────────
  // Cada 2 segmentos: uno lleva merlón, el siguiente está vacío → aspecto de almena
  const MERL_H  = LAYER_H * 1.35;   // más alto que un bloque normal
  const MERL_W  = WALL_W * 0.65;    // más estrecho → hueco visible entre almenas
  const topY_base = WALL_LAYERS * LAYER_H; // altura de la cima del muro
  const mSX = MERL_W / 0.68, mSY = MERL_H / 1.02, mSZ = (WALL_D * 0.85) / 0.68;

  // Contar merlones (solo índices pares del array wallAngles)
  const merlonAngles = wallAngles.filter((_, i) => i % 2 === 0);
  if (merlonAngles.length > 0) {
    const merIM = new THREE.InstancedMesh(rockGeo, rockMat, merlonAngles.length);
    merIM.castShadow = true;
    const md = new THREE.Object3D();
    merlonAngles.forEach((angle, mi) => {
      const mx = VCX + wallWorldR * Math.cos(angle);
      const mz = VCZ + wallWorldR * Math.sin(angle);
      const mBaseH = groundAt(mx, mz);
      md.position.set(mx, mBaseH + topY_base + MERL_H * 0.5, mz);
      md.rotation.set(0, -(Math.PI / 2 + angle), 0);
      md.scale.set(mSX, mSY, mSZ);
      md.updateMatrix();
      merIM.setMatrixAt(mi, md.matrix);
    });
    merIM.instanceMatrix.needsUpdate = true;
    scene.add(merIM);
  }

  // ── Fuente en el centro de la plaza ─────────────────────────
  const fy = groundAt(VCX, VCZ);
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x999999, flatShading: true });
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x29b6e8, emissive: 0x0055aa, emissiveIntensity: 0.4 });
  const jetMat   = new THREE.MeshLambertMaterial({ color: 0x55ccff, transparent: true, opacity: 0.60 });

  const fbase = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.5, 0.5, 14), stoneMat);
  fbase.position.set(VCX, fy + 0.25, VCZ); fbase.castShadow = true; scene.add(fbase);

  const fwater = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 0.32, 14), waterMat);
  fwater.position.set(VCX, fy + 0.66, VCZ); scene.add(fwater);

  const fcol = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.3, 8), stoneMat);
  fcol.position.set(VCX, fy + 1.15, VCZ); fcol.castShadow = true; scene.add(fcol);

  // Chorro (cono invertido — ancho arriba, estrecho abajo)
  const fjet = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.05, 1.0, 8), jetMat);
  fjet.position.set(VCX, fy + 2.15, VCZ); scene.add(fjet);

  // ── Carteles en las 3 entradas ──────────────────────────────
  const signTex    = _makeSignTex();
  const signPostMat = new THREE.MeshLambertMaterial({ color: 0x5a3518 });
  const boardMat   = new THREE.MeshBasicMaterial({ map: signTex });
  const postGeo    = new THREE.CylinderGeometry(0.07, 0.10, 2.0, 6); // 2m — sin solapar tablero
  const boardGeo   = new THREE.BoxGeometry(2.4, 0.75, 0.12);

  function makeSign(wx, wz, rotY) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(postGeo, signPostMat);
    post.position.y = 1.0; // base 0 → tope 2m
    g.add(post);
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.position.y = 2.48; // 2m + 0.375 (mitad) + 0.1 margen
    g.add(board);
    g.position.set(wx, groundAt(wx, wz), wz);
    g.rotation.y = rotY;
    scene.add(g);
  }

  const signR = wallWorldR + 2.5; // ligeramente fuera del muro
  VILLAGE_ENT_ANGLES.forEach(ea => {
    makeSign(VCX + signR * Math.cos(ea), VCZ + signR * Math.sin(ea), ea);
  });
}

function updateNPCs(dt) {
  const px = rig.position.x, pz = rig.position.z;

  // VR: gatillo derecho (right trigger = buttons[0]) para aceptar/cerrar diálogo
  // No usar A/X (buttons[4]) — queda cerca del thumbstick y causa conflictos
  let vrAPressed = false;
  const _sess = renderer.xr.getSession();
  if (_sess?.inputSources) {
    for (const s of _sess.inputSources) {
      if (s.handedness === 'right' && s.gamepad?.buttons[0]?.pressed) vrAPressed = true;
    }
  }
  if (vrAPressed && !_vrAWas && dialogNPC) {
    const n = dialogNPC;
    if (activeQuestId !== n.questId && !questComplete) acceptQuest(n);
    else closeDialog();
  }
  _vrAWas = vrAPressed;

  npcs.forEach(n => {
    // Bob idle
    n.body.position.y = 0.85 + Math.sin(elapsed * 1.5 + n.bobPhase) * 0.05;

    // Rotate toward player when close (mejora #18), otherwise slow idle spin
    const dx = px - n.wx, dz = pz - n.wz;
    const dist = Math.hypot(dx, dz);
    if (dist < 5) {
      // Face player
      const targetY = Math.atan2(dx, dz);
      n.mesh.rotation.y += (targetY - n.mesh.rotation.y) * Math.min(1, dt * 4);
    } else {
      n.mesh.rotation.y += dt * 0.4;
    }

    // Indicator bob
    n.indicator.visible = dist < 5;
    n.indicator.position.y = 2.1 + Math.sin(elapsed * 3 + n.bobPhase) * 0.12;

    // Auto open dialog on proximity
    if (dist < 3 && !dialogNPC) openDialog(n);
    else if (dist > 5 && dialogNPC === n) closeDialog();
  });

  // Survive quest (quest #4)
  if (activeQuestId === 4 && !questComplete) {
    const nearEnemy = enemies.some(e => !e.dead && Math.hypot(
      e.mesh.position.x - px, e.mesh.position.z - pz) < 10);
    if (nearEnemy) {
      surviveTimer += dt;
      questProgress = Math.floor(surviveTimer);
      updateQuestHUD();
      if (surviveTimer >= 60) { questComplete = true; updateQuestHUD(); }
    }
  }

  // Health regen (mejora #9): sin daño por 15s → +1HP cada 8s
  if (playerHP > 0 && playerHP < 5) {
    const timeSinceDmg = elapsed - lastDamageTime;
    if (timeSinceDmg > 15) {
      regenTimer += dt;
      if (regenTimer >= 8) {
        regenTimer = 0;
        playerHP = Math.min(5, playerHP + 1);
        updateHPBar();
        sfx.heartPickup();
      }
    } else {
      regenTimer = 0;
    }
  }

  // Combo timer decay (mejora #15)
  if (comboTimer > 0) {
    comboTimer -= dt;
    if (comboTimer <= 0) {
      comboCount = 0;
      if (comboEl) comboEl.style.display = 'none';
    }
  }

  // Alert icons update (mejora #8)
  for (let i = enemyAlertList.length - 1; i >= 0; i--) {
    const a = enemyAlertList[i];
    a.timer -= dt;
    if (a.timer <= 0) {
      scene.remove(a.mesh);
      enemyAlertList.splice(i, 1);
    } else {
      a.mesh.position.y += dt * 0.8;
      a.mesh.material.opacity = a.timer / 0.8;
    }
  }

  // Death particles (mejora #14)
  for (let i = dmgParticles.length - 1; i >= 0; i--) {
    const p = dmgParticles[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.mesh); dmgParticles.splice(i, 1); continue; }
    p.vy -= 6 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.material.opacity = p.life / 0.5;
  }

  // Rock particles (mejora #19)
  for (let i = rockParticles.length - 1; i >= 0; i--) {
    const p = rockParticles[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.mesh); rockParticles.splice(i, 1); continue; }
    p.vy -= 4 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.material.opacity = p.life / 0.6;
  }

  // Fireflies (mejora #12)
  for (const ff of fireflyList) {
    ff.mesh.position.y = ff.baseY + Math.sin(elapsed * 1.8 + ff.phase) * 0.4;
    ff.mesh.position.x = ff.wx   + Math.sin(elapsed * 1.2 + ff.phase + 1) * 0.5;
    ff.mesh.position.z = ff.wz   + Math.cos(elapsed * 1.0 + ff.phase) * 0.5;
    // Solo visible de noche
    const isNight = dayTime < 0.25 || dayTime > 0.75;
    ff.mesh.visible = isNight;
  }

  // Player shadow update — se achica al saltar, siempre en el suelo
  if (playerShadow) {
    const groundY = groundAt(rig.position.x, rig.position.z);
    const airH    = Math.max(0, rig.position.y - groundY);
    const sScale  = Math.max(0.15, 1 - airH * 0.025);
    playerShadow.position.set(rig.position.x, groundY + 0.02, rig.position.z);
    playerShadow.scale.setScalar(sScale);
    playerShadow.material.opacity = sScale * 0.3;
  }
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
async function initGame() {
  await initPhysics();
  generateMap();
  addTerrainCollider();
  addWallColliders();
  // Inicializar chunk raíz ANTES de buildScene para que groundAt() funcione
  chunkMap.set('0,0', { map: worldMap, hmap: heightMap, mesh: null, collider: null, trees: [], biome: 'home' });
  buildScene();
  spawnPlayer();
  // Sincronizar posición inicial del jugador con Rapier (+5m extra para que caiga sobre el suelo)
  playerBody.setTranslation({ x: rig.position.x, y: rig.position.y + CAPS_OFFSET + 5, z: rig.position.z }, true);
  spawnEnemies();
  spawnPushRocks();
  spawnRockTowers();
  spawnDragons();
  spawnNPCs();
  spawnVillage();
  spawnCastleTowers();
  spawnCastleRoof();
  spawnCastleMaze();
  spawnBossSlime();
  spawnTowerDoor();
  spawnSpiralStairs();
  spawnBridge();
  buildMinimap();
  buildHUD();
  updateStarCounter();
  updateQuestHUD();

  // Pre-simular: dejar caer al jugador con gravedad hasta que toque el suelo
  document.getElementById('loading-msg').textContent = 'INICIANDO FÍSICA...';
  rapierWorld.timestep = 1 / 60;
  let _preVY = 0;
  for (let i = 0; i < 300; i++) {
    _preVY -= GRAVITY * (1 / 60);
    const _prePos = playerBody.translation();
    charCtrl.computeColliderMovement(
      playerCollider,
      { x: 0, y: _preVY * (1 / 60), z: 0 },
      true, null, col => col !== playerCollider
    );
    const _cm = charCtrl.computedMovement();
    playerBody.setNextKinematicTranslation({
      x: _prePos.x, y: _prePos.y + _cm.y, z: _prePos.z
    });
    rapierWorld.step();
    if (charCtrl.computedGrounded()) break;
  }
  // Sincronizar rig con posición final del cuerpo
  const settled = playerBody.translation();
  rig.position.x = settled.x;
  rig.position.z = settled.z;
  rig.position.y = settled.y - CAPS_OFFSET;

  updateChunks();

  gameReady = true;
  const loadDiv = document.getElementById('loading');
  if (loadDiv) loadDiv.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// GENERADOR PROCEDURAL DE ROCAS — textura canvas + geometría jittered
// ─────────────────────────────────────────────────────────────

// Textura de roca pintada en canvas: base cálida + manchas + grano fino
function _makeRockTex() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const cl = v => Math.min(255, Math.max(0, Math.round(v)));
  // Base gris-marrón cálido
  ctx.fillStyle = '#9a8870';
  ctx.fillRect(0, 0, S, S);
  // Manchas gruesas (variación de brillo)
  for (let i = 0; i < 55; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 4 + Math.random() * 11;
    const d = (Math.random() - 0.5) * 36;
    ctx.fillStyle = `rgb(${cl(154+d)},${cl(136+d*0.87)},${cl(112+d*0.72)})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Grano fino
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const d = (Math.random() - 0.5) * 20;
    ctx.fillStyle = `rgb(${cl(154+d)},${cl(136+d*0.87)},${cl(112+d*0.72)})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // Grietas — líneas oscuras finas
  for (let i = 0; i < 6; i++) {
    const x1 = Math.random() * S, y1 = Math.random() * S;
    const x2 = x1 + (Math.random() - 0.5) * 30, y2 = y1 + (Math.random() - 0.5) * 30;
    ctx.strokeStyle = `rgba(50,38,28,${0.25 + Math.random() * 0.30})`;
    ctx.lineWidth = 0.8 + Math.random() * 1.2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  return new THREE.CanvasTexture(cv);
}



// Geometría cúbica con esquinas jittered — sin grietas (misma esquina → mismo jitter)
function _makeRockGeo(seed) {
  const geo = new THREE.BoxGeometry(0.68, 1.02, 0.68, 1, 1, 1);
  const pos = geo.attributes.position;
  // Agrupar vértices por posición original (el box comparte esquinas entre caras)
  // y aplicar el mismo jitter a todos los vértices de la misma esquina
  const cornerMap = new Map();
  const jitters   = [];
  for (let v = 0; v < pos.count; v++) {
    const key = `${pos.getX(v).toFixed(3)},${pos.getY(v).toFixed(3)},${pos.getZ(v).toFixed(3)}`;
    if (!cornerMap.has(key)) {
      const ci = cornerMap.size;
      cornerMap.set(key, ci);
      jitters.push([
        (hash(seed + ci, 0, 1) - 0.5) * 0.05,
        (hash(seed + ci, 0, 2) - 0.5) * 0.04,
        (hash(seed + ci, 0, 3) - 0.5) * 0.05,
      ]);
    }
    const [jx, jy, jz] = jitters[cornerMap.get(key)];
    pos.setXYZ(v, pos.getX(v) + jx, pos.getY(v) + jy, pos.getZ(v) + jz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function _buildSnowTreeParts(seed, sizeClass = 1) {
  // Árbol nevado: copa oscura abajo, blanca/nevada arriba
  const trunkColors = [0x7a5530, 0x5a3518, 0x3d2010];
  const trunkMat = new THREE.MeshLambertMaterial({ color: trunkColors[sizeClass], flatShading: true });
  const leafMat  = new THREE.MeshLambertMaterial({ color: 0x1a4c1a, flatShading: true });
  const snowMat  = new THREE.MeshLambertMaterial({ color: 0xddeeff, flatShading: true });

  const trR  = [0.02, 0.03, 0.05][sizeClass];
  const trRB = [0.05, 0.09, 0.14][sizeClass];
  const trH  = [0.30, 0.45, 0.62][sizeClass];
  const trunkGeo = new THREE.CylinderGeometry(trR, trRB, trH, 5, 1);
  trunkGeo.translate(0, trH / 2, 0);

  const tierMin   = [2, 3, 4][sizeClass];
  const tierExtra = [1, 2, 2][sizeClass];
  const tiers = tierMin + Math.floor(hash(seed, 0, 1) * tierExtra);
  const rBase = [0.28, 0.44, 0.60][sizeClass];
  const rTop  = [0.07, 0.14, 0.22][sizeClass];

  const greenParts = [], snowParts = [];
  let ex = 0, ez = 0;
  for (let i = 0; i < tiers; i++) {
    const t   = i / tiers;
    const r   = rBase - t * (rBase - rTop);
    const h   = 0.36 + (hash(seed, i, 2) - 0.5) * 0.10;
    const y   = 0.32 + i * 0.22;
    const rot = i * Math.PI * 2 * 0.618;
    const seg = 5 + (i & 1);
    ex += (hash(seed, i, 14) - 0.5) * 0.04;
    ez += (hash(seed, i, 15) - 0.5) * 0.04;
    const cone = new THREE.ConeGeometry(r, h, seg, 1);
    cone.rotateY(rot);
    cone.translate(ex, y + h * 0.5, ez);
    if (i >= Math.floor(tiers * 0.5)) snowParts.push(cone);
    else greenParts.push(cone);
  }
  const result = [{ geo: trunkGeo, mat: trunkMat }];
  if (greenParts.length) result.push({ geo: mergeGeometries(greenParts), mat: leafMat });
  if (snowParts.length)  result.push({ geo: mergeGeometries(snowParts),  mat: snowMat });
  return result;
}

function _buildCactusParts(seed) {
  const mat = new THREE.MeshLambertMaterial({ color: 0x4a9a4a, flatShading: true });
  const trunkH = 0.6 + hash(seed, 1, 3) * 0.5; // 0.6 – 1.1

  // Tronco vertical
  const trunkGeo = new THREE.CylinderGeometry(0.07, 0.09, trunkH, 6, 1);
  trunkGeo.translate(0, trunkH / 2, 0);

  // Dos brazos: segmento horizontal + segmento vertical
  const armParts = [];
  for (let side = -1; side <= 1; side += 2) {
    const armLen = 0.22 + hash(seed, side + 5, 2) * 0.18;
    const armY   = trunkH * (0.38 + hash(seed, side + 3, 4) * 0.28);
    const vH     = trunkH * 0.38;
    // Horizontal
    const hArm = new THREE.CylinderGeometry(0.05, 0.06, armLen, 5, 1);
    hArm.rotateZ(Math.PI / 2);
    hArm.translate(side * armLen / 2, armY, 0);
    armParts.push(hArm);
    // Vertical (extremo del brazo)
    const vArm = new THREE.CylinderGeometry(0.04, 0.05, vH, 5, 1);
    vArm.translate(side * armLen, armY + vH / 2, 0);
    armParts.push(vArm);
  }
  const armsGeo = mergeGeometries(armParts);
  return [{ geo: trunkGeo, mat }, { geo: armsGeo, mat }];
}

// ─────────────────────────────────────────────────────────────
// GENERADOR PROCEDURAL DE PINOS LOW-POLY
// seed distinto → forma ligeramente diferente (tiers, radios, drift)
// ─────────────────────────────────────────────────────────────
function _buildTreeParts(seed, sizeClass = 1) {
  // sizeClass: 0=pequeño/esbelto/verde claro, 1=mediano, 2=grande/frondoso/verde oscuro
  const leafColors  = [0x7ec850, 0x2d8b2d, 0x1a4c1a];
  const trunkColors = [0x7a5530, 0x5a3518, 0x3d2010];
  const trunkMat = new THREE.MeshLambertMaterial({ color: trunkColors[sizeClass], flatShading: true });
  const leafMat  = new THREE.MeshLambertMaterial({ color: leafColors[sizeClass],  flatShading: true });

  // Tronco — más esbelto para pequeños, más grueso para grandes
  const trR  = [0.02, 0.03, 0.05][sizeClass];
  const trRB = [0.05, 0.09, 0.14][sizeClass];
  const trH  = [0.28, 0.42, 0.58][sizeClass];
  const trunkGeo = new THREE.CylinderGeometry(trR, trRB, trH, 5, 1);
  trunkGeo.translate(0, trH / 2, 0);

  // Copa — menos tiers y más estrecha para pequeños, más tiers y frondosa para grandes
  const tierMin   = [2, 3, 4][sizeClass];
  const tierExtra = [1, 2, 2][sizeClass];
  const tiers = tierMin + Math.floor(hash(seed, 0, 1) * tierExtra);
  const rBase = [0.30, 0.46, 0.62][sizeClass];
  const rTop  = [0.08, 0.16, 0.24][sizeClass];

  const coneParts = [];
  let cx = 0, cz = 0;
  for (let i = 0; i < tiers; i++) {
    const t   = i / tiers;
    const r   = rBase - t * (rBase - rTop);
    const h   = 0.38 + (hash(seed, i, 2) - 0.5) * 0.10;
    const y   = 0.34 + i * 0.23;
    const rot = i * Math.PI * 2 * 0.618;
    const seg = 5 + (i & 1);
    cx += (hash(seed, i, 14) - 0.5) * 0.05;
    cz += (hash(seed, i, 15) - 0.5) * 0.05;
    const cone = new THREE.ConeGeometry(r, h, seg, 1);
    cone.rotateY(rot);
    cone.translate(cx, y + h * 0.5, cz);
    coneParts.push(cone);
  }
  const canopyGeo = mergeGeometries(coneParts);
  return [{ geo: trunkGeo, mat: trunkMat }, { geo: canopyGeo, mat: leafMat }];
}

initGame().catch(console.error);
