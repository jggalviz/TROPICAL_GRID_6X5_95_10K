/**
 * Cliente HTTP del juego.
 *
 * Reglas:
 *  - Todas las acciones de juego son POST (nunca GET) para que no puedan
 *    cachearse ni dispararse desde un enlace.
 *  - El token viaja en `Authorization: Bearer ...`; jamas en la URL.
 *  - Cada peticion tiene timeout y una clasificacion de error comun.
 */

export class ApiError extends Error {
  constructor({ code = 'NETWORK_ERROR', message = 'Error de red.', status = 0, details = null, requestId = null, kind = 'http' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
    this.kind = kind; // 'http' | 'network' | 'timeout' | 'parse'
  }

  get isAuth() {
    return this.status === 401;
  }

  get isRetryable() {
    return this.kind === 'network' || this.kind === 'timeout' || this.status === 429 || this.status >= 500;
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

export class ApiClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] prefijo ('' = mismo origen)
   * @param {() => (string|null)} [options.getToken]
   */
  constructor({ baseUrl = '', getToken = () => null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = baseUrl;
    this.getToken = getToken;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { body, timeoutMs, headers = {} } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);

    const finalHeaders = { Accept: 'application/json', ...headers };
    const token = this.getToken();
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new ApiError({ code: 'TIMEOUT', message: 'El servidor tardó demasiado en responder.', kind: 'timeout' });
      }
      throw new ApiError({ code: 'NETWORK_ERROR', message: 'No hay conexión con el servidor.', kind: 'network' });
    } finally {
      clearTimeout(timeout);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const info = (payload && payload.error) || {};
      throw new ApiError({
        code: info.code || `HTTP_${response.status}`,
        message: info.message || `Error HTTP ${response.status}.`,
        status: response.status,
        requestId: info.requestId || response.headers.get('X-Request-Id'),
        details: info.details || null,
        kind: 'http'
      });
    }

    if (!payload) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Respuesta no válida del servidor.', status: response.status, kind: 'parse' });
    }

    return payload;
  }

  health() {
    return this.request('GET', '/api/health');
  }

  gameInfo() {
    return this.request('GET', '/api/game');
  }

  player() {
    return this.request('GET', '/api/player');
  }

  createSession(playerId) {
    const body = {};
    if (playerId) body.playerId = playerId;
    return this.request('POST', '/api/session', { body });
  }

  /**
   * Resuelve una ronda. `roundRef` es obligatorio para que un reintento no
   * pueda cobrar dos veces.
   */
  spin({ betCents, buyFeature = false, roundRef, clientSeed }) {
    const body = { betCents, buyFeature };
    if (roundRef) body.roundRef = roundRef;
    if (clientSeed) body.clientSeed = clientSeed;
    return this.request('POST', '/api/spin', { body });
  }
}
