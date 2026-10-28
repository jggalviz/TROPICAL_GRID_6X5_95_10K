'use strict';

/** PROBE TEMPORAL: compara mecanismos de generacion de cuadricula. */

const { findGridPays, model } = (() => {
  const engine = require('../server/engine/gridEngine').createEngine();
  return { findGridPays: engine.internals.findGridPays, model: engine.model };
})();

const PAYTABLE = model.gridPaytableMicro;
const WEIGHTS = model.base.weights;

function createRng(seed) {
  let s = seed >>> 0;
  return {
    int(max) {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s % max;
    }
  };
}

function buildStrip(weights, length, runTable, seed) {
  const rng = createRng(seed);
  const symbols = Object.keys(weights);
  const total = symbols.reduce((acc, s) => acc + weights[s], 0);
  const strip = [];
  while (strip.length < length) {
    let ticket = rng.int(total);
    let symbol = symbols[0];
    for (const s of symbols) {
      if (ticket < weights[s]) { symbol = s; break; }
      ticket -= weights[s];
    }
    const run = runTable[rng.int(runTable.length)];
    for (let i = 0; i < run && strip.length < length; i += 1) strip.push(symbol);
  }
  return strip;
}

function gridFromStrips(strips, rng) {
  const grid = [];
  for (let r = 0; r < 5; r += 1) grid.push(new Array(6).fill(null));
  for (let c = 0; c < 6; c += 1) {
    const strip = strips[c];
    const stop = rng.int(strip.length);
    for (let i = 0; i < 5; i += 1) {
      const symbol = strip[(stop + i) % strip.length];
      grid[4 - i][c] = { s: symbol, v: 0 };
    }
  }
  return grid;
}

function markovGrid(weights, rng, alpha) {
  const grid = [];
  for (let r = 0; r < 5; r += 1) grid.push(new Array(6).fill(null));
  const symbols = Object.keys(weights);
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 6; c += 1) {
      const eff = symbols.map((s) => {
        let weight = weights[s];
        if (r > 0 && grid[r - 1][c] && grid[r - 1][c].s === s) weight *= 1 + alpha;
        if (c > 0 && grid[r][c - 1] && grid[r][c - 1].s === s) weight *= 1 + alpha;
        return weight;
      });
      const total = eff.reduce((a, b) => a + b, 0);
      let ticket = rng.int(total);
      let chosen = symbols[0];
      for (let i = 0; i < symbols.length; i += 1) {
        if (ticket < eff[i]) { chosen = symbols[i]; break; }
        ticket -= eff[i];
      }
      grid[r][c] = { s: chosen, v: 0 };
    }
  }
  return grid;
}

function measure(label, generator, iterations = 40000) {
  const rng = createRng(987654321);
  let hits = 0;
  let pay = 0;
  let paysCount = 0;
  let maxSize = 0;
  for (let i = 0; i < iterations; i += 1) {
    const grid = generator(rng);
    const found = findGridPays(grid, PAYTABLE);
    if (found.length > 0) hits += 1;
    paysCount += found.length;
    for (const entry of found) {
      pay += entry.payMicro;
      maxSize = Math.max(maxSize, entry.size);
    }
  }
  console.log(`${label.padEnd(34)} hit=${((hits / iterations) * 100).toFixed(2)}%  `
    + `pagos/cuad=${(paysCount / iterations).toFixed(3)}  `
    + `pago medio=${(pay / iterations / 10000).toFixed(4)}x  maxSize=${maxSize}`);
}

const run13 = [1, 1, 2, 2, 3, 3, 4];
const run15 = [1, 1, 1, 2, 2, 3, 3, 4, 5];
const run16 = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6];

measure('independiente', (rng) => markovGrid(WEIGHTS, rng, 0));
measure('markov alpha=1.5', (rng) => markovGrid(WEIGHTS, rng, 1.5));
measure('markov alpha=3', (rng) => markovGrid(WEIGHTS, rng, 3));
measure('markov alpha=6', (rng) => markovGrid(WEIGHTS, rng, 6));
measure('strips runs 1-4', (rng) => gridFromStrips(
  [0, 1, 2, 3, 4, 5].map((i) => buildStrip(WEIGHTS, 60, run13, 1000 + i)), rng
));
measure('strips runs 1-5', (rng) => gridFromStrips(
  [0, 1, 2, 3, 4, 5].map((i) => buildStrip(WEIGHTS, 60, run15, 2000 + i)), rng
));
measure('strips runs 1-6', (rng) => gridFromStrips(
  [0, 1, 2, 3, 4, 5].map((i) => buildStrip(WEIGHTS, 60, run16, 3000 + i)), rng
));
