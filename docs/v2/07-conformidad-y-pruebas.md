# Conformidad y pruebas

> Documento 07 de 11 · Plinth v2.0 · Paquetes `@plinth/conformance` y `@plinth/testing`

La v1 tenía un §10 excelente: catorce comprobaciones que fallaban si el servidor empezaba a
opinar. Su defecto era que eran **prosa**. Nadie ejecuta la prosa, y un contrato que no se
ejecuta se erosiona en el tercer PR.

En v2 ese §10 es un paquete npm que cualquier módulo —incluidos los tuyos— importa y corre
contra sí mismo en una línea.

---

## 1. Cómo se usa

```ts
// modules/gantt/test/conformance.test.ts
import { describeConformance } from '@plinth/conformance'
import { gantt } from '../src/index.js'

describeConformance({
  module: gantt(),
  // 'factual' añade las suites F1 y F2. Este módulo no lo declara.
  profiles: ['core'],
  fixtures: { dataDir: './.tmp/conformance' },
})
```

```bash
$ pnpm plinth conform --module @plinth/module-facts
  core     ▸ 42 comprobaciones   42 ✓
  factual  ▸ 12 comprobaciones   12 ✓
```

La salida en `--json` es la que consume CI, y `--report md` genera la tabla que va en el
README del módulo. Que un módulo pueda **publicar su informe de conformidad** es parte del
argumento de por qué esta base merece la pena.

---

## 2. El perfil `core` — vale para todo módulo

