# Plan de ejecución

> Documento 09 de 11 · Plinth v2.1 · **Revisado el 2026-09-22 tras la crítica de sesgo de
> abstracción prematura.** La versión anterior construía el núcleo primero y validaba la
> tesis en la fase 9. Eso era construir una base antes de su segundo usuario. Ver
> [10-decisiones § ADR-018](10-decisiones.md).
>
> **Este documento está escrito para Claude Code.**

---

## 0. La corrección que gobierna este plan

Los documentos 00–08 describen una base reutilizable. Están bien pensados y **no se
tiran**, pero cambian de papel:

- **Documentos 03, 05 y partes de 02 y 04 son ahora el diseño de `facts`.** Se implementan.
- **Documentos 00, 01, 06, 07 y 08 son el borrador de una extracción futura.** Se leen como
  intención, no como especificación a ejecutar hoy.

El motivo, en una frase: **una base extraída de un solo caso es una conjetura, y las
costuras salen donde las puso el primer módulo, no donde de verdad se repiten.** No se sabe
qué pertenece al núcleo hasta que hay dos cosas encima. Hasta entonces, lo honesto es un
programa que funciona, con las carpetas ordenadas donde ya sabemos que hay una costura
real.

Hay una excepción, y es la única: **la capa de protocolo se aísla desde el primer día.** No
porque lo pida un segundo módulo, sino porque la revisión `2026-07-28` acaba de mover
sesiones, handshake, errores y transporte a la vez. Esa costura ya está demostrada por los
hechos.

### El criterio de éxito real

No son las 54 comprobaciones de conformidad. Es una sola frase:

> **¿Puede otro Claude Code, que no ha visto este repositorio, conectar el servidor y
> verificar una aplicación que nosotros no conocemos, sin que el servidor sepa nada de ella?**

El entregable es **la API**. Quien la consuma es un proyecto distinto y posterior. Todo lo
demás es instrumental: una etapa que no acerque a eso se pospone, por elegante que sea el
documento que la describe.

> **Corrección del 2026-09-22.** Una versión anterior de este plan ponía como criterio
> verificar la lista de comprobaciones de una aplicación concreta. Ese criterio venía de una
> crítica externa y era de otro proyecto: mezclaba el entregable (la API) con su primer
> consumidor. El intento de ejecutarlo encontró que esa lista no existía, y el agente paró
> en vez de inventar un sustituto — que fue lo correcto. Lo que el intento sí produjo, diez llamadas contra servicios reales, se conserva
> entero como entrada de la etapa B.

---

## Reglas para quien ejecute

1. **Una etapa por sesión.** Ejecutarla entera, correr su criterio de salida, parar.
2. **El criterio de salida es un comando o una tarea real, no una opinión.**
3. **Leer antes de escribir.** Cada etapa dice qué documentos gobiernan lo que construye.
   Si algo de la especificación no encaja con la realidad (la API del SDK, por ejemplo), se
   anota en `docs/adr/` y se adapta. Decidir en silencio es lo único prohibido.
4. **No adelantar trabajo de etapas posteriores.** Especialmente: no extraer paquetes, no
   generalizar, no crear interfaces con un solo implementador. Un `TODO` es aceptable; una
   abstracción especulativa no.
5. **Duplicar está permitido y es informativo.** Cuando llegue el segundo dominio, lo que se
   haya duplicado de verdad es exactamente el contenido del núcleo. Borrar duplicación antes
   de verla dos veces es adivinar.
6. Commits pequeños, en inglés. Prosa en español, código en inglés
   ([00 §7](00-contrato.md)).

---

# ETAPA A — `facts` funcionando (esta semana)

**Objetivo**: un servidor MCP que se lanza por stdio, mide y recuerda, y con el que otro
agente verifica una aplicación real que nosotros no conocemos.

