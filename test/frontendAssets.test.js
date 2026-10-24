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
const LOGO_MASTER_PATH = path.join(ROOT_DIR, 'design', 'pana_crush_ANIMACION-LOGO_final.gif');
const PUBLIC_SRC_DIR = path.join(PUBLIC_DIR, 'src');

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

  // El peso es parte del contrato: el maestro GIF pesa 476 KB y el WebP servido
  // ronda los 135 KB: WebP animado real (VP8X + ANIM + 5 ANMF), bucle infinito.
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
  // Los retardos son parte del contrato: el logo se mece con el mismo ritmo que
  // el maestro (430/100/370/500/400 ms), no con un frame fijo ni reordenado.
  const delays = frames.map((frame) => binary.readUIntLE(frame.offset + 20, 3));
  assert.deepEqual(delays, [430, 100, 370, 500, 400], 'El logo debe conservar los retardos del maestro');

  // Sin reescalar: el lienzo del WebP tiene que medir lo mismo que el GIF. Un
  // upscale no se nota en pantalla y solo infla el peso que se descarga.
  const master = fs.readFileSync(LOGO_MASTER_PATH);
  assert.equal(master.toString('ascii', 0, 3), 'GIF', 'El maestro del logo debe ser el GIF original');
  assert.equal(
    binary.readUIntLE(chunks[0].offset + 12, 3) + 1,
    master.readUInt16LE(6),
    'El lienzo del WebP debe conservar el ancho del maestro'
  );
  assert.equal(
    binary.readUIntLE(chunks[0].offset + 15, 3) + 1,
    master.readUInt16LE(8),
    'El lienzo del WebP debe conservar el alto del maestro'
  );

  assert.ok(
    binary.length < 200 * 1024,
    `El logo animado debe pesar menos de 200 KB (pesa ${(binary.length / 1024).toFixed(1)} KB)`
  );

  assert.match(html, /<div class="machine__hero">/);
  assert.match(html, /src="\/src\/assets\/PANA-CRUSH-LOGO\.webp"/);
  assert.match(html, /alt="PANA CRUSH"/);
  assert.match(html, /width="240" height="240"/, 'El logo debe reservar 240x240 px como maximo');
});

test('el maestro del logo vive fuera de public/ y no viaja al CDN', () => {
  // El GIF pesa 476 KB: si se queda en `public/src`, se publica en cada deploy y
  // el directorio deja de ser solo lo que consume el cliente.
  assert.ok(fs.existsSync(LOGO_MASTER_PATH), 'Falta el maestro design/pana_crush_ANIMACION-LOGO_final.gif');
  assert.ok(fs.statSync(LOGO_MASTER_PATH).size > 0, 'El maestro del logo esta vacio');

  const media = /\.(gif|png|jpe?g|webp|avif|psd|tiff?|mp4|mov|webm)$/i;
  const strays = fs
    .readdirSync(PUBLIC_SRC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && media.test(entry.name))
    .map((entry) => entry.name);
  assert.deepEqual(
    strays,
    [],
    `public/src solo debe contener carpetas publicadas; sobran: ${strays.join(', ')}`
  );
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
    /@media \(min-width: 900px\) and \(max-height: 660px\)\s*\{\s*\.machine__hero\s*\{\s*display:\s*none;\s*\}/,
    'En escritorio bajo el logo desaparece para ceder alto al tablero'
  );
  assert.match(
    css,
    /\.machine__side \.machine__hero\s*\{[^}]*position:\s*absolute;[^}]*\}/,
    'En movil el logo se superpone al marco y no compite por el alto'
  );
  assert.match(
    css,
    /\.controls\s*\{[^}]*flex-shrink:\s*1;[^}]*min-height:\s*0;/,
    'Los controles deben poder comprimirse dentro de la maquina'
  );
});

