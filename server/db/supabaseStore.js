'use strict';

/**
 * Store respaldado por Supabase/PostgreSQL.
 *
 * Todo el movimiento de dinero ocurre DENTRO de la funcion `play_spin`
 * (SECURITY DEFINER): bloqueo de fila del jugador + debito + credito + registro
 * en el libro mayor, en una sola transaccion. El backend nunca hace
 * "leer saldo -> calcular -> escribir saldo" en JS, porque eso permitiria
 * dobles gastos con peticiones concurrentes.
 */

const config = require('../config');

let client = null;

function getClient() {
  if (client) return client;
  // require diferido: el driver "memory" no necesita el paquete instalado.
  // eslint-disable-next-line global-require
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(config.db.supabaseUrl, config.db.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: config.db.schema },
    global: {
      headers: { 'X-Client-Info': 'tropical-grid-server/1.1.0' }
    }
  });
  return client;
}

/** Traduce los errores de negocio de PostgreSQL a codigos HTTP. */
const DB_ERROR_MAP = Object.freeze({
  PLAYER_NOT_FOUND: { status: 404, code: 'PLAYER_NOT_FOUND' },
  PLAYER_BLOCKED: { status: 403, code: 'PLAYER_BLOCKED' },
  INSUFFICIENT_FUNDS: { status: 402, code: 'INSUFFICIENT_FUNDS' },
  INVALID_STAKE: { status: 400, code: 'INVALID_STAKE' },
  INVALID_WIN: { status: 400, code: 'INVALID_WIN' },
  INVALID_MODE: { status: 400, code: 'INVALID_MODE' }
});

function mapDbError(error) {
  const raw = String((error && error.message) || 'DB_ERROR');
  const key = Object.keys(DB_ERROR_MAP).find((code) => raw.includes(code));
  const mapped = key ? DB_ERROR_MAP[key] : null;
  const err = new Error(mapped ? mapped.code : 'DB_ERROR');
  err.code = mapped ? mapped.code : 'DB_ERROR';
  err.status = mapped ? mapped.status : 500;
  err.cause = raw;
  return err;
}

/**
 * Lee la ficha del jugador (saldo autoritativo incluido).
 * @param {string} playerId uuid
 */
async function getPlayer(playerId) {
  const { data, error } = await getClient()
    .from('players')
    .select('id, external_id, display_name, currency, balance_cents, status, spin_count, total_wagered_cents, total_won_cents')
    .eq('id', playerId)
    .maybeSingle();

  if (error) throw mapDbError(error);
  if (!data) {
    const err = new Error('PLAYER_NOT_FOUND');
    err.code = 'PLAYER_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  return {
    id: data.id,
    externalId: data.external_id,
    displayName: data.display_name,
    currency: data.currency,
    balanceCents: Number(data.balance_cents),
    status: data.status,
    spinCount: Number(data.spin_count),
    totalWageredCents: Number(data.total_wagered_cents),
    totalWonCents: Number(data.total_won_cents)
  };
}

/**
 * Resuelve una ronda de forma atomica e idempotente.
 *
 * @param {object} params
 * @returns {Promise<{roundId: string, balanceCents: number, replayed: boolean, storedResult: object|null}>}
 */
async function playRoundAtomic(params) {
  const { data, error } = await getClient().rpc('play_spin', {
    p_player_id: params.playerId,
    p_round_ref: params.roundRef,
    p_mode: params.mode,
    p_bet_cents: params.betCents,
    p_wager_cents: params.wagerCents,
    p_win_cents: params.winCents,
    p_multiplier: params.multiplier,
    p_engine_version: params.engineVersion,
    p_paytable_version: params.paytableVersion,
    p_certified_rtp: params.certifiedRtp,
    p_server_seed: params.serverSeed,
    p_server_seed_hash: params.serverSeedHash,
    p_client_seed: params.clientSeed,
    p_rng_hash: params.rngHash,
    p_result: params.result
  });

  if (error) throw mapDbError(error);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw mapDbError({ message: 'DB_ERROR' });

  let storedResult = null;
  if (row.replayed) {
    storedResult = await getRoundResult(row.round_id);
  }

  return {
    roundId: row.round_id,
    balanceCents: Number(row.balance_cents),
    replayed: Boolean(row.replayed),
    storedResult
  };
}

/** Recupera el payload de una ronda ya resuelta (para reintentos idempotentes). */
async function getRoundResult(roundId) {
  const { data, error } = await getClient()
    .from('game_rounds')
    .select('id, player_id, mode, bet_cents, wager_cents, win_cents, multiplier, result, created_at')
    .eq('id', roundId)
    .maybeSingle();

  if (error) throw mapDbError(error);
  if (!data) return null;

  return {
    roundId: data.id,
    playerId: data.player_id,
    mode: data.mode,
    betCents: Number(data.bet_cents),
    wagerCents: Number(data.wager_cents),
    winCents: Number(data.win_cents),
    multiplier: data.multiplier,
    result: data.result,
    createdAt: data.created_at
  };
}

/** Movimiento administrativo (seed de pruebas, ajustes, reembolsos). */
async function adjustBalance(playerId, amountCents, note = null) {
  const { data, error } = await getClient().rpc('adjust_balance', {
    p_player_id: playerId,
    p_amount_cents: amountCents,
    p_note: note
  });
  if (error) throw mapDbError(error);
  return Number(data);
}

module.exports = {
  driver: 'supabase',
  getPlayer,
  playRoundAtomic,
  getRoundResult,
  adjustBalance
};