**Un solo paquete.** `@plinth/facts`, publicable con `npx`. Sin monorepo, sin workspaces,
sin `packages/`, sin `modules/`. Las carpetas internas marcan las costuras conocidas y nada
más:

```
facts/
├── package.json          ESM, node >=22.11, bin: facts-mcp
├── src/
│   ├── protocol/         ← la ÚNICA frontera dura. Solo aquí se importa el SDK
│   ├── policy/           ← validación de red por IP
│   ├── store/            ← log append-only + blobs
│   ├── kernel/           ← Result, Clock, ULID, redacción, envoltura, project
│   └── tools/            ← measure.*, recall.*
├── test/
│   ├── fixtures/         ← httpFixture, wsFixture, FakeClock, tempStore
│   └── contract/         ← las 13 del protocolo
└── docs/                 ← esta especificación
```

---

## A1 — Esqueleto y protocolo

**Gobierna**: [03-protocolo §1–§4, §6, §8](03-protocolo.md).

**Entregables**

- Paquete ESM, TypeScript `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`, Vitest, prettier, oxlint. Un `ci.yml` con typecheck, lint y
  test. Nada más de infraestructura.
- `src/kernel/`: `Result`/`Ok`/`Err`, `ToolError` con `channel`, `Clock` real y `FakeClock`,
  ULID monótono, normalización de `project`, redacción de secretos, construcción de la
  `Envelope` (con `request_id`, [02 §4](02-nucleo-api.md)).
- `src/protocol/`: adaptador contra `@modelcontextprotocol/sdk`. `server/discover` desde
  memoria; `tools/list` con orden determinista, `ttlMs` y `cacheScope`; `tools/call` con
  `structuredContent`; lectura y validación de `_meta`; la tabla de errores de
  [03 §4](03-protocolo.md) completa.
- `src/transport/stdio.ts`: sustitución de `console.*`, cierre de `stdin` como apagado,
  `notifications/cancelled` → abort.
- Una tool de juguete (`facts.ping`, que devuelve la hora) solo para cerrar el circuito.
- `inProcessClient()` en `test/fixtures`, con un cliente **real** del SDK.

**Fuera de alcance aquí**: MRTR, `subscriptions/listen`, recursos, paginación de
`tools/list`, enlazado de resultados grandes. Se añaden cuando algo los necesite.

**Criterio de salida**

Las 13 comprobaciones de [03 §8](03-protocolo.md), menos las cuatro de HTTP (6, 7, 8, 9) y
menos la 13 (enlazado), contra `inProcessClient`. Y:

```bash
npx . # arranca por stdio; un cliente MCP real lista facts.ping y lo llama
```

> **Antes de escribir el adaptador**: instalar `@modelcontextprotocol/sdk`, fijar la
> versión exacta y **leer sus tipos**. Esta especificación describe el protocolo, no la API
> del SDK. Si no encajan, manda el SDK y se anota un ADR. Lo que no se negocia es que el
> SDK no salga de `src/protocol/`.

---

## A2 — Política de red y `measure.http`

**Gobierna**: [03-protocolo §5](03-protocolo.md), [05 §4.1](05-modulo-facts.md),
[02 §7](02-nucleo-api.md).

**Entregables**

- `src/policy/`: clasificación de IPv4 e IPv6 (loopback, private, link-local, cgnat,
  public), con los bordes cubiertos: `::ffff:127.0.0.1`, `0.0.0.0`, `100.64.0.0/10`,
  direcciones comprimidas.
- El procedimiento de 7 pasos: resolver, clasificar **todas** las direcciones, rechazar si
  alguna cae fuera del perfil, **conectar a la IP validada** con Host y SNI originales,
  revalidar cada redirección. Link-local denegado siempre.
- Perfiles `deny-all` / `loopback` / `private` / `allowlist`.
- Topes: cuerpo, ratio de descompresión, timeout de conexión, redirecciones.
- `facts.measure.http` completa, con `peer` y `http_status`.
- `httpFixture()` con estados, retardos, cuelgue, redirecciones encadenadas y gzip bomb.

