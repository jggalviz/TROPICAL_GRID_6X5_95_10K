/**
 * Pruebas de la coreografia del giro (`reelMath.js`).
 *
 * El modulo es ESM (lo importa el navegador) y el proyecto se ejecuta como
 * CommonJS, asi que se carga desde una URL `data:`: asi se prueba el fichero
 * REAL que sirve el servidor, sin duplicar formulas en el test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MATH_PATH = path.join(__dirname, '..', 'public', 'src', 'js', 'reelMath.js');

async function loadMath() {
  const source = fs.readFileSync(MATH_PATH, 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(url);
}

test('reelMath: la configuracion por defecto es coherente', async () => {
  const { REEL_DEFAULTS } = await loadMath();

  assert.equal(Object.isFrozen(REEL_DEFAULTS), true);
  assert.equal(REEL_DEFAULTS.rows * REEL_DEFAULTS.columns, 30);
  assert.ok(REEL_DEFAULTS.maxSpeed > 0);
  assert.ok(REEL_DEFAULTS.blurMax > 0);
  assert.ok(REEL_DEFAULTS.stopStaggerMs > 0, 'las paradas deben escalonarse');
  assert.ok(REEL_DEFAULTS.bounceMs > 0);
  assert.ok(REEL_DEFAULTS.blurStep > 0);
  /* La frenada debe durar menos que la suma de giro minimo y rebote: si no, el
     giro se percibe lento en el modo bonus de diez tiradas. */
  assert.ok(REEL_DEFAULTS.stopMs < REEL_DEFAULTS.minSpinMs + REEL_DEFAULTS.bounceMs);
});

test('reelMath: clamp acota y tolera entradas no numericas', async () => {
  const { clamp } = await loadMath();

  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp('7', 0, 10), 7);
  assert.equal(clamp(Number.NaN, 3, 10), 3);
});

test('reelMath: easeOutCubic arranca rapido y termina plano', async () => {
  const { easeOutCubic } = await loadMath();

  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-3), 0);
  assert.equal(easeOutCubic(4), 1);
  assert.ok(easeOutCubic(0.5) > 0.5, 'la salida cubica pasa del 50 % en la mitad');
  /* Monotona */
  let previous = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const value = easeOutCubic(t);
    assert.ok(value >= previous);
    previous = value;
  }
});

test('reelMath: la velocidad respeta la anticipacion y la rampa', async () => {
  const { REEL_DEFAULTS: cfg, speedAt } = await loadMath();

  assert.equal(speedAt(0, cfg), 0);
  assert.equal(speedAt(cfg.anticipationMs, cfg), 0, 'la anticipacion no avanza');
  assert.equal(speedAt(cfg.anticipationMs + cfg.spinUpMs, cfg), cfg.maxSpeed);
  assert.equal(speedAt(cfg.anticipationMs + cfg.spinUpMs * 4, cfg), cfg.maxSpeed);

  let previous = 0;
  for (let ms = 0; ms <= cfg.anticipationMs + cfg.spinUpMs; ms += 10) {
    const speed = speedAt(ms, cfg);
    assert.ok(speed >= previous - 1e-9, 'la rampa no puede bajar');
    assert.ok(speed <= cfg.maxSpeed + 1e-9);
    previous = speed;
  }
});

test('reelMath: el desenfoque crece con la velocidad y se cuantiza', async () => {
  const { REEL_DEFAULTS: cfg, blurForSpeed } = await loadMath();

  assert.equal(blurForSpeed(0, cfg), 0);
  assert.equal(blurForSpeed(cfg.blurMinSpeed, cfg), 0);
  assert.equal(blurForSpeed(cfg.maxSpeed, cfg), cfg.blurMax);

  let previous = 0;
  for (let speed = 0; speed <= cfg.maxSpeed; speed += 1) {
    const blur = blurForSpeed(speed, cfg);
    assert.ok(blur >= previous - 1e-9, 'el desenfoque no puede bajar al acelerar');
    assert.ok(blur <= cfg.blurMax + 1e-9);
    /* Cuantizado: multiplo de `blurStep` (menos el error de coma flotante). */
    const units = blur / cfg.blurStep;
    assert.ok(Math.abs(units - Math.round(units)) < 1e-6, `blur ${blur} fuera de rejilla`);
    previous = blur;
  }
});

