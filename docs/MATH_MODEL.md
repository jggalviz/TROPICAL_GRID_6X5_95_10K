# Modelo matemático — TROPICAL_GRID_6X5_95_10K

Documento de referencia del motor `@server/engine/gridEngine.js`.
Todo lo aquí descrito se puede recalcular con `npm run simulate` y se publica
en vivo en `GET /api/game` (fuente única: las constantes del motor).

| Campo | Valor |
| --- | --- |
| Código de juego | `TROPICAL_GRID_6X5_95_10K` |
| Versión de motor | `ENGINE_VERSION` (`1.0.0`) |
| Versión de paytable | `TG65-95-10K-v1` |
| Rejilla | 6 columnas × 5 filas (30 celdas) |
| Tipo | Cluster Pays (pagos por agrupación) |
| Agrupación mínima | 8 símbolos conectados en ortogonal |
| RTP objetivo | 95,00 % |
| RTP certificado | base 94,92 % · bonus 94,97 % |
| Tope de exposición | 10.000× la apuesta de la ronda |
| Cascadas máximas por tirada | 40 pasos (`MAX_CASCADE_STEPS`) |
| Giros por bonus | 10 (`MAX_FEATURE_SPINS`) |
| Escalera de apuestas | 0,10 · 0,20 · 0,50 · 1 · 2 · 5 · 10 · 20 · 50 · 100 créditos |
| Compra de bonus | 100× la apuesta base (Tropical Fever, 10 giros) |

---

## 1. Unidades y aritmética

El motor **nunca** opera con números en coma flotante para dinero:

* La apuesta viaja en **céntimos enteros** (`betCents`).
* Los pagos de la paytable se definen en **unidades**, donde *1 unidad = 1× la
  apuesta de la ronda*. Se almacenan como **micro-unidades**
  (`MICRO_PER_UNIT = 10 000`, es decir 4 decimales).
* Conversión única al céntimo con redondeo hacia abajo:

```js
microToCents(micro, betCents) = Math.floor(micro * betCents / MICRO_PER_UNIT)
```

Una agrupación de 3,33 unidades sobre una apuesta de 1,00 crédito paga 3,33
créditos (333 céntimos). No hay redondeos intermedios: el total de la ronda se
calcula en micro-unidades y se convierte una sola vez.

## 2. Generador aleatorio (CSPRNG)

* Semilla de servidor: `crypto.randomBytes(32)` → 256 bits de entropía por ronda.
* Flujo determinista: `HMAC-SHA256(serverSeed, "clientSeed:counter")`, leyendo
  bloques de 32 bytes y consumiéndolos en enteros de 32 bits big-endian.
* **Muestreo por rechazo** para eliminar el sesgo modular (`sample >= limit`
  se descarta), de modo que `int(n)` es uniforme en `[0, n)`.
* `serverSeedHash = SHA-256(serverSeed)` se publica con la ronda y permite
  verificar después que la semilla no se alteró.
* El `clientSeed` es informativo (auditoría): se sanea a `[A-Za-z0-9._:-]`,
  máximo 64 caracteres; si quedan menos de 4 válidos se genera uno aleatorio.
* `audit.rngDraws` registra cuántos enteros de 32 bits consumió la ronda.

La reproducibilidad es total: con `serverSeed`, `clientSeed` y la versión de
motor se puede replicar la ronda céntimo a céntimo.

## 3. Tira virtual (reel strips)

Cada una de las 6 columnas usa una tira **física** determinista de
`STRIP_LENGTH = 120` posiciones, construida a partir de pesos por símbolo.
Las rachas (runs) son 1, 1, 2, 2, 3, 3, 4 posiciones: los símbolos regulares
pueden ocupar rachas de hasta 4 celdas, mientras que `SC` (flor) y `MX`
(bomba) siempre ocupan una sola posición. Esto produce la densidad vertical de
un slot real y una tasa de acierto final de ~15,6 % en el modo base (§10).

Distribución publicada de la tira base (`gameInfo.strips.symbolDistribution`),
medida sobre la tira ya construida con rachas:

| Símbolo | Peso | Prob. por posición |
| --- | --- | --- |
| S1 | 1700 | 16,39 % |
| S2 | 1550 | 13,75 % |
| S3 | 1400 | 14,86 % |
| S4 | 1250 | 11,39 % |
| S5 | 1100 | 10,14 % |
| S6 | 1000 | 8,33 % |
| S7 | 900 | 10,83 % |
| S8 | 800 | 5,28 % |
| S9 | 700 | 7,50 % |
| SC (flor) | 310 | 0,83 % |
| MX (bomba) | 175 | 0,69 % |

