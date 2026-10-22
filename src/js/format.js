/**
 * Metadatos de simbolos y formateo. Nada de logica de juego: el cliente solo
 * pinta lo que recibe del servidor.
 */

export const SYMBOLS = Object.freeze({
  S1: { glyph: '🍋', name: 'Limón' },
  S2: { glyph: '🍈', name: 'Melón' },
  S3: { glyph: '🍉', name: 'Sandía' },
  S4: { glyph: '🍍', name: 'Piña' },
  S5: { glyph: '🥥', name: 'Coco' },
  S6: { glyph: '🍌', name: 'Plátano' },
  S7: { glyph: '🥝', name: 'Kiwi' },
  S8: { glyph: '🍇', name: 'Uvas' },
  S9: { glyph: '💎', name: 'Diamante' },
  SC: { glyph: '🌺', name: 'Flor (scatter)' },
  MX: { glyph: '💣', name: 'Bomba' }
});

export const SYMBOL_KEYS = Object.freeze(['S9', 'S8', 'S7', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1']);

const CREDIT_FORMAT = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const PLAIN_FORMAT = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

/** Centimos enteros -> "1.234,56" */
export function formatCents(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return '0,00';
  return CREDIT_FORMAT.format(value / 100);
}

/** Creditos (numero con decimales) -> "1.234,56" */
export function formatCredits(credits) {
  const value = Number(credits);
  if (!Number.isFinite(value)) return '0,00';
  return CREDIT_FORMAT.format(value);
}

/** Numero generico sin ceros forzados. */
export function formatPlain(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return PLAIN_FORMAT.format(n);
}

export function formatMultiplier(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${PLAIN_FORMAT.format(n)}×`;
}

export function formatPercent(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)} %`;
}

export function symbolMeta(symbol) {
  return SYMBOLS[symbol] || { glyph: '❔', name: symbol || '—' };
}

/** Celda -> clave de celda usada por las animaciones. */
export function cellKey(r, c, cols = 6) {
  return r * cols + c;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

/** Identificador de ronda para la clave de idempotencia (32 hex). */
export function makeRoundRef() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Semilla informativa del cliente (ASCII imprimible, max 64). */
export function makeClientSeed() {
  return makeRoundRef().slice(0, 24);
}
