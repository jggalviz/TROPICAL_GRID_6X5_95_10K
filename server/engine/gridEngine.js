'use strict';

/**
 * ============================================================================
 *  TROPICAL_GRID_6X5_95_10K  -  MOTOR MATEMATICO AUTORITATIVO (SERVER-SIDE)
 *  Informe tecnico de diseno matematico y reglas de juego.
 * ============================================================================
 *
 *  REGLAS DEL JUEGO (RESUMEN NORMATIVO)
 *  ---------------------------------------------------------------------------
 *  1. Cuadricula FIJA de 6 columnas x 5 filas (30 celdas). No hay lineas.
 *  2. Pagos por AGRUPACION (Cluster Pays): 8 o mas simbolos regulares (S1..S9)
 *     conectados ortogonalmente (arriba/abajo/izquierda/derecha). No se
 *     consideran diagonales. Todas las agrupaciones se pagan simultaneamente.
 *  3. Tabla de pagos por agrupacion (multiplos de la apuesta total):
 *         8-9 simbolos | 10-11 simbolos | 12+ simbolos
 *     Detalle exacto en CLUSTER_PAYS_UNITS (mas abajo).
 *  4. SCATTER (SC): no forma agrupaciones. Se evalua UNICAMENTE en la
 *     cuadricula inicial: 3 -> 1x, 4 -> 3x, 5 -> 10x, 6+ -> 30x la apuesta.
 *  5. BOMBA MULTIPLICADORA (MX): no forma agrupaciones y NO se elimina.
 *     Cada bomba aterriza con un valor aleatorio de 2x..250x (sesgado a la
 *     parte baja de la tabla). Al terminar la secuencia de cascadas, la SUMA
 *     de las bombas presentes en la cuadricula final es el multiplicador de
 *     la ronda y se aplica al total ganado por agrupaciones + scatter.
 *     Sin bombas -> multiplicador = 1.
 *  6. CASCADAS (Tumbling): las celdas ganadoras se eliminan, los simbolos
 *     superiores caen por gravedad y se rellenan nuevas celdas desde arriba.
 *     El proceso se repite hasta que no haya nuevas agrupaciones.
 *  7. TOPE DE EXPOSICION (Max Exposure Cap): 10.000x la apuesta base por
 *     ronda. Si la ronda alcanza el tope, se corta el proceso y se marca
 *     "capped". Ninguna ronda puede pagar mas de 10.000x.
 *  8. ALEATORIEDAD: exclusivamente `node:crypto` (CSPRNG). Las semillas se
 *     generan con crypto.randomBytes(32) y el flujo aleatorio es un DRBG
 *     HMAC-SHA256 (HMAC(serverSeed, "clientSeed:counter")), con muestreo por
 *     rechazo para eliminar sesgo modular. Nunca Math.random().
 *  9. COMPRA DE BONUS (buy_feature): 100x la apuesta base compra la funcion
 *     TROPICAL FEVER (10 tiradas) con bombas potenciadas. El tope de 10.000x
 *     se calcula sobre la apuesta base (bet), no sobre el precio de compra.
 *
 *  UNIDADES MONETARIAS
 *  ---------------------------------------------------------------------------
 *  - Importes en CENTIMOS enteros (bigint-friendly). Nunca floats para dinero.
 *  - Pagos internos en MICRO-UNIDADES: 1 apuesta = 10.000 micro = 1,0000x.
 *    Asi 0,12x = 1200 micro. Todo el calculo de pagos es aritmetica entera y
 *    se redondea HACIA ABAJO una sola vez, al convertir a centimos.
 *
 *  El cliente NUNCA ejecuta este archivo. Es de uso exclusivo del backend.
 * ============================================================================
 */

const crypto = require('node:crypto');

/* ==========================================================================
 *  1. CONSTANTES DEL JUEGO
 * ========================================================================== */

const GAME_CODE = 'TROPICAL_GRID_6X5_95_10K';
const GAME_NAME = 'Tropical Grid 6x5';
const ENGINE_VERSION = '1.0.0';
const PAYTABLE_VERSION = 'TG65-95-10K-v1';

const GRID_COLS = 6;
const GRID_ROWS = 5;
const GRID_CELLS = GRID_COLS * GRID_ROWS; // 30

const MIN_CLUSTER_SIZE = 8;
const MAX_EXPOSURE_MULTIPLIER = 10000; // 10.000x
const MAX_CASCADE_STEPS = 40;
const MAX_FEATURE_SPINS = 10;

/** 1 unidad de apuesta = 10.000 micro-unidades (precision 0,0001x). */
const MICRO_PER_UNIT = 10000;
/** Tope de exposicion expresado en micro-unidades de apuesta: 10.000x. */
const MAX_EXPOSURE_MICRO = MAX_EXPOSURE_MULTIPLIER * MICRO_PER_UNIT; // 100.000.000

const SCATTER = 'SC';
const MULTIPLIER = 'MX';
const REGULAR_SYMBOLS = Object.freeze([
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'
]);

/** Escalera oficial de apuestas en creditos (validada en el backend). */
const BET_LADDER_CREDITS = Object.freeze([0.10, 0.20, 0.50, 1, 2, 5, 10, 20, 50, 100]);

/* --------------------------------------------------------------------------
 *  1.1 TABLA DE PAGOS POR AGRUPACION  (en multiplos de la apuesta total)
 *      Clave = tamano minimo del tramo. Los tramos son EXACTAMENTE:
 *      8-9 / 10-11 / 12+
 * -------------------------------------------------------------------------- */