**Criterio de salida**

```
✓ un 500 produce ok:true, isError:false, data.http_status:500
✓ un nombre que resuelve a IP pública se rechaza aunque se llame *.localhost
✓ un nombre con dos direcciones (una loopback, una pública) se rechaza
✓ 169.254.169.254 se rechaza en los cuatro perfiles
✓ una redirección a destino denegado se rechaza en el salto
✓ un Authorization no aparece en claro en ningún fichero del almacén
✓ exactamente una petición llega al fixture: cero reintentos implícitos
```

---

## A3 — Almacén y `recall.*`

**Gobierna**: [04-almacenamiento §1, §2, §4, §5](04-almacenamiento.md),
[05 §5, §6](05-modulo-facts.md).

**Entregables**

- `src/store/`: disposición en disco, lock de instancia, comprobación de rutas con
  `realpath` y prefijo (`PATH_NOT_ALLOWED`).
- `EventLog` con `append`, `appendBatch` atómico, `history`, `query`, `scan`.
  **`fsync` por escritura, escaneo lineal en `query`.**
- Apertura con detección y truncado de cola parcial; escaneo tolerante con `warnings`
  (`LOG_LINE_UNREADABLE`, `LOG_SEQ_GAP`).
- `BlobStore` con escritura atómica hasheando al vuelo. Sin GC todavía.
- Cuatro tools: `recall.assert`, `recall.retract`, `recall.query`, `recall.history`.
  Con evidencia incrustada, derivación de `observed_at`, `remeasure_with` sin credenciales,
  `evidence: none | ref | full`, y paginación por cursor.

**Deliberadamente fuera**: *group commit*, índice invertido, checkpoint, rotación, GC,
`recall.supersede`, `recall.export`. Son optimizaciones y comodidades **especificadas en
04 y 05 y pospuestas a propósito**: entran cuando un registro real sea lento o cuando una
secuencia a medias haya hecho daño de verdad. Hasta entonces son complejidad sin evidencia.

**Criterio de salida**

```
✓ tras retract, el fichero tiene más bytes y el prefijo es idéntico byte a byte
✓ history devuelve los dos eventos en orden
✓ una cola parcial (bytes sin \n) se trunca al abrir, se registra, no se pierde lo confirmado
✓ una línea corrupta en medio se salta y produce warning, y la consulta responde igual
✓ con el servicio caído, recall.query responde y abre CERO sockets
✓ cada claim lleva su propio age_seconds, no el de la consulta
✓ FakeClock saltando 10 s hacia atrás no produce age_seconds negativo
✓ una observación de A no se puede citar en B
```

Las tres últimas son las que el crítico señaló como lo mejor del diseño. Son las que no
pueden fallar.

---

## A4 — `measure.ws` y el binario

**Gobierna**: [05 §4.2](05-modulo-facts.md).

**Entregables**

- `facts.measure.ws` con todos los topes, incluido `max_total_bytes`.
- `wsFixture()`: silencioso, periódico, cierre a mitad, handshake rechazado.
- Se retira `facts.ping`.
- README del paquete: qué es, las tres reglas, cómo conectarlo a un cliente MCP, y un
  ejemplo real copiable.
- `npx -y @plinth/facts` funcionando desde un tarball limpio.

**Criterio de salida**

```
✓ un WS silencioso durante 2 s: ok:true, message_count:0, listen_seconds_actual ≈ 2
✓ cada mensaje trae hora absoluta y offset
✓ cancelar a los 50 ms termina la tool en < 200 ms sin fds abiertos
```

---

## A5 — Rodaje contra servicios reales

**Objetivo**: someter las seis tools a servicios que no son *fixtures*, y anotar lo que
estorbe. No es una demostración; es la primera vez que la API se usa sin que nadie la haya
diseñado para el caso.

