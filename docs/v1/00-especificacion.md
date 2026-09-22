# MCP de Hechos — Especificación

> Versión de la especificación: 1.0 · Fecha: 2026-09-22 · Estado: propuesta cerrada, lista para implementar

---

## 1. Qué es esto

Un servidor MCP de propósito único. Hace dos cosas y nada más:

- **Medir**: apunta a un servicio local y devuelve la medida cruda, con la hora exacta en que se tomó.
- **Recordar**: mantiene un registro por proyecto donde cada entrada es *afirmación + evidencia + quién la midió + fecha*.

No opina. No interpreta. No puntúa. No sabe nada de ningún proyecto concreto: el proyecto entra siempre como parámetro.

El valor del servidor está en que un agente que lo consulta no tiene que verificar lo que le responde. En el momento en que el servidor empiece a emitir juicios, deja de ser una fuente y pasa a ser otro agente al que hay que verificar — que es exactamente el trabajo que existe para ahorrar.

### Para qué sirve, en una frase de uso

Un agente está trabajando en la app A. Necesita saber si `/api/orders` responde 200 ahora mismo. Pregunta al MCP; recibe el estado, el cuerpo y la hora. Anota en el registro del proyecto A: "`/api/orders` devuelve 200 con lista vacía", con esa medida como evidencia. Tres días después otro agente lee el registro, ve que la afirmación tiene tres días, vuelve a medir y encuentra un 500: retracta la afirmación con motivo, y añade la nueva. La afirmación vieja sigue ahí, marcada, con su historia.

---

## 2. Las dos reglas que lo hacen valioso

Estas dos reglas no son recomendaciones de estilo. Son el contrato. Sin ellas el servidor no aporta nada sobre un agente cualquiera.

### R1 — Lo medible no se responde de memoria

Si un dato se puede medir ahora, **ninguna herramienta puede devolverlo desde el registro**. El registro guarda afirmaciones históricas con su evidencia; no es una caché de estado actual.

En la práctica:

- `recall.*` **nunca** ejecuta una medida ni sintetiza el estado actual.
- `recall.*` devuelve cada afirmación con su `measured_at` y su `age_seconds`, y marca `stale: true` cuando pasa del umbral de frescura.
- Cuando una consulta al registro trae afirmaciones sobre un objetivo que es medible (una ruta, un WS, un panel), la respuesta incluye `remeasure_with`: el nombre exacto de la tool de medida y los parámetros con los que se tomó la evidencia original, para que quien lea pueda volver a medir sin adivinar.
- El servidor no decide si hay que volver a medir. Da la edad y el cómo; la decisión es de quien lee.

### R2 — Toda respuesta trae la hora

Absolutamente toda respuesta de toda herramienta incluye:

| Campo | Tipo | Significado |
|---|---|---|
| `measured_at` | ISO 8601 con offset | Instante en que se tomó la medida (o en que se escribió/consultó el registro) |
| `age_seconds` | número | Segundos transcurridos entre `measured_at` y el momento de responder. En una medida fresca es ~0; en una entrada del registro es su antigüedad real |

En las respuestas del registro, cada afirmación lleva **su propio** `measured_at` y `age_seconds`, además del de la consulta. La hora de la afirmación es la de la medida que la respalda, no la de la escritura.

---

## 3. Fronteras: qué no lleva

Prohibiciones duras. Un cambio que viole cualquiera de estas líneas no es una mejora del servidor: es otro servidor.

**No interpreta ni puntúa.** Nada de `health`, `status: "ok" | "degraded"`, `score`, `severity`, `passed`, `is_working`, `summary`, `recommendation`, `should_fix`. Ninguna respuesta contiene un campo cuyo valor sea un juicio. Un `200` es un `200`; que eso sea bueno lo decide quien pregunta.

**No conoce ningún proyecto.** Cero rutas, puertos, nombres de servicio, esquemas, selectores o convenciones cableados. Todo entra por parámetro en cada llamada. El servidor no tiene fichero de configuración por proyecto ni autodescubrimiento. Si funciona para la app A y no para la app B, está mal construido.

**No escribe en los ficheros de ningún proyecto.** Sus únicas escrituras son a su propio directorio de datos. No hace `git`, no crea ni edita código, no toca `node_modules`, no arranca ni reinicia servicios, no lanza builds, no instala nada.

