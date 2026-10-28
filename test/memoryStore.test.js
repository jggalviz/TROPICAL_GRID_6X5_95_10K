'use strict';

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/db');

function roundParams(playerId, overrides = {}) {
  return {
    playerId,
    roundRef: null,
    mode: 'BASE',
    betCents: 100,
    wagerCents: 100,
    winCents: 0,
    multiplier: null,
    engineVersion: '1.1.0',
    paytableVersion: 'TG65-95-10K-v2',
    certifiedRtp: 0.9508,
    serverSeed: 'seed',
    serverSeedHash: 'hash',
    clientSeed: 'client',
    rngHash: 'rng',
    result: { totalWinCents: 0 },
    ...overrides
  };
}

test.beforeEach(() => {
  store.__reset();
});

test('crea y lee un jugador', async () => {
  const player = store.createPlayer({ id: 'p-1', externalId: 'ext-1', balanceCents: 5000 });
  const fresh = await store.getPlayer('p-1');

  assert.equal(fresh.id, 'p-1');
  assert.equal(fresh.balanceCents, 5000);
  assert.equal(fresh.status, 'ACTIVE');
  assert.equal(fresh.spinCount, 0);
  assert.equal(player.currency, 'EUR');
});

test('un jugador inexistente produce PLAYER_NOT_FOUND', async () => {
  await assert.rejects(store.getPlayer('nope'), (error) => error.code === 'PLAYER_NOT_FOUND' && error.status === 404);
});

test('debita la apuesta y acredita el premio de forma atomica', async () => {
  store.createPlayer({ id: 'p-2', externalId: 'ext-2', balanceCents: 1000 });

  const outcome = await store.playRoundAtomic(roundParams('p-2', { winCents: 250 }));

  assert.equal(outcome.replayed, false);
  assert.equal(outcome.balanceCents, 1150); // 1000 - 100 + 250

  const player = await store.getPlayer('p-2');
  assert.equal(player.balanceCents, 1150);
  assert.equal(player.spinCount, 1);
  assert.equal(player.totalWageredCents, 100);
  assert.equal(player.totalWonCents, 250);

  const snapshot = store.__snapshot();
  assert.equal(snapshot.ledger.length, 2);
  assert.equal(snapshot.ledger[0].amountCents, -100);
  assert.equal(snapshot.ledger[0].balanceAfterCents, 900);
  assert.equal(snapshot.ledger[1].amountCents, 250);
  assert.equal(snapshot.ledger[1].balanceAfterCents, 1150);
});

test('rechaza una ronda sin saldo suficiente y no altera el saldo', async () => {
  store.createPlayer({ id: 'p-3', externalId: 'ext-3', balanceCents: 50 });

  await assert.rejects(
    store.playRoundAtomic(roundParams('p-3', { betCents: 100, wagerCents: 100 })),
    (error) => error.code === 'INSUFFICIENT_FUNDS' && error.status === 402
  );

  const player = await store.getPlayer('p-3');
  assert.equal(player.balanceCents, 50);
  assert.equal(player.spinCount, 0);
});

test('la compra de bonus se cobra a 100x y queda en el libro mayor', async () => {
  store.createPlayer({ id: 'p-4', externalId: 'ext-4', balanceCents: 50000 });

  const outcome = await store.playRoundAtomic(
    roundParams('p-4', { mode: 'BUY_FEATURE', betCents: 100, wagerCents: 10000, winCents: 0 })
  );

  assert.equal(outcome.balanceCents, 40000);
  const bet = store.__snapshot().ledger[0];
  assert.equal(bet.type, 'BONUS_BUY');
  assert.equal(bet.amountCents, -10000);
});

test('idempotencia: la misma roundRef no debita dos veces', async () => {
  store.createPlayer({ id: 'p-5', externalId: 'ext-5', balanceCents: 1000 });

  const first = await store.playRoundAtomic(roundParams('p-5', { roundRef: 'ref-00000001', winCents: 0 }));
  const second = await store.playRoundAtomic(roundParams('p-5', { roundRef: 'ref-00000001', winCents: 500 }));

  assert.equal(second.replayed, true);
  assert.equal(second.roundId, first.roundId);
  assert.equal(second.balanceCents, 900); // solo el primer debito
  assert.ok(second.storedResult);

  const player = await store.getPlayer('p-5');
  assert.equal(player.balanceCents, 900);
  assert.equal(player.spinCount, 1);
});

test('sin roundRef cada peticion crea una ronda nueva', async () => {
  store.createPlayer({ id: 'p-6', externalId: 'ext-6', balanceCents: 1000 });

  const a = await store.playRoundAtomic(roundParams('p-6'));
  const b = await store.playRoundAtomic(roundParams('p-6'));

  assert.notEqual(a.roundId, b.roundId);
  assert.equal(b.balanceCents, 800);
  assert.equal((await store.getPlayer('p-6')).spinCount, 2);
});

test('un jugador bloqueado no puede jugar', async () => {
  store.createPlayer({ id: 'p-7', externalId: 'ext-7', balanceCents: 1000 });
  store.__setStatus('p-7', 'BLOCKED');

  await assert.rejects(
    store.playRoundAtomic(roundParams('p-7')),
    (error) => error.code === 'PLAYER_BLOCKED' && error.status === 403
  );
  assert.equal((await store.getPlayer('p-7')).balanceCents, 1000);
});

test('adjustBalance acredita y rechaza saldos negativos', async () => {
  store.createPlayer({ id: 'p-8', externalId: 'ext-8', balanceCents: 100 });

  assert.equal(await store.adjustBalance('p-8', 400, 'bono'), 500);
  await assert.rejects(
    store.adjustBalance('p-8', -900, 'ajuste'),
    (error) => error.code === 'INSUFFICIENT_FUNDS' && error.status === 402
  );
  assert.equal((await store.getPlayer('p-8')).balanceCents, 500);
});

test('rechaza importes no enteros', async () => {
  store.createPlayer({ id: 'p-9', externalId: 'ext-9', balanceCents: 1000 });

  await assert.rejects(
    store.playRoundAtomic(roundParams('p-9', { wagerCents: 10.5 })),
    (error) => error.code === 'INVALID_STAKE'
  );
});
