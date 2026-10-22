'use strict';

/**
 * Emision de sesion.
 *
 *   POST /api/session  { playerId? }
 *
 *  Solo existe para DESARROLLO (ALLOW_DEV_SESSION=true). En produccion el token
 *  debe emitirlo tu IdP/backoffice con el mismo SESSION_SECRET; si
 *  ALLOW_DEV_SESSION=false esta ruta responde 403 y no emite nada.
 *
 *  Nota GLI-19: emitir sesiones desde el propio servidor de juego sin validar
 *  identidad NO es aceptable en produccion. Aqui es unicamente una comodidad
 *  para pruebas locales, y el arranque en produccion la desactiva.
 */

const express = require('express');
const crypto = require('node:crypto');

const config = require('../config');
const store = require('../db');
const { ApiError, asyncHandler } = require('../errors');
const { issueToken } = require('../auth/sessionToken');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createSessionRoutes() {
  const router = express.Router();

  router.post(
    '/session',
    asyncHandler(async (req, res) => {
      if (!config.session.allowDevSession) {
        throw ApiError.forbidden(
          'DEV_SESSION_DISABLED',
          'La emision de sesiones esta desactivada. Usa el token de tu IdP.'
        );
      }

      const body = req.body || {};
      const playerId = body.playerId || config.session.devDemoPlayerId;
      if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId)) {
        throw ApiError.badRequest('INVALID_PLAYER_ID', 'playerId debe ser un UUID v4 valido.');
      }

      let player;
      if (store.driver === 'memory' && typeof store.ensureDemoPlayer === 'function') {
        player = store.ensureDemoPlayer({
          id: playerId,
          externalId: `demo-${playerId.slice(0, 8)}`,
          displayName: 'Demo Player',
          balanceCents: 100000 // 1.000,00 creditos de prueba
        });
      } else {
        player = await store.getPlayer(playerId);
      }

      if (player.status !== 'ACTIVE') {
        throw ApiError.forbidden('PLAYER_BLOCKED', 'La cuenta esta suspendida.');
      }

      const { token, expiresAt, ttlSeconds } = issueToken({ playerId: player.id });

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        token,
        tokenType: 'Bearer',
        expiresAt,
        ttlSeconds,
        player: {
          id: player.id,
          displayName: player.displayName,
          currency: player.currency
        },
        balance: {
          cents: player.balanceCents,
          credits: Number((player.balanceCents / 100).toFixed(2)),
          currency: player.currency
        },
        sessionId: crypto.randomUUID()
      });
    })
  );

  return router;
}

module.exports = { createSessionRoutes };