**No agrega ni resume series.** No calcula medias, percentiles, tendencias, tasas de error ni SLOs. `measure.diff` compara dos medidas y describe los cambios campo a campo; no dice si el cambio es una mejora o una regresión.

**No reintenta en silencio.** Un fallo de red es una medida: se devuelve como tal, con su hora. Sin reintentos implícitos, sin backoff oculto, sin fallback a otra URL. Si no pudo medir, lo dice.

**Solo destinos locales.** Por defecto `localhost`, `127.0.0.1`, `[::1]` y `*.localhost`. Cualquier otro host se rechaza salvo que esté en la allowlist explícita de la configuración del servidor (ver §8). Esto evita que el servidor se convierta en un proxy de salida arbitrario.

**No borra afirmaciones.** Nunca. Ver §6.

---

## 4. Modelo de datos

### 4.1 Proyecto

Un `project` es una cadena libre, normalizada. Se crea en su primer uso; no hay que declararlo.

- Normalización: minúsculas, se recortan los espacios de los extremos, y cada carrera de caracteres fuera de `[a-z0-9._-]` se colapsa en un solo `-`.
- Restricciones: de 1 a 64 caracteres tras normalizar; no puede ser `.` ni `..`.
- La respuesta de cualquier tool que reciba `project` devuelve el `project` normalizado, para que quien llama vea con qué identidad se escribió.
- Cada proyecto vive aislado: un fichero de registro propio. Nada se comparte entre proyectos.

Esa normalización es todo el conocimiento de proyectos que tiene el servidor. No sabe qué es cada proyecto ni le importa.

### 4.2 Medida (`Measurement`)

Envoltura común a todas las tools de la familia *Medir*:

```json
{
  "measurement_id": "m_01J8Z9K2QX7T4B",
  "kind": "http | ws | browser | diff",
  "project": "checkout-web",
  "target": { "...": "los parámetros efectivos con que se midió" },
  "measured_at": "2026-09-22T10:14:03.482+02:00",
  "age_seconds": 0.2,
  "duration_ms": 143,
  "ok": true,
  "error": null,
  "data": { "...": "el cuerpo crudo, específico de cada kind" }
}
```

- `measurement_id`: identificador ordenable por tiempo. Es lo que se cita como evidencia en el registro y lo que consume `measure.diff`.
- `ok`: **no es un juicio sobre el servicio medido**. Significa únicamente "la medida se pudo tomar". Un HTTP 500 recibido limpiamente es `ok: true` con `data.status: 500`. Un DNS que no resuelve es `ok: false` con `error` poblado.
- `error`: `null`, o `{ "code": "...", "message": "..." }` con un `code` de la tabla de §7. Nunca una explicación de por qué el servicio está mal.
- `target`: los parámetros **efectivos**, tras aplicar defaults y normalización. Es lo que hay que repetir para volver a medir igual.

Toda medida se persiste en el búfer de medidas del proyecto (§4.4) para poder citarla y diferenciarla después.

### 4.3 Afirmación (`Claim`)

Unidad del registro. Append-only.

```json
{
  "claim_id": "c_01J8Z9M5P0RA2C",
  "project": "checkout-web",
  "statement": "GET /api/orders responde 200 con un array vacío",
  "evidence": [
    { "type": "measurement", "measurement_id": "m_01J8Z9K2QX7T4B" }
  ],
  "measured_by": "claude-opus-5 (sesión 3f9a1c7e)",
  "measured_at": "2026-09-22T10:14:03.482+02:00",
  "recorded_at": "2026-09-22T10:14:07.005+02:00",
  "tags": ["api", "orders"],
  "retracted": null
}
```

Campos y su porqué:

- `statement`: texto libre, 1–2000 caracteres. El servidor **no lo parsea, no lo valida semánticamente y no lo interpreta**. Es la afirmación de quien la hace.
- `evidence`: lista con al menos un elemento. Cada elemento es una de estas formas:
  - `{ "type": "measurement", "measurement_id": "m_..." }` — referencia a una medida tomada por este servidor. El servidor verifica que exista en el búfer del **mismo** proyecto y la deja embebida (snapshot) en el registro, para que la afirmación siga siendo auditable cuando el búfer rote.
  - `{ "type": "external", "description": "...", "uri": "..." }` — evidencia que este servidor no tomó (un log, una captura, una observación humana). `uri` es opcional. El servidor la guarda literal y no la comprueba; queda claramente distinguible de la medida propia.
