'use strict';

/**
 * Invariantes del despliegue en Vercel.
 *
 * Estas comprobaciones existen porque el preset `@vercel/express` inspecciona
 * el repositorio en tiempo de build: si se rompen, el despliegue puede compilar
 * el frontend como si fuera backend o dejar de detectar el entrypoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');

function readVercelConfig() {
  return JSON.parse(read('vercel.json'));
}

/** Quita comentarios para que las comprobaciones no fallen por documentación. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readExcludePatterns() {
  const config = readVercelConfig();
  const pattern = config.functions && config.functions['server.js'] && config.functions['server.js'].excludeFiles;
  assert.equal(
    typeof pattern,
    'string',
    'vercel.json debe declarar functions["server.js"].excludeFiles (ver docs/DEPLOY_VERCEL.md §5.1)'
  );
  return pattern
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((item) => item.trim());
}

test('vercel.json fija el preset Express y no declara builds manuales', () => {
  const config = readVercelConfig();

  assert.equal(config.framework, 'express');
  assert.equal(config.builds, undefined, 'El preset Express resuelve el entrypoint; no uses "builds"');
});

test('la funcion serverless excluye public/ y .env del bundle', () => {
  const patterns = readExcludePatterns();

  for (const expected of ['public', '.env', '.env.*']) {
    assert.ok(
      patterns.includes(expected),
      `Falta "${expected}" en functions["server.js"].excludeFiles (ver docs/DEPLOY_VERCEL.md §5.1)`
    );
  }
});

test('server.js importa express literalmente (requisito de @vercel/express)', () => {
  // El builder oficial busca esta cadena en el archivo; un simple require de
  // ./server/app no basta para que lo detecte como entrypoint.
  assert.match(read('server.js'), /require\(\s*['"]express['"]\s*\)/);
});

test('el backend no traza public/ con res.sendFile', () => {
  const appCode = stripComments(read('server/app.js'));

  assert.doesNotMatch(
    appCode,
    /res\.sendFile\s*\(/,
    'Usa express.static(..., { index: "index.html" }); sendFile vuelve a meter public/ en la funcion'
  );
  assert.match(appCode, /express\.static\(\s*PUBLIC_DIR/);
});

test('el frontend vive en public/ y no vuelve a la raiz', () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'public', 'index.html')), 'Falta public/index.html');
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'public', 'src', 'js', 'main.js')), 'Falta public/src/js/main.js');
  assert.equal(
    fs.existsSync(path.join(ROOT_DIR, 'index.html')),
    false,
    'index.html debe estar solo en public/ para que el CDN lo publique'
  );
});
