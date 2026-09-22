# Observabilidad y rendimiento

> Documento 06 de 11 · Plinth v2.0 · Paquete `@plinth/observability`

Un servidor MCP corre casi siempre como subproceso de otro programa, sin nadie mirando.
Cuando algo va mal, lo único que queda es lo que el servidor dejó escrito. Y como el
protocolo dejó **obsoleta la funcionalidad de Logging** en la revisión 2026-07-28, el canal
ya no es el protocolo: es `stderr` y OpenTelemetry.

---

## 1. Logging

### 1.1 Dónde y en qué formato

- **Siempre a `stderr`. Nunca a `stdout`.** En transporte stdio, `stdout` es el protocolo:
  una sola línea suelta corrompe la sesión. El núcleo, al arrancar en stdio, sustituye
  `console.log/info/warn/error` por el logger, y la CI falla si encuentra una escritura
  directa a `process.stdout` fuera de `@plinth/transport-stdio`.
- **NDJSON**: un objeto JSON por línea. Legible por máquina, y por humano con `jq`.
- Formato de consola legible solo si `PLINTH_LOG_FORMAT=pretty` y `stderr` es un TTY.

```json
{"t":"2026-09-22T10:14:03.482+02:00","lvl":"info","msg":"tool.call","req":"r_01K5…",
 "trace":"4bf92f3577b34da6a3ce929d0e0e4736","tool":"facts.measure.http",
 "project":"checkout-web","dur_ms":143,"ok":true,"client":"claude-code/2.1.0"}
```

Campos siempre presentes: `t`, `lvl`, `msg`, y — dentro de una llamada — `req`, `tool`,
`project`. `msg` es un **evento estable** (`tool.call`, `tool.panic`, `storage.append`,
`policy.deny`), no una frase: se agrupa y se alerta sobre él.

### 1.2 Niveles

`trace` `debug` `info` `warn` `error` `fatal`. Por defecto `info`.

Nivel por petición: si el cliente envía `io.modelcontextprotocol/logLevel` en `_meta`, esa
petición usa ese nivel. La especificación es tajante: **el servidor no debe emitir
`notifications/message` para peticiones que no incluyan ese campo.** Plinth lo respeta; el
log a `stderr` no se ve afectado.

### 1.3 Lo que nunca se registra

- Valores de cabeceras o campos redactados (§[02-nucleo-api §7](02-nucleo-api.md)). El
  logger aplica la misma política de redacción antes de serializar. Sin excepciones ni
  modo verboso que la salte.
- Cuerpos de petición y respuesta. En `debug` se registra tamaño, tipo y hash; el contenido
  vive en el almacén, que es donde se puede auditar el acceso.
- Trazas de excepción hacia el cliente. Al log sí, íntegras.

### 1.4 Muestreo

En `info` no hay muestreo: una línea por llamada, y una llamada es cara. En `debug` y
`trace`, muestreo por `requestId` con ratio configurable, para que activar `trace` en
producción no sea un incidente.

---

## 2. Trazas: OpenTelemetry

`@plinth/observability` depende de **`@opentelemetry/api` y de nada más**. Es la regla para
bibliotecas: la API es un contrato ligero con un no-op integrado; el SDK, los exportadores y
la configuración los aporta la aplicación. Si nadie registra un proveedor, cada `startSpan`
cuesta prácticamente cero y no se exporta nada.

### 2.1 Propagación de contexto

La revisión 2026-07-28 documenta `traceparent`, `tracestate` y `baggage` como claves
reservadas de `_meta`, en formato W3C. Plinth:

- **Extrae** el contexto entrante de `_meta` y hace que el span de la llamada cuelgue del
  del cliente. Una traza que empieza en el cliente MCP y termina en un `fsync` es una sola
  traza.
- **Inyecta** el contexto en las peticiones salientes que haga un módulo, para que el
  servicio medido —si está instrumentado— aparezca en la misma traza.

### 2.2 Spans

| Span | Atributos |
|---|---|
| `mcp.server.request` | `mcp.method`, `mcp.tool.name`, `mcp.client.name`, `plinth.project`, `plinth.request_id` |
| `plinth.tool.execute` | `plinth.module`, `plinth.concurrency_class`, `plinth.queue_wait_ms` |
| `plinth.policy.check` | `plinth.policy.domain`, `plinth.policy.decision` |
| `plinth.storage.append` | `plinth.log.name`, `plinth.batch.size`, `plinth.fsync_ms` |
| `plinth.storage.query` | `plinth.index.hit`, `plinth.candidates`, `plinth.scanned` |
| HTTP/WS salientes | Convenciones semánticas estándar, con la URL **redactada** |