**La regla que define esta etapa**: los objetivos son **heterogéneos y anónimos**. Se mide
lo que haya escuchando en la máquina, sin saber qué es, exactamente como lo hará quien la
use dentro de seis meses contra una app que hoy no existe. **Nada de lo que se encuentre
entra en el código, ni en los tests, ni en un valor por defecto.**

**Objetivos mínimos**, cada uno porque ejercita algo distinto:

| Objetivo | Qué ejercita |
|---|---|
| Un servicio HTTP que responde 200 con JSON | El camino feliz |
| Uno que responde 200 con HTML grande | El ruido: cuánto contexto cuesta una medida |
| Uno que responde 4xx o 5xx | Que un error del servicio sea `ok: true` |
| Un puerto abierto que **no habla HTTP** | Que el código de error distinga "hay algo" de "no hay nada" |
| Un puerto cerrado | `CONNECTION_FAILED` |
| Un host que no resuelve | `DNS_FAILURE` |
| Un WebSocket, si hay alguno | `measure.ws` fuera del fixture |
| Una secuencia completa | medir → asentar → consultar → retractar → `history` |

**Criterio de salida**

> Existe `docs/hallazgos-uso-real.md` con lo que faltó, lo que sobró y lo que hubo que hacer
> a mano. Y `git diff` sobre `src/` está **vacío**: el rodaje no cambia el servidor, lo
> describe.

Si el rodaje no encuentra nada, eso también es un resultado — pero es poco probable, y si
ocurre lo más razonable es sospechar que los objetivos eran demasiado parecidos entre sí.

---

## A6 — El documento de traspaso

La API está terminada cuando alguien que no ha visto este repositorio puede usarla. Eso no
se declara: se escribe.

**Entregable**: `docs/USO.md`, dirigido a quien vaya a consumir el servidor —otro Claude
Code, contra una app que nosotros no conocemos—. En una página:

- Qué es y qué **no** es, con las tres reglas.
- Cómo conectarlo: el bloque `mcpServers` listo para copiar, con `PLINTH_DATA_DIR`
  **propio y obligatorio**, y por qué.
- Las seis tools, una línea cada una, y qué devuelven.
- **Las trampas, que son las que cuestan una tarde**: si el cliente no conecta, leer
  `stderr` (el `LOCK`); las barras de Windows en el JSON de configuración; que un 500 es
  `ok: true` y no un fallo; que `recall.*` nunca mide y por eso su respuesta puede estar
  vieja, con `remeasure_with` como salida.
- Qué hacer con lo que estorbe: dónde reportar, para que el segundo consumidor no repita el
  trabajo del primero.

**Criterio de salida**: una sesión limpia de Claude Code, con **solo** `docs/USO.md` y el
bloque de configuración, conecta el servidor y completa una secuencia
medir → asentar → consultar sin preguntar nada. Si pregunta algo, esa pregunta es un
agujero del documento, no un fallo de quien la hace.

---

# ETAPA B — Corregir con lo aprendido

**Entrada**: los documentos de hallazgos de uso real —hoy
[hallazgos-uso-real](../hallazgos-uso-real.md) y el del intento de A5,
[hallazgos-primer-intento](../hallazgos-primer-intento.md)—, y los que añada cada consumidor.

Aquí **no se añade** funcionalidad nueva de la lista de deseos. Se arregla lo que el uso
real rompió, y solo eso. El orden de prioridad es el del documento de hallazgos, no el de
esta especificación.

Dos excepciones entran sin que el uso las pida, porque son deuda con escenario real encima:

- **B0 — el `LOCK` de instancia de [04 §1](04-almacenamiento.md). ✅ Hecho el 2026-09-22**,
  adelantado a A5: [`src/store/instance-lock.ts`](../../src/store/instance-lock.ts). Cada
  cliente MCP arranca su propio servidor, así que dos procesos sobre el mismo
  `PLINTH_DATA_DIR` es el caso normal en cuanto haya dos aplicaciones conectadas; el
  segundo ahora no arranca y dice qué proceso retiene el directorio. No hay `.lock` por
  fichero: la serialización dentro del proceso basta con un solo proceso por directorio.