- `measured_by`: quién. Cadena libre obligatoria, 1–200 caracteres. Sin valor por defecto: una afirmación sin autor no entra.
- `measured_at`: cuándo se midió lo que sostiene la afirmación. Si toda la evidencia es de tipo `measurement`, se deriva del `measured_at` más antiguo de las medidas citadas y no se puede sobrescribir. Si hay evidencia externa, quien llama debe proporcionarlo.
- `recorded_at`: cuándo se escribió la entrada. Lo pone el servidor.
- `retracted`: `null`, o `{ "at": "...", "by": "...", "reason": "...", "superseded_by": "c_..." | null }`.

### 4.4 Persistencia

Un directorio raíz único, configurable (§8). Por defecto `~/.mcp-hechos/`.

```
~/.mcp-hechos/
  projects/
    checkout-web/
      claims.jsonl          # registro append-only: una operación por línea
      measurements.jsonl    # búfer rotativo de medidas
      blobs/                # cuerpos y capturas grandes, por hash de contenido
        sha256-a1b2c3...json
        sha256-d4e5f6...png
  server.json               # config efectiva del servidor (no de los proyectos)
```

**`claims.jsonl` — append puro.** Cada línea es un evento, no un estado:

```jsonl
{"op":"assert","claim_id":"c_01J8Z9M5P0RA2C","project":"checkout-web","statement":"...","evidence":[...],"measured_by":"...","measured_at":"...","recorded_at":"...","tags":[...]}
{"op":"retract","claim_id":"c_01J8Z9M5P0RA2C","at":"...","by":"...","reason":"...","superseded_by":"c_01J8ZB7..."}
```

El estado de una afirmación se obtiene reproduciendo sus eventos en orden. Nunca se reescribe ni se trunca una línea existente. No hay compactación, no hay `DELETE`, no hay vacuum. Un fichero corrupto o una línea ilegible se salta al leer y se reporta en `warnings`; no se repara reescribiendo.

Escritura: `open` en modo append + una línea completa terminada en `\n` + `fsync`. Un bloqueo por fichero (`claims.jsonl.lock`) serializa escritores concurrentes; si no se obtiene en 5 s, error `LOCK_TIMEOUT`.

**`measurements.jsonl` — búfer rotativo.** Las medidas son voluminosas y la mayoría se descarta. Se conservan las últimas `measurement_retention` (por defecto 500) por proyecto y se rota por tamaño. Rotar no rompe nada: las medidas citadas por una afirmación ya están embebidas en `claims.jsonl`.

**`blobs/`** guarda por hash cualquier cuerpo o captura que pase de `inline_body_limit` (por defecto 256 KiB). El registro y las medidas referencian `{"blob": "sha256-...", "bytes": N, "content_type": "..."}`. Los blobs referenciados por una afirmación no se recolectan; los referenciados solo por medidas rotadas, sí.

---

## 5. Familia *Medir*

Cuatro tools. Todas devuelven la envoltura `Measurement` de §4.2, todas exigen `project`, ninguna concluye nada.

### 5.1 `measure.http`

Una petición HTTP a un servicio local. Devuelve el estado y el cuerpo, crudos.

**Parámetros**

| Nombre | Tipo | Req. | Default | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `url` | string | sí | — | Absoluta. Host sujeto a la política de §3 |
| `method` | enum | no | `GET` | `GET POST PUT PATCH DELETE HEAD OPTIONS` |
| `headers` | objeto | no | `{}` | Valores de cabeceras sensibles se redactan en la respuesta (§9) |
| `body` | string \| objeto | no | — | Objeto ⇒ se serializa a JSON y se fija `content-type` si no viene |
| `timeout_ms` | entero | no | `10000` | 1–120000 |
| `follow_redirects` | bool | no | `false` | En `false`, un 302 se devuelve como 302 |
| `max_body_bytes` | entero | no | `1048576` | Al exceder, se trunca y se marca |

**`data`**