Se siguen las convenciones semánticas de OpenTelemetry para MCP donde existen, en vez de
inventar nombres propios.

### 2.3 Métricas

Vía la API de métricas de OTel; no-op si no hay proveedor.

| Instrumento | Tipo | Etiquetas |
|---|---|---|
| `plinth.tool.calls` | contador | `tool`, `outcome` (`ok`\|`tool_error`\|`protocol_error`\|`panic`) |
| `plinth.tool.duration` | histograma | `tool` |
| `plinth.tool.queue_wait` | histograma | `class` |
| `plinth.tool.in_flight` | *gauge* | `class` |
| `plinth.tool.rejected` | contador | `class`, `reason` |
| `plinth.policy.denials` | contador | `domain`, `reason` |
| `plinth.storage.append.duration` | histograma | `log` |
| `plinth.storage.batch.size` | histograma | `log` |
| `plinth.index.rebuilds` | contador | `log`, `reason` |
| `plinth.budget.exceeded` | contador | `tool` |

**Ninguna métrica lleva el `project` como etiqueta por defecto.** El `project` es una cadena
libre controlada por el llamante: usarlo de etiqueta es una explosión de cardinalidad y, en
HTTP, un vector de denegación de servicio contra el backend de métricas. Se puede activar
con `PLINTH_METRICS_PROJECT_LABEL=1` en despliegues donde el conjunto de proyectos es
conocido y pequeño.

---

## 3. Presupuestos de latencia

Cada tool declara `budgetMs`: lo que se considera normal en su p99. No es un timeout — el
timeout está aparte y aborta —; es el umbral a partir del cual **el servidor se queja de sí
mismo**.

```ts
defineTool({ name: 'recall.query', budgetMs: 50, timeout: { defaultMs: 5_000, maxMs: 30_000 }, … })
```

Al superarse:

- `warn` con `msg: "budget.exceeded"`, la duración, el presupuesto y el desglose por fase
  (espera en cola, política, handler, almacén, serialización).
- Se incrementa `plinth.budget.exceeded`.
- Con `observability.budgets: 'error'` (el valor que usa la CI), además se **falla el
  test**. Así una regresión de rendimiento aparece en el PR que la introduce, no seis meses
  después en producción.

El desglose por fase es lo que hace útil el aviso: "`recall.query` tardó 400 ms, de los
cuales 380 en el almacén con `index.hit: false`" dice qué arreglar. "Tardó 400 ms" no.

---

## 4. Rendimiento: método antes que números

### 4.1 Reglas de diseño que el código debe cumplir

Son revisables en un PR sin medir nada:

1. **Nada bloqueante en el bucle de eventos.** Ni `fs.*Sync`, ni JSON de megabytes en el
   hilo principal, ni bucles de CPU sin ceder. Lo pesado va a un `Worker` o se trocea.
2. **El trabajo repetido se hace una vez, al arrancar.** Los JSON Schema se generan y se
   cachean; `tools/list` se serializa una vez y se sirve desde un `Buffer` hasta que cambie.
3. **Streaming por defecto.** Cuerpos HTTP, blobs, exports y recursos se leen y se escriben
   como streams con tope. No se hace `readFile` de nada que pueda crecer.
4. **Sin copias innecesarias.** Un cuerpo que va a blob se escribe mientras se hashea y no
   se materializa completo en memoria.
5. **Los caminos rápidos no asignan.** El camino de una llamada sin errores no crea arrays
   intermedios ni cierres por elemento. Es el único sitio del proyecto donde esto importa
   tanto como para mencionarlo.
6. **Validar la salida cuesta.** Se hace en dev, test y CI (`validateOutput: true`); no en
   producción. El riesgo lo cubre la conformidad.
7. **Un `await` es un cambio de contexto.** En bucles calientes se usa `Promise.all` con
   concurrencia acotada, no `for await` secuencial.

### 4.2 Banco de pruebas

`bench/` con **tinybench**, corriendo en CI sobre un runner fijo, con tres suites:

| Suite | Qué mide |
|---|---|
| `core.bench.ts` | Sobrecoste por llamada sin handler, validación, construcción de envoltura, semáforo |
| `storage.bench.ts` | `append` aislado y concurrente, `query` con y sin índice, reconstrucción, blobs |
| `protocol.bench.ts` | `tools/list` en frío y en caliente, `tools/call` de ida y vuelta por stdio |

Metodología, porque un benchmark sin método es ruido:

