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
const LOGO_PATH = path.join(PUBLIC_DIR, 'src', 'assets', 'PANA-CRUSH-LOGO.webp');

const read = (file) => fs.readFileSync(file, 'utf8');

/** Recorre los bloques de nivel superior de un contenedor RIFF/WebP. */
const webpChunks = (buffer) => {
  const chunks = [];
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const fourCC = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    chunks.push({ fourCC, offset, size });
    offset += 8 + size + (size % 2);
  }

  return chunks;
};

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

test('el logo animado se sirve ligero y esta centrado sobre el tablero', () => {
  const html = read(INDEX_PATH);

  assert.ok(fs.existsSync(LOGO_PATH), 'Falta public/src/assets/PANA-CRUSH-LOGO.webp');

  // El peso es parte del contrato: el GIF original pesaba 480 KB. Se exige un
  // WebP animado real (VP8X + ANIM + 5 ANMF) de bucle infinito y bajo 200 KB.
  const binary = fs.readFileSync(LOGO_PATH);
  assert.equal(binary.toString('ascii', 0, 4), 'RIFF', 'El logo debe ser un contenedor RIFF/WebP');
  assert.equal(binary.toString('ascii', 8, 12), 'WEBP', 'El logo debe ser un contenedor RIFF/WebP');

  const chunks = webpChunks(binary);
  assert.equal(chunks[0].fourCC, 'VP8X', 'El logo debe declarar caracteristicas extendidas (VP8X)');

  const anim = chunks.find((chunk) => chunk.fourCC === 'ANIM');
  assert.ok(anim, 'El logo debe declarar animacion (bloque ANIM)');
  assert.equal(binary.readUInt16LE(anim.offset + 12), 0, 'El bucle debe ser infinito (loop count 0)');

  const frames = chunks.filter((chunk) => chunk.fourCC === 'ANMF');
  assert.equal(frames.length, 5, 'El logo debe conservar los 5 fotogramas del GIF');

  assert.ok(
    binary.length < 200 * 1024,
    `El logo animado debe pesar menos de 200 KB (pesa ${(binary.length / 1024).toFixed(1)} KB)`
  );

  assert.match(html, /<div class="machine__hero">/);
  assert.match(html, /src="\/src\/assets\/PANA-CRUSH-LOGO\.webp"/);
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

test('el fondo ilustrado se sirve como WebP optimizado con el SVG de respaldo', () => {
  const css = read(STYLE_PATH);
  const webp = path.join(PUBLIC_DIR, 'src', 'assets', 'background.webp');
  const svg = path.join(PUBLIC_DIR, 'src', 'assets', 'background.svg');

  assert.ok(fs.existsSync(webp), 'Falta public/src/assets/background.webp');
  const size = fs.statSync(webp).size;
  assert.ok(size > 0, 'background.webp esta vacio');
  assert.ok(size < 400 * 1024, `background.webp pesa ${(size / 1024).toFixed(1)} KB (objetivo < 400 KB)`);
  assert.equal(
    fs.readFileSync(webp).subarray(0, 4).toString('ascii'),
    'RIFF',
    'background.webp debe ser un contenedor RIFF'
  );
  assert.equal(
    fs.readFileSync(webp).subarray(8, 12).toString('ascii'),
    'WEBP',
    'background.webp debe ser un WebP real'
  );
  assert.ok(fs.existsSync(svg), 'El SVG original debe quedar como respaldo');
  assert.ok(
    !fs.existsSync(path.join(PUBLIC_DIR, 'src', 'fondo_candy_paisaje_v2.svg')),
    'El fondo no debe quedar duplicado fuera de assets/'
  );
  assert.match(
    css,
    /body\s*\{[^}]*background:\s*url\('\.\.\/assets\/background\.webp'\)\s*center center \/ cover no-repeat fixed;/,
    "El body debe pintar el WebP fijo, centrado y escalado con 'cover'"
  );
  assert.match(
    css,
    /background-image:\s*image-set\(\s*url\('\.\.\/assets\/background\.webp'\)\s*type\('image\/webp'\),\s*url\('\.\.\/assets\/background\.svg'\)\s*type\('image\/svg\+xml'\)\s*\)/,
    'image-set debe preferir WebP y dejar el SVG como respaldo'
  );
});
test('las fuentes candy se sirven como WOFF2 propios y sin bloquear el render', () => {
  const css = read(STYLE_PATH);
  const html = read(INDEX_PATH);
  const fontsDir = path.join(PUBLIC_DIR, 'src', 'assets', 'fonts');
  const families = [
    'fredoka-latin.woff2',
    'fredoka-latin-ext.woff2',
    'lilita-one-latin.woff2',
    'lilita-one-latin-ext.woff2'
  ];

  for (const name of families) {
    const file = path.join(fontsDir, name);
    assert.ok(fs.existsSync(file), `Falta public/src/assets/fonts/${name}`);
    assert.ok(fs.statSync(file).size > 0, `${name} esta vacio`);
    assert.equal(
      fs.readFileSync(file).subarray(0, 4).toString('ascii'),
      'wOF2',
      `${name} debe ser un WOFF2 real`
    );

    const urlPattern = new RegExp(`url\\('\\.\\./assets/fonts/${name.replace(/[.]/g, '\\.')}'\\)`);
    assert.match(css, urlPattern, `${name} debe declararse en style.css`);
  }

  assert.match(
    css,
    /@font-face\s*\{[^}]*font-family:\s*'Fredoka';[^}]*font-weight:\s*300 900;[^}]*font-display:\s*swap;/,
    'Fredoka es variable (300-700) y debe declararse con `font-display: swap`'
  );
  assert.match(
    css,
    /@font-face\s*\{[^}]*font-family:\s*'Lilita One';[^}]*font-weight:\s*400 900;[^}]*font-display:\s*swap;/,
    'Lilita One solo tiene 400 y debe declararse con `font-display: swap`'
  );
  assert.match(
    html,
    /<link rel="preload" as="font" type="font\/woff2"[\s\S]*?href="\/src\/assets\/fonts\/fredoka-latin\.woff2" crossorigin \/>/,
    'El HTML debe precargar Fredoka desde el propio origen'
  );
  assert.match(
    html,
    /<link rel="preload" as="font" type="font\/woff2"[\s\S]*?href="\/src\/assets\/fonts\/lilita-one-latin\.woff2" crossorigin \/>/,
    'El HTML debe precargar Lilita One desde el propio origen'
  );
  assert.doesNotMatch(
    css,
    /url\(\s*['"]?https?:\/\/fonts\.(?:googleapis|gstatic)\.com/,
    'La CSP solo permite el propio origen: las fuentes no se piden a terceros'
  );
  assert.doesNotMatch(
    css,
    /@import\s+(?:url\()?['"]?https?:\/\/fonts\./,
    'No debe quedar un @import remoto de Google Fonts'
  );
});


