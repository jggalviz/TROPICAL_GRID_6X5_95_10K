# PANA CRUSH — Guía de despliegue en AWS

- **Repositorio:** `TROPICAL_GRID_6X5_95_10K` (marca visible: PANA CRUSH).
- **Audiencia:** equipo de DevOps / plataforma AWS.
- **Alcance:** publicar el frontend estático de PANA CRUSH y conectarlo con el backend autoritativo (Express + Supabase) en AWS.
- **Estado verificado:** 26/10/2026 — `npm test` → **104/104 tests en verde**.
- **Documentos relacionados:** [`docs/DEPLOY_VERCEL.md`](docs/DEPLOY_VERCEL.md) (despliegue serverless ya soportado), [`docs/MATH_MODEL.md`](docs/MATH_MODEL.md), [`docs/DEMO_MODE.md`](docs/DEMO_MODE.md), [`.env.example`](.env.example).

---

## Índice

1. [Descripción general del proyecto](#1-descripción-general-del-proyecto)
2. [Requisitos de entorno y variables](#2-requisitos-de-entorno-y-variables)
3. [Pasos para la compilación (build)](#3-pasos-para-la-compilación-build)
4. [Recomendaciones de hosting en AWS](#4-recomendaciones-de-hosting-en-aws)
5. [Pruebas de verificación post-despliegue](#5-pruebas-de-verificación-post-despliegue)
6. [Checklist de salida a producción](#6-checklist-de-salida-a-producción)
7. [Anexos](#7-anexos)

---

## 1. Descripción general del proyecto

### 1.1 Qué es PANA CRUSH

PANA CRUSH es un **slot de agrupaciones (cluster pays) 6×5**, con **RTP 95 %** y **ganancia máxima de 10.000×**. La decisión de cada ronda, la selección de símbolos, los multiplicadores, el saldo y la idempotencia se calculan **en el servidor**; el navegador solo presenta la información y envía la intención de giro.

El frontend es una **SPA estática** construida en HTML, CSS y JavaScript puro (módulos ES), sin framework, sin bundler y sin paso de transpilación. La capa visual busca una presentación tipo **AAA** (arte WebP, animaciones y efectos) manteniendo un artefacto estático y sin dependencias de framework. El motor gráfico y los assets están optimizados para ejecutarse directamente en el navegador: arte principal en **WebP**, tipografías **WOFF2** y símbolos en PNG con alfa.

| Capa | Tecnología | Ubicación en el repositorio |
| --- | --- | --- |
| Frontend (SPA) | HTML5 + CSS + JavaScript ES Modules | `public/index.html`, `public/src/css/`, `public/src/js/`, `public/src/assets/` |
| API REST | Node.js ≥ 20 + Express 4 (Helmet, CORS, Compression) | `server/`, `server/app.js`, `server/routes/` |
| Motor autoritativo | Módulo CommonJS del servidor (RTP certificado, paytable) | `server/engine/gridEngine.js` |
| Persistencia real | Supabase (PostgreSQL + RPC atómica `play_spin`) | `server/db/`, `sql/schema.sql` |
| Pruebas | `node:test` (runner nativo de Node) | `test/` (`npm test`) |

### 1.2 Arquitectura de ejecución

```text
┌──────────────────────────┐
│ Navegador (usuario)      │
│ HTML + CSS + JS estático │
└────────────┬─────────────┘
             │ HTTPS (mismo origen)
             ▼
┌───────────────────────────────────────────────┐
│ CloudFront (dominio público + TLS + caché)    │
│                                               │
│  /              → S3 (OAC) → index.html       │
│  /src/**        → S3 (OAC) → JS/CSS/assets    │
│  /api/**        → backend Express (sin caché) │
└──────────────────────────┬────────────────────┘
                           │
                           ▼
              ┌──────────────────────────┐
              │ Express (App Runner/ECS) │
              │ motor + sesión + API     │
              └────────────┬─────────────┘
                           │ HTTPS
                           ▼
              ┌──────────────────────────┐
              │ Supabase (PostgreSQL)    │
              │ saldos y rondas reales   │
              └──────────────────────────┘
```

> **Decisión importante:** la API se consume por **ruta relativa** (`/api/...`) y la CSP del proyecto es `connect-src 'self'`. La forma recomendada de desplegar en AWS es **servir el frontend en S3 + CloudFront y enrutar `/api/*` desde el mismo CloudFront hacia el backend**. Así el navegador ve un único origen y no hay que tocar el frontend ni relajar la CSP.

### 1.3 Tamaño y composición del artefacto estático

Medición real de `public/` en este repositorio:

| Tipo | Archivos | Tamaño | Notas |
| --- | ---: | ---: | --- |
| WebP (arte principal) | 9 | 2,16 MB | Fondos, marco, consola, logo y pantalla de victoria |
| PNG (símbolos) | 20 | 7,18 MB | Solo **11** están referenciados por `public/src/js/format.js` (3,83 MB); los otros 9 no se descargan |
| WOFF2 (tipografías) | 4 | 0,04 MB | Fredoka y Lilita One, precargadas desde `index.html` |
| JS + CSS | 11 | ≈ 0,37 MB | `style.css` concentra la mayor parte |
| **Total publicado** | **45** | **9,76 MB** | La app solo referencia 11 de los 20 PNG; los 9 restantes no se descargan |

Características que condicionan el despliegue:

- **Los nombres de archivo no incluyen hash de contenido** (por ejemplo `style.css`, `main.js`, `PANA-CRUSH-LOGO.webp`). Por eso el proyecto sirve JS/CSS con `Cache-Control: no-cache` y revalida en cada visita.
- **No hay minificación ni fingerprinting** en los scripts de `package.json`. Si el equipo quiere caché inmutable de un año para JS/CSS, primero debe añadir un paso de build con nombres hasheados (ver §4.7).
- **No hay rutas de cliente**: toda la aplicación vive en `/`. El "fallback a `index.html`" es una red de seguridad para rutas desconocidas, no un requisito de navegación interna.
- **No se usa WebSocket** en ninguna capa (ver §2.6).

### 1.4 Qué se publica y qué no

| Se publica en S3/CloudFront | **Nunca** se publica |
| --- | --- |
| `public/index.html` | `.env`, `.env.*` (secretos) |
| `public/src/css/**` | `server/**` (código y configuración del backend) |
| `public/src/js/**` | `sql/**` (esquema y RPC de Supabase) |
| `public/src/assets/**` | `test/**`, `scripts/**`, `docs/**`, `design/**` |
| | `node_modules/**`, `.git/**`, `.vercel/**` |

### 1.5 Fuera del alcance del repositorio

Para evitar suposiciones, esto **no existe hoy** en el repositorio y debe aportarlo el equipo de plataforma:

- No hay `Dockerfile` ni plantillas de infraestructura (Terraform, CDK, CloudFormation).
- No hay workflows de CI/CD (GitHub Actions u otros).
- No hay configuración de Vite (`VITE_*`) ni `.env.production` para el frontend.
- No hay adaptador para AWS Lambda: `server.js` exporta la app para el preset Express de Vercel, no para Lambda. Para Lambda haría falta un adaptador tipo `serverless-http` (no incluido).

---

## 2. Requisitos de entorno y variables

### 2.1 Toolchain necesario

| Herramienta | Versión / requisito | Uso |
| --- | --- | --- |
| Node.js | **≥ 20** (`engines` del `package.json`); recomendado 20 LTS o 22 LTS | Backend, pruebas y scripts de build |
| npm | El incluido con Node (lockfile v3) | `npm ci` / `npm test` |
| AWS CLI | v2 | S3, CloudFront, invalidaciones y verificación |
| Docker | 24+ (opcional) | Empaquetar el backend para ECS/App Runner |
| `sharp` | `devDependency` (binarios precompilados) | Solo para regenerar arte; **no** es dependencia de runtime |

No se necesita navegador headless, Vite, Webpack, Babel ni TypeScript para compilar o desplegar.

### 2.2 Configuración del frontend: no hay `VITE_API_BASE_URL`

> **Importante:** este proyecto **no usa Vite** y **no lee variables `VITE_*`**. No existe `.env.production` ni un `config.js` de runtime. El cliente crea `new ApiClient({ getToken })` en `public/src/js/main.js`; `ApiClient` usa `baseUrl = ''` por defecto (`public/src/js/apiClient.js`), por lo que **todas las llamadas van a `/api/...` en el mismo origen**.

| Elemento | Estado actual | Implicación para AWS |
| --- | --- | --- |
| `VITE_API_BASE_URL` | **No existe** | No la definas esperando que el frontend la lea: no hay código que la consuma |
| `.env.production` (frontend) | **No existe** | El frontend es estático puro; no hay build que inyecte variables |
| `public/src/js/config.js` | **No existe** | La URL base se define en `main.js`/`apiClient.js`, no en un archivo de config |
| `public/src/js/main.js` | `new ApiClient({ getToken: ... })` | `baseUrl` efectivo: `''` (mismo origen) |
| `public/src/js/apiClient.js` | `baseUrl = ''`, `credentials: 'omit'` | Token en `Authorization: Bearer`; no se usan cookies |
| CSP del proyecto | `connect-src 'self'` | El navegador **bloquea** llamadas a otro dominio si no se amplía la CSP |
| WebSocket | No se usa | No hay URL `wss://` que configurar |

#### Opción A — Mismo origen mediante CloudFront (recomendada)

El frontend y la API se publican bajo el mismo dominio (`https://pana-crush.example.com`). CloudFront enruta `/api/*` al backend y el resto a S3.

- **No requiere cambios de código ni de CSP.**
- El navegador no aplica CORS (mismo origen).
- **Sí requiere** declarar el dominio público en `ALLOWED_ORIGINS` del backend, porque CloudFront puede reenviar al origen un `Host` distinto del dominio del navegador y `server/app.js` valida `Origin` contra ese `Host`:

```dotenv
ALLOWED_ORIGINS=https://pana-crush.example.com
```

#### Opción B — API en un dominio separado (p. ej. `api.pana-crush.example.com`)

Requiere **tres cambios coordinados**; hoy **no están implementados**:

1. **Código del cliente** (`public/src/js/main.js`), leyendo la base de un `<meta>` o de un global inyectado en el HTML:

```js
// public/src/js/main.js — cambio necesario solo si la API vive en otro origen
const API_BASE_URL =
  document.querySelector('meta[name="api-base-url"]')?.content ?? '';

const api = new ApiClient({
  baseUrl: API_BASE_URL, // '' = mismo origen; p. ej. 'https://api.pana-crush.example.com'
  getToken: () => (session ? session.current() : null)
});
```

```html
<!-- public/index.html, dentro de <head> -->
<meta name="api-base-url" content="https://api.pana-crush.example.com" />
```

2. **CSP** en `server/app.js` y en la política de respuestas de CloudFront: añadir el dominio de la API a `connect-src` (`connect-src 'self' https://api.pana-crush.example.com`). Si no, el navegador bloqueará las peticiones con un error de CSP.
3. **CORS** en el backend: `ALLOWED_ORIGINS=https://pana-crush.example.com`. El middleware permite los orígenes listados y el mismo `Host`; cualquier otro devuelve `403 CORS_FORBIDDEN`.

> Si se elige la Opción B, hay que **recompilar/publicar el frontend** (cambia `main.js`/`index.html`) y **redesplegar el backend** (cambia la CSP). No es una configuración puramente de infraestructura.

### 2.3 Variables del backend

El backend carga `.env` desde la raíz con `dotenv` (`server/config.js`). En AWS **no se sube `.env`**: se definen como variables de entorno del servicio (ECS task definition, App Runner, etc.) y los secretos se leen de **AWS Secrets Manager** o **SSM Parameter Store**.

| Variable | ¿Obligatoria en producción? | Valor recomendado | Notas |
| --- | --- | --- | --- |
| `NODE_ENV` | Sí | `production` | Activa validación fail-fast y prohíbe el driver en memoria |
| `PORT` | No | `3000` | El puerto que expone el contenedor |
| `SESSION_SECRET` | **Sí** | 64 caracteres hex | Firma HMAC de los tokens; si no cumple, el proceso no arranca en producción |
| `SESSION_TTL_SECONDS` | No | `3600` | Vida del token de sesión real |
| `DB_DRIVER` | Sí | `supabase` | `memory` está **prohibido** con `NODE_ENV=production` |
| `SUPABASE_URL` | **Sí** | `https://<ref>.supabase.co` | Debe terminar en `.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Sí** | *(secreto)* | **Solo backend**; nunca en el navegador ni en S3 |
| `SUPABASE_SCHEMA` | No | `public` | Esquema donde viven tablas y RPC |
| `ALLOW_DEV_SESSION` | Sí | `false` | En producción **debe** ser `false`; el token viene del IdP |
| `DEV_DEMO_PLAYER_ID` | No | UUID v4 | Jugador usado por `POST /api/session` en desarrollo |
| `DEMO_MODE_ENABLED` | Decisión de negocio | `true` / `false` | Habilita “Fichas de Prueba” (`POST /api/demo/session`) |
| `DEMO_GUEST_ID` | No | `invitado_demo` | Alias por defecto del invitado |
| `DEMO_GUEST_NAME` | No | `Invitado Demo` | Nombre mostrado |
| `DEMO_CURRENCY` | No | `VES` | Moneda de la cartera virtual |
| `DEMO_START_BALANCE_CENTS` | No | `100000` | 1.000,00 en céntimos; debe ser > 0 |
| `DEMO_SESSION_TTL_MS` | No | `1800000` | Expiración deslizante de la cartera demo (mínimo 60 s) |
| `DEMO_TOKEN_TTL_SECONDS` | No | `7200` | Vida del token demo (mínimo 60 s) |
| `DEMO_MAX_SESSIONS` | No | `2000` | Tope de carteras demo en memoria |
| `DEMO_MAX_IDEMPOTENT_ROUNDS` | No | `5` | Reintentos idempotentes por invitado |
| `ALLOWED_ORIGINS` | Sí (recomendada) | `https://pana-crush.example.com` | Lista separada por comas; el mismo host se acepta siempre |
| `MAX_EXPOSURE_MULTIPLIER` | No | `10000` | Límite de exposición por ronda |
| `RATE_LIMIT_WINDOW_MS` | No | `1000` | Ventana deslizante por jugador |
| `RATE_LIMIT_MAX_REQUESTS` | No | `12` | Peticiones por ventana |
| `MAX_BODY_BYTES` | No | `8kb` | Límite del cuerpo JSON |
| `IDEMPOTENCY_TTL_MS` | No | `600000` | Retención de `roundRef` para reintentos |

#### Ejemplo de configuración para producción

```dotenv
# Servidor
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=https://pana-crush.example.com

# Persistencia (secretos: Secrets Manager / SSM, nunca en la imagen)
DB_DRIVER=supabase
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_SCHEMA=public

# Sesión
SESSION_SECRET=<64-caracteres-hexadecimales>
SESSION_TTL_SECONDS=3600
ALLOW_DEV_SESSION=false

# Fichas de prueba (opcional; el saldo es virtual y vive en RAM)
# Para dinero real: DEMO_MODE_ENABLED=false. Para demo pública: true.
DEMO_MODE_ENABLED=true
DEMO_START_BALANCE_CENTS=100000
DEMO_CURRENCY=VES

# Límites
MAX_EXPOSURE_MULTIPLIER=10000
RATE_LIMIT_WINDOW_MS=1000
RATE_LIMIT_MAX_REQUESTS=12
```

Genera el secreto de sesión con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2.4 Validaciones fail-fast del backend

`server/config.js` valida la configuración al arrancar. En `NODE_ENV=production` **lanza una excepción y el proceso no levanta** si ocurre cualquiera de estas condiciones:

- `DB_DRIVER=supabase` sin `SUPABASE_URL` o sin `SUPABASE_SERVICE_ROLE_KEY`.
- `DB_DRIVER=memory` con `NODE_ENV=production`.
- `SUPABASE_URL` que no sea una URL `https://*.supabase.co`.
- `SESSION_SECRET` que no sea hexadecimal de exactamente 64 caracteres (32 bytes).
- `ALLOW_DEV_SESSION=true` en producción.
- `DEMO_START_BALANCE_CENTS <= 0` con el modo demo activo.
- TTL demo menor de 60 segundos o topes `DEMO_MAX_*` menores que 1.

En ECS/App Runner esto se traduce en un **health check fallido**; en Vercel, en `503 CONFIG_INVALID`. Revisa los logs del servicio: el mensaje indica exactamente qué variable corregir.

### 2.5 CORS y cookies

- El cliente envía el token en `Authorization: Bearer ...` y usa `credentials: 'omit'`: **no hay cookies de sesión**.
- Orígenes permitidos: los de `ALLOWED_ORIGINS` **más** el mismo `Host` que atiende la petición (`server/app.js` compara `new URL(origin).host` con `req.get('host')`).
- Métodos: `GET, POST, OPTIONS`. Cabeceras permitidas: `Content-Type`, `Authorization`, `Idempotency-Key`.
- Un origen no permitido responde `403 CORS_FORBIDDEN` (no un error de red genérico).
- Si se publica el frontend en CloudFront con `/api/*` hacia otro origen, **incluye el dominio público en `ALLOWED_ORIGINS`** para no depender de qué `Host` reenvía CloudFront.

### 2.6 WebSockets: no se usan

La comunicación es **100 % HTTP REST** (`fetch` con `POST` para las acciones de juego). En el repositorio no hay `WebSocket`, `socket.io`, `EventSource` ni una URL `ws://`/`wss://`.

Consecuencias para AWS:

- No configures **sticky sessions** ni soporte WebSocket en el ALB.
- No hace falta una etapa de API Gateway WebSocket.
- El **idle timeout** del ALB (por defecto 60 s) es suficiente: cada petición es corta y tiene timeout de cliente de 15 s (`ApiClient.DEFAULT_TIMEOUT_MS`).
- Si en el futuro se añade tiempo real, habrá que ampliar `connect-src` en la CSP y añadir el origen `wss://` correspondiente.

### 2.7 Requisitos de Supabase

1. Ejecutar [`sql/schema.sql`](sql/schema.sql) en el proyecto de Supabase de producción (tablas, RPC `play_spin`, políticas y funciones auxiliares).
2. Usar la clave **`service_role` solo en el backend**. Nunca se expone al navegador ni se incluye en la build estática.
3. Mantener el proyecto Supabase en una región con latencia razonable respecto al backend AWS.
4. Verificar que el backend tiene salida HTTPS hacia `*.supabase.co` (Security Group / NAT / VPC endpoints según la topología).

### 2.8 Sesiones reales e IdP

Con `ALLOW_DEV_SESSION=false` (obligatorio en producción), `POST /api/session` responde `403 DEV_SESSION_DISABLED`: **el repositorio no incluye un IdP ni un endpoint autenticado que emita tokens de jugador real**. El equipo de plataforma debe aportar uno de estos:

- Un endpoint propio que, tras autenticar al jugador, llame a `issueToken({ playerId })` de `server/auth/sessionToken.js` y devuelva el token.
- Un IdP externo que emita el mismo formato `t1.<payloadBase64Url>.<firmaBase64Url>` con HMAC-SHA256 y el mismo `SESSION_SECRET`.

Requisitos del token:

- Payload `{ sub, iat, exp, jti }`; `sub` debe ser el UUID de un jugador existente en Supabase y con `status = ACTIVE`.
- `exp` obligatorio; se rechazan tokens expirados o con `iat` futuro (tolerancia de 5 s).
- **No** incluir `demo: true` en tokens de saldo real: `requireAuth` los rechaza con `DEMO_TOKEN_NOT_ALLOWED`.
- El token viaja en `Authorization: Bearer ...`; nunca en la URL.

El modo “Fichas de Prueba” (`POST /api/demo/session`) es independiente y no requiere IdP, pero su cartera es virtual y no toca Supabase.

---

## 3. Pasos para la compilación (build)

### 3.1 Instalación de dependencias

```bash
npm ci          # recomendado en CI: respeta package-lock.json al byte
# o, si vas a actualizar dependencias:
npm install
```

- Usa `npm ci` en CI y en imágenes Docker: respeta `package-lock.json` y falla si el lockfile no coincide.
- Usa `npm install` solo si vas a actualizar dependencias.
- Ninguno requiere variables de entorno: la instalación no se conecta a Supabase.

### 3.2 Verificación de la suite de pruebas

```bash
npm run build:index
npm test
```

Salida esperada (resumen):

```text
# tests 104
# pass 104
# fail 0
```

Notas:

- `npm test` ejecuta `node --test "test/**/*.test.js"` y **no necesita Supabase**: los tests fuerzan `NODE_ENV=test`, `DB_DRIVER=memory` y `ALLOW_DEV_SESSION=true` (`test/helpers/env.js`).
- **Ejecuta `npm run build:index` antes de `npm test`** si tocaste `public/index.html`. El test `server/generated/indexHtml.js refleja public/index.html` falla a propósito cuando el HTML generado está desactualizado.
- `npm start` y `npm run dev` también ejecutan `prestart`/`predev`, que regeneran `server/generated/indexHtml.js` automáticamente.

### 3.3 Compilación de assets (solo si cambia el arte)

No es necesario para un despliegue normal: los WebP/WOFF2/PNG ya están versionados en `public/src/assets/`. Estos scripts se usan cuando el equipo de arte entrega nuevos maestros en `design/`:

| Script | Maestros de entrada (`design/`) | Salida en `public/src/assets/` |
| --- | --- | --- |
| `npm run build:art` | `marco_movil.png`, `consola_movil.png` | `marco_movil.webp`, `consola_movil.webp` |
| `npm run build:desktop-art` | `d1.png`, `d3.png`, `d5.png` | `d1.webp`, `d3.webp`, `d5.webp` |
| `npm run build:bg` | `reino_de_caramelos_y_arcoiris.png`, `avenida_fantastica_reino_caramelos.png` | `reino_de_caramelos_y_arcoiris.webp`, `avenida_fantastica_reino_caramelos.webp` |
| `npm run build:logo` | `pana_crush_ANIMACION-LOGO_final.gif` | `PANA-CRUSH-LOGO.webp` |
| `npm run build:win` | `victoria_dulce.png` | `victoria_dulce.webp` |

- Requieren `sharp` (ya está en `devDependencies`) y son **idempotentes**.
- Los PNG maestros de `design/` **no se publican**.
- Si regeneras arte, **haz commit de los WebP resultantes** y planifica la invalidación/renombrado correspondiente en CloudFront (§4.7).

### 3.4 Generación de la build final estática

El proyecto **no tiene bundler**: la build final es el contenido de `public/` tal cual. Para evitar subir archivos accidentales, prepara una carpeta de staging `dist/` (está en `.gitignore`).

**PowerShell (Windows):**

```powershell
$root = (Get-Location).Path
$dist = Join-Path $root 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null
Copy-Item -Path (Join-Path $root 'public\*') -Destination $dist -Recurse -Force
```

**Bash (Linux/macOS/CI):**

```bash
rm -rf dist
mkdir -p dist
cp -R public/. dist/
```

Verificación del artefacto:

```powershell
Test-Path dist\index.html           # True
Test-Path dist\.env                 # False
(Get-ChildItem dist -Recurse -File | Measure-Object).Count   # 45
"{0:N2} MB" -f ((Get-ChildItem dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
```

```bash
find dist -type f | wc -l    # 45
du -sh dist                  # ~9,8 MB
```

Requisito de estructura en el bucket: `index.html` debe quedar en la **raíz** y `src/` como hermano (`/src/js/main.js`, `/src/assets/...`). No subas la carpeta `public/` como prefijo (`/public/index.html` rompería todas las rutas absolutas del HTML).

> La aplicación usa rutas **absolutas** (`/src/...`, `/api/...`). Publícala en la raíz de un dominio o subdominio, no bajo un subpath como `https://ejemplo.com/juego/`; para ese caso habría que reescribir las rutas del HTML/JS y el `baseUrl` del cliente.

### 3.5 Empaquetado del backend (contenedor)

El backend no se compila: se ejecuta con Node. Ejemplo de `Dockerfile` para ECS/App Runner:

```dockerfile
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Incluye server/generated/indexHtml.js (HTML ya generado)
COPY --chown=node:node server ./server

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
```

`.dockerignore` mínimo:

```text
node_modules
.git
.env
.env.*
public
test
design
docs
scripts
sql
.vercel
.sim
.sim-chrome
tmp-case
*.log
```

> **No uses `npm start` dentro del contenedor.** `npm start` dispara `prestart`, que ejecuta `scripts/build-index-html.js` y necesita `public/index.html` y `scripts/`; ambos quedan fuera de la imagen. `server/generated/indexHtml.js` ya viaja en `server/`. Usa `node server/index.js` (como en el `CMD`).
>
> Si quieres que el backend también sirva los estáticos (sin CloudFront), copia `public/` en la imagen y arranca con `node server/index.js`; el HTML y `/src/**` se servirán desde el mismo proceso.

Build y prueba local de la imagen:

```bash
docker build -t pana-crush-api:1.0.0 .
docker run --rm -p 3000:3000 --env-file /ruta/segura/pana-crush-prod.env pana-crush-api:1.0.0
curl -s http://localhost:3000/api/health
```

> El archivo de entorno de esa prueba debe vivir **fuera del repositorio** (o generarse desde Secrets Manager). No lo dejes como `prod.env` dentro del proyecto: `.gitignore` no cubre todos los nombres posibles.

---

## 4. Recomendaciones de hosting en AWS

### 4.1 Arquitectura recomendada

| Componente | Servicio recomendado | Motivo |
| --- | --- | --- |
| Frontend estático | **S3 privado + CloudFront con OAC** | CDN global, TLS, compresión y caché por tipo de archivo |
| API autoritativa | **AWS App Runner** (o ECS Fargate + ALB) | Proceso Node persistente, WebSockets innecesarios, health check simple |
| Enrutado de API | **CloudFront behavior `/api/*`** hacia el backend | Mantiene el mismo origen y la CSP `connect-src 'self'` |
| Persistencia | **Supabase** (externo a AWS) | Saldos y rondas reales con RPC atómica |
| Secretos | **Secrets Manager / SSM Parameter Store** | Evita `.env` en imágenes y en S3 |
| Logs | **CloudWatch Logs** | Diagnóstico de `CONFIG_INVALID`, 4xx/5xx y latencia |

**Por qué no publicar el backend en S3:** S3 solo sirve objetos estáticos. El motor, la sesión y `/api/spin` requieren un proceso Node. S3/CloudFront es para `public/`; el backend va en un servicio de contenedores.

**Alternativa simple:** ejecutar todo en App Runner/ECS (`node server/index.js` sirve `public/` y `/api/*`) y poner CloudFront delante como CDN. Es válida para una demo, pero pierde la separación de caché por tipo de asset y obliga a escalar el proceso para servir imágenes.

### 4.2 Preparar el bucket S3 y subir el artefacto

Variables de trabajo:

> Los comandos de AWS de esta sección están en **Bash** (Linux, macOS, WSL o Git Bash). En PowerShell puro, define las variables con `$env:VAR = "..."` y adapta `sed`/`$(...)`; para seguir la guía tal cual, usa WSL o Git Bash.

```bash
export AWS_REGION=us-east-1
export BUCKET=pana-crush-web-prod
export DOMAIN=pana-crush.example.com
export API_ORIGIN=api-pana-crush.us-east-1.awsapprunner.com
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

> En `us-east-1` el bucket se crea sin `LocationConstraint`. En otra región añade `--create-bucket-configuration LocationConstraint="$AWS_REGION"`.

```bash
# 1) Bucket privado
aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION"

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 2) Versionado (recomendado para poder revertir un despliegue)
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
```

Subida con metadatos correctos. El primer `sync` copia el contenido y elimina objetos obsoletos; los `cp` posteriores ajustan `Cache-Control` y `Content-Type` por clase de archivo:

```bash
# Contenido y limpieza de obsoletos
aws s3 sync dist/ "s3://$BUCKET/" --delete

# HTML: siempre revalidar
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache, max-age=0, must-revalidate" \
  --content-type "text/html; charset=utf-8"

# JS y CSS: sin fingerprint, revalidar (ver §4.7)
aws s3 cp dist/src/js "s3://$BUCKET/src/js" --recursive \
  --cache-control "public, max-age=0, must-revalidate" \
  --content-type "text/javascript; charset=utf-8"

aws s3 cp dist/src/css "s3://$BUCKET/src/css" --recursive \
  --cache-control "public, max-age=0, must-revalidate" \
  --content-type "text/css; charset=utf-8"

# Assets inmutables por tipo (S3 no siempre infiere bien WOFF2)
aws s3 cp dist/src/assets "s3://$BUCKET/src/assets" --recursive \
  --exclude "*" --include "*.webp" \
  --cache-control "public, max-age=31536000, immutable" \
  --content-type "image/webp"

aws s3 cp dist/src/assets "s3://$BUCKET/src/assets" --recursive \
  --exclude "*" --include "*.png" \
  --cache-control "public, max-age=31536000, immutable" \
  --content-type "image/png"

aws s3 cp dist/src/assets/fonts "s3://$BUCKET/src/assets/fonts" --recursive \
  --cache-control "public, max-age=31536000, immutable" \
  --content-type "font/woff2"
```

Comprobaciones rápidas de objetos:

```bash
aws s3 ls "s3://$BUCKET/"                      # index.html + src/
aws s3api head-object --bucket "$BUCKET" --key "src/js/main.js" \
  --query "{type:ContentType,cache:CacheControl,size:ContentLength}"
aws s3api head-object --bucket "$BUCKET" --key "src/assets/PANA-CRUSH-LOGO.webp" \
  --query "{type:ContentType,cache:CacheControl,size:ContentLength}"
```

> **S3 distingue mayúsculas/minúsculas.** El HTML referencia `PANA-CRUSH-LOGO.webp` con ese nombre exacto. No renombres archivos al subirlos desde Windows.
>
> Los 9 PNG de símbolos no referenciados (`candy_1`, `candy_7`, `candy_9`, `candy_10`, `candy_12`, `candy_14`, `candy_16`, `candy_17`, `candy_18`) no se descargan, pero ocupan espacio en el bucket. Puedes excluirlos del `sync` si quieres reducir el artefacto a ~6,4 MB.

### 4.3 Origin Access Control (OAC) y bucket policy

El bucket permanece **privado**. CloudFront firma las peticiones a S3 con OAC (SigV4).

```bash
OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config '{
    "Name": "pana-crush-oac",
    "Description": "OAC para el frontend de PANA CRUSH",
    "SigningProtocol": "sigv4",
    "SigningBehavior": "always",
    "OriginAccessControlOriginType": "s3"
  }' \
  --query 'OriginAccessControl.Id' --output text)

echo "$OAC_ID"
```

La bucket policy se aplica **después de crear la distribución** (necesitas su ARN). Guarda el archivo en `infra/bucket-policy.json` fuera del árbol público:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipalReadOnly",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::pana-crush-web-prod/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DIST_ID>"
        }
      }
    }
  ]
}
```

```bash
aws s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy file://infra/bucket-policy.json
```

### 4.4 Políticas de caché y cabeceras de seguridad en CloudFront

Crea dos cache policies: una para contenido que debe revalidarse y otra para assets inmutables.

```bash
REVALIDATE_ID=$(aws cloudfront create-cache-policy \
  --cache-policy-config '{
    "Name": "pana-crush-revalidate",
    "Comment": "HTML/JS/CSS sin fingerprint: no cachear sin revalidar",
    "MinTTL": 0,
    "DefaultTTL": 0,
    "MaxTTL": 0,
    "ParametersInCacheKeyAndForwardedToOrigin": {
      "EnableAcceptEncodingGzip": true,
      "EnableAcceptEncodingBrotli": true,
      "CookiesConfig": { "CookieBehavior": "none" },
      "HeadersConfig": { "HeaderBehavior": "none" },
      "QueryStringsConfig": { "QueryStringBehavior": "none" }
    }
  }' \
  --query 'CachePolicy.Id' --output text)

ASSETS_ID=$(aws cloudfront create-cache-policy \
  --cache-policy-config '{
    "Name": "pana-crush-assets-immutable",
    "Comment": "WebP/PNG/WOFF2 inmutables durante 1 ano",
    "MinTTL": 31536000,
    "DefaultTTL": 31536000,
    "MaxTTL": 31536000,
    "ParametersInCacheKeyAndForwardedToOrigin": {
      "EnableAcceptEncodingGzip": true,
      "EnableAcceptEncodingBrotli": true,
      "CookiesConfig": { "CookieBehavior": "none" },
      "HeadersConfig": { "HeaderBehavior": "none" },
      "QueryStringsConfig": { "QueryStringBehavior": "none" }
    }
  }' \
  --query 'CachePolicy.Id' --output text)

echo "revalidate=$REVALIDATE_ID assets=$ASSETS_ID"
```

Política de cabeceras de respuesta (equivalente a Helmet/`vercel.json`). Guárdala como `infra/response-headers-policy.json`:

```json
{
  "Name": "pana-crush-security",
  "Comment": "CSP, HSTS y cabeceras de seguridad de PANA CRUSH",
  "SecurityHeadersConfig": {
    "ContentSecurityPolicy": {
      "Override": true,
      "ContentSecurityPolicy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    },
    "ContentTypeOptions": { "Override": true },
    "FrameOptions": { "Override": true, "FrameOption": "DENY" },
    "ReferrerPolicy": { "Override": true, "ReferrerPolicy": "no-referrer" },
    "StrictTransportSecurity": {
      "Override": true,
      "AccessControlMaxAgeSec": 63072000,
      "IncludeSubdomains": true,
      "Preload": false
    }
  }
}
```

```bash
SECURITY_ID=$(aws cloudfront create-response-headers-policy \
  --response-headers-policy-config file://infra/response-headers-policy.json \
  --query 'ResponseHeadersPolicy.Id' --output text)

echo "$SECURITY_ID"
```

> La CSP debe ser **idéntica** a la del backend/`vercel.json`. Si el navegador recibe dos cabeceras CSP, aplica la **intersección**: una directiva más restrictiva en cualquiera de las dos bloquea el recurso. Si eliges la Opción B de API separada, añade el dominio de la API a `connect-src` en **ambas**.

### 4.5 Distribución de CloudFront y behaviors

Configuración de behaviors (el orden importa: primero las rutas más específicas):

| Orden | Path pattern | Origen | Cache policy | Métodos | Función |
| ---: | --- | --- | --- | --- | --- |
| 1 | `/api/*` | Backend | **CachingDisabled** (managed) | GET, HEAD, OPTIONS, POST | — |
| 2 | `/src/assets/*` | S3 (OAC) | `pana-crush-assets-immutable` | GET, HEAD | — |
| 3 | `/src/*` | S3 (OAC) | `pana-crush-revalidate` | GET, HEAD | — |
| 4 | `*` (default) | S3 (OAC) | `pana-crush-revalidate` | GET, HEAD | `pana-crush-spa-fallback` (opcional) |

Archivo `infra/cloudfront-distribution.json` (sustituye los placeholders con los IDs devueltos en §4.3–4.4):

```json
{
  "CallerReference": "pana-crush-2026-10-26",
  "Comment": "PANA CRUSH - SPA estatica + API",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "s3-pana-crush",
        "DomainName": "pana-crush-web-prod.s3.us-east-1.amazonaws.com",
        "OriginPath": "",
        "CustomHeaders": { "Quantity": 0 },
        "S3OriginConfig": { "OriginAccessIdentity": "" },
        "OriginAccessControlId": "<OAC_ID>"
      },
      {
        "Id": "api-pana-crush",
        "DomainName": "api-pana-crush.us-east-1.awsapprunner.com",
        "OriginPath": "",
        "CustomHeaders": { "Quantity": 0 },
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
          "OriginReadTimeout": 60,
          "OriginKeepaliveTimeout": 5
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-pana-crush",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    },
    "Compress": true,
    "CachePolicyId": "<REVALIDATE_ID>",
    "ResponseHeadersPolicyId": "<SECURITY_ID>"
  },
  "CacheBehaviors": {
    "Quantity": 3,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "api-pana-crush",
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": {
          "Quantity": 4,
          "Items": ["GET", "HEAD", "OPTIONS", "POST"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        },
        "Compress": true,
        "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        "ResponseHeadersPolicyId": "<SECURITY_ID>"
      },
      {
        "PathPattern": "/src/assets/*",
        "TargetOriginId": "s3-pana-crush",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
          "Quantity": 2,
          "Items": ["GET", "HEAD"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        },
        "Compress": true,
        "CachePolicyId": "<ASSETS_ID>",
        "ResponseHeadersPolicyId": "<SECURITY_ID>"
      },
      {
        "PathPattern": "/src/*",
        "TargetOriginId": "s3-pana-crush",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
          "Quantity": 2,
          "Items": ["GET", "HEAD"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        },
        "Compress": true,
        "CachePolicyId": "<REVALIDATE_ID>",
        "ResponseHeadersPolicyId": "<SECURITY_ID>"
      }
    ]
  },
  "HttpVersion": "http2and3",
  "IsIPV6Enabled": true,
  "PriceClass": "PriceClass_100",
  "ViewerCertificate": { "CloudFrontDefaultCertificate": true },
  "Restrictions": {
    "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 }
  }
}
```

```bash
DIST_ID=$(aws cloudfront create-distribution \
  --distribution-config file://infra/cloudfront-distribution.json \
  --query 'Distribution.Id' --output text)

DIST_DOMAIN=$(aws cloudfront get-distribution \
  --id "$DIST_ID" \
  --query 'Distribution.DomainName' --output text)

echo "distribution=$DIST_ID domain=$DIST_DOMAIN"
```

> Sustituye en el JSON el `DomainName` del origen S3 por `<bucket>.s3.<region>.amazonaws.com` y el del origen `api-pana-crush` por el valor de `$API_ORIGIN`. Si el backend vive en otro puerto o path, ajusta `HTTPSPort`/`OriginPath`. El certificado ACM y el dominio propio se añaden en §4.9.

Notas de la configuración:

- `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` es la política administrada **CachingDisabled**; `b689b0a8-53d0-40ab-baf2-68738e2966ac` es **AllViewerExceptHostHeader**. No inventes IDs: verifícalos con `aws cloudfront list-cache-policies` y `list-origin-request-policies`.
- `AllViewerExceptHostHeader` reenvía `Authorization`, `Origin`, `Content-Type` y query strings; por eso el backend recibe el token y puede aplicar CORS.
- Como el `Host` que ve el backend es el del origen (App Runner), **el dominio público debe estar en `ALLOWED_ORIGINS`**.
- `PriceClass_100` cubre Norteamérica/Europa. Si el público está en Latinoamérica, evalúa `PriceClass_200` o `PriceClass_All`.

Aplica ahora la bucket policy con el ARN real de la distribución:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

sed "s/<ACCOUNT_ID>/$ACCOUNT_ID/; s/<DIST_ID>/$DIST_ID/" \
  infra/bucket-policy.json > infra/bucket-policy.rendered.json

aws s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy file://infra/bucket-policy.rendered.json
```

> Ajusta `Resource` en `bucket-policy.json` si el bucket no se llama `pana-crush-web-prod`.

### 4.6 Fallback a `index.html` sin enmascarar 404 de assets

La aplicación solo tiene una página. `DefaultRootObject: index.html` ya resuelve `/`. Para rutas desconocidas sin extensión (por ejemplo `/lobby`), añade una **CloudFront Function** asociada **solo al behavior default**:

```js
// infra/spa-fallback.js
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Cualquier ruta de directorio → index.html (la app no tiene rutas anidadas)
  if (uri.endsWith('/')) {
    request.uri = '/index.html';
    return request;
  }

  // Ruta sin extensión → index.html (el resto conserva su 403/404 real)
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
```

```bash
aws cloudfront create-function \
  --name pana-crush-spa-fallback \
  --function-config '{"Comment":"SPA fallback a index.html","Runtime":"cloudfront-js-2.0"}' \
  --function-code fileb://infra/spa-fallback.js

ETAG=$(aws cloudfront describe-function \
  --name pana-crush-spa-fallback --query 'ETag' --output text)

aws cloudfront publish-function \
  --name pana-crush-spa-fallback --if-match "$ETAG"
```

Asóciala en la consola: *Distribution → Behaviors → Default (*) → Edit → Function associations → Viewer request → `pana-crush-spa-fallback`*. No la asocies a `/api/*` ni a `/src/*`: esos behaviors tienen su propia asociación y no deben devolver HTML.

> **No configures “Custom Error Response 403/404 → /index.html” de forma global.** S3 con OAC devuelve `403` para objetos inexistentes; un fallback global convertiría `GET /src/js/typo.js` en `200 text/html`, ocultando el 404 y provocando errores de MIME en el navegador. La función anterior solo reescribe rutas **sin extensión**.

### 4.7 Políticas de caché recomendadas

| Ruta | `Content-Type` | `Cache-Control` en S3 | CloudFront | Motivo |
| --- | --- | --- | --- | --- |
| `/`, `/index.html` | `text/html; charset=utf-8` | `no-cache, max-age=0, must-revalidate` | `pana-crush-revalidate` | Cada despliegue debe verse de inmediato |
| `/src/js/**` | `text/javascript; charset=utf-8` | `public, max-age=0, must-revalidate` | `pana-crush-revalidate` | **Sin hash** en el nombre: cachear 1 año dejaría JS viejo tras un deploy |
| `/src/css/**` | `text/css; charset=utf-8` | `public, max-age=0, must-revalidate` | `pana-crush-revalidate` | Igual que JS |
| `/src/assets/**/*.webp` | `image/webp` | `public, max-age=31536000, immutable` | `pana-crush-assets-immutable` | Arte estable; se renombra o invalida si cambia |
| `/src/assets/**/*.png` | `image/png` | `public, max-age=31536000, immutable` | `pana-crush-assets-immutable` | Símbolos estables |
| `/src/assets/fonts/*.woff2` | `font/woff2` | `public, max-age=31536000, immutable` | `pana-crush-assets-immutable` | Tipografías versionadas |
| `/api/*` | `application/json` | Definido por Express | **CachingDisabled** | Saldos y rondas nunca se cachean |

Reglas de oro:

- **`index.html` nunca es inmutable.** Si se cachea un año, los usuarios seguirán apuntando a JS/CSS antiguos.
- **No apliques `immutable` a JS/CSS mientras los nombres no tengan hash.** El navegador no volverá a pedirlos y un hotfix no llegará a producción hasta que expire la caché o se invalide.
- **Assets inmutables:** si reemplazas un WebP conservando el nombre, invalida esa ruta o cambia el nombre y actualiza el HTML/CSS. La invalidación de CloudFront **no borra** la copia `immutable` que ya tenga el navegador: para assets servidos con `immutable`, el rollback fiable es **renombrar** el archivo (o aceptar que los navegadores con caché sigan viendo la versión anterior hasta un año).
- **`Content-Type` correcto es obligatorio:** un `.js` servido como `text/html` es rechazado por la CSP `script-src 'self'`/MIME checking; un `.webp` servido como `application/octet-stream` no se pinta.

#### Si más adelante se añade fingerprinting

Para poder usar `Cache-Control: public, max-age=31536000, immutable` también en JS/CSS:

1. Añadir al pipeline un paso que calcule el hash de `style.css` y de cada módulo JS, renombre los archivos (`main.<hash>.js`) y reescriba las referencias en `index.html`.
2. Subir los archivos hasheados con `Cache-Control: public, max-age=31536000, immutable`.
3. Aplicar la cache policy `pana-crush-assets-immutable` al behavior `/src/*` (o crear `/src/js/*` y `/src/css/*`).
4. Mantener `index.html` con `no-cache`: es el único archivo que “publica” los nuevos hashes.

Mientras eso no exista, la configuración segura es la de la tabla (JS/CSS con `max-age=0, must-revalidate`), que es la misma que ya usa Express en local y `vercel.json` en Vercel.

### 4.8 Despliegue del backend en AWS

#### Opción App Runner (recomendada para empezar)

1. Crea el repositorio ECR y publica la imagen:

```bash
aws ecr create-repository --repository-name pana-crush-api --region "$AWS_REGION"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker build -t pana-crush-api:1.0.0 .
docker tag pana-crush-api:1.0.0 \
  "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/pana-crush-api:1.0.0"
docker push "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/pana-crush-api:1.0.0"
```

2. Crea el servicio en App Runner con esta configuración:

| Ajuste | Valor |
| --- | --- |
| Origen | Imagen ECR `pana-crush-api:1.0.0` |
| Puerto | `3000` |
| Health check | HTTP `GET /api/health`, esperado `200` |
| Variables | Las de §2.3 (`NODE_ENV=production`, `ALLOWED_ORIGINS`, `DB_DRIVER=supabase`, etc.) |
| Secretos | `SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` desde Secrets Manager |
| Auto scaling | Mínimo 2 instancias para HA; máximo según carga |
| Logs | CloudWatch Logs |

3. Comprueba el endpoint directo del servicio antes de conectarlo a CloudFront:

```bash
curl -sS "https://<servicio>.us-east-1.awsapprunner.com/api/health" | jq
```

> CloudFront necesita un origen HTTPS **públicamente accesible**. Si App Runner se despliega en una VPC privada, usa un ALB público (restringido al prefix list de CloudFront) como origen, o expón el servicio con un endpoint alcanzable. Un servicio privado sin ALB no puede usarse como custom origin.

#### Opción ECS Fargate + ALB

| Ajuste | Valor |
| --- | --- |
| Contenedor | Imagen ECR, puerto `3000` |
| CPU/memoria | 0,5 vCPU / 1 GB como punto de partida |
| Health check del target group | `GET /api/health`, matcher `200`, intervalo 30 s, timeout 5 s, unhealthy 3 |
| Sticky sessions | **Desactivadas** (no hay WebSocket ni estado de sesión en el proceso) |
| Idle timeout ALB | 60 s (suficiente para peticiones < 15 s) |
| Security Group del ALB | Ingress 443 desde el prefix list administrado `com.amazonaws.global.cloudfront.origin-facing` (o el rango de CloudFront de tu región) |
| Security Group de la tarea | Ingress 3000 solo desde el SG del ALB; egress 443 a `*.supabase.co` |
| Secretos | `secrets` del task definition → Secrets Manager (`SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`) |
| Logs | Driver `awslogs` a CloudWatch |

> Si el origen es un ALB, necesitas un listener **HTTPS** con un certificado ACM válido para su dominio; CloudFront no acepta certificados autofirmados en un custom origin. Para HTTP interno, usa `OriginProtocolPolicy: http-only` solo si el ALB está en una red privada y el tramo CloudFront→ALB ya está cifrado por otro medio.

Consideraciones de estado (importantes para escalar):

- **Saldos reales:** viven en Supabase y la RPC `play_spin` es atómica; escalar el backend no duplica cobros.
- **Cartera demo:** vive en RAM **por instancia** (`server/services/demoWallet.js`). Con 2+ tareas, un invitado puede “perder” su saldo virtual al cambiar de instancia. Es aceptable para una demo; si se necesita continuidad, hay que moverla a un almacén compartido (Redis/Upstash) o fijar 1 instancia.
- **Rate limit e idempotencia:** también son locales al proceso. Con varias instancias, el límite efectivo se multiplica. Para producción real, mover a un almacén compartido.
- **Rate limit por IP con CloudFront + ALB:** `server/app.js` fija `trust proxy = 1`. Si hay dos proxies (CloudFront y ALB), `req.ip` puede ser la IP del edge de CloudFront y los invitados de un mismo edge compartirían el límite de `/api/demo/session`. Los jugadores con token se limitan por `player.id`/`demoKey`. Si necesitas la IP real del jugador, ajusta `trust proxy` a 2 (cambio de código) o mueve el rate limit a un almacén compartido.
- **Sin sesiones sticky:** no son necesarias para el juego; el token es autocontenido (HMAC).

#### Lambda

`server.js` existe para el preset Express de Vercel, pero **no hay adaptador Lambda** en el repositorio. Si el equipo quiere Lambda + API Gateway, debe añadir un adaptador (`serverless-http` o similar) y validar el tamaño del bundle; no es un camino soportado hoy.

### 4.9 Dominio, TLS y DNS

1. Solicita el certificado en **`us-east-1`** (requisito de CloudFront, independientemente de la región del bucket):

```bash
aws acm request-certificate \
  --domain-name "$DOMAIN" \
  --validation-method DNS \
  --region us-east-1
```

2. Valida el certificado por DNS (Route 53 o el proveedor del dominio).
3. En la distribución: *Settings → Alternate domain names (CNAMEs)* → añade `$DOMAIN`; selecciona el certificado ACM. En el JSON de §4.5, sustituye `"ViewerCertificate": { "CloudFrontDefaultCertificate": true }` por `"ACMCertificateArn": "<ARN>"`, `"SSLSupportMethod": "sni-only"` y `"MinimumProtocolVersion": "TLSv1.2_2021"`.
4. En Route 53, crea un **Alias A/AAAA** hacia la distribución de CloudFront (no un CNAME a un nombre de bucket S3).
5. Mantén `ViewerProtocolPolicy: redirect-to-https` y HSTS una vez verificado HTTPS.
6. Opcional: AWS WAF delante de CloudFront (rate-based rule para `/api/*`).

### 4.10 Orden de despliegue y invalidación

Con nombres **sin hash**, el orden importa:

1. Backend primero si hay cambios de contrato (debe ser compatible hacia atrás mientras conviven versiones).
2. Sube assets nuevos (`webp`, `png`, `woff2`).
3. Sube JS/CSS.
4. Sube `index.html` al final.
5. Invalida HTML/JS/CSS:

```bash
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/" "/index.html" "/src/js/*" "/src/css/*"
```

No invalides `/src/assets/*` salvo que hayas reemplazado un asset conservando el nombre. Invalidar todo (`/*`) funciona pero consume cuota y tarda más.

> **Ventana de inconsistencia:** al no haber fingerprinting, entre la subida de JS/CSS y la de `index.html` un usuario puede recibir HTML nuevo con JS viejo (o al revés). Para un lanzamiento congelado, haz el deploy en una ventana de baja audiencia o implementa fingerprinting (§4.7). El `index.html` con `no-cache` reduce la ventana, pero no la elimina.

---

## 5. Pruebas de verificación post-despliegue

### 5.1 Comprobaciones HTTP (smoke test)

Define la URL pública y ejecuta estas comprobaciones. **Bash:**

```bash
BASE="https://pana-crush.example.com"

# 1) HTML: 200, tipo correcto, sin caché larga y CSP presente
curl -sSI "$BASE/" | tr -d '\r' | grep -Ei \
  'HTTP/|content-type|cache-control|content-security-policy|strict-transport-security|x-content-type-options'

# 2) JS y CSS: 200, MIME correcto y revalidación
curl -sSI "$BASE/src/js/main.js" | tr -d '\r' | grep -Ei 'HTTP/|content-type|cache-control'
curl -sSI "$BASE/src/css/style.css" | tr -d '\r' | grep -Ei 'HTTP/|content-type|cache-control'

# 3) Assets: 200, MIME correcto e inmutable
curl -sSI "$BASE/src/assets/PANA-CRUSH-LOGO.webp" | tr -d '\r' | grep -Ei 'HTTP/|content-type|cache-control'
curl -sSI "$BASE/src/assets/fonts/fredoka-latin.woff2" | tr -d '\r' | grep -Ei 'HTTP/|content-type|cache-control'
curl -sSI "$BASE/src/assets/symbols/candy_2.png" | tr -d '\r' | grep -Ei 'HTTP/|content-type|cache-control'
```

**PowerShell:**

```powershell
$BASE = "https://pana-crush.example.com"
curl.exe -sSI "$BASE/" | Select-String -Pattern `
  "HTTP/|content-type|cache-control|content-security-policy|strict-transport-security|x-content-type-options"
curl.exe -sSI "$BASE/src/js/main.js" | Select-String -Pattern "HTTP/|content-type|cache-control"
curl.exe -sSI "$BASE/src/assets/PANA-CRUSH-LOGO.webp" | Select-String -Pattern "HTTP/|content-type|cache-control"
```

Resultados esperados:

| Recurso | Estado | `Content-Type` | `Cache-Control` |
| --- | ---: | --- | --- |
| `/` o `/index.html` | 200 | `text/html; charset=utf-8` | `no-cache, max-age=0, must-revalidate` |
| `/src/js/main.js` | 200 | `text/javascript; charset=utf-8` | `public, max-age=0, must-revalidate` |
| `/src/css/style.css` | 200 | `text/css; charset=utf-8` | `public, max-age=0, must-revalidate` |
| `/src/assets/*.webp` | 200 | `image/webp` | `public, max-age=31536000, immutable` |
| `/src/assets/**/*.woff2` | 200 | `font/woff2` | `public, max-age=31536000, immutable` |
| `/src/assets/symbols/*.png` | 200 | `image/png` | `public, max-age=31536000, immutable` |
| `/api/health` | 200 | `application/json; charset=utf-8` | sin caché (CachingDisabled) |

Además, `/` debe incluir `content-security-policy` con `connect-src 'self'` y `strict-transport-security: max-age=63072000; includeSubDomains`.

### 5.2 Verificación de la API

```bash
# Salud: status UP y persistencia real (no "memory")
curl -sS "$BASE/api/health" | jq '{status, dbDriver, engineVersion, paytableVersion}'

# Información pública: escalera de apuestas, RTP certificado y modo demo
curl -sS "$BASE/api/game" | jq '{ok, betLadder: .game.betLadder, certifiedRtp: .game.certifiedRtp, demo: .game.demo}'

# Flujo demo completo (requiere DEMO_MODE_ENABLED=true)
TOKEN=$(curl -sS -X POST "$BASE/api/demo/session" \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"smoke_test"}' | jq -r .token)

curl -sS -X POST "$BASE/api/spin" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"betCents":100,"roundRef":"smoke-20261026-01"}' \
  | jq '{demo, replayed, balance, totalWinCents, roundId}'
```

**PowerShell equivalente:**

```powershell
$BASE = "https://pana-crush.example.com"

Invoke-RestMethod -Uri "$BASE/api/health" | Select-Object status, dbDriver, engineVersion

$session = Invoke-RestMethod -Method Post -Uri "$BASE/api/demo/session" `
  -ContentType "application/json" -Body '{"playerId":"smoke_test"}'

$body = @{ betCents = 100; roundRef = "smoke-$(Get-Date -Format yyyyMMddHHmmss)" } | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$BASE/api/spin" `
  -Headers @{ Authorization = "Bearer $($session.token)" } `
  -ContentType "application/json" -Body $body |
  Select-Object demo, replayed, balance, totalWinCents, roundId | Format-List
```

Criterios:

- `status: "UP"` y `dbDriver: "supabase"` en producción.
- `/api/game` responde 200 y `demo.enabled` coincide con `DEMO_MODE_ENABLED`.
- El spin demo devuelve `demo: true`, un `balance.cents` numérico y **no** requiere token real.
- Repetir el mismo `roundRef` devuelve `replayed: true` y **no** descuenta dos veces (idempotencia).
- Si `DEMO_MODE_ENABLED=false`, `/api/demo/session` responde `403 DEMO_DISABLED`; usa un token del IdP para probar `/api/spin`.

**CORS (preflight):**

```bash
curl -sS -i -X OPTIONS "$BASE/api/spin" \
  -H "Origin: $BASE" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  | grep -Ei 'HTTP/|access-control-allow-origin|access-control-allow-methods|access-control-allow-headers'
```

Esperado: `204` (o `200`) con `access-control-allow-origin` igual al origen público. Si recibes `403 CORS_FORBIDDEN`, falta el dominio en `ALLOWED_ORIGINS`.

**Rutas inexistentes:**

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/api/no-existe"
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/src/js/no-existe.js"
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/ruta-sin-extension"
```

Esperado:

- `/api/no-existe` → `404 application/json` con `NOT_FOUND`.
- `/src/js/no-existe.js` → `403` o `404`, **nunca** `200 text/html` (el fallback no debe aplicarse a assets).
- `/ruta-sin-extension` → `200 text/html` si la CloudFront Function está asociada; si no, `403` de S3.

### 5.3 Verificación en navegador

Abre la URL pública y ejecuta estos snippets en la consola de DevTools:

```js
// 1) Desbordes de scroll (debe ser <= 1 px en ambos ejes)
({
  vertical: document.documentElement.scrollHeight - window.innerHeight,
  horizontal: document.documentElement.scrollWidth - window.innerWidth
})

// 2) Imágenes rotas o no cargadas (debe devolver [])
[...document.images]
  .filter((img) => !img.complete || img.naturalWidth === 0)
  .map((img) => img.currentSrc || img.src)

// 3) Tipografías cargadas (ambas deben ser true)
({
  fredoka: document.fonts.check('16px Fredoka'),
  lilita: document.fonts.check('16px "Lilita One"')
})

// 4) Recursos del frontend descargados (revisa que no haya rutas raras)
[...performance.getEntriesByType('resource')]
  .filter((r) => r.name.includes('/src/'))
  .map((r) => r.name)
```

Checklist manual:

| Área | Comprobación | Resultado esperado |
| --- | --- | --- |
| Carga inicial | Logo, fondo, máquina y HUD visibles | Sin huecos ni imágenes rotas |
| Conexión | Estado “Conectando…” desaparece | Sesión demo automática o sesión real |
| Saldo | “Fichas de Prueba” muestra 1.000,00 VES (si demo activo) | Formato correcto y moneda correcta |
| Giro | Pulsar SPIN / barra espaciadora | Animación, HUD actualizado y saldo coherente |
| Victoria | Cualquier premio > 0 | Se abre el overlay; los premios grandes muestran más monedas/rayos y duran más |
| Cierre del overlay | Clic, toque o Espacio/Enter | Se cierra sin lanzar un giro accidental |
| Controles | Apuesta ±, MAX, AUTO y Tropical Fever | Responden y respetan el saldo/límites |
| Responsive | 360×640, 390×844, 768×1024, 1440×900, 1920×1080 | Sin scrollbars, sin botones cortados, sin solapes |
| Consola | Errores, CSP o CORS | **Cero** errores y cero violaciones de CSP |
| Network | Peticiones 4xx/5xx | Ninguna (salvo pruebas negativas deliberadas) |
| Network | WebSocket | **Ninguno** (la app no usa WS) |
| Recarga | Ctrl+F5 y recarga normal | Misma versión; `index.html` revalidado (200/304) |
| Red caída | Desconectar y girar | Mensaje de error controlado, sin crash |

> **Favicon:** el HTML no declara ningún icono. Algunos navegadores solicitan `/favicon.ico` automáticamente y S3 responderá `403` (no es un fallo del juego). Si quieres evitar ese ruido en la consola/Network, añade `public/favicon.ico` o un `<link rel="icon" href="data:...">` antes de publicar.

### 5.4 Rendimiento y caché

- Ejecuta **Lighthouse mobile** (throttling por defecto) sobre `/`:
  - LCP < 2,5 s, CLS < 0,1, TBT < 200 ms como objetivos.
  - Si el LCP es alto, revisa el peso del arte de fondo y el número de símbolos descargados.
- Comprueba que la primera carga **no descarga los 20 PNG**: solo 11 están referenciados. Si descarga más, hay referencias añadidas en CSS/JS.
- Compresión de texto (JS/CSS/HTML):

```bash
curl -sSI -H 'Accept-Encoding: br,gzip' "$BASE/src/js/main.js" \
  | grep -Ei 'HTTP/|content-encoding|content-length'
```

- En CloudFront, revisa métricas de **cache hit ratio**, **4xx/5xx** y latencia al origen. Tras la primera visita, `/src/assets/*` debe servir casi todo desde caché.
- Los PNG de símbolos son el mayor peso (3,83 MB de los 11 usados). Si el rendimiento móvil no cumple, la primera optimización es convertirlos a WebP/AVIF (requiere actualizar `public/src/js/format.js` y regenerar el arte).

### 5.5 Problemas típicos y solución

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| `403 AccessDenied` en `/` | Bucket policy ausente/incorrecta u OAC no asociado | Revisa `OriginAccessControlId`, `AWS:SourceArn` y que el bucket siga privado |
| `403` en todos los assets | OAC sin `s3:GetObject` o distribución con OAI antigua | Aplica la bucket policy de §4.3 y asocia el OAC al origen S3 |
| `404` en `/src/js/main.js` | Se subió `public/` como prefijo | Re-sube el **contenido** de `public/` a la raíz del bucket |
| JS se sirve como `text/html` | Fallback global 403/404 → `index.html` o `Content-Type` mal puesto | Usa la CloudFront Function de §4.6 y fija `text/javascript; charset=utf-8` |
| `Refused to connect ... connect-src` | API en otro origen y CSP sin ampliar | Opción A (proxy `/api/*`) o añade el dominio a `connect-src` |
| `403 CORS_FORBIDDEN` | Dominio público fuera de `ALLOWED_ORIGINS` | Añade `https://tu-dominio` y redespliega el backend |
| `503 CONFIG_INVALID` (Vercel) o health check fallido (ECS) | Falta `SESSION_SECRET`, Supabase o `ALLOW_DEV_SESSION=false` | Corrige variables y reinicia el servicio |
| `500` en `/api/spin` | Esquema/RPC de Supabase no aplicado o credenciales inválidas | Ejecuta `sql/schema.sql` y valida la `service_role` |
| `401 TOKEN_MISSING` | Demo desactivado y sin token del IdP | Activa `DEMO_MODE_ENABLED` o integra el IdP |
| `403 DEMO_DISABLED` | `DEMO_MODE_ENABLED=false` | Cambia la variable si el modo prueba debe estar disponible |
| `429 RATE_LIMITED` | Rate limit por jugador | Ajusta `RATE_LIMIT_*` o revisa bucles del cliente |
| `413 PAYLOAD_TOO_LARGE` | Cuerpo > `MAX_BODY_BYTES` | Reduce el payload o sube el límite |
| UI antigua tras desplegar | `index.html`/JS en caché | Invalida `/`, `/index.html`, `/src/js/*`, `/src/css/*`; recarga forzada |
| Scrollbars o layout cortado | CSS no cargó o viewport alterado | Verifica `/src/css/style.css` (200, `text/css`) y el `<meta viewport>` |
| Fuentes con fallback | WOFF2 con MIME incorrecto o bloqueado | `font/woff2` + `font-src 'self'`; revisa preloads |
| Imágenes rotas solo en producción | Mayúsculas/minúsculas o 403 de S3 | Respeta el nombre exacto; verifica `head-object` |
| `502/504` en `/api/*` | Origen inaccesible, puerto/TLS incorrecto o health check caído | Prueba el endpoint del backend directo y revisa SG/health |
| WebSocket fallando | No aplica: la app no usa WS | Elimina reglas/sticky sessions innecesarias |

---

## 6. Checklist de salida a producción

### Antes del despliegue

- [ ] `npm ci` termina sin errores y sin modificar `package-lock.json`.
- [ ] `npm run build:index` ejecutado después del último cambio en `public/index.html`.
- [ ] `npm test` → **104/104** y `# fail 0`.
- [ ] `git status` solo muestra los archivos que se van a desplegar; `.env` no está trackeado.
- [ ] `sql/schema.sql` aplicado en el Supabase de producción (incluida la RPC `play_spin`).
- [ ] `SESSION_SECRET` de 64 hex generado y guardado en Secrets Manager/SSM.
- [ ] `NODE_ENV=production`, `DB_DRIVER=supabase`, `ALLOW_DEV_SESSION=false`.
- [ ] `ALLOWED_ORIGINS` incluye el dominio público.
- [ ] Endpoint/IdP que emita tokens reales disponible (no incluido en el repo) o modo demo habilitado explícitamente.
- [ ] Decisión tomada sobre `DEMO_MODE_ENABLED` (y sus TTL/saldo) para ese entorno.
- [ ] Backup/versionado de Supabase y del bucket S3 habilitados.
- [ ] Tag de imagen del backend y versión anterior identificados para rollback.

### Infraestructura

- [ ] Bucket S3 privado, con Public Access Block y versionado.
- [ ] OAC asociado al origen S3 y bucket policy con `AWS:SourceArn` correcto.
- [ ] Behaviors `/api/*`, `/src/assets/*`, `/src/*` y default en el orden correcto.
- [ ] Cache policies aplicadas (`revalidate` vs `assets-immutable`).
- [ ] Response headers policy con CSP, HSTS, `nosniff`, `DENY` y `no-referrer`.
- [ ] CloudFront Function de fallback asociada **solo** al behavior default.
- [ ] Certificado ACM en `us-east-1`, alias y Route 53 apuntando a CloudFront.
- [ ] Backend con health check `/api/health` y logs en CloudWatch.
- [ ] Security Groups: ALB solo desde CloudFront; tarea solo desde ALB; egress a Supabase.
- [ ] Alarmas de 5xx, latencia y errores de origen configuradas.

### Después del despliegue

- [ ] `/` responde 200 con CSP y `Cache-Control` de revalidación.
- [ ] JS/CSS responden con MIME correcto y `max-age=0, must-revalidate`.
- [ ] WebP/PNG/WOFF2 responden con `immutable` y `Content-Type` correcto.
- [ ] `/api/health` → `UP` + `supabase`.
- [ ] Flujo demo: sesión + spin + idempotencia verificados.
- [ ] CORS preflight correcto desde el dominio público.
- [ ] Rutas inexistentes: API 404 JSON, assets 403/404, ruta sin extensión 200 HTML.
- [ ] Sin 404 de imágenes, sin scrollbars, sin errores de consola ni violaciones CSP.
- [ ] Victoria visible en el overlay (incluido cierre con clic/Espacio).
- [ ] Invalidación de `/`, `/index.html`, `/src/js/*`, `/src/css/*` ejecutada.
- [ ] Métricas de CloudFront saludables tras 15–30 minutos.

### Rollback

1. **Frontend:** vuelve a subir la versión anterior de `index.html`, JS y CSS desde el versionado de S3 (o desde el artefacto anterior) e invalida esas rutas.
2. **Backend:** despliega de nuevo el tag de imagen anterior en App Runner/ECS. Mantén compatibilidad de API durante la ventana de transición.
3. **Assets inmutables:** si el rollback afecta a un asset con nombre reutilizado, invalida esa ruta concreta; si el nombre cambió, el HTML anterior ya apunta al correcto.

---

## 7. Anexos

### 7.1 Superficie de API

| Método | Ruta | Autenticación | Descripción |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Ninguna | Estado, versión de motor/paytable y driver de persistencia |
| `GET` | `/api/game` | Ninguna | Información pública, escalera de apuestas, RTP y configuración demo |
| `POST` | `/api/demo/session` | Ninguna | Emite token demo y cartera virtual (requiere `DEMO_MODE_ENABLED`) |
| `POST` | `/api/session` | Ninguna | Emite token de desarrollo (requiere `ALLOW_DEV_SESSION=true`; **desactivado en producción**) |
| `GET` | `/api/player` | `Bearer` (real o demo) | Saldo y estadísticas del jugador |
| `POST` | `/api/spin` | `Bearer` real/demo o intención demo explícita | Resuelve una ronda; acepta `betCents` **o** `bet`, `buyFeature`, `roundRef`, `clientSeed` |

Códigos de error habituales: `TOKEN_MISSING` (401), `CORS_FORBIDDEN` (403), `DEMO_DISABLED` (403), `INVALID_BET` (400), `INSUFFICIENT_FUNDS` (402), `RATE_LIMITED` (429), `CONFIG_INVALID` (503).

La apuesta válida está en la escalera del motor: `0.10, 0.20, 0.50, 1, 2, 5, 10, 20, 50, 100` créditos (10–10.000 céntimos). Envía exactamente uno de `bet` (créditos) o `betCents` (entero).

### 7.2 Comandos de referencia

| Comando | Uso |
| --- | --- |
| `npm ci` | Instalación reproducible |
| `npm run build:index` | Regenera `server/generated/indexHtml.js` desde `public/index.html` |
| `npm test` | Suite completa (104 tests) |
| `npm start` | Servidor local/standalone en `http://localhost:3000` |
| `npm run dev` | Servidor con recarga (`node --watch`) |
| `npm run simulate:validate` | Simulación base de 20.000 rondas con CSPRNG |
| `npm run simulate:feature` | Simulación de 20.000 rondas en modo feature |
| `npm run build:art` / `build:desktop-art` / `build:bg` / `build:logo` / `build:win` | Regeneración de arte WebP desde `design/` |

### 7.3 Archivos clave

| Archivo | Rol |
| --- | --- |
| `public/index.html` | Documento único de la SPA y fuente del HTML generado |
| `public/src/js/main.js` | Arranque del cliente; construye `ApiClient` sin `baseUrl` (mismo origen) |
| `public/src/js/apiClient.js` | Cliente HTTP, timeout de 15 s, `Authorization: Bearer`, `cache: 'no-store'` |
| `public/src/js/sessionClient.js` | Gestión del token en el cliente |
| `public/src/js/gameClient.js` | Flujo de giro y coordinación con la UI |
| `public/src/js/uiManager.js` | Interfaz y overlay de victoria por perfiles |
| `server/config.js` | Variables de entorno y validación fail-fast |
| `server/app.js` | CSP, CORS, rutas, estáticos locales y manejo de errores |
| `server/generated/indexHtml.js` | HTML de `/` **generado**; no editar a mano |
| `server.js` | Entry para el preset Express de Vercel (no usado en AWS) |
| `vercel.json` | Referencia de cabeceras y configuración del despliegue serverless |
| `sql/schema.sql` | Esquema y RPC de Supabase |

### 7.4 Referencias

- Despliegue serverless existente: [`docs/DEPLOY_VERCEL.md`](docs/DEPLOY_VERCEL.md)
- Modelo matemático y RTP: [`docs/MATH_MODEL.md`](docs/MATH_MODEL.md)
- Modo “Fichas de Prueba”: [`docs/DEMO_MODE.md`](docs/DEMO_MODE.md)
- Variables de entorno de referencia: [`.env.example`](.env.example)

---

**Versión del documento:** 1.0 · **Última verificación:** 26/10/2026 · **Suite:** 104/104 tests.