const CLUSTER_PAYS_UNITS = Object.freeze({
  S1: Object.freeze({ 8: 0.91, 10: 2.27, 12: 5.05 }),
  S2: Object.freeze({ 8: 1.11, 10: 2.78, 12: 6.56 }),
  S3: Object.freeze({ 8: 1.36, 10: 3.28, 12: 8.08 }),
  S4: Object.freeze({ 8: 1.62, 10: 4.04, 12: 9.58 }),
  S5: Object.freeze({ 8: 2.07, 10: 5.05, 12: 11.61 }),
  S6: Object.freeze({ 8: 2.62, 10: 6.56, 12: 14.63 }),
  S7: Object.freeze({ 8: 3.33, 10: 8.08, 12: 18.16 }),
  S8: Object.freeze({ 8: 4.45, 10: 11.10, 12: 23.20 }),
  S9: Object.freeze({ 8: 5.95, 10: 14.63, 12: 29.25 })
});

/** Pagos de scatter segun cantidad en la cuadricula inicial (multiplos). */
const SCATTER_PAYS_UNITS = Object.freeze({
  3: 7.6,
  4: 22.7,
  5: 75.4,
  6: 226
});

/* --------------------------------------------------------------------------
 *  1.2 TIRA VIRTUAL (REEL STRIP)
 *      Cada columna usa una tira fisica determinista de STRIP_LENGTH
 *      posiciones. Las rachas (runs) de 1 a 4 simbolos generan las
 *      agrupaciones verticales propias de un juego Cluster Pays y hacen que
 *      la tasa de acierto sea la de un slot real (~24% antes de cascadas).
 *      SCATTER y MULTIPLICADOR nunca se apilan (run = 1).
 *      Los pesos de SC/MX se expresan en "posiciones sueltas": al no
 *      multiplicarse por la racha media, su peso es mayor para conservar su
 *      probabilidad objetivo (SC ~1,22%, MX ~0,68%).
 * -------------------------------------------------------------------------- */
const STRIP_LENGTH = 120;
const STRIP_RUN_LENGTHS = Object.freeze([1, 1, 2, 2, 3, 3, 4]);
const STRIP_SEED = 0x7f4a7c15;
const SINGLE_RUN_SYMBOLS = Object.freeze([SCATTER, MULTIPLIER]);

const BASE_WEIGHTS = Object.freeze({
  S1: 1700,
  S2: 1550,
  S3: 1400,
  S4: 1250,
  S5: 1100,
  S6: 1000,
  S7: 900,
  S8: 800,
  S9: 700,
  SC: 310,
  MX: 175
});

/** Pesos potenciados del modo TROPICAL FEVER (mas bombas, mismas agrupaciones). */
const FEATURE_WEIGHTS = Object.freeze({
  S1: 1700,
  S2: 1550,
  S3: 1400,
  S4: 1250,
  S5: 1100,
  S6: 1000,
  S7: 900,
  S8: 800,
  S9: 700,
  SC: 310,
  MX: 1040
});

/* --------------------------------------------------------------------------
 *  1.3 TABLA DE VALORES DE BOMBA (2x..250x) - SESGADA AL RANGO BAJO
 *      Media base ~5,50x | Media feature ~14,65x
 * -------------------------------------------------------------------------- */
const BASE_MULTIPLIER_TABLE = Object.freeze({
  2: 2200,
  3: 2000,
  4: 1600,
  5: 1200,
  6: 900,
  8: 650,
  10: 450,
  12: 300,
  15: 220,
  20: 150,
  25: 90,
  50: 40,
  100: 12,
  250: 3
});

const FEATURE_MULTIPLIER_TABLE = Object.freeze({
  2: 450,
  3: 520,
  4: 620,
  5: 680,
  6: 730,
  8: 760,
  10: 780,
  12: 740,
  15: 690,
  20: 620,
  25: 520,
  50: 340,
  100: 143,
  250: 37
});

/* --------------------------------------------------------------------------
 *  1.4 COMPRA DE BONUS
 * -------------------------------------------------------------------------- */
const FEATURE_CONFIG = Object.freeze({
  id: 'TROPICAL_FEVER',
  label: 'Tropical Fever',
  costMultiplier: 100, // 100x la apuesta base
  spins: MAX_FEATURE_SPINS
});

/**
 * RTP certificado por simulacion (ver docs/MATH_MODEL.md).
 * `base` y `feature` son el RTP medido sobre la apuesta; `*StandardError` y
 * `*Ci95` documentan la precision de la medicion (error estandar en puntos
 * porcentuales). Se actualiza solo al recalibrar; NUNCA en caliente.
 */
const CERTIFIED_RTP = Object.freeze({
  target: 0.95,
  base: 0.9492,
  feature: 0.9497,
  baseStandardError: 0.0021,
  featureStandardError: 0.0033,
  baseCi95: Object.freeze([0.9451, 0.9533]),
  featureCi95: Object.freeze([0.9432, 0.9562]),
  simulatedRoundsBase: 12000000,
  simulatedRoundsFeature: 300000,
  simulatedSpinsFeature: 3000000,
  calibratedAt: '2026-10-21'
});

/* ==========================================================================
 *  2. UTILIDADES
 * ========================================================================== */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function unitsToMicro(units) {
  return Math.round(units * MICRO_PER_UNIT);
}

