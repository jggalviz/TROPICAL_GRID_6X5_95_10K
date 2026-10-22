'use strict';

/**
 * Modelo de servido del frontend.
 *
 * En Vercel el CDN publica `public/src/**` (y `/index.html`), mientras que `/`
 * lo atiende la funcion Express desde `server/generated/indexHtml.js`. En local
 * `npm start` sirve `public/` completo. Estas pruebas fijan ambos contratos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startServer, createClient } = require('./helpers/server');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('GET / responde el HTML aunque la funcion no sirva public/ (modelo Vercel)', async () => {
  const server = await startServer({ staticDir: null });
  const request = createClient(server.baseUrl);

  try {
    const response = await request('GET', '/');

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.text, INDEX_HTML);

    const asset = await request('GET', '/src/js/main.js');
    assert.equal(asset.status, 404, 'En Vercel los estaticos los sirve el CDN');
    assert.equal(asset.body.error.code, 'NOT_FOUND');
  } finally {
    await server.close();
  }
});

test('en local (staticDir = public/) tambien se sirven los estaticos', async () => {
  const server = await startServer();
  const request = createClient(server.baseUrl);

  try {
    const index = await request('GET', '/index.html');
    assert.equal(index.status, 200);
    assert.equal(index.text, INDEX_HTML);

    const asset = await request('GET', '/src/js/main.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') || '', /javascript/);
  } finally {
    await server.close();
  }
});
