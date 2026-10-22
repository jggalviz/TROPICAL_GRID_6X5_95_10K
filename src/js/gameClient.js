/**
 * Orquestador del cliente.
 *
 * Responsabilidades:
 *   - Pedir SIEMPRE el resultado al servidor (nunca calcularlo aqui).
 *   - Reproducir la animacion de la respuesta.
 *   - Gestionar apuesta, automatico y refresco de sesion.
 *
 * La clave de idempotencia (`roundRef`) se genera una vez por tirada y se
 * reutiliza en el reintento: si la red falla despues de que el servidor ya
 * guardo la ronda, el reintento devuelve la misma ronda y no vuelve a cobrar.
 */

import { ApiError } from './apiClient.js';
import { TIMING, sleep, winLevel } from './uiManager.js';
import { formatCents, formatCredits, makeClientSeed, makeRoundRef } from './format.js';

const AUTO_SPINS = 10;
const RETRY_DELAY_MS = 320;

const DEFAULT_LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

const ERROR_TEXT = {
  INSUFFICIENT_FUNDS: 'Saldo insuficiente para esta apuesta.',
  RATE_LIMITED: 'Demasiadas peticiones seguidas. Espera un instante.',
  INVALID_BET: 'La apuesta no es válida.',
  INVALID_ROUND_REF: 'Referencia de ronda inválida. Recarga la página.',
  PLAYER_BLOCKED: 'La cuenta está suspendida.',
  TOKEN_MISSING: 'Sesión no válida. Vuelve a iniciar sesión.',
  TOKEN_INVALID: 'Sesión no válida o expirada.',
  TOKEN_EXPIRED: 'Sesión expirada. Vuelve a iniciar sesión.',
  SESSION_REQUIRED: 'Necesitas un token de sesión válido.',
  DEMO_DISABLED: 'El modo Fichas de Prueba está desactivado en este servidor.',
  DEMO_MODE_CONFLICT: 'No puedes usar fichas de prueba con una sesión real activa.',
  DEMO_TOKEN_NOT_ALLOWED: 'Ese token es de prueba y no permite jugar con saldo real.',
  NETWORK_ERROR: 'Sin conexión con el servidor.',
  TIMEOUT: 'El servidor no respondió a tiempo.',
  INTERNAL_ERROR: 'Error interno del servidor. Inténtalo más tarde.'
};

export class GameClient {
  constructor({ api, ui, sfx, session }) {
    this.api = api;
    this.ui = ui;
    this.sfx = sfx;
    this.session = session;

    this.gameInfo = null;
    this.betLadder = DEFAULT_LADDER.slice();
    this.betIndex = DEFAULT_LADDER.indexOf(1);
    this.balanceCents = 0;
    this.isDemo = false;
    this.busy = false;
    this.autoRunning = false;
    this.autoRemaining = 0;

    this.ui.handlers.onSound = () => this.toggleSound();
  }

  /* ------------------------------------------------------------- arranque */

  async boot() {
    this.ui.setStatus('Cargando juego…');
    const gamePayload = await this.api.gameInfo();
    this.gameInfo = gamePayload.game;
    this.ui.setGameInfo(this.gameInfo);

    if (Array.isArray(this.gameInfo.betLadder) && this.gameInfo.betLadder.length > 0) {
      this.betLadder = this.gameInfo.betLadder.slice();
    }
    const preferred = this.betLadder.indexOf(1);
    this.betIndex = preferred >= 0 ? preferred : 0;
    this.ui.setBet(this.betCredits);

    await this.connect();
  }

  async connect() {
    const resolved = await this.session.resolve();
    this.ui.setStatus(resolved.source === 'dev' ? 'Sesión de demostración' : 'Sincronizando sesión…');

    try {
      await this.loadPlayer();
    } catch (error) {
      if (!(error instanceof ApiError) || !error.isAuth) throw error;
      this.session.invalidate();
      await this.session.resolve();
      await this.loadPlayer();
    }
  }

  async loadPlayer() {
    const payload = await this.api.player();
    this.balanceCents = payload.balance.cents;
    this.isDemo = payload.demo === true;

    this.ui.setCurrency(payload.balance.currency);
    this.ui.setBalance(payload.balance.credits);
    this.ui.setDemoMode(this.isDemo);
    this.ui.setRoundInfo({ state: this.isDemo ? 'Modo prueba' : 'Lista' });
    this.ui.setStatus(
      this.isDemo
        ? `Fichas de Prueba · ${formatCredits(payload.balance.credits)} ${payload.balance.currency}`
        : `Jugador ${payload.player.displayName}`
    );
    this.ui.updateAffordability(this.balanceCents, this.betCents);
    return payload;
  }

