'use strict';

/**
 * ============================================================================
 *  SERVICIO DE JUEGO  -  unico punto donde se ejecuta el motor
 * ============================================================================
 *  Orden de una ronda:
 *    1. Validar entrada (apuesta de la escalera, modo, idempotencia, semilla).
 *    2. Comprobar saldo leido de la BD (rechazo temprano; la BD es la autoridad).
 *    3. Ejecutar el motor autoritativo (CSPRNG + tiras fisicas).
 *    4. Persistir de forma ATOMICA e IDEMPOTENTE (debito + credito + auditoria).
 *    5. Devolver el resultado ya persistido.
 *
 *  El cliente no puede influir en el resultado: `clientSeed` solo se mezcla en
 *  el DRBG y queda registrada para verificacion posterior.
 * ============================================================================
 */

const engine = require('../engine/gridEngine');
const store = require('../db');
const { ApiError } = require('../errors');
const { demoWallet } = require('./demoWallet');

const ROUND_REF_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_SEED_PATTERN = /^[\x20-\x7E]{0,64}$/;

function centsToCredits(cents) {
  return Number((cents / 100).toFixed(2));
}

function validateBetCents(betCents) {
  if (!Number.isInteger(betCents)) {
    throw ApiError.badRequest('INVALID_BET', 'La apuesta debe expresarse en centimos enteros.');
  }
  const credits = betCents / 100;
  if (!engine.isValidBetCredits(credits)) {
    throw ApiError.badRequest(
      'INVALID_BET',
      `Apuesta no permitida. Escalera valida: ${engine.BET_LADDER_CREDITS.join(', ')}`,
      { betLadder: engine.BET_LADDER_CREDITS }
    );
  }
}

function validateRoundRef(roundRef) {
  if (roundRef === undefined || roundRef === null || roundRef === '') return null;
  if (typeof roundRef !== 'string' || !ROUND_REF_PATTERN.test(roundRef)) {
    throw ApiError.badRequest(
      'INVALID_ROUND_REF',
      'roundRef debe tener entre 8 y 64 caracteres [A-Za-z0-9_-].'
    );
  }
  return roundRef;
}

function validateClientSeed(clientSeed) {
  if (clientSeed === undefined || clientSeed === null || clientSeed === '') return undefined;
  if (typeof clientSeed !== 'string' || !CLIENT_SEED_PATTERN.test(clientSeed)) {
    throw ApiError.badRequest(
      'INVALID_CLIENT_SEED',
      'clientSeed debe ser texto ASCII imprimible de maximo 64 caracteres.'
    );
  }
  return clientSeed;
}

function mapStoreError(error) {
  if (error instanceof ApiError) return error;
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  const code = (error && error.code) || 'DB_ERROR';
  if (status === 402) return ApiError.paymentRequired(code);
  if (status === 403) return ApiError.forbidden(code);
  if (status === 404) return ApiError.notFound(code);
  if (status === 400) return ApiError.badRequest(code);
  return ApiError.internal(`Fallo de persistencia (${code}).`);
}

/** Envelope publico: resultado del motor + saldo autoritativo + metadatos. */
function toPublicRound({ roundId, engineResult, balanceCents, currency, replayed, demo = false }) {
  const certifiedRtp = engineResult.mode === 'BUY_FEATURE'
    ? engine.CERTIFIED_RTP.feature
    : engine.CERTIFIED_RTP.base;

  return {
    roundId,
    replayed,
    /* true = ronda de "Fichas de Prueba": saldo virtual, sin cargo real. */
    demo,
    balance: {
      cents: balanceCents,
      credits: centsToCredits(balanceCents),
      currency
    },
    game: {
      code: engine.GAME_CODE,
      engineVersion: engineResult.engineVersion,
      paytableVersion: engineResult.paytableVersion
    },
    mode: engineResult.mode,
    betCents: engineResult.betCents,
    betCredits: centsToCredits(engineResult.betCents),
    wagerCents: engineResult.wagerCents,
    wagerCredits: centsToCredits(engineResult.wagerCents),
    totalWinCents: engineResult.totalWinCents,
    totalWinCredits: engineResult.totalWinCredits,
    winMultiplier: Number((engineResult.totalWinCents / engineResult.betCents).toFixed(4)),
    maxWinCents: engineResult.maxWinCents,
    maxWinMultiplier: engine.MAX_EXPOSURE_MULTIPLIER,
    capped: engineResult.capped,
    maxWinReached: engineResult.maxWinReached,
    spinsPlayed: engineResult.spinsPlayed,
    spinsPlanned: engineResult.spinsPlanned,
    spins: engineResult.spins,
    initialGrid: engineResult.initialGrid,
    finalGrid: engineResult.finalGrid,
    cascades: engineResult.cascades,
    scatter: engineResult.scatter,
    bombs: engineResult.bombs,
    multiplier: engineResult.multiplier,
    multiplierApplied: engineResult.multiplierApplied,
    feature: engineResult.feature || null,
    audit: {
      ...engineResult.audit,
      certifiedRtp
    }
  };
}

