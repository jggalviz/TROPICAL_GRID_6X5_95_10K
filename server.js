'use strict';

/**
 * ============================================================================
 *  ENTRY POINT PARA VERCEL (preset "Express")
 * ============================================================================
 *  Vercel detecta `server.js` en la raiz del repositorio y despliega la app
 *  Express como UNA sola Vercel Function:
 *
 *    - public/src/** -> CDN (CSS/JS)
 *    - `/`           -> esta funcion (HTML generado desde public/index.html)
 *    - /api/**       -> esta funcion
 *
 *  En local NO se usa: `npm start` ejecuta `server/index.js`, que abre un
 *  puerto real con timeouts y apagado ordenado. Aqui solo se exporta la app,
 *  que es lo que exige Vercel.
 *
 *  IMPORTANTE: el builder `@vercel/express` inspecciona ESTE archivo buscando
 *  `require('express')` para detectar el entrypoint. No basta con exigir
 *  `./server/app`; por eso `express` se importa aqui y se usa en el fallback.
 *
 *  Si la configuracion es invalida (falta SESSION_SECRET, Supabase, etc.) se
 *  responde 503 con un mensaje accionable en lugar de un 500 opaco; el detalle
 *  completo queda en los Runtime Logs del despliegue.
 * ============================================================================
 */

const express = require('express');

let app;

try {
  const { createApp } = require('./server/app');
  // En Vercel el CDN sirve public/src/**; la funcion solo atiende `/` y /api/*.
  app = createApp({ staticDir: null });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('[vercel] La aplicacion no pudo inicializarse:', detail);

  const fallback = express();
  fallback.disable('x-powered-by');
  fallback.use((req, res) => {
    res.status(503).set('Cache-Control', 'no-store').json({
      ok: false,
      error: {
        code: 'CONFIG_INVALID',
        message:
          'El servidor no esta configurado. Define SESSION_SECRET, SUPABASE_URL y ' +
          'SUPABASE_SERVICE_ROLE_KEY en Vercel (ver docs/DEPLOY_VERCEL.md).'
      }
    });
  });
  app = fallback;
}

module.exports = app;
