'use strict';

/**
 * ============================================================================
 *  APLICACION EXPRESS
 * ============================================================================
 *  Separada de `index.js` para poder instanciarla en los tests sin abrir
 *  puertos.
 *
 *  Superficie publica:
 *    - Estaticos: /  (index.html), /src (JS+CSS), /assets
 *    - API:       /api/*  (JSON, sin cache)
 *
 *  No se sirve NADA del backend: `server/`, `scripts/`, `sql/` y `.env`
 *  quedan fuera del arbol estatico a proposito.
 * ============================================================================
 */

const path = require('node:path');
const crypto = require('node:crypto');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const config = require('./config');
const { ApiError } = require('./errors');
const { createGameRoutes } = require('./routes/game');
const { createSessionRoutes } = require('./routes/session');
const {
  SlidingWindowRateLimiter,
  createRateLimitMiddleware
} = require('./middleware/rateLimit');

const ROOT_DIR = path.join(__dirname, '..');

function createApp(options = {}) {
  const app = express();
  const rateLimit = options.rateLimit || new SlidingWindowRateLimiter();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  /* --- Cabeceras de seguridad --- */
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"]
        }
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' }
    })
  );

  /* --- CORS restringido a los origenes configurados --- */
  app.use(
    cors({
      origin(origin, callback) {
        // Sin Origin = mismo origen / peticiones servidor-a-servidor.
        if (!origin) return callback(null, true);
        if (config.allowedOrigins.includes(origin)) return callback(null, true);
        return callback(ApiError.forbidden('CORS_FORBIDDEN', 'Origen no permitido.'));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'Retry-After'],
      credentials: false,
      maxAge: 600
    })
  );

  app.use(compression());
  app.use(express.json({ limit: config.limits.maxBodyBytes }));

  /* --- Id de peticion + log de acceso --- */
  const logRequests = options.logRequests !== false;
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    if (!logRequests) return next();
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // eslint-disable-next-line no-console
      console.log(
        `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms ${req.id}`
      );
    });
    return next();
  });

  /* --- API --- */
  app.use('/api', createSessionRoutes({ rateLimit }));
  app.use('/api', createGameRoutes({ rateLimit }));

  /* --- Front-end (solo cliente visual) --- */
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
  });
  app.use(
    '/src',
    express.static(path.join(ROOT_DIR, 'src'), {
      index: false,
      dotfiles: 'ignore',
      maxAge: config.isProduction ? '1h' : 0
    })
  );
  app.use(
    '/assets',
    express.static(path.join(ROOT_DIR, 'assets'), {
      index: false,
      dotfiles: 'ignore',
      maxAge: config.isProduction ? '24h' : 0
    })
  );

  /* --- 404 --- */
  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Recurso no encontrado.' }
    });
  });

  /* --- Error handler (unico punto de salida de errores) --- */
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    let status = Number.isInteger(error && error.status) ? error.status : 500;
    let code = (error && error.code) || 'INTERNAL_ERROR';
    let message = (error && error.message) || 'Error interno.';

    // Body JSON malformado (express.json)
    if (error && error.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'El cuerpo de la peticion no es JSON valido.';
    }
    if (error && error.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Cuerpo de peticion demasiado grande.';
    }
    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error(`[error] ${req.id} ${code}:`, (error && error.cause) || error);
      message = 'Error interno del servidor.';
    }

    if (res.headersSent) return next(error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({
      ok: false,
      error: { code, message, requestId: req.id }
    });
  });

  return app;
}

module.exports = { createApp, createRateLimitMiddleware, ROOT_DIR };
