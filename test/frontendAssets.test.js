'use strict';

/**
 * Contrato de assets del frontend.
 *
 * Los 20 caramelos viven en `public/src/assets/symbols`; el motor usa 11
 * simbolos y `format.js` es la unica fuente de verdad de su imagen. Esta
 * prueba evita que un renombrado o una ruta rota llegue a produccion.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SYMBOLS_DIR = path.join(PUBLIC_DIR, 'src', 'assets', 'symbols');
const FORMAT_PATH = path.join(PUBLIC_DIR, 'src', 'js', 'format.js');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
const LOGO_PATH = path.join(PUBLIC_DIR, 'src', 'assets', 'PANA-CRUSH-LOGO.png');

const read = (file) => fs.readFileSync(file, 'utf8');

test('los 20 caramelos estan en la carpeta limpia de simbolos', () => {
  for (let index = 1; index <= 20; index += 1) {
    const file = path.join(SYMBOLS_DIR, `candy_${index}.png`);
    assert.ok(fs.existsSync(file), `Falta ${path.relative(ROOT_DIR, file)}`);
    assert.ok(fs.statSync(file).size > 0, `${path.basename(file)} esta vacio`);
  }
});

test('los 11 simbolos del motor apuntan a imagenes existentes', () => {
  const source = read(FORMAT_PATH);
  const matches = [...source.matchAll(/image:\s*`\$\{SYMBOL_IMAGE_PATH\}([^`]+)`/g)];

  assert.equal(matches.length, 11, 'format.js debe mapear S1-S9, SC y MX');

  for (const [, fileName] of matches) {
    const file = path.join(SYMBOLS_DIR, fileName);
    assert.ok(fs.existsSync(file), `Simbolo sin asset: ${path.relative(ROOT_DIR, file)}`);
    assert.match(fileName, /^candy_\d+\.png$/, `Nombre de asset inesperado: ${fileName}`);
  }
});

test('el logo oficial se sirve y esta centrado sobre el tablero', () => {
  const html = read(INDEX_PATH);

  assert.ok(fs.existsSync(LOGO_PATH), 'Falta public/src/assets/PANA-CRUSH-LOGO.png');
  assert.match(html, /<div class="machine__hero">/);
  assert.match(html, /src="\/src\/assets\/PANA-CRUSH-LOGO\.png"/);
  assert.match(html, /alt="PANA CRUSH"/);
});
