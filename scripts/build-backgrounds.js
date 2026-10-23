#!/usr/bin/env node
'use strict';

/**
 * Optimiza los dos fondos ilustrados del juego.
 *
 *   npm run build:bg
 *
 * Los maestros viven en `design/` porque todo lo que hay en `public/src/**` se
 * publica en el CDN y los PNG pesan ~2 MB cada uno:
 *
 *   design/reino_de_caramelos_y_arcoiris.png      1672 x 941    escritorio
 *   design/avenida_fantastica_reino_caramelos.png 1024 x 1536   movil
 *
 * El CSS sirve uno u otro segun el ancho (`body` para >= 900 px y la media
 * query de 899 px hacia abajo) y los pinta con `cover` + `center`, asi que el
 * asset tiene que conservar la relacion del maestro: cualquier recorte o
 * reescalado descentraria la ilustracion respecto al tablero y la consola, que
 * comparten eje.
 *
 * Calidad 90 y sin reescalar:
 *   - a 90 los degradados del cielo y los arcoiris no hacen banding y el peso
 *     queda muy por debajo del umbral de 400 KB que vigila el test;
 *   - no se hace `resize`: el escritorio (1672 px) cubre 1080p con un 15 % de
 *     ampliacion que el navegador interpola de sobra, y el movil (1024 px)
 *     dobla la densidad de un iPhone de 390 px CSS. Ampliar aqui solo añadiria
 *     bytes sin recuperar detalle.
 *
 * Es idempotente: misma entrada y misma calidad -> mismos bytes.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const DESIGN = path.join(ROOT, 'design');
const ASSETS = path.join(ROOT, 'public', 'src', 'assets');
const DEPLOY = path.join(ROOT, '.vercel', 'output', 'static', 'src', 'assets');

// 90 es el minimo que deja el cielo y los arcoiris sin banding visible sobre
// `cover` en pantalla completa (ver cabecera).
const QUALITY = Number(process.env.BG_QUALITY || 90);

/** Un fondo por dispositivo: maestro, destino y relacion de aspecto exigida. */
const BACKGROUNDS = [
  {
    key: 'desktop',
    source: path.join(DESIGN, 'reino_de_caramelos_y_arcoiris.png'),
    target: 'reino_de_caramelos_y_arcoiris.webp',
    use: 'escritorio (body)',
  },
  {
    key: 'mobile',
    source: path.join(DESIGN, 'avenida_fantastica_reino_caramelos.png'),
    target: 'avenida_fantastica_reino_caramelos.webp',
    use: 'movil (max-width: 899px)',
  },
];

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

/** Optimiza un maestro y devuelve el WebP junto a su metadata. */
async function optimize(source) {
  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`${path.basename(source)} no declara medidas: revisa el PNG`);
  }

  // Los fondos son fotograficos y opacos: `cover` no deja ver el alfa, asi que
  // se descarta para no pagar un canal que nunca se pinta.
  const webp = await sharp(source)
    .rotate()
    .flatten({ background: '#ffa8de' })
    .webp({ quality: QUALITY, effort: 6, smartSubsample: true })
    .toBuffer();

  const out = await sharp(webp).metadata();
  if (out.width !== meta.width || out.height !== meta.height) {
    throw new Error(
      `El WebP mide ${out.width}x${out.height} y el maestro ${meta.width}x${meta.height}: ` +
        'los fondos no se reescalan (ver cabecera)'
    );
  }
  if (out.format !== 'webp') {
    throw new Error(`El destino no es un WebP real: ${out.format}`);
  }

  return { meta, out, webp };
}

(async () => {
  if (!fs.existsSync(ASSETS)) {
    throw new Error('Falta public/src/assets: no se puede publicar el fondo');
  }

  for (const bg of BACKGROUNDS) {
    if (!fs.existsSync(bg.source)) {
      throw new Error(`Falta el maestro ${path.relative(ROOT, bg.source)}`);
    }

    const { meta, out, webp } = await optimize(bg.source);
    const target = path.join(ASSETS, bg.target);

    fs.writeFileSync(target, webp);
    // `.vercel/output` es un hard link del repo: si se rompe, se refresca a mano.
    const deploy = path.join(DEPLOY, bg.target);
    if (fs.existsSync(deploy) && fs.statSync(deploy).ino !== fs.statSync(target).ino) {
      fs.copyFileSync(target, deploy);
    }

    const saved = 100 - (webp.length / fs.statSync(bg.source).size) * 100;
    console.log(
      `origen  ${path.relative(ROOT, bg.source)}  ${meta.width}x${meta.height}  ` +
        `${kb(fs.statSync(bg.source).size)}  (${bg.use})`
    );
    console.log(
      `salida  ${path.relative(ROOT, target)}  ${out.width}x${out.height}  ` +
        `${kb(webp.length)} (q=${QUALITY})  ${saved.toFixed(1)} % menos`
    );
  }
})().catch((err) => {
  console.error(`build:bg · ${err.message}`);
  process.exitCode = 1;
});
