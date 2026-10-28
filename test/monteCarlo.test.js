'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  classifyPrizeTier,
  classifyVolatility,
  formatCents,
  formatRatioPercent,
  formatDecimal,
  createWelford,
  percentile,
  runMonteCarlo
} = require('../scripts/monteCarlo');
const { createFastRng } = require('../scripts/lib/fastRng');

test('monteCarlo: formatea dinero y porcentajes sin perder precision', () => {
  assert.equal(formatCents(0n), '0,00');
  assert.equal(formatCents(100n), '1,00');
  assert.equal(formatCents(9179115n), '91.791,15');
  assert.equal(formatCents(-123n), '-1,23');

  assert.equal(formatRatioPercent(1n, 3n, 4), '33,3333');
  assert.equal(formatRatioPercent(2n, 3n, 4), '66,6667');
  assert.equal(formatRatioPercent(9179115n, 10000000n, 4), '91,7912');
  assert.equal(formatRatioPercent(0n, 0n, 4), '0,0000');
  assert.equal(formatRatioPercent(-1n, 4n, 2), '-25,00');

  assert.equal(formatDecimal(94.92, 4), '94,9200');
  assert.equal(formatDecimal(-1.5, 2), '-1,50');
});

test('monteCarlo: los limites de los tramos son exactos', () => {
  const bet = 100;
  const jackpot = 1000;

  assert.equal(classifyPrizeTier(0, bet, jackpot), 'none');
  assert.equal(classifyPrizeTier(1, bet, jackpot), 'micro');
  assert.equal(classifyPrizeTier(99, bet, jackpot), 'micro');
  assert.equal(classifyPrizeTier(100, bet, jackpot), 'small');
  assert.equal(classifyPrizeTier(499, bet, jackpot), 'small');
  assert.equal(classifyPrizeTier(500, bet, jackpot), 'medium');
  assert.equal(classifyPrizeTier(2499, bet, jackpot), 'medium');
  assert.equal(classifyPrizeTier(2500, bet, jackpot), 'large');
  assert.equal(classifyPrizeTier(9999, bet, jackpot), 'large');
  assert.equal(classifyPrizeTier(10000, bet, jackpot), 'very-large');
  assert.equal(classifyPrizeTier(99999, bet, jackpot), 'very-large');
  assert.equal(classifyPrizeTier(100000, bet, jackpot), 'jackpot');
  assert.equal(classifyPrizeTier(1000000, bet, jackpot), 'jackpot');

  assert.throws(() => classifyPrizeTier(-1, bet, jackpot), /winCents/);
  assert.throws(() => classifyPrizeTier(1, 0, jackpot), /betCents/);
  assert.throws(() => classifyPrizeTier(1, bet, 0), /jackpotX/);
});

test('monteCarlo: parser valida opciones y conserva defaults', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.rounds, 100000);
  assert.equal(defaults.mode, 'base');
  assert.equal(defaults.bet, 1);
  assert.equal(defaults.betCents, 100);
  assert.equal(defaults.seed, 20261026);
  assert.equal(defaults.jackpotX, 1000);
  assert.equal(defaults.crypto, false);
  assert.equal(defaults.save, true);

  const parsed = parseArgs([
    '--rounds=1000',
    '--mode=feature',
    '--bet=0.5',
    '--seed',
    '7',
    '--jackpot=250',
    '--no-save',
    '--quiet'
  ]);
  assert.equal(parsed.rounds, 1000);
  assert.equal(parsed.mode, 'feature');
  assert.equal(parsed.bet, 0.5);
  assert.equal(parsed.betCents, 50);
  assert.equal(parsed.seed, 7);
  assert.equal(parsed.jackpotX, 250);
  assert.equal(parsed.save, false);
  assert.equal(parsed.quiet, true);

  assert.throws(() => parseArgs(['--mode=nope']), /--mode/);
  assert.throws(() => parseArgs(['--bet=0.33']), /--bet/);
  assert.throws(() => parseArgs(['--rounds=0']), /--rounds/);
  assert.throws(() => parseArgs(['--jackpot=50']), /--jackpot/);
  assert.throws(() => parseArgs(['--desconocido=1']), /desconocida/);
});