```json
{
  "status": 200,
  "status_text": "OK",
  "headers": { "content-type": "application/json; charset=utf-8" },
  "body": { "orders": [] },
  "body_format": "json | text | base64 | blob",
  "body_bytes": 17,
  "body_truncated": false,
  "timing_ms": { "dns": 1, "connect": 3, "tls": null, "ttfb": 118, "total": 143 },
  "redirect_chain": []
}
```

`body_format` describe cómo se codificó, no qué significa. Si el `content-type` es JSON y parsea, `body` es el objeto y `body_format` es `json`; si declara JSON y no parsea, se devuelve el texto tal cual con `body_format: "text"` y un aviso en `warnings` — sin corregirlo ni opinar.

**Lo que esta tool no hace:** no comprueba si el estado es el esperado (no hay `expect_status`), no valida el cuerpo contra un esquema, no reintenta, no sigue redirecciones salvo que se le pida.

### 5.2 `measure.ws`

Se conecta a un WebSocket, escucha N segundos y devuelve los mensajes que llegaron.

**Parámetros**

| Nombre | Tipo | Req. | Default | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `url` | string | sí | — | `ws://` o `wss://`, host local |
| `listen_seconds` | número | sí | — | 0.1–120 |
| `headers` | objeto | no | `{}` | Para auth de handshake |
| `subprotocols` | string[] | no | `[]` | |
| `send` | array | no | `[]` | Mensajes a enviar tras abrir: `{ "payload": string\|objeto, "delay_ms": 0 }` |
| `max_messages` | entero | no | `1000` | Al alcanzarlo se deja de acumular y se marca; la escucha sigue hasta cumplir el tiempo |
| `max_message_bytes` | entero | no | `65536` | Por mensaje; al exceder se trunca o va a blob |

**`data`**

```json
{
  "connected": true,
  "opened_at": "2026-09-22T10:14:03.500+02:00",
  "handshake_ms": 12,
  "closed": { "at": "...", "code": 1000, "reason": "", "by": "server | client | timeout" },
  "listen_seconds_requested": 5,
  "listen_seconds_actual": 5.01,
  "messages": [
    { "seq": 1, "at": "...", "offset_ms": 340, "direction": "in | out",
      "type": "text | binary", "bytes": 42,
      "payload": { "tick": 1 }, "payload_format": "json | text | base64 | blob" }
  ],
  "message_count": 7,
  "messages_truncated": false,
  "bytes_total": 294
}
```

Cada mensaje trae su hora absoluta y su offset desde la apertura. La escucha **siempre** cumple el tiempo pedido salvo que el servidor cierre; cero mensajes en N segundos es una medida perfectamente válida y se devuelve como tal, no como error.

**Lo que no hace:** no interpreta los payloads, no espera un mensaje concreto (no hay `wait_for`), no reconecta, no dice si el silencio es un problema.

### 5.3 `measure.browser`

Estado vivo de un panel en un navegador real. Playwright + Chromium headless, incluido en el servidor.

**Parámetros**

| Nombre | Tipo | Req. | Default | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `url` | string | sí | — | Host local |
| `wait_until` | enum | no | `networkidle` | `load domcontentloaded networkidle` |
| `settle_ms` | entero | no | `0` | Espera adicional fija tras `wait_until` |
| `timeout_ms` | entero | no | `30000` | 1000–120000 |
| `selectors` | array | no | `[]` | Qué leer del DOM. Ver abajo |
| `capture` | objeto | no | ver abajo | Qué recoger además del DOM |
| `viewport` | objeto | no | `{"width":1280,"height":800}` | |
| `actions` | array | no | `[]` | Interacciones antes de leer. Ver abajo |
| `storage` | objeto | no | — | `{ "local_storage": {...}, "cookies": [...] }` para sesión autenticada |

`selectors[]`: `{ "name": "total", "selector": "#cart-total", "read": "text" }`, donde `read` ∈ `text | html | value | count | attribute | exists` (con `attribute` cuando `read` es `attribute`).

`capture`: `{ "console": true, "network": true, "screenshot": false, "page_errors": true, "full_html": false }`.

`actions[]`, en orden, solo mecánicas: `{ "type": "click", "selector": "..." }`, `fill` (con `value`), `press` (con `key`), `wait_for_selector` (con `selector`, `state`), `wait_ms` (con `ms`), `scroll` (con `selector` o `to`). Sin aserciones: una acción que no se puede ejecutar produce un elemento de error en `action_results`, no un fallo de test.

