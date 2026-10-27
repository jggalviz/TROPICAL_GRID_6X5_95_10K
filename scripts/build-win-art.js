#!/usr/bin/env node
'use strict';

/**
 * Optimiza el cartel de victoria (WIN overlay).
 *
 *   npm run build:win
 *
 * El maestro vive en `design/victoria_dulce.png` (antes `¡Victoria dulce!.png`):
 * 1536 x 1024 px y alfa real (las esquinas son transparentes). Igual que el
 * resto del arte, se archiva fuera de `public/` porque todo lo que hay en
 * `public/src/**` se publica en el CDN y el PNG pesa 2,7 MB.
 *
 * El script escribe `public/src/assets/victoria_dulce.webp` con este contrato:
 *   - WebP con alfa (VP8X + ALPH + VP8) a calidad 90. `alphaQuality: 100`
 *     conserva el canal alfa sin perdida: el recorte del cartel no gana halos
 *     blancos ni escalones en el borde de las letras.
 *   - 1152 x 768 px (75 % del maestro, misma relacion 3:2). El CSS no pinta el
 *     arte por encima de 640 px CSS, asi que 1152 cubre pantallas retina
 *     (1,8x) sin cargar los ~573 KB del lienzo completo.
 *   - Antes de reescalar se recorta el alfa vacio si el maestro lo tuviera
 *     (`trim`): hoy no hay margen que quitar, pero un arte nuevo con aire
 *     transparente no se publica con ese peso muerto.
 *   - Tope de peso: 450 KB (el WebP actual ronda los 423 KB).
 *
 * Es idempotente: misma entrada y misma calidad -> mismos bytes.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'design', 'victoria_dulce.png');
const TARGET = path.join(ROOT, 'public', 'src', 'assets', 'victoria_dulce.webp');
const DEPLOY = path.join(ROOT, '.vercel', 'output', 'static', 'src', 'assets', 'victoria_dulce.webp');

// El arte se pinta como maximo a 640 px CSS: 1152 px cubre retina sin inflar
// la descarga (573 KB a lienzo completo contra 423 KB aqui).
const TARGET_WIDTH = 1152;
const QUALITY = Number(process.env.WIN_QUALITY || 90);
const MAX_BYTES = 450 * 1024;

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

(async () => {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Falta el maestro ${path.relative(ROOT, SOURCE)}: mueve el PNG a design/`);
  }

  const master = await sharp(SOURCE).metadata();
  if (!master.width || !master.height) {
    throw new Error(`${path.basename(SOURCE)} no declara medidas: revisa el PNG`);
  }
  if (!master.hasAlpha) {
    throw new Error(
      'El maestro no trae canal alfa: el cartel se recorta sobre el juego y un fondo ' +
        'opaco taparia la pantalla. Exporta el PNG con transparencia.'
    );
  }

  // Recorte del alfa vacio. Hoy es un no-op (el arte toca los cuatro bordes),
  // pero deja el pipeline preparado para un maestro con margen transparente.
  const trimmed = await sharp(SOURCE)
    .ensureAlpha()
    .trim({ threshold: 1 })
    .toBuffer({ resolveWithObject: true });
  const crop = trimmed.info.trimOffsetLeft || trimmed.info.trimOffsetTop
    ? `${trimmed.info.trimOffsetLeft},${trimmed.info.trimOffsetTop}`
    : null;

  const webp = await sharp(trimmed.data)
    .resize({ width: TARGET_WIDTH, fit: 'inside', withoutEnlargement: true })
    .webp({
      quality: QUALITY,
      alphaQuality: 100,
      effort: 6,
      smartSubsample: true
    })
    .toBuffer();

  const out = await sharp(webp).metadata();
  if (out.format !== 'webp') {
    throw new Error(`El destino no es un WebP real: ${out.format}`);
  }
  if (!out.hasAlpha) {
    throw new Error('El WebP salio sin canal alfa: revisa alphaQuality y el maestro');
  }
  if (out.width !== TARGET_WIDTH) {
    throw new Error(
      `El WebP mide ${out.width}px de ancho y el contrato exige ${TARGET_WIDTH}px ` +
        '(ver cabecera: es el 75 % del maestro)'
    );
  }
  if (Math.abs(out.width / out.height - master.width / master.height) > 0.002) {
    throw new Error(
      `El WebP mide ${out.width}x${out.height} y rompe la relacion del maestro ` +
        `${master.width}x${master.height}: el cartel se deformaria`
    );
  }
  if (webp.length >= MAX_BYTES) {
    throw new Error(
      `El cartel pesa ${kb(webp.length)} y el contrato exige menos de ${MAX_BYTES / 1024} KB: ` +
        'baja WIN_QUALITY antes de publicarlo'
    );
  }

  fs.writeFileSync(TARGET, webp);
  // `.vercel/output` es un hard link del repo: si se rompe, se refresca a mano.
  if (fs.existsSync(DEPLOY) && fs.statSync(DEPLOY).ino !== fs.statSync(TARGET).ino) {
    fs.copyFileSync(TARGET, DEPLOY);
  }

  console.log(
    `origen  ${path.relative(ROOT, SOURCE)}  ${master.width}x${master.height}  ` +
      `${kb(fs.statSync(SOURCE).size)}${crop ? `  (alfa recortado en ${crop})` : '  (alfa ya ajustado)'}`
  );
  console.log(
    `salida  ${path.relative(ROOT, TARGET)}  ${out.width}x${out.height}  ` +
      `${kb(webp.length)} (q=${QUALITY}, alfa intacta)`
  );
  console.log(
    `ahorro  ${(100 - (webp.length / fs.statSync(SOURCE).size) * 100).toFixed(1)} % menos que el maestro`
  );
})().catch((err) => {
  console.error(`build:win · ${err.message}`);
  process.exitCode = 1;
});
