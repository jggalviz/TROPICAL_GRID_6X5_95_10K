'use strict';

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/db');
const { startServer, createClient, createPlayerToken } = require('./helpers/server');

let server;
let request;

test.before(async () => {
  server = await startServer();
  request = createClient(server.baseUrl);
});

test.after(async () => {
  await server.close();
});

test.beforeEach(() => {
  store.__reset();
});

/* -------------------------------------------------------------------------- */
/*  Salud y metadatos                                                          */
/* -------------------------------------------------------------------------- */

test('GET /api/health responde UP sin exponer secretos', async () => {
  const response = await request('GET', '/api/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'UP');
  assert.equal(response.body.dbDriver, 'memory');
  assert.equal(response.body.engineVersion, '1.0.0');
  assert.equal(response.text.includes(process.env.SESSION_SECRET), false);
});

test('GET /api/game publica la paytable y el RTP certificado', async () => {
  const response = await request('GET', '/api/game');

  assert.equal(response.status, 200);
  const { game } = response.body;
  assert.equal(game.code, 'TROPICAL_GRID_6X5_95_10K');
  assert.equal(game.grid.cols, 6);
  assert.equal(game.grid.rows, 5);
  assert.equal(game.minClusterSize, 8);
  assert.equal(game.maxExposureMultiplier, 10000);
  assert.deepEqual(game.betLadder, [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]);
  assert.equal(game.certifiedRtp.base, 0.9492);
  assert.equal(game.certifiedRtp.feature, 0.9497);
  assert.equal(Object.keys(game.clusterPays).length, 9);
  assert.equal(response.text.includes('serverSeed'), false);
});

/* -------------------------------------------------------------------------- */
/*  Sesion y autenticacion                                                     */
/* -------------------------------------------------------------------------- */

test('POST /api/session emite un token utilizable', async () => {
  const session = await request('POST', '/api/session', { body: {} });

  assert.equal(session.status, 200);
  assert.ok(session.body.token);
  assert.equal(session.body.tokenType, 'Bearer');
  assert.equal(session.body.player.id, '00000000-0000-4000-8000-000000000001');

  const player = await request('GET', '/api/player', { token: session.body.token });
  assert.equal(player.status, 200);
  assert.equal(player.body.balance.cents, 100000);
});

test('POST /api/session rechaza playerId no uuid', async () => {
  const response = await request('POST', '/api/session', { body: { playerId: 'demo' } });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_PLAYER_ID');
});

test('GET /api/player sin token responde 401', async () => {
  const response = await request('GET', '/api/player');
  assert.equal(response.status, 401);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'TOKEN_MISSING');
});

test('GET /api/player con token invalido responde 401', async () => {
  const response = await request('GET', '/api/player', {
    token: `t1.${'a'.repeat(24)}.${'b'.repeat(43)}`
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'TOKEN_BAD_SIGNATURE');
});

test('GET /api/player con token de jugador inexistente responde 404', async () => {
  const { token } = createPlayerToken();
  store.__reset();
  const response = await request('GET', '/api/player', { token });
  assert.equal(response.status, 404);
});

/* -------------------------------------------------------------------------- */
/*  Spin                                                                       */
/* -------------------------------------------------------------------------- */

test('POST /api/spin resuelve una ronda y actualiza el saldo', async () => {
  const { token } = createPlayerToken({ balanceCents: 100000 });

  const response = await request('POST', '/api/spin', {
    token,
    body: { bet: 1, roundRef: 'test-round-0001' }
  });

  assert.equal(response.status, 200);
  const body = response.body;
  assert.equal(body.ok, true);
  assert.equal(body.replayed, false);
  assert.equal(body.mode, 'BASE');
  assert.equal(body.betCents, 100);
  assert.equal(body.wagerCents, 100);
  assert.equal(body.balance.cents, 100000 - 100 + body.totalWinCents);

  assert.equal(body.spins.length, 1);
  const spin = body.spins[0];
  assert.equal(spin.initialGrid.length, 5);
  assert.equal(spin.initialGrid[0].length, 6);
  assert.equal(spin.finalGrid.length, 5);
  assert.ok(Array.isArray(spin.cascades));
  assert.ok(spin.cascades.length <= 40);
  assert.equal(typeof spin.winCents, 'number');
  assert.ok(spin.winCents >= 0);
  assert.ok(body.totalWinCents <= body.maxWinCents);

  /* Auditoria: semilla de servidor de 64 hex; el secreto HMAC nunca viaja. */
  assert.match(body.audit.serverSeed, /^[0-9a-f]{64}$/);
  assert.match(body.audit.serverSeedHash, /^[0-9a-f]{64}$/);
  assert.equal(body.audit.certifiedRtp, 0.9492);
  assert.ok(body.audit.rngDraws > 0);
});

test('POST /api/spin es idempotente con la misma roundRef', async () => {
  const { token } = createPlayerToken({ balanceCents: 100000 });
  const body = { bet: 1, roundRef: 'idem-round-0001' };

  const first = await request('POST', '/api/spin', { token, body });
  const second = await request('POST', '/api/spin', { token, body });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.roundId, first.body.roundId);
  assert.equal(second.body.balance.cents, first.body.balance.cents);
  assert.equal(second.body.totalWinCents, first.body.totalWinCents);
});