**`data`**

```json
{
  "final_url": "http://localhost:3000/dashboard",
  "http_status": 200,
  "title": "Dashboard",
  "loaded_at": "...",
  "load_ms": 842,
  "action_results": [
    { "index": 0, "type": "click", "selector": "#refresh", "ok": true, "at": "...", "error": null }
  ],
  "selectors": {
    "total": { "found": true, "count": 1, "read": "text", "value": "42 €" },
    "banner": { "found": false, "count": 0, "read": "text", "value": null }
  },
  "console": [ { "at": "...", "level": "error", "text": "TypeError: x is not a function", "location": "app.js:120:8" } ],
  "page_errors": [ { "at": "...", "name": "TypeError", "message": "...", "stack": "..." } ],
  "network": [ { "at": "...", "method": "GET", "url": "http://localhost:3000/api/me", "status": 200, "resource_type": "fetch", "duration_ms": 31, "response_bytes": 210, "failure": null } ],
  "screenshot": { "blob": "sha256-...", "bytes": 91234, "content_type": "image/png", "width": 1280, "height": 800 },
  "full_html": null
}
```

`found: false` es una medida, no un error: el selector no estaba. La tool devuelve lo que había en la página en ese instante; que eso sea correcto lo decide quien pregunta.

**Lo que no hace:** no evalúa JS arbitrario que el llamante le pase (evita que se cuele lógica de proyecto dentro del servidor; las lecturas son declarativas vía `selectors`), no compara contra un baseline visual, no espera por texto concreto, no dice si el panel "funciona".

### 5.4 `measure.diff`

Compara dos medidas del mismo proyecto y del mismo `kind`. Describe qué cambió, campo a campo.

**Parámetros**

| Nombre | Tipo | Req. | Default | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `measurement_id` | string | no | la penúltima del proyecto/kind | Lado A (la anterior) |
| `against` | string | no | la última del proyecto/kind | Lado B (la actual) |
| `kind` | enum | no | — | Requerido si se omiten los ids, para resolver "las dos últimas" |
| `ignore` | string[] | no | ver abajo | Rutas JSON-pointer a excluir |
| `remeasure` | bool | no | `false` | `true` ⇒ toma una medida nueva con el `target` de A y la usa como B |

`ignore` por defecto excluye lo que cambia en cada medida sin significar nada: `/measured_at`, `/age_seconds`, `/duration_ms`, `/measurement_id`, `/data/timing_ms`, `/data/headers/date`, `/data/messages/*/at`, `/data/messages/*/offset_ms`, `/data/network/*/duration_ms`. Se puede sustituir por completo.

**`data`**

```json
{
  "a": { "measurement_id": "m_...", "measured_at": "...", "age_seconds": 3600 },
  "b": { "measurement_id": "m_...", "measured_at": "...", "age_seconds": 0.1 },
  "comparable": true,
  "identical": false,
  "change_count": 2,
  "changes": [
    { "path": "/data/status", "op": "replace", "from": 200, "to": 500 },
    { "path": "/data/body/orders/3", "op": "add", "from": null, "to": { "id": 41 } }
  ],
  "ignored_paths": ["/measured_at", "..."]
}
```

`changes[].op` ∈ `add | remove | replace`. Es el vocabulario de JSON Patch: mecánico, no valorativo. No existe un campo que diga si el cambio es bueno. Comparar dos `kind` distintos devuelve `comparable: false` con `changes: []`; no se inventa una correspondencia.

---

## 6. Familia *Recordar*

Un registro por proyecto. Cuatro tools. Ninguna mide, ninguna borra.

### 6.1 `recall.assert`

Escribe una afirmación.

**Parámetros**

| Nombre | Tipo | Req. | Notas |
|---|---|---|---|
| `project` | string | sí | |
| `statement` | string | sí | 1–2000 chars. No se interpreta |
| `evidence` | array | sí | ≥1 elemento, formas de §4.3 |
| `measured_by` | string | sí | 1–200 chars. Sin default |
| `measured_at` | ISO 8601 | condicional | Obligatorio si hay evidencia externa; prohibido si toda la evidencia son medidas propias (se deriva) |
| `tags` | string[] | no | ≤20, normalizadas como `project` |

**Respuesta**: la `Claim` completa tal como quedó escrita, más `measured_at`/`age_seconds` de la operación.