- **B1 — el *spike* del SDK v2**, acotado y con permiso para abandonarlo. Ver
  [ADR-0002](../adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md) y el prompt en
  [ARRANQUE](../ARRANQUE.md).

Candidatos que probablemente aparezcan, y que **solo entran si el uso los pidió**:

**Dos ya no son candidatos: tienen uso detrás.** Salieron del sondeo de puertos que hizo el
intento fallido de A5, que fue uso real aunque el objetivo fuera equivocado:

| Promovido | Por qué | Evidencia |
|---|---|---|
| `measure.tcp` | *"¿hay algo escuchando?"* fue la pregunta hecha diez veces, y no necesita HTTP | [05 §9](05-modulo-facts.md) ya lo especifica |
| `body_head_bytes`, distinto de `max_body_bytes` | 800 bytes de `<!DOCTYPE html>` por puerto para unos 60 caracteres útiles. Un tope de **lo que se trae** no es lo mismo que un tope de **lo que se mira** | Medido, no supuesto |

Y una confirmación a favor de lo que ya hay: que `CONNECTION_RESET`, `TIMEOUT` y
`CONNECTION_FAILED` sean códigos distintos separó *"hay algo que no habla HTTP"* de *"no hay
nada"*. Un `ok: false` genérico habría aplanado las tres. Eso es la regla 3 —no interpretar—
pagando dividendos.

El resto siguen siendo candidatos:

| Candidato | Especificado en | Entra si… |
|---|---|---|
| `measure.diff` | [05 §4.4](05-modulo-facts.md) | Hubo que comparar dos medidas a ojo |
| `recall.supersede` | [05 §6.3](05-modulo-facts.md) | Una secuencia a medias dejó el registro mintiendo |
| `recall.export` | [05 §6.6](05-modulo-facts.md) | Hizo falta sacar el registro del servidor |
| Índice + *group commit* | [04 §2.2, §3](04-almacenamiento.md) | Una consulta o una escritura real fue lenta. **Medir antes** |
| Enlazado de resultados grandes | [03 §2.3](03-protocolo.md) | Una respuesta reventó el contexto del cliente |
| `measure.process` | [05 §9](05-modulo-facts.md) | Quedó algo que no habla HTTP ni WebSocket y hubo que mirar a mano |
| Navegador | [05 §4.3](05-modulo-facts.md) | Hubo que abrir un panel y mirarlo |

**Criterio de salida**: un consumidor real verifica su aplicación **cómodamente**, no solo a
duras penas. Y dos semanas de uso sin que aparezca un hallazgo nuevo de los gordos.

---

# ETAPA C — El segundo dominio, sin extraer nada

**Objetivo**: el simulador de protocolos o la herramienta Gantt, funcionando.

**La regla de esta etapa es contraintuitiva y es la importante**:

> Se construye en el **mismo repositorio**, como un segundo directorio, y **se permite
> copiar y pegar** de `facts` todo lo que haga falta. No se crea ni una sola abstracción
> compartida.

Copiar duele, y ese dolor es el dato. Al terminar, lo que se haya copiado **sin
modificarlo** es el núcleo. Lo que se copió y hubo que retocar no lo es todavía: es dos
cosas parecidas, y forzarlas a una interfaz común es cómo nacen los núcleos que estorban.

Mientras se construye, llevar `docs/que-se-repitio.md`: qué se copió, si se tocó, y qué
costó.

**Criterio de salida**

El segundo dominio hace algo útil de verdad, y existe la lista de lo que se repitió
literalmente.

---

# ETAPA D — Extraer el núcleo