Verifica los invariantes N1–N5 del [contrato](00-contrato.md#2-invariantes-del-núcleo) sobre
cualquier módulo registrado, sin saber nada de su dominio. Así es como:

### N1 — Toda respuesta trae su hora

| # | Comprobación | Método |
|---|---|---|
| 1 | Toda salida de toda tool tiene `observed_at` válido ISO 8601 con offset | Se invoca cada tool con entradas generadas del esquema y se valida la envoltura |
| 2 | Toda salida tiene `age_seconds` numérico, finito y **no negativo** | Con `FakeClock` que salta hacia atrás 10 s a mitad de la llamada; si el campo saliera de restar relojes de pared, aquí se vuelve negativo |
| 3 | Las respuestas de **error** también los tienen | Se fuerza cada `code` declarado del módulo |
| 4 | Toda colección de elementos con historia lleva edad **por elemento** | Se detectan arrays de objetos con `*_at` en el esquema de salida y se exige `age_seconds` hermano |
| 5 | `age_basis` es coherente con el origen del dato | |

### N2 — Los fallos esperados son valores

| # | Comprobación | Método |
|---|---|---|
| 6 | Ningún handler lanza ante entradas válidas del esquema | *Property testing* con `fast-check` sobre el arbitrario derivado del esquema zod; 200 casos por tool |
| 7 | Toda entrada **inválida** produce `isError: true`, no un error JSON-RPC | Mutaciones del esquema: tipo cambiado, requerido ausente, fuera de rango |
| 8 | Un throw inyectado produce `-32603` sin traza en el mensaje | Se parchea el handler para lanzar |
| 9 | Todo `code` que el módulo emite está declarado en su manifiesto | Se recogen los códigos de toda la ejecución y se comparan |

### N3 — Ningún destino sale de la política

| # | Comprobación | Método |
|---|---|---|
| 10 | Con `net: 'deny-all'`, ninguna tool abre un socket | Se instrumenta `net.Socket` y `dns.lookup` y se cuenta: debe ser 0 |
| 11 | Un nombre que resuelve a IP pública se rechaza aunque se llame `*.localhost` | Resolvedor DNS falso de `@plinth/testing` |
| 12 | Un nombre con dos direcciones, una loopback y una pública, se rechaza | El ataque de rebinding clásico |
| 13 | `169.254.169.254` se rechaza en **todos** los perfiles, incluido `allowlist` | |
| 14 | Una redirección a un destino denegado se rechaza en el salto | Servidor de pruebas que redirige |
| 15 | Ninguna ruta escrita cae fuera de `PLINTH_DATA_DIR` | `fs` instrumentado; se comprueba cada apertura en escritura |
| 16 | Un `project` con `../` no escapa del directorio | Entradas de *path traversal*, incluidas codificadas |

### N4 — Todo trabajo es cancelable y acotado

| # | Comprobación | Método |
|---|---|---|
| 17 | Abortar el signal termina cada tool en < 200 ms | Se aborta a los 50 ms y se mide |
| 18 | Ninguna tool excede su `timeout.maxMs` | Servidor de pruebas que nunca responde |
| 19 | Tras abortar no queda ningún handle, socket ni fd abierto | Se comparan los recursos activos antes y después |
| 20 | No hay reintentos implícitos | Se cuentan las peticiones que llegan al servidor de pruebas: exactamente una |

### N5 — El registro no se reescribe

| # | Comprobación | Método |
|---|---|---|
| 21 | Tras cada operación de escritura, el prefijo del fichero es idéntico byte a byte | Se toma la huella tras cada llamada |
| 22 | La interfaz del almacén no expone `update` ni `delete` | Inspección de tipos en tiempo de compilación, más reflexión |
| 23 | Borrar el índice y reconstruirlo da resultados idénticos | 50 consultas antes y después |
| 24 | Un fichero con una línea corrupta en medio se lee, se salta y se avisa | Se corrompe una línea a propósito |
| 25 | Una cola parcial (corte de energía simulado) se trunca y se registra | Se escriben bytes sin `\n` final |

### Transversales

| # | Comprobación |
|---|---|
| 26 | Ninguna tool escribe en `process.stdout` |
| 27 | Ningún secreto en claro aparece en **ningún** fichero del almacén tras una llamada autenticada |
| 28 | Ningún secreto en claro aparece en **ninguna** línea de log |
| 29 | Todo campo público de todo esquema tiene `.describe()` |
| 30 | Todo esquema genera JSON Schema 2020-12 válido (validado con Ajv 2020) |
| 31 | `readOnlyHint: true` ⇒ el módulo no llamó a ninguna escritura del almacén |
| 32 | `openWorldHint: false` ⇒ el módulo no obtuvo permiso de red |
| 33 | Dos ejecuciones de una tool `idempotentHint` con la misma entrada dan el mismo `data` (salvo campos de tiempo) |
| 34 | `clientInfo` no aparece en ninguna condición del código del módulo |
| 35 | Dos proyectos distintos no comparten ni un byte de datos ni un identificador resoluble |
| 36 | La descripción de toda tool que crea un handle menciona su caducidad |
| 37 | El arranque falla, no la primera llamada, si falta configuración obligatoria |
| 38 | `dispose()` libera todo: sin fds, sin procesos hijos, sin timers pendientes |
| 39 | Arrancar y parar 20 veces no deja crecer el RSS más de un 5 % |
| 40 | El módulo no importa de otro módulo ni de `@modelcontextprotocol/sdk` |
| 41 | Ningún fichero de `packages/` contiene una cadena de dominio (`localhost:<puerto>`, rutas de API) |
| 42 | Con la política de procesos por defecto, ninguna tool lanza un subproceso | `child_process` instrumentado: cero `spawn`/`exec` no concedidos |

---

## 3. El perfil `factual` — solo para módulos que lo declaran

### F1 — Lo medible no se responde de memoria

| # | Comprobación | Método |
|---|---|---|
| 43 | Las tools de lectura del registro **no generan tráfico de red** | Sockets instrumentados: cero, con el servicio observado caído |
| 44 | Las tools de lectura no escriben en ningún log | |
| 45 | Toda afirmación devuelta cuya evidencia sea propia trae `remeasure_with` | |
| 46 | `remeasure_with.tool` existe y `remeasure_with.arguments` valida contra su `inputSchema` | Se ejecuta de verdad contra el servidor de pruebas |
| 47 | `remeasure_with.arguments` **no contiene credenciales** | Se observa con `Authorization` y se busca el valor |
| 48 | `stale` es exactamente `age_seconds > stale_seconds` | Barrido de valores límite con `FakeClock` |
| 49 | Ninguna tool de lectura devuelve un campo que describa el estado *actual* de algo medible | Marcado en el esquema; se comprueba que no exista |

### F2 — Ningún campo de salida es un juicio

El linter recorre el JSON Schema de salida de cada tool, incluidos `$defs` y ramas de
composición, y falla si encuentra una clave que case con:

```
health  healthy  status(salvo http_status/status_text/status_code)  score  rating  grade
severity  priority  passed  failed  success(como valoración)  is_*  should_*  can_*
recommendation  suggestion  advice  summary  conclusion  verdict  quality  risk  impact
degraded  critical  warning_level  confidence
```

| # | Comprobación |
|---|---|
| 50 | Ninguna clave de la lista negra en ningún esquema de salida |
| 51 | Cada excepción declarada tiene justificación escrita en el manifiesto |
| 52 | `ok` solo existe en la envoltura, y hay un test que lo fija a `true` con un 500 |
| 53 | Simetría del diff: A→B y B→A producen el mismo `change_count` y ningún campo asimétrico |
| 54 | Ninguna `description` de tool contiene verbos de valoración (`checks whether`, `validates that`, `ensures`, `verifies that`) |

La 53 es la que más discusión dará y es la que más vale: una tool llamada `measure.http`
cuya descripción diga *"checks whether the endpoint is healthy"* ya ha roto el contrato en
el único sitio donde el modelo lo lee.

---

## 4. `@plinth/testing` — los dobles

Sin buenos dobles, las 54 comprobaciones anteriores serían lentas e inestables.

| Doble | Qué es |
|---|---|
| `FakeClock` | Reloj de pared y monótono controlados. `advance(ms)`, `jump(ms)` (salto de NTP, incluido hacia atrás), `setNow(date)` |
| `httpFixture()` | Servidor HTTP efímero: estados, cabeceras, cuerpos, retardos, cuelgue permanente, redirecciones encadenadas, cuerpos infinitos, *gzip bomb*. Cuenta peticiones |
| `wsFixture()` | Servidor WS: silencioso, periódico, con cierre a mitad, con handshake rechazado |
| `pageFixture()` | Sirve HTML estático con recursos, errores de consola, `fetch` a hosts arbitrarios |
| `fakeResolver()` | DNS controlado: un nombre → varias direcciones, o distinta respuesta en la segunda consulta (TOCTOU) |
| `tempStore()` | Directorio de datos desechable con utilidades de corrupción: truncar, corromper una línea, dejar cola parcial |
| `recordFs()` | Instrumenta `fs` y `net` y devuelve todo lo abierto, para las comprobaciones 10, 15, 19, 42, 43 |
| `inProcessClient()` | Cliente MCP real del SDK hablando con el servidor por un par de streams en memoria. Sin puertos, sin procesos, y aun así protocolo de verdad |

Todos los dobles son **deterministas**. Un test que dependa de tiempos reales o de puertos
libres es un test que fallará en CI un martes y nadie sabrá por qué.

---

## 5. La pirámide completa

| Nivel | Herramienta | Alcance | Meta |
|---|---|---|---|
| **Unidad** | Vitest | Funciones puras: normalización, ULID, redacción, diff, cursor, clasificación de IP | Líneas ≥ 90 %, ramas ≥ 85 % en `packages/` |
| **Propiedades** | fast-check | Normalización idempotente; ULID monótonos y ordenables; redacción sin falsos negativos; cursor de ida y vuelta; diff simétrico; índice ≡ escaneo lineal | 1 000 casos por propiedad |
| **Integración** | Vitest + dobles | Una tool de punta a punta contra un doble | |
| **Contrato de protocolo** | `inProcessClient` | Las 13 comprobaciones de [03 §8](03-protocolo.md) con un cliente real del SDK | 100 % |
| **Conformidad** | `@plinth/conformance` | Las 54 de arriba, por módulo | 100 %, sin excepciones sin justificar |
| **Extremo a extremo** | Proceso real | `npx` del binario publicado, stdio y HTTP, contra un servicio de pruebas | Un recorrido por transporte |
| **Rendimiento** | tinybench | [06 §4.2](06-observabilidad-y-rendimiento.md) | Regresión p99 > 10 % falla |
| **Mutación** | Stryker | Solo `packages/core` y `packages/storage` | Puntuación ≥ 70 %, semanal |

### Sobre las propiedades

Es donde más rinde el esfuerzo en un proyecto así, porque los invariantes son
matemáticos:

- `normalize(normalize(x)) === normalize(x)` para toda cadena.
- Para todo par de ULID generados en orden, `a < b` lexicográficamente.
- Para todo objeto con un secreto en cualquier profundidad, `redact` lo elimina.
- `parse(serialize(cursor)) === cursor`.
- `diff(a,b).change_count === diff(b,a).change_count`.
- Para toda secuencia de eventos, `query(índice) === query(escaneo lineal)`.
- Para toda secuencia de `append`, el fichero resultante tiene tantas líneas como eventos y
  cada prefijo es estable.

### Sobre la mutación

Stryker introduce mutantes (cambia `>` por `>=`, elimina llamadas, invierte condiciones) y
comprueba que algún test falle. Una suite verde con puntuación de mutación del 30 % es una
suite que mide cobertura, no corrección. Se aplica solo a `core` y `storage` porque es lento
y porque ahí es donde un error silencioso duele: un `>=` mal puesto en la clasificación de
IP es un fallo de seguridad que la cobertura de líneas no ve.

---

## 6. Qué corre y cuándo

| Momento | Qué |
|---|---|
| Al guardar (editor) | Typecheck incremental, lint |
| Pre-commit | Lint y formato sobre lo *staged*. Nada más: un pre-commit lento se acaba saltando |
| Pre-push | Unidad + integración de los paquetes tocados |
| PR | Typecheck, lint, unidad, propiedades, integración, contrato, **conformidad**, e2e, `publint`, `attw`, `dependency-cruiser`, auditoría de dependencias |
| PR a `main` | Lo anterior + benchmarks contra la línea base |
| Diario en `main` | Todo + mutación + e2e en la matriz Node 22/24 × Linux/macOS/Windows |
| Antes de publicar | Todo + instalación limpia del tarball + arranque real del binario |

**Windows no es opcional.** Un servidor MCP se lanza desde un editor, y una parte enorme de
los editores corre en Windows. Rutas, `fsync`, bloqueo de ficheros, finales de línea y el
lanzamiento de procesos se comportan distinto. Si la CI no lo prueba, el primer usuario de
Windows lo prueba por nosotros.