function microToCents(micro, betCents) {
  if (!Number.isFinite(micro) || micro <= 0) return 0;
  return Math.floor((micro * betCents) / MICRO_PER_UNIT);
}

function mapClusterPays(paysUnits) {
  const table = {};
  for (const symbol of Object.keys(paysUnits)) {
    table[symbol] = {};
    for (const size of Object.keys(paysUnits[symbol])) {
      table[symbol][Number(size)] = unitsToMicro(paysUnits[symbol][size]);
    }
    Object.freeze(table[symbol]);
  }
  return Object.freeze(table);
}

function mapPays(paysUnits) {
  const table = {};
  for (const key of Object.keys(paysUnits)) {
    table[Number(key)] = unitsToMicro(paysUnits[key]);
  }
  return Object.freeze(table);
}

/** Devuelve el tramo de pago (8 / 10 / 12) segun el tamano de la agrupacion. */
function clusterTier(size) {
  if (size >= 12) return 12;
  if (size >= 10) return 10;
  if (size >= MIN_CLUSTER_SIZE) return 8;
  return 0;
}

/**
 * Tramo de pago de scatter aplicable a `count` flores.
 * El ultimo tramo de la tabla es abierto ("6+"), asi que se acota a su clave.
 * Se memoiza por tabla para no recorrer claves en cada tirada.
 */
const scatterTopTierCache = new WeakMap();

function scatterTopTier(scatterPays) {
  let top = scatterTopTierCache.get(scatterPays);
  if (top === undefined) {
    top = Object.keys(scatterPays).reduce((max, key) => Math.max(max, Number(key) || 0), 0);
    scatterTopTierCache.set(scatterPays, top);
  }
  return top;
}

function assertInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const err = new Error(`${name} invalido: ${value}. Debe ser entero entre ${min} y ${max}.`);
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }
  return value;
}

/* ==========================================================================
 *  3. GENERADOR ALEATORIO CRIPTOGRAFICO (CSPRNG / HMAC-DRBG)
 *     - Semilla: crypto.randomBytes(32) -> 256 bits de entropia.
 *     - Flujo: HMAC-SHA256(serverSeed, `${clientSeed}:${counter}`).
 *     - Muestreo por rechazo: elimina el sesgo modular (GLI-19 3.2.1).
 * ========================================================================== */

const UINT32_RANGE = 0x100000000; // 2^32
const DRBG_MAX_BLOCKS = 0x7fffffff;

/**
 * Crea el flujo aleatorio determinista de la ronda.
 * @param {{serverSeed: string, clientSeed: string}} seeds
 * @returns {{int: (maxExclusive:number)=>number, float: ()=>number,
 *            draws: ()=>number, getState: ()=>{counter:number}}}
 */
function createRng({ serverSeed, clientSeed }) {
  if (typeof serverSeed !== 'string' || !/^[0-9a-f]{64}$/i.test(serverSeed)) {
    throw new Error('serverSeed debe ser 32 bytes en hexadecimal (64 chars).');
  }
  const clientSeedText = typeof clientSeed === 'string' && clientSeed.length > 0
    ? clientSeed
    : 'default-client-seed';

  const key = Buffer.from(serverSeed, 'hex');
  const data = Buffer.from(clientSeedText, 'utf8');
  const mac = crypto.createHmac('sha256', key);
  mac.update(data);
  mac.update(Buffer.from(':0', 'utf8'));
  let block = mac.digest();
  let offset = 0;
  let blockCounter = 1;
  let draws = 0;

  function nextUint32() {
    if (offset + 4 > block.length) {
      if (blockCounter > DRBG_MAX_BLOCKS) {
        throw new Error('DRBG agotado: limite de bloques excedido.');
      }
      const h = crypto.createHmac('sha256', key);
      h.update(data);
      h.update(Buffer.from(`:${blockCounter}`, 'utf8'));
      block = h.digest();
      offset = 0;
      blockCounter += 1;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    draws += 1;
    return value;
  }

  /**
   * Entero uniforme en [0, maxExclusive). Rechazo sobre el mayor multiplo
   * de maxExclusive que cabe en 2^32.
   */
  function int(maxExclusive) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
      throw new RangeError(`int(maxExclusive=${maxExclusive}) fuera de rango.`);
    }
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(UINT32_RANGE / maxExclusive) * maxExclusive;
    let sample;
    do {
      sample = nextUint32();
    } while (sample >= limit);
    return sample % maxExclusive;
  }

  return {
    int,
    float: () => int(UINT32_RANGE) / UINT32_RANGE,
    draws: () => draws,
    getState: () => ({ counter: blockCounter, offset, draws })
  };
}

/** Genera el par de semillas de una ronda con el CSPRNG del sistema. */
function createSeeds(clientSeed) {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const safeClientSeed = normalizeClientSeed(clientSeed);
  const rngHash = crypto
    .createHash('sha256')
    .update(`${serverSeed}:${safeClientSeed}:${ENGINE_VERSION}`)
    .digest('hex');
  return {
    serverSeed,
    clientSeed: safeClientSeed,
    serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
    rngHash
  };
}

/** El client seed es informativo/auditoria; se sanea y acota a 64 chars. */
function normalizeClientSeed(clientSeed) {
  if (typeof clientSeed !== 'string') return crypto.randomBytes(16).toString('hex');
  const clean = clientSeed.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
  return clean.length >= 4 ? clean : crypto.randomBytes(16).toString('hex');
}

