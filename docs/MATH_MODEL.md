# Modelo matemático — TROPICAL_GRID_6X5_95_10K

Documento de referencia del motor `@server/engine/gridEngine.js`.
Todo lo aquí descrito se puede recalcular con `npm run simulate` y se publica
en vivo en `GET /api/game` (fuente única: las constantes del motor).

| Campo | Valor |
| --- | --- |
| Código de juego | `TROPICAL_GRID_6X5_95_10K` |
| Versión de motor | `ENGINE_VERSION` (`1.1.0`) |
| Versión de paytable | `TG65-95-10K-v2` |
| Rejilla | 6 columnas × 5 filas (30 celdas) |
| Tipo | Grid Pays (pagos por dispersión) |
| Mínimo de pago | 8 símbolos iguales en cualquier posición |
| RTP objetivo | 95,00 % |
| RTP certificado | base 95,08 % · bonus 94,98 % |
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

Una combinación de 3,33 unidades sobre una apuesta de 1,00 crédito paga 3,33
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
un slot real y una tasa de acierto final de ~61,8 % en el modo base (§10).

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


## 4. Pagos por dispersión (Grid Pays)

Se cuenta **todas** las apariciones de cada símbolo regular (`S1`…`S9`) en las
30 celdas. No importa que estén conectados ni adyacentes: solo cuenta el total.
Si un símbolo alcanza el mínimo, paga una vez el tramo correspondiente:

| Tramo | Cantidad total en la rejilla |
| --- | --- |
| 8 | 8 y 9 |
| 10 | 10 y 11 |
| 12 | 12 o más |

Tabla de pagos en unidades (× la apuesta de la ronda):

| Símbolo | 8-9 | 10-11 | 12+ |
| --- | --- | --- | --- |
| S1 | 0,0927 | 0,2313 | 0,5146 |
| S2 | 0,1131 | 0,2833 | 0,6685 |
| S3 | 0,1386 | 0,3342 | 0,8234 |
| S4 | 0,1651 | 0,4117 | 0,9762 |
| S5 | 0,2109 | 0,5146 | 1,1831 |
| S6 | 0,2670 | 0,6685 | 1,4908 |
| S7 | 0,3393 | 0,8234 | 1,8505 |
| S8 | 0,4535 | 1,1311 | 2,3641 |
| S9 | 0,6063 | 1,4908 | 2,9806 |

Si en un mismo paso hay varios símbolos que alcanzan el mínimo, sus pagos se
**suman** y todas sus celdas se eliminan. `SC` y `MX` no participan en estos
pagos: son símbolos especiales.

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

1. Tras pagar las combinaciones dispersas, se eliminan **todas** las celdas de
   cada símbolo ganador (no solo un subconjunto conectado).
2. Los símbolos restantes caen por gravedad y se rellenan las celdas vacías
   desde arriba con nuevas posiciones de la tira.
3. Se vuelve a contar cada símbolo en la nueva rejilla. El bucle se corta cuando
   ningún símbolo alcanza 8 apariciones, tras `MAX_CASCADE_STEPS = 40` pasos o
   cuando la ganancia base ya supera el tope de exposición.
4. `SC` y `MX` nunca se eliminan: permanecen en la rejilla y caen con el resto.

Todas las cascadas de una tirada comparten el mismo flujo RNG. El importe de
la tirada es la suma de los pasos más el scatter, multiplicado al final.

## 7. Bombas y multiplicador

`MX` no paga por sí misma: deja una bomba en la celda con un valor fijo de la
tabla. **Al final de la tirada** se suman las bombas presentes en la rejilla
final y ese total multiplica la ganancia acumulada de la tirada (pagos
dispersos + scatter). Si no hay bombas, el multiplicador es 1.

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
mismos pesos, pero valores de bomba ligeramente superiores (2·3·4·5·6·8·11·13·
16·21·26·52·104·250) para compensar la mayor frecuencia de premios; su media es
~15,25× frente a ~5,50× del modo base.

## 8. Tropical Fever (compra de bonus)

* Coste: `feature.costMultiplier = 100` × la apuesta de la ronda.
* Duración: 10 giros gratuitos (`feature.spins = 10`).
* Rejilla y tabla de pagos dispersos idénticas al modo base.
* Diferencia matemática: los pesos de la tira dan mucho más peso a `MX`
  (1040 frente a 175), de modo que cada giro acumula varias bombas y el
  multiplicador medio de los giros con pago base es ~28×. Además, la tabla de
  valores de bomba del bonus es ~4,1 % superior a la del modo base.
