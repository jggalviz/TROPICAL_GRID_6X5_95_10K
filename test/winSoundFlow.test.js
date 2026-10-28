'use strict';

/**
 * Flujo de la victoria durante una tirada.
 *
 * Comprueba el comportamiento real de `GameClient.presentSpin()` con un UI y
 * un `sfx` espiados: cada scatter pagado y cada cascada con `winCents > 0`
 * debe llamar a `sfx.win()` en el momento de registrar el premio. Los modulos
 * del cliente son ESM, asi que se cargan como data URLs con sus imports
 * relativos reescritos (mismo helper que `frontendSession.test.js`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', 'public', 'src', 'js');
const urlCache = new Map();
const moduleCache = new Map();

function buildModuleUrl(fileName) {
  const file = path.join(JS_DIR, fileName);
  if (urlCache.has(file)) return urlCache.get(file);

  const source = fs.readFileSync(file, 'utf8').replace(
    /(\bfrom\s+['"])(\.[^'"]+)(['"])/g,
    (_match, head, specifier, tail) => `${head}${buildModuleUrl(specifier.replace(/^\.\//, ''))}${tail}`
  );

  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  urlCache.set(file, url);
  return url;
}

function loadClientModule(fileName) {
  const file = path.join(JS_DIR, fileName);
  if (!moduleCache.has(file)) moduleCache.set(file, import(buildModuleUrl(fileName)));
  return moduleCache.get(file);
}

/** UI sin DOM: cualquier metodo no declarado se registra y devuelve undefined. */
function createUiSpy() {
  return new Proxy(
    { handlers: {}, refs: {} },
    {
      get(target, property) {
        if (property in target) return target[property];
        return () => undefined;
      }
    }
  );
}

function createSfxSpy() {
  const calls = { win: 0, cluster: 0, drop: 0 };
  return {
    calls,
    sfx: {
      win() {
        calls.win += 1;
      },
      cluster() {
        calls.cluster += 1;
      },
      drop() {
        calls.drop += 1;
      },
      spin() {},
      bomb() {},
      click() {},
      unlock() {},
      error() {},
      isMuted: () => false,
      setMuted() {}
    }
  };
}

/**
 * Sustituye los timers por ejecucion inmediata: el orden de llamadas es el
 * mismo y la prueba no espera los ~5 s de animaciones de todas las cascadas.
 */
async function withoutAnimationDelays(callback) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ...args) => {
    if (typeof fn === 'function') fn(...args);
    return 0;
  };
  try {
    return await callback();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

function cascade(index, winCents) {
  return {
    index,
    clusters: [{ symbol: 'S1', size: 5, cells: [[index, index]] }],
    winCents,
    bombsAfter: [],
    gridAfter: []
  };
}

test('cada scatter y cada cascada con premio dispara sfx.win()', async () => {
  const { GameClient } = await loadClientModule('gameClient.js');
  const { calls, sfx } = createSfxSpy();
  const game = new GameClient({ api: {}, ui: createUiSpy(), sfx, session: {} });

  const spin = {
    initialGrid: [],
    bombs: [],
    scatter: { count: 3, cells: [[0, 0]], payCents: 760 },
    cascades: [cascade(0, 120), cascade(1, 0), cascade(2, 80)],
    multiplier: 1,
    winCents: 960
  };

  const running = await withoutAnimationDelays(() => game.presentSpin(spin, {
    index: 0,
    total: 1,
    isFeature: false,
    runningWinCents: 0
  }));

  assert.equal(calls.win, 3, 'scatter + dos cascadas pagadas deben sonar por separado');
  assert.equal(calls.cluster, 4, 'scatter y cada cascada conservan su efecto corto');
  assert.equal(running, 200, 'solo las cascadas suman al contador progresivo');
});

test('un giro con win positivo sin desglose de cascadas no se queda mudo', async () => {
  const { GameClient } = await loadClientModule('gameClient.js');
  const { calls, sfx } = createSfxSpy();
  const game = new GameClient({ api: {}, ui: createUiSpy(), sfx, session: {} });

  const spin = {
    initialGrid: [],
    bombs: [],
    scatter: { count: 2, cells: [], payCents: 0 },
    cascades: [],
    multiplier: 1,
    winCents: 45
  };

  const running = await withoutAnimationDelays(() => game.presentSpin(spin, {
    index: 0,
    total: 1,
    isFeature: false,
    runningWinCents: 0
  }));

  assert.equal(calls.win, 1, 'el fallback debe sonar una sola vez por el giro ganador');
  assert.equal(running, 0);
});

test('un giro sin premio no reproduce la victoria', async () => {
  const { GameClient } = await loadClientModule('gameClient.js');
  const { calls, sfx } = createSfxSpy();
  const game = new GameClient({ api: {}, ui: createUiSpy(), sfx, session: {} });

  const spin = {
    initialGrid: [],
    bombs: [],
    scatter: { count: 2, cells: [], payCents: 0 },
    cascades: [cascade(0, 0)],
    multiplier: 1,
    winCents: 0
  };

  await withoutAnimationDelays(() => game.presentSpin(spin, {
    index: 0,
    total: 1,
    isFeature: false,
    runningWinCents: 0
  }));

  assert.equal(calls.win, 0);
});

test('la celebracion final conserva el sonido cuando totalWinCents es positivo', async () => {
  const { GameClient } = await loadClientModule('gameClient.js');
  const { calls, sfx } = createSfxSpy();
  const game = new GameClient({ api: {}, ui: createUiSpy(), sfx, session: {} });

  /* El desglose por giro se prueba arriba; aqui aislamos el cierre de ronda. */
  game.presentSpin = async () => 0;

  const round = {
    mode: 'BASE',
    replayed: false,
    spins: [{ initialGrid: [], finalGrid: [], cascades: [] }],
    totalWinCents: 500,
    betCents: 100,
    multiplier: 1,
    maxWinReached: false
  };

  await withoutAnimationDelays(() => game.present(round));

  assert.equal(calls.win, 1, 'el total de la ronda debe celebrarse con el MP3');
});