/* ==========================================================================
 *  4. TIRAS VIRTUALES PONDERADAS
 * ========================================================================== */

/**
 * Compila una tabla de pesos en una estructura de busqueda binaria acumulada.
 * @param {Record<string, number>} weights
 */
function compilePicker(weights) {
  const keys = Object.keys(weights);
  const symbols = [];
  const cumulative = [];
  let total = 0;
  for (const key of keys) {
    const weight = weights[key];
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new Error(`Peso invalido para ${key}: ${weight}`);
    }
    if (weight === 0) continue;
    total += weight;
    symbols.push(key);
    cumulative.push(total);
  }
  if (total <= 0) throw new Error('La tabla de pesos no puede estar vacia.');
  return Object.freeze({
    symbols: Object.freeze(symbols),
    cumulative: Object.freeze(cumulative),
    total
  });
}

/** Selecciona una clave con probabilidad proporcional a su peso. */
function pickWeighted(picker, rng) {
  const ticket = rng.int(picker.total);
  let low = 0;
  let high = picker.cumulative.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ticket < picker.cumulative[mid]) high = mid;
    else low = mid + 1;
  }
  return picker.symbols[low];
}

/** Compila la tabla de valores de bomba (2x..250x) con pesos acumulados. */
function compileMultiplierPicker(table) {
  const values = [];
  const cumulative = [];
  let total = 0;
  for (const key of Object.keys(table)) {
    const value = Number(key);
    const weight = table[key];
    if (!Number.isSafeInteger(value) || value < 2 || value > 250) {
      throw new Error(`Valor de multiplicador fuera de [2,250]: ${key}`);
    }
    total += weight;
    values.push(value);
    cumulative.push(total);
  }
  return Object.freeze({ values: Object.freeze(values), cumulative: Object.freeze(cumulative), total });
}

function pickMultiplier(picker, rng) {
  const ticket = rng.int(picker.total);
  let low = 0;
  let high = picker.cumulative.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ticket < picker.cumulative[mid]) high = mid;
    else low = mid + 1;
  }
  return picker.values[low];
}

/* ==========================================================================
 *  5. TIRAS FISICAS, GRAVEDAD Y DETECCION DE AGRUPACIONES
 * ========================================================================== */

/** Celda: { s: simbolo, v: valor de bomba (0 si no es bomba) }. */
function createCell(symbol, value) {
  return { s: symbol, v: symbol === MULTIPLIER ? value : 0 };
}

function createEmptyGrid() {
  return Array.from({ length: GRID_ROWS }, () => new Array(GRID_COLS).fill(null));
}

function cloneGrid(grid) {
  return grid.map((row) => row.map((cell) => (cell ? { s: cell.s, v: cell.v } : null)));
}

/* --------------------------------------------------------------------------
 *  5.1 CONSTRUCCION DETERMINISTA DE LAS TIRAS
 *      mulberry32 (PRNG de construccion, NO de juego) genera siempre las
 *      mismas tiras a partir de STRIP_SEED. Las tiras son parte de las
 *      reglas del juego y se publican hasheadas en /api/game para auditoria.
 * -------------------------------------------------------------------------- */
function createStripRng(seed) {
  let state = seed >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(max) {
      return Math.floor(this.next() * max);
    }
  };
}

function buildStrip(weights, length, seed) {
  const symbols = Object.keys(weights);
  const total = symbols.reduce((sum, symbol) => sum + weights[symbol], 0);
  const rng = createStripRng(seed);
  const strip = [];
  let guard = 0;

  while (strip.length < length) {
    guard += 1;
    if (guard > length * 100) throw new Error('No se pudo construir la tira virtual.');
    let ticket = rng.int(total);
    let symbol = symbols[symbols.length - 1];
    for (const candidate of symbols) {
      if (ticket < weights[candidate]) {
        symbol = candidate;
        break;
      }
      ticket -= weights[candidate];
    }
    const runLength = SINGLE_RUN_SYMBOLS.includes(symbol)
      ? 1
      : STRIP_RUN_LENGTHS[rng.int(STRIP_RUN_LENGTHS.length)];
    for (let i = 0; i < runLength && strip.length < length; i += 1) {
      strip.push(symbol);
    }
  }

  return Object.freeze(strip);
}

function buildStrips(weights, seed) {
  return Object.freeze(
    Array.from({ length: GRID_COLS }, (_, col) =>
      buildStrip(weights, STRIP_LENGTH, (seed ^ Math.imul(col + 1, 0x9e3779b9)) >>> 0)
    )
  );
}

function stripAt(strip, position) {
  const len = strip.length;
  return strip[((position % len) + len) % len];
}

/**
 * Extrae un simbolo de la tira. Si la posicion es MULTIPLICADOR se sortea
 * su valor (2x..250x) con el CSPRNG de la ronda.
 */
function drawFromStrip(strip, position, rng, multiplierPicker) {
  const symbol = stripAt(strip, position);
  if (symbol === MULTIPLIER) {
    return createCell(MULTIPLIER, pickMultiplier(multiplierPicker, rng));
  }
  return createCell(symbol, 0);
}

/**
 * Tirada inicial: cada columna elige una parada aleatoria (CSPRNG) y se
 * toman 5 posiciones consecutivas. La fila inferior (4) corresponde a la
 * parada; las superiores avanzan en la tira.
 */
