'use strict';

/**
 * Selector de persistencia. El resto del backend solo conoce esta interfaz:
 *   getPlayer(playerId)
 *   playRoundAtomic(params)
 *   getRoundResult(roundId)
 *   adjustBalance(playerId, amountCents, note)
 */

const config = require('../config');

const store = config.db.driver === 'supabase'
  // eslint-disable-next-line global-require
  ? require('./supabaseStore')
  // eslint-disable-next-line global-require
  : require('./memoryStore');

module.exports = store;
