'use strict';

/** Utilidades compartidas por los tests de API: servidor efimero + cliente HTTP. */

const { once } = require('node:events');

const { createApp } = require('../../server/app');
const { SlidingWindowRateLimiter } = require('../../server/middleware/rateLimit');
const { issueToken } = require('../../server/auth/sessionToken');
const store = require('../../server/db');

/**
 * Levanta la app en un puerto libre.
 * @param {object} [options]
 * @param {number} [options.rateLimitMaxRequests]  limite por jugador
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void>, limiter: object }>}
 */
async function startServer(options = {}) {
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxRequests: options.rateLimitMaxRequests || 1000
  });
  const app = createApp({ rateLimit: limiter, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    limiter,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      })
  };
}

/** Cliente HTTP minimalista con token opcional. */
function createClient(baseUrl) {
  return async function request(method, path, { token, body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, body: json, text };
  };
}

/** Crea un jugador de prueba y devuelve su token. */
function createPlayerToken({ balanceCents = 100000, id } = {}) {
  const player = store.createPlayer({
    id,
    externalId: `test-${Math.random().toString(36).slice(2, 10)}`,
    displayName: 'Test Player',
    balanceCents
  });
  const { token } = issueToken({ playerId: player.id });
  return { player, token };
}

module.exports = { startServer, createClient, createPlayerToken };