test('POST /api/spin acepta Idempotency-Key en cabecera', async () => {
  const { token } = createPlayerToken({ balanceCents: 100000 });
  const headers = { 'Idempotency-Key': 'header-key-0001' };

  const first = await request('POST', '/api/spin', { token, headers, body: { bet: 1 } });
  const second = await request('POST', '/api/spin', { token, headers, body: { bet: 1 } });

  assert.equal(second.body.replayed, true);
  assert.equal(second.body.roundId, first.body.roundId);
});


test('POST /api/spin compra de bonus: cobra 100x y entrega hasta 10 tiradas', async () => {
  const { token } = createPlayerToken({ balanceCents: 200000 });

  const response = await request('POST', '/api/spin', {
    token,
    body: { bet: 1, buyFeature: true, roundRef: 'feature-round-01' }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'BUY_FEATURE');
  assert.equal(response.body.wagerCents, 10000);
  assert.equal(response.body.feature.costMultiplier, 100);
  assert.ok(response.body.spins.length >= 1 && response.body.spins.length <= 10);
  assert.equal(response.body.balance.cents, 200000 - 10000 + response.body.totalWinCents);
  assert.equal(response.body.initialGrid, null);
});

test('POST /api/spin rechaza apuestas fuera de la escalera', async () => {
  const { token } = createPlayerToken();

  for (const bet of [0.15, 3, 0, -1, 1000]) {
    const response = await request('POST', '/api/spin', { token, body: { bet } });
    assert.equal(response.status, 400, `bet=${bet}`);
    assert.equal(response.body.error.code, 'INVALID_BET');
  }
});

test('POST /api/spin exige una sola forma de apuesta', async () => {
  const { token } = createPlayerToken();

  const both = await request('POST', '/api/spin', { token, body: { bet: 1, betCents: 100 } });
  assert.equal(both.status, 400);
  assert.equal(both.body.error.code, 'INVALID_BET');

  const none = await request('POST', '/api/spin', { token, body: {} });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'INVALID_BET');
});

test('POST /api/spin valida roundRef y clientSeed', async () => {
  const { token } = createPlayerToken();

  const badRef = await request('POST', '/api/spin', { token, body: { bet: 1, roundRef: 'x' } });
  assert.equal(badRef.status, 400);
  assert.equal(badRef.body.error.code, 'INVALID_ROUND_REF');

  const badSeed = await request('POST', '/api/spin', {
    token,
    body: { bet: 1, clientSeed: 'ñññ' }
  });
  assert.equal(badSeed.status, 400);
  assert.equal(badSeed.body.error.code, 'INVALID_CLIENT_SEED');
});

test('POST /api/spin sin saldo responde 402 y no toca el saldo', async () => {
  const { token } = createPlayerToken({ balanceCents: 50 });

  const response = await request('POST', '/api/spin', { token, body: { bet: 1 } });
  assert.equal(response.status, 402);
  assert.equal(response.body.error.code, 'INSUFFICIENT_FUNDS');

  const player = await request('GET', '/api/player', { token });
  assert.equal(player.body.balance.cents, 50);
});

test('POST /api/spin sin token responde 401', async () => {
  const response = await request('POST', '/api/spin', { body: { bet: 1 } });
  assert.equal(response.status, 401);
});

test('POST /api/spin con JSON invalido responde 400 INVALID_JSON', async () => {
  const { token } = createPlayerToken();
  const response = await request('POST', '/api/spin', { token, body: '{"bet":' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});

test('el cliente no puede fijar la semilla del servidor', async () => {
  const { token } = createPlayerToken({ balanceCents: 100000 });

  const a = await request('POST', '/api/spin', { token, body: { bet: 1, clientSeed: 'aaaaaaaa' } });
  const b = await request('POST', '/api/spin', { token, body: { bet: 1, clientSeed: 'aaaaaaaa' } });

  assert.notEqual(a.body.audit.serverSeed, b.body.audit.serverSeed);
  assert.notEqual(a.body.audit.rngHash, b.body.audit.rngHash);
});

/* -------------------------------------------------------------------------- */
/*  404                                                                        */
/* -------------------------------------------------------------------------- */

test('una ruta desconocida devuelve 404 JSON', async () => {
  const response = await request('GET', '/api/nope');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

