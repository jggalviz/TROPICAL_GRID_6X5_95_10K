'use strict';

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { SlidingWindowRateLimiter } = require('../server/middleware/rateLimit');
const store = require('../server/db');
const { startServer, createClient, createPlayerToken } = require('./helpers/server');

test('permite hasta el maximo y luego bloquea con retryAfter', () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 3 });
  const t0 = 1_000_000;

  assert.equal(limiter.consume('p1', t0).allowed, true);
  assert.equal(limiter.consume('p1', t0 + 10).allowed, true);
  assert.equal(limiter.consume('p1', t0 + 20).allowed, true);

  const blocked = limiter.consume('p1', t0 + 30);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterMs, 970); // la marca mas antigua + ventana - ahora

  // Pasada la ventana vuelve a permitir.
  assert.equal(limiter.consume('p1', t0 + 1001).allowed, true);
});

test('las ventanas son independientes por clave', () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 1 });
  const t0 = 2_000_000;

  assert.equal(limiter.consume('a', t0).allowed, true);
  assert.equal(limiter.consume('a', t0).allowed, false);
  assert.equal(limiter.consume('b', t0).allowed, true);
});

test('la ventana es deslizante, no fija', () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 2 });
  const t0 = 3_000_000;

  assert.equal(limiter.consume('k', t0).allowed, true); // t0
  assert.equal(limiter.consume('k', t0 + 600).allowed, true); // t0+600
  assert.equal(limiter.consume('k', t0 + 900).allowed, false);
  // En t0+1001 la primera marca ya expiro -> queda sitio.
  assert.equal(limiter.consume('k', t0 + 1001).allowed, true);
  assert.equal(limiter.consume('k', t0 + 1002).allowed, false);
});

test('POST /api/spin devuelve 429 al superar el limite por jugador', async () => {
  store.__reset();
  const server = await startServer({ rateLimitMaxRequests: 2 });
  const request = createClient(server.baseUrl);
  const { token } = createPlayerToken({ balanceCents: 100000 });

  try {
    const first = await request('POST', '/api/spin', { token, body: { bet: 0.1 } });
    const second = await request('POST', '/api/spin', { token, body: { bet: 0.1 } });
    const third = await request('POST', '/api/spin', { token, body: { bet: 0.1 } });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.equal(third.headers.get('x-ratelimit-remaining'), '0');

    // El limite es por jugador: otro jugador no se ve afectado.
    const other = createPlayerToken({ balanceCents: 100000 });
    const otherSpin = await request('POST', '/api/spin', { token: other.token, body: { bet: 0.1 } });
    assert.equal(otherSpin.status, 200);
  } finally {
    await server.close();
  }
});
