'use strict';

/**
 * Contrato de reproduccion de la victoria.
 *
 * `sfx.js` es ESM dentro de un package CommonJS, asi que se carga por `data:`
 * URL. Se sustituyen `window` y `fetch` por dobles minimos para comprobar el
 * flujo real sin navegador: precarga del MP3, decodificacion unica, volumen del
 * GainNode, desbloqueo dentro del gesto y respeto del mute.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SFX_PATH = path.join(__dirname, '..', 'public', 'src', 'js', 'sfx.js');
const SOURCE = fs.readFileSync(SFX_PATH, 'utf8');
const SFX_URL = `data:text/javascript;base64,${Buffer.from(SOURCE, 'utf8').toString('base64')}`;
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function createAudioHarness() {
  const calls = {
    fetch: [],
    decoded: 0,
    starts: [],
    gains: [],
    silentBuffers: 0,
    resumes: 0
  };
  const decodedBuffer = { duration: 1.8, sampleRate: 44100 };

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 1.25;
      this.sampleRate = 44100;
      this.destination = { kind: 'destination' };
    }

    resume() {
      calls.resumes += 1;
      this.state = 'running';
      return Promise.resolve();
    }

    createBuffer() {
      calls.silentBuffers += 1;
      return { silent: true };
    }

    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        connectedTo: null,
        started: false,
        connect(node) {
          this.connectedTo = node;
        },
        start() {
          this.started = true;
          calls.starts.push(source);
        },
        stop() {
          this.stopped = true;
        }
      };
      return source;
    }

    createGain() {
      const node = {
        gain: {
          setValueAtTime(value, time) {
            calls.gains.push({ value, time });
          }
        },
        connect() {}
      };
      return node;
    }

    decodeAudioData(data, success) {
      calls.decoded += 1;
      assert.ok(data instanceof ArrayBuffer, 'decodeAudioData debe recibir el MP3');
      success(decodedBuffer);
      return Promise.resolve(decodedBuffer);
    }
  }

  return { calls, FakeAudioContext, decodedBuffer };
}

test('la victoria precarga el MP3, aplica volumen y solo suena tras desbloquear', async () => {
  const { calls, FakeAudioContext, decodedBuffer } = createAudioHarness();
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);

  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer
    };
  };

  try {
    const { createSfx, WIN_SOUND_SRC } = await import(SFX_URL);
    assert.equal(WIN_SOUND_SRC, '/src/assets/AUDIO-WIN-2.MP3');

    const sfx = createSfx();
    await wait();

    assert.equal(calls.fetch.length, 1, 'createSfx debe iniciar la precarga una sola vez');
    assert.equal(calls.fetch[0].url, WIN_SOUND_SRC);
    assert.deepEqual(calls.fetch[0].options, {
      cache: 'force-cache',
      credentials: 'same-origin'
    });

    /* Aun sin gesto no debe existir AudioContext ni decodificacion. */
    assert.equal(calls.decoded, 0, 'La precarga de red no debe decodificar antes del gesto');

    sfx.unlock();
    sfx.unlock();
    await wait();

    assert.equal(calls.decoded, 1, 'El MP3 debe decodificarse una sola vez');
    assert.equal(calls.silentBuffers, 1, 'El gesto debe desbloquear una sola vez');
    assert.equal(
      calls.starts.filter((source) => source.buffer && source.buffer.silent).length,
      1,
      'El desbloqueo debe arrancar un unico buffer silencioso'
    );

    sfx.win();
    sfx.win();

    const winStarts = calls.starts.filter((source) => source.buffer === decodedBuffer);
    assert.equal(winStarts.length, 2, 'Cada victoria inicia su propia fuente');
    assert.equal(winStarts[0].connectedTo.gain !== undefined, true);
    assert.deepEqual(calls.gains, [
      { value: 0.62, time: 1.25 },
      { value: 0.62, time: 1.25 }
    ]);
    assert.ok(
      winStarts.every((source) => source.stopped !== true),
      'Dos victorias seguidas deben solaparse sin cortarse'
    );

    sfx.setMuted(true);
    assert.ok(winStarts.every((source) => source.stopped === true), 'El mute debe detener todas las voces');
    sfx.win();
    assert.equal(
      calls.starts.filter((source) => source.buffer === decodedBuffer).length,
      2,
      'El mute no debe reproducir el MP3'
    );

    /* El techo de voces protege la salida sin bloquear los premios nuevos. */
    sfx.setMuted(false);
    for (let index = 0; index < 4; index += 1) sfx.win();

    const burst = calls.starts.filter((source) => source.buffer === decodedBuffer).slice(-4);
    assert.equal(burst.length, 4, 'Cada victoria debe arrancar aunque ya haya voces activas');
    assert.equal(burst[0].stopped, true, 'La voz mas antigua sale al superar el techo');
    assert.ok(
      burst.slice(1).every((source) => source.stopped !== true),
      'Las tres voces mas recientes deben seguir sonando'
    );
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