  /* ------------------------------------------------------- fichas de prueba */

  /**
   * Abre una sesion de invitado con saldo virtual ("Fichas de Prueba").
   *
   * El backend emite un token con el claim `demo: true` y una cartera virtual de
   * 1.000,00 VES. El cliente NO fija ni calcula el saldo: solo pinta el que
   * devuelve el servidor en cada ronda.
   */
  async startDemoMode() {
    if (this.busy) return null;
    if (this.autoRunning) this.stopAuto('Automático detenido');

    this.sfx.unlock();
    this.sfx.click();
    this.ui.setStatus('Cargando fichas de prueba…');

    try {
      const payload = await this.session.startDemoSession();
      this.isDemo = true;
      this.balanceCents = payload.balance.cents;

      this.ui.setCurrency(payload.balance.currency);
      this.ui.setBalance(payload.balance.credits);
      this.ui.setDemoMode(true);
      this.ui.setWin(0);
      this.ui.setMultiplier(null);
      this.ui.setRoundInfo({ state: 'Modo prueba' });
      this.ui.setStatus(
        `Fichas de Prueba · ${formatCredits(payload.balance.credits)} ${payload.balance.currency}`
      );
      this.ui.updateAffordability(this.balanceCents, this.betCents);
      this.ui.toast(
        `Fichas de prueba listas: ${formatCredits(payload.balance.credits)} ${payload.balance.currency} virtuales.`,
        { type: 'info', timeout: 5200 }
      );
      return payload;
    } catch (error) {
      this.handleError(error);
      return null;
    }
  }

  /* ---------------------------------------------------------------- apuesta */

  get betCredits() {
    return this.betLadder[this.betIndex];
  }

  get betCents() {
    return Math.round(this.betCredits * 100);
  }

  get featureCostMultiplier() {
    return (this.gameInfo && this.gameInfo.feature && this.gameInfo.feature.costMultiplier) || 100;
  }

  get featureCostCents() {
    return this.betCents * this.featureCostMultiplier;
  }

  changeBet(direction) {
    if (this.busy || this.autoRunning) return;
    const next = Math.min(this.betLadder.length - 1, Math.max(0, this.betIndex + direction));
    if (next === this.betIndex) {
      this.ui.toast(direction > 0 ? 'Apuesta máxima alcanzada.' : 'Apuesta mínima alcanzada.');
      return;
    }
    this.betIndex = next;
    this.ui.setBet(this.betCredits);
    this.ui.updateAffordability(this.balanceCents, this.betCents);
    this.sfx.click();
  }

  setMaxBet() {
    if (this.busy || this.autoRunning) return;
    this.betIndex = this.betLadder.length - 1;
    this.ui.setBet(this.betCredits);
    this.ui.updateAffordability(this.balanceCents, this.betCents);
    this.sfx.click();
  }

  toggleSound() {
    const muted = !this.sfx.isMuted();
    this.sfx.setMuted(muted);
    const button = this.ui.refs.soundBtn;
    button.textContent = muted ? '🔇' : '🔊';
    button.setAttribute('aria-pressed', muted ? 'false' : 'true');
    if (!muted) this.sfx.click();
  }

  /* ---------------------------------------------------------------- tiradas */