* El multiplicador se aplica **por giro** (al final de cada tirada del bonus),
  no al total del bonus.
* La compra se contabiliza como una ronda con apuesta = coste del bonus, por lo
  que su RTP se mide sobre ese importe (94,98 %).

## 9. Tope de exposición

`MAX_EXPOSURE_MULTIPLIER = 10 000`. Se aplica en dos puntos:

1. Durante las cascadas: si la ganancia base ya supera el tope, se corta el
   bucle (`capped = true`).
2. Al convertir: `winCents = min(betCents × 10 000, presupuesto de la ronda)`.

El límite se aplica a la ronda completa, así que un bonus puede tocar techo
sumando sus 10 giros. El tope actúa como red de seguridad: en la certificación
de 1.000.000 de rondas base y 500.000 compras de bonus no se alcanzó en ninguna
ronda (0,0000 % de rondas topadas).

## 10. RTP certificado

Valores publicados por el motor en `gameInfo.certifiedRtp` (no se recalculan en
caliente; solo se actualizan al recalibrar):

| Modo | RTP | Error estándar | IC 95 % | Rondas simuladas |
| --- | --- | --- | --- | --- |
| Base | 95,08 % | 0,37 % | 94,34 % – 95,81 % | 1.000.000 |
| Tropical Fever | 94,98 % | 0,16 % | 94,66 % – 95,30 % | 500.000 (5.000.000 giros) |

Fecha de calibración: `2026-10-27`.

Estadísticos de la misma certificación:

| Métrica | Base | Tropical Fever |
| --- | --- | --- |
| Acierto por ronda | 61,80 % | 99,98 % |
| Acierto por tirada interna | 61,80 % | 56,97 % |
| Desviación estándar del retorno | 3,7407× | 1,1469× |
| Cascadas medias por tirada | 1,156 | 0,966 |
| Multiplicador medio con pago base | 2,432× | 27,993× |
| Rondas topadas | 0,0000 % | 0,0000 % |

La varianza del modo base exige muestras grandes: el 90 % de las rondas paga
menos de 2,00× y el 99 % menos de 12,31×, pero las rondas con bombas altas
mueven la media. Para certificación se recomienda ≥ 1.000.000 de rondas base y
≥ 500.000 compras de bonus, preferiblemente repartidas en varias semillas.

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
porcentaje de rondas topadas, RTP desglosado (pagos dispersos / scatter), media de
unidades ganadas, multiplicador medio en rondas ganadoras, percentiles y
distribución de premios por tramos. El resultado completo se guarda en
`.sim/simulation-<timestamp>.json` como evidencia reproducible.

* `--crypto` valida el flujo RNG real (más lento, sin atajos).
* El PRNG `sfc32` se usa solo para calibración rápida; no interviene en
  producción.
* Las semillas de simulación son fijas por `--seed`, de modo que dos auditorías
  con la misma versión obtienen exactamente el mismo resultado.

### 11.1 Reporte Monte Carlo con distribución de premios

`scripts/monteCarlo.js` es el informe específico de RTP, volatilidad, hit rate
y tramos de premio. No duplica las reglas: ejecuta `engine.playRound()` y agrega
los resultados, por lo que cualquier cambio futuro en rodillos, pagos dispersos,
cascadas, bombas o topes se refleja automáticamente.

```bash
# 100.000 rondas base (por defecto), semilla reproducible
npm run montecarlo

# 1.000.000 de rondas base (evidencia de mayor tamaño)
npm run montecarlo:1m

# Compra de bonus: 100.000 compras = 1.000.000 de giros internos
npm run montecarlo:feature

# Ambos modos y semilla manual
node scripts/monteCarlo.js --rounds=1000000 --mode=both --seed=20261026 --bet=1
```

El reporte imprime:

* **RTP empírico** = total pagado / total apostado × 100, con IC 95 % y error
  estándar. En modo feature el importe apostado es la compra de 100× apuesta
  base (10 giros gratis).
* **Hit rate** por ronda (pago > 0), hit con beneficio (pago > apuesta) y hit
  rate por tirada interna (útil en feature, donde una compra contiene 10
  tiradas). Cada frecuencia se muestra en porcentaje y como equivalencia
  `1 victoria por cada X giros` (o `1 tirada con premio por cada X tiradas`
  internas), calculada como `rondas / casos`. Si no hay casos, se informa
  explícitamente en lugar de mostrar una división por cero.
