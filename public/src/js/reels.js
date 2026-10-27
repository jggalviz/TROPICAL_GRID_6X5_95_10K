/**
 * Rodillos.
 *
 * Cada columna del tablero es un carril con una tira de `rows + 2` casillas: la
 * ventana visible (`rows`) y dos de reserva, una por encima y otra por debajo,
 * para que el carril nunca muestre un hueco al anticipar o al rebotar.
 *
 * Solo se toca lo que el compositor puede resolver:
 *
 *   - `.reel__body`  -> `transform` (avance continuo, anticipacion, rebote)
 *   - `.reel`        -> `filter: blur()` (desenfoque de movimiento) y
 *                       `--col-index` (desfase de la onda suave de reposo)
 *   - reciclado      -> UN `appendChild` por celda cruzada (la que sale por
 *                       arriba vuelve al final con simbolo nuevo)
 *
 * La coreografia (velocidades, distancias y que simbolo entra en cada celda) se
 * calcula en `reelMath.js`, que no toca el DOM.
 */

import {
  REEL_DEFAULTS,
  blurForSpeed,
  clamp,
  columnsFromMatrix,
  easeOutCubic,
  speedAt,
  stopInjections,
  stopPlan,
  timelineMs
} from './reelMath.js';

const REDUCED_MOTION = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Normaliza una columna del resultado a `[{ sym, bomb }]`. */
function normalizeColumn(column, rows) {
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    const cell = column ? column[row] : null;
    if (cell && typeof cell === 'object') {
      out.push({ sym: cell.sym ?? cell.symbol ?? null, bomb: Number(cell.bomb) || 0 });
    } else {
      out.push({ sym: cell ?? null, bomb: 0 });
    }
  }
  return out;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.grid contenedor `.grid`
 * @param {Array<string>} options.symbols simbolos que pueden entrar en el giro
 * @param {(cell: HTMLElement, sym: string|null, bomb: number) => void} options.paint
 * @param {(row: number, col: number) => HTMLElement} options.createCell
 * @param {(col: number, cells: HTMLElement[]) => void} [options.onLand]
 * @param {() => void} [options.onAllLanded]
 * @param {object} [options.cfg] sobreescritura de `REEL_DEFAULTS`
 */
