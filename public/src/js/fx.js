/**
 * Capa de efectos visuales (game feel).
 *
 * Este modulo SOLO pinta decoracion: no decide premios, no lee el estado del
 * motor y no toca el saldo. Los textos llegan ya formateados desde
 * `uiManager` (importes del payload) y jamas se inserta HTML ajeno: todo se
 * construye con `createElement` + `textContent`.
 *
 * Reglas de rendimiento:
 *   - Cada particula anima unicamente `transform` y `opacity`, de modo que el
 *     navegador la resuelve en el compositor (sin layout ni paint por frame).
 *   - Los nodos se autodestruyen con `animationend` y con un temporizador de
 *     respaldo (una pestana en segundo plano no dispara animaciones).
 *   - Hay un presupuesto de nodos vivos: si la pantalla ya esta llena, el
 *     efecto nuevo se descarta en lugar de acumular trabajo.
 *   - Con `prefers-reduced-motion` no se crea ninguna particula.
 */

const SPARK_COLORS = ['#fff6b0', '#ffd35c', '#ff9ad8', '#8ce9ff', '#ffb072'];
const COIN_FACES = ['🪙', '🍬', '🍭', '💎'];

/** Presupuesto de nodos simultaneos de la capa (chispas + monedas + cartel). */
const NODE_BUDGET = 120;

