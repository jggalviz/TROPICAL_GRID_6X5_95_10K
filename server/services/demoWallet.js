'use strict';

/**
 * ============================================================================
 *  CARTERA VIRTUAL DEL MODO "FICHAS DE PRUEBA"
 * ============================================================================
 *  El saldo de invitado vive UNICAMENTE en memoria del proceso:
 *
 *    - Nunca escribe en Supabase (`playRoundAtomic` no se invoca).
 *    - Es autoritativo: el cliente no envia ni puede fijar su saldo.
 *    - Cada sesion demo tiene su propio saldo, su historial de idempotencia y
 *      una expiracion deslizante (se renueva con cada tirada).
 *    - Si el proceso se reinicia, todas las carteras se descartan y el invitado
 *      vuelve a empezar con el saldo inicial.
 *
 *  Claves de cartera:
 *    demo:<sub del token>   -> emitida por POST /api/demo/session (recomendado)
 *    anon:<hash(ip|ua)>     -> invitado sin token que declara intencion demo
 *
 *  El motor matematico es EXACTAMENTE el mismo que en dinero real
 *  (`gridEngine.playRound`), por lo que el RTP mostrado es el certificado.
 * ============================================================================
 */

const crypto = require('node:crypto');

const config = require('../config');

function demoKeyFromSub(sub) {
  return `demo:${sub}`;
}

/** Clave estable para invitados sin token (no identifica personas). */
function demoKeyFromRequest({ ip = '', userAgent = '' } = {}) {
  const digest = crypto
    .createHash('sha256')
    .update(`${ip}|${userAgent}`)
    .digest('hex')
    .slice(0, 32);
  return `anon:${digest}`;
}

class DemoWallet {
  constructor(options = {}) {
    this.currency = options.currency || config.demo.currency;
    this.startBalanceCents = options.startBalanceCents || config.demo.startBalanceCents;
    this.sessionTtlMs = options.sessionTtlMs || config.demo.sessionTtlMs;
    this.maxSessions = options.maxSessions || config.demo.maxSessions;
    this.maxIdempotentRounds = options.maxIdempotentRounds || config.demo.maxIdempotentRounds;
    this.now = options.now || Date.now;
    this.sessions = new Map(); // key -> wallet
  }

  /** Crea una cartera nueva con el saldo inicial (1.000,00 por defecto). */
  open(key, { displayName } = {}) {
    const now = this.now();
    const wallet = {
      key,
      displayName: displayName || config.demo.guestName,
      currency: this.currency,
      balanceCents: this.startBalanceCents,
      spinCount: 0,
      totalWageredCents: 0,
      totalWonCents: 0,
      rounds: new Map(), // roundRef -> { roundId, balanceCents, result }
      createdAt: now,
      expiresAt: now + this.sessionTtlMs
    };
    this.sessions.set(key, wallet);
    this.evictIfNeeded_();
    return wallet;
  }

  /** Cartera existente o null si no hay / caduco (sin crear nada). */
  peek(key) {
    const wallet = this.sessions.get(key);
    if (!wallet) return null;
    if (wallet.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return wallet;
  }

  /** Cartera existente o nueva; renueva la expiracion deslizante. */
  ensure(key, options) {
    const wallet = this.peek(key);
    if (!wallet) return this.open(key, options);
    wallet.expiresAt = this.now() + this.sessionTtlMs;
    return wallet;
  }

  /** Busca una ronda ya liquidada (idempotencia) sin alterar el saldo. */
  findReplay(key, roundRef) {
    if (!roundRef) return null;
    const wallet = this.peek(key);
    if (!wallet) return null;
    return wallet.rounds.get(roundRef) || null;
  }

  /**
   * Liquida una ronda en la cartera virtual.
   * Todo es sincrono: no hay ventana de carrera entre saldo y apuesta.
   *
   * @param {object} params
   * @param {string} params.key
   * @param {string|null} [params.roundRef]
   * @param {number} params.wagerCents
   * @param {number} params.winCents
   * @param {object} params.result  resultado completo del motor (auditoria)
   * @returns {{ replayed: boolean, roundId: string, balanceCents: number, stored?: object }}
   * @throws {Error} code=INSUFFICIENT_FUNDS, status=402
   */
  commit({ key, roundRef = null, wagerCents, winCents, result }) {
    const wallet = this.ensure(key);

    if (roundRef) {
      const stored = wallet.rounds.get(roundRef);
      if (stored) {
        return { replayed: true, roundId: stored.roundId, balanceCents: stored.balanceCents, stored };
      }
    }

    if (!Number.isInteger(wagerCents) || wagerCents < 0 || !Number.isInteger(winCents) || winCents < 0) {
      const error = new Error('Importes invalidos en la cartera demo.');
      error.code = 'INVALID_AMOUNT';
      error.status = 400;
      throw error;
    }
    if (wallet.balanceCents < wagerCents) {
      const error = new Error('Fichas de prueba insuficientes.');
      error.code = 'INSUFFICIENT_FUNDS';
      error.status = 402;
      throw error;
    }

    wallet.balanceCents = wallet.balanceCents - wagerCents + winCents;
    wallet.spinCount += 1;
    wallet.totalWageredCents += wagerCents;
    wallet.totalWonCents += winCents;
    wallet.expiresAt = this.now() + this.sessionTtlMs;

    const entry = {
      roundId: crypto.randomUUID(),
      balanceCents: wallet.balanceCents,
      result
    };

    if (roundRef) {
      wallet.rounds.set(roundRef, entry);
      if (wallet.rounds.size > this.maxIdempotentRounds) {
        // Map conserva el orden de insercion: se descarta la referencia mas vieja.
        const oldest = wallet.rounds.keys().next().value;
        wallet.rounds.delete(oldest);
      }
    }

    return { replayed: false, roundId: entry.roundId, balanceCents: wallet.balanceCents };
  }

  /** Vista publica del saldo virtual (lo unico que se envia al cliente). */
  snapshot(key) {
    const wallet = this.ensure(key);
    return {
      displayName: wallet.displayName,
      balance: {
        cents: wallet.balanceCents,
        credits: Number((wallet.balanceCents / 100).toFixed(2)),
        currency: wallet.currency
      },
      stats: {
        spinCount: wallet.spinCount,
        totalWageredCents: wallet.totalWageredCents,
        totalWonCents: wallet.totalWonCents
      }
    };
  }

  /** Descarta carteras caducadas y limita el crecimiento del Map. */
  evictIfNeeded_() {
    if (this.sessions.size <= this.maxSessions) return;

    const now = this.now();
    for (const [key, wallet] of this.sessions) {
      if (wallet.expiresAt <= now) this.sessions.delete(key);
    }

    // Aun por encima del limite: se descartan las que expiran antes.
    while (this.sessions.size > Math.floor(this.maxSessions * 0.85)) {
      let oldestKey = null;
      let oldestExpiry = Infinity;
      for (const [key, wallet] of this.sessions) {
        if (wallet.expiresAt < oldestExpiry) {
          oldestExpiry = wallet.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      this.sessions.delete(oldestKey);
    }
  }

  /** Solo tests: vacia todas las carteras virtuales. */
  reset() {
    this.sessions.clear();
  }
}

/** Instancia unica usada por el backend (estado en memoria del proceso). */
const demoWallet = new DemoWallet();

module.exports = { DemoWallet, demoWallet, demoKeyFromSub, demoKeyFromRequest };
