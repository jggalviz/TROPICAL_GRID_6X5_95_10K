'use strict';

/**
 * Error de API con codigo estable. El cliente solo muestra `code` + `message`;
 * nunca se filtran trazas ni detalles internos de la base de datos.
 */
class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code = 'UNAUTHORIZED', message = 'Sesion no valida.') {
    return new ApiError(401, code, message);
  }

  static paymentRequired(code = 'INSUFFICIENT_FUNDS', message = 'Saldo insuficiente.') {
    return new ApiError(402, code, message);
  }

  static forbidden(code = 'FORBIDDEN', message = 'Operacion no permitida.') {
    return new ApiError(403, code, message);
  }

  static notFound(code = 'NOT_FOUND', message = 'Recurso no encontrado.') {
    return new ApiError(404, code, message);
  }

  static tooManyRequests(code = 'RATE_LIMITED') {
    return new ApiError(429, code, 'Demasiadas peticiones. Espera un instante.');
  }

  static internal(message = 'Error interno.') {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}

/**
 * Envuelve un handler async para que los rechazos lleguen al error handler
 * de Express (Express 4 no captura promesas rechazadas por si solo).
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { ApiError, asyncHandler };
