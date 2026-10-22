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
const STYLE_PATH = path.join(PUBLIC_DIR, 'src', 'css', 'style.css');
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
  assert.match(html, /width="240" height="240"/, 'El logo debe reservar 240x240 px como maximo');
});

test('la capa candyland mantiene el tablero protagonista y los caramelos grandes', () => {
  const css = read(STYLE_PATH);

  assert.match(
    css,
    /\.machine__logo\s*\{[^}]*max-width:\s*min\(240px,\s*42vw\);[^}]*max-height:\s*110px;[^}]*\}/,
    'El logo debe quedar acotado a 240x110 px como maximo'
  );
  assert.match(
    css,
    /\.tile__img\s*\{[^}]*width:\s*85%;[^}]*height:\s*85%;[^}]*object-fit:\s*contain;[^}]*\}/,
    'Los caramelos deben ocupar el 85% de la casilla'
  );
  assert.match(css, /linear-gradient\(155deg,\s*#8be8ff/, 'El fondo debe ser candyland azul/rosa');
  assert.doesNotMatch(css, /#0b1a13|#0f261c/i, 'No deben quedar fondos verde oscuro');
});

test('la maquina completa cabe en el viewport sin scroll vertical', () => {
  const css = read(STYLE_PATH);

  assert.match(
    css,
    /html\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;[^}]*\}/,
    'html debe fijar el alto del viewport y bloquear el scroll'
  );
  assert.match(
    css,
    /\.app\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*\}/,
    'El contenedor principal debe medir 100dvh sin desbordar'
  );
  assert.match(
    css,
    /\.machine\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*\}/,
    'La maquina debe poder encogerse para ceder alto al tablero'
  );
  assert.match(
    css,
    /\.board\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/,
    'El tablero debe ser el bloque flexible del layout'
  );
  assert.match(
    css,
    /\.grid\s*\{[^}]*aspect-ratio:\s*6\s*\/\s*5;/,
    'La cuadricula 6x5 debe conservar su proporcion'
  );
});

test('el escalado del tablero y las casillas se adapta al alto disponible', () => {
  const css = read(STYLE_PATH);

  assert.match(
    css,
    /\.stage\s*\{[^}]*min-height:\s*0;[^}]*\}/,
    'El escenario debe poder encogerse para no empujar contenido fuera'
  );
  assert.match(
    css,
    /\.grid\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*aspect-ratio:\s*6\s*\/\s*5;/,
    'La cuadricula debe poder encogerse y conservar su proporcion'
  );
  assert.match(
    css,
    /\.tile\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*\}/,
    'Cada casilla debe llenar su celda sin desbordar'
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.board\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-height:\s*0;/,
    'En movil el tablero abraza la cuadricula y puede encogerse'
  );
  assert.match(
    css,
    /width:\s*min\(100%,\s*calc\(\(100dvh - var\(--board-chrome\)\)\s*\*\s*6\s*\/\s*5\)\)/,
    'El ancho del tablero debe combinar el ancho y el alto disponibles'
  );
  assert.match(
    css,
    /@media \(max-height: 660px\)\s*\{\s*\.machine__hero\s*\{\s*display:\s*none;\s*\}/,
    'En alturas cortas el logo desaparece para ceder alto al tablero'
  );
  assert.match(
    css,
    /\.controls\s*\{[^}]*flex-shrink:\s*1;[^}]*min-height:\s*0;/,
    'Los controles deben poder comprimirse dentro de la maquina'
  );
});