test('monteCarlo: Welford y percentiles son coherentes', () => {
  const stats = createWelford();
  [1, 2, 3].forEach((value) => stats.add(value));
  assert.equal(stats.count, 3);
  assert.equal(stats.mean, 2);
  assert.equal(stats.variance(), 1);
  assert.equal(stats.stdDev(), 1);

  const values = Float64Array.from([0, 10, 20, 30]);
  assert.equal(percentile(values, 0.5), 10);
  assert.equal(percentile(values, 0.75), 20);
  assert.equal(percentile(values, 0.99), 30);
  assert.equal(percentile(new Float64Array(0), 0.5), 0);
});

test('monteCarlo: PRNG sfc32 es determinista y sin sesgo evidente', () => {
  const first = createFastRng(12345);
  const second = createFastRng(12345);
  for (let i = 0; i < 100; i += 1) {
    const a = first.int(1000);
    const b = second.int(1000);
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 1000);
  }
  assert.equal(first.draws(), 132);
  assert.ok(first.float() >= 0 && first.float() < 1);
});

test('monteCarlo: una corrida base cuadra con el motor y es reproducible', () => {
  const report = runMonteCarlo({
    rounds: 2000,
    mode: 'base',
    betCredits: 1,
    seed: 12345,
    jackpotX: 1000
  });

  assert.equal(report.rounds, 2000);
  assert.equal(report.betCents, 100);
  assert.equal(report.creditCost, 1);
  assert.equal(report.totals.wageredCents, '200000');
  assert.equal(report.checks.bucketCountsSum, true);
  assert.equal(report.checks.bucketWinsSum, true);
  assert.equal(report.checks.wageredMatches, true);
  assert.equal(report.checks.maxWinWithinCap, true);

  const bucketRounds = report.distribution.reduce((sum, bucket) => sum + bucket.rounds, 0);
  const bucketWins = report.distribution.reduce(
    (sum, bucket) => sum + BigInt(bucket.paidCents),
    0n
  );
  assert.equal(bucketRounds, report.rounds);
  assert.equal(bucketWins, BigInt(report.totals.wonCents));
  assert.equal(report.hitRate, (report.rounds - report.distribution[0].rounds) / report.rounds);
  assert.ok(
    Math.abs(
      report.rtp.value - Number(report.totals.wonCents) / Number(report.totals.wageredCents)
    ) < 1e-12
  );
  assert.ok(report.maxWinXBet <= 10000);

  const repeated = runMonteCarlo({
    rounds: 2000,
    mode: 'base',
    betCredits: 1,
    seed: 12345,
    jackpotX: 1000
  });
  assert.equal(report.totals.wonCents, repeated.totals.wonCents);
  assert.equal(report.rtp.exactPercent, repeated.rtp.exactPercent);
  assert.deepEqual(
    report.distribution.map((bucket) => bucket.rounds),
    repeated.distribution.map((bucket) => bucket.rounds)
  );
});

test('monteCarlo: el modo feature contabiliza 100x de apuesta y 10 tiradas', () => {
  const report = runMonteCarlo({
    rounds: 50,
    mode: 'feature',
    betCredits: 1,
    seed: 7,
    jackpotX: 1000
  });

  assert.equal(report.creditCost, 100);
  assert.equal(report.wagerCents, 10000);
  assert.equal(report.totals.wageredCents, (50 * 10000).toString());
  assert.equal(report.checks.bucketCountsSum, true);
  assert.equal(report.checks.wageredMatches, true);
  assert.ok(report.diagnostics.totalSpins > 0);
  assert.ok(report.diagnostics.spinsPerRound <= 10);
  assert.ok(report.hitRate >= 0 && report.hitRate <= 1);
});

test('monteCarlo: la clasificacion de volatilidad usa umbrales documentados', () => {
  assert.equal(classifyVolatility(0), 'BAJA');
  assert.equal(classifyVolatility(0.99), 'BAJA');
  assert.equal(classifyVolatility(1), 'MEDIA');
  assert.equal(classifyVolatility(2.99), 'MEDIA');
  assert.equal(classifyVolatility(3), 'ALTA');
  assert.equal(classifyVolatility(7.99), 'ALTA');
  assert.equal(classifyVolatility(8), 'MUY ALTA');
  assert.equal(classifyVolatility(Number.NaN), 'N/D');
});

