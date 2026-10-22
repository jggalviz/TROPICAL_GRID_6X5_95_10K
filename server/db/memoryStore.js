'use strict';

/**
 * ============================================================================
 *  STORE EN MEMORIA  -  SOLO DESARROLLO / TESTS
 * ============================================================================
 *  Replica la semantica de `public.play_spin` (idempotencia por round_ref,
 *  debito + credito, libro mayor) sin base de datos.
 *
 *  Atomicidad: Node ejecuta JS en un unico hilo y todas las mutaciones de este
 *  modulo son SINCRONAS (sin await entre la comprobacion de saldo y la
 *  escritura), por lo que no puede haber intercalado entre peticiones.
 *
 *  PROHIBIDO en produccion: `config.js` aborta el arranque si
 *  NODE_ENV=production y el driver es "memory".
 */

const crypto = require('node:crypto');

const players = new Map();       // id -> jugador
const roundsByRef = new Map();   // `${playerId}:${roundRef}` -> roundId
const rounds = new Map();        // roundId -> ronda
const ledger = [];               // movimientos

let seeded = false;

function notFound() {
  const err = new Error('PLAYER_NOT_FOUND');
  err.code = 'PLAYER_NOT_FOUND';
  err.status = 404;
  return err;
}

function businessError(code, status = 400) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  return err;
}

function publicPlayer(player) {
  return {
    id: player.id,
    externalId: player.externalId,
    displayName: player.displayName,
    currency: player.currency,
    balanceCents: player.balanceCents,
    status: player.status,
    spinCount: player.spinCount,
    totalWageredCents: player.totalWageredCents,
    totalWonCents: player.totalWonCents
  };
}

function createPlayer({ id, externalId, displayName = 'Player', currency = 'EUR', balanceCents = 0 }) {
  const player = {
    id: id || crypto.randomUUID(),
    externalId,
    displayName,
    currency,
    balanceCents: Math.trunc(balanceCents),
    status: 'ACTIVE',
    spinCount: 0,
    totalWageredCents: 0,
    totalWonCents: 0,
    createdAt: new Date().toISOString()
  };
  players.set(player.id, player);
  return publicPlayer(player);
}

async function getPlayer(playerId) {
  const player = players.get(playerId);
  if (!player) throw notFound();
  return publicPlayer(player);
}

async function playRoundAtomic(params) {
  const player = players.get(params.playerId);
  if (!player) throw notFound();
  if (player.status !== 'ACTIVE') throw businessError('PLAYER_BLOCKED', 403);
  if (!Number.isInteger(params.betCents) || params.betCents <= 0) throw businessError('INVALID_STAKE');
  if (!Number.isInteger(params.wagerCents) || params.wagerCents <= 0) throw businessError('INVALID_STAKE');
  if (!Number.isInteger(params.winCents) || params.winCents < 0) throw businessError('INVALID_WIN');

  const refKey = params.roundRef ? `${params.playerId}:${params.roundRef}` : null;
  if (refKey && roundsByRef.has(refKey)) {
    const existing = rounds.get(roundsByRef.get(refKey));
    return {
      roundId: existing.roundId,
      balanceCents: player.balanceCents,
      replayed: true,
      storedResult: {
        roundId: existing.roundId,
        playerId: player.id,
        mode: existing.mode,
        betCents: existing.betCents,
        wagerCents: existing.wagerCents,
        winCents: existing.winCents,
        multiplier: existing.multiplier,
        result: existing.result,
        createdAt: existing.createdAt
      }
    };
  }

  if (player.balanceCents < params.wagerCents) throw businessError('INSUFFICIENT_FUNDS', 402);

  /* --- Debito atomico: mismo orden que `play_spin` (replay antes que saldo) --- */
  if (player.balanceCents < params.wagerCents) throw businessError('INSUFFICIENT_FUNDS', 402);

  const roundId = crypto.randomUUID();
  const balanceBefore = player.balanceCents;
  const afterBet = balanceBefore - params.wagerCents;
  const balanceAfter = afterBet + params.winCents;

  ledger.push({
    playerId: player.id,
    roundId,
    type: params.mode === 'BUY_FEATURE' ? 'BONUS_BUY' : 'BET',
    amountCents: -params.wagerCents,
    balanceAfterCents: afterBet
  });
  if (params.winCents > 0) {
    ledger.push({
      playerId: player.id,
      roundId,
      type: 'WIN',
      amountCents: params.winCents,
      balanceAfterCents: balanceAfter
    });
  }

  player.balanceCents = balanceAfter;
  player.spinCount += 1;
  player.totalWageredCents += params.wagerCents;
  player.totalWonCents += params.winCents;

  const round = {
    roundId,
    playerId: player.id,
    roundRef: params.roundRef,
    mode: params.mode,
    betCents: params.betCents,
    wagerCents: params.wagerCents,
    winCents: params.winCents,
    balanceBeforeCents: balanceBefore,
    balanceAfterCents: balanceAfter,
    multiplier: params.multiplier,
    engineVersion: params.engineVersion,
    paytableVersion: params.paytableVersion,
    certifiedRtp: params.certifiedRtp,
    serverSeed: params.serverSeed,
    serverSeedHash: params.serverSeedHash,
    clientSeed: params.clientSeed,
    rngHash: params.rngHash,
    result: params.result,
    createdAt: new Date().toISOString()
  };

  rounds.set(roundId, round);
  if (refKey) roundsByRef.set(refKey, roundId);

  return { roundId, balanceCents: balanceAfter, replayed: false, storedResult: null };
}

async function getRoundResult(roundId) {
  const round = rounds.get(roundId);
  if (!round) return null;
  return {
    roundId: round.roundId,
    playerId: round.playerId,
    mode: round.mode,
    betCents: round.betCents,
    wagerCents: round.wagerCents,
    winCents: round.winCents,
    multiplier: round.multiplier,
    result: round.result,
    createdAt: round.createdAt
  };
}

async function adjustBalance(playerId, amountCents, note = null) {
  const player = players.get(playerId);
  if (!player) throw notFound();
  const next = player.balanceCents + amountCents;
  if (next < 0) throw businessError('INSUFFICIENT_FUNDS', 402);
  player.balanceCents = next;
  ledger.push({
    playerId, roundId: null, type: 'ADJUSTMENT', amountCents: next, balanceAfterCents: next, note
  });
  return next;
}

/** Crea el jugador demo (idempotente) al arrancar en modo memoria. */
function ensureDemoPlayer({ id, externalId = 'demo', displayName = 'Demo Player', balanceCents = 100000 }) {
  if (players.has(id)) return publicPlayer(players.get(id));
  return createPlayer({ id, externalId, displayName, balanceCents });
}

function markSeeded() {
  seeded = true;
}

/** Utilidades exclusivas de test. */
function __setStatus(playerId, status) {
  const player = players.get(playerId);
  if (!player) throw notFound();
  player.status = status;
  return publicPlayer(player);
}

function __reset() {
  players.clear();
  roundsByRef.clear();
  rounds.clear();
  ledger.length = 0;
  seeded = false;
}

function __snapshot() {
  return {
    players: [...players.values()].map(publicPlayer),
    rounds: [...rounds.values()],
    ledger: ledger.slice(),
    seeded
  };
}

module.exports = {
  driver: 'memory',
  getPlayer,
  playRoundAtomic,
  getRoundResult,
  adjustBalance,
  createPlayer,
  ensureDemoPlayer,
  markSeeded,
  __reset,
  __setStatus,
  __snapshot
};
