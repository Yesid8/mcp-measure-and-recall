# Arquitectura

> Documento 01 de 11 · Plinth v2.0

---

## 1. Forma del repositorio

Monorepo con pnpm workspaces. ESM puro, sin build dual CJS. TypeScript en modo
`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.

```
plinth/
├── package.json                 # workspaces, scripts raíz, engines: node >=22.11
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.ts
├── .changeset/
├── .github/workflows/           # ci.yml, release.yml, bench.yml
├── docs/                        # esta especificación + ADRs + guía de módulos
├── packages/
│   ├── core/                    # @plinth/core        — modelo de tools, ctx, result, reloj, ids
│   ├── policy/                  # @plinth/policy      — red, disco, procesos: conceder o negar
│   ├── storage/                 # @plinth/storage     — log append-only, índice, blobs
│   ├── observability/           # @plinth/observability — log NDJSON, OTel, presupuestos
│   ├── protocol/                # @plinth/protocol    — ÚNICO que importa el SDK de MCP
│   ├── transport-stdio/         # @plinth/transport-stdio
│   ├── transport-http/          # @plinth/transport-http
│   ├── testing/                 # @plinth/testing     — dobles: HTTP, WS, página estática, reloj
│   ├── conformance/             # @plinth/conformance — suite ejecutable N1–N5, F1–F2
│   └── cli/                     # @plinth/cli         — plinth serve | doctor | conform | bench
├── modules/
│   ├── facts/                   # @plinth/module-facts
│   └── facts-browser/           # @plinth/module-facts-browser (Playwright, opcional)
├── examples/
│   ├── minimal-server/          # 40 líneas: un módulo de una tool
│   ├── facts-server/            # el binario publicable del módulo de hechos
│   └── gantt-sketch/            # esqueleto del segundo dominio, para probar la base
└── bench/
```

### Grafo de dependencias

Es acíclico y estrecho a propósito. Una flecha significa "importa de".

```
                       ┌──────────┐
                       │   core   │  (0 dependencias en tiempo de ejecución salvo zod)
                       └────┬─────┘
          ┌─────────────┬───┴────┬──────────────┬─────────────┐
          ▼             ▼        ▼              ▼             ▼
      ┌────────┐  ┌──────────┐ ┌───────┐  ┌────────────┐ ┌──────────┐
      │ policy │  │ storage  │ │testing│  │observabil. │ │ protocol │
      └────┬───┘  └────┬─────┘ └───┬───┘  └──────┬─────┘ └────┬─────┘
           │           │           │             │            │
           └───────────┴─────┬─────┴─────────────┘      ┌─────┴──────┐
                             ▼                          ▼            ▼
                      ┌─────────────┐           ┌────────────┐ ┌───────────┐
                      │  conformance│           │ transport- │ │ transport-│
                      └──────┬──────┘           │   stdio    │ │   http    │
                             │                  └────────────┘ └───────────┘
                             ▼
                      ┌─────────────┐
                      │   modules/  │
                      └─────────────┘