test('cada dispositivo pinta su propio fondo ilustrado en WebP de calidad 90', () => {
  const css = read(STYLE_PATH);

  // Un maestro por dispositivo, archivado en `design/`: todo lo que hay en
  // `public/src/**` se publica en el CDN y cada PNG pesa ~2 MB.
  const fondos = [
    ['reino_de_caramelos_y_arcoiris.png', 'reino_de_caramelos_y_arcoiris.webp'],
    ['avenida_fantastica_reino_caramelos.png', 'avenida_fantastica_reino_caramelos.webp'],
  ];

  for (const [master, served] of fondos) {
    const file = path.join(PUBLIC_DIR, 'src', 'assets', served);
    assert.ok(fs.existsSync(file), `Falta public/src/assets/${served}`);

    const binary = fs.readFileSync(file);
    assert.equal(binary.toString('ascii', 0, 4), 'RIFF', `${served} debe ser un contenedor RIFF/WebP`);
    assert.equal(binary.toString('ascii', 8, 12), 'WEBP', `${served} debe ser un WebP real`);

    // Sin reescalar ni recortar: el fondo se pinta con `cover` + `center` sobre
    // el mismo eje que el tablero y la consola, asi que el lienzo tiene que
    // medir exactamente lo que el maestro. Se comprueba contra el IHDR del PNG
    // y contra las dimensiones codificadas en el bloque VP8 del WebP.
    const masterFile = path.join(ROOT_DIR, 'design', master);
    assert.ok(fs.existsSync(masterFile), `Falta el maestro design/${master}`);
    const png = fs.readFileSync(masterFile);
    assert.equal(png.toString('ascii', 1, 4), 'PNG', `design/${master} debe ser el PNG maestro`);

    const lossy = webpChunks(binary).find((chunk) => chunk.fourCC === 'VP8 ');
    assert.ok(lossy, `${served} debe ser un WebP lossy (bloque VP8), sin alfa que nadie pinta`);
    assert.equal(
      binary.readUInt16LE(lossy.offset + 14) & 0x3fff,
      png.readUInt32BE(16),
      `${served} debe conservar el ancho del maestro`
    );
    assert.equal(
      binary.readUInt16LE(lossy.offset + 16) & 0x3fff,
      png.readUInt32BE(20),
      `${served} debe conservar el alto del maestro`
    );

    // Peso: q=90 deja los dos fondos en ~231/240 KB. El tope evita que una
    // subida de calidad cuele un PNG disfrazado de WebP.
    assert.ok(
      binary.length < 400 * 1024,
      `${served} pesa ${(binary.length / 1024).toFixed(1)} KB (objetivo < 400 KB)`
    );

    // Y el maestro no viaja al CDN.
    assert.ok(
      !fs.existsSync(path.join(PUBLIC_DIR, 'src', master)),
      `${master} no debe servirse desde public/src`
    );
  }

  // Escritorio: `body` pinta el reino del arcoiris centrado, escalado con
  // `cover` y anclado al viewport.
  assert.match(
    css,
    /body\s*\{[^}]*background:\s*url\('\.\.\/assets\/reino_de_caramelos_y_arcoiris\.webp'\)\s*no-repeat\s*center\s*center\s*\/\s*cover\s*fixed;/,
    "El escritorio debe pintar el arcoiris con `cover`, centrado y `fixed`"
  );

  // Movil: el case se recorta sobre la avenida, con el mismo encuadre.
  assert.match(
    css,
    /@media \(max-width: 899px\) \{\s*body \{\s*background:\s*url\('\.\.\/assets\/avenida_fantastica_reino_caramelos\.webp'\)\s*no-repeat\s*center\s*center\s*\/\s*cover;\s*\}\s*\}/,
    'Por debajo de 900 px el fondo debe pasar a la avenida fantastica'
  );

  // El fondo anterior (248 KB de WebP + 7,4 MB de SVG) se archiva en `design/`:
  // ni se sirve desde el CDN ni queda como respaldo muerto en el CSS.
  for (const retired of ['background.webp', 'background.svg']) {
    assert.ok(
      !fs.existsSync(path.join(PUBLIC_DIR, 'src', 'assets', retired)),
      `${retired} no debe seguir en public/src/assets`
    );
    assert.ok(
      fs.existsSync(path.join(ROOT_DIR, 'design', retired)),
      `El fondo retirado debe conservarse en design/${retired}`
    );
  }
  assert.doesNotMatch(css, /assets\/background\.(?:webp|svg)/, 'El CSS no debe referenciar el fondo retirado');

  // Sin scroll vertical: el fondo no empuja la maqueta ni en escritorio ni en
  // movil (el `body` recorta y la carcasa mide el viewport dinamico).
  assert.match(css, /body\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/, 'El body no debe generar scroll');
  assert.match(css, /\.app\s*\{[^}]*height:\s*100dvh;/, 'La carcasa sigue midiendo `100dvh`');
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



test('los rotulos del case no se repintan: el DOM solo guarda nombre accesible y estado', () => {
  const css = read(STYLE_PATH);

  // Las cuatro placas de la fila inferior (MAS · AUTO · GIRAR · APUESTA) vienen
  // vacias en `consola_movil.webp`: los rotulos visibles los pone la hoja de
  // estilo (los `::after` de la seccion 6 y `.bet-readout`). Lo que ninguna
  // regla puede volver a pintar es el texto del DOM, que solo guarda el nombre
  // accesible: se recorta a 1x1 en una sola regla compartida, que ademas es la
  // unica que toca a `#spin-label`.
  const start = css.indexOf('.machine__side .controls #btn-feature .btn__title,');
  assert.ok(start > -1, 'Debe existir una regla unica para los rotulos impresos en el case');

  const block = css.slice(start, css.indexOf('}', start));
  for (const selector of [
    '.machine__side .controls #btn-auto .btn__title,',
    '.machine__side .controls__bet #btn-bet-max .chip__label,',
    '.machine__side .controls #spin-label {'
  ]) {
    assert.ok(
      block.includes(selector),
      `La regla compartida debe cubrir ${selector.replace(/[,\s{]+$/, '')}`
    );
  }

  for (const declaration of [
    'position: absolute;',
    'width: 1px;',
    'height: 1px;',
    'overflow: hidden;',
    'clip-path: inset(50%);'
  ]) {
    assert.ok(block.includes(declaration), `Un rotulo impreso en el case necesita \`${declaration}\``);
  }

  // Oculto de verdad: sin colocacion ni tipografia propia sobre el arte.
  assert.doesNotMatch(
    block,
    /\b(?:top|left|right|bottom|transform|font-size|letter-spacing|color|text-shadow):/,
    'Si la placa la pinta el case, el rotulo no necesita geometria ni estilo de texto'
  );

  // El case es la unica capa grafica de la consola movil.
  assert.match(
    css,
    /\.machine__side \.controls \{[\s\S]*?background: url\('\.\.\/assets\/consola_movil\.webp'\) no-repeat center \/ contain;/,
    'La carcasa movil debe pintar `consola_movil.webp`, que ya trae los rotulos integrados'
  );

  // Y los textos siguen en el HTML: son el nombre accesible de cada pulsador y
  // `#spin-label` cambia a "GIRANDO…" mientras el motor gira.
  const html = read(INDEX_PATH);
  assert.match(
    html,
    /<span class="btn__spin-label" id="spin-label">SPIN<\/span>/,
    'El estado del giro debe seguir en el DOM para lectores de pantalla'
  );
  assert.match(
    html,
    /<span class="chip__label">MAX<\/span>/,
    'El nombre accesible de la apuesta maxima no se borra: solo se oculta'
  );
  assert.match(
    html,
    /id="btn-auto"[^>]*>[\s\S]*?<span class="btn__title">AUTO<\/span>/,
    'El pulsador AUTO conserva su texto como nombre accesible'
  );
  assert.match(html, /<span class="balance__value" id="balance-value">/, 'El saldo dinamico sigue en el HUD');
  assert.match(html, /<strong class="bet-readout__value" id="bet-readout">/, 'La apuesta dinamica sigue en el HUD');
});
test('la consola y el tablero comparten el mismo eje X en movil', () => {
  const css = read(STYLE_PATH);

  // 1) Una sola columna: el marco (marca + HUD + tablero) y la consola son las
  //    dos filas de la maquina y las dos se ciñen a `--m-w`, asi que su eje X
  //    no puede separarse.
  const machineGrid = css.match(
    /\.machine\s*\{[^}]*grid-template-areas:\s*"frame"\s*"console";[^}]*\}/
  );
  assert.ok(machineGrid, 'La maquina movil debe apilar marco y consola en una columna');
  assert.match(machineGrid[0], /display:\s*grid;/, 'La maquina centra por rejilla');
  assert.match(machineGrid[0], /grid-template-columns:\s*minmax\(0, 1fr\);/, 'Una sola pista de ancho');
  assert.match(machineGrid[0], /justify-items:\s*center;/, 'Las dos filas se centran en la columna');
  assert.match(
    machineGrid[0],
    /padding:\s*0;/,
    'Sin padding propio: el aire lateral lo pone `.app` y es simetrico'
  );
  // El ancho sale del alto libre menos la separacion, repartido entre la
  // relacion del marco (1 / 1,2395, la del recorte 1392 x 1123 sin estirar) y la
  // de la consola (1 / 2,5729).
  // `cqw`/`cqh` en lugar de `%`: dentro de una custom property un `%` se
  // resuelve contra la propiedad que la usa, y el mismo token medía el ancho en
  // `width` y el alto en `height` (el HUD caía 12 px bajo sus placas).
  assert.match(
    machineGrid[0],
    /--m-w:\s*min\(100cqw,\s*calc\(\(100cqh - clamp\(4px, 1\.2dvh, 10px\)\) \/ 1\.1954\)\);/,
    'El ancho de la maquina descuenta marco + separacion + consola del alto libre'
  );

  // 2) Las dos piezas se miden con esa unidad y con la relacion exacta de su
  //    lienzo (`contain` sobre una caja con esa relacion llena el 100%).
  const frameRule = css.match(/\.machine__table\s*\{[^}]*aspect-ratio:\s*1392 \/ 1123;[^}]*\}/);
  assert.ok(frameRule, 'El marco debe declarar la relacion exacta de su recorte, 1392/1123');
  assert.match(frameRule[0], /width:\s*var\(--m-w\);/, 'El marco se mide con `--m-w`');

  const caseRule = css.match(
    /\.machine__side \.controls\s*\{[^}]*aspect-ratio:\s*1783 \/ 693;[^}]*\}/
  );
  assert.ok(caseRule, 'La consola debe declarar su relacion 1783/693');
  const rule = caseRule[0];
  assert.match(rule, /grid-area:\s*console;/, 'La consola vive en la fila `console`');
  assert.match(rule, /width:\s*var\(--m-w\);/, 'La consola comparte el ancho exacto del marco');
  assert.match(rule, /justify-self:\s*center;/, 'Centrada por rejilla, no por un margen heredado');
  assert.match(rule, /padding:\s*0;/, 'Sin aire lateral descompensado');
  assert.match(rule, /border:\s*0;/, 'Sin filo que desplace el dibujo');
  assert.match(rule, /align-self:\s*center;/, 'La fila no estira el case');
  assert.match(
    rule,
    /background:\s*url\('\.\.\/assets\/consola_movil\.webp'\)\s*no-repeat\s*center\s*\/\s*contain;/,
    'El dibujo se pinta centrado en su propia caja'
  );

  // 3) El tablero tapa la ventana transparente del marco con % del recorte
  //    (medido: x 6,25-93,97 %, y 38,02-95,64 %), con un pelo de aire por fuera
  //    para que su filo se meta bajo el borde rosa y no asome el fondo.
  assert.match(
    css,
    /\.machine__table \.board\s*\{[^}]*position:\s*absolute;[^}]*left:\s*6\.20%;[^}]*top:\s*37\.90%;[^}]*width:\s*87\.81%;[^}]*height:\s*57\.85%;[^}]*\}/,
    'El tablero se coloca en la ventana del marco, no en el flujo de la fila'
  );

  // 4) La marca y el HUD caen sobre sus huecos del arte nuevo: el claro del arco
  //    se centra en 21,88 % del ancho y su borde inferior queda a 29,12 % del
  //    alto, y la franja de placas ciruela va de 40,88 a 93,18 % del ancho y de
  //    23,33 a 29,74 % del alto del recorte.
  const hudRule = css.match(
    /\.machine__side \.hud\s*\{[^}]*width:\s*calc\(var\(--m-w\) \* 0\.5230\);[^}]*\}/
  );
  assert.ok(hudRule, 'El HUD debe medir la franja exacta de las tres placas');
  assert.match(
    hudRule[0],
    /height:\s*calc\(var\(--frame-h\) \* 0\.0641\);/,
    'La franja mide el alto interior de las placas ciruela'
  );
  assert.match(
    hudRule[0],
    /margin-left:\s*calc\(\(100% - var\(--m-w\)\) \/ 2 \+ var\(--m-w\) \* 0\.4088\);/,
    'La franja arranca en la primera placa del toldo'
  );
  assert.match(
    hudRule[0],
    /margin-top:\s*calc\(var\(--frame-h\) \* 0\.2333\);/,
    'La franja cae sobre el toldo y no sobre la ventana'
  );

  const heroRule = css.match(/\.machine__side \.machine__hero\s*\{[^}]*--logo-h:[\s\S]*?\n  \}/);
  assert.ok(heroRule, 'La marca debe declarar su caja sobre el arco');
  assert.match(
    heroRule[0],
    /var\(--m-w\) \* 0\.2188 - var\(--logo-w\) \/ 2/,
    'El logo se centra en el claro del arco'
  );
  assert.match(
    heroRule[0],
    /bottom:\s*calc\(var\(--frame-h\) \* 0\.7088\);/,
    'La base del logo se apoya en el borde inferior del claro'
  );

  // 5) La chapa del logo: 44 % del ancho del marco y un tope por alto medido con
  //    el hueco real. `--logo-sky` es lo que hay entre el filo superior de
  //    `.machine` y el ancla del logo: la mitad del sobrante vertical de la
  //    rejilla (alto del escenario menos marco, separacion y consola) mas el
  //    29,12 % del marco que queda por encima de la base. De ahi se descuentan
  //    16 px (10 del balanceo + 6 de colchon) y se divide por 1,046, que es lo
  //    que trepa la esquina alta del PNG al girar -3° y crecer un 3 %. Sin ese
  //    tope el 44 % se corta contra el filo en tablet vertical y en 320 px.
  assert.match(
    heroRule[0],
    /--logo-sky:\s*calc\(\s*\(100cqh - \(var\(--frame-h\) \+ var\(--row-gap\) \+ var\(--m-w\) \* 0\.3887\)\) \/ 2\s*\+ var\(--frame-h\) \* 0\.2912\s*\);/,
    'El aire del logo se mide con el hueco real, no con un porcentaje fijo'
  );
  assert.match(
    heroRule[0],
    /--logo-h:\s*min\(\s*calc\(var\(--m-w\) \* 0\.44\),\s*max\(0px, \(var\(--logo-sky\) - 16px\) \/ 1\.046\)\s*\);/,
    'El logo apunta al 44 % del marco y nunca rebasa el filo superior'
  );
  assert.match(
    heroRule[0],
    /--logo-w:\s*calc\(var\(--logo-h\) \* 0\.9686\);/,
    'La caja del logo conserva la proporcion del PNG (493 x 509)'
  );
  assert.doesNotMatch(heroRule[0], /var\(--m-w\) \* 0\.34\b/, 'El logo ya no se ata al 34 % anterior');
  assert.equal(
    (css.match(/--logo-h:\s*min\(/g) || []).length,
    1,
    'El tope del logo vive en una sola regla, comun a todo el rango movil'
  );
});
test('el arte de las dos maquinas se sirve con su lienzo exacto y los maestros quedan fuera de public/', () => {
  // Cada pieza se pinta con `background: url(...) center / contain` sobre una
  // caja con la relacion de su lienzo; si el WebP cambia de medidas, `contain`
  // lo centra con aire y los controles se salen del arte.
  //
  // Movil (`build-mobile-art.js`): marco y consola recortados al alfa.
  // Escritorio (`build-desktop-art.js`): d1 (marco del tablero), d5 (modulo
  // hero + placas) y d3 (consola), a q=90 y con el mismo contrato de lienzo.
  const pieces = [
    { name: 'marco_movil', size: '1392x1123', max: 300 * 1024, build: 'build-mobile-art.js' },
    { name: 'consola_movil', size: '1783x693', max: 300 * 1024, build: 'build-mobile-art.js' },
    { name: 'd1', size: '1017x819', max: 300 * 1024, build: 'build-desktop-art.js' },
    { name: 'd5', size: '1471x1042', max: 560 * 1024, build: 'build-desktop-art.js' },
    { name: 'd3', size: '599x468', max: 300 * 1024, build: 'build-desktop-art.js' }
  ];
  const css = read(STYLE_PATH);

  for (const { name, size, max, build } of pieces) {
    const asset = path.join(PUBLIC_DIR, 'src', 'assets', `${name}.webp`);
    assert.ok(fs.existsSync(asset), `Falta public/src/assets/${name}.webp`);
    const binary = fs.readFileSync(asset);
    assert.equal(binary.toString('ascii', 0, 4), 'RIFF', `${name} debe ser un contenedor RIFF/WebP`);
    assert.equal(binary.toString('ascii', 8, 12), 'WEBP', `${name} debe ser un contenedor RIFF/WebP`);

    const canvas = webpChunks(binary).find((chunk) => chunk.fourCC === 'VP8X');
    assert.ok(canvas, `${name} debe declarar caracteristicas extendidas (VP8X)`);
    const width = binary.readUIntLE(canvas.offset + 12, 3) + 1;
    const height = binary.readUIntLE(canvas.offset + 15, 3) + 1;
    assert.equal(`${width}x${height}`, size, `El lienzo de ${name} debe ser exactamente ${size}`);

    // Los degradados dorados hacen banding por debajo de q=92 en la consola; el
    // tope deja aire para subir la calidad sin servir un PNG disfrazado de WebP.
    assert.ok(
      binary.length < max,
      `${name} debe pesar menos de ${max / 1024} KB (pesa ${(binary.length / 1024).toFixed(1)} KB)`
    );

    // Los maestros llegan con margenes transparentes y pesan MB: se publica
    // todo `public/src/**`, asi que viven en `design/` y solo se sirve el
    // recorte que produce el script de cada maqueta.
    assert.ok(
      fs.existsSync(path.join(ROOT_DIR, 'design', `${name}.png`)),
      `El arte master debe estar en design/${name}.png`
    );
    for (const stray of [`${name}.png`, `${name}.webp`]) {
      assert.ok(
        !fs.existsSync(path.join(PUBLIC_DIR, 'src', stray)),
        `${stray} no debe servirse desde public/src`
      );
    }

    // El script de la pieza declara el mismo lienzo que el CSS.
    const script = fs.readFileSync(path.join(ROOT_DIR, 'scripts', build), 'utf8');
    const [w, h] = size.split('x');
    assert.match(
      script,
      new RegExp(`name: '${name}',[\\s\\S]{0,90}?canvas: \\{ width: ${w}, height: ${h} \\}`),
      `${build} debe recortar ${name} a ${size}`
    );
  }

  // El arte de escritorio se compila a q=90 y el comando queda registrado.
  const desktop = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'build-desktop-art.js'), 'utf8');
  for (const name of ['d1', 'd5', 'd3']) {
    const block = desktop.slice(desktop.indexOf(`name: '${name}'`));
    assert.match(block.slice(0, 200), /quality: 90,/, `${name} se compila a calidad 90`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:desktop-art'], 'node scripts/build-desktop-art.js');

  // El CSS de escritorio pinta las tres piezas a sangre y ancla los controles
  // en % del lienzo (las mismas medidas que imprime el script). Se buscan todas
  // las reglas del selector: las capas anteriores tambien declaran cajas para
  // estos botones y solo una lleva la geometria del arte.
  for (const name of ['d1', 'd5', 'd3']) {
    assert.match(
      css,
      new RegExp(`url\\('\\.\\.\\/assets\\/${name}\\.webp'\\) no-repeat center \\/ 100% 100%`),
      `El CSS debe pintar ${name}.webp sin aire (100% 100%)`
    );
  }
  // El arte antiguo del hero ya no se sirve ni se pinta.
  assert.doesNotMatch(css, /d2\.webp/, 'El CSS ya no debe referenciar d2.webp');
  assert.ok(
    !fs.existsSync(path.join(PUBLIC_DIR, 'src', 'assets', 'd2.webp')),
    'd2.webp no debe servirse: lo sustituye d5.webp'
  );
  const bodies = (selector) => [...css.matchAll(new RegExp(`${selector} \\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1]);
  const spinBodies = bodies('\\.machine__side \\.controls \\.btn--spin');
  assert.ok(spinBodies.length, 'La capsula SPIN debe declarar su caja');
  for (const declaration of ['left: 9.35%;', 'top: 39.32%;', 'width: 81.30%;', 'height: 26.71%;']) {
    assert.ok(
      spinBodies.some((body) => body.includes(declaration)),
      `El SPIN se ancla al dibujo con \`${declaration}\``
    );
  }
  const windowBodies = bodies('\\.machine__table \\.board');
  assert.ok(windowBodies.length, 'El tablero debe declarar su caja sobre la ventana del marco');
  for (const declaration of ['left: 5%;', 'top: 11.7%;', 'width: 89.3%;', 'height: 82.45%;']) {
    assert.ok(
      windowBodies.some((body) => body.includes(declaration)),
      `La ventana de d1 se cubre con \`${declaration}\``
    );
  }

  // Geometria del hero de escritorio (d5 · 1471 x 1042): el lienzo manda en la
  // columna lateral y las placas se reparten con las proporciones reales del
  // dibujo, no con tercios, para que cada dato caiga en el centro de su placa.
  assert.match(
    css,
    /--side-w: calc\(\(var\(--frame-h\) - var\(--d-gap-y\)\) \/ 1\.48966\)/,
    'La columna lateral reparte su alto con 1042/1471 (hero) + 468/599 (consola)'
  );
  assert.match(
    css,
    /--hero-h: calc\(var\(--side-w\) \* 0\.70836\)/,
    'El hero mide 1042/1471 de su ancho'
  );
  assert.match(
    css,
    /--frame-h: min\([\s\S]{0,180}?\/ 1\.91305\)/,
    'El marco descuenta la columna lateral con 1,24176 (d1) + 0,67129 (d5 + d3)'
  );

  const heroBodies = bodies('\\.machine__side \\.machine__hero');
  assert.ok(heroBodies.length, 'El hero debe declarar su caja');
  assert.ok(
    heroBodies.some((body) => body.includes('height: var(--hero-h);')),
    'El hero ocupa el alto que le da `--hero-h`'
  );

  const hudBodies = bodies('\\.machine__side \\.hud');
  assert.ok(hudBodies.length, 'Las placas deben declarar su banda sobre el dibujo');
  for (const declaration of [
    'left: 5.64%;',
    'top: calc(var(--hero-h) * 0.7582);',
    'width: 88.92%;',
    'height: calc(var(--hero-h) * 0.1602);',
    'grid-template-columns: 31.73% 28.59% 32.11%;',
    'column-gap: 3.75%;'
  ]) {
    assert.ok(
      hudBodies.some((body) => body.includes(declaration)),
      `Las placas se anclan al dibujo con \`${declaration}\``
    );
  }

  const logoBodies = bodies('\\.machine__side \\.machine__logo');
  assert.ok(logoBodies.length, 'El logo debe declarar su caja sobre la nube');
  for (const declaration of ['left: 50.82%;', 'top: 34.3%;', 'width: 54%;']) {
    assert.ok(
      logoBodies.some((body) => body.includes(declaration)),
      `El logo se apoya en el hueco de d5 con \`${declaration}\``
    );
  }
  assert.ok(
    logoBodies.some((body) => body.includes('top: 34.3%;') && body.includes('width: 54%;')),
    'El logo cubre la nube de d5 y asoma por arriba del modulo'
  );
  assert.ok(
    logoBodies.some((body) => body.includes('width: 45%;') && body.includes('top: 36.7%;')),
    'En ventanas bajas el logo mantiene la base con un 45 % de ancho'
  );
  // El case de escritorio responde como un pulsador de arcade: se hunde un 5 %
  // (y con el, su trozo de dibujo) y suelta un destello especular al pasar el
  // cursor o al pulsar.
  assert.match(
    css,
    /\.machine__side \.controls \.gbtn:active:not\(:disabled\) \{\s*transform: scale\(0\.95\);/,
    'El pulsador de escritorio se hunde con `scale(0.95)`'
  );
  assert.match(
    css,
    /\.machine__side \.controls \.gbtn:hover:not\(:disabled\)::after,[\s\S]{0,140}?animation: pana-art-sheen/,
    'El `::after` del pulsador barre un destello de luz al pasar el cursor'
  );
  assert.match(
    css,
    /@keyframes pana-art-sheen \{\s*from \{ background-position: 140% 0; \}\s*to \{ background-position: -60% 0; \}\s*\}/,
    'El destello recorre la capsula de un borde al otro'
  );
  assert.match(
    css,
    /\.machine__side \.controls \.gbtn \{[^}]*transition:[\s\S]{0,120}?transform 0\.14s cubic-bezier/,
    'La transicion del hundimiento es fluida (curva de muelle)'
  );

  // La variante sin iconos del arte no es la que se publica.
  assert.ok(
    !fs.existsSync(path.join(PUBLIC_DIR, 'src', 'assets', 'consola_movil_sin_iconos.webp')),
    'La variante sin iconos no debe servirse desde public/src/assets'
  );
});

test('el pulsador se hunde en 80 ms al tocarlo y vuelve con la misma curva', () => {
  const css = read(STYLE_PATH);

  // La transicion vive en la capa tactil (no en `:active`), asi el retorno al
  // soltar tambien anima y el hundimiento no aparece de golpe.
  const touchLayer = css.match(/\.machine__side \.controls \.gbtn,[\s\S]*?\}/);
  assert.ok(touchLayer, 'La capa tactil del case debe declarar sus reglas base');
  assert.match(
    touchLayer[0],
    /transition:\s*transform 0\.08s ease,\s*filter 0\.08s ease,\s*box-shadow 0\.08s ease;/,
    'El hundimiento entra y sale en 80 ms'
  );

  // Los seis pulsadores comparten la misma respuesta fisica: 6 % menos y 1 px
  // hacia abajo, con un punto de brillo que ilumina la tinta del case.
  const press = css.match(
    /\.machine__side \.controls #btn-feature:active:not\(:disabled\),[\s\S]*?transform: scale\(0\.94\) translateY\(1px\);[\s\S]*?filter: brightness\(1\.06\) saturate\(1\.04\);\s*\}/
  );
  assert.ok(press, 'La seccion 7bis debe hundir el pulsador con `scale(0.94)`');
  for (const id of ['#btn-feature', '#btn-auto', '.btn--spin', '#btn-bet-down', '#btn-bet-up', '#btn-bet-max']) {
    assert.ok(press[0].includes(id), `El hundimiento debe cubrir ${id}`);
  }

  // El origen se clava en el centro de la caja tactil, que ahora es el bbox
  // medido del disco: el hundimiento cierra el bisel hacia el pulsador fisico y
  // no desplaza el arte ni un pixel.
  assert.match(
    css,
    /#btn-feature\s*\{\s*transform-origin:\s*50% 50%;\s*\}/,
    'FEVER encoge hacia el centro de su disco'
  );
  assert.match(
    css,
    /#btn-auto\s*\{\s*transform-origin:\s*50% 50%;\s*\}/,
    'AUTO encoge hacia el centro de su disco'
  );
  assert.match(
    css,
    /\.btn--spin\s*\{\s*transform-origin:\s*50% 50%;\s*\}/,
    'El GIRAR encoge hacia el centro de su disco'
  );
});


test('la caja tactil de cada pulsador es su bbox del arte y el velo se recorta con --disc', () => {
  const css = read(STYLE_PATH);

  // Medido sobre `consola_movil.webp` (1783 x 693) con el analisis de alfa y
  // color: discos x 4,6-16,3 / 21,0-32,7 / 67,3-78,9 / 84,1-95,4 % · y
  // 45,0-74,1 %, capsula del GIRAR x 38,6-61,0 % · y 24,5-79,8 % y el tramo MAX
  // de la placa APUESTA x 84,2-94,8 % · y 82,0-93,5 %. La caja tactil es
  // exactamente ese recuadro, asi que el dedo siempre cae sobre el dibujo.
  const boxes = [
    [/\.machine__side \.controls #btn-feature\.gbtn \{([^}]*)\}/, ['left: 4.6%;', 'top: 45%;', 'width: 11.7%;', 'height: 29.1%;']],
    [/\.machine__side \.controls #btn-auto\.gbtn \{([^}]*)\}/, ['left: 21%;', 'top: 44.7%;', 'width: 11.7%;', 'height: 29.4%;']],
    [/\.machine__side \.controls \.btn--spin\.gbtn \{([^}]*)\}/, ['left: 38.6%;', 'top: 24.5%;', 'width: 22.4%;', 'height: 55.3%;']],
    [/\.machine__side \.controls__bet #btn-bet-down \{([^}]*)\}/, ['left: 67.3%;', 'top: 45%;']],
    [/\.machine__side \.controls__bet #btn-bet-up \{([^}]*)\}/, ['left: 84.1%;', 'top: 45%;', 'width: 11.3%;', 'height: 28.8%;']],
    [/\.machine__side \.controls__bet #btn-bet-max \{([^}]*)\}/, ['left: 84.2%;', 'top: 82%;', 'width: 10.6%;', 'height: 11.5%;']]
  ];
  for (const [pattern, declarations] of boxes) {
    // Las reglas de `--disc` no llevan geometria: se busca la que la declare
    // completa, que es la que coloca el pulsador sobre el dibujo.
    const bodies = [...css.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match[1]);
    assert.ok(bodies.length, `Falta la regla tactil ${pattern.source}`);
    assert.ok(
      bodies.some((body) => declarations.every((declaration) => body.includes(declaration))),
      `Ninguna regla de ${pattern.source} declara ${declarations.join(' ')}`
    );
  }

  // Los dos discos que comparten caja declaran una sola vez el tamano comun.
  const discPair = css.match(
    /\.machine__side \.controls__bet #btn-bet-down,\s*\n\s*\.machine__side \.controls__bet #btn-bet-up \{([^}]*)\}/
  );
  assert.ok(discPair, 'Los discos − y + comparten su regla base');
  assert.ok(discPair[1].includes('width: 11.6%;'), 'Los dos discos minus/plus miden 11,6 % de ancho');
  assert.ok(discPair[1].includes('height: 29.1%;'), 'Los dos discos minus/plus miden 29,1 % de alto');

  // `--disc` (top right bottom left, en % de la caja tactil) recorta el velo del
  // hundimiento. Con la caja ceñida al bbox del arte el recorte no necesita
  // aire: si alguien vuelve a estirar una caja para incluir la placa, este es el
  // valor que debe crecer con ella.
  const discs = {
    '.machine__side .controls #btn-feature': '0',
    '.machine__side .controls #btn-auto': '0',
    '.machine__side .controls .btn--spin': '0',
    '.machine__side .controls__bet #btn-bet-down': '0',
    '.machine__side .controls__bet #btn-bet-up': '0',
    '.machine__side .controls__bet #btn-bet-max': '0',
  };
  for (const [selector, disc] of Object.entries(discs)) {
    const rule = css.match(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{\\s*--disc:\\s*([^;]+);`)
    );
    assert.ok(rule, `${selector} debe declarar su recorte --disc`);
    assert.equal(rule[1].trim(), disc, `${selector} recorta el velo a su disco`);
  }

  // El velo es un `::before` absoluto que se ciñe con `inset: var(--disc)`.
  assert.match(
    css,
    /#btn-feature:active:not\(:disabled\)::before,[\s\S]*?#btn-auto:active:not\(:disabled\)::before,[\s\S]*?\.chip\.gbtn:active:not\(:disabled\)::before\s*\{[\s\S]*?inset: var\(--disc\);[\s\S]*?pointer-events: none;/,
    'El velo de los pulsadores circulares se recorta con `--disc` y no captura el toque'
  );

  // Un borde duro dibujaria un circulo sobre el aro (y cruzaria la corona del
  // GIRAR), asi que los circulares difuminan el ultimo tramo con una mascara.
  assert.match(
    css,
    /#btn-feature:active:not\(:disabled\)::before,[\s\S]*?mask-image: radial-gradient\(closest-side,[\s\S]*?\);/,
    'El velo circular debe difuminar su borde con una mascara radial'
  );
  assert.match(
    css,
    /\.btn--spin:active:not\(:disabled\)::before\s*\{[\s\S]*?mask-image: radial-gradient\(closest-side,/,
    'El GIRAR tambien difumina el borde de su velo'
  );

  // La placa APUESTA es una pildora con aro dorado nitido: borde recto y sin
  // mascara heredada del grupo circular.
  const maxVeil = css.match(/#btn-bet-max:active:not\(:disabled\)::before\s*\{[\s\S]*?\}/);
  assert.ok(maxVeil, 'La placa APUESTA debe tener su propio velo');
  assert.match(maxVeil[0], /border-radius: 999px;/, 'APUESTA se hunde como pildora');
  assert.match(maxVeil[0], /mask-image: none;/, 'La pildora anula la mascara circular');
});


test('el reset de pintura del case deja viva la respuesta al toque', () => {
  const css = read(STYLE_PATH);

  // El boton candy pinta fondo, halos y un `inset` blanco en `:active`; si el
  // reset no incluyera ese estado, el velo candy taparia el disco del case.
  const reset = css.match(
    /\.machine__side \.controls #btn-spin,\s*\n[\s\S]*?\{\s*background: none;\s*box-shadow: none;\s*border: 0;\s*animation: none;\s*\}/
  );
  assert.ok(reset, 'Debe existir un reset de pintura por id para la capa tactil');
  for (const selector of [
    '#btn-spin:active:not(:disabled)',
    '#btn-feature:active:not(:disabled)',
    '#btn-auto:active:not(:disabled)',
    '#btn-bet-down:active:not(:disabled)',
    '#btn-bet-up:active:not(:disabled)',
    '#btn-bet-max:active:not(:disabled)',
  ]) {
    assert.ok(reset[0].includes(selector), `El reset debe cubrir ${selector}, no solo el reposo`);
  }
  assert.doesNotMatch(
    reset[0],
    /transform:|filter:/,
    'El reset solo apaga pintura: `transform` y `filter` son el hundimiento'
  );

  // El reset de reposo/hover se excluye de `:active` para no cancelar el
  // hundimiento mientras el dedo sigue apoyado (el hover tactil se queda pegado).
  const restReset = css.match(
    /\.machine__side \.controls #btn-spin:hover:not\(:disabled\):not\(:active\),[\s\S]*?\{\s*transform: none;\s*filter: none;\s*\}/
  );
  assert.ok(restReset, 'El reset de reposo debe usar `:not(:active)`');
  for (const selector of [
    '#btn-feature:hover:not(:disabled):not(:active)',
    '#btn-auto:hover:not(:disabled):not(:active)',
    '#btn-bet-down:hover:not(:disabled):not(:active)',
    '#btn-bet-up:hover:not(:disabled):not(:active)',
    '#btn-bet-max:hover:not(:disabled):not(:active)',
  ]) {
    assert.ok(restReset[0].includes(selector), `El reset de reposo debe cubrir ${selector}`);
  }
});

test('el GIRAR del case recupera el acabado candy: cristal y destellos', () => {
  const css = read(STYLE_PATH);

  // El reflejo cuelga de `#btn-spin` (solo ese pulsador) y se recorta al domo
  // del disco: el velo de pulsación de la sección 7 sigue siendo suyo, pero la
  // caja es la misma, así el `scale(0.94)` de 7bis no deforma el cristal.
  const glass = css.match(/\.machine__side \.controls #btn-spin::before\s*\{[\s\S]*?\n  \}/);
  assert.ok(glass, 'El GIRAR debe declarar su reflejo de cristal');
  assert.match(
    glass[0],
    /linear-gradient\(180deg, rgba\(255, 255, 255, 0\.6\) 0%, rgba\(255, 255, 255, 0\) 60%\)/,
    'El reflejo usa el degradado de cristal de la mitad superior'
  );
  assert.match(glass[0], /height: 41%;/, 'El reflejo se queda en la mitad superior del disco');
  assert.match(glass[0], /mask-image: radial-gradient\(closest-side,/, 'El domo se difumina en el aro');
  assert.match(glass[0], /pointer-events: none;/, 'El reflejo no captura el toque');

  // Los tres `.spin-spark` del DOM vuelven a pintarse sobre el case, con el
  // parpadeo `twinkle` y un ritmo distinto en cada esquina.
  const sparks = css.match(/\.machine__side \.controls #btn-spin \.spin-spark\s*\{[\s\S]*?\n  \}/);
  assert.ok(sparks, 'Los destellos del GIRAR deben repintarse');
  assert.match(sparks[0], /display: block;/, 'El case ya no apaga los destellos');
  assert.match(sparks[0], /animation: twinkle 2\.6s ease-in-out infinite;/, 'Parpadeo `twinkle` en el GIRAR');
  assert.doesNotMatch(sparks[0], /display: none;/, 'Los destellos no pueden quedar ocultos');

  for (const [spark, duration, delay] of [['--b', '3.2s', '0.9s'], ['--c', '3.8s', '1.7s']]) {
    const rule = css.match(
      new RegExp(`#btn-spin \\.spin-spark${spark}\\s*\\{[\\s\\S]*?\\n  \\}`)
    );
    assert.ok(rule, `El destello ${spark} debe tener su esquina`);
    assert.match(rule[0], new RegExp(`animation-duration: ${duration};`), `${spark} parpadea a su ritmo`);
    assert.match(rule[0], new RegExp(`animation-delay: ${delay};`), `${spark} entra desfasado`);
  }

  assert.match(
    css,
    /@keyframes twinkle \{\s*0%, 100% \{ opacity: 0\.3; transform: scale\(0\.8\); \}\s*50% \{ opacity: 1; transform: scale\(1\.2\); \}/,
    'El parpadeo crece y se enciende hacia la mitad del ciclo'
  );

  // Con movimiento reducido los destellos siguen visibles pero quietos.
  assert.match(
    css,
    /#btn-spin \.spin-spark \{\s*animation: none;\s*opacity: 0\.8;\s*\}/,
    'Con `prefers-reduced-motion` los destellos se quedan fijos'
  );
});

test('la zona tactil del GIRAR no se recorta con el alto del boton candy', () => {
  const css = read(STYLE_PATH);

  // El boton candy limita su alto a 130 px: por debajo de 768 px de ancho el
  // case mide menos y no se notaba, pero a 768/899 el disco mide ~194 px y la
  // zona tactil se quedaba corta, sin cubrir el tercio inferior del GIRAR.
  assert.match(
    css,
    /\.btn--spin\.gbtn\s*\{[\s\S]*?max-height: none;/,
    'En el case el alto del GIRAR lo manda el dibujo, no la regla de escritorio'
  );
  assert.match(
    css,
    /\.machine__side \.controls \.btn--spin\s*\{[\s\S]*?max-height: 130px;/,
    'La regla de escritorio del boton candy conserva su limite propio'
  );
});