**Errores relevantes**: `EVIDENCE_REQUIRED` (lista vacía), `MEASUREMENT_NOT_FOUND` (id inexistente o de otro proyecto), `MEASURED_AT_REQUIRED`, `MEASURED_AT_NOT_ALLOWED`.

El servidor no comprueba que la evidencia respalde la afirmación — eso sería interpretar. Comprueba que la evidencia **exista** y sea del proyecto, y la deja embebida.

### 6.2 `recall.retract`

Marca una afirmación como retractada. **La afirmación no se borra nunca**, ni aquí ni por ninguna otra vía: no existe tool de borrado ni parámetro que lo permita.

**Parámetros**

| Nombre | Tipo | Req. | Notas |
|---|---|---|---|
| `project` | string | sí | |
| `claim_id` | string | sí | |
| `reason` | string | sí | 1–1000 chars. Sin motivo no se retracta |
| `by` | string | sí | Quién retracta |
| `superseded_by` | string | no | `claim_id` de la que la sustituye. Debe existir en el mismo proyecto |

Retractar una afirmación ya retractada devuelve `ALREADY_RETRACTED` con la retractación existente, y no escribe una segunda. `superseded_by` no puede apuntar a sí misma ni formar un ciclo (`CIRCULAR_SUPERSEDE`).

**Respuesta**: la `Claim` con su bloque `retracted` poblado.

### 6.3 `recall.query`

Lee el registro. Nunca mide.

**Parámetros**

| Nombre | Tipo | Req. | Default | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `text` | string | no | — | Subcadena, sin distinguir mayúsculas, sobre `statement`. Sin ranking ni relevancia |
| `tags` | string[] | no | — | Coincidencia por conjunción (todas) |
| `include_retracted` | bool | no | `false` | |
| `only_retracted` | bool | no | `false` | |
| `measured_by` | string | no | — | Coincidencia exacta |
| `measured_after` / `measured_before` | ISO 8601 | no | — | Sobre `measured_at` |
| `stale_seconds` | entero | no | `3600` | Umbral para la marca `stale` |
| `limit` | entero | no | `50` | 1–500 |
| `cursor` | string | no | — | Paginación opaca |
| `order` | enum | no | `measured_at_desc` | o `measured_at_asc`, `recorded_at_desc`, `recorded_at_asc` |

**Respuesta**

```json
{
  "project": "checkout-web",
  "measured_at": "2026-09-22T11:02:00.000+02:00",
  "age_seconds": 0,
  "total_matched": 3,
  "claims": [
    {
      "claim_id": "c_...",
      "statement": "...",
      "evidence": [ "..." ],
      "measured_by": "...",
      "measured_at": "2026-09-22T10:14:03.482+02:00",
      "age_seconds": 2876.5,
      "stale": true,
      "recorded_at": "...",
      "tags": ["api"],
      "retracted": null,
      "remeasure_with": {
        "tool": "measure.http",
        "arguments": { "project": "checkout-web", "url": "http://localhost:3000/api/orders", "method": "GET" }
      }
    }
  ],
  "next_cursor": null,
  "warnings": []
}
```

`stale` es aritmética pura (`age_seconds > stale_seconds`), no un juicio: es el umbral que pidió quien llama. `remeasure_with` aparece siempre que la evidencia sea una medida propia — es el mecanismo de R1: el registro te entrega la forma de volver a medir en vez de fingir que sabe el estado actual.

Por defecto se ocultan las retractadas, para que un lector descuidado no cite una afirmación muerta. Nunca desaparecen: `include_retracted: true` las trae.

### 6.4 `recall.history`

Los eventos crudos de una afirmación, en orden.

**Parámetros**: `project` (req.), `claim_id` (req.).

**Respuesta**: `{ project, measured_at, age_seconds, claim_id, events: [ { op, at, ... } ], current: <Claim> }`.

`events` es literalmente lo que hay en `claims.jsonl` para ese id: `assert`, luego `retract` si lo hubo. Es la garantía auditable de que nada se reescribió.

---

## 7. Errores

Todo error se devuelve como error MCP con un `code` estable y un `message` descriptivo, más `measured_at` y `age_seconds`. El `message` describe qué falló mecánicamente, nunca qué significa ni qué hacer.

