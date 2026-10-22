'use strict';

/**
 * Rutas de juego.
 *
 *   GET  /api/health   -> liveness (sin datos sensibles)
 *   GET  /api/game     -> informacion publica del juego (paytable, tiras, RTP)
 *   GET  /api/player   -> saldo y estadisticas del jugador autenticado
 *   POST /api/spin     -> resuelve una ronda (base o compra de bonus)
 */

const express = require('express');

const engine = require('../engine/gridEngine');
const gameService = require('../services/gameService');
const store = require('../db');
const { ApiError, asyncHandler } = require('../errors');
const { requireAuth } = require('../middleware/auth');
const { createRateLimitMiddleware } = require('../middleware/rateLimit');

function createGameRoutes({ rateLimit } = {}) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      status: 'UP',
      engineVersion: engine.ENGINE_VERSION,
      paytableVersion: engine.PAYTABLE_VERSION,
      dbDriver: store.driver,
      certifiedRtp: engine.CERTIFIED_RTP,
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  router.get('/game', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, game: gameService.getGameInfo() });
  });

  router.get(
    '/player',
    requireAuth(),
    asyncHandler(async (req, res) => {
      const payload = await gameService.getBalance(req.player);
      res.json({
        ok: true,
        player: {
          id: req.player.id,
          displayName: req.player.displayName,
          currency: req.player.currency
        },
        ...payload
      });
    })
  );

  router.post(
    '/spin',
    requireAuth(),
    createRateLimitMiddleware(rateLimit),
    asyncHandler(async (req, res) => {
      const body = req.body || {};

      /* Apuesta: se acepta `bet` en creditos (0.10 .. 100) o `betCents` entero.
         Solo se admite una de las dos formas para evitar ambiguedad. */
      const hasCredits = body.bet !== undefined && body.bet !== null;
      const hasCents = body.betCents !== undefined && body.betCents !== null;
      if (hasCredits === hasCents) {
        throw ApiError.badRequest('INVALID_BET', 'Envia exactamente uno de: bet (creditos) o betCents.');
      }

      let betCents;
      if (hasCredits) {
        betCents = engine.creditsToCents(body.bet);
        if (betCents === null) {
          throw ApiError.badRequest('INVALID_BET', 'bet debe ser un numero de creditos con 2 decimales.');
        }
      } else {
        betCents = body.betCents;
      }

      const buyFeature = body.buyFeature === true;
      const roundRef = body.roundRef || req.get('idempotency-key') || null;
      const clientSeed = body.clientSeed;

      const result = await gameService.playRound({
        player: req.player,
        betCents,
        buyFeature,
        clientSeed,
        roundRef
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, ...result });
    })
  );

  return router;
}

module.exports = { createGameRoutes };
