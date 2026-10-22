'use strict';

/**
 * Emision de sesion.
 *
 *   POST /api/session        { playerId? }   -> token de JUGADOR REAL (solo dev)
 *   POST /api/demo/session   { playerId? }   -> token de "FICHAS DE PRUEBA"
 *
 *  `/api/session` solo existe para DESARROLLO (ALLOW_DEV_SESSION=true). En
 *  produccion el token real debe emitirlo tu IdP/backoffice con el mismo
 *  SESSION_SECRET; si ALLOW_DEV_SESSION=false esta ruta responde 403.
 *
 *  `/api/demo/session` es el modo "Jugar Gratis": emite un token firmado con el
 *  claim `demo: true` y una cartera VIRTUAL en memoria (1.000,00 VES por
 *  defecto). No crea jugadores ni escribe en Supabase.
 *
 *  Nota GLI-19: emitir sesiones de dinero real desde el propio servidor de juego
 *  sin validar identidad NO es aceptable en produccion. El modo demo si es
 *  seguro porque su saldo es ficticio y no toca la base de datos.
 */

const express = require('express');
const crypto = require('node:crypto');

const config = require('../config');
const store = require('../db');
const { ApiError, asyncHandler } = require('../errors');
const { issueToken } = require('../auth/sessionToken');
const { createRateLimitMiddleware } = require('../middleware/rateLimit');
const { demoWallet, demoKeyFromSub } = require('../services/demoWallet');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUEST_ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

function centsToCredits(cents) {
  return Number((cents / 100).toFixed(2));
}

function createSessionRoutes({ rateLimit } = {}) {
  const router = express.Router();

  /**
   * Sesion de invitado para "Fichas de Prueba".
   * Devuelve un token demo (claim `demo: true`) y el saldo virtual inicial.
   */
  router.post(
    '/demo/session',
    createRateLimitMiddleware(rateLimit),
    asyncHandler(async (req, res) => {
      if (!config.demo.enabled) {
        throw ApiError.forbidden(
          'DEMO_DISABLED',
          'El modo Fichas de Prueba esta desactivado en este servidor.'
        );
      }

      const body = req.body || {};
      const alias = typeof body.playerId === 'string' && body.playerId.trim() !== ''
        ? body.playerId.trim()
        : config.demo.guestId;

      if (!GUEST_ALIAS_PATTERN.test(alias)) {
        throw ApiError.badRequest(
          'INVALID_PLAYER_ID',
          'playerId debe ser un alias de 3 a 32 caracteres [A-Za-z0-9_-].'
        );
      }

      /* Una cartera nueva por sesion: dos invitados no comparten saldo. */
      const demoId = `${alias}:${crypto.randomUUID()}`;
      const { token, expiresAt, ttlSeconds } = issueToken({
        playerId: demoId,
        ttlSeconds: config.demo.tokenTtlSeconds,
        demo: true
      });

      const wallet = demoWallet.open(demoKeyFromSub(demoId), {
        displayName: config.demo.guestName
      });

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        demo: true,
        token,
        tokenType: 'Bearer',
        expiresAt,
        ttlSeconds,
        sessionId: demoId,
        player: {
          id: demoId,
          alias,
          displayName: config.demo.guestName,
          currency: wallet.currency
        },
        balance: {
          cents: wallet.balanceCents,
          credits: centsToCredits(wallet.balanceCents),
          currency: wallet.currency
        }
      });
    })
  );

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
