'use strict';

/**
 * Autenticacion por token firmado.
 *
 *   Authorization: Bearer t1.<payload>.<firma>
 *
 * El token solo transporta el `playerId`; el saldo SIEMPRE se lee de la base de
 * datos en cada peticion (nunca se confia en el cliente).
 */

const { ApiError } = require('../errors');
const { verifyToken } = require('../auth/sessionToken');
const store = require('../db');

function extractBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function requireAuth({ loadPlayer = true } = {}) {
  return async function authMiddleware(req, res, next) {
    try {
      const token = extractBearer(req.get('authorization'));
      if (!token) throw ApiError.unauthorized('TOKEN_MISSING', 'Falta el encabezado Authorization.');

      let payload;
      try {
        payload = verifyToken(token);
      } catch (error) {
        throw ApiError.unauthorized(error.code || 'TOKEN_INVALID', 'Sesion no valida o expirada.');
      }

      req.session = payload;
      if (loadPlayer) {
        const player = await store.getPlayer(payload.sub);
        if (player.status !== 'ACTIVE') {
          throw ApiError.forbidden('PLAYER_BLOCKED', 'La cuenta esta suspendida.');
        }
        req.player = player;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { requireAuth, extractBearer };
