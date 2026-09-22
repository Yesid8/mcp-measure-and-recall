# Protocolo, transportes y seguridad de red

> Documento 03 de 11 · Plinth v2.0 · Paquetes `@plinth/protocol`, `@plinth/transport-stdio`,
> `@plinth/transport-http`

---

## 1. Versión del protocolo

Plinth implementa **MCP `2026-07-28`** y solo esa revisión.

Esta decisión es el mayor cambio respecto a la v1, que no mencionaba versión alguna. La
revisión 2026-07-28 rompió con todas las anteriores de forma profunda:

| Lo que desapareció | Lo que hay ahora |
|---|---|
| Handshake `initialize` / `notifications/initialized` | Nada. Cada petición lleva su propio `_meta` |
| Sesiones de protocolo y cabecera `Mcp-Session-Id` | Nada. El estado va en *handles* explícitos, argumentos de tool |
| Endpoint HTTP GET y stream SSE independiente | `subscriptions/listen`: un POST cuya respuesta es un stream largo |
| `resources/subscribe` / `unsubscribe` | El filtro de `subscriptions/listen` |
| Reanudación SSE (`Last-Event-ID`) | Nada. Un stream roto pierde la petición; el cliente la reemite con **otro** id |
| `ping`, `logging/setLevel`, `notifications/roots/list_changed` | Nivel de log por petición en `_meta`; `stderr` y OTel |
| Peticiones servidor→cliente (`sampling`, `elicitation`, `roots`) | **MRTR**: el servidor devuelve `resultType: "input_required"` |

Además quedan **obsoletos** *Roots*, *Sampling* y *Logging* como funcionalidades, y el
transporte HTTP+SSE de 2024-11-05.

> **Sobre el SDK**: los paquetes que hablan esta revisión son `@modelcontextprotocol/server`
> y `@modelcontextprotocol/client` (v2, sobre `@modelcontextprotocol/core`).
> `@modelcontextprotocol/sdk@1.30.0` es la línea **v1** y habla `2025-11-25`. Además, la
> revisión moderna es **opt-in explícito** en la v2: no sale por defecto en el cable.
> Ver [ADR-0002](../adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md).

**Postura de Plinth**: no implementa compatibilidad hacia atrás con clientes *legacy*.
Un cliente que envíe `initialize` recibe un error JSON-RPC cuyo mensaje nombra
explícitamente las versiones soportadas — que es lo que la especificación pide, porque un
cliente antiguo no tiene forma de avanzar y ese mensaje es el único diagnóstico que su
usuario verá.

> Si más adelante hace falta modo *dual-era*, va en `@plinth/protocol-legacy`, nunca dentro
> de `@plinth/protocol`. Ver [10-decisiones § ADR-004](10-decisiones.md).

---

## 2. Qué implementa el servidor

| RPC | Estado | Notas |
|---|---|---|
| `server/discover` | **Obligatorio** | La especificación lo exige a todo servidor |
| `tools/list` | Sí | Orden determinista, paginado, `ttlMs` + `cacheScope` |
| `tools/call` | Sí | Con `structuredContent` |
| `resources/list`, `resources/read`, `resources/templates/list` | Opcional por módulo | |
| `prompts/list`, `prompts/get` | No en v2.0 | Ningún módulo actual los necesita |
| `subscriptions/listen` | Sí, si algún módulo declara `listChanged` | |
| `completion/complete` | No en v2.0 | |
| `initialize` | No | Error con lista de versiones soportadas |

### 2.1 `server/discover`

```jsonc
// ← resultado
{
  "resultType": "complete",
  "protocolVersions": ["2026-07-28"],
  "serverInfo": { "name": "facts-mcp", "version": "2.0.0" },
  "capabilities": {
    "tools": { "listChanged": false },
    "resources": { "listChanged": false },
    "extensions": {}
  },
  "instructions": "…"
}
```

Debe responder **sin tocar disco ni red**: es la sonda de compatibilidad y un cliente puede
llamarla antes que nada. Se construye una vez al arrancar y se sirve desde memoria.