function createReelState(rng, strips, multiplierPicker) {
  const grid = createEmptyGrid();
  const cursors = new Array(GRID_COLS).fill(0);

  for (let col = 0; col < GRID_COLS; col += 1) {
    const strip = strips[col];
    const stop = rng.int(strip.length);
    for (let i = 0; i < GRID_ROWS; i += 1) {
      const row = GRID_ROWS - 1 - i;
      grid[row][col] = drawFromStrip(strip, stop + i, rng, multiplierPicker);
    }
    cursors[col] = (stop + GRID_ROWS) % strip.length;
  }

  return { grid, cursors, strips };
}

/**
 * Aplica gravedad a cada columna y rellena los huecos desde arriba
 * continuando la tira fisica (el cursor avanza). Las bombas caen como
 * cualquier otro simbolo y NUNCA se eliminan.
 * @param {Set<number>} removedSet indices lineales (row * GRID_COLS + col)
 */
function applyGravityAndRefill(grid, removedSet, reelState, rng, multiplierPicker) {
  for (let col = 0; col < GRID_COLS; col += 1) {
    const survivors = [];
    for (let row = GRID_ROWS - 1; row >= 0; row -= 1) {
      const cell = grid[row][col];
      if (cell !== null && !removedSet.has(row * GRID_COLS + col)) {
        survivors.push(cell);
      }
    }

    let write = GRID_ROWS - 1;
    for (const cell of survivors) {
      grid[write][col] = cell;
      write -= 1;
    }

    const strip = reelState.strips[col];
    while (write >= 0) {
      grid[write][col] = drawFromStrip(strip, reelState.cursors[col], rng, multiplierPicker);
      reelState.cursors[col] = (reelState.cursors[col] + 1) % strip.length;
      write -= 1;
    }
  }
  return grid;
}

/**
 * Detecta todas las agrupaciones >= MIN_CLUSTER_SIZE mediante BFS ortogonal.
 * Orden determinista (fila, columna) para que la auditoria sea reproducible.
 *
 * @param {Array<Array<{s:string,v:number}>>} grid
 * @param {Record<string, Record<number, number>>} paytable micro-unidades
 * @returns {Array<{symbol:string,size:number,cells:Array<[number,number]>,
 *                  tier:number,payMicro:number}>}
 */
function findClusters(grid, paytable) {
  const visited = Array.from({ length: GRID_ROWS }, () => new Array(GRID_COLS).fill(false));
  const clusters = [];

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (visited[row][col]) continue;
      const startCell = grid[row][col];
      if (!startCell || !REGULAR_SYMBOLS.includes(startCell.s)) {
        visited[row][col] = true;
        continue;
      }

      const symbol = startCell.s;
      const cells = [];
      const queue = [[row, col]];
      visited[row][col] = true;

      while (queue.length > 0) {
        const [r, c] = queue.pop();
        cells.push([r, c]);
        const neighbours = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
        for (const [nr, nc] of neighbours) {
          if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
          if (visited[nr][nc]) continue;
          const next = grid[nr][nc];
          if (!next || next.s !== symbol) continue;
          visited[nr][nc] = true;
          queue.push([nr, nc]);
        }
      }

      if (cells.length >= MIN_CLUSTER_SIZE) {
        cells.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
        const tier = clusterTier(cells.length);
        const payMicro = paytable[symbol] && paytable[symbol][tier] ? paytable[symbol][tier] : 0;
        clusters.push({ symbol, size: cells.length, cells, tier, payMicro });
      }
    }
  }

  return clusters;
}

/** Lista de bombas visibles con su valor. */
function collectBombs(grid) {
  const bombs = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      const cell = grid[row][col];
      if (cell && cell.s === MULTIPLIER) bombs.push({ r: row, c: col, value: cell.v });
    }
  }
  return bombs;
}

/** Matriz serializable (solo simbolos) para el cliente. */
function toMatrix(grid) {
  return grid.map((row) => row.map((cell) => (cell ? cell.s : null)));
}

/* ==========================================================================
 *  6. RESOLUCION DE UNA TIRADA (con cascadas)
 * ========================================================================== */

/**
 * Ejecuta una tirada completa: drop inicial, evaluacion, cascadas y
 * recoleccion del multiplicador final.
 *
 * @param {object} params
 * @param {object} params.rng               generador (CSPRNG o inyectado en tests)
 * @param {object} params.pickers           pickers compilados del modo
 * @param {Array<Array<string>>} params.strips tiras fisicas del modo
 * @param {object} params.paytable          tabla de pagos en micro-unidades
 * @param {object} params.scatterPays       pagos de scatter en micro-unidades
 * @param {number} params.betCents          apuesta base en centimos
 * @param {number} params.winBudgetCents    maximo pagable en esta tirada
 * @param {number} params.spinIndex         indice (modo base => 0)
 * @returns {object} resultado serializable de la tirada
 */