- Fase de calentamiento explícita; se descarta.
- Mínimo 30 iteraciones o 2 s, lo que sea mayor.
- Se publica **p50, p95, p99 y desviación**, nunca la media sola.
- Comparación contra la línea base guardada en `bench/baseline.json`, versionada.
- **Umbral de regresión: +10 % en p99** falla el build. Una mejora que baje la línea base la
  actualiza en el mismo PR, a propósito y a la vista.
- La suite de benchmarks corre en su propio workflow (`bench.yml`), no en cada push, para
  que una CI ruidosa no la vuelva inútil: en cada PR a `main` y a diario sobre `main`.

### 4.3 Metas

Repetidas desde [01-arquitectura §6](01-arquitectura.md) para tenerlas a mano.

| Magnitud | Meta |
|---|---|
| Arranque frío hasta primer `tools/list` (stdio) | < 250 ms p95 |
| Sobrecoste del núcleo por llamada | < 1 ms p99 |
| Validación de entrada, esquema típico | < 300 µs p99 |
| `tools/list` en caliente | < 200 µs p99 |
| `append` + durabilidad | < 5 ms p99 |
| `append` con 64 concurrentes | > 8 000 ev/s |
| `recall.query` con filtros sobre 100 k afirmaciones | < 25 ms p95 |
| `recall.query` con texto sobre 100 k afirmaciones | < 40 ms p95 |
| Memoria en reposo, servidor con el módulo facts | < 90 MB RSS |
| Dependencias de `@plinth/core` en runtime | 1 |

---

## 5. Diagnóstico en caliente

### 5.1 `plinth doctor`

Un comando que responde a "¿por qué no funciona?" sin leer código:

```
$ plinth doctor
✓ node v22.14.0                        (>= 22.11 requerido)
✓ data dir  ~/.plinth                  escribible, 1.2 GB libres
✓ instance lock                        libre
✓ modules   facts@2.0.0                policy=factual, 9 tools
  ⚠ facts-browser                      no instalado → browser tools ocultas
✓ policy    net=loopback               allowHosts: (ninguno), redirects: 0
✓ storage   3 proyectos, 41 208 eventos, 0 avisos
  ⚠ checkout-web/claims.idx            checkpoint 4 209 eventos por detrás
✓ protocol  2026-07-28                 server/discover en 1.8 ms
✓ otel                                 sin proveedor registrado (no-op)
```

Cada aviso trae la orden que lo arregla. `--json` para automatizarlo, con la forma
`{ checks: [{ id, pass, detail }] }`.

`doctor` es una herramienta de diagnóstico de la línea de comandos, **no la salida de una
tool**: F2 no le aplica y sí puede emitir un veredicto. El campo se llama `pass` y no `ok`
precisamente para no reutilizar una palabra que en la envoltura significa otra cosa.

### 5.2 Recurso MCP de salud del propio servidor

`plinth://self` — solo lectura, y con una restricción que importa: **es aritmética, no
valoración**. Devuelve recuentos, duraciones y versiones. No devuelve `status: "healthy"`
ni nada parecido; ni siquiera el núcleo se salta F2, porque el núcleo es lo que el módulo
factual cita.

```json
{
  "observed_at": "…", "age_seconds": 0, "uptime_ms": 918_233,
  "server": { "name": "facts-mcp", "version": "2.0.0", "protocol": "2026-07-28" },
  "modules": [ { "id": "facts", "version": "2.0.0", "tools": 9 } ],
  "calls": { "total": 1421, "by_outcome": { "ok": 1390, "tool_error": 30, "protocol_error": 0, "panic": 1 } },
  "in_flight": { "cpu": 0, "net": 1, "disk": 0 },
  "storage": { "projects": 3, "events": 41208, "bytes": 18_442_112, "warnings": 0 },
  "memory": { "rss": 88_100_864, "heap_used": 31_442_112 }
}
```

`panic: 1` es un dato accionable que hoy se pierde en el log. Que esté aquí significa que
el siguiente agente que consulte el servidor puede ver que algo reventó y decidir qué hacer.

### 5.3 Reproducción de un fallo

Toda llamada lleva `requestId` en el log, en el span y en `_meta` de la respuesta de error.
Con ese identificador:

```
$ plinth replay r_01K5Z9K2QX7T4B --from ~/.plinth
```

reconstruye la llamada desde el flujo `observations` — la tool, el `target` efectivo
(**con los secretos redactados**, así que una reproducción autenticada exige volver a
aportar credenciales) — y la vuelve a ejecutar, mostrando un diff contra la observación
original. Es `measure.diff` desde la línea de comandos, y es la herramienta que convierte
"a veces falla" en un caso reproducible.