**También lleva `ttlMs` y `cacheScope`** (§2.2). La lista normativa de resultados que deben
llevarlos incluye `server/discover`, no solo las listas.

### 2.2 `tools/list`

- **Orden determinista**: las tools se ordenan por nombre completo ascendente, siempre.
  La especificación lo pide para que el cliente cachee y para mejorar el acierto de caché
  de prompt del modelo. El núcleo ordena al componer, no en cada petición.
- **`ttlMs` y `cacheScope`**: **obligatorios**, vía la interfaz `CacheableResult`
  ([SEP-2549](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)).
  La regla normativa completa, que va más allá de `tools/list`:

  > *"Servers **MUST** include caching hints on results with `resultType: "complete"`
  > returned by: `server/discover`, `tools/list`, `prompts/list`, `resources/list`,
  > `resources/templates/list`, `resources/read`."*

  En Plinth: `ttlMs: 300_000`, `cacheScope: "private"` por defecto. `"public"` solo si el
  resultado no depende de la autorización de la petición, cosa que el núcleo sabe porque
  sabe si hay ACL por proyecto. Cuatro reglas que es fácil incumplir sin darse cuenta:

  1. `ttlMs` **debe ser `>= 0`**. Un entero en milisegundos; `0` significa "inmediatamente
     rancio", no "sin caducidad".
  2. Los resultados interinos con `resultType: "input_required"` **no llevan** sugerencias
     de caché, y un reintento MRTR (con `inputResponses` o `requestState`) **no se puede
     cachear**: depende de entradas que no están en la clave de caché.
  3. En un listado paginado, **cada página lleva su propio `ttlMs`**, pero todas las
     páginas de una misma petición **deben llevar el mismo `cacheScope`**.
  4. `"public"` puede compartirse **entre contextos de autorización distintos**, incluso
     viniendo de un endpoint autenticado. No es un control de acceso: es una declaración de
     que el contenido no es de nadie en particular.
- El conjunto de tools **no puede variar por conexión**. Sí puede variar por la
  autorización presentada, que es entrada por petición y no estado de conexión.
- Paginación por cursor opaco; el núcleo la implementa aunque hoy quepa todo en una página.

### 2.3 `tools/call` — forma del resultado

```jsonc
{
  "resultType": "complete",
  "content": [{ "type": "text", "text": "<el mismo JSON, serializado>" }],
  "structuredContent": { /* la Envelope completa */ },
  "isError": false,
  "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "…", "version": "…" } }
}
```

`structuredContent` es lo real; el bloque de texto existe por compatibilidad, como la
especificación recomienda. El `outputSchema` publicado describe la `Envelope` completa, no
solo `data`, para que el cliente pueda validar la respuesta entera.

**Excepción de tamaño**: si la envoltura serializada supera `PLINTH_MAX_RESULT_BYTES`
(por defecto 1 MiB), el bloque de texto se sustituye por un resumen de una línea y un
`resource_link` al blob completo, y se añade un `warning` con código `RESULT_LINKED`.
`structuredContent` conserva la estructura con el cuerpo grande reemplazado por su
referencia de blob. Ninguna respuesta de Plinth revienta el contexto del cliente en
silencio.

### 2.4 MRTR: `resultType: "input_required"`

Ningún módulo de la v2.0 lo necesita, pero el adaptador lo soporta porque es la única
forma de pedir algo al cliente en esta revisión, y un módulo de terceros la querrá.

```ts
// el handler devuelve
return NeedsInput({
  requests: {
    confirm_write: {
      method: 'elicitation/create',
      params: { mode: 'form', message: '…', requestedSchema: { /* … */ } },
    },
  },
  // Estado opaco que el cliente devuelve tal cual en el reintento.
  // Plinth lo firma (HMAC con clave de proceso) y lo cifra si lleva datos.
  state: { pendingId: handleId },
})
```

Reglas que impone el núcleo:

- El `requestState` **se firma siempre**. Es un dato que viaja por el cliente y vuelve; sin
  firma, es un canal de inyección hacia el servidor.
- El `requestState` tiene TTL y es de un solo uso.
- El id JSON-RPC del reintento es necesariamente distinto; el servidor no debe asumir
  correlación por id, sino por `requestState`.

---

## 3. `_meta` en cada petición

En un protocolo sin estado, `_meta` es donde va todo lo que antes vivía en la sesión.

| Clave | Obligatoria | Uso en Plinth |
|---|---|---|
| `io.modelcontextprotocol/protocolVersion` | **Sí** | Si no es `2026-07-28` → `-32022` con `data.supported` |
| `io.modelcontextprotocol/clientCapabilities` | **Sí** | Si falta una capacidad necesaria → `-32021` con `data.requiredCapabilities` |
| `io.modelcontextprotocol/clientInfo` | No | Va al log y al span. **Nunca** cambia comportamiento ni decide seguridad |
| `io.modelcontextprotocol/logLevel` | No | Nivel mínimo para esta petición. Sin este campo, el servidor **no** emite `notifications/message` |
| `progressToken` | No | Habilita `ctx.progress()`. Sin token, `progress()` es no-op |
| `traceparent`, `tracestate`, `baggage` | No | Contexto W3C: el span de la llamada cuelga del del cliente |

Una petición a la que le falte un campo obligatorio es malformada: `-32602` y, en HTTP,
`400`.

`clientInfo` es autodeclarado y no verificado. Está prohibido dentro de Plinth usarlo para
nada que no sea log, traza y visualización; hay un test de conformidad que busca su uso en
ramas condicionales.

---

## 4. Modelo de errores: el mapeo completo

Esta tabla es el corazón del adaptador y corrige el punto más débil de la v1, que enviaba
todo por el canal JSON-RPC.

| Situación | Canal | Forma |
|---|---|---|
| Tool desconocida | JSON-RPC | `-32602` |
| Petición que no cumple el esquema de `CallToolRequest` | JSON-RPC | `-32602` |
| Falta un campo obligatorio de `_meta` | JSON-RPC | `-32602` (HTTP 400) |
| Versión de protocolo no soportada | JSON-RPC | `-32022` `UnsupportedProtocolVersion`, `data.supported` |
| Falta una capacidad de cliente requerida | JSON-RPC | `-32021` `MissingRequiredClientCapability`, `data.requiredCapabilities` |
| Cabecera HTTP que no casa con el cuerpo | JSON-RPC | `-32020` `HeaderMismatch` (HTTP 400) |
| Método no implementado | JSON-RPC | `-32601` (HTTP 404) |
| Bug del servidor (excepción no capturada) | JSON-RPC | `-32603`, sin detalle al cliente |
| **Argumentos inválidos para la tool** | **Tool** | `isError: true` + detalle de zod: ruta, esperado, recibido |
| **El destino no responde / DNS / TLS / timeout** | **Tool** | `isError: true`, `error.code`, `ok: false` en la envoltura |
| **Política deniega el destino** | **Tool** | `isError: true`, `HOST_NOT_ALLOWED` |
| **Handle caducado o inexistente** | **Tool** | `isError: true`, `HANDLE_NOT_FOUND`, con cómo crear uno |
| **Cola llena** | **Tool** | `isError: true`, `RESOURCE_EXHAUSTED` |
| **El servicio observado responde 500** | **Ninguno** | `ok: true`, `isError: false`, `data.http_status === 500` |

La última fila es el contrato factual entero en una línea: **un error de observación no es
lo mismo que la observación de un error.** Solo es error lo que impidió observar.

**Códigos reservados.** El rango `-32020`…`-32099` pertenece a la especificación MCP.
Plinth **no** emite ningún código de ese rango que no sea uno de los tres definidos, y no
inventa códigos propios en el rango JSON-RPC reservado. Los códigos de Plinth son cadenas
(`HOST_NOT_ALLOWED`), no números, y viajan en el cuerpo del resultado.

