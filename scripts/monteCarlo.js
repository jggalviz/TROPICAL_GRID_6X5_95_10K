'use strict';

/**
 * ============================================================================
 *  TROPICAL_GRID_6X5_95_10K - SIMULACION MONTE CARLO (OFFLINE)
 * ============================================================================
 *
 *  Objetivo:
 *    Medir con el motor autoritativo del juego (sin interfaz grafica):
 *      - RTP empirico = total pagado / total apostado * 100.
 *      - Frecuencia de aciertos (hit rate), por ronda y por tirada interna.
 *      - Volatilidad: desviacion estandar del retorno, percentiles y maximo.
 *      - Distribucion de premios por tramos (pequeno / mediano / grande /
 *        jackpot), con numero de casos y aporte a RTP.
 *
 *  Reglas del juego que NO se duplican aqui:
 *    - Rejilla 6x5, pagos por dispersion de 8+ simbolos, cascadas, scatter SC y
 *      bombas MX: todo vive en `server/engine/gridEngine.js`.
 *    - El script solo orquesta `playRound()` y agrega resultados.
 *
 *  Precision decimal:
 *    - El motor trabaja en centimos enteros y micro-unidades.
 *    - La simulacion acumula dinero en BigInt (centimos).
 *    - RTP y porcentajes se formatean con division entera escalada; no se
 *      usan floats para calcular importes.
 *
 *  PRNG:
 *    - Por defecto usa sfc32 determinista (rapido, solo calibracion offline).
 *    - `--crypto` usa el HMAC-DRBG real del motor (mas lento) para validar el
 *      flujo de produccion.
 *
 *  Uso:
 *    node scripts/monteCarlo.js
 *    node scripts/monteCarlo.js --rounds=1000000 --mode=both --seed=7
 *    node scripts/monteCarlo.js --rounds=100000 --mode=feature --bet=5
 *    node scripts/monteCarlo.js --help
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  createEngine,
  GAME_CODE,
  ENGINE_VERSION,
  PAYTABLE_VERSION,
  CERTIFIED_RTP,
  MAX_EXPOSURE_MULTIPLIER,
  BET_LADDER_CREDITS,
  isValidBetCredits,
  creditsToCents
} = require('../server/engine/gridEngine');
const { createFastRng } = require('./lib/fastRng');

const DEFAULT_ROUNDS = 100000;
const MAX_ROUNDS = 10000000;
const DEFAULT_SEED = 20261026;
const DEFAULT_JACKPOT_X = 1000;
const MIN_JACKPOT_X = 100;

const PRIZE_TIERS = Object.freeze([
  Object.freeze({ id: 'none', label: 'Sin premio' }),
  Object.freeze({ id: 'micro', label: 'Micro (<1x)' }),
  Object.freeze({ id: 'small', label: 'Pequeno (1-5x)' }),
  Object.freeze({ id: 'medium', label: 'Mediano (5-25x)' }),
  Object.freeze({ id: 'large', label: 'Grande (25-100x)' }),
  Object.freeze({ id: 'very-large', label: 'Muy grande (100-<umbral)' }),
  Object.freeze({ id: 'jackpot', label: 'Jackpot (>=umbral)' })
]);

/* ==========================================================================
 *  1. FORMATEO EXACTO (SIN FLOATS PARA DINERO)
 * ========================================================================== */

/** Agrupa miles con punto: 1234567 -> 1.234.567. */
function groupDigits(text) {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Formatea centimos enteros como creditos con dos decimales exactos. */
function formatCents(cents) {
  const value = typeof cents === 'bigint' ? cents : BigInt(Math.trunc(cents));
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const integerPart = absolute / 100n;
  const decimalPart = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${groupDigits(integerPart.toString())},${decimalPart}`;
}

/** Formatea un entero con separador de miles. */
function formatCount(value) {
  return groupDigits(String(value));
}

/** Formatea un valor ya escalado (p. ej. 917912 -> 91,7912 con 4 decimales). */
function formatScaled(scaled, decimals) {
  const scale = 10n ** BigInt(decimals);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const integerPart = absolute / scale;
  const fractionalPart = (absolute % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${groupDigits(integerPart.toString())},${fractionalPart}`;
}

/**
 * Calcula (numerador / denominador) * 100 con redondeo a `decimals` y sin
 * pasar por coma flotante. Devuelve el numero formateado, sin el simbolo %.
 */
function formatRatioPercent(numerator, denominator, decimals = 4) {
  const n = typeof numerator === 'bigint' ? numerator : BigInt(numerator);
  const d = typeof denominator === 'bigint' ? denominator : BigInt(denominator);
  if (d === 0n) return formatScaled(0n, decimals);

  const negative = (n < 0n) !== (d < 0n);
  const absoluteN = n < 0n ? -n : n;
  const absoluteD = d < 0n ? -d : d;
  const scale = 10n ** BigInt(decimals);
  const scaled = (absoluteN * 100n * scale + absoluteD / 2n) / absoluteD;
  const text = formatScaled(scaled, decimals);
  return negative && scaled !== 0n ? `-${text}` : text;
}

/** Formatea un numero real (solo para estadisticos, nunca para dinero). */
function formatDecimal(value, decimals = 4) {
  if (!Number.isFinite(value)) return 'n/d';
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals).replace('.', ',');
  return `${negative ? '-' : ''}${fixed}`;
}

/** Formatea una diferencia con signo explicito. */
function formatSignedDecimal(value, decimals = 4) {
  if (!Number.isFinite(value)) return 'n/d';
  return `${value > 0 ? '+' : ''}${formatDecimal(value, decimals)}`;
}

/**
 * Equivalencia de frecuencia: cuantos ensayos hacen falta, en media, para
 * observar un evento. Devuelve `null` si no hubo eventos en la muestra.
 * Solo se usa para estadisticos de presentacion, nunca para importes.
 */
