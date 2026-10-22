'use strict';

/**
 * ============================================================================
 *  APLICACION EXPRESS
 * ============================================================================
 *  Separada de `index.js` para poder instanciarla en los tests sin abrir
 *  puertos.
 *
 *  Superficie publica:
 *    - Estaticos: public/  (index.html, src/, assets/)
 *      En Vercel los publica el CDN; en local los sirve este mismo proceso.
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
/* Unico arbol estatico permitido: en Vercel `public/**` se publica en el CDN. */
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

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

  /* --- CORS restringido: origenes configurados + mismo origen --- */
  const corsBase = {
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'Retry-After'],
    credentials: false,
    maxAge: 600
  };

  app.use((req, res, next) =>
    cors({
      ...corsBase,
      origin(origin, callback) {
        // Sin Origin = mismo origen / peticiones servidor-a-servidor.
        if (!origin) return callback(null, true);
        if (config.allowedOrigins.includes(origin)) return callback(null, true);
        // Mismo host que sirve la app (Vercel y previews, dominio propio, LAN):
        // el navegador no aplica CORS en mismo origen, asi que esto no amplia
        // la superficie y evita depender de ALLOWED_ORIGINS en cada despliegue.
        try {
          if (new URL(origin).host === req.get('host')) return callback(null, true);
        } catch {
          /* Origin malformado: se rechaza abajo. */
        }
        return callback(ApiError.forbidden('CORS_FORBIDDEN', 'Origen no permitido.'));
      }
    })(req, res, next)
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

  /* --- Front-end (solo cliente visual) ---
     Un unico arbol estatico: `public/`. En Vercel, ese directorio lo sirve el
     CDN y no llega a esta funcion; en local lo sirve este middleware. */
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      dotfiles: 'ignore',
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        // El HTML se revalida siempre; JS/CSS mantienen cache corta.
        if (path.extname(filePath).toLowerCase() === '.html') {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
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

module.exports = { createApp, createRateLimitMiddleware, ROOT_DIR, PUBLIC_DIR };
