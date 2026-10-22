'use strict';

/**
 * Autenticacion por token firmado.
 *
 *   Authorization: Bearer t1.<payload>.<firma>
 *
 * El token solo transporta el `playerId`; el saldo SIEMPRE se lee de la base de
 * datos en cada peticion (nunca se confia en el cliente).
 *
 * Dos modos de llamada:
 *   - `requireAuth()`   -> exige token de JUGADOR REAL. Rechaza tokens demo.
 *   - `resolveCaller()` -> resuelve quien llama y deja `req.player` (real) o
 *                          `req.demoKey` (Fichas de Prueba) para la ruta.
 */

const { ApiError } = require('../errors');
const { verifyToken } = require('../auth/sessionToken');
const store = require('../db');
const { demoKeyFromSub, demoKeyFromRequest } = require('../services/demoWallet');

function extractBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function verifyOrThrow(token) {
  try {
    return verifyToken(token);
  } catch (error) {
    throw ApiError.unauthorized(error.code || 'TOKEN_INVALID', 'Sesion no valida o expirada.');
  }
}

async function loadActivePlayer(playerId) {
  const player = await store.getPlayer(playerId);
  if (player.status !== 'ACTIVE') {
    throw ApiError.forbidden('PLAYER_BLOCKED', 'La cuenta esta suspendida.');
  }
  return player;
}

function requireAuth({ loadPlayer = true } = {}) {
  return async function authMiddleware(req, res, next) {
    try {
      const token = extractBearer(req.get('authorization'));
      if (!token) throw ApiError.unauthorized('TOKEN_MISSING', 'Falta el encabezado Authorization.');

      const payload = verifyOrThrow(token);

      /* Un token de "Fichas de Prueba" jamas puede operar sobre saldo real. */
      if (payload.demo === true) {
        throw ApiError.unauthorized(
          'DEMO_TOKEN_NOT_ALLOWED',
          'Este token es de fichas de prueba y no permite operaciones con saldo real.'
        );
      }

      req.session = payload;
      if (loadPlayer) req.player = await loadActivePlayer(payload.sub);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Resuelve la identidad SIN exigir token de jugador real.
 *
 * Deja en la peticion:
 *   req.player     -> jugador real (solo si el token es de jugador real)
 *   req.session    -> payload firmado del token (si lo hay)
 *   req.isDemo     -> true cuando no hay jugador real (token demo o invitado)
 *   req.isDemoToken-> true si el token presentado lleva `demo: true`
 *   req.demoKey    -> clave de la cartera virtual (sesion demo o invitado)
 *
 * Un token invalido/caducado SIEMPRE responde 401: no se degrada a demo.
 * La ruta decide si el invitado anonimo puede continuar (ver routes/game.js).
 */
function resolveCaller() {
  return async function resolveCallerMiddleware(req, res, next) {
    try {
      const token = extractBearer(req.get('authorization'));

      if (!token) {
        req.isDemo = true;
        req.isDemoToken = false;
        req.demoKey = demoKeyFromRequest({
          ip: req.ip,
          userAgent: req.get('user-agent') || ''
        });
        return next();
      }

      const payload = verifyOrThrow(token);
      req.session = payload;

      if (payload.demo === true) {
        req.isDemo = true;
        req.isDemoToken = true;
        req.demoKey = demoKeyFromSub(payload.sub);
        return next();
      }

      req.player = await loadActivePlayer(payload.sub);
      req.isDemo = false;
      req.isDemoToken = false;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { requireAuth, resolveCaller, extractBearer };