function calculateOneInEvery(events, trials) {
  const eventCount = Number(events);
  const trialCount = Number(trials);
  if (!Number.isFinite(eventCount) || !Number.isFinite(trialCount)) return null;
  if (eventCount <= 0 || trialCount <= 0) return null;
  return trialCount / eventCount;
}

/* ==========================================================================
 *  2. TRAMOS DE PREMIO
 * ========================================================================== */

function tierLabel(id, jackpotX) {
  if (id === 'very-large') return `Muy grande (100-<${jackpotX}x)`;
  if (id === 'jackpot') return `Jackpot (>=${jackpotX}x)`;
  const tier = PRIZE_TIERS.find((entry) => entry.id === id);
  return tier ? tier.label : id;
}

function tierDefinition(id, jackpotX) {
  if (id === 'none') return 'pago = 0';
  if (id === 'micro') return '0 < pago < 1x';
  if (id === 'small') return '1x <= pago < 5x';
  if (id === 'medium') return '5x <= pago < 25x';
  if (id === 'large') return '25x <= pago < 100x';
  if (id === 'very-large') return `100x <= pago < ${jackpotX}x`;
  if (id === 'jackpot') return `pago >= ${jackpotX}x`;
  return '';
}

/**
 * Clasifica el pago de una ronda en multiplos de la APUESTA BASE.
 * En modo feature el coste de compra es 100x la apuesta base, pero los tramos
 * se mantienen en "x apuesta base" para que sean comparables con el modo base
 * y con el tope de exposicion del motor (10.000x).
 *
 * @param {number} winCents pago de la ronda en centimos (entero)
 * @param {number} betCents apuesta base en centimos (entero > 0)
 * @param {number} jackpotX umbral de jackpot en multiplos de la apuesta base
 * @returns {'none'|'micro'|'small'|'medium'|'large'|'very-large'|'jackpot'}
 */
function classifyPrizeTier(winCents, betCents, jackpotX = DEFAULT_JACKPOT_X) {
  if (!Number.isSafeInteger(winCents) || winCents < 0) {
    throw new RangeError(`winCents invalido: ${winCents}`);
  }
  if (!Number.isSafeInteger(betCents) || betCents <= 0) {
    throw new RangeError(`betCents invalido: ${betCents}`);
  }
  if (!Number.isSafeInteger(jackpotX) || jackpotX < 2) {
    throw new RangeError(`jackpotX invalido: ${jackpotX}`);
  }

  if (winCents === 0) return 'none';
  if (winCents < betCents) return 'micro';
  if (winCents < betCents * 5) return 'small';
  if (winCents < betCents * 25) return 'medium';
  if (winCents < betCents * 100) return 'large';
  if (winCents < betCents * jackpotX) return 'very-large';
  return 'jackpot';
}


/* ==========================================================================
 *  3. ARGUMENTOS Y ESTADISTICOS AUXILIARES
 * ========================================================================== */

const USAGE = [
  'TROPICAL_GRID_6X5_95_10K - Monte Carlo offline',
  '',
  'Uso:',
  '  node scripts/monteCarlo.js [opciones]',
  '',
  'Opciones:',
  `  --rounds=N       Rondas por modo (1..${MAX_ROUNDS}). Default: ${DEFAULT_ROUNDS}.`,
  '  --mode=MODO      base | feature | both. Default: base.',
  '  --bet=N          Apuesta base en creditos de la escalera oficial. Default: 1.',
  `  --seed=N         Semilla sfc32 (0..4294967295). Default: ${DEFAULT_SEED}.`,
  `  --jackpot=N      Umbral de jackpot en x apuesta base (100..${MAX_EXPOSURE_MULTIPLIER}).`,
  `                   Default: ${DEFAULT_JACKPOT_X}.`,
  '  --crypto         Usa el HMAC-DRBG real del motor (lento, valida el flujo).',
  '  --no-save        No escribe la evidencia JSON en .sim/.',
  '  --json=PATH      Ruta personalizada del JSON de evidencia.',
  '  --quiet          Sin cabecera ni barra de progreso.',
  '  --help           Muestra esta ayuda.',
  '',
  'Ejemplos:',
  '  node scripts/monteCarlo.js',
  '  node scripts/monteCarlo.js --rounds=1000000 --mode=both --seed=7',
  '  node scripts/monteCarlo.js --rounds=100000 --mode=feature --bet=5',
  '  node scripts/monteCarlo.js --rounds=250000 --jackpot=250',
  '',
  `Escalera de apuestas: ${BET_LADDER_CREDITS.join(' / ')} creditos.`
].join('\n');

