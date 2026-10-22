/**
 * Gestion de la sesion del cliente.
 *
 * Prioridad:
 *   1. Token en la URL (`?token=` o `#token=`) -> se guarda y se borra de la barra.
 *   2. Token en sessionStorage (sobrevive a recargas de la pestaña).
 *   3. POST /api/session (solo si el backend tiene ALLOW_DEV_SESSION=true).
 *
 * En produccion el paso 3 responde 403 y el jugador debe entrar con el token
 * emitido por el IdP del operador.
 */

import { ApiError } from './apiClient.js';

const STORAGE_KEY = 'tg65.session.v1';

function safeStorage() {
  try {
    const probe = '__tg65__';
    window.sessionStorage.setItem(probe, '1');
    window.sessionStorage.removeItem(probe);
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredToken() {
  const storage = safeStorage();
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

export function storeToken(token, expiresAt = null) {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ token, expiresAt }));
  } catch {
    /* almacenamiento lleno o bloqueado: se sigue en memoria */
  }
}

export function clearToken() {
  const storage = safeStorage();
  if (storage) {
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

export class SessionManager {
  constructor(api) {
    this.api = api;
    this.token = null;
    this.player = null;
    this.source = null;
  }

  /** Token actual, o null si todavia no hay sesion. */
  current() {
    return this.token;
  }

  setToken(token, source = 'manual') {
    this.token = token || null;
    this.source = source;
    if (token) storeToken(token);
    return this.token;
  }

  /**
   * Resuelve credenciales sin llamar aun a /api/player.
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

    return this.requestDevSession();
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

  /** Descarta la sesion actual (token caducado, cambio de jugador...). */
  invalidate() {
    this.token = null;
    this.player = null;
    clearToken();
  }
}
