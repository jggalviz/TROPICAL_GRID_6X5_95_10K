'use strict';

/**
 * Configuracion central del backend.
 * Se valida al arrancar: si falta algo critico en produccion, el proceso no
 * levanta (fail-fast) en lugar de arrancar en un estado inseguro.
 */

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

function str(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  return raw.trim();
}

function int(name, fallback) {
  const raw = str(name);
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name, fallback) {
  const raw = str(name).toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function list(name, fallback) {
  const raw = str(name);
  if (raw === '') return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

const SUPABASE_URL = str('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = str('SUPABASE_SERVICE_ROLE_KEY');
const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const SESSION_SECRET = str('SESSION_SECRET');
const ALLOW_DEV_SESSION = bool('ALLOW_DEV_SESSION', !IS_PRODUCTION);

/**
 * Modo "Fichas de Prueba" (jugar gratis).
 *
 * No es una sesion de jugador real: el backend emite un token firmado con el
 * claim `demo: true` y liquida las rondas en una cartera VIRTUAL en memoria.
 * Nunca se escribe en la base de datos de Supabase ni se mueve dinero real.
 */
const DEMO_MODE_ENABLED = bool('DEMO_MODE_ENABLED', true);
const DEMO_START_BALANCE_CENTS = int('DEMO_START_BALANCE_CENTS', 100000); // 1.000,00
const DEMO_SESSION_TTL_MS = int('DEMO_SESSION_TTL_MS', 30 * 60 * 1000);
const DEMO_TOKEN_TTL_SECONDS = int('DEMO_TOKEN_TTL_SECONDS', 2 * 60 * 60);
const DEMO_MAX_SESSIONS = int('DEMO_MAX_SESSIONS', 2000);
const DEMO_MAX_IDEMPOTENT_ROUNDS = int('DEMO_MAX_IDEMPOTENT_ROUNDS', 5);

/**
 * Driver de persistencia:
 *   - "supabase": produccion (debito/credito atomico via RPC).
 *   - "memory":   solo desarrollo local; el saldo vive en RAM y se pierde al
 *                 reiniciar. Se activa automaticamente si no hay credenciales.
 */
const DB_DRIVER = str('DB_DRIVER', supabaseConfigured ? 'supabase' : 'memory');

const problems = [];

if (DB_DRIVER === 'supabase' && !supabaseConfigured) {
  problems.push('DB_DRIVER=supabase requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY');
}
if (DB_DRIVER === 'memory' && IS_PRODUCTION) {
  problems.push('DB_DRIVER=memory esta prohibido con NODE_ENV=production');
}
if (DB_DRIVER === 'supabase' && /^https?:\/\/.*\.supabase\.co\/?$/.test(SUPABASE_URL) === false) {
  problems.push('SUPABASE_URL no parece una URL de proyecto valida');
}
if (!/^[0-9a-f]{64}$/i.test(SESSION_SECRET)) {
  problems.push('SESSION_SECRET debe ser hexadecimal de 64 caracteres (32 bytes)');
}
if (IS_PRODUCTION && ALLOW_DEV_SESSION) {
  problems.push('ALLOW_DEV_SESSION debe ser false en produccion (el token debe venir de tu IdP)');
}
if (DEMO_MODE_ENABLED && DEMO_START_BALANCE_CENTS <= 0) {
  problems.push('DEMO_START_BALANCE_CENTS debe ser un entero positivo');
}
if (DEMO_MODE_ENABLED && (DEMO_SESSION_TTL_MS < 60000 || DEMO_TOKEN_TTL_SECONDS < 60)) {
  problems.push('El TTL del modo demo es demasiado corto (minimo 60 s de sesion y de token)');
}
if (DEMO_MAX_SESSIONS < 1 || DEMO_MAX_IDEMPOTENT_ROUNDS < 1) {
  problems.push('DEMO_MAX_SESSIONS y DEMO_MAX_IDEMPOTENT_ROUNDS deben ser >= 1');
}

if (problems.length > 0) {
  const message = `Configuracion invalida:\n  - ${problems.join('\n  - ')}`;
  if (IS_PRODUCTION || process.env.NODE_ENV === 'test') {
    throw new Error(message);
  }
  // En desarrollo se avisa pero se permite continuar con valores por defecto.
  // eslint-disable-next-line no-console
  console.warn(`[config] ${message}`);
}

const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  port: int('PORT', 3000),
  allowedOrigins: list('ALLOWED_ORIGINS', ['http://localhost:3000', 'http://127.0.0.1:3000']),
  db: Object.freeze({
    driver: DB_DRIVER,
    supabaseUrl: SUPABASE_URL,
    supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
    schema: str('SUPABASE_SCHEMA', 'public')
  }),
  session: Object.freeze({
    secret: SESSION_SECRET,
    ttlSeconds: int('SESSION_TTL_SECONDS', 3600),
    allowDevSession: ALLOW_DEV_SESSION,
    devDemoPlayerId: str('DEV_DEMO_PLAYER_ID', '00000000-0000-4000-8000-000000000001')
  }),
  demo: Object.freeze({
    enabled: DEMO_MODE_ENABLED,
    guestId: str('DEMO_GUEST_ID', 'invitado_demo'),
    guestName: str('DEMO_GUEST_NAME', 'Invitado Demo'),
    currency: str('DEMO_CURRENCY', 'VES'),
    startBalanceCents: DEMO_START_BALANCE_CENTS,
    sessionTtlMs: DEMO_SESSION_TTL_MS,
    tokenTtlSeconds: DEMO_TOKEN_TTL_SECONDS,
    maxSessions: DEMO_MAX_SESSIONS,
    maxIdempotentRounds: DEMO_MAX_IDEMPOTENT_ROUNDS
  }),
  limits: Object.freeze({
    maxExposureMultiplier: int('MAX_EXPOSURE_MULTIPLIER', 10000),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 1000),
    rateLimitMaxRequests: int('RATE_LIMIT_MAX_REQUESTS', 12),
    maxBodyBytes: str('MAX_BODY_BYTES', '8kb'),
    idempotencyTtlMs: int('IDEMPOTENCY_TTL_MS', 10 * 60 * 1000)
  })
});

module.exports = config;