function playSpin({
  rng, pickers, strips, paytable, scatterPays, betCents, winBudgetCents, spinIndex = 0
}) {
  const reelState = createReelState(rng, strips, pickers.multipliers);
  let grid = reelState.grid;
  const initialGrid = toMatrix(grid);

  /* --- Scatter: solo se evalua en la cuadricula inicial --- */
  const scatterCells = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (grid[row][col].s === SCATTER) scatterCells.push([row, col]);
    }
  }
  const scatterPayMicro = scatterPays[Math.min(scatterCells.length, scatterTopTier(scatterPays))] || 0;
  let clusterWinMicro = 0;
  const cascades = [];
  let capped = false;

  /* --- Bucle de cascadas --- */
  for (let stepIndex = 0; stepIndex < MAX_CASCADE_STEPS; stepIndex += 1) {
    const clusters = findClusters(grid, paytable);
    if (clusters.length === 0) break;

    const stepWinMicro = clusters.reduce((sum, cluster) => sum + cluster.payMicro, 0);
    clusterWinMicro += stepWinMicro;

    const removedCells = [];
    const removedSet = new Set();
    for (const cluster of clusters) {
      for (const [r, c] of cluster.cells) {
        removedCells.push([r, c]);
        removedSet.add(r * GRID_COLS + c);
      }
    }

    const step = {
      index: stepIndex,
      grid: toMatrix(grid),
      bombs: collectBombs(grid),
      clusters: clusters.map((cluster) => ({
        symbol: cluster.symbol,
        size: cluster.size,
        tier: cluster.tier,
        payMicro: cluster.payMicro,
        payUnits: Number((cluster.payMicro / MICRO_PER_UNIT).toFixed(4)),
        payCredits: Number(((cluster.payMicro * betCents) / (MICRO_PER_UNIT * 100)).toFixed(2)),
        cells: cluster.cells
      })),
      removedCells,
      winMicro: stepWinMicro,
      winCents: microToCents(stepWinMicro, betCents),
      gridAfter: null
    };

    grid = applyGravityAndRefill(grid, removedSet, reelState, rng, pickers.multipliers);
    step.gridAfter = toMatrix(grid);
    step.bombsAfter = collectBombs(grid);
    cascades.push(step);

    /* Corte por exposicion: el ganador base ya supera el tope de la ronda */
    if (clusterWinMicro >= MAX_EXPOSURE_MICRO) {
      capped = true;
      break;
    }
  }

  /* --- Multiplicador: suma de bombas en la cuadricula final --- */
  const finalGrid = toMatrix(grid);
  const bombs = collectBombs(grid);
  const multiplier = bombs.length > 0
    ? bombs.reduce((sum, bomb) => sum + bomb.value, 0)
    : 1;

  const baseWinMicro = clusterWinMicro + scatterPayMicro;

  /* --- Conversion monetaria unica (redondeo hacia abajo al centimo) --- */
  let winCents;
  if (baseWinMicro <= 0) {
    winCents = 0;
  } else if (baseWinMicro * multiplier >= MAX_EXPOSURE_MICRO) {
    winCents = Math.min(betCents * MAX_EXPOSURE_MULTIPLIER, winBudgetCents);
    capped = true;
  } else {
    winCents = microToCents(baseWinMicro * multiplier, betCents);
  }

  if (winCents > winBudgetCents) {
    winCents = winBudgetCents;
    capped = true;
  }

  return {
    index: spinIndex,
    initialGrid,
    finalGrid,
    cascades,
    scatter: {
      count: scatterCells.length,
      cells: scatterCells,
      payMicro: scatterPayMicro,
      payUnits: Number((scatterPayMicro / MICRO_PER_UNIT).toFixed(4)),
      payCents: microToCents(scatterPayMicro, betCents)
    },
    clusterWinMicro,
    baseWinMicro,
    baseWinUnits: Number((baseWinMicro / MICRO_PER_UNIT).toFixed(4)),
    multiplier,
    multiplierApplied: baseWinMicro > 0 ? multiplier : 0,
    bombs,
    winCents,
    winCredits: Number((winCents / 100).toFixed(2)),
    cascadeCount: cascades.length,
    capped
  };
}

/* ==========================================================================
 *  7. RONDA COMPLETA (modo base y compra de bonus)
 * ========================================================================== */

/**
 * Ejecuta una ronda autoritativa completa.
 *
 * @param {object} model     modelo matematico compilado
 * @param {object} options
 * @param {number} options.betCents        apuesta base en centimos
 * @param {boolean} [options.buyFeature]   true = TROPICAL FEVER (100x bet)
 * @param {string} [options.clientSeed]    semilla informativa del cliente
 * @param {string} [options.roundId]       id de ronda (para el hash de auditoria)
 * @param {object} [options.rng]           solo tests/simulacion
 * @returns {object} resultado de la ronda
 */