test('reelMath: la frenada aterriza alineada y recorre al menos una ventana', async () => {
  const { REEL_DEFAULTS: cfg, stopPlan } = await loadMath();

  for (const offset of [0, 0.13, 0.5, 0.87, 0.999]) {
    for (const speed of [0, 3, 12, cfg.maxSpeed]) {
      const plan = stopPlan({ speed, offset, cfg });

      assert.ok(plan.cells >= cfg.rows, 'hacen falta celdas para rellenar la ventana');
      assert.equal(Number.isInteger(plan.cells), true);
      /* `offset + distance` es entero: el carril acaba justo en la rejilla. */
      const landing = offset + plan.distance;
      assert.ok(Math.abs(landing - Math.round(landing)) < 1e-9, 'aterrizaje desalineado');
      assert.equal(Math.round(landing), plan.cells);
      assert.ok(plan.distance > 0);
      assert.ok(plan.durationMs > 0);
      assert.ok(plan.durationMs <= cfg.stopMs * 1.8 + 1);
    }
  }
});

test('reelMath: mas velocidad implica mas recorrido de frenada', async () => {
  const { REEL_DEFAULTS: cfg, stopPlan } = await loadMath();

  const slow = stopPlan({ speed: cfg.maxSpeed * 0.4, offset: 0.2, cfg });
  const fast = stopPlan({ speed: cfg.maxSpeed, offset: 0.2, cfg });

  assert.ok(fast.distance > slow.distance - 1e-9);
  assert.ok(fast.cells >= slow.cells);
});

test('reelMath: las ultimas inyecciones son el resultado, en orden de fila', async () => {
  const { stopInjections } = await loadMath();

  const target = ['A', 'B', 'C', 'D', 'E'];
  const fill = (i) => `fill${i}`;

  const exact = stopInjections({ cells: 5, rows: 5, target, fill });
  assert.deepEqual(exact, target, 'con cinco celdas no sobra relleno');

  const longer = stopInjections({ cells: 8, rows: 5, target, fill });
  assert.equal(longer.length, 8);
  assert.deepEqual(longer.slice(3), target, 'los cinco ultimos son la ventana final');
  assert.deepEqual(longer.slice(0, 3), ['fill0', 'fill1', 'fill2']);

  const zero = stopInjections({ cells: 0, rows: 5, target });
  assert.deepEqual(zero, []);
});

test('reelMath: la matriz del servidor se transpone a columnas', async () => {
  const { columnsFromMatrix } = await loadMath();

  const matrix = [
    ['a0', 'b0', 'c0'],
    ['a1', 'b1', null]
  ];
  const columns = columnsFromMatrix(matrix, { rows: 2, columns: 3 });

  assert.equal(columns.length, 3);
  assert.deepEqual(columns[0], ['a0', 'a1']);
  assert.deepEqual(columns[1], ['b0', 'b1']);
  assert.deepEqual(columns[2], ['c0', null]);

  const empty = columnsFromMatrix(null, { rows: 2, columns: 2 });
  assert.deepEqual(empty, [[null, null], [null, null]]);
});

test('reelMath: la duracion total suma desfase, frenada y rebote', async () => {
  const { timelineMs } = await loadMath();

  assert.equal(timelineMs({ reels: 6, staggerMs: 80, durationMs: 400, bounceMs: 240 }), 5 * 80 + 400 + 240);
  assert.equal(timelineMs({ reels: 1, staggerMs: 80, durationMs: 400, bounceMs: 240 }), 640);
  assert.equal(timelineMs(), 0);
});