* **Volatilidad**: σ del retorno por ronda, σ del premio, coeficiente de
  variación, percentiles (p50, p75, p90, p95, p99, p99.9) y máximo observado.
* **Distribución de premios**, con número de casos, porcentaje de rondas, pago
  total, porcentaje del pago y aporte a RTP. Los tramos se expresan en
  múltiplos de la apuesta base: sin premio (`0`), micro (`0 < pago < 1x`),
  pequeño (`1x–<5x`), mediano (`5x–<25x`), grande (`25x–<100x`), muy grande
  (`100x–<umbral`) y jackpot (`≥umbral`). El umbral por defecto es `1000x`
  y se cambia con `--jackpot=250`, por ejemplo.
* **Desglose exacto en céntimos**: total apostado, total pagado, resultado del
  operador, pago medio por ronda, pago medio por ronda ganadora y una tabla
  por tramo con el pago en céntimos enteros y su equivalencia en créditos.
* **Topes de ganancia observados**: tope de exposición en céntimos, número de
  rondas topadas, frecuencia de tope, máximo premio observado y holgura hasta
  el límite de `10.000x` la apuesta base.
* **Diagnóstico**: cascadas medias, tiradas con bomba, tiradas con 3+ SC
  (scatter pagado) y multiplicador medio en tiradas con pago base.
* **Controles de consistencia**: suma de tramos = rondas, suma de pagos = total,
  apuestas contabilizadas y máximo dentro del tope de exposición.

Precisión y reproducibilidad:

* El dinero se acumula en céntimos enteros con `BigInt`; los porcentajes se
  calculan con división entera escalada. Los `float` solo se usan para
  estadísticos (σ, percentiles, IC), nunca para importes.
* El PRNG por defecto es `sfc32` determinista y offline. `--crypto` usa el
  HMAC-DRBG real del motor para validar el flujo de producción (más lento).
* La evidencia completa se guarda en `.sim/montecarlo-<timestamp>.json`
  (`--no-save` lo desactiva, `--json=RUTA` cambia el destino).
* 100.000 rondas son una muestra de diagnóstico, no una certificación: el IC
  del RTP sigue siendo ancho por la volatilidad del juego. Para verificar el
  RTP publicado se usan muestras grandes (≥1.000.000 de rondas) y se comprueba
  que el RTP certificado cae dentro del IC observado; la certificación actual se
  hizo con 1.000.000 de rondas base y 500.000 compras de bonus (5.000.000 giros).


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

`npm test` (suite completa con `node --test`) cubre:

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

* Pagos por dispersión: 8 símbolos aislados (sin adyacencia) pagan el tramo 8-9;
  7 no pagan; dos símbolos pueden pagar simultáneamente.
* Cascadas: se eliminan **todas** las celdas del símbolo ganador, se aplica
  gravedad/refill y se vuelve a contar; una segunda combinación encadena otro
  pago, el bucle termina cuando ningún símbolo alcanza 8 y se respeta el tope
  de 40 pasos.
* `SC` sobrevive a las cascadas y solo se evalúa en la rejilla inicial; su pago
  se suma al de los pagos dispersos. `MX` también sobrevive y la suma de bombas
  se aplica al final, después de la última cascada.
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
* Paytable de pagos dispersos (`GRID_PAYS_UNITS`, alias `CLUSTER_PAYS_UNITS`) o
  de scatter (`SCATTER_PAYS_UNITS`), incluido el tramo abierto 6+.
* Tablas de bombas (`BASE_MULTIPLIER_TABLE`, `FEATURE_MULTIPLIER_TABLE`).
* Parámetros de Tropical Fever (coste, número de giros).
* `MAX_EXPOSURE_MULTIPLIER`, `MAX_CASCADE_STEPS`, `MIN_GRID_PAY_SIZE`
  (alias `MIN_CLUSTER_SIZE`).
* Algoritmo RNG, `STRIP_LENGTH`, `STRIP_RUN_LENGTHS` o `STRIP_SEED`.

Tras cualquier cambio hay que volver a simular, actualizar `CERTIFIED_RTP` y
este documento, y subir la versión de paytable (`PAYTABLE_VERSION`). El motor
publica versión de motor, versión de paytable y checksum de tiras en cada
respuesta de auditoría para que el operador pueda demostrar qué versión estaba
en juego en cada ronda.