function playRound(model, options = {}) {
  const {
    betCents,
    buyFeature = false,
    clientSeed,
    roundId = null,
    rng: injectedRng = null
  } = options;

  assertInteger(betCents, 'betCents', { min: 1, max: 100000000 });
  if (typeof buyFeature !== 'boolean') {
    const err = new Error('buyFeature debe ser booleano.');
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }

  const seeds = injectedRng ? null : createSeeds(clientSeed);
  const rng = injectedRng || createRng(seeds);

  const creditCost = buyFeature ? model.feature.costMultiplier : 1;
  const wagerCents = betCents * creditCost;
  assertInteger(wagerCents, 'wagerCents', { min: 1, max: 100000000 });
  const maxWinCents = betCents * model.maxExposureMultiplier;

  const plannedSpins = buyFeature ? model.feature.spins : 1;
  const pickers = buyFeature ? model.feature.pickers : model.base.pickers;
  const spins = [];
  let totalWinCents = 0;
  let totalBaseWinMicro = 0;
  let capped = false;

  for (let spinIndex = 0; spinIndex < plannedSpins; spinIndex += 1) {
    const remaining = maxWinCents - totalWinCents;
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const spin = playSpin({
      rng,
      pickers,
      strips: buyFeature ? model.feature.strips : model.base.strips,
      paytable: model.clusterPaytableMicro,
      scatterPays: model.scatterPaysMicro,
      betCents,
      winBudgetCents: remaining,
      spinIndex
    });
    spins.push(spin);
    totalWinCents += spin.winCents;
    totalBaseWinMicro += spin.baseWinMicro;
    if (spin.capped) {
      capped = true;
      break;
    }
  }

  if (totalWinCents > maxWinCents) {
    totalWinCents = maxWinCents;
    capped = true;
  }

  const primary = spins[0];
  const isFeature = buyFeature;

  const result = {
    gameCode: GAME_CODE,
    gameName: GAME_NAME,
    engineVersion: ENGINE_VERSION,
    paytableVersion: model.paytableVersion,
    mode: isFeature ? 'BUY_FEATURE' : 'BASE',
    betCents,
    wagerCents,
    maxWinCents,
    totalWinCents,
    totalWinCredits: Number((totalWinCents / 100).toFixed(2)),
    totalBaseWinMicro,
    totalBaseWinUnits: Number((totalBaseWinMicro / MICRO_PER_UNIT).toFixed(4)),
    capped,
    maxWinReached: totalWinCents >= maxWinCents,
    spinsPlayed: spins.length,
    spinsPlanned: plannedSpins,
    spins,
    /* Acceso directo para el modo base (el cliente tambien puede usar spins[]) */
    initialGrid: isFeature ? null : primary.initialGrid,
    finalGrid: isFeature ? null : primary.finalGrid,
    cascades: isFeature ? [] : primary.cascades,
    scatter: isFeature ? null : primary.scatter,
    bombs: isFeature ? null : primary.bombs,
    multiplier: isFeature ? null : primary.multiplier,
    multiplierApplied: isFeature ? null : primary.multiplierApplied,
    audit: {
      roundId,
      serverSeed: seeds ? seeds.serverSeed : null,
      serverSeedHash: seeds ? seeds.serverSeedHash : null,
      clientSeed: seeds ? seeds.clientSeed : null,
      rngHash: seeds ? seeds.rngHash : null,
      rngDraws: typeof rng.draws === 'function' ? rng.draws() : null,
      generatedAt: new Date().toISOString(),
      certifiedRtp: CERTIFIED_RTP,
      paytableVersion: model.paytableVersion,
      engineVersion: ENGINE_VERSION
    }
  };

  if (isFeature) {
    result.feature = {
      id: model.feature.id,
      label: model.feature.label,
      costMultiplier: model.feature.costMultiplier,
      spins: model.feature.spins
    };
  }

  return result;
}

/* ==========================================================================
 *  8. CONSTRUCCION DEL MODELO Y API PUBLICA DEL MOTOR
 * ========================================================================== */

/**
 * Compila un modelo matematico completo. Los `overrides` existen para la
 * calibracion offline (scripts/simulate.js) y los tests; el endpoint de
 * produccion usa SIEMPRE el modelo por defecto (createEngine() sin args).
 */
function buildModel(overrides = {}) {
  const clusterPaysUnits = overrides.clusterPaysUnits || CLUSTER_PAYS_UNITS;
  const scatterPaysUnits = overrides.scatterPaysUnits || SCATTER_PAYS_UNITS;
  const baseWeights = overrides.baseWeights || BASE_WEIGHTS;
  const featureWeights = overrides.featureWeights || FEATURE_WEIGHTS;
  const baseMultiplierTable = overrides.baseMultiplierTable || BASE_MULTIPLIER_TABLE;
  const featureMultiplierTable = overrides.featureMultiplierTable || FEATURE_MULTIPLIER_TABLE;
  const featureConfig = Object.assign({}, FEATURE_CONFIG, overrides.featureConfig || {});

  const model = {
    paytableVersion: overrides.paytableVersion || PAYTABLE_VERSION,
    clusterPaysUnits,
    scatterPaysUnits,
    clusterPaytableMicro: mapClusterPays(clusterPaysUnits),
    scatterPaysMicro: mapPays(scatterPaysUnits),
    maxExposureMultiplier: overrides.maxExposureMultiplier || MAX_EXPOSURE_MULTIPLIER,
    base: {
      weights: baseWeights,
      multiplierTable: baseMultiplierTable,
      strips: buildStrips(baseWeights, STRIP_SEED),
      pickers: {
        symbols: compilePicker(baseWeights),
        multipliers: compileMultiplierPicker(baseMultiplierTable)
      }
    },
    feature: {
      id: featureConfig.id,
      label: featureConfig.label,
      costMultiplier: featureConfig.costMultiplier,
      spins: featureConfig.spins,
      weights: featureWeights,
      multiplierTable: featureMultiplierTable,
      strips: buildStrips(featureWeights, (STRIP_SEED ^ 0x5bd1e995) >>> 0),
      pickers: {
        symbols: compilePicker(featureWeights),
        multipliers: compileMultiplierPicker(featureMultiplierTable)
      }
    }
  };

  return deepFreeze(model);
}

