'use strict';

/**
 * Disparador y escala de la pantalla de victoria (`#win-overlay`).
 *
 * Regla del cliente: cualquier victoria valida (importe > 0) abre la capa, y el
 * perfil de intensidad se elige por `win / bet`:
 *
 *   low  (< 1x)   -> 8 monedas (0 por debajo de 0,2x), rayos quietos, 1,7 s;
 *   mid  (1-10x)  -> 22 monedas, rayos girando, 3 s;
 *   high (>10x)   -> 42 monedas, rebote marcado, 3,8-4,6 s segun el nivel.
 *
 * Se importa el modulo ESM de produccion: `Ui` no toca el DOM en el constructor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UI_PATH = path.join(__dirname, '..', 'public', 'src', 'js', 'uiManager.js');

const loadUi = async () => {
  const { Ui } = await import(pathToFileURL(UI_PATH).href);
  return new Ui();
};

test('cualquier victoria valida abre la pantalla, tambien por debajo de 1x', async () => {
  const ui = await loadUi();

  // Premios fraccionarios y minimos: la capa es el mensaje del premio.
  assert.equal(ui.isWinWorthOverlay_('win', 1), true, '1 centimo ya es una victoria');
  assert.equal(ui.isWinWorthOverlay_('win', 5), true, '0,05x de 1,00 debe abrir');
  assert.equal(ui.isWinWorthOverlay_('win', 50), true, '0,50x de 1,00 debe abrir');
  assert.equal(ui.isWinWorthOverlay_('win', 100), true, '1x debe abrir');
  assert.equal(ui.isWinWorthOverlay_('win', 900), true, '9x debe abrir');

  // Sin premio no hay nada que anunciar.
  assert.equal(ui.isWinWorthOverlay_('win', 0), false);
  assert.equal(ui.isWinWorthOverlay_('win', -5), false);
  assert.equal(ui.isWinWorthOverlay_('win', null), false);
  assert.equal(ui.isWinWorthOverlay_('win', undefined), false);
  assert.equal(ui.isWinWorthOverlay_('win', Number.NaN), false);

  // Los niveles altos abren siempre, aunque el payload no traiga importe.
  assert.equal(ui.isWinWorthOverlay_('big', null), true);
  assert.equal(ui.isWinWorthOverlay_('mega', null), true);
  assert.equal(ui.isWinWorthOverlay_('epic', null), true);
});

test('el perfil escala con el ratio: low < 1x, mid 1-10x y high >= 10x', async () => {
  const ui = await loadUi();

  // Bajo: sutil y rapido. Por debajo de 0,2x ni siquiera llueve.
  const tiny = ui.resolveWinProfile_('win', 5, 100);
  assert.equal(tiny.name, 'low');
  assert.equal(tiny.coins, 0, 'un 0,05x no debe llenar la capa de monedas');
  assert.equal(tiny.durationMs, 1700);
  assert.equal(tiny.rollMs, 450);
  assert.equal(tiny.rays, 'soft');
  assert.ok(tiny.power <= 0.2, 'el destello bajo debe ser discreto');

  const fractional = ui.resolveWinProfile_('win', 50, 100);
  assert.equal(fractional.name, 'low');
  assert.equal(fractional.coins, 8);

  // Medio: el diseno estandar de 22 monedas y 3 s.
  const even = ui.resolveWinProfile_('win', 100, 100);
  assert.equal(even.name, 'mid');
  assert.equal(even.coins, 22);
  assert.equal(even.durationMs, 3000);
  assert.equal(even.rollMs, 900);
  assert.equal(even.rays, 'full');

  const almostBig = ui.resolveWinProfile_('win', 990, 100);
  assert.equal(almostBig.name, 'mid', '9,9x sigue en la banda media');

  // Alto: la frontera de 10x y los niveles que ya calcula `winLevel`.
  const ten = ui.resolveWinProfile_('win', 1000, 100);
  assert.equal(ten.name, 'high');
  assert.equal(ten.coins, 42);
  assert.equal(ten.durationMs, 3800);
  assert.ok(ten.power >= 0.8);

  const big = ui.resolveWinProfile_('big', 1500, 100);
  assert.equal(big.name, 'high');
  assert.equal(big.coins, 42);
  assert.equal(big.durationMs, 3800);

  const mega = ui.resolveWinProfile_('mega', 3000, 100);
  assert.equal(mega.durationMs, 4200);
  assert.ok(mega.power >= 0.9);

  const epic = ui.resolveWinProfile_('epic', 12000, 100);
  assert.equal(epic.durationMs, 4600);
  assert.equal(epic.power, 1);

  // Sin apuesta el importe sigue siendo autoritativo: perfil bajo, sin inventar.
  const noBet = ui.resolveWinProfile_('win', 250, null);
  assert.equal(noBet.name, 'low');
  assert.equal(noBet.coins, 8);

  const noCents = ui.resolveWinProfile_('win', null, 100);
  assert.equal(noCents.name, 'low');
  assert.equal(noCents.coins, 0);
});

test('showWinOverlay aplica la clase del perfil, lanza sus monedas y se cierra', async () => {
  const ui = await loadUi();
  const classes = new Set();
  const coins = [];
  const node = {
    hidden: true,
    offsetWidth: 0,
    classList: {
      add: (name) => classes.add(name),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name)
    }
  };

  ui.refs.winOverlay = node;
  ui.refs.winAmount = { textContent: '' };
  ui.refs.winCurrency = { textContent: '' };
  ui.refs.winRain = { textContent: '' };
  ui.fx = { coinRain: ({ count }) => coins.push(count) };

  // Bajo: 8 monedas y clase `is-low`. En Node no hay rAF, asi que el conteo
  // escribe directamente el importe formateado (respaldo limpio).
  assert.equal(
    ui.showWinOverlay('win', '0,50', { cents: 50, profile: ui.resolveWinProfile_('win', 50, 100) }),
    true
  );
  assert.equal(node.hidden, false);
  assert.ok(node.classList.contains('is-low'));
  assert.deepEqual(coins, [8]);
  assert.equal(ui.refs.winAmount.textContent, '0,50');
  assert.equal(ui.refs.winCurrency.textContent, 'EUR');

  ui.hideWinOverlay({ immediate: true });
  assert.equal(node.hidden, true);
  assert.equal(classes.size, 0, 'el cierre debe limpiar la clase de perfil');

  // Un 0,05x no lanza monedas, pero mantiene la clase sutil.
  coins.length = 0;
  ui.showWinOverlay('win', '0,05', { cents: 5, profile: ui.resolveWinProfile_('win', 5, 100) });
  assert.deepEqual(coins, []);
  assert.ok(node.classList.contains('is-low'));
  ui.hideWinOverlay({ immediate: true });

  // Alto: 42 monedas y rebote marcado (clase `is-high`).
  ui.showWinOverlay('epic', '120,00', {
    cents: 12000,
    profile: ui.resolveWinProfile_('epic', 12000, 100)
  });
  assert.deepEqual(coins, [42]);
  assert.ok(node.classList.contains('is-high'));
  ui.hideWinOverlay({ immediate: true });

  // Sin capa montada no hay overlay ni respaldo silencioso: devuelve false.
  ui.refs.winOverlay = null;
  assert.equal(ui.showWinOverlay('win', '1,00', { cents: 100 }), false);
});
