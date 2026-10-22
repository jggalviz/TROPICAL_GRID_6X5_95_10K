'use strict';

/**
 * Limitador de peticiones de ventana deslizante en memoria.
 *
 * Suficiente para una instancia unica; si el backend se escala horizontalmente,
 * sustituir por Redis (misma interfaz: consume(key) -> { allowed, retryAfterMs }).
 *
 * Se aplica por jugador (no por IP) para que un mismo usuario no pueda inundar
 * el motor con peticiones paralelas que compitan por el saldo.
 */

const config = require('../config');

class SlidingWindowRateLimiter {
  constructor({ windowMs, maxRequests, maxKeys = 50000 } = {}) {
    this.windowMs = windowMs || config.limits.rateLimitWindowMs;
    this.maxRequests = maxRequests || config.limits.rateLimitMaxRequests;
    this.maxKeys = maxKeys;
    this.buckets = new Map(); // key -> number[] (timestamps ms)
  }

  /** @returns {{ allowed: boolean, retryAfterMs: number, remaining: number }} */
  consume(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    let hits = this.buckets.get(key);
    if (!hits) {
      hits = [];
      this.buckets.set(key, hits);
    }

    // Elimina marcas fuera de la ventana.
    let expired = 0;
    while (expired < hits.length && hits[expired] <= cutoff) expired += 1;
    if (expired > 0) hits.splice(0, expired);

    if (hits.length >= this.maxRequests) {
      const oldest = hits[0];
      return {
        allowed: false,
        retryAfterMs: Math.max(1, oldest + this.windowMs - now),
        remaining: 0
      };
    }

    hits.push(now);
    this.evictIfNeeded();
    return { allowed: true, retryAfterMs: 0, remaining: this.maxRequests - hits.length };
  }

  /** Poda simple para que el Map no crezca sin control. */
  evictIfNeeded() {
    if (this.buckets.size <= this.maxKeys) return;
    const now = Date.now();
    for (const [key, hits] of this.buckets) {
      if (hits.length === 0 || hits[hits.length - 1] <= now - this.windowMs) this.buckets.delete(key);
      if (this.buckets.size <= this.maxKeys * 0.8) break;
    }
  }

  reset() {
    this.buckets.clear();
  }
}

/** Middleware de Express: limita por jugador autenticado o, si no hay, por IP. */
function createRateLimitMiddleware(limiter = new SlidingWindowRateLimiter()) {
  return function rateLimit(req, res, next) {
    const key = (req.player && req.player.id) || req.ip || 'anonymous';
    const result = limiter.consume(key);
    res.setHeader('X-RateLimit-Limit', String(limiter.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      const err = new Error('RATE_LIMITED');
      err.status = 429;
      err.code = 'RATE_LIMITED';
      return next(err);
    }
    return next();
  };
}

module.exports = { SlidingWindowRateLimiter, createRateLimitMiddleware };
