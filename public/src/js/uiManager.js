/**
 * Capa de presentacion.
 *
 * Este modulo NO decide nada del juego: recibe la respuesta ya resuelta por el
 * servidor y la reproduce. Cualquier importe mostrado proviene del payload
 * (`balance.credits`, `totalWinCredits`, ...), nunca de un calculo local.
 */

import {
  SYMBOL_KEYS,
  escapeHtml,
  formatCents,
  formatCredits,
  formatMultiplier,
  formatPercent,
  formatPlain,
  symbolMeta
} from './format.js';
import { createFx } from './fx.js';
import { columnsFromMatrix } from './reelMath.js';
import { createReels } from './reels.js';

const REDUCED_MOTION = typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const base = (ms) => (REDUCED_MOTION ? Math.min(ms, 20) : ms);

/**
 * Cascada de caida: cada columna arranca `DROP_STAGGER` ms despues de la
 * anterior y dentro de la columna la fila suma un escalon corto para que el
 * bloque no caiga como una losa rigida.
 *
 * `tile-drop` dura 300 ms y aterriza al 70 % (210 ms). Con la ultima columna
 * (delay 300 + 4 x 6 = 324 ms) el aterrizaje cae en 534 ms, antes de la espera
 * `TIMING.drop` (580 ms): cuando empieza el resaltado de premios todos los
 * simbolos ya estan en su celda.
 */
const DROP_STAGGER = 60;
const DROP_ROW_STAGGER = 6;
const DROP_MS = 300;
const DROP_LAND_RATIO = 0.7;

/* Dimensiones del tablero: cada columna es un rodillo. */
const ROWS = 5;
const COLS = 6;

export const TIMING = Object.freeze({
  reel: base(300),
  drop: base(580),
  hold: base(640),
  pop: base(300),
  settle: base(240)
});

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clasificacion visual de la ganancia segun multiplos de la apuesta. */
export function winLevel(winCents, betCents) {
  if (!betCents || betCents <= 0) return { key: 'win', label: 'GANANCIA' };
  const ratio = winCents / betCents;
  if (ratio >= 100) return { key: 'epic', label: '¡ÉPICA!' };
  if (ratio >= 25) return { key: 'mega', label: 'MEGA' };
  if (ratio >= 10) return { key: 'big', label: 'GRAN PREMIO' };
  return { key: 'win', label: 'GANANCIA' };
}

const LEVEL_LABEL = { win: 'GANANCIA', big: 'GRAN PREMIO', mega: 'MEGA', epic: '¡ÉPICA!' };

export class Ui {
  constructor() {
    this.tiles = [];
    this.refs = {};
    this.gameInfo = null;
    this.currency = 'EUR';
    this.featureCostMultiplier = 100;
    this.busy = false;
    this.isDemo = false;
    this.demoCurrency = 'VES';
    this.demoStartCredits = 1000;
    this.handlers = { onSound: null, onReelLand: null };

    /* Capa de particulas y celebraciones (se monta en `mount`). */
    this.fx = null;
    /* Rodillos: cada columna del tablero es un carril animado. */
    this.reels = null;
    /* Imagenes de simbolos precargadas para que el reciclado no parpadee. */
    this.preloaded = null;
    /* Conteo ascendente de la ganancia: valor mostrado y frame pendiente. */
    this.winShownCents = 0;
    this.winRaf = 0;
    /* Temporizadores de los efectos del marco y del HUD. */
    this.landTimer = 0;
    this.landOffTimer = 0;
    this.frameShakeTimer = 0;
    this.hudTimer = 0;
    this.mxTimer = 0;
  }

