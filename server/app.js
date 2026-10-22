'use strict';

/**
 * ============================================================================
 *  APLICACION EXPRESS
 * ============================================================================
 *  Separada de `index.js` para poder instanciarla en los tests sin abrir
 *  puertos.
 *
 *  Superficie publica:
 *    - Indice:    `/` sirve `server/generated/indexHtml.js`, generado desde
 *                 `public/index.html` en build. No depende del routing del CDN.
 *    - Estaticos: public/ completo en local; en Vercel el CDN publica
 *                 `public/src/**` y la funcion no los sirve.
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
const { INDEX_HTML } = require('./generated/indexHtml');
const { ApiError } = require('./errors');
const { createGameRoutes } = require('./routes/game');
const { createSessionRoutes } = require('./routes/session');
const {
  SlidingWindowRateLimiter,
  createRateLimitMiddleware
} = require('./middleware/rateLimit');

const ROOT_DIR = path.join(__dirname, '..');
/* Unico arbol estatico permitido: el CDN publica `public/**`. */
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/**
 * Crea la app Express.
 *
 * @param {object} [options]
 * @param {object} [options.rateLimit]     limitador compartido (tests)
 * @param {boolean} [options.logRequests]  log de acceso por peticion
 * @param {string|null} [options.staticDir] arbol estatico local. En Vercel es
 *   `null`: el CDN sirve `public/src/**` y la funcion no debe trazarlo.
 */
function createApp(options = {}) {
  const app = express();
  const rateLimit = options.rateLimit || new SlidingWindowRateLimiter();
  const staticDir = options.staticDir || null;

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

  /* --- Indice del juego ---
     Se sirve desde `server/generated/indexHtml.js`, que `npm run build:index`
     genera a partir de `public/index.html`. Asi `/` funciona aunque el CDN no
     resuelva el directorio raiz y la funcion no necesita `public/` en Vercel
     (donde `staticDir` es `null`). */
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(INDEX_HTML);
  });

  /* --- Front-end local (solo cliente visual) ---
     En local `staticDir` es `public/`: sirve index.html y src/**. En Vercel es
     `null`; el CDN publica `public/src/**` y esta funcion solo atiende `/` y
     `/api/*`. Evitamos `res.sendFile(...)`: no hace falta y complica el
     trazado de assets de NFT. */
  if (staticDir) {
    app.use(
      express.static(staticDir, {
        index: 'index.html',
        dotfiles: 'ignore',
        /* Los assets no llevan hash en el nombre: se revalida siempre (304 si no
           cambian) para que un despliegue nuevo no quede oculto tras la cache. */
        maxAge: 0,
        setHeaders(res, filePath) {
          const ext = path.extname(filePath).toLowerCase();
          if (ext === '.html' || ext === '.js' || ext === '.css') {
            res.setHeader('Cache-Control', 'no-cache');
          }
        }
      })
    );
  }

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