| `code` | Cuándo |
|---|---|
| `INVALID_PROJECT` | `project` vacío o inválido tras normalizar |
| `INVALID_PARAMS` | Parámetro fuera de rango, tipo equivocado, ausente |
| `HOST_NOT_ALLOWED` | Destino no local y no en la allowlist |
| `URL_INVALID` | No parseable, o esquema no admitido |
| `CONNECTION_REFUSED` | Nada escuchando en ese puerto |
| `DNS_FAILURE` | El host no resuelve |
| `TLS_ERROR` | Handshake TLS fallido |
| `TIMEOUT` | Se agotó `timeout_ms` |
| `WS_HANDSHAKE_FAILED` | Upgrade rechazado |
| `BROWSER_UNAVAILABLE` | Chromium no instalado o no lanzable |
| `NAVIGATION_FAILED` | La página no llegó a cargar |
| `MEASUREMENT_NOT_FOUND` | `measurement_id` inexistente o de otro proyecto |
| `CLAIM_NOT_FOUND` | `claim_id` inexistente en el proyecto |
| `EVIDENCE_REQUIRED` | `evidence` vacío |
| `MEASURED_AT_REQUIRED` | Evidencia externa sin `measured_at` |
| `MEASURED_AT_NOT_ALLOWED` | `measured_at` explícito con evidencia solo de medidas |
| `ALREADY_RETRACTED` | Retractar lo ya retractado |
| `CIRCULAR_SUPERSEDE` | `superseded_by` forma un ciclo |
| `NOT_COMPARABLE` | `measure.diff` entre `kind` distintos |
| `LOCK_TIMEOUT` | No se obtuvo el lock del registro en 5 s |
| `STORAGE_ERROR` | Fallo de E/S en el directorio de datos |

**Errores de medida vs. medidas de error.** Un servicio que responde 500 **no es un error**: es una medida correcta con `ok: true` y `data.status: 500`. Solo es error lo que impidió tomar la medida (conexión, timeout, navegador, parámetros). La distinción es el corazón de no opinar.

---

## 8. Configuración del servidor

Configuración **del servidor**, no de proyectos. Por variables de entorno; sin fichero por proyecto.

| Variable | Default | Efecto |
|---|---|---|
| `HECHOS_DATA_DIR` | `~/.mcp-hechos` | Raíz del almacén |
| `HECHOS_ALLOWED_HOSTS` | — | Hosts extra permitidos además de los locales, separados por comas. Sin comodines de dominio abierto |
| `HECHOS_MEASUREMENT_RETENTION` | `500` | Medidas conservadas por proyecto |
| `HECHOS_INLINE_BODY_LIMIT` | `262144` | Bytes antes de ir a blob |
| `HECHOS_DEFAULT_STALE_SECONDS` | `3600` | Default de `stale_seconds` en `recall.query` |
| `HECHOS_BROWSER_ENABLED` | `true` | `false` ⇒ `measure.browser` responde `BROWSER_UNAVAILABLE` |
| `HECHOS_MAX_CONCURRENT_BROWSERS` | `2` | Tope de contextos Chromium simultáneos |

Ninguna variable introduce conocimiento de un proyecto: ni URLs base, ni rutas, ni credenciales.

---

## 9. Seguridad y datos sensibles

- **Redacción en salida.** Los valores de `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key` y `x-auth-token` se devuelven como `"[redacted:N bytes]"` en `target` y en `data.headers`. Se envían íntegros al servicio; no se persisten en claro.
- **Credenciales no se guardan.** El `target` persistido lleva las cabeceras ya redactadas. Un `remeasure_with` de `recall.query` reproduce la URL y el método, pero no las credenciales: quien vuelva a medir las aporta.
- **Solo local por defecto.** Ver §3. Es lo que evita que el servidor sea un canal de exfiltración.
- **Solo escritura en su directorio.** Cualquier ruta que se resuelva fuera de `HECHOS_DATA_DIR` es `STORAGE_ERROR`; los nombres de proyecto normalizados no pueden atravesar directorios.
- **`statement` es texto, no instrucciones.** El contenido del registro lo escriben agentes y lo leen agentes. La especificación es explícita: una afirmación es un dato citable, nunca una orden para quien la lee.

---

## 10. Cómo se comprueba que cumple el contrato

