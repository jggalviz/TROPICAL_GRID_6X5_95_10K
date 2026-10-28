'use strict';

/**
 * ============================================================================
 *  PRNG RAPIDO PARA SIMULACIONES OFFLINE (sfc32)
 * ============================================================================
 *  - Determinista: la misma semilla produce exactamente la misma secuencia.
 *  - NO se usa en produccion. El motor de juego usa siempre su HMAC-DRBG
 *    basado en `node:crypto` (ver `server/engine/gridEngine.js`).
 *  - `int(maxExclusive)` aplica muestreo por rechazo para no introducir sesgo
 *    modular, igual que el RNG real.
 * ============================================================================
 */

/**
 * @param {number} seed semilla de 32 bits
 * @returns {{int: (maxExclusive:number)=>number, float: ()=>number, draws: ()=>number}}
 */
function createFastRng(seed) {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  let draws = 0;

  function nextUint32() {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    draws += 1;
    return t;
  }
  for (let i = 0; i < 32; i += 1) nextUint32();

  function int(maxExclusive) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
      throw new RangeError(`int(maxExclusive=${maxExclusive}) fuera de rango.`);
    }
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let value;
    do {
      value = nextUint32();
    } while (value >= limit);
    return value % maxExclusive;
  }

  return { int, float: () => int(0x100000000) / 0x100000000, draws: () => draws };
}

module.exports = { createFastRng };
