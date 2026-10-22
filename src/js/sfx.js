/**
 * Efectos de sonido sintetizados con WebAudio.
 *
 * No se cargan ficheros de audio: la CSP del servidor solo permite recursos
 * propios y esto mantiene el cliente sin dependencias ni assets binarios.
 * Todo fallo de audio se ignora en silencio (el juego nunca depende del sonido).
 */

export function createSfx({ muted = false } = {}) {
  let context = null;
  let isMuted = muted;

  function ensureContext() {
    if (isMuted) return null;
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

  return {
    unlock() {
      const ctx = ensureContext();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    },
    setMuted(value) {
      isMuted = Boolean(value);
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
    win(level = 'win') {
      const arpeggio = {
        win: [523.25, 659.25],
        big: [523.25, 659.25, 783.99],
        mega: [523.25, 659.25, 783.99, 1046.5],
        epic: [523.25, 659.25, 783.99, 1046.5, 1318.5]
      }[level] || [523.25, 659.25];

      arpeggio.forEach((freq, index) => {
        tone({ freq, duration: 0.18, type: 'triangle', volume: 0.05, delay: index * 0.085 });
      });
    },
    error() {
      tone({ freq: 220, toFreq: 140, duration: 0.22, type: 'sawtooth', volume: 0.045 });
    }
  };
}