function parseInteger(value, name, { min, max }) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} debe ser un entero entre ${min} y ${max}. Recibido: ${value}`);
  }
  return parsed;
}

function parseBoolean(value, name) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`--${name} debe ser true o false. Recibido: ${value}`);
}


/**
 * Parser sin dependencias. Acepta `--clave=valor` y `--clave valor`.
 * @param {string[]} argv
 */
function parseArgs(argv = []) {
  const args = {
    rounds: DEFAULT_ROUNDS,
    mode: 'base',
    bet: 1,
    betCents: creditsToCents(1),
    seed: DEFAULT_SEED,
    jackpot: DEFAULT_JACKPOT_X,
    jackpotX: DEFAULT_JACKPOT_X,
    crypto: false,
    save: true,
    jsonPath: null,
    quiet: false,
    help: false
  };
  const booleanFlags = new Set(['crypto', 'no-save', 'quiet', 'help']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error(`Argumento no reconocido: ${token}`);
    }

    const equalsAt = token.indexOf('=');
    let key;
    let value;
    if (equalsAt >= 0) {
      key = token.slice(2, equalsAt);
      value = token.slice(equalsAt + 1);
    } else {
      key = token.slice(2);
      if (booleanFlags.has(key)) {
        value = true;
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`Falta el valor de --${key}`);
        }
        value = next;
        index += 1;
      }
    }

    switch (key) {
      case 'rounds':
        args.rounds = parseInteger(value, key, { min: 1, max: MAX_ROUNDS });
        break;
      case 'mode':
        if (value !== 'base' && value !== 'feature' && value !== 'both') {
          throw new Error(`--mode invalido: ${value}. Use base, feature o both.`);
        }
        args.mode = value;
        break;
      case 'bet': {
        const bet = Number(value);
        if (!Number.isFinite(bet) || !isValidBetCredits(bet)) {
          throw new Error(
            `--bet invalido: ${value}. Use la escalera oficial: ${BET_LADDER_CREDITS.join(' / ')}.`
          );
        }
        args.bet = bet;
        args.betCents = creditsToCents(bet);
        break;
      }
      case 'seed':
        args.seed = parseInteger(value, key, { min: 0, max: 0xffffffff });
        break;
      case 'jackpot':
        args.jackpot = parseInteger(value, key, {
          min: MIN_JACKPOT_X,
          max: MAX_EXPOSURE_MULTIPLIER
        });
        args.jackpotX = args.jackpot;
        break;
      case 'crypto':
        args.crypto = parseBoolean(value, key);
        break;
      case 'no-save':
        args.save = !parseBoolean(value, key);
        break;
      case 'quiet':
        args.quiet = parseBoolean(value, key);
        break;
      case 'help':
        args.help = parseBoolean(value, key);
        break;
      case 'json':
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error('--json requiere una ruta no vacia.');
        }
        args.jsonPath = value;
        break;
      default:
        throw new Error(`Opcion desconocida: --${key}. Use --help.`);
    }
  }

  return args;
}


/** Percentil con orden ascendente; mismo criterio que scripts/simulate.js. */
function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

/** Acumulador de media/varianza numericamente estable (Welford). */
function createWelford() {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  return {
    add(value) {
      count += 1;
      const delta = value - mean;
      mean += delta / count;
      m2 += delta * (value - mean);
    },
    get count() {
      return count;
    },
    get mean() {
      return mean;
    },
    variance() {
      return count > 1 ? m2 / (count - 1) : 0;
    },
    stdDev() {
      return Math.sqrt(this.variance());
    }
  };
}

/**
 * Clasificacion interna de volatilidad sobre sigma del retorno por ronda.
 * No es una norma de industria: sirve para comparar versiones del mismo juego.
 */
function classifyVolatility(stdDev) {
  if (!Number.isFinite(stdDev) || stdDev < 0) return 'N/D';
  if (stdDev < 1) return 'BAJA';
  if (stdDev < 3) return 'MEDIA';
  if (stdDev < 8) return 'ALTA';
  return 'MUY ALTA';
}


/* ==========================================================================
 *  4. EJECUCION DE LA SIMULACION
 * ========================================================================== */

/**
 * Ejecuta `rounds` rondas autoritativas de un solo modo y devuelve un informe
 * serializable. No imprime nada: la salida de terminal vive en printReport().
 *
 * @param {object} options
 * @param {number} options.rounds
 * @param {'base'|'feature'} options.mode
 * @param {number} [options.betCredits=1]
 * @param {number} [options.seed=DEFAULT_SEED]
 * @param {number} [options.jackpotX=DEFAULT_JACKPOT_X]
 * @param {boolean} [options.cryptoMode=false]
 * @param {((fraction:number)=>void)|null} [options.onProgress]
 */
function runMonteCarlo({
  rounds,
  mode,
  betCredits = 1,
  seed = DEFAULT_SEED,
  jackpotX = DEFAULT_JACKPOT_X,
  cryptoMode = false,
  onProgress = null
}) {
  if (mode !== 'base' && mode !== 'feature') {
    throw new Error(`Modo invalido: ${mode}. Use base o feature.`);
  }
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new RangeError(`rounds invalido: ${rounds}`);
  }
  if (!isValidBetCredits(betCredits)) {
    throw new RangeError(`betCredits invalido: ${betCredits}`);
  }
  if (!Number.isSafeInteger(jackpotX) || jackpotX < MIN_JACKPOT_X || jackpotX > MAX_EXPOSURE_MULTIPLIER) {
    throw new RangeError(`jackpotX invalido: ${jackpotX}`);
  }

  const engine = createEngine();
  const buyFeature = mode === 'feature';
  const betCents = creditsToCents(betCredits);
  const creditCost = buyFeature ? engine.model.feature.costMultiplier : 1;
  const wagerCents = betCents * creditCost;
  const certified = buyFeature ? CERTIFIED_RTP.feature : CERTIFIED_RTP.base;
  const certifiedCi = buyFeature ? CERTIFIED_RTP.featureCi95 : CERTIFIED_RTP.baseCi95;
  const rng = cryptoMode ? null : createFastRng((seed ^ (buyFeature ? 0x5f5f : 0xaaaa)) >>> 0);
  const tierIndex = new Map(PRIZE_TIERS.map((tier, index) => [tier.id, index]));
  const progressEvery = Math.max(1, Math.floor(rounds / 100));

  let wageredCents = 0n;
  let wonCents = 0n;
  let hits = 0;
  let profitHits = 0;
  let cappedRounds = 0;
  let maxWinCents = 0;
  let totalSpins = 0;
  let spinHits = 0;
  let cascadeTotal = 0;
  let bombSpins = 0;
  let scatterSpins = 0;
  let multiplierSum = 0;
  let multiplierCount = 0;
  const bucketCounts = new Array(PRIZE_TIERS.length).fill(0);
  const bucketWins = new Array(PRIZE_TIERS.length).fill(0n);
  const prizeMultiples = new Float64Array(rounds);
  const returnStats = createWelford();
  const prizeStats = createWelford();

  const startedAt = process.hrtime.bigint();

  for (let round = 0; round < rounds; round += 1) {
    const result = engine.playRound({
      betCents,
      buyFeature,
      roundId: null,
      rng: rng || undefined,
      clientSeed: 'montecarlo'
    });

    wageredCents += BigInt(result.wagerCents);
    wonCents += BigInt(result.totalWinCents);

    const tierId = classifyPrizeTier(result.totalWinCents, betCents, jackpotX);
    const index = tierIndex.get(tierId);
    bucketCounts[index] += 1;
    bucketWins[index] += BigInt(result.totalWinCents);

    if (result.totalWinCents > 0) hits += 1;
    if (result.totalWinCents > result.wagerCents) profitHits += 1;
    if (result.capped) cappedRounds += 1;
    if (result.totalWinCents > maxWinCents) maxWinCents = result.totalWinCents;

    totalSpins += result.spinsPlayed;
    for (const spin of result.spins) {
      if (spin.winCents > 0) spinHits += 1;
      cascadeTotal += spin.cascadeCount;
      if (spin.bombs && spin.bombs.length > 0) bombSpins += 1;
      if (spin.scatter && spin.scatter.payMicro > 0) scatterSpins += 1;
      if (spin.baseWinMicro > 0) {
        multiplierSum += spin.multiplierApplied;
        multiplierCount += 1;
      }
    }

    const returnMultiple = result.totalWinCents / result.wagerCents;
    const prizeMultiple = result.totalWinCents / betCents;
    returnStats.add(returnMultiple);
    prizeStats.add(prizeMultiple);
    prizeMultiples[round] = prizeMultiple;

    if (onProgress && (round + 1) % progressEvery === 0) {
      onProgress((round + 1) / rounds);
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  prizeMultiples.sort();

  const rtpValue = Number(wonCents) / Number(wageredCents);
  const rtpVariance = returnStats.variance();
  const rtpStdDev = Math.sqrt(rtpVariance);
  const rtpStdError = rtpStdDev / Math.sqrt(rounds);
  const rtpCiLow = Math.max(0, returnStats.mean - 1.96 * rtpStdError);
  const rtpCiHigh = returnStats.mean + 1.96 * rtpStdError;
  const prizeStdDev = prizeStats.stdDev();

  const hitRate = hits / rounds;
  const profitHitRate = profitHits / rounds;
  const cappedRate = cappedRounds / rounds;
  const misses = rounds - hits;
  const roundsPerHit = calculateOneInEvery(hits, rounds);
  const roundsPerProfitHit = calculateOneInEvery(profitHits, rounds);
  const roundsPerMiss = calculateOneInEvery(misses, rounds);
  const spinOneIn = calculateOneInEvery(spinHits, totalSpins);
  const roundsPerCap = calculateOneInEvery(cappedRounds, rounds);
  const maxWinXBet = maxWinCents / betCents;
  const maxWinXWager = maxWinCents / wagerCents;
  const avgWinXBet = Number(wonCents) / (betCents * rounds);
  const bucketCountsSum = bucketCounts.reduce((sum, value) => sum + value, 0);
  const bucketWinsSum = bucketWins.reduce((sum, value) => sum + value, 0n);
  const capCents = betCents * MAX_EXPOSURE_MULTIPLIER;
  const headroomCents = capCents - maxWinCents;
  const netCents = wageredCents - wonCents;
  const avgWonPerRoundCents = Number(wonCents) / rounds;
  const avgWonPerWinningRoundCents = hits > 0 ? Number(wonCents) / hits : 0;
  const capUsage = capCents > 0 ? maxWinCents / capCents : 0;
  const headroomPercent = capCents > 0 ? (headroomCents / capCents) * 100 : 0;

  const buckets = PRIZE_TIERS.map((tier, index) => ({
    id: tier.id,
    label: tierLabel(tier.id, jackpotX),
    definition: tierDefinition(tier.id, jackpotX),
    rounds: bucketCounts[index],
    share: bucketCounts[index] / rounds,
    sharePercent: formatRatioPercent(BigInt(bucketCounts[index]), BigInt(rounds), 4),
    paidCents: bucketWins[index].toString(),
    paidCentsFormatted: groupDigits(bucketWins[index].toString()),
    paidCredits: formatCents(bucketWins[index]),
    payoutShare: wonCents > 0n ? Number(bucketWins[index]) / Number(wonCents) : 0,
    payoutSharePercent: formatRatioPercent(bucketWins[index], wonCents, 4),
    rtpContribution: (Number(bucketWins[index]) / Number(wageredCents)) * 100,
    rtpContributionPercent: formatRatioPercent(bucketWins[index], wageredCents, 4)
  }));

  return {
    generatedAt: new Date().toISOString(),
    gameCode: GAME_CODE,
    engineVersion: ENGINE_VERSION,
    paytableVersion: PAYTABLE_VERSION,
    mode: buyFeature ? 'FEATURE' : 'BASE',
    buyFeature,
    rounds,
    betCredits,
    betCents,
    creditCost,
    wagerCents,
    wagerCredits: formatCents(BigInt(wagerCents)),
    maxExposureX: MAX_EXPOSURE_MULTIPLIER,
    jackpotX,
    seed: cryptoMode ? null : (seed >>> 0),
    prng: cryptoMode ? 'crypto (HMAC-DRBG)' : 'sfc32 (offline)',
    cryptoMode,
    elapsedMs,
    roundsPerSecond: elapsedMs > 0 ? Math.round((rounds / elapsedMs) * 1000) : 0,
    hits,
    profitHits,
    misses,
    hitRate,
    hitRatePercent: formatRatioPercent(BigInt(hits), BigInt(rounds), 4),
    profitHitRate,
    profitHitRatePercent: formatRatioPercent(BigInt(profitHits), BigInt(rounds), 4),
    roundsPerHit,
    roundsPerHitFormatted: roundsPerHit === null ? null : formatDecimal(roundsPerHit, 2),
    roundsPerProfitHit,
    roundsPerProfitHitFormatted: roundsPerProfitHit === null ? null : formatDecimal(roundsPerProfitHit, 2),
    roundsPerMiss,
    roundsPerMissFormatted: roundsPerMiss === null ? null : formatDecimal(roundsPerMiss, 2),
    hitFrequency: {
      definition: 'pago > 0',
      hits,
      rounds,
      rate: hitRate,
      percent: formatRatioPercent(BigInt(hits), BigInt(rounds), 4),
      oneInRounds: roundsPerHit,
      oneInRoundsFormatted: roundsPerHit === null ? null : formatDecimal(roundsPerHit, 2)
    },
    profitHitFrequency: {
      definition: 'pago > apuesta',
      hits: profitHits,
      rounds,
      rate: profitHitRate,
      percent: formatRatioPercent(BigInt(profitHits), BigInt(rounds), 4),
      oneInRounds: roundsPerProfitHit,
      oneInRoundsFormatted: roundsPerProfitHit === null ? null : formatDecimal(roundsPerProfitHit, 2)
    },
    missFrequency: {
      definition: 'pago = 0',
      hits: misses,
      rounds,
      rate: misses / rounds,
      percent: formatRatioPercent(BigInt(misses), BigInt(rounds), 4),
      oneInRounds: roundsPerMiss,
      oneInRoundsFormatted: roundsPerMiss === null ? null : formatDecimal(roundsPerMiss, 2)
    },
    cappedRate,
    cappedRatePercent: formatRatioPercent(BigInt(cappedRounds), BigInt(rounds), 4),
    maxWinCents: maxWinCents.toString(),
    maxWinCredits: formatCents(BigInt(maxWinCents)),
    maxWinXBet,
    maxWinXWager,
    avgWinXBet,
    avgWinXWager: rtpValue,
    totals: {
      wageredCents: wageredCents.toString(),
      wonCents: wonCents.toString(),
      wageredCredits: formatCents(wageredCents),
      wonCredits: formatCents(wonCents)
    },
    cents: {
      betCents,
      wagerPerRoundCents: wagerCents,
      totalWageredCents: wageredCents.toString(),
      totalWonCents: wonCents.toString(),
      netCents: netCents.toString(),
      netCredits: formatCents(netCents),
      avgWonPerRoundCents,
      avgWonPerRoundCentsFormatted: formatDecimal(avgWonPerRoundCents, 4),
      avgWonPerWinningRoundCents,
      avgWonPerWinningRoundCentsFormatted: formatDecimal(avgWonPerWinningRoundCents, 4)
    },
    caps: {
      maxExposureX: MAX_EXPOSURE_MULTIPLIER,
      maxExposureCents: capCents.toString(),
      maxExposureCentsFormatted: groupDigits(capCents.toString()),
      maxExposureCredits: formatCents(BigInt(capCents)),
      cappedRounds,
      cappedRate,
      cappedRatePercent: formatRatioPercent(BigInt(cappedRounds), BigInt(rounds), 4),
      roundsPerCap,
      roundsPerCapFormatted: roundsPerCap === null ? null : formatDecimal(roundsPerCap, 2),
      maxObservedWinCents: maxWinCents.toString(),
      maxObservedWinCentsFormatted: groupDigits(maxWinCents.toString()),
      maxObservedWinCredits: formatCents(BigInt(maxWinCents)),
      maxObservedWinXBet: maxWinXBet,
      maxObservedWinXWager: maxWinXWager,
      maxWinCapUsagePercent: capUsage * 100,
      headroomCents: headroomCents.toString(),
      headroomCentsFormatted: groupDigits(headroomCents.toString()),
      headroomCredits: formatCents(BigInt(headroomCents)),
      headroomPercent,
      capReached: maxWinCents >= capCents
    },
    rtp: {
      value: rtpValue,
      percent: rtpValue * 100,
      exactPercent: formatRatioPercent(wonCents, wageredCents, 4),
      stdErrorPercent: rtpStdError * 100,
      ci95: {
        low: rtpCiLow,
        high: rtpCiHigh,
        lowPercent: rtpCiLow * 100,
        highPercent: rtpCiHigh * 100,
        lowFormatted: formatDecimal(rtpCiLow * 100, 4),
        highFormatted: formatDecimal(rtpCiHigh * 100, 4)
      },
      target: CERTIFIED_RTP.target,
      certified,
      certifiedPercent: certified * 100,
      certifiedFormatted: formatDecimal(certified * 100, 4),
      certifiedCi95: [certifiedCi[0] * 100, certifiedCi[1] * 100],
      certifiedWithinCi: certified >= rtpCiLow && certified <= rtpCiHigh,
      differenceVsCertifiedPp: (rtpValue - certified) * 100,
      differenceVsTargetPp: (rtpValue - CERTIFIED_RTP.target) * 100
    },
    volatility: {
      stdDevXWager: rtpStdDev,
      stdDevXBet: prizeStdDev,
      coefficientOfVariation: returnStats.mean !== 0 ? rtpStdDev / returnStats.mean : 0,
      classification: classifyVolatility(rtpStdDev),
      classificationNote: 'BAJA <1, MEDIA <3, ALTA <8, MUY ALTA >=8 (sigma del retorno x apostado)'
    },
    percentilesXBet: {
      p50: percentile(prizeMultiples, 0.5),
      p75: percentile(prizeMultiples, 0.75),
      p90: percentile(prizeMultiples, 0.9),
      p95: percentile(prizeMultiples, 0.95),
      p99: percentile(prizeMultiples, 0.99),
      p999: percentile(prizeMultiples, 0.999),
      max: maxWinXBet
    },
    distribution: buckets,
    diagnostics: {
      totalSpins,
      spinsPerRound: totalSpins / rounds,
      spinHits,
      spinHitRate: totalSpins > 0 ? spinHits / totalSpins : 0,
      spinHitRatePercent: formatRatioPercent(BigInt(spinHits), BigInt(totalSpins || 1), 4),
      spinOneIn,
      spinOneInFormatted: spinOneIn === null ? null : formatDecimal(spinOneIn, 2),
      avgCascadesPerSpin: totalSpins > 0 ? cascadeTotal / totalSpins : 0,
      bombSpins,
      bombSpinRate: totalSpins > 0 ? bombSpins / totalSpins : 0,
      bombSpinRatePercent: formatRatioPercent(BigInt(bombSpins), BigInt(totalSpins || 1), 4),
      scatterSpins,
      scatterSpinRate: totalSpins > 0 ? scatterSpins / totalSpins : 0,
      scatterSpinRatePercent: formatRatioPercent(BigInt(scatterSpins), BigInt(totalSpins || 1), 4),
      avgMultiplierWhenBaseWin: multiplierCount > 0 ? multiplierSum / multiplierCount : 0
    },
    checks: {
      bucketCountsSum: bucketCountsSum === rounds,
      bucketWinsSum: bucketWinsSum === wonCents,
      wageredMatches: wageredCents === BigInt(wagerCents) * BigInt(rounds),
      maxWinWithinCap: maxWinCents <= betCents * MAX_EXPOSURE_MULTIPLIER
    }
  };
}


/* ==========================================================================
 *  5. SALIDA DE TERMINAL
 * ========================================================================== */

function printStartup(args, modes) {
  const separator = '='.repeat(88);
  console.log('');
  console.log(separator);
  console.log(' TROPICAL_GRID_6X5_95_10K - MONTE CARLO (OFFLINE)');
  console.log(' Simulacion con el motor autoritativo, sin interfaz grafica');
  console.log(separator);
  console.log(` Modo(s) .................: ${modes.join(' + ').toUpperCase()}`);
  console.log(` Rondas por modo .........: ${formatCount(args.rounds)}`);
  console.log(` Apuesta base ............: ${formatCents(BigInt(args.betCents))} creditos (${args.betCents} centimos)`);
  console.log(` Semilla .................: ${args.crypto ? 'n/a (--crypto)' : args.seed}`);
  console.log(` PRNG ....................: ${args.crypto ? 'HMAC-DRBG real del motor' : 'sfc32 offline'}`);
  console.log(` Umbral jackpot ..........: ${args.jackpotX}x apuesta base`);
  console.log(' Reglas ..................: server/engine/gridEngine.playRound()');
  console.log(separator);
  console.log('');
}

function printReport(report) {
  const separator = '='.repeat(88);
  const sub = '-'.repeat(88);
  const totalPayoutShare = formatRatioPercent(
    BigInt(report.totals.wonCents),
    BigInt(report.totals.wonCents),
    4
  );

  console.log(separator);
  console.log(` MODO ${report.mode} - ${report.buyFeature ? `compra de bonus (${report.creditCost}x)` : 'giro base'}`);
  console.log(separator);
  console.log(` Motor / paytable .......: ${report.engineVersion} / ${report.paytableVersion}`);
  console.log(` PRNG / semilla .........: ${report.prng}${report.seed === null ? '' : ` / ${report.seed}`}`);
  console.log(` Rondas / apuesta .......: ${formatCount(report.rounds)} / ${formatCents(BigInt(report.betCents))} creditos`);
  console.log(` Importe por ronda ......: ${formatCents(BigInt(report.wagerCents))} creditos (${report.creditCost}x apuesta base)`);
  console.log(` Tiempo .................: ${formatCount(Math.round(report.elapsedMs))} ms (${formatCount(report.roundsPerSecond)} rondas/s)`);
  console.log(sub);

  console.log(' ECONOMIA Y RTP (IMPORTES EXACTOS EN CENTIMOS)');
  console.log(` Total apostado .........: ${report.totals.wageredCredits} creditos (${formatCount(report.totals.wageredCents)} cts)`);
  console.log(` Total pagado ...........: ${report.totals.wonCredits} creditos (${formatCount(report.totals.wonCents)} cts)`);
  console.log(` Resultado operador .....: ${report.cents.netCredits} creditos (${formatCount(report.cents.netCents)} cts)`);
  console.log(` Pago medio / ronda .....: ${report.cents.avgWonPerRoundCentsFormatted} cts`);
  console.log(` Pago medio si gana .....: ${report.cents.avgWonPerWinningRoundCentsFormatted} cts (${formatCount(report.hits)} rondas)`);
  console.log(` RTP empirico ...........: ${report.rtp.exactPercent} %`);
  console.log(`   Formula ..............: (${formatCount(report.totals.wonCents)} cts / ${formatCount(report.totals.wageredCents)} cts) * 100`);
  console.log(`   Error estandar .......: ${formatDecimal(report.rtp.stdErrorPercent, 4)} pp`);
  console.log(`   IC 95% ...............: ${report.rtp.ci95.lowFormatted} % - ${report.rtp.ci95.highFormatted} %`);
  console.log(` RTP certificado ........: ${report.rtp.certifiedFormatted} % (referencia certificada)`);
  console.log(` Diferencia vs certif ...: ${formatSignedDecimal(report.rtp.differenceVsCertifiedPp, 4)} pp`);
  console.log(` Diferencia vs objetivo .: ${formatSignedDecimal(report.rtp.differenceVsTargetPp, 4)} pp (target ${formatDecimal(report.rtp.target * 100, 2)} %)`);
  console.log(` Certificado dentro IC .: ${report.rtp.certifiedWithinCi ? 'SI' : 'NO'}`);
  console.log(sub);

  console.log(' FRECUENCIA DE ACIERTOS (HIT FREQUENCY)');
  console.log(` Hit frequency ..........: ${report.hitFrequency.percent} % (${formatCount(report.hitFrequency.hits)} de ${formatCount(report.hitFrequency.rounds)})`);
  console.log(`   1 victoria por cada ..: ${report.hitFrequency.oneInRoundsFormatted
    ? `${report.hitFrequency.oneInRoundsFormatted} giros (pago > 0)`
    : 'sin victorias en la muestra'}`);
  console.log(` Acierto con beneficio ..: ${report.profitHitFrequency.percent} % (pago > apuesta)`);
  console.log(`   1 beneficio por cada .: ${report.profitHitFrequency.oneInRoundsFormatted
    ? `${report.profitHitFrequency.oneInRoundsFormatted} giros`
    : 'sin beneficios en la muestra'}`);
  console.log(` Rondas sin premio ......: ${report.missFrequency.percent} %`);
  console.log(`   1 giro sin premio ....: ${report.missFrequency.oneInRoundsFormatted
    ? `cada ${report.missFrequency.oneInRoundsFormatted} giros`
    : 'sin giros sin premio en la muestra'}`);
  console.log(` Hit rate por tirada ....: ${report.diagnostics.spinHitRatePercent} % (${formatCount(report.diagnostics.spinHits)} de ${formatCount(report.diagnostics.totalSpins)})`);
  console.log(`   1 premio por cada ....: ${report.diagnostics.spinOneInFormatted
    ? `${report.diagnostics.spinOneInFormatted} tiradas internas`
    : 'sin premios internos en la muestra'}`);
  console.log(sub);

  console.log(' VOLATILIDAD');
  console.log(` Retorno medio / ronda ..: ${formatDecimal(report.avgWinXWager, 4)}x importe apostado (${formatDecimal(report.avgWinXBet, 4)}x apuesta base)`);
  console.log(` Desv. est. retorno .....: ${formatDecimal(report.volatility.stdDevXWager, 4)}x importe apostado`);
  console.log(` Desv. est. premio ......: ${formatDecimal(report.volatility.stdDevXBet, 4)}x apuesta base`);
  console.log(` Coef. de variacion .....: ${formatDecimal(report.volatility.coefficientOfVariation, 4)}`);
  console.log(` Indice de volatilidad ..: ${report.volatility.classification} (sigma del retorno)`);
  console.log(` Percentiles x apuesta ..: p50=${formatDecimal(report.percentilesXBet.p50, 2)}`
    + ` p75=${formatDecimal(report.percentilesXBet.p75, 2)}`
    + ` p90=${formatDecimal(report.percentilesXBet.p90, 2)}`
    + ` p95=${formatDecimal(report.percentilesXBet.p95, 2)}`
    + ` p99=${formatDecimal(report.percentilesXBet.p99, 2)}`
    + ` p99.9=${formatDecimal(report.percentilesXBet.p999, 2)}`);
  console.log(` Maximo observado .......: ${formatDecimal(report.maxWinXBet, 2)}x apuesta base`
    + ` (${formatDecimal(report.maxWinXWager, 2)}x importe apostado)`);
  console.log(sub);

  console.log(' DISTRIBUCION DE PREMIOS (pago en x apuesta base)');
  console.log(` ${'Tramo'.padEnd(28)} ${'Rondas'.padStart(10)} ${'% rondas'.padStart(10)}`
    + ` ${'Pago total'.padStart(15)} ${'% del pago'.padStart(11)} ${'RTP'.padStart(9)}`);
  console.log(` ${'-'.repeat(28)} ${'-'.repeat(10)} ${'-'.repeat(10)}`
    + ` ${'-'.repeat(15)} ${'-'.repeat(11)} ${'-'.repeat(9)}`);
  for (const bucket of report.distribution) {
    console.log(` ${bucket.label.padEnd(28)}`
      + ` ${formatCount(bucket.rounds).padStart(10)}`
      + ` ${`${bucket.sharePercent} %`.padStart(10)}`
      + ` ${bucket.paidCredits.padStart(15)}`
      + ` ${`${bucket.payoutSharePercent} %`.padStart(11)}`
      + ` ${`${bucket.rtpContributionPercent} %`.padStart(9)}`);
  }
  console.log(` ${'TOTAL'.padEnd(28)}`
    + ` ${formatCount(report.rounds).padStart(10)}`
    + ` ${'100,0000 %'.padStart(10)}`
    + ` ${report.totals.wonCredits.padStart(15)}`
    + ` ${`${totalPayoutShare} %`.padStart(11)}`
    + ` ${`${report.rtp.exactPercent} %`.padStart(9)}`);
  console.log(' Tramos: 0 | <1x | 1-<5x | 5-<25x | 25-<100x | 100-<umbral | >=umbral.');
  console.log(` Referencia: pagos en x apuesta base${report.buyFeature ? `; la compra cuesta ${report.creditCost}x` : ''}.`);
  console.log(` Umbral de jackpot: ${report.jackpotX}x apuesta base.`);
  console.log(sub);

  console.log(' DESGLOSE EXACTO POR TRAMO (CENTIMOS)');
  console.log(` ${'Tramo'.padEnd(26)} ${'Rondas'.padStart(9)} ${'% rondas'.padStart(9)}`
    + ` ${'Pagado cts'.padStart(16)} ${'Creditos'.padStart(14)} ${'RTP'.padStart(8)}`);
  console.log(` ${'-'.repeat(26)} ${'-'.repeat(9)} ${'-'.repeat(9)}`
    + ` ${'-'.repeat(16)} ${'-'.repeat(14)} ${'-'.repeat(8)}`);
  for (const bucket of report.distribution) {
    console.log(` ${bucket.label.padEnd(26)}`
      + ` ${formatCount(bucket.rounds).padStart(9)}`
      + ` ${`${bucket.sharePercent} %`.padStart(9)}`
      + ` ${bucket.paidCentsFormatted.padStart(16)}`
      + ` ${bucket.paidCredits.padStart(14)}`
      + ` ${`${bucket.rtpContributionPercent} %`.padStart(8)}`);
  }
  console.log(` ${'TOTAL'.padEnd(26)}`
    + ` ${formatCount(report.rounds).padStart(9)}`
    + ` ${'100,0000 %'.padStart(9)}`
    + ` ${formatCount(report.totals.wonCents).padStart(16)}`
    + ` ${report.totals.wonCredits.padStart(14)}`
    + ` ${`${report.rtp.exactPercent} %`.padStart(8)}`);
  console.log(sub);

  console.log(' TOPES DE GANANCIA OBSERVADOS');
  console.log(` Tope de exposicion .....: ${formatCount(report.caps.maxExposureX)}x apuesta base`);
  console.log(`   En centimos ..........: ${report.caps.maxExposureCentsFormatted} cts (${report.caps.maxExposureCredits} creditos)`);
  console.log(` Rondas topadas .........: ${formatCount(report.caps.cappedRounds)} (${report.caps.cappedRatePercent} %)`
    + (report.caps.roundsPerCapFormatted
      ? ` -> 1 cada ${report.caps.roundsPerCapFormatted} rondas`
      : ' -> sin topes en la muestra'));
  console.log(` Maximo observado .......: ${report.caps.maxObservedWinCredits} creditos`);
  console.log(`   En centimos ..........: ${report.caps.maxObservedWinCentsFormatted} cts`);
  console.log(`   Equivalencia .........: ${formatDecimal(report.caps.maxObservedWinXBet, 2)}x apuesta base`
    + ` (${formatDecimal(report.caps.maxObservedWinXWager, 2)}x importe apostado)`);
  console.log(` Uso del tope ...........: ${formatDecimal(report.caps.maxWinCapUsagePercent, 4)} % del maximo permitido`);
  console.log(` Holgura bajo el tope ...: ${report.caps.headroomCentsFormatted} cts`
    + ` (${formatDecimal(report.caps.headroomPercent, 4)} %)`);
  console.log(` Tope alcanzado .........: ${report.caps.capReached ? 'SI' : 'NO'}`);
  console.log(sub);

  console.log(' DIAGNOSTICO DEL MOTOR');
  console.log(` Giros internos .........: ${formatCount(report.diagnostics.totalSpins)}`
    + ` (${formatDecimal(report.diagnostics.spinsPerRound, 2)} por ronda)`);
  console.log(` Cascadas medias ........: ${formatDecimal(report.diagnostics.avgCascadesPerSpin, 3)} por tirada`);
  console.log(` Tiradas con bomba ......: ${report.diagnostics.bombSpinRatePercent} %`);
  console.log(` Tiradas con 3+ SC ......: ${report.diagnostics.scatterSpinRatePercent} %`);
  console.log(` Multiplicador medio ....: ${formatDecimal(report.diagnostics.avgMultiplierWhenBaseWin, 3)}x`
    + ' (tiradas con pago base)');
  console.log(` Pago maximo observado ..: ${report.maxWinCredits} creditos`);
  console.log(sub);

  console.log(' CONTROLES DE CONSISTENCIA');
  console.log(` Suma de tramos = rondas : ${report.checks.bucketCountsSum ? 'SI' : 'NO'}`);
  console.log(` Suma de pagos = total ..: ${report.checks.bucketWinsSum ? 'SI' : 'NO'}`);
  console.log(` Apuestas contabilizadas : ${report.checks.wageredMatches ? 'SI' : 'NO'}`);
  console.log(` Maximo dentro del tope .: ${report.checks.maxWinWithinCap ? 'SI' : 'NO'}`);
  console.log(sub);

  const modeArg = report.mode.toLowerCase();
  const seedArg = report.cryptoMode ? '--crypto' : `--seed=${report.seed}`;
  console.log(` Reproducir .............: node scripts/monteCarlo.js --rounds=${report.rounds}`
    + ` --mode=${modeArg} --bet=${report.betCredits} ${seedArg} --jackpot=${report.jackpotX}`);
  console.log('');
}


/* ==========================================================================
 *  6. EVIDENCIA JSON Y PUNTO DE ENTRADA
 * ========================================================================== */

function saveEvidence(args, reports) {
  const filePath = args.jsonPath
    ? path.resolve(process.cwd(), args.jsonPath)
    : path.join(__dirname, '..', '.sim', `montecarlo-${Date.now()}.json`);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    gameCode: GAME_CODE,
    engineVersion: ENGINE_VERSION,
    paytableVersion: PAYTABLE_VERSION,
    certifiedRtp: CERTIFIED_RTP,
    config: {
      roundsPerMode: args.rounds,
      mode: args.mode,
      betCredits: args.bet,
      betCents: args.betCents,
      seed: args.seed,
      jackpotX: args.jackpotX,
      cryptoMode: args.crypto
    },
    reports
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { args, reports: [], file: null };
  }

  const modes = args.mode === 'both' ? ['base', 'feature'] : [args.mode];
  if (!args.quiet) printStartup(args, modes);

  const reports = [];
  for (const mode of modes) {
    let lastPercent = -1;
    const onProgress = (!args.quiet && process.stderr.isTTY)
      ? (fraction) => {
        const percent = Math.min(100, Math.floor(fraction * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          process.stderr.write(`\r  ${mode.toUpperCase().padEnd(7)} ${String(percent).padStart(3, ' ')}%`);
        }
      }
      : null;

    const report = runMonteCarlo({
      rounds: args.rounds,
      mode,
      betCredits: args.bet,
      seed: args.seed,
      jackpotX: args.jackpotX,
      cryptoMode: args.crypto,
      onProgress
    });
    if (onProgress) process.stderr.write(`\r${' '.repeat(48)}\r`);
    printReport(report);
    reports.push(report);
  }

  let file = null;
  if (args.save) {
    file = saveEvidence(args, reports);
    console.log(` Evidencia JSON .........: ${file}`);
    console.log('');
  }

  return { args, reports, file };
}

module.exports = {
  parseArgs,
  classifyPrizeTier,
  classifyVolatility,
  formatCents,
  formatRatioPercent,
  formatDecimal,
  calculateOneInEvery,
  percentile,
  createWelford,
  runMonteCarlo,
  saveEvidence,
  printReport,
  main,
  USAGE,
  PRIZE_TIERS,
  DEFAULT_ROUNDS,
  DEFAULT_JACKPOT_X
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error en la simulacion Monte Carlo: ${error.message}`);
    process.exitCode = 1;
  }
}