  mount() {
    const byId = (id) => document.getElementById(id);

    this.refs = {
      grid: byId('grid'),
      banner: byId('banner'),
      bannerLevel: byId('banner-level'),
      bannerAmount: byId('banner-amount'),
      spinTag: byId('spin-tag'),
      betValue: byId('bet-value'),
      betReadout: byId('bet-readout'),
      winValue: byId('win-value'),
      mxValue: byId('mx-value'),
      balanceValue: byId('balance-value'),
      balanceCurrency: byId('balance-currency'),
      demoBtn: byId('btn-demo'),
      demoSub: byId('demo-sub'),
      spinBtn: byId('btn-spin'),
      spinLabel: byId('spin-label'),
      featureBtn: byId('btn-feature'),
      featureCost: byId('feature-cost'),
      autoBtn: byId('btn-auto'),
      autoCount: byId('auto-count'),
      betUp: byId('btn-bet-up'),
      betDown: byId('btn-bet-down'),
      betMax: byId('btn-bet-max'),
      status: byId('status-text'),
      engine: byId('engine-text'),
      soundBtn: byId('btn-sound'),
      helpBtn: byId('btn-help'),
      history: byId('history'),
      toasts: byId('toasts'),
      modal: byId('modal'),
      modalTitle: byId('modal-title'),
      modalBody: byId('modal-body'),
      modalClose: byId('btn-modal-close'),
      infoState: byId('info-state'),
      infoRound: byId('info-round'),
      infoSeedHash: byId('info-seedhash'),
      infoClientSeed: byId('info-clientseed'),
      infoDraws: byId('info-draws'),
      infoRtpBase: byId('info-rtp-base'),
      infoRtpFeature: byId('info-rtp-feature'),
      infoCap: byId('info-cap')
    };

    /* Contenedores que reciben los efectos de impacto y de camara. */
    this.refs.board = document.querySelector('.board');
    this.refs.frame = document.querySelector('.machine__table');
    this.fx = createFx();

    this.buildGrid();

    this.refs.modalClose.addEventListener('click', () => this.closeModal());
    this.refs.modal.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement && event.target.dataset.close === '1') this.closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeModal();
    });
    this.refs.helpBtn.addEventListener('click', () => this.showInfo());
    this.refs.soundBtn.addEventListener('click', () => {
      if (typeof this.handlers.onSound === 'function') this.handlers.onSound();
    });

    this.renderPlaceholderGrid();
    this.renderHistoryEmpty();
  }

  /* ---------------------------------------------------------------- tablero */

  buildGrid() {
    const grid = this.refs.grid;
    grid.textContent = '';
    this.tiles = [];

    this.reels = createReels({
      grid,
      rows: ROWS,
      columns: COLS,
      symbols: SYMBOL_KEYS,
      createCell: (row, col) => this.createTile_(row, col),
      paint: (cell, symbol, bombValue) => this.paintCell_(cell, symbol, bombValue),
      /* Al aterrizar cada carril sus casillas visibles cambian de nodo: la
         lista `tiles` se reengancha para que premios, bombas y cascadas sigan
         apuntando a lo que el jugador ve. */
      onLand: (col, cells) => {
        this.syncColumn_(col, cells);
        if (typeof this.handlers.onReelLand === 'function') this.handlers.onReelLand(col);
      },
      onAllLanded: () => this.dropImpact()
    });

    this.reels.mount();

    for (const { row, col, el } of this.reels.visibleCells()) {
      this.tiles[row * COLS + col] = el;
    }
  }

  /** Casilla: imagen del simbolo con glifo accesible de reserva. */
  createTile_(row, col) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.sym = 'S1';
    tile.dataset.row = String(row);
    tile.dataset.col = String(col);

    const image = document.createElement('img');
    image.className = 'tile__img';
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    image.addEventListener('error', () => {
      image.hidden = true;
      const fallback = tile.querySelector('.tile__glyph');
      if (fallback) fallback.hidden = false;
    });

    const glyph = document.createElement('span');
    glyph.className = 'tile__glyph';
    glyph.setAttribute('aria-hidden', 'true');

    tile.append(image, glyph);
    return tile;
  }

  /** Fija la columna del carril tras su aterrizaje. */
  syncColumn_(col, cells) {
    for (let row = 0; row < ROWS; row += 1) {
      const tile = cells[row];
      if (!tile) continue;
      /* El nodo puede venir de la cascada anterior: se limpia antes de que
         `highlightCells` lo marque como premio. */
      tile.classList.remove('tile--drop', 'tile--win', 'tile--scatter', 'tile--pop');
      this.tiles[row * COLS + col] = tile;
    }
  }

  paintCell_(tile, symbol, bombValue = 0) {
    if (!tile) return;
    const meta = symbol ? symbolMeta(symbol) : null;
    const image = tile.querySelector('.tile__img');
    const glyph = tile.querySelector('.tile__glyph');

    tile.dataset.sym = symbol || '';
    tile.classList.toggle('tile--empty', !symbol);
    tile.setAttribute('aria-label', meta ? meta.name : 'Casilla vacía');

    if (glyph) {
      glyph.textContent = meta ? meta.glyph : '';
      glyph.hidden = Boolean(meta && meta.image);
    }

    if (image) {
      if (meta && meta.image) {
        if (image.getAttribute('src') !== meta.image) image.src = meta.image;
        image.hidden = false;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
      }
    }

    let badge = tile.querySelector('.tile__bomb-value');
    if (bombValue > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'tile__bomb-value';
        tile.appendChild(badge);
      }
      badge.textContent = `${formatPlain(bombValue)}×`;
    } else if (badge) {
      badge.remove();
    }
  }

  setTile(index, symbol, bombValue = 0) {
    this.paintCell_(this.tiles[index], symbol, bombValue);
  }

  /** Matriz del servidor -> columnas del rodillo con su bomba. */
  columns_(matrix, bombs = []) {
    const bombMap = new Map();
    for (const bomb of bombs || []) bombMap.set(bomb.r * COLS + bomb.c, bomb.value);

    return columnsFromMatrix(matrix, { rows: ROWS, columns: COLS }).map((column, col) =>
      column.map((symbol, row) => ({ sym: symbol, bomb: bombMap.get(row * COLS + col) || 0 })));
  }

  /**
   * Pinta una matriz del servidor (`grid[row][col]`).
   *
   * Con los rodillos girando no se pinta a mano: se ordena la parada de cada
   * carril, que inyecta el resultado mientras frena y lo fija al aterrizar.
   *
   * @param {Array<Array<string>>} matrix
   * @param {Array<{r:number,c:number,value:number}>} [bombs]
   * @param {{drop?: boolean}} [options]
   * @returns {number} ms que dura la entrada del tablero (0 sin animacion)
   */
  renderGrid(matrix, bombs = [], { drop = true } = {}) {
    if (drop && this.reels && this.reels.isSpinning()) {
      return this.reels.stop(this.columns_(matrix, bombs));
    }

    const bombMap = new Map();
    for (const bomb of bombs || []) bombMap.set(bomb.r * COLS + bomb.c, bomb.value);

    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const index = row * COLS + col;
        const symbol = matrix && matrix[row] ? matrix[row][col] : null;
        this.paintCell_(this.tiles[index], symbol, bombMap.get(index) || 0);
      }
    }

    return drop ? this.playDrop() : 0;
  }

  renderPlaceholderGrid() {
    const pool = SYMBOL_KEYS.concat(['SC', 'MX', 'S1', 'S4', 'S6', 'S8']);
    const matrix = Array.from({ length: 5 }, (_, row) =>
      Array.from({ length: 6 }, (_, col) => pool[(row * 6 + col) % pool.length]));
    this.renderGrid(matrix, [], { drop: false });
  }

  /**
   * Caida en cascada: las seis columnas aterrizan escalonadas de izquierda a
   * derecha (`DROP_STAGGER` ms) con un micro escalon por fila dentro de cada
   * columna.
   *
   * El retardo viaja en la custom property `--drop-delay`: asi no queda un
   * `animation-delay` inline que retrasaria despues `tile--win` o `tile--pop`.
   *
   * @returns {number} ms que tarda en caer la ultima columna
   */
  playDrop() {
    let lastDelay = 0;

    this.tiles.forEach((tile, index) => {
      tile.classList.remove('tile--drop', 'tile--win', 'tile--pop');
      if (REDUCED_MOTION) return;

      const row = Math.floor(index / COLS);
      const col = index % COLS;
      const delay = col * DROP_STAGGER + row * DROP_ROW_STAGGER;
      if (delay > lastDelay) lastDelay = delay;

      void tile.offsetWidth; // reinicia la animacion
      tile.style.setProperty('--drop-delay', `${delay}ms`);
      tile.classList.add('tile--drop');
    });

    if (REDUCED_MOTION) return 0;

    this.scheduleLanding_(lastDelay + DROP_MS * DROP_LAND_RATIO);
    return lastDelay + DROP_MS;
  }

  /**
   * Micro-impacto del marco justo cuando la ultima columna toca su celda: hace
   * de contrapeso sonoro/visual y da peso al aterrizaje.
   */
  scheduleLanding_(atMs) {
    clearTimeout(this.landTimer);
    this.landTimer = setTimeout(() => this.dropImpact(), Math.max(0, atMs));
  }

  dropImpact() {
    const board = this.refs.board;
    if (!board || REDUCED_MOTION) return;

    board.classList.remove('is-landing');
    void board.offsetWidth;
    board.classList.add('is-landing');

    clearTimeout(this.landOffTimer);
    this.landOffTimer = setTimeout(() => board.classList.remove('is-landing'), 430);
  }

  startSpinning() {
    if (this.fx) this.fx.clear();
    this.clearHighlights();
    this.preloadSymbols_();

    if (!this.reels || !this.reels.start()) {
      /* Movimiento reducido (o tablero sin montar): sin giro, pero con
         feedback inmediato para que la tirada no parezca congelada. */
      this.tiles.forEach((tile, index) => {
        this.paintCell_(tile, SYMBOL_KEYS[(index + 3) % SYMBOL_KEYS.length], 0);
      });
    }
  }

  /**
   * Giro completo de los rodillos con el resultado ya resuelto por el servidor.
   *
   * Es la API comoda para probar el efecto o para integrarlo desde otra capa:
   * arranca (anticipacion + motion blur), para de izquierda a derecha con
   * rebote y resuelve cuando el ultimo carril ha aterrizado.
   *
   * @param {Array<Array<string>>} targetSymbols matriz `matrix[row][col]`
   * @param {{bombs?: Array<{r:number,c:number,value:number}>}} [options]
   * @returns {Promise<number>} ms de la secuencia
   */
  async spin(targetSymbols, { bombs = [] } = {}) {
    if (!this.reels) return 0;
    this.clearHighlights();
    const ms = await this.reels.spin(this.columns_(targetSymbols, bombs));
    return ms;
  }

  /** Precarga las imagenes de los simbolos: el reciclado no debe parpadear. */
  preloadSymbols_() {
    if (this.preloaded || typeof Image !== 'function') return;
    this.preloaded = [];
    for (const key of SYMBOL_KEYS) {
      const meta = symbolMeta(key);
      if (!meta || !meta.image) continue;
      const image = new Image();
      image.decoding = 'async';
      image.src = meta.image;
      this.preloaded.push(image);
    }
  }

  clearHighlights() {
    this.tiles.forEach((tile) => {
      tile.classList.remove('tile--win', 'tile--scatter', 'tile--pop');
    });
  }

  /** Chispas sobre una muestra de las celdas premiadas. */
  burst_(indexes, power = 1, maxCells = 18) {
    if (!this.fx || !indexes || indexes.length === 0) return;
    const step = Math.max(1, Math.ceil(indexes.length / maxCells));
    const sample = [];
    for (let i = 0; i < indexes.length; i += step) {
      const tile = this.tiles[indexes[i]];
      if (tile) sample.push(tile);
    }
    this.fx.sparkBurst(sample, { power });
  }

  /** Marca celdas [[r,c], ...] y devuelve los indices afectados. */
  highlightCells(cells, className = 'tile--win') {
    const indexes = [];
    for (const cell of cells || []) {
      const [r, c] = Array.isArray(cell) ? cell : [cell.r, cell.c];
      const index = r * 6 + c;
      const tile = this.tiles[index];
      if (!tile) continue;
      tile.classList.add(className);
      indexes.push(index);
    }
    /* Chispas doradas al encenderse el premio (solo en celdas ganadoras). */
    if (className === 'tile--win') this.burst_(indexes, 1, 18);
    return indexes;
  }

  async popCells(cells) {
    const indexes = [];
    for (const cell of cells || []) {
      const [r, c] = Array.isArray(cell) ? cell : [cell.r, cell.c];
      const tile = this.tiles[r * 6 + c];
      if (!tile) continue;
      tile.classList.remove('tile--win', 'tile--scatter');
      tile.classList.add('tile--pop');
      indexes.push(r * 6 + c);
    }

    /* Segunda tanda, mas abierta: acompana la explosion de las celdas. */
    this.burst_(indexes, 2, 12);

    await sleep(TIMING.pop);
    for (const index of indexes) {
      const tile = this.tiles[index];
      if (tile) tile.classList.remove('tile--pop');
    }
  }

  shakeGrid() {
    const grid = this.refs.grid;
    grid.classList.remove('is-shaking');
    void grid.offsetWidth;
    grid.classList.add('is-shaking');
    setTimeout(() => grid.classList.remove('is-shaking'), 360);
  }

  /**
   * Temblor del marco completo (MEGA WIN). Se aplica a `.machine__table`, que
   * pinta el dibujo del marco y contiene el tablero, para que tiemble la
   * ventana de juego y no el HUD ni la consola.
   */
  shakeFrame() {
    const frame = this.refs.frame;
    if (!frame || REDUCED_MOTION) return;

    frame.classList.remove('is-quaking');
    void frame.offsetWidth;
    frame.classList.add('is-quaking');

    clearTimeout(this.frameShakeTimer);
    this.frameShakeTimer = setTimeout(() => frame.classList.remove('is-quaking'), 660);
  }

  /**
   * Escala de celebracion segun el nivel de premio que ya calculo el servidor:
   *
   *   win  -> el brillo y las chispas ya los puso `tile--win`.
   *   big  -> destello de pantalla + enfasis del HUD (el conteo ascendente va
   *           en `setWin`).
   *   mega -> cartel 3D, lluvia de monedas y temblor del marco.
   *   epic -> lo mismo, con mas intensidad.
   *
   * @param {string} level clave de `winLevel`
   * @param {string} amountText importe ya formateado
   */
  celebrate(level, amountText) {
    const key = LEVEL_LABEL[level] ? level : 'win';
    this.bumpHud_(key);
    if (!this.fx) return;

    if (key === 'big') {
      this.fx.flash({ power: 0.5 });
      return;
    }

    if (key === 'mega' || key === 'epic') {
      const huge = key === 'epic';
      this.fx.flash({ power: huge ? 1 : 0.8 });
      this.fx.coinRain({ count: huge ? 44 : 34 });
      const card = this.fx.mega(huge ? '¡ÉPICA GANANCIA!' : '¡MEGA GANANCIA!', amountText);

      /* El cartel 3D sustituye al banner del tablero, que quedaria detras con
         el mismo importe. Con movimiento reducido no hay cartel y el banner se
         queda como unico mensaje. */
      if (card && this.refs.banner) this.refs.banner.classList.remove('is-visible');

      this.shakeFrame();
    }
  }

  /** Enfasis de la placa de ganancia y del multiplicador (solo transform). */
  bumpHud_(key) {
    if (REDUCED_MOTION || key === 'win') return;

    const winCell = this.refs.winValue ? this.refs.winValue.closest('.hud__cell') : null;
    const mxCell = this.refs.mxValue ? this.refs.mxValue.closest('.hud__cell') : null;
    const huge = key === 'mega' || key === 'epic';

    if (winCell) {
      winCell.classList.remove('is-win-big', 'is-win-huge');
      void winCell.offsetWidth;
      winCell.classList.add(huge ? 'is-win-huge' : 'is-win-big');
    }
    if (mxCell) {
      mxCell.classList.remove('is-hot', 'is-hot-max');
      void mxCell.offsetWidth;
      mxCell.classList.add(huge ? 'is-hot-max' : 'is-hot');
    }

    clearTimeout(this.hudTimer);
    this.hudTimer = setTimeout(() => {
      if (winCell) winCell.classList.remove('is-win-big', 'is-win-huge');
      if (mxCell) mxCell.classList.remove('is-hot', 'is-hot-max');
    }, huge ? 1000 : 700);
  }

  /* -------------------------------------------------------------------- HUD */

  setBalance(credits, { deltaCents = 0 } = {}) {
    const node = this.refs.balanceValue;
    node.textContent = formatCredits(credits);
    node.classList.remove('is-up', 'is-down');
    if (deltaCents > 0) node.classList.add('is-up');
    if (deltaCents < 0) node.classList.add('is-down');
    setTimeout(() => node.classList.remove('is-up', 'is-down'), 520);
  }

  setCurrency(currency) {
    this.currency = currency || 'EUR';
    if (this.refs.balanceCurrency) this.refs.balanceCurrency.textContent = this.currency;
  }

  /**
   * Refleja en la interfaz si el jugador esta en modo "Fichas de Prueba".
   * El saldo mostrado sigue viniendo del servidor (cartera virtual), nunca de
   * un calculo local.
   *
   * @param {boolean} active
   * @param {{ label?: string|null }} [options] texto del subtitulo del boton
   */
  setDemoMode(active, { label = null } = {}) {
    this.isDemo = Boolean(active);
    document.body.classList.toggle('is-demo', this.isDemo);

    const button = this.refs.demoBtn;
    if (!button) return;
    button.setAttribute('aria-pressed', this.isDemo ? 'true' : 'false');
    button.classList.toggle('is-active', this.isDemo);
    button.title = this.isDemo
      ? `Modo Fichas de Prueba activo · pulsa para empezar de nuevo con ${formatCredits(this.demoStartCredits)} ${this.demoCurrency} virtuales`
      : `Jugar gratis con ${formatCredits(this.demoStartCredits)} ${this.demoCurrency} virtuales`;

    if (this.refs.demoSub) {
      this.refs.demoSub.textContent = this.isDemo
        ? (label || 'Modo activo')
        : `${formatCredits(this.demoStartCredits)} ${this.demoCurrency}`;
    }
  }

  setBet(credits) {
    this.refs.betValue.textContent = formatCredits(credits);
    this.refs.betReadout.textContent = formatCredits(credits);
    this.refs.featureCost.textContent =
      `${this.featureCostMultiplier}× · ${formatCredits(credits * this.featureCostMultiplier)}`;
  }

  /**
   * Pinta la ganancia acumulada.
   *
   * Con `roll` el numero asciende desde el valor mostrado hasta el objetivo con
   * `requestAnimationFrame` (solo escribe texto, no mueve layout). El importe
   * final es siempre el del servidor: el conteo es puramente visual.
   *
   * @param {number} cents importe autoritativo del payload
   * @param {{roll?: boolean, level?: string}} [options]
   */
  setWin(cents, { roll = false, level = 'win' } = {}) {
    const target = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
    const node = this.refs.winValue;

    this.cancelWinRoll_();

    if (!roll || REDUCED_MOTION || typeof requestAnimationFrame !== 'function' || target <= this.winShownCents) {
      this.winShownCents = target;
      node.textContent = formatCents(target);
      return;
    }

    const from = this.winShownCents;
    const duration = level === 'win' ? 420 : 520;
    const started = performance.now();

    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const value = Math.round(from + (target - from) * eased);

      this.winShownCents = value;
      node.textContent = formatCents(value);

      if (progress < 1) {
        this.winRaf = requestAnimationFrame(step);
        return;
      }

      this.winRaf = 0;
      this.winShownCents = target;
      node.textContent = formatCents(target);
    };

    this.winRaf = requestAnimationFrame(step);
  }

  cancelWinRoll_() {
    if (this.winRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.winRaf);
    this.winRaf = 0;
  }

  setMultiplier(value) {
    const active = Boolean(value && value > 1);
    this.refs.mxValue.textContent = active ? formatMultiplier(value) : '—';

    const cell = this.refs.mxValue.closest('.hud__cell');
    if (!cell || !active || REDUCED_MOTION) return;

    /* Pulso corto en cada subida del multiplicador (bonus de 10 giros). */
    cell.classList.remove('is-tick');
    void cell.offsetWidth;
    cell.classList.add('is-tick');

    clearTimeout(this.mxTimer);
    this.mxTimer = setTimeout(() => cell.classList.remove('is-tick'), 640);
  }

  setStatus(text) {
    this.refs.status.textContent = text;
  }

  setEngineText(text) {
    this.refs.engine.textContent = text;
  }

  setBusy(busy) {
    this.busy = Boolean(busy);
    this.refs.spinBtn.classList.toggle('is-busy', busy);
    this.refs.spinBtn.disabled = Boolean(busy);
    this.refs.spinBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    this.refs.spinLabel.textContent = busy ? 'GIRANDO…' : 'SPIN';
    this.refs.betUp.disabled = Boolean(busy);
    this.refs.betDown.disabled = Boolean(busy);
    this.refs.betMax.disabled = Boolean(busy);
    this.refs.featureBtn.disabled = Boolean(busy);
  }

  /** Habilita/deshabilita acciones segun el saldo autoritativo. */
  updateAffordability(balanceCents, betCents) {
    if (this.busy) return;
    this.refs.spinBtn.disabled = balanceCents < betCents;
    this.refs.featureBtn.disabled = balanceCents < betCents * this.featureCostMultiplier;
  }

  setAuto(active, remaining = 0) {
    this.refs.autoBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    this.refs.autoCount.textContent = active ? String(remaining) : '10';
  }

  setSpinTag(text) {
    const node = this.refs.spinTag;
    if (!text) {
      node.classList.remove('is-visible');
      node.textContent = '';
      return;
    }
    node.textContent = text;
    node.classList.add('is-visible');
  }

  showBanner(level, amountText) {
    const banner = this.refs.banner;
    const key = LEVEL_LABEL[level] ? level : 'win';
    banner.classList.remove('banner--big', 'banner--mega', 'banner--epic');
    if (key !== 'win') banner.classList.add(`banner--${key}`);
    this.refs.bannerLevel.textContent = LEVEL_LABEL[key];
    this.refs.bannerAmount.textContent = amountText;
    banner.classList.add('is-visible');
  }

  hideBanner() {
    this.refs.banner.classList.remove('is-visible');
  }

  /* ----------------------------------------------------------------- toasts */

  toast(message, { type = 'info', timeout = 4200 } = {}) {
    const node = document.createElement('div');
    node.className = `toast toast--${type}`;
    node.textContent = message;
    this.refs.toasts.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      setTimeout(() => node.remove(), 240);
    }, timeout);
  }

  /* --------------------------------------------------------------- historial */

  renderHistoryEmpty() {
    this.refs.history.textContent = '';
    const item = document.createElement('li');
    item.className = 'is-empty';
    item.textContent = 'Todavía no hay tiradas';
    this.refs.history.appendChild(item);
  }

  addHistory({ winCents, betCents, mode, spins }) {
    const empty = this.refs.history.querySelector('.is-empty');
    if (empty) empty.remove();

    const item = document.createElement('li');
    if (winCents > 0) item.classList.add('is-win');

    const left = document.createElement('span');
    left.textContent = mode === 'BUY_FEATURE'
      ? `Bonus · ${spins} giros`
      : `Base · ${formatCents(betCents)}`;

    const right = document.createElement('span');
    right.textContent = formatCents(winCents);

    item.append(left, right);
    this.refs.history.prepend(item);

    while (this.refs.history.children.length > 8) {
      this.refs.history.lastElementChild.remove();
    }
  }

  /* ------------------------------------------------------- panel de auditoria */

  setRoundInfo({ state, roundId = null, serverSeedHash = null, clientSeed = null, rngDraws = null } = {}) {
    if (state) this.refs.infoState.textContent = state;
    this.refs.infoRound.textContent = roundId ? String(roundId).slice(0, 18) : '—';
    this.refs.infoRound.title = roundId || '';
    this.refs.infoSeedHash.textContent = serverSeedHash || '—';
    this.refs.infoClientSeed.textContent = clientSeed || '—';
    this.refs.infoDraws.textContent = Number.isFinite(rngDraws) ? formatPlain(rngDraws) : '—';
  }

  /* ---------------------------------------------------------- info del juego */

  setGameInfo(info) {
    this.gameInfo = info;
    this.featureCostMultiplier = info && info.feature ? info.feature.costMultiplier : 100;
    const rtp = (info && info.certifiedRtp) || {};
    this.refs.infoRtpBase.textContent = formatPercent(rtp.base);
    this.refs.infoRtpFeature.textContent = formatPercent(rtp.feature);
    this.refs.infoCap.textContent = `${formatPlain((info && info.maxExposureMultiplier) || 10000)}×`;
    this.refs.featureBtn.querySelector('.btn__title').textContent =
      (info && info.feature && info.feature.label) || 'Tropical Fever';
    this.setEngineText(
      info ? `${info.code} · v${info.engineVersion} · ${info.paytableVersion}` : ''
    );

    /* Modo "Fichas de Prueba": el backend publica saldo/moneda en /api/game. */
    const demo = (info && info.demo) || {};
    this.demoCurrency = demo.currency || 'VES';
    this.demoStartCredits = Number.isFinite(demo.startBalanceCredits)
      ? demo.startBalanceCredits
      : 1000;
    if (this.refs.demoBtn) {
      this.refs.demoBtn.hidden = demo.enabled === false;
      this.refs.demoBtn.title = demo.enabled === false
        ? 'Modo Fichas de Prueba desactivado en este servidor'
        : `Jugar gratis con ${formatCredits(this.demoStartCredits)} ${this.demoCurrency} virtuales`;
    }
    this.setDemoMode(this.isDemo);
  }

  /* ------------------------------------------------------------------- modal */

  openModal(title, html) {
    this.refs.modalTitle.textContent = title;
    this.refs.modalBody.innerHTML = html;
    this.refs.modal.hidden = false;
    this.refs.modalClose.focus();
  }

  closeModal() {
    if (this.refs.modal.hidden) return;
    this.refs.modal.hidden = true;
    this.refs.modalBody.textContent = '';
  }

  showInfo() {
    if (!this.gameInfo) {
      this.openModal('Reglas', '<p>Cargando información del juego…</p>');
      return;
    }
    this.openModal('Reglas y tabla de pagos', this.buildInfoHtml_());
  }

  /**
   * Puerta de autenticacion manual: se usa cuando el backend no emite tokens
   * (ALLOW_DEV_SESSION=false) y no hay token en la URL ni en la sesion.
   *
   * Incluye la alternativa "Fichas de Prueba", que no necesita token real.
   *
   * @param {object} options
   * @param {(token: string) => void} options.onSubmit token pegado por el usuario
   * @param {(() => void)|null} [options.onDemo]    entrar en modo invitado
   */
  showAuthGate({ onSubmit, onDemo = null } = {}) {
    const demoBlock = onDemo
      ? `<button class="btn btn--demo auth-form__demo" id="auth-demo" type="button">
           <span class="btn__title">Fichas de Prueba</span>
           <span class="btn__sub">Jugar gratis · saldo virtual</span>
         </button>`
      : '';

    const html = `
      <h3>Sesión requerida</h3>
      <p>Este servidor no emite sesiones de prueba. Pega el token emitido por el
      operador (por ejemplo el que genera <code>npm run token</code>) o abre la
      página con <code>?token=…</code>.</p>
      <form class="auth-form">
        <label class="auth-form__label" for="token-input">Token de sesión</label>
        <input class="auth-form__input" id="token-input" type="password"
               autocomplete="off" spellcheck="false" placeholder="t1.…" />
        <button class="btn btn--spin auth-form__submit" type="submit">ENTRAR</button>
      </form>
      ${demoBlock}`;

    this.openModal('Sesión requerida', html);

    const form = this.refs.modalBody.querySelector('.auth-form');
    const input = this.refs.modalBody.querySelector('#token-input');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      this.closeModal();
      onSubmit(value);
    });

    if (onDemo) {
      const demoButton = this.refs.modalBody.querySelector('#auth-demo');
      demoButton.addEventListener('click', () => {
        this.closeModal();
        onDemo();
      });
    }

    input.focus();
  }

  /** HTML del modal informativo, generado desde /api/game. */
  buildInfoHtml_() {
    const info = this.gameInfo;
    const tiers = ['8', '10', '12'];

    const clusterRows = SYMBOL_KEYS.map((symbol) => {
      const meta = symbolMeta(symbol);
      const pays = (info.clusterPays && info.clusterPays[symbol]) || {};
      const cells = tiers.map((tier) => `<td>${formatPlain(pays[tier] || 0)}×</td>`).join('');
      return `<tr><td><span class="paytable__symbol"><img class="paytable__icon" src="${escapeHtml(meta.image)}" alt="" />${escapeHtml(meta.name)}</span></td>${cells}</tr>`;
    }).join('');

    const scatter = info.scatterPays || {};
    const scatterCells = ['3', '4', '5', '6'].map((key) => `<td>${formatPlain(scatter[key] || 0)}×</td>`).join('');

    const distribution = (info.multiplier && info.multiplier.distribution) || {};
    const multiplierItems = Object.keys(distribution)
      .map(Number)
      .sort((a, b) => a - b)
      .map((value) => `<li>${formatMultiplier(value)}: <strong>${(distribution[value] * 100).toFixed(2)} %</strong></li>`)
      .join('');

    const rules = (info.rules || []).map((rule) => `<li>${escapeHtml(rule)}</li>`).join('');
    const rtp = info.certifiedRtp || {};
    const feature = info.feature || {};
    const ladder = (info.betLadder || []).map((value) => formatCredits(value)).join(' · ');

    return `
      <h3>Cómo se juega</h3>
      <ul>${rules}</ul>
      <p>Cuadrícula de <strong>${info.grid.cols} × ${info.grid.rows}</strong> y agrupaciones
      mínimas de <strong>${info.minClusterSize}</strong> símbolos conectados en horizontal o vertical.</p>

      <h3>Pagos por agrupación (× apuesta)</h3>
      <table class="paytable">
        <thead><tr><th>Símbolo</th><th>8–9</th><th>10–11</th><th>12+</th></tr></thead>
        <tbody>${clusterRows}</tbody>
      </table>

      <h3>Scatter 🍭 (solo tirada inicial)</h3>
      <table class="paytable">
        <thead><tr><th>Cantidad</th><th>3</th><th>4</th><th>5</th><th>6+</th></tr></thead>
        <tbody><tr><td>Pago × apuesta</td>${scatterCells}</tr></tbody>
      </table>

      <h3>Bombas multiplicadoras 💣</h3>
      <p>${escapeHtml((info.multiplier && info.multiplier.rule) || '')}</p>
      <p>Reparto de valores por bomba:</p>
      <ul>${multiplierItems}</ul>

      <h3>Modo bonus · ${escapeHtml(feature.label || 'Tropical Fever')}</h3>
      <p>Compra directa por <strong>${formatPlain(feature.costMultiplier || 100)}×</strong> la apuesta base
      (${formatCredits((feature.costMultiplier || 100) * (info.betLadder ? info.betLadder[0] : 1))} con la apuesta mínima)
      y <strong>${formatPlain(feature.spins || 10)}</strong> tiradas con tiras de mayor volatilidad.</p>

      <h3>RTP y límites</h3>
      <ul>
        <li>RTP certificado del modo base: <strong>${formatPercent(rtp.base)}</strong></li>
        <li>RTP certificado del modo bonus: <strong>${formatPercent(rtp.feature)}</strong></li>
        <li>Ganancia máxima por ronda: <strong>${formatPlain(info.maxExposureMultiplier)}×</strong> la apuesta base</li>
        <li>Motor ${escapeHtml(info.engineVersion)} · tabla de pagos ${escapeHtml(info.paytableVersion)}</li>
      </ul>

      <h3>Escalera de apuestas</h3>
      <p>${ladder}</p>

      <h3>Transparencia</h3>
      <p>Cada ronda se resuelve en el servidor con un CSPRNG (HMAC-SHA256) y se guarda con
      el hash de la semilla del servidor, la semilla del cliente y el número de extracciones.
      El cliente solo reproduce la animación: no calcula premios ni saldo.</p>`;
  }
}