Pruebas que fallan si el servidor empieza a opinar. No son ejemplos: son el criterio de aceptación.

1. **Sin juicios en el esquema.** Recorrer los esquemas de salida de todas las tools y fallar si aparece cualquier clave de la lista negra (`health`, `score`, `severity`, `passed`, `ok_status`, `summary`, `recommendation`, `is_*`, `should_*`) fuera del `ok` documentado en §4.2.
2. **500 no es error.** Un servicio local que responde 500 produce `ok: true`, `error: null`, `data.status: 500`.
3. **Cero mensajes es una medida.** `measure.ws` sobre un WS silencioso durante 2 s devuelve `ok: true`, `message_count: 0`, `listen_seconds_actual ≈ 2`.
4. **Selector ausente es una medida.** `measure.browser` con un selector que no existe devuelve `found: false`, no un error.
5. **Recordar no mide.** Con el servicio caído, `recall.query` responde con normalidad y no genera tráfico de red. Verificable interceptando el socket.
6. **Hora en todas las respuestas.** Toda respuesta de toda tool, incluidas las de error, contiene `measured_at` y `age_seconds`.
7. **Edad propia por afirmación.** Cada `claim` de `recall.query` lleva su propio `age_seconds` derivado de su `measured_at`, no el de la consulta.
8. **La retractación no borra.** Tras `recall.retract`, el fichero `claims.jsonl` tiene más bytes, la línea original es idéntica byte a byte, y `recall.history` devuelve los dos eventos.
9. **Solo append.** Ejecutar una secuencia de asserts y retracts y comprobar que cada byte del fichero previo sigue en su sitio tras cada operación.
10. **Cero conocimiento de proyecto.** Buscar en el código fuente puertos, rutas de API, nombres de servicio o selectores literales de cualquier app real. Cero coincidencias.
11. **Aislamiento entre proyectos.** Una medida del proyecto A no puede citarse como evidencia en B (`MEASUREMENT_NOT_FOUND`), y una `recall.query` sobre B nunca devuelve afirmaciones de A.
12. **Host remoto rechazado.** Una URL no local sin allowlist devuelve `HOST_NOT_ALLOWED` y no abre ningún socket.
13. **Diff no valora.** Un cambio de 200 a 500 y uno de 500 a 200 producen estructuras simétricas: mismo `change_count`, ningún campo que distinga cuál es mejor.
14. **Secretos redactados.** Una medida con `Authorization` devuelve y persiste el valor redactado; el valor en claro no aparece en ningún fichero del almacén.

---

## 11. Decisiones tomadas y por qué

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Playwright + Chromium incluido | CDP a un Chrome que el usuario arranque | El servidor mide sin pedirle nada al usuario; el coste es la dependencia del navegador |
| JSONL append-only | SQLite | "No se borra nunca" se demuestra con el fichero a la vista; auditable, diff-able, sin dependencias |
| `project` como cadena libre | Registro previo de proyectos | Cero conocimiento de proyectos dentro del servidor; el coste, un typo puede fragmentar un registro, se mitiga devolviendo siempre el `project` normalizado |
| Directorio único del servidor | Almacén dentro de cada repo | Escribir en el repo violaría "ninguna escritura sobre sus ficheros" |
| Búfer rotativo de medidas + snapshot en la afirmación | Guardar todas las medidas para siempre | Las medidas son grandes y casi todas descartables; la evidencia citada sobrevive porque va embebida |
| `selectors` declarativos en `measure.browser` | `evaluate` de JS arbitrario | Un `evaluate` sería la puerta por la que entraría lógica de proyecto al servidor |

---

## 12. Extensiones que respetarían el contrato

Ideas compatibles, fuera de v1. Cada una debe pasar §10 entera.

- `measure.tcp` — un puerto acepta conexión o no, con su hora.
- `measure.process` — un proceso con ese patrón de línea de comandos existe o no, con su hora.
- `measure.file` — mtime, tamaño y hash de un fichero (lectura, jamás escritura).
- Recurso MCP de solo lectura que exponga `claims.jsonl` para inspección humana.
- `recall.export` — volcado íntegro del registro de un proyecto, sin filtros.

Y lo que nunca entra, por mucho que se pida: `measure.assert_status`, `recall.summarize`, `project.health`, `measure.wait_until`, `recall.delete`.
