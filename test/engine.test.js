'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEngine,
  SCATTER,
  SCATTER_PAYS_UNITS,
  MAX_CASCADE_STEPS
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

/**
 * Construye una tirada determinista a partir de una matriz visible 5x6.
 * El motor lee cada columna de abajo hacia arriba (fila 4 -> fila 0), por lo
 * que la tira inicial se invierte. `tails[col]` son las posiciones que se
 * consumen en las recargas de las cascadas (cursor = 5).
 */
function matrixSpin(engine, matrix, tails = []) {
  const strips = matrix[0].map((_, col) => {
    const initial = [];
    for (let row = matrix.length - 1; row >= 0; row -= 1) {
      initial.push(matrix[row][col]);
    }
    const strip = initial.concat(tails[col] || []);
    while (strip.length < 120) strip.push('S2');
    return strip.slice(0, 120);
  });

  return engine.internals.playSpin({
    rng: { int: () => 0, draws: () => 1 },
    pickers: engine.model.base.pickers,
    strips,
    betCents: BET_CENTS,
    winBudgetCents: BET_CENTS * 10000
  });
}

/* 8 S1 aislados: ninguno toca a otro en horizontal, vertical o diagonal. */
const DISPERSED_S1 = [
  ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
  ['S2', 'S1', 'S4', 'S5', 'S6', 'S7'],
  ['S3', 'S4', 'S1', 'S6', 'S1', 'S8'],
  ['S4', 'S5', 'S6', 'S1', 'S8', 'S9'],
  ['S1', 'S6', 'S1', 'S8', 'S9', 'S1']
];

const S1_CELLS = [
  [0, 0], [1, 1], [2, 2], [2, 4], [3, 3], [4, 0], [4, 2], [4, 5]
];

test('grid pays: 8 simbolos dispersos pagan sin adyacencia y se eliminan todos', () => {
  const engine = createEngine();
  const spin = matrixSpin(engine, DISPERSED_S1, [
    ['S2', 'S3'], ['S4'], ['S5', 'S7'], ['S8'], ['S9'], ['S2']
  ]);

  assert.equal(spin.cascadeCount, 1);
  const step = spin.cascades[0];
  assert.equal(step.payType, 'GRID_PAYS');
  assert.equal(step.clusters.length, 1);

  const pay = step.clusters[0];
  assert.equal(pay.symbol, 'S1');
  assert.equal(pay.size, 8, 'deben contar las 8 apariciones aunque esten aisladas');
  assert.equal(pay.tier, 8);
  assert.equal(pay.payMicro, 927);
  assert.deepEqual(pay.cells, S1_CELLS);
  assert.deepEqual(step.removedCells, S1_CELLS, 'se eliminan todas las celdas ganadoras');
  assert.equal(
    step.gridAfter.flat().filter((symbol) => symbol === 'S1').length,
    0,
    'no puede quedar ningun S1 tras la cascada'
  );
  assert.equal(spin.winCents, 9);
  assert.equal(spin.multiplier, 1);
});

test('cascadas: tras el refill se reevalua el conteo disperso y encadena otro pago', () => {
  const engine = createEngine();
  const spin = matrixSpin(engine, DISPERSED_S1, [
    ['S2', 'S2', 'S3', 'S3', 'S4'],
    ['S2', 'S3', 'S4'],
    ['S2', 'S2', 'S3', 'S5'],
    ['S2', 'S5'],
    ['S2', 'S7'],
    ['S2', 'S7']
  ]);

  assert.equal(spin.cascadeCount, 2, 'el segundo S2 debe abrir otra cascada');

  const [first, second] = spin.cascades;
  assert.equal(first.clusters[0].symbol, 'S1');
  assert.equal(first.clusters[0].size, 8);
  assert.equal(second.clusters[0].symbol, 'S2');
  assert.equal(second.clusters[0].size, 10, 'S2 suma las apariciones supervivientes y las nuevas');
  assert.equal(second.clusters[0].tier, 10);
  assert.equal(second.clusters[0].payMicro, 2833);
  assert.deepEqual(second.removedCells, second.clusters[0].cells);

  const leftS2 = second.gridAfter.flat().filter((symbol) => symbol === 'S2').length;
  assert.equal(leftS2, 0, 'la segunda cascada tambien elimina todas las apariciones');
  assert.equal(spin.cascadeCount, 2, 'sin un tercer conteo >= 8 el bucle debe parar');
  assert.equal(spin.winCents, 9 + 28);
});

