/**
 * Punto de entrada del cliente visual.
 *
 * El cliente no conoce el motor ni las probabilidades: todo lo que muestra
 * viene de /api/game (informacion publica) y de las respuestas de /api/spin.
 */

import { ApiClient, ApiError } from './apiClient.js';
import { SessionManager } from './sessionClient.js';
import { createSfx } from './sfx.js';
import { Ui } from './uiManager.js';
import { GameClient } from './gameClient.js';

function describe(error) {
  if (error instanceof ApiError) return error.message;
  if (error && error.message) return error.message;
  return 'Error inesperado.';
}

function bootstrap() {
  const ui = new Ui();
  ui.mount();

  let session = null;
  const api = new ApiClient({ getToken: () => (session ? session.current() : null) });
  session = new SessionManager(api);

  const sfx = createSfx();
  const game = new GameClient({ api, ui, sfx, session });

  /* --- Controles --- */
  ui.refs.spinBtn.addEventListener('click', () => {
    if (game.autoRunning) return;
    void game.spin();
  });

  ui.refs.featureBtn.addEventListener('click', () => {
    if (game.autoRunning) game.stopAuto('Automático detenido');
    void game.spin({ buyFeature: true });
  });

  ui.refs.autoBtn.addEventListener('click', () => game.toggleAuto());
  ui.refs.betUp.addEventListener('click', () => game.changeBet(1));
  ui.refs.betDown.addEventListener('click', () => game.changeBet(-1));
  ui.refs.betMax.addEventListener('click', () => game.setMaxBet());

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (!document.getElementById('modal').hidden) return;

    if (event.code === 'Space' || event.key === 'Enter') {
      event.preventDefault();
      if (!ui.busy && !game.autoRunning) void game.spin();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      game.changeBet(1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      game.changeBet(-1);
    }
  });

  /* --- Arranque --- */
  const start = () => game.boot().catch((error) => {
    ui.setBusy(false);
    if (error && (error.code === 'SESSION_REQUIRED' || (error instanceof ApiError && error.isAuth))) {
      ui.setStatus('Sesión requerida');
      ui.showAuthGate((token) => {
        session.setToken(token);
        ui.setStatus('Verificando token…');
        start();
      });
      return;
    }
    ui.setStatus(`Sin conexión · ${(error && error.code) || 'ERROR'}`);
    ui.toast(describe(error), { type: 'error', timeout: 6000 });
    // eslint-disable-next-line no-console
    console.error('[tropical-grid] fallo de arranque:', error);
  });

  start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