const CAN_ANIMATE = typeof window !== 'undefined'
  && typeof document !== 'undefined'
  && (typeof window.matchMedia !== 'function'
    || !window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const fixed = (value) => value.toFixed(1);

export function createFx() {
  let layer = null;
  let megaNode = null;
  const timers = new Set();

  /** Contenedor fijo a pantalla completa, compartido por todos los efectos. */
  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.getElementById('fx');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'fx';
      layer.className = 'fx';
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }
    return layer;
  }

  /**
   * Programa la retirada del nodo.
   *
   * `onEnd` escucha `animationend`; se desactiva en nodos con animaciones
   * encadenadas o pseudo-elementos animados, donde el primer evento no marca el
   * final real.
   */
  function track(el, lifeMs, { onEnd = true } = {}) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      el.remove();
    }, lifeMs);
    timers.add(timer);

    if (onEnd) {
      el.addEventListener('animationend', () => {
        clearTimeout(timer);
        timers.delete(timer);
        el.remove();
      }, { once: true });
    }
    return el;
  }

  /** Retira todos los efectos vivos (se usa al empezar una tirada nueva). */
  function clear() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    megaNode = null;
    if (layer) layer.textContent = '';
  }

  /**
   * Chispas que emergen de las celdas premiadas.
   *
   * Lee primero TODOS los rectangulos y solo despues crea nodos, para provocar
   * un unico calculo de layout en lugar de uno por celda.
   *
   * @param {Element[]} tiles celdas ganadoras
   * @param {{power?: number}} [options] 1 = resaltado, 2 = explosion
   */
  function sparkBurst(tiles, { power = 1 } = {}) {
    if (!CAN_ANIMATE || !tiles || tiles.length === 0 || document.hidden) return;

    const host = ensureLayer();
    const budget = NODE_BUDGET - host.childElementCount;
    if (budget <= 0) return;

    const rects = [];
    for (const tile of tiles) {
      if (!tile || !tile.isConnected) continue;
      const rect = tile.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    if (rects.length === 0) return;

    /* Presupuesto por rafaga: en una ganancia de tablero completo (30 celdas)
       dos chispas por celda son 60 capas animandose a la vez. Con muchas celdas
       ya resaltadas basta una chispa cada una; el efecto se lee igual y el
       compositor no se satura. */
    const perTile = rects.length > 10 ? 1 : power > 1 ? 3 : 2;
    let made = 0;

    for (const rect of rects) {
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      for (let i = 0; i < perTile && made < budget; i += 1) {
        made += 1;
        const angle = rand(-Math.PI * 0.94, -Math.PI * 0.06);
        const distance = rand(16, 42) * power;
        const el = document.createElement('span');
        el.className = 'fx__spark';
        el.style.setProperty('--x', `${fixed(centerX)}px`);
        el.style.setProperty('--y', `${fixed(centerY)}px`);
        el.style.setProperty('--dx', `${fixed(Math.cos(angle) * distance)}px`);
        el.style.setProperty('--dy', `${fixed(Math.sin(angle) * distance)}px`);
        el.style.setProperty('--s', `${fixed(rand(4, 9) * (power > 1 ? 1.15 : 1))}px`);
        el.style.setProperty('--t', `${Math.round(rand(420, 720))}ms`);
        el.style.setProperty('--c', pick(SPARK_COLORS));
        host.appendChild(el);
        track(el, 900);
      }
    }
  }

  /**
   * Centro del tablero en coordenadas de viewport.
   *
   * En escritorio el tablero queda a la derecha del panel de apuesta, asi que
   * centrar el cartel y el destello en el viewport los deja desalineados del
   * foco de juego. Sin tablero montado se usa el centro de la ventana.
   */
  function focusCenter() {
    const board = document.querySelector('.board');
    const rect = board ? board.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.42 };
  }

  /**
   * Destello de pantalla. `power` va de 0 a 1: 0,35 para un premio normal y 1
   * para el MEGA.
   */
  function flash({ power = 0.7 } = {}) {
    if (!CAN_ANIMATE || document.hidden) return;
    const host = ensureLayer();
    const el = document.createElement('div');
    el.className = 'fx__flash';
    el.style.setProperty('--flash-peak', String(Math.max(0, Math.min(1, power))));
    const center = focusCenter();
    el.style.setProperty('--fx-cx', `${((center.x / window.innerWidth) * 100).toFixed(2)}%`);
    el.style.setProperty('--fx-cy', `${((center.y / window.innerHeight) * 100).toFixed(2)}%`);
    host.appendChild(el);
    track(el, 700);
  }

  /**
   * Lluvia de monedas y caramelos.
   *
   * Por defecto cae por toda la pantalla sobre la capa `#fx` (MEGA WIN). El
   * overlay de victoria pasa su propio `host` y `zone: 'sides'` para que la
   * cascada caiga por los laterales, dentro del velo, sin mezclarse con las
   * chispas del tablero.
   *
   * @param {{count?: number, host?: Element|null, zone?: 'full'|'sides'}} [options]
   */
  function coinRain({ count = 40, host = null, zone = 'full' } = {}) {
    if (!CAN_ANIMATE || document.hidden) return;
    const target = host || ensureLayer();
    const total = Math.min(count, Math.max(0, NODE_BUDGET - target.childElementCount));
    if (total <= 0) return;

    for (let i = 0; i < total; i += 1) {
      const left = i % 2 === 0;
      const el = document.createElement('span');
      el.className = 'fx__coin';
      el.textContent = pick(COIN_FACES);
      el.style.setProperty(
        '--x',
        `${fixed(zone === 'sides' ? (left ? rand(-4, 14) : rand(86, 104)) : rand(-4, 102))}vw`
      );
      /* En los laterales la deriva entra hacia el centro: la cascada se lee
         como un marco de monedas y no como una cortina uniforme. */
      el.style.setProperty(
        '--drift',
        `${fixed(zone === 'sides' ? (left ? rand(1, 7) : rand(-7, -1)) : rand(-8, 8))}vw`
      );
      el.style.setProperty('--s', `${Math.round(rand(18, 40))}px`);
      el.style.setProperty('--r0', `${Math.round(rand(-80, 80))}deg`);
      el.style.setProperty('--r1', `${Math.round(rand(300, 900))}deg`);
      el.style.setProperty('--t', `${Math.round(rand(1500, 2800))}ms`);
      el.style.setProperty('--d', `${Math.round(rand(0, 900))}ms`);
      target.appendChild(el);
      track(el, 3900);
    }
  }

  /**
   * Cartel del gran premio. Se centra sobre el tablero (no sobre la ventana,
   * que en escritorio tiene el panel de apuesta a la izquierda) y se retira al
   * acabar su animacion de vida (`mega-life`).
   *
   * @param {string} title texto del nivel, p. ej. "¡MEGA GANANCIA!"
   * @param {string} amountText importe ya formateado
   */
  function mega(title, amountText) {
    if (!CAN_ANIMATE) return null;
    const host = ensureLayer();
    if (megaNode) {
      megaNode.remove();
      megaNode = null;
    }

    const card = document.createElement('div');
    card.className = 'fx__mega';
    card.style.left = `${fixed(focusCenter().x)}px`;

    const kicker = document.createElement('span');
    kicker.className = 'fx__mega-kicker';
    kicker.textContent = title;

    const amount = document.createElement('strong');
    amount.className = 'fx__mega-amount';
    amount.textContent = amountText;

    card.append(kicker, amount);
    host.appendChild(card);
    megaNode = track(card, 2800, { onEnd: false });
    return card;
  }

  return { clear, sparkBurst, flash, coinRain, mega };
}

