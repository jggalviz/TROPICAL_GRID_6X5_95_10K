/**
 * Gestion de la sesion del cliente.
 *
 * Prioridad:
 *   1. Token en la URL (`?token=` o `#token=`) -> se guarda y se borra de la barra.
 *   2. Token en localStorage (sobrevive al cierre de la pestaña). Los tokens de
 *      versiones anteriores guardados en sessionStorage se migran solos.
 *   3. Sin token -> modo "Fichas de Prueba" AUTOMATICO: se pide un token de
 *      invitado a POST /api/demo/session (claim `demo: true`) y el juego queda
 *      listo para girar con saldo virtual, sin modal ni interaccion previa.
 *
 * Solo si el operador desactiva el modo demo (DEMO_DISABLED) se recurre a
 * POST /api/session (desarrollo, ALLOW_DEV_SESSION=true) y, en ultimo termino,
 * al error SESSION_REQUIRED que muestra la puerta manual de token.
 */

import { ApiError } from './apiClient.js';

const STORAGE_KEY = 'tg65.session.v1';

/**
 * `localStorage` es la fuente principal (la sesion sobrevive a la pestaña);
 * `sessionStorage` solo se usa para migrar tokens de versiones anteriores.
 */
function safeStorage(kind = 'local') {
  try {
    const storage = kind === 'session' ? window.sessionStorage : window.localStorage;
    if (!storage) return null;
    const probe = '__tg65__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function parseStoredToken(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string') return null;
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

export function readStoredToken() {
  const stored = parseStoredToken(safeStorage('local'));
  if (stored) return stored;

  /* Compatibilidad: versiones previas guardaban el token en sessionStorage. */
  const legacyStorage = safeStorage('session');
  const legacy = parseStoredToken(legacyStorage);
  if (!legacy) return null;

  storeToken(legacy);
  try {
    legacyStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignorado */
  }
  return legacy;
}

export function storeToken(token, expiresAt = null) {
  const local = safeStorage('local');
  if (!local) return;
  try {
    local.setItem(STORAGE_KEY, JSON.stringify({ token, expiresAt }));
    const legacyStorage = safeStorage('session');
    if (legacyStorage) legacyStorage.removeItem(STORAGE_KEY);
  } catch {
    /* almacenamiento lleno o bloqueado: se sigue en memoria */
  }
}

export function clearToken() {
  for (const kind of ['local', 'session']) {
    const storage = safeStorage(kind);
    if (!storage) continue;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* ignorado */
    }
  }
}

/** Extrae y limpia el token de la URL (no se deja en el historial). */
export function takeTokenFromUrl() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token') || new URLSearchParams(url.hash.replace(/^#/, '')).get('token');
  if (!token) return null;

  url.searchParams.delete('token');
  if (url.hash) {
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    hashParams.delete('token');
    const hash = hashParams.toString();
    url.hash = hash ? `#${hash}` : '';
  }
  window.history.replaceState({}, '', url.toString());
  return token;
}

/** El operador desactivo las fichas de prueba (o el servidor las prohibe). */
function isDemoDisabled(error) {
  return error instanceof ApiError && (error.code === 'DEMO_DISABLED' || error.status === 403);
}

export class SessionManager {
  constructor(api) {
    this.api = api;
    this.token = null;
    this.player = null;
    this.source = null;
    this.demoPayload = null;
    /* true = token de invitado (Fichas de Prueba), no de jugador real. */
    this.isDemo = false;
  }

  /** Token actual, o null si todavia no hay sesion. */
  current() {
    return this.token;
  }

  setToken(token, source = 'manual') {
    this.token = token || null;
    this.source = source;
    this.isDemo = source === 'demo';
    if (token) storeToken(token);
    return this.token;
  }

  /**
   * Resuelve credenciales sin llamar aun a /api/player.
   *
   * Sin token en la URL ni en localStorage NO se lanza SESSION_REQUIRED: se
   * abre una sesion de "Fichas de Prueba" para que el juego arranque listo.
   *
   * @returns {Promise<{ token: string, source: string, player: object|null }>}
   */
  async resolve() {
    const fromUrl = takeTokenFromUrl();
    if (fromUrl) {
      this.setToken(fromUrl, 'url');
      return { token: fromUrl, source: 'url', player: null };
    }

    const stored = readStoredToken();
    if (stored) {
      this.setToken(stored, 'storage');
      return { token: stored, source: 'storage', player: null };
    }

    return this.resolveDefaultSession();
  }

  /**
   * Sesion por defecto cuando no hay token: modo prueba automatico.
   *
   * El backend emite un token `demo: true` y una cartera virtual (1.000,00 VES),
   * asi que la maquina queda lista para girar sin pedir nada al jugador.
   *
   * Solo si el operador desactivo el modo demo (DEMO_DISABLED) se intenta la
   * sesion de desarrollo; si tampoco esta disponible, el SESSION_REQUIRED sube
   * al arranque y la puerta manual de token sigue siendo el ultimo recurso.
   *
   * @returns {Promise<{ token: string, source: string, player: object|null }>}
   */
  async resolveDefaultSession() {
    try {
      const payload = await this.startDemoSession();
      return { token: payload.token, source: 'demo', player: this.player };
    } catch (error) {
      if (!isDemoDisabled(error)) throw error;
      return this.requestDevSession();
    }
  }

  async requestDevSession(playerId) {
    let payload;
    try {
      payload = await this.api.createSession(playerId);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'DEV_SESSION_DISABLED' || error.status === 403)) {
        throw new ApiError({
          code: 'SESSION_REQUIRED',
          message: 'Este servidor no emite sesiones. Introduce un token válido.',
          status: 403,
          kind: 'http'
        });
      }
      throw error;
    }

    this.setToken(payload.token, 'dev');
    this.player = payload.player || null;
    return { token: payload.token, source: 'dev', player: this.player };
  }

  /**
   * Abre una sesion temporal de invitado para "Fichas de Prueba".
   *
   * No requiere token de usuario real: el backend emite uno propio con el claim
   * `demo: true` y una cartera virtual (1.000,00 VES por defecto). El saldo SIEMPRE
   * lo calcula el servidor; `payload.balance` es solo la foto inicial.
   *
   * @param {string} [alias]  alias de invitado (`invitado_demo` por defecto)
   * @returns {Promise<object>} payload de /api/demo/session
   */
  async startDemoSession(alias = 'invitado_demo') {
    const payload = await this.api.createDemoSession(alias);
    this.setToken(payload.token, 'demo');
    this.player = payload.player || null;
    this.demoPayload = payload;
    return payload;
  }

  /** Descarta la sesion actual (token caducado, cambio de jugador...). */
  invalidate() {
    this.token = null;
    this.player = null;
    this.demoPayload = null;
    this.isDemo = false;
    clearToken();
  }
}
