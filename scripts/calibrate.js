'use strict';

/**
 * ============================================================================
 *  HERRAMIENTA DE CALIBRACION DE TIRAS (OFFLINE)
 * ============================================================================
 *  Mide, para distintos vectores de pesos, la composicion real de las tiras
 *  fisicas, la probabilidad de que una tirada inicial contenga al menos un
 *  pago disperso >= 8 y el valor medio pagado. Sirve para disenar las tiras y
 *  la tabla de pagos antes de certificar el RTP.
 *
 *  Uso: node scripts/calibrate.js [--grids=200000]
 * ============================================================================
 */

const { createEngine, SCATTER, MULTIPLIER } = require('../server/engine/gridEngine');

function parseArg(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

const GRIDS = parseArg('grids', 200000);

const CANDIDATES = {
  'A-equilibrado (produccion)': {
    S1: 1500, S2: 1400, S3: 1250, S4: 1100, S5: 1000,
    S6: 850, S7: 700, S8: 550, S9: 450, SC: 250, MX: 140
  },
  'C-sesgo alto': {
    S1: 2400, S2: 2000, S3: 1600, S4: 1200, S5: 900,
    S6: 700, S7: 550, S8: 400, S9: 300, SC: 250, MX: 140
  },
  'D-sesgo muy alto': {
    S1: 2900, S2: 2300, S3: 1700, S4: 1200, S5: 850,
    S6: 620, S7: 450, S8: 320, S9: 220, SC: 250, MX: 140
  },
  'E-plano': {
    S1: 1000, S2: 1000, S3: 1000, S4: 1000, S5: 1000,
    S6: 1000, S7: 1000, S8: 1000, S9: 1000, SC: 310, MX: 175
  },
  'F-plano-suave': {
    S1: 1200, S2: 1200, S3: 1150, S4: 1100, S5: 1050,
    S6: 1000, S7: 950, S8: 900, S9: 850, SC: 310, MX: 175
  },
  'G-progresivo': {
    S1: 1700, S2: 1550, S3: 1400, S4: 1250, S5: 1100,
    S6: 1000, S7: 900, S8: 800, S9: 700, SC: 310, MX: 175
  }
};

function createFastRng(seed) {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  function next() {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  }
  for (let i = 0; i < 32; i += 1) next();
  return {
    int(max) {
      const limit = Math.floor(0x100000000 / max) * max;
      let v;
      do { v = next(); } while (v >= limit);
      return v % max;
    },
    float: () => next() / 0x100000000,
    draws: () => 0
  };
}

function analyse(label, weights) {
  const engine = createEngine({ baseWeights: weights });
  const internals = engine.internals;
  const model = engine.model;
  const paytable = model.gridPaytableMicro;
  const rng = createFastRng(1234567);
  const gridCount = GRIDS;

  let gridsWithPay = 0;
  let totalPays = 0;
  let totalPayMicro = 0;
  let bigPays = 0;
  let scatters = 0;
  let bombs = 0;
  const bySymbol = {};

  for (let i = 0; i < gridCount; i += 1) {
    const { grid } = internals.createReelState(rng, model.base.strips, model.base.pickers.multipliers);
    const pays = internals.findGridPays(grid, paytable);
    if (pays.length > 0) gridsWithPay += 1;
    totalPays += pays.length;
    for (const pay of pays) {
      totalPayMicro += pay.payMicro;
      if (pay.size >= 12) bigPays += 1;
      const entry = bySymbol[pay.symbol] || (bySymbol[pay.symbol] = { count: 0, pay: 0, max: 0 });
      entry.count += 1;
      entry.pay += pay.payMicro;
      entry.max = Math.max(entry.max, pay.size);
    }
    for (const row of grid) {
      for (const cell of row) {
        if (cell.s === SCATTER) scatters += 1;
        if (cell.s === MULTIPLIER) bombs += 1;
      }
    }
  }

  const cells = gridCount * 30;
  const avgPayUnits = totalPayMicro / gridCount / 10000;
  const stripPositions = model.base.strips.length * model.base.strips[0].length;
  const stripSc = model.base.strips.reduce(
    (sum, strip) => sum + strip.filter((symbol) => symbol === SCATTER).length, 0
  );
  const stripMx = model.base.strips.reduce(
    (sum, strip) => sum + strip.filter((symbol) => symbol === MULTIPLIER).length, 0
  );

  console.log('');
  console.log(`### ${label}`);
  console.log(`  Peso total .................: ${Object.values(weights).reduce((a, b) => a + b, 0)}`);
  console.log(`  Tira SC / MX ...............: ${((stripSc / stripPositions) * 100).toFixed(3)}% / ${((stripMx / stripPositions) * 100).toFixed(3)}%`);
  console.log(`  P(>=1 pago disperso inicial) : ${((gridsWithPay / gridCount) * 100).toFixed(2)}%`);
  console.log(`  Pagos dispersos/cuadricula .: ${(totalPays / gridCount).toFixed(3)}`);
  console.log(`  Pagos con conteo >=12 ......: ${((bigPays / gridCount) * 100).toFixed(3)}%`);
  console.log(`  Pago medio inicial .........: ${avgPayUnits.toFixed(4)}x apuesta`);
  console.log(`  Scatter por celda ..........: ${((scatters / cells) * 100).toFixed(3)}%`);
  console.log(`  Bomba por celda ............: ${((bombs / cells) * 100).toFixed(3)}%`);
  const symbols = Object.keys(bySymbol).sort();
  const distribution = symbols.map((symbol) => {
    const entry = bySymbol[symbol];
    return `${symbol}:${(entry.count / gridCount * 100).toFixed(1)}%/max${entry.max}`;
  }).join('  ');
  console.log(`  Reparto ....................: ${distribution}`);
  return { label, hitRate: gridsWithPay / gridCount, avgPayUnits };
}

function main() {
  console.log(`Calibracion con ${GRIDS.toLocaleString('es-ES')} cuadriculas por candidato`);
  const summary = [];
  for (const [label, weights] of Object.entries(CANDIDATES)) {
    summary.push(analyse(label, weights));
  }
  console.log('');
  console.log('=========================== RESUMEN ===========================');
  for (const row of summary) {
    console.log(`${row.label.padEnd(28)} hit=${(row.hitRate * 100).toFixed(2)}%  pago medio=${row.avgPayUnits.toFixed(4)}x`);
  }
}

main();
