#!/usr/bin/env node
'use strict';

/**
 * Recorta y optimiza el arte de la maquina movil (marco + consola).
 *
 *   npm run build:art
 *
 * Los maestros viven en `design/` (nunca se publican: el CDN solo sirve
 * `public/src/**`) y llegan con un lienzo mayor y margenes transparentes
 * alrededor del dibujo. El CSS dibuja cada pieza con `background: url(...)
 * center / contain` sobre una caja con la relacion exacta de su recorte, y
 * coloca los controles en % de esa caja: cualquier pixel transparente de mas
 * descentraria el dibujo y desalinearia las areas tactiles.
 *
 * Piezas:
 *   design/marco_movil.png   -> public/src/assets/marco_movil.webp   (1392 x 1123)
 *   design/consola_movil.png -> public/src/assets/consola_movil.webp (1783 x 693)
 *
 * `design/marco_movil_v1.png` es el maestro anterior (toldo con la nube rosa a
 * la izquierda, 1325 x 941 tras el recorte). Se conserva como referencia: el
 * dueño del marco vigente es siempre `design/marco_movil.png`, de modo que el
 * CSS y esta tabla hablan siempre de la misma pieza.
 *
 * El script, para cada pieza:
 *   1. mide el bbox de los pixeles con alfa visible;
 *   2. comprueba que ese recorte respeta la relacion del lienzo de diseno;
 *   3. escribe el WebP con alfa al tamano exacto del lienzo.
 *
 * Es idempotente: misma entrada y misma calidad -> mismos bytes.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'public', 'src', 'assets');
const DEPLOY_DIR = path.join(ROOT, '.vercel', 'output', 'static', 'src', 'assets');

/**
 * Lienzo de diseno de cada pieza: el CSS coloca sus capas en % de esta caja,
 * asi que el recorte visible tiene que medir exactamente lo mismo.
 *
 * `quality` sube en la consola porque sus degradados dorados hacen banding
 * visible muy por debajo de 92.
 */
const PIECES = [
  {
    name: 'marco_movil',
    canvas: { width: 1392, height: 1123 },
    quality: 90,
    maxBytes: 300 * 1024
  },
  {
    name: 'consola_movil',
    canvas: { width: 1783, height: 693 },
    quality: 92,
    maxBytes: 300 * 1024
  }
];

/** BBox de los pixeles con alfa visible. */
function alphaBox(data, width, height, channels, threshold = 8) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[(row + x) * channels + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('La imagen no tiene un solo pixel visible: revisa el alfa del arte');
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

async function build({ name, canvas, quality, maxBytes }) {
  const source = path.join(ROOT, 'design', `${name}.png`);
  const target = path.join(ASSETS_DIR, `${name}.webp`);
  if (!fs.existsSync(source)) {
    throw new Error(`Falta el arte de origen: ${path.relative(ROOT, source)}`);
  }

  const base = sharp(source).ensureAlpha();
  const meta = await base.metadata();
  const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
  const box = alphaBox(data, info.width, info.height, info.channels);

  const canvasRatio = canvas.width / canvas.height;
  const ratio = box.width / box.height;
  console.log(
    `${name}  origen ${meta.width}x${meta.height}  recorte ${box.width}x${box.height} ` +
      `(ratio ${ratio.toFixed(4)} vs ${canvasRatio.toFixed(4)})`
  );
  if (Math.abs(ratio - canvasRatio) > 0.002) {
    throw new Error(
      `${name}: el recorte visible no respeta la relacion ${canvas.width}/${canvas.height}: ` +
        `${box.width}x${box.height} da ${ratio.toFixed(4)}. Ajusta el arte antes de publicarlo.`
    );
  }

  const trimmed = await sharp(source)
    .ensureAlpha()
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .resize(canvas.width, canvas.height, { fit: 'fill' })
    .webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true })
    .toBuffer();

  const out = await sharp(trimmed).metadata();
  if (out.width !== canvas.width || out.height !== canvas.height) {
    throw new Error(
      `${name}: el WebP generado mide ${out.width}x${out.height}, se esperaba ${canvas.width}x${canvas.height}`
    );
  }
  if (trimmed.length > maxBytes) {
    throw new Error(
      `${name}: el WebP pesa ${kb(trimmed.length)} y el tope es ${kb(maxBytes)}. Baja la calidad del arte.`
    );
  }

  fs.writeFileSync(target, trimmed);
  // `.vercel/output` es un hard link del repo: si se rompe, se refresca a mano.
  const deploy = path.join(DEPLOY_DIR, `${name}.webp`);
  if (fs.existsSync(deploy) && fs.statSync(deploy).ino !== fs.statSync(target).ino) {
    fs.copyFileSync(target, deploy);
  }

  console.log(
    `  -> ${path.relative(ROOT, target)}  ${out.width}x${out.height}  ${kb(trimmed.length)} ` +
      `(q=${quality}, alfa intacto)`
  );
  console.log(`  fuente ${kb(fs.statSync(source).size)}`);
}

(async () => {
  for (const piece of PIECES) {
    await build(piece);
  }
})().catch((err) => {
  console.error(`build:art · ${err.message}`);
  process.exitCode = 1;
});