/**
 * Ejecuta una ronda.
 * @param {object} params
 * @param {object} params.player     jugador cargado desde el store
 * @param {number} params.betCents   apuesta base en centimos
 * @param {boolean} [params.buyFeature]
 * @param {string} [params.clientSeed]
 * @param {string} [params.roundRef] clave de idempotencia del cliente
 */
async function playRound({ player, betCents, buyFeature = false, clientSeed, roundRef }) {
  validateBetCents(betCents);
  if (typeof buyFeature !== 'boolean') {
    throw ApiError.badRequest('INVALID_MODE', 'buyFeature debe ser booleano.');
  }
  const ref = validateRoundRef(roundRef);
  const seed = validateClientSeed(clientSeed);

  const wagerCents = buyFeature
    ? betCents * engine.FEATURE_CONFIG.costMultiplier
    : betCents;

  if (player.balanceCents < wagerCents) {
    throw ApiError.paymentRequired(
      'INSUFFICIENT_FUNDS',
      `Saldo insuficiente: se necesitan ${centsToCredits(wagerCents)} creditos.`
    );
  }

  /* --- Ejecucion autoritativa (el resultado NO depende del cliente) --- */
  let engineResult;
  try {
    engineResult = engine.playRound({ betCents, buyFeature, clientSeed: seed });
  } catch {
    throw ApiError.internal('El motor no pudo resolver la ronda.');
  }

  /* --- Persistencia atomica + idempotente --- */
  let persisted;
  try {
    persisted = await store.playRoundAtomic({
      playerId: player.id,
      roundRef: ref,
      mode: engineResult.mode,
      betCents: engineResult.betCents,
      wagerCents: engineResult.wagerCents,
      winCents: engineResult.totalWinCents,
      multiplier: engineResult.multiplier,
      engineVersion: engineResult.engineVersion,
      paytableVersion: engineResult.paytableVersion,
      certifiedRtp: buyFeature ? engine.CERTIFIED_RTP.feature : engine.CERTIFIED_RTP.base,
      serverSeed: engineResult.audit.serverSeed,
      serverSeedHash: engineResult.audit.serverSeedHash,
      clientSeed: engineResult.audit.clientSeed,
      rngHash: engineResult.audit.rngHash,
      result: engineResult
    });
  } catch (error) {
    throw mapStoreError(error);
  }

  /* --- Reintento idempotente: se devuelve la ronda ya guardada --- */
  if (persisted.replayed && persisted.storedResult) {
    return toPublicRound({
      roundId: persisted.storedResult.roundId,
      engineResult: persisted.storedResult.result,
      balanceCents: persisted.balanceCents,
      currency: player.currency,
      replayed: true
    });
  }

  return toPublicRound({
    roundId: persisted.roundId,
    engineResult,
    balanceCents: persisted.balanceCents,
    currency: player.currency,
    replayed: false
  });
}

