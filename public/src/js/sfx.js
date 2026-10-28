/**
 * Efectos de sonido del cliente.
 *
 * Los efectos cortos se sintetizan con WebAudio. La victoria usa el MP3 propio
 * `AUDIO-WIN-2.MP3`: se precarga con `fetch`, se decodifica en el AudioContext
 * desbloqueado por el primer gesto del jugador y se reproduce con un
 * `GainNode` que fija el volumen. Las victorias encadenadas usan voces
 * simultaneas (con un techo) para que ninguna cascada quede muda.
 *
 * El asset y la peticion son del mismo origen, por lo que encajan con la CSP
 * (`default-src 'self'` / `connect-src 'self'`). Todo fallo de audio se ignora
 * en silencio: el juego nunca depende del sonido.
 */

export const WIN_SOUND_SRC = '/src/assets/AUDIO-WIN-2.MP3';

/* Volumen lineal del MP3 (0-1): presente pero sin tapar los efectos cortos. */
const WIN_SOUND_VOLUME = 0.62;

/* Cascadas encadenadas: se permite que varias victorias suenen a la vez, pero
   con un techo para no saturar la salida ni acumular fuentes sin control. */
const MAX_WIN_VOICES = 3;

export function createSfx({ muted = false } = {}) {
  let context = null;
  let isMuted = muted;
  let gestureUnlocked = false;
  let winAudioData = null;
  let winAudioPromise = null;
  let winBuffer = null;
  let winBufferPromise = null;
  let activeWinSources = new Set();

  function ensureContext() {
    if (isMuted || typeof window === 'undefined') return null;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      if (!context) context = new Ctor();
      if (context.state === 'suspended') context.resume().catch(() => {});
      return context;
    } catch {
      return null;
    }
  }

  /**
   * Desbloquea el contexto dentro del gesto del jugador. Un buffer silencioso
   * de una muestra cubre iOS/Safari incluso si el primer sonido real llega
   * despues de la respuesta del servidor, ya fuera del gesto.
   */
  function unlockContext(ctx) {
    const resumed = ctx.state === 'suspended' ? ctx.resume() : null;
    if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});

    if (gestureUnlocked) return;
    gestureUnlocked = true;
    try {
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const source = ctx.createBufferSource();
      source.buffer = silent;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      /* el contexto seguira intentando reproducir con normalidad */
    }
  }

  /** Detiene y libera una voz concreta (o todas si no se pasa ninguna). */
  function stopWinSource(source) {
    if (!source) return;
    activeWinSources.delete(source);
    try {
      source.stop();
    } catch {
      /* la fuente ya habia terminado */
    }
  }

  function stopWinSound() {
    for (const source of [...activeWinSources]) stopWinSource(source);
  }

  function preloadWinSound() {
    if (winAudioPromise) return winAudioPromise;
    if (typeof window === 'undefined' || typeof fetch !== 'function') {
      winAudioPromise = Promise.resolve(null);
      return winAudioPromise;
    }

    winAudioPromise = fetch(WIN_SOUND_SRC, {
      cache: 'force-cache',
      credentials: 'same-origin'
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => {
        winAudioData = data;
        return data;
      })
      .catch(() => null);

    return winAudioPromise;
  }

  /** Decodifica el MP3 una sola vez; sin contexto valido devuelve `null`. */
  function decodeWinSound(ctx) {
    if (!ctx) return Promise.resolve(null);
    if (winBuffer) return Promise.resolve(winBuffer);
    if (winBufferPromise) return winBufferPromise;

    winBufferPromise = (winAudioData ? Promise.resolve(winAudioData) : preloadWinSound())
      .then((data) => {
        if (!data) return null;
        return new Promise((resolve) => {
          try {
            /* Safari antiguo solo admite callbacks; Chrome devuelve promesa. */
            const decoding = ctx.decodeAudioData(
              data.slice(0),
              (buffer) => resolve(buffer),
              () => resolve(null)
            );
            if (decoding && typeof decoding.then === 'function') {
              decoding.then(resolve).catch(() => resolve(null));
            }
          } catch {
            resolve(null);
          }
        });
      })
      .then((buffer) => {
        winBuffer = buffer;
        return buffer;
      })
      .catch(() => null);

    return winBufferPromise;
  }

  function playWinSound(ctx, buffer) {
    if (!ctx || !buffer || isMuted) return;

    /* Cada premio inicia su propia voz para que las cascadas encadenadas no se
       corten entre si. Si se supera el techo, sale la victoria mas antigua:
       el premio nuevo siempre se oye de inmediato. */
    while (activeWinSources.size >= MAX_WIN_VOICES) {
      stopWinSource(activeWinSources.values().next().value);
    }

    let source = null;
    try {
      source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime(WIN_SOUND_VOLUME, ctx.currentTime);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => activeWinSources.delete(source);
      activeWinSources.add(source);
      source.start(0);
    } catch {
      if (source) activeWinSources.delete(source);
      /* audio no disponible */
    }
  }

  function tone({ freq = 440, toFreq = null, duration = 0.12, type = 'sine', volume = 0.06, delay = 0 }) {
    const ctx = ensureContext();
    if (!ctx) return;
    try {
      const startAt = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startAt);
      if (toFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), startAt + duration);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    } catch {
      /* audio no disponible */
    }
  }

  /* La red se precarga en cuanto se crea el reproductor. La decodificacion
     espera al primer gesto para no crear un AudioContext bloqueado. */
  void preloadWinSound();

  return {
    unlock() {
      void preloadWinSound();
      const ctx = ensureContext();
      if (!ctx) return;
      unlockContext(ctx);
      /* Deja el buffer listo antes de que llegue el resultado del servidor. */
      void decodeWinSound(ctx);
    },
    setMuted(value) {
      isMuted = Boolean(value);
      if (isMuted) stopWinSound();
    },
    isMuted() {
      return isMuted;
    },
    click() {
      tone({ freq: 520, toFreq: 640, duration: 0.07, type: 'triangle', volume: 0.05 });
    },
    spin() {
      tone({ freq: 180, toFreq: 320, duration: 0.28, type: 'sawtooth', volume: 0.035 });
    },
    drop(index = 0) {
      tone({ freq: 300 + index * 18, toFreq: 190, duration: 0.1, type: 'sine', volume: 0.03 });
    },
    cluster(size = 8) {
      const base = 420 + Math.min(size, 20) * 16;
      tone({ freq: base, toFreq: base * 1.5, duration: 0.16, type: 'triangle', volume: 0.045 });
    },
    bomb() {
      tone({ freq: 150, toFreq: 60, duration: 0.3, type: 'square', volume: 0.04 });
      tone({ freq: 320, toFreq: 120, duration: 0.24, type: 'sawtooth', volume: 0.025, delay: 0.03 });
    },
    win() {
      if (isMuted) return;
      const ctx = ensureContext();
      if (!ctx) return;
      unlockContext(ctx);

      if (winBuffer) {
        playWinSound(ctx, winBuffer);
        return;
      }

      /* Si la decodificacion aun no termino, reproduce en cuanto este lista. */
      void decodeWinSound(ctx).then((buffer) => playWinSound(ctx, buffer));
    },
    error() {
      tone({ freq: 220, toFreq: 140, duration: 0.22, type: 'sawtooth', volume: 0.045 });
    }
  };
}
