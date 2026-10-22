'use strict';

/**
 * Arranque del cliente sin token ("Fichas de Prueba" automaticas).
 *
 * Fija el contrato del bootstrap:
 *   - Sin token en la URL ni en localStorage se abre una sesion demo sola.
 *   - El token de la URL o de localStorage tiene prioridad (jugador real).
 *   - `GameClient.boot()` deja saldo virtual listo para girar y NO abre el
 *     modal de "Sesion requerida".
 *
 * Los modulos del cliente son ESM y el package.json raiz no declara
 * "type": "module", asi que se cargan con `loadClientModule` (imports relativos
 * reescritos a data URLs). Asi se prueban de verdad, sin bundler ni jsdom.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', 'public', 'src', 'js');
const MAIN_PATH = path.join(JS_DIR, 'main.js');
const STORAGE_KEY = 'tg65.session.v1';

/* ------------------------------------------------------------------ helpers */

const urlCache = new Map();
const moduleCache = new Map();

/** URL `data:` del modulo con sus imports relativos ya resueltos. */
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

/** Espera a que se asienten las promesas del fallback (sin timers falsos). */
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function createStorage() {
  const items = new Map();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => {
      items.set(key, String(value));
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => items.clear()
  };
}

/** Instala un `window` minimo (el cliente lee storage, URL e historial). */
function installWindow({ href = 'http://localhost:3000/', localStorage, sessionStorage } = {}) {
  const local = localStorage || createStorage();
  const session = sessionStorage || createStorage();
  const window = {
    localStorage: local,
    sessionStorage: session,
    location: { href },
    history: {
      replaceState: (_state, _title, next) => {
        window.location.href = next;
      }
    }
  };
  global.window = window;
  return { window, localStorage: local, sessionStorage: session };
}

function demoPayload(alias = 'invitado_demo') {
  return {
    ok: true,
    demo: true,
    token: `t1.demo.${alias}`,
    tokenType: 'Bearer',
    expiresAt: null,
    sessionId: `${alias}:uuid`,
    player: { id: `${alias}:uuid`, alias, displayName: 'Invitado Demo', currency: 'VES' },
    balance: { cents: 100000, credits: 1000, currency: 'VES' }
  };
}

function playerPayload() {
  return {
    ok: true,
    demo: true,
    player: { displayName: 'Invitado Demo', currency: 'VES' },
    balance: { cents: 100000, credits: 1000, currency: 'VES' }
  };
}

/** UI espiada: registra cada metodo llamado sin necesitar DOM. */
function createUiSpy() {
  const calls = [];
  const ui = new Proxy(
    { handlers: {}, refs: {} },
    {
      get(target, property) {
        if (property in target) return target[property];
        return (...args) => {
          calls.push({ name: String(property), args });
        };
      }
    }
  );
  return { ui, calls };
}
/* ------------------------------------------------------------------- sesion */

test('sin token, SessionManager abre una sesion de fichas de prueba', async () => {
  const { localStorage } = installWindow();
  const { SessionManager } = await loadClientModule('sessionClient.js');

  const calls = [];
  const api = {
    createDemoSession: async (alias) => {
      calls.push(['demo', alias]);
      return demoPayload();
    },
    createSession: async () => {
      calls.push(['dev']);
      throw new Error('no debe usarse la sesion de desarrollo');
    }
  };

  const manager = new SessionManager(api);
  const resolved = await manager.resolve();

  assert.equal(resolved.source, 'demo');
  assert.equal(resolved.token, 't1.demo.invitado_demo');
  assert.equal(manager.isDemo, true);
  assert.equal(manager.current(), resolved.token);
  assert.deepEqual(calls, [['demo', 'invitado_demo']], 'debe emitir token demo por defecto');
  assert.match(
    localStorage.getItem(STORAGE_KEY) || '',
    /"token":"t1\.demo\.invitado_demo"/,
    'el token demo debe persistir en localStorage'
  );
});

test('el token de la URL tiene prioridad y se borra de la barra', async () => {
  const { window } = installWindow({ href: 'http://localhost:3000/?token=t1.url.sig#tab=game' });
  const { SessionManager } = await loadClientModule('sessionClient.js');

  const api = {
    createDemoSession: async () => {
      throw new Error('no debe pedir fichas de prueba');
    }
  };

  const resolved = await new SessionManager(api).resolve();

  assert.equal(resolved.source, 'url');
  assert.equal(resolved.token, 't1.url.sig');
  assert.equal(window.location.href, 'http://localhost:3000/#tab=game');
});