test('bombas: MX sobrevive a las cascadas y su suma se aplica al final', () => {
  const engine = createEngine();
  const withBombs = DISPERSED_S1.map((row) => row.slice());
  withBombs[0][1] = 'MX';
  withBombs[0][3] = 'MX';

  const spin = matrixSpin(engine, withBombs, [
    ['S2', 'S3'], ['S4'], ['S5', 'S7'], ['S8'], ['S9'], ['S2']
  ]);

  assert.equal(spin.cascadeCount, 1);
  assert.equal(spin.cascades[0].bombs.length, 2);
  assert.equal(
    spin.finalGrid.flat().filter((symbol) => symbol === 'MX').length,
    2,
    'las bombas no se eliminan en las cascadas'
  );
  assert.equal(spin.multiplier, 4, 'dos bombas de 2x se suman al final');
  assert.equal(spin.multiplierApplied, 4);
  assert.equal(spin.winCents, Math.floor((927 * 4 * BET_CENTS) / 10000));
});

test('cascadas: el bucle se detiene en el limite de 40 pasos', () => {
  const engine = createEngine();
  const spin = fixedSpin(engine, new Array(6).fill('S1'));

  assert.equal(spin.cascadeCount, MAX_CASCADE_STEPS);
  assert.equal(spin.cascades.every((step) => step.clusters[0].size === 30), true);
  assert.equal(spin.finalGrid.flat().filter((symbol) => symbol === 'S1').length, 30);
  assert.equal(spin.winCents, Math.floor((5146 * 40 * BET_CENTS) / 10000));
});

test('grid pays: con 7 no paga y con dos conteos validos paga ambos a la vez', () => {
  const engine = createEngine();

  const seven = DISPERSED_S1.map((row) => row.slice());
  seven[0][0] = 'S9';
  const sevenGrid = seven.map((row) => row.map((symbol) => ({ s: symbol, v: 0 })));
  assert.equal(
    engine.internals.findGridPays(sevenGrid, engine.model.clusterPaytableMicro)
      .some((pay) => pay.symbol === 'S1'),
    false,
    '7 S1 no alcanzan el minimo'
  );

  const double = DISPERSED_S1.map((row) => row.slice());
  for (const [r, c] of [[0, 1], [0, 3], [0, 5], [1, 0], [1, 2], [2, 1], [2, 3], [3, 1]]) {
    double[r][c] = 'S2';
  }
  const doubleGrid = double.map((row) => row.map((symbol) => ({ s: symbol, v: 0 })));
  const pays = engine.internals.findGridPays(doubleGrid, engine.model.clusterPaytableMicro);
  assert.deepEqual(pays.map((pay) => pay.symbol), ['S1', 'S2']);
  assert.equal(pays.filter((pay) => pay.size === 8).length, 2);
});

test('scatter: la flor sobrevive a las cascadas y se evalua solo en la rejilla inicial', () => {
  const engine = createEngine();
  const withScatter = DISPERSED_S1.map((row) => row.slice());
  withScatter[0][1] = SCATTER;
  withScatter[0][3] = SCATTER;
  withScatter[0][5] = SCATTER;

  const spin = matrixSpin(engine, withScatter, [
    ['S2', 'S3'], ['S4'], ['S5', 'S7'], ['S8'], ['S9'], ['S2']
  ]);

  assert.equal(spin.scatter.count, 3);
  assert.equal(spin.cascadeCount, 1);
  assert.equal(
    spin.finalGrid.flat().filter((symbol) => symbol === SCATTER).length,
    3,
    'las flores no se eliminan en cascadas regulares'
  );
  /* La flor paga una sola vez (7,6x) y solo desde la matriz inicial. */
  assert.equal(spin.scatter.payMicro, 76000);
  assert.equal(spin.baseWinMicro, 927 + 76000);
  assert.equal(spin.winCents, 769);
});
