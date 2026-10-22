'use strict';

/**
 * Entorno de test: DEBE importarse antes que cualquier modulo del backend
 * (config.js valida el entorno al cargarse).
 *
 *  - DB_DRIVER=memory  : sin red, sin Supabase, estado en RAM.
 *  - SESSION_SECRET    : 64 hex fijos para firmar/verificar en tests.
 */

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'memory';
process.env.ALLOW_DEV_SESSION = 'true';
process.env.SESSION_SECRET = '6f1d8b2a4c9e7053bd81f6a2e35c47890ab12de34f5c6057e8d9a1b2c3d4e5f6';
process.env.PORT = '3000';
process.env.RATE_LIMIT_WINDOW_MS = '1000';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

module.exports = {
  DEMO_PLAYER_ID: '00000000-0000-4000-8000-000000000001'
};
