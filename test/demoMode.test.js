'use strict';

/**
 * Modo "Fichas de Prueba" (Jugar Gratis).
 *
 * Verifica que:
 *   - POST /api/demo/session emite un token demo con saldo virtual de 1.000,00 VES.
 *   - POST /api/spin acepta esos tokens (o un invitado sin token) y usa el MISMO
 *     motor, pero NO escribe nada en la base de datos real.
 *   - El saldo virtual es autoritativo del servidor, idempotente y nunca negativo.
 */

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/db');
const { verifyToken } = require('../server/auth/sessionToken');
const { demoWallet } = require('../server/services/demoWallet');
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
  demoWallet.reset();
});

async function openDemoSession(alias = 'invitado_demo') {
  const response = await request('POST', '/api/demo/session', { body: { playerId: alias } });
  assert.equal(response.status, 200, response.text);
  return response.body;
}

/* -------------------------------------------------------------------------- */
/*  Parametros publicos y emision de sesion                                    */
/* -------------------------------------------------------------------------- */

test('GET /api/game publica los parametros del modo demo', async () => {
  const response = await request('GET', '/api/game');

  assert.equal(response.status, 200);
  assert.equal(response.body.game.demo.enabled, true);
  assert.equal(response.body.game.demo.guestId, 'invitado_demo');
  assert.equal(response.body.game.demo.currency, 'VES');
  assert.equal(response.body.game.demo.startBalanceCredits, 1000);
  assert.equal(response.body.game.demo.startBalanceCents, 100000);
});

test('POST /api/demo/session emite un token demo con 1.000,00 VES virtuales', async () => {
  const body = await openDemoSession();

  assert.equal(body.ok, true);
  assert.equal(body.demo, true);
  assert.equal(body.player.alias, 'invitado_demo');
  assert.equal(body.player.displayName, 'Invitado Demo');
  assert.equal(body.balance.cents, 100000);
  assert.equal(body.balance.credits, 1000);
  assert.equal(body.balance.currency, 'VES');
  assert.equal(body.tokenType, 'Bearer');

  const payload = verifyToken(body.token);
  assert.equal(payload.demo, true);
  assert.equal(payload.sub, body.sessionId);
});

test('POST /api/demo/session rechaza alias invalidos', async () => {
  const response = await request('POST', '/api/demo/session', { body: { playerId: 'a b' } });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_PLAYER_ID');
});

/* -------------------------------------------------------------------------- */
/*  Rondas demo: mismo motor, cero escrituras reales                           */
/* -------------------------------------------------------------------------- */

test('POST /api/spin con token demo resuelve la matriz, cascadas y saldo virtual', async () => {
  const demo = await openDemoSession();

  const response = await request('POST', '/api/spin', {
    token: demo.token,
    body: { betCents: 100, clientSeed: 'demo-seed-1', roundRef: 'demo-ref-1' }
  });

  assert.equal(response.status, 200, response.text);
  const round = response.body;
  assert.equal(round.ok, true);
  assert.equal(round.demo, true);
  assert.equal(round.roundId.length > 0, true);
  assert.equal(round.initialGrid.length, 5);
  assert.equal(round.initialGrid.every((row) => row.length === 6), true);
  assert.equal(Array.isArray(round.cascades), true);
  assert.equal(round.balance.currency, 'VES');
  assert.equal(
    round.balance.cents,
    100000 - round.wagerCents + round.totalWinCents
  );
  assert.equal(round.audit.certifiedRtp, 0.9508);

  /* La base de datos real no recibio ninguna escritura. */
  const snapshot = store.__snapshot();
  assert.equal(snapshot.rounds.length, 0);
  assert.equal(snapshot.ledger.length, 0);
  assert.equal(snapshot.players.length, 0);
});

test('el saldo virtual persiste entre tiradas de la misma sesion demo', async () => {
  const demo = await openDemoSession();

  const first = await request('POST', '/api/spin', {
    token: demo.token,
    body: { betCents: 100, clientSeed: 'demo-seed-a' }
  });
  const second = await request('POST', '/api/spin', {
    token: demo.token,
    body: { betCents: 100, clientSeed: 'demo-seed-b' }
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.balance.cents, first.body.balance.cents - 100 + second.body.totalWinCents);
});

test('GET /api/player con token demo devuelve el saldo virtual', async () => {
  const demo = await openDemoSession();

  await request('POST', '/api/spin', {
    token: demo.token,
    body: { betCents: 100, clientSeed: 'demo-seed-player' }
  });

  const response = await request('GET', '/api/player', { token: demo.token });

  assert.equal(response.status, 200);
  assert.equal(response.body.demo, true);
  assert.equal(response.body.player.currency, 'VES');
  assert.equal(response.body.balance.currency, 'VES');
  assert.equal(response.body.stats.spinCount, 1);
});

test('un invitado sin token puede jugar declarando playerId invitado_demo', async () => {
  const response = await request('POST', '/api/spin', {
    body: { betCents: 100, playerId: 'invitado_demo', demo: true, clientSeed: 'anon-demo' }
  });

  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.demo, true);
  assert.equal(store.__snapshot().rounds.length, 0);
});

test('sin token y sin intencion demo sigue respondiendo 401', async () => {
  const response = await request('POST', '/api/spin', {
    body: { betCents: 100, clientSeed: 'no-demo' }
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'TOKEN_MISSING');
});

/* -------------------------------------------------------------------------- */
/*  Reglas de seguridad del saldo virtual                                      */
/* -------------------------------------------------------------------------- */

test('misma roundRef no vuelve a cobrar en modo demo', async () => {
  const demo = await openDemoSession();
  const payload = { betCents: 100, clientSeed: 'idem-seed', roundRef: 'idem-ref-1' };

  const first = await request('POST', '/api/spin', { token: demo.token, body: payload });
  const second = await request('POST', '/api/spin', { token: demo.token, body: payload });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.roundId, first.body.roundId);
  assert.equal(second.body.balance.cents, first.body.balance.cents);
});

test('el saldo virtual no puede quedar negativo (compra de bonus)', async () => {
  const demo = await openDemoSession();

  /* Bet 20,00 creditos x100 (coste del bonus) = 2.000,00 > 1.000,00 disponibles. */
  const response = await request('POST', '/api/spin', {
    token: demo.token,
    body: { betCents: 2000, buyFeature: true, clientSeed: 'broke-demo' }
  });

  assert.equal(response.status, 402);
  assert.equal(response.body.error.code, 'INSUFFICIENT_FUNDS');

  const status = await request('GET', '/api/player', { token: demo.token });
  assert.equal(status.body.balance.cents, 100000);
});

test('un jugador real no puede mezclar su sesion con fichas de prueba', async () => {
  const { token } = createPlayerToken({ balanceCents: 100000 });

  const response = await request('POST', '/api/spin', {
    token,
    body: { betCents: 100, demo: true, clientSeed: 'conflict-demo' }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'DEMO_MODE_CONFLICT');
});

test('las carteras demo caducan y no crecen sin limite', () => {
  const { DemoWallet } = require('../server/services/demoWallet');
  let now = 1000;
  const wallet = new DemoWallet({
    currency: 'VES',
    startBalanceCents: 100000,
    sessionTtlMs: 50,
    maxSessions: 2,
    maxIdempotentRounds: 2,
    now: () => now
  });

  wallet.open('demo:a'); // expira en 1050
  now += 30;
  wallet.open('demo:b'); // expira en 1080
  now += 40; // now=1070: 'demo:a' caduco, 'demo:b' sigue viva
  assert.equal(wallet.peek('demo:a'), null);
  assert.notEqual(wallet.peek('demo:b'), null);

  /* Tope de sesiones: al abrir una tercera se descarta la que antes expira. */
  wallet.open('demo:c');
  const open = [...wallet.sessions.keys()];
  assert.equal(open.length <= 2, true);

  /* Tope de idempotencia: solo se conservan las ultimas rondas. */
  const local = new DemoWallet({
    startBalanceCents: 100000,
    maxIdempotentRounds: 2,
    now: () => now
  });
  for (let i = 0; i < 4; i += 1) {
    local.commit({
      key: 'demo:x',
      roundRef: `ref-${i}`,
      wagerCents: 100,
      winCents: 0,
      result: { i }
    });
  }
  assert.equal(local.findReplay('demo:x', 'ref-0'), null);
  assert.notEqual(local.findReplay('demo:x', 'ref-3'), null);
});