/**
 * Ejecuta una ronda en modo "Fichas de Prueba".
 *
 * Usa EXACTAMENTE el mismo motor (`engine.playRound`) que una ronda real, pero
 * liquida en la cartera virtual en memoria: no hay `playRoundAtomic`, no hay
 * debito/credito en Supabase y el saldo devuelto es ficticio.
 *
 * @param {object} params
 * @param {string} params.demoKey  clave de la cartera virtual del invitado
 * @param {number} params.betCents
 * @param {boolean} [params.buyFeature]
 * @param {string} [params.clientSeed]
 * @param {string} [params.roundRef] idempotencia del cliente
 */
async function playDemoRound({ demoKey, betCents, buyFeature = false, clientSeed, roundRef }) {
  validateBetCents(betCents);
  if (typeof buyFeature !== 'boolean') {
    throw ApiError.badRequest('INVALID_MODE', 'buyFeature debe ser booleano.');
  }
  const ref = validateRoundRef(roundRef);
  const seed = validateClientSeed(clientSeed);

  const wagerCents = buyFeature
    ? betCents * engine.FEATURE_CONFIG.costMultiplier
    : betCents;

  /* Reintento idempotente: misma roundRef -> misma ronda, sin re-cobrar. */
  const replay = demoWallet.findReplay(demoKey, ref);
  if (replay) {
    return toPublicRound({
      roundId: replay.roundId,
      engineResult: replay.result,
      balanceCents: replay.balanceCents,
      currency: demoWallet.currency,
      replayed: true,
      demo: true
    });
  }

  const wallet = demoWallet.ensure(demoKey);
  if (wallet.balanceCents < wagerCents) {
    throw ApiError.paymentRequired(
      'INSUFFICIENT_FUNDS',
      `Fichas de prueba insuficientes: se necesitan ${centsToCredits(wagerCents)} creditos virtuales.`
    );
  }

  /* --- Mismo motor autoritativo que en dinero real --- */
  let engineResult;
  try {
    engineResult = engine.playRound({ betCents, buyFeature, clientSeed: seed });
  } catch {
    throw ApiError.internal('El motor no pudo resolver la ronda.');
  }

  let committed;
  try {
    committed = demoWallet.commit({
      key: demoKey,
      roundRef: ref,
      wagerCents: engineResult.wagerCents,
      winCents: engineResult.totalWinCents,
      result: engineResult
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error && error.code === 'INSUFFICIENT_FUNDS') {
      throw ApiError.paymentRequired('INSUFFICIENT_FUNDS', 'Fichas de prueba insuficientes.');
    }
    throw ApiError.internal('No se pudo liquidar la ronda de prueba.');
  }

  if (committed.replayed && committed.stored) {
    return toPublicRound({
      roundId: committed.roundId,
      engineResult: committed.stored.result,
      balanceCents: committed.balanceCents,
      currency: wallet.currency,
      replayed: true,
      demo: true
    });
  }

  return toPublicRound({
    roundId: committed.roundId,
    engineResult,
    balanceCents: committed.balanceCents,
    currency: wallet.currency,
    replayed: false,
    demo: true
  });
}

/** Saldo virtual actual (lo crea con 1.000,00 si es la primera visita). */
function getDemoBalance(demoKey) {
  const snapshot = demoWallet.snapshot(demoKey);
  return {
    demo: true,
    player: {
      id: demoKey,
      displayName: snapshot.displayName,
      currency: snapshot.balance.currency
    },
    balance: snapshot.balance,
    stats: snapshot.stats
  };
}

async function getBalance(player) {
  const fresh = await store.getPlayer(player.id);
  return {
    balance: {
      cents: fresh.balanceCents,
      credits: centsToCredits(fresh.balanceCents),
      currency: fresh.currency
    },
    stats: {
      spinCount: fresh.spinCount,
      totalWageredCents: fresh.totalWageredCents,
      totalWonCents: fresh.totalWonCents
    }
  };
}

/** Info publica del juego (paytable, tiras, RTP certificado, reglas). */
function getGameInfo() {
  return engine.gameInfo;
}

module.exports = {
  playRound,
  playDemoRound,
  getBalance,
  getDemoBalance,
  getGameInfo,
  __internals: { validateBetCents, validateRoundRef, validateClientSeed, centsToCredits }
};
