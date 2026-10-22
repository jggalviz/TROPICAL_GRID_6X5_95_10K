'use strict';

/**
 * ============================================================================
 *  SEED DE DESARROLLO
 * ============================================================================
 *  Crea (o pone a punto) el jugador demo en Supabase.
 *
 *    npm run seed
 *    npm run seed -- --balance-credits=5000
 *
 *  NO crea tablas: ejecuta antes `sql/schema.sql` en el SQL Editor.
 *  Idempotente: si el jugador existe, solo ajusta saldo si se pide.
 * ============================================================================
 */

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../server/config');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  if (config.db.driver !== 'supabase') {
    console.log('[seed] Driver en memoria: no hay nada que sembrar.');
    console.log(`[seed] Jugador demo en memoria: ${config.session.devDemoPlayerId} (1.000,00 creditos).`);
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(config.db.supabaseUrl, config.db.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const playerId = arg('player-id', config.session.devDemoPlayerId);
  const externalId = arg('external-id', 'demo');
  const displayName = arg('name', 'Demo Player');
  const credits = Number(arg('balance-credits', '1000'));
  const balanceCents = Math.round(credits * 100);

  if (!Number.isInteger(balanceCents) || balanceCents < 0) {
    throw new Error('balance-credits invalido');
  }

  const { data: existing, error: selectError } = await supabase
    .from('players')
    .select('id, external_id, balance_cents, status')
    .eq('id', playerId)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing) {
    console.log(`[seed] Jugador ya existe: ${existing.id} (saldo ${(existing.balance_cents / 100).toFixed(2)})`);
    if (process.argv.includes('--reset-balance')) {
      const { data, error } = await supabase.rpc('adjust_balance', {
        p_player_id: playerId,
        p_amount_cents: balanceCents - Number(existing.balance_cents),
        p_note: 'seed --reset-balance'
      });
      if (error) throw error;
      console.log(`[seed] Saldo ajustado a ${(Number(data) / 100).toFixed(2)} creditos.`);
    }
    return;
  }

  const { data, error } = await supabase
    .from('players')
    .insert({
      id: playerId,
      external_id: externalId,
      display_name: displayName,
      currency: 'EUR',
      balance_cents: balanceCents,
      status: 'ACTIVE'
    })
    .select('id, external_id, balance_cents')
    .single();

  if (error) throw error;
  console.log(`[seed] Jugador creado: ${data.id} (${(data.balance_cents / 100).toFixed(2)} creditos)`);
}

main().catch((error) => {
  console.error('[seed] Error:', error.message || error);
  process.exitCode = 1;
});
