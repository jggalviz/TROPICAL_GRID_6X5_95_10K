'use strict';

/**
 * ============================================================================
 *  TROPICAL_GRID_6X5_95_10K - SIMULADOR MONTE CARLO (CALIBRACION DE RTP)
 * ============================================================================
 *  Uso:
 *    node scripts/simulate.js --rounds=200000 --mode=base
 *    node scripts/simulate.js --rounds=50000  --mode=feature
 *    node scripts/simulate.js --rounds=20000  --mode=base --crypto
 *
 *  - Por defecto usa un PRNG rapido determinista SOLO para calibracion
 *    offline (no interviene en produccion).
 *  - Con --crypto usa el CSPRNG real del motor (mas lento, valida el flujo).
 *  - Mide RTP total, RTP por agrupaciones, factor multiplicador, tasa de
 *    acierto, ganancia maxima observada y % de rondas topadas al maximo.
 * ============================================================================
 */

const engineModule = require('../server/engine/gridEngine');

function parseArgs(argv) {
  const args = { rounds: 100000, mode: 'both', crypto: false, seed: 20240501, bet: 1, featureMx: 0 };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'rounds') args.rounds = Math.max(1, Number(value) || 1);
    else if (key === 'mode') args.mode = value || 'both';
    else if (key === 'crypto') args.crypto = value === undefined ? true : value !== 'false';
    else if (key === 'seed') args.seed = Number(value) || args.seed;
    else if (key === 'bet') args.bet = Number(value) || 1;
    else if (key === 'feature-mx') args.featureMx = Number(value) || 0;
    else if (key === 'help') args.help = true;
  }
  return args;
}

