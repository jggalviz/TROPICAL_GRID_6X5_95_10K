'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEngine,
  SCATTER,
  SCATTER_PAYS_UNITS
} = require('../server/engine/gridEngine');

const BET_CENTS = 100;

/** Rejilla determinista: cada columna es un simbolo o una tira explicita. */
function fixedSpin(engine, columns) {
  const strips = columns.map((column) => {
    const cells = Array.isArray(column) ? column.slice() : new Array(120).fill(column);
    while (cells.length < 120) cells.push('S1');
    return cells.slice(0, 120);
  });
  return engine.internals.playSpin({
    rng: { int: () => 0, draws: () => 1 },
    pickers: engine.model.base.pickers,
    strips,
    betCents: BET_CENTS,
    winBudgetCents: BET_CENTS * 10000
  });
}

test('scatter: el tramo 6+ es abierto y paga el maximo de la tabla', () => {
  const engine = createEngine();
  const maxUnits = SCATTER_PAYS_UNITS[6];

  const allFlowers = fixedSpin(engine, new Array(6).fill(SCATTER));
  assert.equal(allFlowers.scatter.count, 30);
  assert.equal(allFlowers.scatter.payUnits, maxUnits, '7+ flores no deben pagar 0');
  assert.equal(allFlowers.winCents, Math.round(maxUnits * BET_CENTS));

  const seven = fixedSpin(engine, [
    [SCATTER, SCATTER, SCATTER, SCATTER, SCATTER],
    [SCATTER, SCATTER, 'S1', 'S1', 'S1'],
    'S2', 'S3', 'S4', 'S5'
  ]);
  assert.equal(seven.scatter.count, 7);
  assert.equal(seven.scatter.payUnits, maxUnits);
});

test('scatter: por debajo de 3 flores no paga', () => {
  const engine = createEngine();
  const two = fixedSpin(engine, [
    [SCATTER, SCATTER, 'S1', 'S1', 'S1'],
    'S2', 'S3', 'S4', 'S5', 'S6'
  ]);
  assert.equal(two.scatter.count, 2);
  assert.equal(two.scatter.payUnits, 0);
  assert.equal(two.scatter.payCents, 0);
  assert.equal(two.winCents, 0);
});