`gameInfo.strips.checksum` es el SHA-256 de las 6 tiras concatenadas
(`7eed98dba294a61aa2f7df4b477a30b062b6cce43ebb9c8a51eeb03a7033a820` para la
tira base de esta versión): permite al auditor comprobar que el despliegue
sirve exactamente las tiras certificadas.


## 4. Agrupaciones (cluster pays)

Se buscan componentes conexas por vecindad ortogonal (4 direcciones) del mismo
símbolo regular. Solo pagan las de tamaño ≥ 8 y el pago se toma del tramo:

| Tramo | Tamaño |
| --- | --- |
| 8 | 8 y 9 |
| 10 | 10 y 11 |
| 12 | 12 o más |

Tabla de pagos en unidades (× la apuesta de la ronda):

| Símbolo | 8 | 10 | 12+ |
| --- | --- | --- | --- |
| S1 | 0,91 | 2,27 | 5,05 |
| S2 | 1,11 | 2,78 | 6,56 |
| S3 | 1,36 | 3,28 | 8,08 |
| S4 | 1,62 | 4,04 | 9,58 |
| S5 | 2,07 | 5,05 | 11,61 |
| S6 | 2,62 | 6,56 | 14,63 |
| S7 | 3,33 | 8,08 | 18,16 |
| S8 | 4,45 | 11,10 | 23,20 |
| S9 | 5,95 | 14,63 | 29,25 |

Si en un mismo paso hay varias agrupaciones, sus pagos se **suman**. `SC` y
`MX` no forman agrupaciones: son símbolos especiales.

## 5. Scatter (flor)

La flor se evalúa **solo en la rejilla inicial** de cada tirada (no en las
recargas de las cascadas). El último tramo es abierto (`6+`): 6 o más flores
pagan el tramo máximo.

| Flores | Unidades |
| --- | --- |
| 3 | 7,60 |
| 4 | 22,70 |
| 5 | 75,40 |
| 6+ | 226,00 |

## 6. Cascadas

1. Tras pagar las agrupaciones, sus celdas se eliminan.
2. Los símbolos restantes caen por gravedad y se rellenan las celdas vacías
   desde arriba con nuevas posiciones de la tira.
3. Se vuelve a evaluar. El bucle se corta cuando no hay agrupaciones, tras
   `MAX_CASCADE_STEPS = 40` pasos o cuando la ganancia base ya supera el tope
   de exposición (corte anticipado para acotar el peor caso).

Todas las cascadas de una tirada comparten el mismo flujo RNG. El importe de
la tirada es la suma de los pasos más el scatter, multiplicado al final.

## 7. Bombas y multiplicador

`MX` no paga por sí misma: deja una bomba en la celda con un valor fijo de la
tabla. **Al final de la tirada** se suman las bombas presentes en la rejilla
final y ese total multiplica la ganancia acumulada de la tirada (agrupaciones +
scatter). Si no hay bombas, el multiplicador es 1.

Distribución de valores (base) publicada en `gameInfo.multiplier.distribution`:

| Valor | Peso | Probabilidad |
| --- | --- | --- |
| 2× | 2200 | 22,41 % |
| 3× | 2000 | 20,38 % |
| 4× | 1600 | 16,30 % |
| 5× | 1200 | 12,23 % |
| 6× | 900 | 9,17 % |
| 8× | 650 | 6,62 % |
| 10× | 450 | 4,58 % |
| 12× | 300 | 3,06 % |
| 15× | 220 | 2,24 % |
| 20× | 150 | 1,53 % |
| 25× | 90 | 0,92 % |
| 50× | 40 | 0,41 % |
| 100× | 12 | 0,12 % |
| 250× | 3 | 0,03 % |

Rango efectivo: 2× – 250×. En el modo bonus se usa una tabla propia con los
mismos valores pero mucho más peso en los tramos altos (media ~14,65× frente a
~5,50× del modo base).

## 8. Tropical Fever (compra de bonus)

* Coste: `feature.costMultiplier = 100` × la apuesta de la ronda.
* Duración: 10 giros gratuitos (`feature.spins = 10`).
* Rejilla y paytable de agrupaciones idénticas al modo base.
* Diferencia matemática: los pesos de la tira dan mucho más peso a `MX`
  (1040 frente a 175), de modo que cada giro acumula varias bombas y el
  multiplicador medio de los giros con premio es ~22×.