```

Reglas que la CI comprueba con `dependency-cruiser`:

1. `core` no importa de ningún otro paquete de Plinth.
2. Solo `protocol` importa los paquetes del SDK. Cualquier otra importación falla.
3. Ningún paquete de `packages/` importa de `modules/`.
4. Ningún módulo importa de otro módulo.
5. Ninguna importación crea un ciclo.

---

## 2. Las capas, de dentro hacia fuera

### 2.1 `@plinth/core` — el modelo

Define qué es una tool, qué recibe, qué devuelve y con qué contexto. No abre sockets, no
toca disco, no habla JSON-RPC. Es puro y testeable sin arrancar nada.

Contiene: `defineTool`, `defineModule`, `createServer`, el tipo `Result`, el catálogo de
errores base, el reloj inyectable, los ULID, el semáforo de concurrencia, y el compositor
que resuelve el conjunto de tools de un servidor a partir de sus módulos.

Su única dependencia en tiempo de ejecución es **zod v4**, usada como fuente única de
verdad de los esquemas: el tipo TypeScript y el JSON Schema 2020-12 que ve el cliente
salen del mismo objeto vía `z.toJSONSchema()`.

### 2.2 `@plinth/policy` — el permiso

Decide, antes de cada efecto, si se permite. Tres dominios:

- **Red**: qué hosts, qué esquemas, qué puertos. Resuelve el DNS y valida la **IP**, no el
  nombre (ver [03-protocolo §5](03-protocolo.md)).
- **Disco**: qué raíces son legibles y cuáles escribibles. Toda ruta se resuelve
  (`fs.realpath`) y se compara contra la raíz antes de abrirse.
- **Proceso**: por defecto, nada. Un módulo que necesite lanzar un subproceso lo declara y
  el operador lo concede por nombre de binario.

La política es un objeto inmutable construido al arrancar. Un handler no la modifica; la
consulta.

### 2.3 `@plinth/storage` — la memoria

Un log de eventos append-only por *(proyecto, flujo)*, con índice derivado y almacén de
blobs por contenido. Genérico: el módulo facts lo usa para afirmaciones, un módulo Gantt
lo usaría para revisiones de plan, un simulador para trazas de sesión. Detalle completo en
[04-almacenamiento](04-almacenamiento.md).

### 2.4 `@plinth/observability` — la cuenta de lo que pasa

Logger NDJSON a `stderr` (nunca a `stdout`: en stdio ese canal es el protocolo), spans
OpenTelemetry vía `@opentelemetry/api` como *peer opcional* (si no está, no-op de coste
cero), y presupuestos de latencia por tool que emiten un aviso cuando se exceden. Ver
[06-observabilidad-y-rendimiento](06-observabilidad-y-rendimiento.md).

### 2.5 `@plinth/protocol` — la frontera

El único paquete que sabe que existe MCP. Traduce en ambas direcciones.

> **Los paquetes del SDK que hablan `2026-07-28` son `@modelcontextprotocol/server` y
> `@modelcontextprotocol/client` (v2, sobre `@modelcontextprotocol/core`).
> `@modelcontextprotocol/sdk` es la línea v1 y habla `2025-11-25`.** Confundirlos costó una
> etapa: [ADR-0002](../adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md).


- `ToolDefinition` de Plinth → entrada de `tools/list` con `inputSchema`, `outputSchema`,
  `annotations`, orden determinista, `ttlMs` y `cacheScope`.
- `tools/call` → validación, construcción del `ToolContext`, invocación, y traducción del
  `Result` a `CallToolResult` con `structuredContent` o a error JSON-RPC.
- Implementa `server/discover`, obligatorio en la revisión 2026-07-28.

Si mañana sale la revisión 2027-xx-xx, se toca este paquete y una suite de contrato. Ese es
todo el propósito de que exista.

### 2.6 Transportes

`transport-stdio` (cero dependencias más allá del SDK a través de `protocol`) y
`transport-http` (streamable HTTP sobre Hono). Ambos implementan una interfaz mínima del
núcleo y son intercambiables: `server.listen(stdio())` o `server.listen(http({...}))`.

---

## 3. El viaje de una llamada

Sigue una llamada a `facts.measure.http` desde que entra hasta que sale. Cada paso está en
un sitio y solo en uno.

```
 1. transport-http        Valida Origin. Valida cabeceras Mcp-Method / Mcp-Name /
                          MCP-Protocol-Version contra el cuerpo. Extrae la identidad.
                              │  falla → 403 · 400 HeaderMismatch(-32020)
                              ▼
 2. protocol              Lee _meta: protocolVersion, clientInfo, clientCapabilities.
                          Versión no soportada → UnsupportedProtocolVersion(-32022).
                          Resuelve el nombre de tool en el registro.
                              │  desconocida → -32602
                              ▼
 3. protocol              Valida `arguments` contra el inputSchema (zod).
                              │  inválido → TOOL EXECUTION ERROR (isError: true)
                              │            con el detalle de zod, para que el modelo
                              │            se corrija. NO es un error JSON-RPC.
                              ▼
 4. core                  Construye el ToolContext: AbortSignal (cancelación del
                          transporte ∪ deadline), reloj, logger con requestId,
                          span OTel, proyecto normalizado, política, almacén.
                              ▼
 5. core                  Adquiere el permiso de concurrencia de la clase de la tool
                          ("cpu", "net", "disk", "browser"). Cola acotada.
                              │  cola llena → Err(RESOURCE_EXHAUSTED)
                              ▼
 6. module-facts          El handler. Pide a la política permiso para el destino,
                          mide, construye el resultado de dominio.
                              │  devuelve Ok(data) o Err(ToolError)
                              ▼
 7. core                  Envuelve: añade observed_at, age_seconds, duration_ms,
                          project normalizado, y el id de observación.
                              ▼
 8. core (solo dev/test)  Valida la salida contra el outputSchema. En producción
                          se omite; el coste es real y la CI ya lo garantiza.
                              ▼
 9. protocol              CallToolResult: structuredContent = la envoltura completa,
                          content[0] = el mismo JSON serializado (compatibilidad),
                          isError según el Result. _meta.serverInfo.
                              ▼
