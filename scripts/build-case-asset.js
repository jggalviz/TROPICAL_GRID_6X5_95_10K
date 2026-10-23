#!/usr/bin/env node
'use strict';

/**
 * Recorta y optimiza el case de la consola movil.
 *
 *   npm run build:case
 *
 * El arte se entrega en `design/consola_movil.webp` con un lienzo de 2019 x 1000
 * px y margenes transparentes alrededor del case. El CSS dibuja el case con
 * `background: url(...) center / contain` sobre una caja de 1952 / 904, asi que
 * el asset servido tiene que ser exactamente el recorte visible: cualquier pixel
 * transparente de mas descentra el dibujo y desalinea las areas tactiles (que se
 * colocan en % de esa caja).
 *
 * El arte vive fuera de `public/` a proposito: lo unico que se publica en el CDN
 * es `public/src/**`, y los master (3,3 MB entre PNG y WebP con margenes) no se
 * descargan nunca en el cliente.
 *
 * El script:
 *   1. mide el bbox de los pixeles con alfa visible;
 *   2. comprueba que ese recorte mantiene la relacion 1952 / 904;
 *   3. escribe `public/src/assets/consola_movil.webp` con alfa y WebP lossy.
 *
 * Es idempotente: misma entrada y misma calidad -> mismos bytes.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'design', 'consola_movil.webp');
const TARGET = path.join(ROOT, 'public', 'src', 'assets', 'consola_movil.webp');
const DEPLOY = path.join(ROOT, '.vercel', 'output', 'static', 'src', 'assets', 'consola_movil.webp');

// Lienzo de diseno del case: el CSS coloca cada control en % de esta caja.
const CANVAS_W = 1952;
const CANVAS_H = 904;
const CANVAS_RATIO = CANVAS_W / CANVAS_H; // 2,1593

// 92 y no 88: los degradados dorados del case hacen banding visible en el aro
// y en el bisel a 88 (240 kB -> 199 kB, 70 kB menos que se notan en el pulido).
const QUALITY = Number(process.env.CASE_QUALITY || 92);

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

(async () => {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Falta el arte de origen: ${path.relative(ROOT, SOURCE)}`);
  }

  const base = sharp(SOURCE).ensureAlpha();
  const meta = await base.metadata();
  const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
  const box = alphaBox(data, info.width, info.height, info.channels);

  const ratio = box.width / box.height;
  const drift = Math.abs(ratio - CANVAS_RATIO);
  console.log(
    `origen  ${meta.width}x${meta.height}  recorte ${box.width}x${box.height} ` +
      `(ratio ${ratio.toFixed(4)} vs ${CANVAS_RATIO.toFixed(4)})`
  );
  if (drift > 0.002) {
    throw new Error(
      `El recorte visible no respeta la relacion ${CANVAS_W}/${CANVAS_H}: ` +
        `${box.width}x${box.height} da ${ratio.toFixed(4)}. Ajusta el arte antes de publicarlo.`
    );
  }

  const trimmed = await sharp(SOURCE)
    .ensureAlpha()
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .resize(CANVAS_W, CANVAS_H, { fit: 'fill' })
    .webp({ quality: QUALITY, alphaQuality: 100, effort: 6, smartSubsample: true })
    .toBuffer();

  const out = await sharp(trimmed).metadata();
  if (out.width !== CANVAS_W || out.height !== CANVAS_H) {
    throw new Error(`El WebP generado mide ${out.width}x${out.height}, se esperaba ${CANVAS_W}x${CANVAS_H}`);
  }

  fs.writeFileSync(TARGET, trimmed);
  // `.vercel/output` es un hard link del repo: si se rompe, se refresca a mano.
  if (fs.existsSync(DEPLOY) && fs.statSync(DEPLOY).ino !== fs.statSync(TARGET).ino) {
    fs.copyFileSync(TARGET, DEPLOY);
  }

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  console.log(
    `salida  ${TARGET.replace(ROOT + path.sep, '')}  ${out.width}x${out.height}  ` +
      `${kb(trimmed.length)} (q=${QUALITY}, alfa intacto)`
  );
  console.log(`fuente  ${kb(fs.statSync(SOURCE).size)}  ->  ${(100 - (trimmed.length / fs.statSync(SOURCE).size) * 100).toFixed(1)} % menos`);
})().catch((err) => {
  console.error(`build:case · ${err.message}`);
  process.exitCode = 1;
});
