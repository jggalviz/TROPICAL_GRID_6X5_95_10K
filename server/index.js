'use strict';

/**
 * Punto de entrada del backend.
 *
 *   npm start          -> http://localhost:3000
 *   NODE_ENV=production npm start
 *
 * Arranque fail-fast: si la configuracion es insegura, `config.js` lanza y el
 * proceso no levanta.
 */

const config = require('./config');
const engine = require('./engine/gridEngine');
const store = require('./db');
const { createApp } = require('./app');

function banner(port) {
  const rtp = (engine.CERTIFIED_RTP.base * 100).toFixed(2);
  const rtpFeature = (engine.CERTIFIED_RTP.feature * 100).toFixed(2);
  return [
    '',
    '============================================================',
    `  ${engine.GAME_CODE}  v${engine.ENGINE_VERSION}`,
    `  Paytable ${engine.PAYTABLE_VERSION}`,
    `  RTP certificado: base ${rtp}% | bonus ${rtpFeature}%`,
    `  Persistencia: ${store.driver}${store.driver === 'memory' ? '  (SOLO DESARROLLO)' : ''}`,
    `  Escuchando en http://localhost:${port}`,
    '============================================================',
    ''
  ].join('\n');
}

function bootstrap() {
  if (store.driver === 'memory') {
    // eslint-disable-next-line no-console
    console.warn(
      '[arranque] Driver en MEMORIA: los saldos se pierden al reiniciar. ' +
        'Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para persistencia real.'
    );
    if (typeof store.ensureDemoPlayer === 'function') {
      store.ensureDemoPlayer({
        id: config.session.devDemoPlayerId,
        externalId: 'demo',
        displayName: 'Demo Player',
        balanceCents: 100000
      });
    }
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(banner(config.port));
  });

  // Timeouts defensivos (slowloris).
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`\n[${signal}] cerrando servidor...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[unhandledRejection]', reason);
  });

  return server;
}

if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap };
