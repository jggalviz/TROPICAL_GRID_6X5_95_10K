'use strict';

/**
 * ============================================================================
 *  EMISION DE TOKEN DE SESION (desarrollo / pruebas manuales)
 * ============================================================================
 *
 *    npm run token
 *    npm run token -- 7f3c... --ttl=7200
 *
 *  Imprime el Bearer token firmado con SESSION_SECRET. Equivale a
 *  POST /api/session cuando ALLOW_DEV_SESSION=true.
 * ============================================================================
 */

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../server/config');
const { issueToken, verifyToken } = require('../server/auth/sessionToken');

function main() {
  const args = process.argv.slice(2);
  const ttlArg = args.find((item) => item.startsWith('--ttl='));
  const positional = args.filter((item) => !item.startsWith('--'));

  const playerId = positional[0] || config.session.devDemoPlayerId;
  const ttlSeconds = ttlArg ? Number(ttlArg.split('=')[1]) : undefined;

  const issued = issueToken({ playerId, ttlSeconds });
  // Verificacion inmediata: si el token recien emitido no valida, algo esta mal.
  const payload = verifyToken(issued.token);

  console.log(`playerId : ${payload.sub}`);
  console.log(`expira   : ${issued.expiresAt} (${issued.ttlSeconds}s)`);
  console.log(`token    : ${issued.token}`);
  console.log('');
  console.log(`curl -H "Authorization: Bearer ${issued.token}" ^`);
  console.log('     -H "Content-Type: application/json" ^');
  console.log('     -d "{\\"bet\\":1,\\"roundRef\\":\\"manual-session-0001\\"}" ^');
  console.log(`http://localhost:${config.port}/api/spin`);
}

try {
  main();
} catch (error) {
  console.error('[token] Error:', error.message || error);
  process.exitCode = 1;
}