Ahora sí, y solo ahora, aplican los documentos [00](00-contrato.md),
[01](01-arquitectura.md), [02](02-nucleo-api.md), [06](06-observabilidad-y-rendimiento.md),
[07](07-conformidad-y-pruebas.md) y [08](08-proyecto-oss.md).

**Entregables**

- Monorepo con los paquetes que la etapa C **demostró** que hacían falta. Probablemente
  menos de los nueve que dibuja [01 §1](01-arquitectura.md); ese árbol es una hipótesis, no
  un plano.
- El sistema de módulos de [02 §8](02-nucleo-api.md), los handles de [02 §6](02-nucleo-api.md),
  las clases de concurrencia de [02 §5](02-nucleo-api.md) — **cada uno solo si los dos
  dominios lo usan**.
- `@plinth/conformance` con los invariantes que sobrevivieron al contacto con dos dominios.
- Transporte HTTP ([03 §7](03-protocolo.md)) si hace falta de verdad.
- Observabilidad ([06](06-observabilidad-y-rendimiento.md)) e infraestructura OSS
  ([08](08-proyecto-oss.md)).

**Criterio de salida — el que de verdad prueba la tesis**

```bash
git diff --stat main -- packages/
# vacío tras construir una tool nueva en cualquiera de los dos módulos
```

Y una revisión honesta: si al extraer resulta que los dos dominios comparten menos de lo
que parecía, **la conclusión correcta es que no había base**, y dos programas buenos valen
más que una abstracción mediocre. Esa posibilidad tiene que estar sobre la mesa desde ahora
o la etapa D se convierte en una profecía autocumplida.

---

## Qué se pospone y por qué

Resumen en una tabla, para que nadie lo añada con buena intención antes de tiempo.

| Pospuesto a | Qué | Por qué |
|---|---|---|
| **Etapa B** | `measure.diff`, `supersede`, `export`, índice, *group commit* | Optimizaciones y comodidades sin evidencia de uso |
| **Etapa B o C** | Navegador y Playwright | Cientos de MB y una dependencia nativa antes de saber si se necesita |
| **Etapa D** | Monorepo, paquetes, semver, npm | No se publica una API que no se ha usado dos veces |
| **Etapa D** | Sistema de módulos, handles, clases de concurrencia | Son abstracciones; hacen falta dos usuarios para dibujarlas |
| **Etapa D** | Kit de conformidad como paquete | Los invariantes se prueban antes como tests normales |
| **Etapa D** | Transporte HTTP y autorización | El caso principal es stdio junto a lo que se mide |
| **Etapa D** | OpenTelemetry | `stderr` en NDJSON resuelve el 90 % con el 2 % del trabajo |
| **Nunca** | Compatibilidad con MCP anterior a `2026-07-28`; carga dinámica de módulos; bus de eventos; caché de resultados; panel web | [09 anterior y 01 §7](01-arquitectura.md) |

---

## Lo que sigue valiendo entero de los documentos 00–08

Para que la poda no se lleve lo bueno por delante. Esto es contrato desde la etapa A:

1. **Lo medible no se responde de memoria.** `recall.*` no mide nunca, y entrega
   `remeasure_with` en vez de fingir que sabe el estado actual.
2. **Toda respuesta trae la hora, y cada elemento de una colección trae la suya.** No la de
   la consulta. Sobre reloj monótono.
3. **No interpreta ni puntúa.** Ningún campo de salida es un juicio. `ok` significa "se
   pudo observar" y nada más.
4. **Un error de observación no es la observación de un error.** Un 500 limpio es
   `ok: true`.
5. **Nada se borra.** Retractación con motivo, log append-only, sin `delete` en la interfaz.
6. **El SDK no sale de `src/protocol/`.**
7. **La red se valida por IP resuelta, y se conecta a la IP validada.**
8. **Los secretos se redactan antes de persistir, nunca después.**