  async spin({ buyFeature = false } = {}) {
    if (this.busy) return null;

    const wagerCents = buyFeature ? this.featureCostCents : this.betCents;
    if (this.balanceCents < wagerCents) {
      this.sfx.error();
      this.ui.toast(
        buyFeature ? 'Saldo insuficiente para Tropical Fever.' : 'Saldo insuficiente para esta apuesta.',
        { type: 'error' }
      );
      return null;
    }

    this.sfx.unlock();
    this.busy = true;
    this.ui.setBusy(true);
    this.ui.hideBanner();
    this.ui.setMultiplier(null);
    this.ui.setWin(0);
    this.ui.setStatus(buyFeature ? 'Comprando Tropical Fever…' : 'Resolviendo tirada…');

    const balanceBefore = this.balanceCents;
    const roundRef = makeRoundRef();
    const clientSeed = makeClientSeed();

    try {
      const round = await this.requestSpin({
        betCents: this.betCents,
        buyFeature,
        roundRef,
        clientSeed
      });

      this.balanceCents = round.balance.cents;
      this.ui.setCurrency(round.balance.currency);
      this.ui.setBalance(round.balance.credits, { deltaCents: round.balance.cents - balanceBefore });

      /* El backend marca cada ronda demo: la UI lo refleja al instante. */
      this.isDemo = round.demo === true;
      this.ui.setDemoMode(this.isDemo);

      await this.present(round);

      this.ui.addHistory({
        winCents: round.totalWinCents,
        betCents: round.betCents,
        mode: round.mode,
        spins: round.spinsPlayed
      });
      this.ui.setRoundInfo({
        state: round.replayed ? 'Repetida' : 'Completada',
        roundId: round.roundId,
        serverSeedHash: round.audit.serverSeedHash,
        clientSeed: round.audit.clientSeed,
        rngDraws: round.audit.rngDraws
      });
      this.ui.setStatus(
        `${this.isDemo ? 'Prueba · ' : ''}${round.mode === 'BUY_FEATURE' ? 'Bonus' : 'Base'} · ${round.spinsPlayed} giro(s)`
      );

      return round;
    } catch (error) {
      this.handleError(error);
      return null;
    } finally {
      this.busy = false;
      this.ui.setBusy(false);
      this.ui.updateAffordability(this.balanceCents, this.betCents);
    }
  }

