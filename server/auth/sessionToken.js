'use strict';

/**
 * ============================================================================
 *  TOKENS DE SESION FIRMADOS (HMAC-SHA256)
 * ============================================================================
 *  El cliente NUNCA puede fabricar un `playerId`: el token lo emite el backend
 *  (o tu IdP) y va firmado con SESSION_SECRET.
 *
 *  Formato:  t1.<payloadBase64Url>.<firmaBase64Url>
 *  Payload:  { sub, iat, exp, jti }
 *
 *  - Comparacion en tiempo constante (evita timing attacks).
 *  - `exp` obligatorio; sin expiracion el token se rechaza.
 * ============================================================================
 */

const crypto = require('node:crypto');

const config = require('../config');

const TOKEN_VERSION = 't1';
const CLOCK_SKEW_SECONDS = 5;

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalised = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalised.length % 4 === 0 ? '' : '='.repeat(4 - (normalised.length % 4));
  return Buffer.from(normalised + padding, 'base64');
}

function hmac(payloadB64, secret) {
  return toBase64Url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

function tokenError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  err.status = 401;
  return err;
}

/**
 * Emite un token de sesion.
 * @param {object} params
 * @param {string} params.playerId  uuid del jugador (claim `sub`)
 * @param {number} [params.ttlSeconds]
 * @param {string} [params.secret]  solo tests
 * @returns {{ token: string, expiresAt: string, ttlSeconds: number }}
 */
function issueToken({ playerId, ttlSeconds, secret = config.session.secret }) {
  if (typeof playerId !== 'string' || playerId.length < 8) {
    throw new Error('playerId invalido');
  }
  const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : config.session.ttlSeconds;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.max(1, Math.trunc(ttl));

  const payload = { sub: playerId, iat, exp, jti: crypto.randomUUID() };
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = hmac(payloadB64, secret);

  return {
    token: `${TOKEN_VERSION}.${payloadB64}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    ttlSeconds: exp - iat
  };
}

/**
 * Verifica un token y devuelve su payload.
 * Lanza un error con `code` y `status = 401` si no es valido.
 * @param {string} token
 * @param {object} [options]
 * @returns {{ sub: string, iat: number, exp: number, jti: string }}
 */
function verifyToken(token, { secret = config.session.secret, now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length < 16) throw tokenError('TOKEN_MISSING');

  const parts = token.split('.');
  if (parts.length !== 3) throw tokenError('TOKEN_MALFORMED');
  const [version, payloadB64, signature] = parts;
  if (version !== TOKEN_VERSION) throw tokenError('TOKEN_VERSION_UNSUPPORTED');

  const expected = hmac(payloadB64, secret);
  const provided = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
    throw tokenError('TOKEN_BAD_SIGNATURE');
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch {
    throw tokenError('TOKEN_MALFORMED');
  }

  if (!payload || typeof payload.sub !== 'string' || !payload.sub) throw tokenError('TOKEN_MALFORMED');
  if (!Number.isFinite(payload.exp)) throw tokenError('TOKEN_MALFORMED');

  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) throw tokenError('TOKEN_EXPIRED');
  if (Number.isFinite(payload.iat) && payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw tokenError('TOKEN_NOT_YET_VALID');
  }

  return payload;
}

module.exports = { issueToken, verifyToken, TOKEN_VERSION };
