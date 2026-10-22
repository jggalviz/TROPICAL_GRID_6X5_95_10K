'use strict';

require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { issueToken, verifyToken, TOKEN_VERSION } = require('../server/auth/sessionToken');

const SECRET = process.env.SESSION_SECRET;
const PLAYER_ID = '11111111-1111-4111-8111-111111111111';

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(payloadB64, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

test('emite y verifica un token valido', () => {
  const { token, expiresAt, ttlSeconds } = issueToken({ playerId: PLAYER_ID, ttlSeconds: 120 });
  const payload = verifyToken(token);

  assert.equal(payload.sub, PLAYER_ID);
  assert.equal(payload.exp - payload.iat, 120);
  assert.equal(ttlSeconds, 120);
  assert.equal(typeof payload.jti, 'string');
  assert.equal(new Date(expiresAt).getTime(), payload.exp * 1000);
  assert.ok(token.startsWith(`${TOKEN_VERSION}.`));
});

test('rechaza una firma manipulada', () => {
  const { token } = issueToken({ playerId: PLAYER_ID });
  const [version, payloadB64, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  payload.sub = '99999999-9999-4999-8999-999999999999';
  const forgedB64 = b64url(JSON.stringify(payload));

  assert.throws(
    () => verifyToken(`${version}.${forgedB64}.${signature}`),
    (error) => error.code === 'TOKEN_BAD_SIGNATURE'
  );
});

test('rechaza un token firmado con otro secreto', () => {
  const payloadB64 = b64url(JSON.stringify({ sub: PLAYER_ID, iat: 1, exp: 9999999999, jti: 'x' }));
  const forged = `${TOKEN_VERSION}.${payloadB64}.${sign(payloadB64, 'a'.repeat(64))}`;

  assert.throws(() => verifyToken(forged), (error) => error.code === 'TOKEN_BAD_SIGNATURE');
});

test('rechaza tokens expirados', () => {
  const { token } = issueToken({ playerId: PLAYER_ID, ttlSeconds: 60 });
  const now = Date.now() + 70 * 1000;

  assert.throws(() => verifyToken(token, { now }), (error) => error.code === 'TOKEN_EXPIRED');
});

test('rechaza tokens de una version desconocida', () => {
  const payloadB64 = b64url(JSON.stringify({ sub: PLAYER_ID, iat: 1, exp: 9999999999 }));
  const token = `t9.${payloadB64}.${sign(payloadB64)}`;

  assert.throws(() => verifyToken(token), (error) => error.code === 'TOKEN_VERSION_UNSUPPORTED');
});

test('rechaza payloads sin exp o sin sub', () => {
  const noExp = b64url(JSON.stringify({ sub: PLAYER_ID, iat: 1 }));
  assert.throws(
    () => verifyToken(`${TOKEN_VERSION}.${noExp}.${sign(noExp)}`),
    (error) => error.code === 'TOKEN_MALFORMED'
  );

  const noSub = b64url(JSON.stringify({ iat: 1, exp: 9999999999 }));
  assert.throws(
    () => verifyToken(`${TOKEN_VERSION}.${noSub}.${sign(noSub)}`),
    (error) => error.code === 'TOKEN_MALFORMED'
  );
});

test('rechaza tokens malformados o vacios', () => {
  assert.throws(() => verifyToken(''), (error) => error.code === 'TOKEN_MISSING');
  assert.throws(() => verifyToken(undefined), (error) => error.code === 'TOKEN_MISSING');
  assert.throws(
    () => verifyToken('aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb'),
    (error) => error.code === 'TOKEN_MALFORMED'
  );
});

test('tokens distintos para el mismo jugador (jti unico)', () => {
  const a = issueToken({ playerId: PLAYER_ID });
  const b = issueToken({ playerId: PLAYER_ID });
  assert.notEqual(a.token, b.token);
  assert.notEqual(verifyToken(a.token).jti, verifyToken(b.token).jti);
});