/** sfc32: PRNG de calibracion (NO se usa en produccion). */
function createFastRng(seed) {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  let draws = 0;

  function nextUint32() {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    draws += 1;
    return t;
  }
  for (let i = 0; i < 32; i += 1) nextUint32();

  function int(maxExclusive) {
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let value;
    do {
      value = nextUint32();
    } while (value >= limit);
    return value % maxExclusive;
  }

  return { int, float: () => int(0x100000000) / 0x100000000, draws: () => draws };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function runSimulation({ rounds, mode, cryptoMode, seed, betCredits, featureMx = 0 }) {
  const overrides = {};
  if (featureMx > 0) {
    overrides.featureWeights = { ...engineModule.model.feature.weights, MX: featureMx };
  }
  const engine = engineModule.createEngine(overrides);
  const buyFeature = mode === 'feature';
  const betCents = Math.round(betCredits * 100);
  const rng = cryptoMode ? null : createFastRng((seed ^ (buyFeature ? 0x5f5f : 0xaaaa)) >>> 0);

  let wageredCents = 0;
  let wonCents = 0;
  let baseWinMicroTotal = 0;
  let hits = 0;
  let cappedRounds = 0;
  let maxWinCents = 0;
  let spinsPlayed = 0;
  let multiplierSum = 0;
  let multiplierCount = 0;
  let bombRounds = 0;
  let clusterWinMicroTotal = 0;
  let scatterWinMicroTotal = 0;
  let sumRatio = 0;
  let sumRatioSq = 0;
  const winRatios = [];
  const bucketCounts = new Array(12).fill(0);

  const startedAt = Date.now();

  for (let i = 0; i < rounds; i += 1) {
    const result = engine.playRound({
      betCents,
      buyFeature,
      roundId: null,
      rng: rng || undefined,
      clientSeed: 'simulation'
    });

    wageredCents += result.wagerCents;
    wonCents += result.totalWinCents;
    spinsPlayed += result.spinsPlayed;
    if (result.totalWinCents > 0) hits += 1;
    if (result.capped) cappedRounds += 1;
    if (result.totalWinCents > maxWinCents) maxWinCents = result.totalWinCents;

    for (const spin of result.spins) {
      baseWinMicroTotal += spin.baseWinMicro;
      clusterWinMicroTotal += spin.clusterWinMicro;
      scatterWinMicroTotal += spin.scatter.payMicro;
      if (spin.bombs && spin.bombs.length > 0) bombRounds += 1;
      if (spin.baseWinMicro > 0) {
        multiplierSum += spin.multiplier;
        multiplierCount += 1;
      }
    }

    const ratio = result.totalWinCents / Math.max(1, result.betCents);
    const wageredRatio = result.wagerCents > 0 ? result.totalWinCents / result.wagerCents : 0;
    sumRatio += wageredRatio;
    sumRatioSq += wageredRatio * wageredRatio;
    winRatios.push(ratio);
    const bucket = ratio === 0 ? 0
      : ratio < 1 ? 1
        : ratio < 2 ? 2
          : ratio < 5 ? 3
            : ratio < 10 ? 4
              : ratio < 25 ? 5
                : ratio < 50 ? 6
                  : ratio < 100 ? 7
                    : ratio < 500 ? 8
                      : ratio < 1000 ? 9
                        : ratio < 10000 ? 10 : 11;
    bucketCounts[bucket] += 1;
  }

  winRatios.sort((a, b) => a - b);

  const elapsedMs = Date.now() - startedAt;
  const totalSpins = buyFeature ? spinsPlayed : rounds;
  const meanRatio = sumRatio / rounds;
  const variance = Math.max(0, sumRatioSq / rounds - meanRatio * meanRatio);
  const stdError = Math.sqrt(variance / rounds);
  return {
    mode: buyFeature ? 'BUY_FEATURE' : 'BASE',
    rounds,
    prng: cryptoMode ? 'crypto (HMAC-DRBG)' : 'sfc32 (calibracion)',
    elapsedMs,
    roundsPerSecond: Math.round((rounds / Math.max(1, elapsedMs)) * 1000),
    wagered: wageredCents / 100,
    won: wonCents / 100,
    rtp: wageredCents > 0 ? wonCents / wageredCents : 0,
    rtpStdError: stdError,
    rtpCi95: [Math.max(0, meanRatio - 1.96 * stdError), meanRatio + 1.96 * stdError],
    featureMx: featureMx || null,
    hitRate: hits / rounds,
    cappedRate: cappedRounds / rounds,
    maxWinX: maxWinCents / betCents,
    avgWinX: wonCents / betCents / rounds,
    clusterRtpShare: wageredCents > 0 ? ((clusterWinMicroTotal * betCents) / 10000) / wageredCents : 0,
    scatterRtpShare: wageredCents > 0 ? ((scatterWinMicroTotal * betCents) / 10000) / wageredCents : 0,
    avgMultiplierWhenWin: multiplierCount > 0 ? multiplierSum / multiplierCount : 0,
    bombRoundRate: bombRounds / Math.max(1, totalSpins),
    avgBaseWinUnits: (baseWinMicroTotal / Math.max(1, totalSpins)) / 10000,
    spinsPlayed,
    spinRtp: buyFeature && spinsPlayed > 0
      ? (wonCents / 100) / (spinsPlayed * (betCents / 100))
      : null,
    percentilesX: {
      p50: quantile(winRatios, 0.5),
      p90: quantile(winRatios, 0.9),
      p99: quantile(winRatios, 0.99),
      p999: quantile(winRatios, 0.999)
    },
    distribution: {
      zero: bucketCounts[0] / rounds,
      '0-1x': bucketCounts[1] / rounds,
      '1-2x': bucketCounts[2] / rounds,
      '2-5x': bucketCounts[3] / rounds,
      '5-10x': bucketCounts[4] / rounds,
      '10-25x': bucketCounts[5] / rounds,
      '25-50x': bucketCounts[6] / rounds,
      '50-100x': bucketCounts[7] / rounds,
      '100-500x': bucketCounts[8] / rounds,
      '500-1k': bucketCounts[9] / rounds,
      '1k-10k': bucketCounts[10] / rounds,
      '10k+': bucketCounts[11] / rounds
    }
  };
}

function printReport(report) {
  const pct = (value) => `${(value * 100).toFixed(4)}%`;
  console.log('');
  console.log('==================================================================');
  console.log(` TROPICAL_GRID_6X5_95_10K - Simulacion ${report.mode}`);
  console.log('==================================================================');
  console.log(` Rondas simuladas .........: ${report.rounds.toLocaleString('es-ES')}`);
  console.log(` PRNG .....................: ${report.prng}`);
  console.log(` Tiempo ...................: ${report.elapsedMs} ms (${report.roundsPerSecond}/s)`);
  console.log(` Total apostado ...........: ${report.wagered.toFixed(2)}`);
  console.log(` Total pagado .............: ${report.won.toFixed(2)}`);
  console.log(` RTP ......................: ${pct(report.rtp)}`);
  console.log(` Error estandar (IC95) .....: ${(report.rtpStdError * 100).toFixed(3)}% `
    + `[${pct(report.rtpCi95[0])} - ${pct(report.rtpCi95[1])}]`);
  if (report.featureMx) console.log(` Peso MX de feature ........: ${report.featureMx}`);
  console.log(` Tasa de acierto ..........: ${pct(report.hitRate)}`);
  console.log(` Media ganada / ronda .....: ${report.avgWinX.toFixed(4)}x`);
  console.log(` Maximo observado .........: ${report.maxWinX.toFixed(2)}x`);
  console.log(` Rondas topadas ...........: ${pct(report.cappedRate)}`);
  console.log(` RTP agrupaciones .........: ${pct(report.clusterRtpShare)}`);
  console.log(` RTP scatter ..............: ${pct(report.scatterRtpShare)}`);
  console.log(` Base win medio (unidades).: ${report.avgBaseWinUnits.toFixed(4)}x`);
  console.log(` Multiplicador medio (win).: ${report.avgMultiplierWhenWin.toFixed(3)}`);
  console.log(` Tiradas jugadas ..........: ${report.spinsPlayed.toLocaleString('es-ES')}`);
  if (report.spinRtp !== null) {
    console.log(` RTP por tirada del bonus .: ${pct(report.spinRtp)}`);
  }
  console.log(` Percentiles (x apuesta) ..: p50=${report.percentilesX.p50.toFixed(2)} `
    + `p90=${report.percentilesX.p90.toFixed(2)} p99=${report.percentilesX.p99.toFixed(2)} `
    + `p99.9=${report.percentilesX.p999.toFixed(2)}`);
  console.log('------------------------------------------------------------------');
  console.log(' Distribucion de premios (x apuesta):');
  for (const [bucket, share] of Object.entries(report.distribution)) {
    console.log(`   ${bucket.padEnd(10)} ${pct(share)}`);
  }
  console.log('==================================================================');
  console.log('');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Opciones: --rounds=N --mode=base|feature|both --crypto --seed=N --bet=1');
    return;
  }

  const modes = args.mode === 'both' ? ['base', 'feature'] : [args.mode];
  const reports = [];

  for (const mode of modes) {
    if (mode !== 'base' && mode !== 'feature') {
      throw new Error(`Modo invalido: ${mode}`);
    }
    const report = runSimulation({
      rounds: args.rounds,
      mode,
      cryptoMode: args.crypto,
      seed: args.seed,
      betCredits: args.bet,
      featureMx: args.featureMx
    });
    printReport(report);
    reports.push(report);
  }

  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '.sim');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `simulation-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    generatedAt: new Date().toISOString(),
    certifiedRtp: engineModule.CERTIFIED_RTP,
    reports
  }, null, 2));
  console.log(`Resultado guardado en ${file}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Error en la simulacion:', error);
    process.exitCode = 1;
  }
}

module.exports = { createFastRng, runSimulation };