10. observability         Cierra el span, emite la línea NDJSON, comprueba el
                          presupuesto de latencia.
```

**Lo importante del paso 3.** La v1 mandaba todo error por el canal JSON-RPC. La revisión
2026-07-28 es explícita en que los errores de validación de entrada deben llegar al modelo
como *tool execution errors* para que pueda corregirse solo, y reserva JSON-RPC para lo que
el modelo no puede arreglar: tool desconocida, petición malformada, fallo del servidor.
v2 sigue esa línea y la tabla completa está en [03-protocolo §4](03-protocolo.md).

---

## 4. Cómo se añade un módulo

Un módulo es un paquete con una función que devuelve un `Module`. Nada más.

```ts
// modules/gantt/src/index.ts
import { defineModule, defineTool, Ok, Err } from '@plinth/core'
import { z } from 'zod'

const ScheduleInput = z.object({
  project: z.string(),
  plan_id: z.string().describe('Handle devuelto por gantt.plan.create'),
  as_of: z.iso.datetime({ offset: true }).optional(),
})

const criticalPath = defineTool({
  name: 'critical_path',                 // se expone como "gantt.critical_path"
  title: 'Critical path',
  description: 'Computes the critical path of a stored plan revision.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  concurrency: 'cpu',
  input: ScheduleInput,
  output: CriticalPathOutput,
  async handler(input, ctx) {
    const plan = await ctx.storage.project(input.project).log('plans').latest(input.plan_id)
    if (!plan) return Err({ code: 'PLAN_NOT_FOUND', message: `No plan ${input.plan_id}` })
    return Ok(computeCriticalPath(plan, ctx.clock.now()))
  },
})

export const gantt = defineModule({
  id: 'gantt',
  version: '0.1.0',
  // policy: 'factual' NO se declara: este módulo sí valora (holgura, criticidad)
  idPrefixes: ['p_', 'tk_'],
  config: z.object({ maxTasksPerPlan: z.number().int().default(5_000) }),
  tools: [criticalPath, /* … */],
})
```

Y se compone un servidor:

```ts
// examples/gantt-sketch/src/server.ts
import { createServer } from '@plinth/core'
import { stdio } from '@plinth/transport-stdio'
import { gantt } from '@plinth/module-gantt'

const server = createServer({
  name: 'gantt-mcp',
  version: '0.1.0',
  modules: [gantt({ maxTasksPerPlan: 20_000 })],
  policy: { net: 'deny-all', fs: { write: [process.env.PLINTH_DATA_DIR!] } },
})

