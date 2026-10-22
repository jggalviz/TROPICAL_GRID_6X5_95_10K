'use strict';

/**
 * Genera `server/generated/indexHtml.js` a partir de `public/index.html`.
 *
 * Vercel sirve `public/src/**` desde el CDN, pero `/` lo atiende la funcion
 * Express porque el CDN no resuelve directorios. Para no meter todo `public/`
 * en el bundle, el HTML se incrusta como modulo CommonJS: NFT solo traza este
 * archivo y no aparece el log `Compiling ... from ESM to CommonJS`.
 *
 * Se ejecuta en `npm start`, `npm run dev` y `vercel-build`. Despues de editar
 * el HTML, ejecuta `npm run build:index`; `npm test` falla si el modulo
 * generado quedo desactualizado.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT_DIR, 'public', 'index.html');
const TARGET_DIR = path.join(ROOT_DIR, 'server', 'generated');
const TARGET_PATH = path.join(TARGET_DIR, 'indexHtml.js');

const html = fs.readFileSync(SOURCE_PATH, 'utf8');

const source = [
  "'use strict';",
  '',
  '/**',
  ' * ARCHIVO GENERADO por scripts/build-index-html.js.',
  ' * Fuente: public/index.html. No editar a mano: ejecuta `npm run build:index`.',
  ' */',
  '',
  `module.exports = { INDEX_HTML: ${JSON.stringify(html)} };`,
  ''
].join('\n');

fs.mkdirSync(TARGET_DIR, { recursive: true });
fs.writeFileSync(TARGET_PATH, source, 'utf8');

// eslint-disable-next-line no-console
console.log(
  `[build:index] ${path.relative(ROOT_DIR, TARGET_PATH)} actualizado (${Buffer.byteLength(html, 'utf8')} bytes).`
);