* El multiplicador se aplica **por giro** (al final de cada tirada del bonus),
  no al total del bonus.
* La compra se contabiliza como una ronda con apuesta = coste del bonus, por lo
  que su RTP se mide sobre ese importe (94,97 %).

## 9. Tope de exposición

`MAX_EXPOSURE_MULTIPLIER = 10 000`. Se aplica en dos puntos:

1. Durante las cascadas: si la ganancia base ya supera el tope, se corta el
   bucle (`capped = true`).
2. Al convertir: `winCents = min(betCents × 10 000, presupuesto de la ronda)`.

El límite se aplica a la ronda completa, así que un bonus puede tocar techo
sumando sus 10 giros. El tope actúa como red de seguridad del peor caso: en las
simulaciones de calibración ninguna ronda lo alcanzó (0,0000 % de rondas
topadas), y el ligero margen del 94,92 % frente al objetivo del 95,00 % se fija
en la calibración de pesos para dejar holgura bajo el tope.

## 10. RTP certificado

Valores publicados por el motor en `gameInfo.certifiedRtp` (no se recalculan en
caliente; solo se actualizan al recalibrar):

| Modo | RTP | Error estándar | IC 95 % | Rondas simuladas |
| --- | --- | --- | --- | --- |
| Base | 94,92 % | 0,21 % | 94,51 % – 95,33 % | 12.000.000 |
| Tropical Fever | 94,97 % | 0,33 % | 94,32 % – 95,62 % | 300.000 (3.000.000 giros) |

Fecha de calibración: `2026-10-21`.

Comprobación de referencia con 60.000 rondas por modo (PRNG de calibración):

| Modo | RTP medido | Error estándar | Acierto | RTP por agrupaciones | RTP por scatter |
| --- | --- | --- | --- | --- | --- |
| Base | 94,41 % | 2,44 % | 15,57 % | 43,90 % | 0,66 % |
| Bonus | 95,24 % | 0,74 % | 81,26 % | 3,61 % | 0,92 % |

La varianza del modo base exige muestras grandes: el 90 % de las rondas paga
menos de 1,62× y el 99 % menos de 16,68×, pero las rondas con bombas altas
mueven la media. Para certificación se usan ≥ 10 millones de rondas.

## 11. Metodología de simulación

```bash
# RTP base (100.000 rondas por defecto, PRNG rápido de calibración)
npm run simulate

# Flujo RNG real (HMAC-DRBG) del motor
npm run simulate:validate      # 20.000 rondas en modo base con --crypto
npm run simulate:feature       # 20.000 compras de bonus (PRNG de calibración)

# Parámetros manuales
node scripts/simulate.js --rounds=200000 --mode=both --crypto --seed=20240501 --bet=1
node scripts/simulate.js --rounds=50000 --mode=feature --seed=7 --bet=5
```

Cada ejecución imprime RTP, error estándar, IC 95 %, tasa de acierto,
porcentaje de rondas topadas, RTP desglosado (agrupaciones / scatter), media de
unidades ganadas, multiplicador medio en rondas ganadoras, percentiles y
distribución de premios por tramos. El resultado completo se guarda en
`.sim/simulation-<timestamp>.json` como evidencia reproducible.

* `--crypto` valida el flujo RNG real (más lento, sin atajos).
* El PRNG `sfc32` se usa solo para calibración rápida; no interviene en
  producción.
* Las semillas de simulación son fijas por `--seed`, de modo que dos auditorías
  con la misma versión obtienen exactamente el mismo resultado.


## 12. Verificación de una ronda

Cada respuesta de `POST /api/spin` incluye el bloque `audit`:

| Campo | Significado |
| --- | --- |
| `serverSeedHash` | `SHA-256(serverSeed)`, compromiso previo a conocer el resultado |
| `serverSeed` | semilla de la ronda; se genera por ronda y se revela con el resultado |
| `clientSeed` | semilla informativa del jugador (saneada) |
| `rngHash` | `SHA-256(serverSeed:clientSeed:engineVersion)`, huella de la ronda |
| `rngDraws` | enteros de 32 bits consumidos |
| `paytableVersion` | versión de paytable usada |
| `engineVersion` | versión de motor usada |
| `certifiedRtp` | RTP aplicado a esa ronda (base o bonus) |

Como `serverSeed` se genera con 256 bits nuevos en cada ronda, revelarlo junto
al resultado no permite predecir rondas futuras; el hash publicado permite
comprobar que la semilla no se manipuló después.