export function createReels({
  grid,
  symbols = [],
  paint,
  createCell,
  onLand,
  onAllLanded,
  cfg = {}
} = {}) {
  const config = { ...REEL_DEFAULTS, ...cfg };
  const state = {
    reels: [],
    raf: 0,
    last: 0,
    running: false,
    pending: 0,
    step: 0,
    gap: 0,
    observer: null,
    cursor: 0
  };

  const paintCell = (cell, spec) => {
    if (!cell || typeof paint !== 'function') return;
    paint(cell, spec ? spec.sym : null, spec ? spec.bomb : 0);
  };

  /** Siguiente simbolo de relleno (nunca el mismo dos veces seguidas). */
  const nextSymbol = () => {
    const total = symbols.length;
    if (total === 0) return null;
    state.cursor = (state.cursor + 1 + Math.floor(Math.random() * Math.max(1, total - 1))) % total;
    return symbols[state.cursor];
  };

  const randomCell = () => ({ sym: nextSymbol(), bomb: 0 });

  /** Recoloca las celdas fuera de vista con el simbolo vacio. */
  const clearBuffers = (reel) => {
    const children = reel.strip.children;
    paintCell(children[0], null);
    paintCell(children[config.rows + 1], null);
  };

  const measure = () => {
    if (!state.reels.length || !grid) return;
    const gap = Number.parseFloat(window.getComputedStyle(grid).rowGap) || 0;
    const height = grid.clientHeight;
    if (!(height > 0)) return;

    /* La ventana son `rows` casillas separadas por `rows - 1` huecos. */
    const cell = Math.max(1, (height - gap * (config.rows - 1)) / config.rows);
    state.gap = gap;
    state.step = cell + gap;

    for (const reel of state.reels) {
      reel.el.style.setProperty('--reel-cell', `${cell.toFixed(2)}px`);
      reel.el.style.setProperty('--reel-step', `${state.step.toFixed(2)}px`);
      reel.strip.style.gap = `${gap.toFixed(2)}px`;
    }
  };

  const render = (reel) => {
    const offset = reel.pos - reel.recycled;
    reel.body.style.transform = `translate3d(0, ${(-offset * state.step).toFixed(2)}px, 0)`;
  };

  const api = {
    config,

    /** Construye los seis carriles dentro del `.grid`. */
    mount() {
      if (!grid || typeof createCell !== 'function') return api;

      grid.textContent = '';
      state.reels = [];

      const fragment = document.createDocumentFragment();
      for (let col = 0; col < config.columns; col += 1) {
        const el = document.createElement('div');
        el.className = 'reel';
        el.dataset.col = String(col);
        /* Indice del carril (0..5): `style.css` lo usa para desfasar la onda
           suave del reposo y que recorra el tablero de izquierda a derecha. */
        el.style.setProperty('--col-index', String(col));
        el.style.setProperty('--reel-anticipation', `${config.anticipationMs}ms`);
        el.style.setProperty('--reel-delay', `${col * config.startStaggerMs}ms`);
        el.style.setProperty('--reel-bounce', `${config.bounceMs}ms`);
        el.style.setProperty('--reel-bounce-y', `${config.bouncePx}px`);
        el.style.setProperty('--reel-anticipate-y', `${Math.max(4, Math.round(config.bouncePx * 0.8))}px`);

        const body = document.createElement('div');
        body.className = 'reel__body';

        const strip = document.createElement('div');
        strip.className = 'reel__strip';

        /* Una celda de reserva arriba, `rows` visibles y una de reserva abajo. */
        for (let slot = 0; slot < config.rows + 2; slot += 1) {
          strip.appendChild(createCell(slot - 1, col));
        }

        body.appendChild(strip);
        el.appendChild(body);
        fragment.appendChild(el);

        state.reels.push({
          index: col,
          el,
          body,
          strip,
          phase: 'idle',
          pos: 0,
          recycled: 0,
          startRecycled: 0,
          speed: 0,
          blur: -1,
          startedAt: 0,
          stopScheduledAt: Infinity,
          stopStartedAt: 0,
          plan: null,
          injections: null,
          target: null,
          landTimer: 0
        });
      }

      grid.appendChild(fragment);
      clearBuffersAll();
      measure();
      return api;
    },

    measure,

    /** Nodos visibles en orden de fila, listos para indexar como `row * cols + col`. */
    visibleCells() {
      const out = [];
      for (const reel of state.reels) {
        const children = reel.strip.children;
        for (let row = 0; row < config.rows; row += 1) {
          out.push({ col: reel.index, row, el: children[row + 1] });
        }
      }
      return out;
    },

    isSpinning() {
      return state.running;
    },

    /** Arranca el giro: anticipacion, rampa y blur. Devuelve false sin animacion. */
    start() {
      if (REDUCED_MOTION || state.reels.length === 0) return false;

      api.cancelTimers();
      measure();
      /* Un reflow entre quitar y volver a poner las clases reinicia la
         anticipacion aunque el giro anterior acabe de terminar. */
      void grid.offsetWidth;

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      state.last = now;
      state.running = true;
      state.pending = state.reels.length;

      for (const reel of state.reels) {
        reel.phase = 'spin';
        reel.pos = 0;
        reel.recycled = 0;
        reel.startRecycled = 0;
        reel.speed = 0;
        reel.blur = -1;
        reel.startedAt = now + reel.index * config.startStaggerMs;
        reel.stopScheduledAt = Infinity;
        reel.stopStartedAt = 0;
        reel.plan = null;
        reel.injections = null;
        reel.target = null;
        reel.el.classList.remove('is-landed');
        reel.el.classList.add('is-spinning', 'is-anticipating');
        reel.el.style.filter = '';
        reel.body.style.transform = 'translate3d(0, 0, 0)';
      }

      if (!state.raf) state.raf = requestAnimationFrame(api.tick);
      return true;
    },

    /**
     * Programa la parada de cada carril, de izquierda a derecha, con el
     * resultado ya resuelto por el servidor.
     *
     * @param {Array<Array<string|{sym: string, bomb: number}|null>>} columns
     * @returns {number} ms hasta que el ultimo carril termina el rebote
     */
    stop(columns) {
      if (!state.running || state.reels.length === 0) {
        api.paintColumns(columns);
        return 0;
      }

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      /* Peor caso (offset 0 = recorrido mas largo): la duracion devuelta nunca
         se queda corta respecto al aterrizaje real de cada carril. */
      const estimate = stopPlan({ speed: config.maxSpeed, offset: 0, cfg: config });
      let wait = 0;

      for (const reel of state.reels) {
        reel.target = normalizeColumn(columns ? columns[reel.index] : null, config.rows);
        const earliest = Math.max(now, reel.startedAt + config.anticipationMs + config.minSpinMs);
        reel.stopScheduledAt = earliest + reel.index * config.stopStaggerMs;
        wait = Math.max(wait, reel.stopScheduledAt - now);
      }

      return Math.round(wait + timelineMs({
        reels: state.reels.length,
        staggerMs: 0,
        durationMs: estimate.durationMs,
        bounceMs: config.bounceMs
      }));
    },

    /**
     * Giro completo (`spin(targetSymbols)`): arranca y para con el resultado.
     *
     * @param {Array<Array<*>>} columns columnas (`columns[col][row]`) o matriz
     *   `matrix[row][col]` (se detecta sola)
     * @returns {Promise<number>} ms de la secuencia
     */
    async spin(columns) {
      const looksLikeMatrix = Array.isArray(columns)
        && columns.length === config.rows
        && Array.isArray(columns[0])
        && columns[0].length === config.columns;

      const target = looksLikeMatrix ? columnsFromMatrix(columns, config) : columns;

      if (!api.start()) {
        api.paintColumns(target);
        return 0;
      }

      const ms = api.stop(target);
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    },

    /** Pinta el resultado sin animacion (movimiento reducido o ronda repetida). */
    paintColumns(columns) {
      for (const { col, row, el } of api.visibleCells()) {
        const column = columns ? columns[col] : null;
        paintCell(el, normalizeColumn(column, config.rows)[row]);
      }
    },

    tick(now) {
      state.raf = 0;
      const dt = clamp((now - (state.last || now)) / 1000, 0, 0.064);
      state.last = now;

      let busy = false;
      for (const reel of state.reels) {
        if (api.step(reel, now, dt)) busy = true;
      }

      if (busy) state.raf = requestAnimationFrame(api.tick);
    },

    step(reel, now, dt) {
      if (reel.phase === 'idle' || reel.phase === 'settle') return false;
      if (now < reel.startedAt) return true;

      if (reel.el.classList.contains('is-anticipating')
        && now >= reel.startedAt + config.anticipationMs) {
        reel.el.classList.remove('is-anticipating');
      }

      if (reel.phase === 'spin') {
        reel.speed = speedAt(now - reel.startedAt, config);
        if (now >= reel.stopScheduledAt) api.beginStop(reel, now);
      }

      if (reel.phase === 'spin') {
        reel.pos += reel.speed * dt;
      } else if (reel.phase === 'stop') {
        const u = clamp((now - reel.stopStartedAt) / reel.plan.durationMs, 0, 1);
        const next = reel.stopFrom + reel.plan.distance * easeOutCubic(u);
        reel.speed = (next - reel.pos) / Math.max(dt, 1e-3);
        reel.pos = next;
      }

      /* Un reciclado por celda cruzada. El tope evita que un frame perdido
         encadene varias recolocaciones y se coma el siguiente frame. */
      let guard = 0;
      while (reel.pos - reel.recycled >= 1 && guard < 4) {
        api.recycle(reel);
        guard += 1;
      }
      if (reel.pos - reel.recycled >= 1) {
        reel.recycled = Math.floor(reel.pos);
        reel.pos = reel.recycled;
      }

      render(reel);

      const blur = blurForSpeed(reel.speed, config);
      if (blur !== reel.blur) {
        reel.blur = blur;
        reel.el.style.filter = blur > 0 ? `blur(${blur}px)` : '';
      }

      if (reel.phase === 'stop' && now - reel.stopStartedAt >= reel.plan.durationMs) {
        api.land(reel);
        return false;
      }
      return true;
    },

    beginStop(reel, now) {
      reel.phase = 'stop';
      reel.stopStartedAt = now;
      reel.stopFrom = reel.pos;
      reel.startRecycled = reel.recycled;

      const offset = reel.pos - reel.recycled;
      reel.plan = stopPlan({ speed: reel.speed, offset, cfg: config });
      reel.injections = stopInjections({
        cells: reel.plan.cells,
        rows: config.rows,
        target: reel.target,
        fill: randomCell
      });
    },

    recycle(reel) {
      const cell = reel.strip.firstElementChild;
      if (!cell) return;
      reel.strip.appendChild(cell);

      const cycle = reel.recycled - reel.startRecycled;
      const injected = reel.injections && cycle >= 0 && cycle < reel.injections.length
        ? reel.injections[cycle]
        : null;

      paintCell(cell, injected || randomCell());
      reel.recycled += 1;
    },

    /** Aterrizaje: fija el resultado, dispara el rebote y avisa a la capa de UI. */
    land(reel) {
      reel.phase = 'settle';
      reel.pos = reel.recycled;
      reel.speed = 0;
      reel.blur = 0;
      reel.el.style.filter = '';
      reel.el.classList.remove('is-spinning');
      reel.body.style.transform = 'translate3d(0, 0, 0)';

      const children = [...reel.strip.children];
      const visible = children.slice(1, config.rows + 1);

      visible.forEach((cell, row) => paintCell(cell, reel.target ? reel.target[row] : null));
      clearBuffers(reel);

      reel.el.classList.remove('is-landed');
      void reel.el.offsetWidth;
      reel.el.classList.add('is-landed');

      clearTimeout(reel.landTimer);
      reel.landTimer = setTimeout(() => {
        reel.el.classList.remove('is-landed');
        reel.phase = 'idle';
      }, config.bounceMs + 40);

      if (typeof onLand === 'function') onLand(reel.index, visible);

      state.pending = Math.max(0, state.pending - 1);
      if (state.pending === 0) {
        state.running = false;
        if (typeof onAllLanded === 'function') onAllLanded();
      }
    },

    cancelTimers() {
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
      for (const reel of state.reels) {
        clearTimeout(reel.landTimer);
        reel.landTimer = 0;
        reel.el.classList.remove('is-landed', 'is-spinning', 'is-anticipating');
        reel.el.style.filter = '';
        reel.phase = 'idle';
      }
      state.running = false;
      state.pending = 0;
    },

    /** Ajustes en caliente (por ejemplo desde una consola de desarrollo). */
    configure(partial = {}) {
      Object.assign(config, partial);
      measure();
      for (const reel of state.reels) {
        reel.el.style.setProperty('--reel-anticipation', `${config.anticipationMs}ms`);
        reel.el.style.setProperty('--reel-delay', `${reel.index * config.startStaggerMs}ms`);
        reel.el.style.setProperty('--reel-bounce', `${config.bounceMs}ms`);
        reel.el.style.setProperty('--reel-bounce-y', `${config.bouncePx}px`);
        reel.el.style.setProperty('--reel-anticipate-y', `${Math.max(4, Math.round(config.bouncePx * 0.8))}px`);
      }
      return config;
    },

    destroy() {
      api.cancelTimers();
      if (state.observer) state.observer.disconnect();
      state.observer = null;
      state.reels = [];
      if (grid) grid.textContent = '';
    }
  };

  function clearBuffersAll() {
    for (const reel of state.reels) clearBuffers(reel);
  }

  if (typeof ResizeObserver === 'function' && grid) {
    state.observer = new ResizeObserver(() => {
      measure();
      for (const reel of state.reels) render(reel);
    });
    state.observer.observe(grid);
  }

  return api;
}