Toda respuesta de error, incluidas las de protocolo, lleva `observed_at` y `age_seconds` en
`error.data`. La regla N1 no tiene excepciones.

---

## 5. Seguridad de red: el agujero que la v1 dejaba abierto

La v1 decía: *"Por defecto `localhost`, `127.0.0.1`, `[::1]` y `*.localhost`. Cualquier
otro host se rechaza salvo allowlist."*

Eso valida el **nombre**, y el nombre no es el destino. Tres formas de atravesarlo:

1. **DNS rebinding**: `evil.localhost` es un nombre que pasa el filtro y puede resolver a
   `203.0.113.7`. Peor: puede resolver a loopback en la primera consulta y a una IP pública
   en la segunda, entre la validación y la conexión (TOCTOU).
2. **Redirecciones**: la v1 permite `follow_redirects`. Un servicio local puede redirigir a
   cualquier sitio y la segunda petición ya no pasa por el filtro.
3. **Metadatos de nube**: `169.254.169.254` es *link-local*, no es "remoto" en ninguna
   lista ingenua, y es la primera parada de cualquier exfiltración en un contenedor.

`@plinth/policy` lo resuelve así, y es obligatorio para toda E/S de red de todo módulo:

### 5.1 Resolver, validar la IP, y fijarla

```
 1. Parsear la URL. Esquema en {http, https, ws, wss}. Puerto explícito o por defecto.
 2. Si el host es literal IP → va directo al paso 4.
 3. Resolver A y AAAA. Sin caché propia (la del SO ya está); con timeout.
 4. Para CADA dirección resuelta, clasificar:
        loopback   127.0.0.0/8, ::1
        private    10/8, 172.16/12, 192.168/16, fc00::/7
        link-local 169.254.0.0/16, fe80::/10        ← SIEMPRE denegado, sin excepción
        cgnat      100.64.0.0/10                     ← denegado por defecto
        public     el resto
 5. Si ALGUNA dirección cae en una clase no permitida → HOST_NOT_ALLOWED, sin abrir socket.
    (Todas, no alguna: un nombre con una A pública y otra loopback es un ataque.)
 6. Conectar a la IP VALIDADA, no al nombre: `lookup` fijado en el agente, cabecera Host
    con el nombre original, SNI con el nombre original.
 7. Cada salto de redirección repite 1–6. Sin excepción.
```

El paso 6 es lo que cierra el TOCTOU: entre validar y conectar no hay una segunda
resolución que pueda devolver otra cosa.

### 5.2 Perfiles de política

```ts
type NetProfile = 'deny-all' | 'loopback' | 'private' | 'allowlist'

policy: {
  net: {
    profile: 'loopback',                          // por defecto
    allowHosts: ['api.staging.internal:8443'],    // host:puerto exactos, sin comodines
    allowPorts: { min: 1024, max: 65535 },
    maxRedirects: 0,                              // por defecto no se siguen
    maxResponseBytes: 8 * 1024 * 1024,
    connectTimeoutMs: 5_000,
  },
}
```

- `deny-all` es lo que usa un módulo que no toca la red (Gantt). Que sea el perfil de un
  módulo y no un olvido es visible en el arranque.
- `allowlist` exige `host:puerto` literal. **No hay comodines de dominio**: `*.example.com`
  convierte un servidor MCP en un proxy de salida con un paso intermedio.
- El perfil se concede **por módulo**, no globalmente. El módulo facts tiene `loopback`; un
  módulo Gantt montado en el mismo servidor sigue teniendo `deny-all`.

### 5.3 Otras defensas de red

- **Sin proxy heredado**: se ignoran `HTTP_PROXY`/`HTTPS_PROXY` del entorno salvo que la
  política declare un proxy explícito. Un proxy heredado salta toda la validación de IP.
- **Tope de respuesta**: se corta el stream al superar `maxResponseBytes`, se marca
  `body_truncated` y se emite un `warning`. No se acumula en memoria sin tope.