**Reproducción exacta**: con `serverSeed`, `clientSeed` y la misma versión de
motor, `playRound()` genera la misma rejilla, las mismas cascadas, las mismas
bombas y el mismo importe. Es la prueba que debe ejecutar el laboratorio.

**Idempotencia**: `roundRef` identifica la petición. Si el cliente reintenta
(fallo de red, refresco), el servidor devuelve la ronda ya registrada con
`replayed: true` y **no** cobra dos veces. El cliente reutiliza siempre la misma
`roundRef` para una tirada.

## 13. Cobertura de la suite de pruebas

`npm test` (43 casos, `node --test`) cubre:

**API y contrato**

* `/api/health` sin secretos; `/api/game` publica paytable, tiras y RTP certificado.
* Sesión: emisión de token, rechazo de `playerId` no UUID, 401 sin token o con
  token inválido, 404 de jugador inexistente.
* `/api/spin`: resolución y actualización de saldo, idempotencia por `roundRef` y
  por cabecera `Idempotency-Key`, compra de bonus a 100×, rechazo de apuestas
  fuera de la escalera, una sola forma de apuesta, validación de `roundRef` y
  `clientSeed`, 402 sin saldo, 400 con JSON inválido y 404 JSON en rutas
  desconocidas.
* El cliente **no** puede fijar la semilla del servidor.

**Motor**

* El tramo `6+` de scatter es abierto y paga el máximo de la tabla (regresión de
  §5); con menos de 3 flores no hay pago.

**Persistencia y dinero**

* Alta/lectura de jugador y `PLAYER_NOT_FOUND`.
* Débito de apuesta y crédito de premio atómicos; rechazo sin saldo sin alterar
  el saldo; compra de bonus a 100× registrada en el libro mayor.
* Idempotencia de `roundRef` (sin doble débito) y creación de ronda nueva cuando
  no se envía.
* Jugador bloqueado no puede jugar; `adjustBalance` rechaza saldos negativos;
  importes no enteros rechazados.

**Límites y sesión**

* Ventana deslizante (no fija), ventanas independientes por clave, 429 al
  superar el límite por jugador.
* Tokens: firma manipulada, secreto distinto, expiración, versión desconocida,
  payload sin `exp`/`sub`, formato inválido y `jti` único por token.

El determinismo del motor, la uniformidad del muestreo por rechazo y el
cumplimiento del RTP se validan con `scripts/simulate.js` (§11) y con la
reproducción de rondas descrita en §12, no con pruebas unitarias.

## 14. Correspondencia con GLI-19

| Requisito | Dónde se cumple |
| --- | --- |
| RNG criptográfico y sin sesgo | HMAC-DRBG con muestreo por rechazo (§2, requisito 3.2.1) |
| Paytable y reglas publicadas | `GET /api/game` + modal «Reglas» del cliente |
| RTP medido y documentado | §10, evidencia en `.sim/*.json` |
| Límite de exposición | §9, `MAX_EXPOSURE_MULTIPLIER` |
| Registro de rondas y movimientos | `server/db` (ledger de doble entrada) + bloque `audit` |
| No repudio de la ronda | `serverSeedHash`, `rngHash`, `roundRef` |
| Lógica en servidor, cliente solo visual | `server/services/gameService.js` vs `public/src/js/*` |
| Control de acceso y límites | `middleware/auth.js`, `middleware/rateLimit.js` |
| Idempotencia de la transacción | `roundRef` único por jugador |

## 15. Cambios que exigen recalibración y recertificación

* Tablas de pesos (`BASE_WEIGHTS`, `FEATURE_WEIGHTS`).
* Paytable de agrupaciones (`CLUSTER_PAYS_UNITS`) o de scatter
  (`SCATTER_PAYS_UNITS`), incluido el tramo abierto 6+.
* Tablas de bombas (`BASE_MULTIPLIER_TABLE`, `FEATURE_MULTIPLIER_TABLE`).
* Parámetros de Tropical Fever (coste, número de giros).
* `MAX_EXPOSURE_MULTIPLIER`, `MAX_CASCADE_STEPS`, `MIN_CLUSTER_SIZE`.
* Algoritmo RNG, `STRIP_LENGTH`, `STRIP_RUN_LENGTHS` o `STRIP_SEED`.

Tras cualquier cambio hay que volver a simular, actualizar `CERTIFIED_RTP` y
este documento, y subir la versión de paytable (`PAYTABLE_VERSION`). El motor
publica versión de motor, versión de paytable y checksum de tiras en cada
respuesta de auditoría para que el operador pueda demostrar qué versión estaba
en juego en cada ronda.