test('el token guardado se reutiliza y se migra desde sessionStorage', async () => {
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 't1.local.sig', expiresAt: null }));
  installWindow({ localStorage, sessionStorage });

  const { SessionManager, readStoredToken } = await loadClientModule('sessionClient.js');

  assert.equal(readStoredToken(), 't1.local.sig');
  const resolved = await new SessionManager({
    createDemoSession: async () => {
      throw new Error('no debe pedir fichas de prueba');
    }
  }).resolve();
  assert.equal(resolved.source, 'storage');

  /* Compatibilidad con la version anterior, que guardaba en sessionStorage. */
  const legacyLocal = createStorage();
  const legacySession = createStorage();
  legacySession.setItem(STORAGE_KEY, JSON.stringify({ token: 't1.legacy.sig' }));
  installWindow({ localStorage: legacyLocal, sessionStorage: legacySession });

  assert.equal(readStoredToken(), 't1.legacy.sig');
  assert.match(legacyLocal.getItem(STORAGE_KEY) || '', /t1\.legacy\.sig/);
  assert.equal(legacySession.getItem(STORAGE_KEY), null, 'el token migrado sale de sessionStorage');
});

test('un token caducado se descarta y se entra en modo prueba', async () => {
  const localStorage = createStorage();
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ token: 't1.old.sig', expiresAt: '2000-01-01T00:00:00.000Z' })
  );
  installWindow({ localStorage });

  const { SessionManager } = await loadClientModule('sessionClient.js');

  let demoCalls = 0;
  const resolved = await new SessionManager({
    createDemoSession: async () => {
      demoCalls += 1;
      return demoPayload();
    }
  }).resolve();

  assert.equal(resolved.source, 'demo');
  assert.equal(demoCalls, 1);
});

test('si el operador desactiva el modo prueba se intenta la sesion de desarrollo', async () => {
  installWindow();
  const { ApiError } = await loadClientModule('apiClient.js');
  const { SessionManager } = await loadClientModule('sessionClient.js');

  const api = {
    createDemoSession: async () => {
      throw new ApiError({ code: 'DEMO_DISABLED', message: 'Modo prueba desactivado.', status: 403 });
    },
    createSession: async () => ({ token: 't1.dev.sig', player: { displayName: 'Demo Player' } })
  };

  const resolved = await new SessionManager(api).resolve();

  assert.equal(resolved.source, 'dev');
});


/* ----------------------------------------------------------------- arranque */

test('boot() arranca con fichas de prueba y sin modal de sesion', async () => {
  installWindow();
  const { SessionManager } = await loadClientModule('sessionClient.js');
  const { GameClient } = await loadClientModule('gameClient.js');

  const { ui, calls } = createUiSpy();
  const api = {
    gameInfo: async () => ({
      game: {
        code: 'TG65',
        engineVersion: '1.0.0',
        paytableVersion: '1',
        betLadder: [0.1, 0.2, 0.5, 1, 2, 5],
        demo: { enabled: true, currency: 'VES', startBalanceCredits: 1000 }
      }
    }),
    player: async () => playerPayload(),
    createDemoSession: async () => demoPayload()
  };

  const game = new GameClient({
    api,
    ui,
    sfx: { unlock() {}, click() {}, error() {} },
    session: new SessionManager(api)
  });

  await game.boot();

  const names = calls.map((call) => call.name);

  assert.equal(game.isDemo, true, 'el arranque sin token debe quedar en modo prueba');
  assert.equal(game.balanceCents, 100000, 'saldo virtual de 1.000,00 VES');
  assert.equal(game.busy, false, 'la maquina debe quedar lista para girar');
  assert.ok(game.balanceCents >= game.betCents, 'el saldo demo cubre la apuesta por defecto');
  assert.ok(names.includes('setBalance'), 'debe pintar el saldo virtual del servidor');
  assert.ok(
    calls.some((call) => call.name === 'setDemoMode' && call.args[0] === true),
    'la interfaz debe marcar el modo Fichas de Prueba'
  );
  assert.equal(names.includes('showAuthGate'), false, 'no debe abrir la puerta de sesion');
  assert.equal(names.includes('openModal'), false, 'no debe abrir el modal de sesion');
  assert.equal(
    calls.some((call) => call.name === 'toast'),
    false,
    'el arranque automatico no debe avisar con un toast'
  );
});

