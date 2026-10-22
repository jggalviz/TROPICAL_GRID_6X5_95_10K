# Modo "Fichas de Prueba" (Jugar Gratis)

Sesión de invitado con saldo **virtual** para probar el slot sin IdP, sin token real
y sin tocar Supabase. El motor es exactamente el mismo (`gridEngine.playRound`), por
lo que la matriz 6x5, las cascadas y el RTP son los certificados.

## Flujo

```
Navegador                     Backend
   │  clic "Fichas de Prueba"    │
   ├── POST /api/demo/session ──►│  token firmado con claim `demo: true`
   │◄── { token, 1.000,00 VES } ─┤  + cartera virtual en memoria
   │                             │
   ├── POST /api/spin ──────────►│  resolveCaller(): isDemo = true
   │   Authorization: Bearer …   │  gridEngine.playRound()
   │   { betCents, clientSeed }  │  demoWallet.commit()  (sin Supabase)
   │◄── grid, cascades, balance ─┤  balance.cents ficticio
```

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/api/demo/session` | Emite token demo + saldo inicial virtual. Body opcional `{ "playerId": "invitado_demo" }` (alias 3–32 chars). |
| POST | `/api/spin` | Con token demo, o sin token + `{ "demo": true }` / `"playerId": "invitado_demo"`. Devuelve `demo: true`. |
| GET | `/api/player` | Con token demo devuelve `demo: true`, `balance` y `stats` de la cartera virtual. |
| GET | `/api/game` | Publica `game.demo` (`enabled`, `currency`, `startBalanceCredits`…). |

```bash
# 1) Abrir sesión de invitado
curl -s -X POST http://localhost:3000/api/demo/session \
  -H "Content-Type: application/json" \
  -d '{"playerId":"invitado_demo"}'

# 2) Girar con el token devuelto (tirada de 1,00 crédito)
curl -s -X POST http://localhost:3000/api/spin \
  -H "Authorization: Bearer t1.…" \
  -H "Content-Type: application/json" \
  -d '{"betCents":100,"clientSeed":"demo-1","roundRef":"demo-ref-1"}'
```

## Reglas de seguridad

- `isDemo = !player` en `/api/spin`: sin token de jugador real la ronda se liquida
  en la cartera virtual. Un token **inválido o caducado sigue dando 401** (no se
  degrada a demo).
- `requireAuth()` rechaza tokens con `demo: true` (`DEMO_TOKEN_NOT_ALLOWED`), así
  que un token de invitado no puede operar sobre saldo real.
- Un jugador real que envíe `demo: true` recibe `400 DEMO_MODE_CONFLICT`.
- El saldo es autoritativo del servidor, con idempotencia por `roundRef`, tope de
  rondas memorizadas y TTL deslizante. Nunca queda negativo (402).
- Todas las carteras viven en RAM (`server/services/demoWallet.js`): al reiniciar
  el proceso los invitados vuelven a 1.000,00.

## Variables de entorno

Ver `.env.example` → bloque *Fichas de Prueba*: `DEMO_MODE_ENABLED`,
`DEMO_GUEST_ID`, `DEMO_CURRENCY`, `DEMO_START_BALANCE_CENTS`,
`DEMO_SESSION_TTL_MS`, `DEMO_TOKEN_TTL_SECONDS`, `DEMO_MAX_SESSIONS`,
`DEMO_MAX_IDEMPOTENT_ROUNDS`.

## Piezas implicadas

| Capa | Archivo |
| --- | --- |
| Botón y estilos | `public/index.html` (`#btn-demo`), `public/src/css/style.css` (`.btn--demo`, `body.is-demo`) |
| Cliente | `public/src/js/main.js`, `public/src/js/gameClient.js` (`startDemoMode`), `public/src/js/sessionClient.js`, `public/src/js/apiClient.js`, `public/src/js/uiManager.js` (`setDemoMode`, `showAuthGate`) |
| Sesión demo | `server/routes/session.js`, `server/auth/sessionToken.js`, `server/middleware/auth.js` (`resolveCaller`) |
| Cartera virtual | `server/services/demoWallet.js`, `server/services/gameService.js` (`playDemoRound`) |
| Ruta de juego | `server/routes/game.js`, `server/config.js`, `server/middleware/rateLimit.js` |
| Tests | `test/demoMode.test.js` |

## En Vercel

El despliegue (preset Express, `public/**` en el CDN y `server.js` como entry)
está descrito en [`DEPLOY_VERCEL.md`](./DEPLOY_VERCEL.md). Ten en cuenta que la
cartera demo vive en RAM por instancia: si Vercel atiende la petición con otra
instancia, se recrea con el saldo inicial (1.000,00) en lugar de fallar. Para
una demo pública es aceptable; para continuidad estricta entre instancias hace
falta un almacén compartido con TTL.
