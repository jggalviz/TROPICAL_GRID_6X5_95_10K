#!/usr/bin/env node
'use strict';

/**
 * Optimiza el logotipo animado de PANA CRUSH.
 *
 *   npm run build:logo
 *
 * El maestro vive en `design/pana_crush_ANIMACION-LOGO_final.gif`: 493 x 509 px
 * por fotograma, 5 fotogramas, alfa binaria y bucle infinito. Igual que el arte
 * del case, se guarda fuera de `public/` porque todo lo que hay en
 * `public/src/**` se publica en el CDN y el GIF pesa 476 KB.
 *
 * El script escribe `public/src/assets/PANA-CRUSH-LOGO.webp` respetando el
 * contrato de `test/frontendAssets.test.js`:
 *   - WebP animado real (VP8X + ANIM + 5 ANMF) con loop 0;
 *   - menos de 200 KB;
 *   - mismos retardos que el maestro: 430, 100, 370, 500 y 400 ms;
 *   - alfa exacta: `alphaQuality: 100` comprime el canal alfa sin perdida, asi
 *     que cada pixel conserva su transparencia original (0 px distintos).
 *
 * Calidad 76 y no 92: el logo se pinta a 126 px de alto como maximo y a ese
 * tamano el error es indistinguible (PSNR 36,6 dB, por encima del asset
 * anterior de 34,7 dB), mientras que en 493 x 509 nativo cada punto de calidad
 * cuesta ~6 KB sobre el archivo completo. `minSize` desactiva los keyframes de
 * la animacion y recorta ~5 KB sin tocar un pixel.
 *
 * Es idempotente: misma entrada y misma calidad -> mismos bytes.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'design', 'pana_crush_ANIMACION-LOGO_final.gif');
const TARGET = path.join(ROOT, 'public', 'src', 'assets', 'PANA-CRUSH-LOGO.webp');
const DEPLOY = path.join(ROOT, '.vercel', 'output', 'static', 'src', 'assets', 'PANA-CRUSH-LOGO.webp');

// Contrato del logo: el GIF entrega 5 fotogramas y estos retardos.
const FRAMES = 5;
const DELAYS = [430, 100, 370, 500, 400];
const MAX_BYTES = 200 * 1024;

// Ver el comentario de cabecera: 76 es el punto donde el peso baja de 135 KB
// sin que se note a 126 px de alto (el maximo que pinta el CSS).
const QUALITY = Number(process.env.LOGO_QUALITY || 76);

/** Decodifica todos los fotogramas apilados en un unico RGBA. */
async function decode(file) {
  const meta = await sharp(file, { animated: true }).metadata();
  const { data, info } = await sharp(file, { animated: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { meta, data, info };
}

(async () => {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Falta el maestro del logo: ${path.relative(ROOT, SOURCE)}`);
  }

  const source = await decode(SOURCE);
  if (source.meta.pages !== FRAMES) {
    throw new Error(
      `El maestro trae ${source.meta.pages} fotogramas y el contrato exige ${FRAMES}: ` +
        'actualiza el test y build-logo-asset.js antes de publicarlo'
    );
  }
  if (source.meta.loop !== 0) {
    throw new Error(`El maestro debe repetirse sin fin (loop 0), trae loop ${source.meta.loop}`);
  }
  for (const index of DELAYS.keys()) {
    if (source.meta.delay[index] !== DELAYS[index]) {
      throw new Error(
        `El fotograma ${index} dura ${source.meta.delay[index]} ms y el contrato espera ${DELAYS[index]} ms`
      );
    }
  }

  // `delay` y `loop` no se tocan: sharp los hereda del maestro.
  const webp = await sharp(SOURCE, { animated: true })
    .webp({
      quality: QUALITY,
      alphaQuality: 100,
      effort: 6,
      smartSubsample: true,
      minSize: true,
    })
    .toBuffer();

  const output = await decode(webp);
  if (output.meta.pages !== FRAMES) {
    throw new Error(`El WebP salio con ${output.meta.pages} fotogramas, se esperaban ${FRAMES}`);
  }
  if (output.meta.loop !== 0) {
    throw new Error(`El WebP salio con loop ${output.meta.loop}, se esperaba bucle infinito`);
  }
  if (output.info.width !== source.info.width || output.info.height !== source.info.height) {
    throw new Error(
      `El WebP mide ${output.info.width}x${output.info.height}, se esperaba ` +
        `${source.info.width}x${source.info.height} (sin reescalar)`
    );
  }
  for (const index of DELAYS.keys()) {
    if (output.meta.delay[index] !== DELAYS[index]) {
      throw new Error(
        `El WebP cambio el retardo del fotograma ${index} a ${output.meta.delay[index]} ms`
      );
    }
  }

  // Alfa exacta: el canal alfa viaja sin perdida, byte a byte contra el maestro.
  let alphaDiff = 0;
  for (let i = 3; i < source.data.length; i += 4) {
    if (source.data[i] !== output.data[i]) alphaDiff += 1;
  }
  if (alphaDiff > 0) {
    throw new Error(`El WebP altero el alfa en ${alphaDiff} pixeles: revisa alphaQuality`);
  }

  if (webp.length >= MAX_BYTES) {
    throw new Error(
      `El logo pesa ${(webp.length / 1024).toFixed(1)} KB y el contrato exige menos de ` +
        `${MAX_BYTES / 1024} KB: baja LOGO_QUALITY antes de publicarlo`
    );
  }

  fs.writeFileSync(TARGET, webp);
  // `.vercel/output` es un hard link del repo: si se rompe, se refresca a mano.
  if (fs.existsSync(DEPLOY) && fs.statSync(DEPLOY).ino !== fs.statSync(TARGET).ino) {
    fs.copyFileSync(TARGET, DEPLOY);
  }

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  const frame = source.meta.pageHeight;
  console.log(
    `origen  ${path.relative(ROOT, SOURCE)}  ${source.info.width}x${frame} x${FRAMES}  ` +
      `${kb(fs.statSync(SOURCE).size)}`
  );
  console.log(
    `salida  ${path.relative(ROOT, TARGET)}  ${output.info.width}x${frame} x${FRAMES}  ` +
      `${kb(webp.length)} (q=${QUALITY}, alfa intacta, retardos ${DELAYS.join('/')} ms)`
  );
  console.log(
    `ahorro  ${(100 - (webp.length / fs.statSync(SOURCE).size) * 100).toFixed(1)} % menos que el maestro`
  );
})().catch((err) => {
  console.error(`build:logo · ${err.message}`);
  process.exitCode = 1;
});