await server.listen(stdio())
```

El módulo **no** ha escrito: una línea de JSON-RPC, un manejo de cancelación, un
`try/catch` de protocolo, una marca de tiempo, un identificador, un validador, una línea de
log, un span, ni un solo test de conformidad. Todo eso lo pone la base, y el kit de
conformidad ya puede correr contra él:

```bash
pnpm plinth conform --module @plinth/module-gantt
```

### Reglas de composición

- El `id` del módulo prefija sus tools: `gantt.critical_path`. Se puede remapear al
  montar (`gantt({ namespace: 'plan' })`) para resolver colisiones al agregar módulos de
  terceros.
- Dos módulos en un mismo servidor **no comparten estado**. Comparten el almacén solo en el
  sentido de que cuelgan de la misma raíz y del mismo `project`, en flujos distintos.
- Un módulo declara sus prefijos de identificador; el núcleo falla al arrancar si dos
  módulos reclaman el mismo.
- Un módulo declara la configuración que necesita como esquema zod; el núcleo la resuelve
  desde el entorno con prefijo `PLINTH_<MODULO>_` y falla al arrancar, no en la primera
  llamada, si falta algo obligatorio.

---

## 5. Los tres dominios que dan forma al núcleo

No es casualidad que la base se diseñe con tres dominios en mente y no con uno. Lo que cada
uno exige del núcleo es distinto, y la intersección es lo que el núcleo debe contener.

| Dominio | Lo que exige del núcleo | Lo que NO comparte |
|---|---|---|
| **facts** — medir y recordar | Cliente HTTP/WS acotado, registro append-only, redacción de secretos, política de red estricta | El vocabulario de afirmación y evidencia |
| **protocol-sim** — simular protocolos | Sesiones largas por *handle* explícito, streams, presupuesto de CPU, trazas grandes en blobs, cancelación fina | Máquinas de estado, codecs, temporización |
| **gantt** — planificar | Revisiones de plan versionadas y auditables, consultas paginadas sobre el log, cálculo determinista, reloj inyectable para "a fecha de" | Grafos de tareas, calendarios, recursos |

La intersección es exactamente: identidad de proyecto, log append-only con índice,
marcas de tiempo honestas, *handles* explícitos en vez de sesiones, validación, límites de
recursos, cancelación, política y observabilidad. Eso, y solo eso, es `packages/`.

> Nota sobre el simulador de protocolos: la revisión MCP 2026-07-28 **elimina las sesiones
> del protocolo**. Una simulación larga no puede apoyarse en la conexión. Se modela con el
> patrón de *handle explícito* que la propia especificación recomienda: una tool crea la
> sesión y devuelve un identificador opaco, y las siguientes lo reciben como argumento. El
> núcleo da la pieza (`ctx.handles`, §[02-nucleo-api §6](02-nucleo-api.md)) con
> autorización, caducidad y error de handle expirado ya resueltos.

---

## 6. Presupuesto arquitectónico

Metas que la CI vigila, no aspiraciones. Detalle y método en
[06-observabilidad-y-rendimiento](06-observabilidad-y-rendimiento.md).

| Magnitud | Meta | Por qué |
|---|---|---|
| Dependencias de `@plinth/core` en runtime | 1 (`zod`) | Un núcleo con árbol de dependencias grande no es una base, es un riesgo |
| Arranque frío hasta primer `tools/list` (stdio) | < 250 ms p95 | El cliente lo paga en cada sesión |
| Sobrecoste del núcleo por llamada (sin el handler) | < 1 ms p99 | Si la base cuesta más que el trabajo, sobra |
| Validación de entrada, esquema típico | < 300 µs p99 | |
| `append` + durabilidad, por evento | < 5 ms p99 | Con *group commit* (ver 04) |
| Consulta con filtros sobre 100 000 eventos | < 25 ms p95 | Con índice; sin índice sería O(n) |
| Consulta con texto sobre 100 000 eventos | < 40 ms p95 | Índice invertido + verificación literal |
| Tamaño instalado de `@plinth/core` | < 150 KB | |
| Cobertura en `packages/` | líneas ≥ 90 %, ramas ≥ 85 % | |

---

## 7. Qué NO hace esta arquitectura

Para que quede por escrito y no se relitigue en cada PR:

- **No hay plugins dinámicos cargados por ruta ni por configuración.** Los módulos se
  importan y se componen en código. Un servidor es un programa, no un contenedor de
  plugins. Cargar código arbitrario desde configuración es una superficie de ataque a
  cambio de una flexibilidad que nadie ha pedido.
- **No hay un bus de eventos interno entre módulos.** Los módulos no se hablan. Si dos
  necesitan hablarse, o son uno, o el cliente los orquesta.
- **No hay inyección de dependencias por contenedor.** El `ToolContext` es el único canal
  de dependencias, se construye explícitamente y es un objeto normal. Se lee.
- **No hay abstracción de base de datos.** El almacén es un log de ficheros. Si algún día
  hace falta Postgres, será otro paquete que implemente la misma interfaz, y la decisión
  quedará en un ADR.
- **No hay capa de caché de resultados de tools.** Cachear una medida es exactamente lo que
  el contrato factual prohíbe, y para lo demás está `ttlMs` del propio protocolo.