  /**
   * Peticion con un maximo de dos reintentos: uno por token caducado y otro por
   * fallo de red. Ambos reutilizan la MISMA `roundRef`.
   */
  async requestSpin(payload) {
    let retries = 0;
    for (;;) {
      try {
        return await this.api.spin(payload);
      } catch (error) {
        const apiError = error instanceof ApiError ? error : null;
        if (!apiError) throw error;

        if (apiError.isAuth && retries === 0) {
          retries += 1;
          /* Si estabamos en demo se renueva la sesion demo: nunca se cae a una
             sesion real (ni a su saldo) por un token de invitado caducado. */
          const wasDemo = this.session.isDemo || this.isDemo;
          this.session.invalidate();
          if (wasDemo) {
            await this.session.startDemoSession();
          } else {
            await this.session.resolve();
          }
          continue;
        }

        if (apiError.kind === 'network' && retries === 0) {
          retries += 1;
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        throw error;
      }
    }
  }

  /* ------------------------------------------------------------- animacion */

  async present(round) {
    const spins = Array.isArray(round.spins) ? round.spins : [];
    const isFeature = round.mode === 'BUY_FEATURE';
    const last = spins[spins.length - 1];

    if (round.replayed) {
      this.ui.clearHighlights();
      this.ui.renderGrid(
        last ? last.finalGrid : round.finalGrid,
        last ? last.bombs : round.bombs,
        { drop: false }
      );
      this.ui.setWin(round.totalWinCents);
      this.ui.setMultiplier(isFeature ? null : round.multiplier);
      this.ui.toast('Ronda ya registrada: no se ha vuelto a cobrar.', { type: 'info' });
      return;
    }

    this.ui.startSpinning();
    this.ui.setSpinTag(isFeature ? `Bonus · ${spins.length} giros` : 'Tirada');
    this.sfx.spin();
    await sleep(TIMING.reel);
    this.ui.setSpinTag(null);

    let runningWinCents = 0;
    for (let index = 0; index < spins.length; index += 1) {
      runningWinCents = await this.presentSpin(spins[index], {
        index,
        total: spins.length,
        isFeature,
        runningWinCents
      });
    }

    this.ui.setSpinTag(null);
    this.ui.clearHighlights();
    if (!isFeature) this.ui.setMultiplier(round.multiplier);

    const total = round.totalWinCents;
    this.ui.setWin(total);

    if (total > 0) {
      const level = winLevel(total, round.betCents);
      this.ui.showBanner(level.key, formatCents(total));
      this.sfx.win(level.key);
      setTimeout(() => this.ui.hideBanner(), 2200);
    }

    if (round.maxWinReached) {
      this.ui.toast('Tope de ganancia alcanzado: 10.000× la apuesta.', { type: 'info' });
    }
  }

  /**
   * Anima una tirada concreta (una en modo base, hasta 10 en el bonus).
   * @returns {Promise<number>} ganancia acumulada mostrada
   */
  async presentSpin(spin, { index, total, isFeature, runningWinCents = 0 }) {
    if (isFeature) {
      this.ui.setSpinTag(`Giro ${index + 1}/${total}`);
      await sleep(TIMING.settle);
    }

    this.ui.clearHighlights();
    const firstBombs = spin.cascades && spin.cascades.length ? spin.cascades[0].bombs : spin.bombs;
    this.ui.renderGrid(spin.initialGrid, firstBombs, { drop: true });
    this.sfx.drop(index);
    await sleep(TIMING.drop);

    if (spin.scatter && spin.scatter.count >= 3) {
      this.ui.highlightCells(spin.scatter.cells, 'tile--scatter');
      this.sfx.cluster(12);
      this.ui.toast(`Flor ×${spin.scatter.count}: +${formatCents(spin.scatter.payCents)}`, {
        type: 'info',
        timeout: 2600
      });
      await sleep(TIMING.settle);
    }

    let running = runningWinCents;
    let bombsSeen = (firstBombs || []).length;

    for (const step of spin.cascades || []) {
      const cells = (step.clusters || []).flatMap((cluster) => cluster.cells);
      const biggest = (step.clusters || []).reduce((max, cluster) => Math.max(max, cluster.size), 8);

      this.ui.highlightCells(cells);
      this.sfx.cluster(biggest);
      await sleep(TIMING.hold);
      await this.ui.popCells(cells);

      running += step.winCents;
      this.ui.setWin(running);

      const bombsAfter = step.bombsAfter || [];
      this.ui.renderGrid(step.gridAfter, bombsAfter, { drop: true });
      if (bombsAfter.length > bombsSeen) {
        this.sfx.bomb();
        this.ui.shakeGrid();
      }
      bombsSeen = bombsAfter.length;
      this.sfx.drop(step.index + 1);
      await sleep(TIMING.drop);
    }

    this.ui.clearHighlights();
    /* En el bonus cada giro tiene su propio multiplicador de bombas. */
    if (isFeature) this.ui.setMultiplier(spin.multiplier);
    return running;
  }

  /* ------------------------------------------------------------ automatico */

  toggleAuto() {
    if (this.autoRunning) {
      this.stopAuto('Automático detenido');
      return;
    }
    if (this.busy) return;

    this.sfx.unlock();
    this.sfx.click();
    this.autoRunning = true;
    this.autoRemaining = AUTO_SPINS;
    this.ui.setAuto(true, this.autoRemaining);
    this.ui.setStatus(`Automático · ${this.autoRemaining} tiradas`);
    void this.runAuto();
  }

  async runAuto() {
    while (this.autoRunning && this.autoRemaining > 0) {
      const round = await this.spin();
      if (!round) {
        this.stopAuto('Automático detenido');
        return;
      }

      this.autoRemaining -= 1;
      this.ui.setAuto(this.autoRemaining > 0, this.autoRemaining);

      if (this.autoRemaining <= 0) break;
      if (round.maxWinReached) {
        this.ui.toast('Tope alcanzado: automático detenido.');
        break;
      }
      if (this.balanceCents < this.betCents) {
        this.ui.toast('Saldo insuficiente: automático detenido.', { type: 'error' });
        break;
      }
      await sleep(420);
    }
    this.stopAuto();
  }

  stopAuto(message) {
    this.autoRunning = false;
    this.autoRemaining = 0;
    this.ui.setAuto(false, 0);
    this.ui.setStatus(message || 'Lista');
  }

  /* --------------------------------------------------------------- errores */

  handleError(error) {
    this.sfx.error();
    const code = (error && error.code) || 'UNKNOWN';
    const text = ERROR_TEXT[code] || (error && error.message) || 'Error inesperado.';
    this.ui.toast(text, { type: 'error', timeout: 5200 });
    this.ui.setStatus(`Error · ${code}`);

    if (code === 'SESSION_REQUIRED' || (error instanceof ApiError && error.isAuth)) {
      this.ui.showAuthGate({
        onSubmit: (token) => {
          this.session.setToken(token);
          this.ui.setStatus('Verificando token…');
          this.connect().catch((inner) => this.handleError(inner));
        },
        /* Alternativa para jugar sin token real: fichas de prueba. */
        onDemo: () => {
          void this.startDemoMode();
        }
      });
    }
  }
}