- **Tope de descompresión**: ratio máxima 100:1 y tope absoluto, contra *zip bombs*.
- **Sin autenticación automática**: nunca se reenvían credenciales del entorno. Lo que se
  envía es lo que el llamante puso en los argumentos.
- **Las credenciales no cruzan un cambio de origen.** Al seguir una redirección, si el
  origen de destino (esquema, host o puerto) difiere del de la petición anterior, se
  **eliminan** `authorization`, `cookie`, `proxy-authorization` y toda cabecera cubierta por
  la política de redacción. La revalidación del destino en cada salto (§5.1, paso 7) impide
  llegar a un sitio prohibido; **no** impide llevarle el secreto a un sitio permitido pero
  distinto. Son dos defensas, no una.

---

## 6. Transporte stdio

El caso normal: el cliente lanza el proceso.

- **`stdout` es exclusivamente el protocolo.** Cualquier `console.log` en cualquier
  dependencia corrompe la sesión. El núcleo, al arrancar en modo stdio, **reemplaza
  `console.*` por el logger a `stderr`** y falla la CI si encuentra una escritura directa a
  `process.stdout` fuera de `@plinth/transport-stdio`.
- Los logs van a `stderr` como NDJSON.
- Credenciales desde el entorno, nunca por el protocolo (la especificación lo dice
  explícitamente para stdio).
- Cierre de `stdin` ⇒ apagado ordenado.
- Un proceso stdio **no es una conversación**: el cliente puede intercalar peticiones no
  relacionadas. Plinth no asocia nada a la identidad del proceso.
- `notifications/cancelled` solo existe en stdio; el núcleo la traduce a `abort` del signal
  de esa petición.

---

## 7. Transporte HTTP streamable

Un único endpoint, POST, sobre Hono. Lo que la revisión 2026-07-28 exige:

| Requisito | Implementación |
|---|---|
| Validar `Origin` | Allowlist explícita. Presente e inválido → **403**. Ausente → permitido solo si `bind` es loopback |
| Bind por defecto | `127.0.0.1`. Escuchar en `0.0.0.0` exige `PLINTH_HTTP_ALLOW_PUBLIC_BIND=1` **y** auth configurada, o el arranque falla |
| `Accept` del cliente | Debe listar `application/json` **y** `text/event-stream` |
| Cabecera `MCP-Protocol-Version` | Obligatoria; debe coincidir con `_meta`. Si no → 400 `-32020` |
| Cabeceras `Mcp-Method` / `Mcp-Name` | Obligatorias; validadas contra el cuerpo. Se decodifica el centinela `=?base64?…?=` antes de comparar |
| `Mcp-Param-{Name}` (`x-mcp-header`) | Validadas contra el cuerpo si están presentes. Plinth **no** anota `x-mcp-header` en ninguna tool propia |
| Notificación del cliente | `202 Accepted` sin cuerpo |
| Respuesta a petición | `application/json`, o `text/event-stream` si hay progreso o es `subscriptions/listen` |
| SSE | `X-Accel-Buffering: no`. Keep-alive con línea `:` cada 15 s en streams largos |
| Sin reanudación | `Last-Event-ID` ignorada |
| `GET` / `DELETE` al endpoint | **405 Method Not Allowed** |
| `Mcp-Session-Id` entrante | Ignorada; nunca se emite ni se devuelve |
| Método no implementado | **404** con cuerpo JSON-RPC `-32601` |
| Cancelación | Cierre del stream de respuesta ⇒ abort del signal. No se envía nada más de esa petición |

### 7.1 Autorización y el problema del `project`

En stdio, `project` es un argumento de confianza. **En HTTP no lo es**: cualquiera que
alcance el endpoint podría leer el registro de cualquier proyecto con solo escribir su
nombre.

Plinth ofrece tres modos, y `createServer` **falla al arrancar** si el transporte es HTTP y
no se eligió uno:

| Modo | Para qué | Cómo |
|---|---|---|
| `single-project` | Un servidor por proyecto, detrás de un proxy | `PLINTH_HTTP_PROJECT=mi-proyecto`. El argumento `project` se **ignora** y se fuerza. Si el cliente manda otro, `INVALID_PROJECT` |
| `bearer` | Despliegue interno | Tokens en `PLINTH_HTTP_TOKENS` (fichero JSON): `{ token_hash, projects: [...], label }`. Comparación en tiempo constante. El `project` pedido debe estar en la lista del token |
| `oauth` | Despliegue público | Framework de autorización de MCP. Recurso protegido con metadata, validación de `aud`, y mapeo de *claim* a proyectos. **No se implementa en v2.0**: se deja la interfaz `AuthProvider` y se documenta |

Reglas comunes:

- Sin autorización válida → **401** con `WWW-Authenticate`, antes de parsear el cuerpo.
- Un proyecto no autorizado se comporta **igual que uno inexistente**: no se filtra si
  existe.
- Todos los handles quedan atados a la identidad, además de al proyecto.
- *Rate limiting* por identidad: *token bucket* por clase de concurrencia. Al superarlo,
  `RESOURCE_EXHAUSTED` como *tool execution error* (no 429: el modelo puede reaccionar
  mejor a un error de tool).

### 7.2 Lo que HTTP obliga a repensar del módulo facts

Un servidor HTTP con política `loopback` mide el loopback **de la máquina del servidor**,
no la del usuario. Es correcto y es sorprendente. Por eso:

- La `description` de toda tool de medida dice explícitamente *"measures from the server's
  network position"*.
- `server/discover` incluye en `instructions` la posición de red y el perfil de política
  vigente.
- El despliegue HTTP del módulo facts **no** es el caso principal; el principal es stdio
  junto a lo que se mide. Está documentado como tal en su README.

---

## 8. Compatibilidad y prueba del adaptador

`@plinth/protocol` tiene una suite de contrato propia que corre contra un cliente real del
SDK, no contra dobles:

1. `server/discover` responde sin E/S y en < 5 ms.
2. Una petición sin `protocolVersion` → `-32602`.
3. Una petición con `2025-11-25` → `-32022` con `supported: ["2026-07-28"]`.
4. `initialize` → error cuyo mensaje contiene `2026-07-28`.
5. `tools/list` devuelve el mismo orden en 100 llamadas, y **tanto `tools/list` como
    `server/discover`** traen exactamente los valores que Plinth configura —hoy
    `ttlMs === 300_000` y `cacheScope === 'private'`—, no meramente `ttlMs >= 0`.
    Un aserto sobre el mínimo normativo lo satisface `ttlMs: 0`, que es el defecto de
    `@modelcontextprotocol/server`: la comprobación pasaría mientras la sugerencia de cinco
    minutos se convierte en «inmediatamente rancio». Una comprobación que no puede fallar
    no es una comprobación.
    Además, `tools/call` **no** trae sugerencias de caché: la lista normativa es cerrada, y
    sugerir caché sobre una observación sería lo contrario de lo que este servidor
    garantiza.
6. `GET` y `DELETE` al endpoint HTTP → 405.
7. `Origin` no permitido → 403 sin tocar el cuerpo.
8. `Mcp-Name` que no casa con `params.name` → 400 con `-32020`.
9. `Mcp-Name` no ASCII codificado en base64 se acepta y se decodifica para comparar.
10. Cerrar el stream de respuesta aborta el `ctx.signal` en < 100 ms y no se emite nada más.
11. Un throw del handler produce `-32603` y el mensaje **no** contiene la traza.
12. Argumentos inválidos producen `isError: true`, **no** un error JSON-RPC.
13. Un resultado de 5 MiB se entrega enlazado, no inline, con `warning: RESULT_LINKED`.

Estas trece son el contrato del paquete. Cuando salga la próxima revisión del protocolo,
son el primer sitio donde mirar.