test('un token guardado que el servidor rechaza cae en modo prueba sin modal', async () => {
  const localStorage = createStorage();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 't1.stale.sig' }));
  installWindow({ localStorage });

  const { ApiError } = await loadClientModule('apiClient.js');
  const { SessionManager } = await loadClientModule('sessionClient.js');
  const { GameClient } = await loadClientModule('gameClient.js');
  const { ui, calls } = createUiSpy();

  let playerCalls = 0;
  const api = {
    gameInfo: async () => ({
      game: { code: 'TG65', betLadder: [1], demo: { enabled: true, currency: 'VES' } }
    }),
    player: async () => {
      playerCalls += 1;
      if (playerCalls === 1) {
        throw new ApiError({ code: 'TOKEN_EXPIRED', message: 'Sesion expirada.', status: 401 });
      }
      return playerPayload();
    },
    createDemoSession: async () => demoPayload()
  };

  const game = new GameClient({
    api,
    ui,
    sfx: { unlock() {}, click() {}, error() {} },
    session: new SessionManager(api)
  });

  await game.boot();

  assert.equal(playerCalls, 2, 'debe reintentar con una sesion demo');
  assert.equal(game.isDemo, true);
  assert.equal(game.balanceCents, 100000);
  assert.equal(
    calls.some((call) => call.name === 'showAuthGate'),
    false,
    'un token caducado no debe abrir el modal de sesion'
  );
  assert.match(localStorage.getItem(STORAGE_KEY) || '', /t1\.demo\./);
});

test('un fallo transitorio al recuperar la sesion no abre el modal de token', async () => {
  installWindow();

  const { ApiError } = await loadClientModule('apiClient.js');
  const { SessionManager } = await loadClientModule('sessionClient.js');
  const { GameClient } = await loadClientModule('gameClient.js');
  const { ui, calls } = createUiSpy();

  const api = {
    createDemoSession: async () => {
      throw new ApiError({ code: 'RATE_LIMITED', message: 'Demasiadas peticiones.', status: 429 });
    }
  };

  const game = new GameClient({
    api,
    ui,
    sfx: { unlock() {}, click() {}, error() {} },
    session: new SessionManager(api)
  });

  /* Igual que en un giro fallido: `handleError` corre antes de liberar `busy`. */
  game.busy = true;
  game.handleError(new ApiError({ code: 'TOKEN_EXPIRED', message: 'Sesion expirada.', status: 401 }));
  await wait();

  assert.equal(
    calls.some((call) => call.name === 'showAuthGate'),
    false,
    'un 429 no debe pedir token'
  );
  assert.equal(game.busy, false, 'el fallback debe liberar el bloqueo del giro');
  assert.equal(game.demoFallbackRunning, false);
  assert.equal(game.lastDemoError.code, 'RATE_LIMITED');

  const statuses = calls.filter((call) => call.name === 'setStatus').map((call) => call.args[0]);
  assert.ok(statuses.includes('Modo prueba no disponible · reintenta'));
});

test('si el servidor prohibe las fichas de prueba, la recuperacion pide token', async () => {
  installWindow();

  const { ApiError } = await loadClientModule('apiClient.js');
  const { SessionManager } = await loadClientModule('sessionClient.js');
  const { GameClient } = await loadClientModule('gameClient.js');
  const { ui, calls } = createUiSpy();

  const api = {
    createDemoSession: async () => {
      throw new ApiError({ code: 'DEMO_DISABLED', message: 'Modo prueba desactivado.', status: 403 });
    }
  };

  const game = new GameClient({
    api,
    ui,
    sfx: { unlock() {}, click() {}, error() {} },
    session: new SessionManager(api)
  });

  game.handleError(new ApiError({ code: 'SESSION_REQUIRED', message: 'Sin sesion.', status: 401 }));
  await wait();

  assert.equal(game.demoIsBlocked_(), true);
  assert.equal(calls.some((call) => call.name === 'showAuthGate'), true);
});

test('main.js intenta el modo prueba antes de pedir token', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const boot = source.slice(source.indexOf('const start = () =>'));

  const demoIndex = boot.indexOf('startDemoMode');
  const gateIndex = boot.indexOf('showAuthGate');

  assert.ok(demoIndex > -1, 'main.js debe activar el modo prueba al arrancar');
  assert.ok(gateIndex > -1, 'main.js conserva la puerta manual como ultimo recurso');
  assert.ok(demoIndex < gateIndex, 'el modo prueba debe intentarse antes de abrir la puerta');
});

