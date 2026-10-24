/**
 * Matematica del giro de rodillos.
 *
 * Modulo puro (sin DOM ni imports) para poder probarlo con `node --test`: la
 * animacion real vive en `reels.js` y solo aplica estas formulas al `transform`
 * y al `filter` de cada carril.
 *
 * Unidades: la velocidad se mide en CELDAS por segundo y las distancias en
 * celdas. Asi la coreografia no depende de los pixeles: al redimensionar la
 * ventana solo cambia la escala (px por celda), nunca los tiempos ni el numero
 * de simbolos que pasa cada rodillo.
 */

/**
 * Ajustes del giro. Todo lo que define la "sensacion" esta aqui: velocidad
 * punta, duracion de la frenada, desfase entre rodillos, intensidad del
 * desenfoque y del rebote.
 */
export const REEL_DEFAULTS = Object.freeze({
  rows: 5,
  columns: 6,

  /* Velocidad punta en celdas/segundo (30 = una celda cada ~33 ms). */
  maxSpeed: 30,
  /* Rampa de aceleracion tras la anticipacion. */
  spinUpMs: 180,
  /* Micro subida previa: el rodillo "carga" antes de caer. */
  anticipationMs: 140,
  /* Desfase de arranque para que los seis carriles no salgan como un bloque. */
  startStaggerMs: 16,
  /* Giro minimo visible antes de aceptar la orden de parada. */
  minSpinMs: 340,

  /* Frenada: duracion objetivo y desfase de parada izquierda -> derecha. */
  stopMs: 400,
  stopStaggerMs: 70,
  /* Rebote final (lo ejecuta una animacion CSS, aqui solo se reserva tiempo). */
  bounceMs: 240,
  bouncePx: 8,

  /* Desenfoque de movimiento. */
  blurMax: 4.2,
  blurMinSpeed: 3,
  blurStep: 0.35
});

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : (n > max ? max : n);
}

/** Progreso 0..1 -> 0..1 con salida rapida y frenada larga. */
export function easeOutCubic(t) {
  const u = clamp(t, 0, 1);
  return 1 - (1 - u) ** 3;
}

/**
 * Velocidad del rodillo en funcion del tiempo desde su arranque.
 *
 * Durante la anticipacion se queda a cero (el carril solo hace el micro
 * movimiento hacia arriba); despues sube hasta `maxSpeed` con una salida
 * cubica, de modo que el arranque se percibe instantaneo pero sin salto.
 *
 * @param {number} elapsedMs ms desde el arranque del rodillo
 * @returns {number} celdas por segundo
 */
export function speedAt(elapsedMs, cfg = REEL_DEFAULTS) {
  const since = Number(elapsedMs) - cfg.anticipationMs;
  if (!(since > 0)) return 0;
  return cfg.maxSpeed * easeOutCubic(since / Math.max(1, cfg.spinUpMs));
}

/**
 * Desenfoque vertical de movimiento para una velocidad dada.
 *
 * Crece con la velocidad, se satura en `blurMax` y se cuantiza a `blurStep`
 * para no repintar la capa del carril por variaciones de centesimas de pixel.
 *
 * @param {number} speed celdas por segundo
 * @returns {number} px de `filter: blur()`
 */
export function blurForSpeed(speed, cfg = REEL_DEFAULTS) {
  const v = Number(speed);
  if (!(v > cfg.blurMinSpeed)) return 0;
  const span = Math.max(1e-3, cfg.maxSpeed - cfg.blurMinSpeed);
  const ratio = clamp((v - cfg.blurMinSpeed) / span, 0, 1);
  const raw = cfg.blurMax * Math.sqrt(ratio);
  const step = Math.max(1e-3, cfg.blurStep);
  /* `toFixed` deja el valor limpio (12 * 0.35 = 4.199999...) sin perder la
     cuantizacion: sigue siendo un multiplo exacto de `blurStep`. */
  return Number((Math.round(raw / step) * step).toFixed(2));
}

/**
 * Plan de frenada de un rodillo.
 *
 * La curva es `easeOutCubic` sobre la distancia: arranca con la velocidad que
 * traia el carril y muere en cero. Como `distance` se elige para que
 * `offset + distance` sea un entero, el carril aterriza EXACTAMENTE alineado
 * con la rejilla (nunca a media celda) y el numero de celdas recicladas es
 * justo `cells`, lo que permite inyectar los simbolos del resultado en las
 * ultimas posiciones.
 *
 * @param {{speed?: number, offset?: number, cfg?: object}} params
 * @returns {{cells: number, distance: number, durationMs: number}}
 */
export function stopPlan({ speed = 0, offset = 0, cfg = REEL_DEFAULTS } = {}) {
  const v = Math.max(Number(speed) || 0, cfg.maxSpeed * 0.35);
  const slack = clamp(offset, 0, 0.999);
  const travel = (v * cfg.stopMs) / 3000;
  const cells = Math.max(cfg.rows, Math.round(travel + slack));
  const distance = cells - slack;
  const durationMs = clamp((3000 * distance) / v, 180, cfg.stopMs * 1.8);
  return { cells, distance, durationMs: Math.round(durationMs) };
}

/**
 * Simbolos que entran por abajo durante la frenada.
 *
 * El carril recicla una celda por cada celda recorrida: la que sale por arriba
 * vuelve al final de la tira. Una celda inyectada en el reciclado `j` llega a
 * la fila 0 en el reciclado `j + rows`, asi que las `rows` ultimas inyecciones
 * son las que quedan a la vista, en orden de fila. El resto es relleno.
 *
 * @param {{cells: number, rows: number, target: Array<*>, fill?: Function}} params
 * @returns {Array<*>} longitud `cells`
 */
export function stopInjections({ cells, rows, target = [], fill } = {}) {
  const total = Math.max(0, Math.floor(cells));
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const remaining = total - i;
    if (remaining <= rows) {
      out.push(target[rows - remaining]);
    } else {
      out.push(typeof fill === 'function' ? fill(i) : null);
    }
  }
  return out;
}

/**
 * Matriz del servidor (`matrix[row][col]`) -> columnas del rodillo
 * (`out[col][row]`), que es el orden en el que se para cada carril.
 *
 * @param {Array<Array<string|null>>} matrix
 * @param {{rows?: number, columns?: number}} [size]
 * @returns {Array<Array<string|null>>}
 */
export function columnsFromMatrix(matrix, { rows = 5, columns = 6 } = {}) {
  const out = [];
  for (let col = 0; col < columns; col += 1) {
    const column = [];
    for (let row = 0; row < rows; row += 1) {
      column.push(matrix && matrix[row] ? (matrix[row][col] ?? null) : null);
    }
    out.push(column);
  }
  return out;
}

/**
 * Ms desde "ahora" hasta que el ultimo rodillo termina su rebote.
 *
 * @param {{reels: number, staggerMs: number, durationMs: number, bounceMs: number}} params
 */
export function timelineMs({ reels = 6, staggerMs = 0, durationMs = 0, bounceMs = 0 } = {}) {
  return Math.max(0, reels - 1) * staggerMs + durationMs + bounceMs;
}