/** Descripcion publica (sin logica) para /api/game y para la UI. */
function buildGameInfo(model) {
  const multiplierDistribution = {};
  for (const key of Object.keys(model.base.multiplierTable)) {
    multiplierDistribution[key] = Number(
      (model.base.multiplierTable[key] / model.base.pickers.multipliers.total).toFixed(6)
    );
  }

  /* Rango efectivo de bombas derivado del modelo (admite overrides). */
  const multiplierValues = Object.keys(model.base.multiplierTable)
    .concat(Object.keys(model.feature.multiplierTable))
    .map(Number);
  const multiplierMin = Math.min(...multiplierValues);
  const multiplierMax = Math.max(...multiplierValues);

  /* Comprobante de las tiras fisicas: permite al auditor verificar que el
     despliegue sirve exactamente las tiras certificadas. */
  const stripChecksum = crypto
    .createHash('sha256')
    .update(model.base.strips.map((strip) => strip.join('')).join('|'))
    .digest('hex');
  const composition = {};
  for (const strip of model.base.strips) {
    for (const symbol of strip) composition[symbol] = (composition[symbol] || 0) + 1;
  }
  const positions = model.base.strips.length * STRIP_LENGTH;
  const symbolDistribution = {};
  for (const symbol of Object.keys(composition)) {
    symbolDistribution[symbol] = Number((composition[symbol] / positions).toFixed(6));
  }

  return Object.freeze({
    code: GAME_CODE,
    name: GAME_NAME,
    engineVersion: ENGINE_VERSION,
    paytableVersion: model.paytableVersion,
    grid: { cols: GRID_COLS, rows: GRID_ROWS },
    minClusterSize: MIN_CLUSTER_SIZE,
    maxExposureMultiplier: model.maxExposureMultiplier,
    betLadder: BET_LADDER_CREDITS,
    certifiedRtp: CERTIFIED_RTP,
    clusterPays: model.clusterPaysUnits,
    scatterPays: model.scatterPaysUnits,
    strips: {
      length: STRIP_LENGTH,
      columns: GRID_COLS,
      checksum: stripChecksum,
      symbolDistribution
    },
    multiplier: {
      min: multiplierMin,
      max: multiplierMax,
      distribution: multiplierDistribution,
      rule: 'La suma de las bombas de la cuadricula final multiplica el total ganado.'
    },
    feature: {
      id: model.feature.id,
      label: model.feature.label,
      costMultiplier: model.feature.costMultiplier,
      spins: model.feature.spins
    },
    rules: [
      `Cuadricula fija de ${GRID_COLS}x${GRID_ROWS} con pagos por agrupacion de ${MIN_CLUSTER_SIZE} o mas simbolos.`,
      'Las agrupaciones se forman con simbolos iguales conectados en horizontal o vertical.',
      'Los simbolos ganadores se eliminan y provocan cascadas hasta que no queden premios.',
      `El SCATTER paga solo en la tirada inicial: 3/4/5/6+ = ${model.scatterPaysUnits[3]}x/${model.scatterPaysUnits[4]}x/${model.scatterPaysUnits[5]}x/${model.scatterPaysUnits[6]}x.`,
      `Cada bomba vale entre ${multiplierMin}x y ${multiplierMax}x; al final de la ronda se suman y multiplican el premio.`,
      `La ganancia maxima por ronda esta limitada a ${model.maxExposureMultiplier.toLocaleString('es-ES')}x la apuesta base.`
    ]
  });
}

/**
 * Crea una instancia del motor. En produccion usar la exportacion por defecto.
 * @param {object} [overrides] solo para calibracion/tests
 */
function createEngine(overrides = {}) {
  const model = buildModel(overrides);
  return {
    model,
    gameInfo: buildGameInfo(model),
    version: ENGINE_VERSION,
    playRound: (options) => playRound(model, options),
    internals: {
      createRng,
      createSeeds,
      buildStrips,
      buildStrip,
      createReelState,
      applyGravityAndRefill,
      findClusters,
      collectBombs,
      toMatrix,
      playSpin: (params) =>
        playSpin({
          ...params,
          pickers: params.pickers || model.base.pickers,
          strips: params.strips || model.base.strips,
          paytable: params.paytable || model.clusterPaytableMicro,
          scatterPays: params.scatterPays || model.scatterPaysMicro
        })
    }
  };
}

/** Valida que un importe en creditos pertenezca a la escalera oficial. */
function isValidBetCredits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) return false;
  return BET_LADDER_CREDITS.some((bet) => Math.round(bet * 100) === cents);
}

function creditsToCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  if (cents <= 0 || Math.abs(value * 100 - cents) > 1e-6) return null;
  return cents;
}

const defaultEngine = createEngine();

module.exports = {
  /* Instancia de produccion */
  playRound: defaultEngine.playRound,
  gameInfo: defaultEngine.gameInfo,
  model: defaultEngine.model,
  createEngine,
  /* Constantes y metadatos */
  GAME_CODE,
  GAME_NAME,
  ENGINE_VERSION,
  PAYTABLE_VERSION,
  GRID_COLS,
  GRID_ROWS,
  GRID_CELLS,
  MIN_CLUSTER_SIZE,
  MAX_EXPOSURE_MULTIPLIER,
  MAX_CASCADE_STEPS,
  MAX_FEATURE_SPINS,
  BET_LADDER_CREDITS,
  CLUSTER_PAYS_UNITS,
  SCATTER_PAYS_UNITS,
  BASE_WEIGHTS,
  FEATURE_WEIGHTS,
  BASE_MULTIPLIER_TABLE,
  FEATURE_MULTIPLIER_TABLE,
  FEATURE_CONFIG,
  CERTIFIED_RTP,
  SCATTER,
  MULTIPLIER,
  REGULAR_SYMBOLS,
  /* Helpers de validacion y utilidades */
  isValidBetCredits,
  creditsToCents,
  clusterTier
};







