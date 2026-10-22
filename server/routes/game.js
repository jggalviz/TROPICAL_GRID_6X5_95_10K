'use strict';

/**
 * Rutas de juego.
 *
 *   GET  /api/health   -> liveness (sin datos sensibles)
 *   GET  /api/game     -> informacion publica del juego (paytable, tiras, RTP, demo)
 *   GET  /api/player   -> saldo y estadisticas (real o virtual segun el token)
 *   POST /api/spin     -> resuelve una ronda (base, compra de bonus o demo)
 */

const express = require('express');

const engine = require('../engine/gridEngine');
const gameService = require('../services/gameService');
const store = require('../db');
const config = require('../config');
const { ApiError, asyncHandler } = require('../errors');
const { resolveCaller } = require('../middleware/auth');
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
    res.json({
      ok: true,
      game: {
        ...gameService.getGameInfo(),
        /* Parametros publicos del modo "Fichas de Prueba" (los pinta el cliente). */
        demo: {
          enabled: config.demo.enabled,
          guestId: config.demo.guestId,
          guestName: config.demo.guestName,
          currency: config.demo.currency,
          startBalanceCents: config.demo.startBalanceCents,
          startBalanceCredits: Number((config.demo.startBalanceCents / 100).toFixed(2))
        }
      }
    });
  });

  /**
   * Saldo y estadisticas.
   *  - Token real -> saldo de la base de datos.
   *  - Token demo o invitado -> saldo virtual en memoria (1.000,00 VES).
   */
  router.get(
    '/player',
    resolveCaller(),
    asyncHandler(async (req, res) => {
      /* Sin token no se expone ningun saldo: el invitado debe pedir sesion demo. */
      if (!req.session) {
        throw ApiError.unauthorized('TOKEN_MISSING', 'Falta el encabezado Authorization.');
      }

      if (req.isDemo) {
        const payload = gameService.getDemoBalance(req.demoKey);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          demo: true,
          player: payload.player,
          balance: payload.balance,
          stats: payload.stats
        });
        return;
      }

      const payload = await gameService.getBalance(req.player);
      res.json({
        ok: true,
        demo: false,
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
    resolveCaller(),
    createRateLimitMiddleware(rateLimit),
    asyncHandler(async (req, res) => {
      const body = req.body || {};

      /* Intencion demo: token demo, o invitado sin token que la declara. */
      const demoRequested = body.demo === true || body.playerId === config.demo.guestId;

      if (req.player && demoRequested) {
        throw ApiError.badRequest(
          'DEMO_MODE_CONFLICT',
          'Hay una sesion real activa: no se puede jugar con fichas de prueba con ese token.'
        );
      }

      /* Sin token y sin intencion demo explicita se mantiene el 401. */
      if (!req.player && !req.isDemoToken && !demoRequested) {
        throw ApiError.unauthorized('TOKEN_MISSING', 'Falta el encabezado Authorization.');
      }

      /* `isDemo = !token || player_id === 'invitado_demo'` (token demo incluido). */
      const isDemo = !req.player;
      if (isDemo && !config.demo.enabled) {
        throw ApiError.forbidden(
          'DEMO_DISABLED',
          'El modo Fichas de Prueba esta desactivado en este servidor.'
        );
      }

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

      /* Ruta demo: mismo motor, cartera virtual, CERO escrituras en Supabase. */
      const result = isDemo
        ? await gameService.playDemoRound({
          demoKey: req.demoKey,
          betCents,
          buyFeature,
          clientSeed,
          roundRef
        })
        : await gameService.playRound({
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
