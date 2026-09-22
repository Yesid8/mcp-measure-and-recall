# Módulo `facts` — medir y recordar

> Documento 05 de 11 · Plinth v2.0 · Paquetes `@plinth/module-facts` y
> `@plinth/module-facts-browser`
>
> Este documento sustituye a la especificación v1 completa. Lo que la v1 decía sobre
> transportes, errores, almacenamiento, política y pruebas está ahora en los documentos
> 02–04 y 07, porque no era propio de este dominio. Aquí queda solo el dominio.

---

## 1. Qué hace y qué no

Dos familias de tools sobre la base de Plinth:

- **`measure.*`** — apunta a un servicio y devuelve la observación cruda con su hora.
- **`recall.*`** — un registro por proyecto donde cada entrada es *afirmación + evidencia +
  quién la observó + cuándo*, y donde nada se borra jamás.

El módulo declara `policy: 'factual'`, con lo que acepta las reglas **F1** (lo medible no se
responde de memoria) y **F2** (ningún campo de salida es un juicio) del
[contrato](00-contrato.md#3-la-política-factual-opt-in), y el kit de conformidad las
verifica en CI.

El valor está en que un agente que consulta este módulo no tiene que verificar lo que le
responde. En el momento en que el módulo emita juicios deja de ser una fuente y pasa a ser
otro agente al que hay que verificar — que es exactamente el trabajo que existe para
ahorrar.

### Frase de uso

Un agente trabaja en la app A. Necesita saber si `/api/orders` responde 200 ahora mismo.
Llama a `facts.measure.http`; recibe estado, cuerpo y hora. Anota en el registro del
proyecto A: *"`/api/orders` devuelve 200 con lista vacía"*, citando esa observación como
evidencia. Tres días después otro agente lee el registro, ve que la afirmación tiene tres
días, usa el `remeasure_with` que viene en la respuesta, encuentra un 500, retracta la
afirmación con motivo y añade la nueva. La vieja sigue ahí, marcada, con su historia.

---

## 2. Configuración del módulo

```
PLINTH_DATA_DIR                    ~/.plinth        raíz del almacén (núcleo)
PLINTH_FACTS_OBSERVATION_RETENTION 500              observaciones conservadas por proyecto
PLINTH_FACTS_DEFAULT_STALE_SECONDS 3600             defecto de `stale_seconds` en recall.query
PLINTH_FACTS_BROWSER_ENABLED       auto            auto | on | off
PLINTH_FACTS_MAX_BROWSERS          2                contextos Chromium simultáneos
PLINTH_FACTS_BROWSER_TTL_MS        600000           caducidad de un handle de contexto
```

Ninguna variable introduce conocimiento de un proyecto concreto: ni URL base, ni rutas, ni
credenciales. El perfil de red lo concede la política del servidor
([03-protocolo §5.2](03-protocolo.md)), no este módulo.

Prefijos de identificador que el módulo registra (`idPrefixes`): `c_` afirmación,
`bx_` contexto de navegador.

`BROWSER_ENABLED=auto` significa: si `@plinth/module-facts-browser` está instalado y
Chromium se puede lanzar, las tools de navegador aparecen en `tools/list`; si no, **no
aparecen**. No se publica una tool que devolverá siempre error. Es mejor que el modelo no
la vea que verla y descubrir que no sirve.

---

## 3. La observación

Todas las tools `measure.*` devuelven la `Envelope` del núcleo
([02-nucleo-api §4](02-nucleo-api.md)) con `kind` en `data`:

```json
{
  "observation_id": "o_01K5Z9K2QX7T4BVWRM3P8QJHYD",
  "tool": "facts.measure.http",
  "project": "checkout-web",
  "target": { "url": "http://localhost:3000/api/orders", "method": "GET",
              "headers": { "authorization": "[redacted:47 bytes]" },
              "timeout_ms": 10000, "follow_redirects": false },
  "observed_at": "2026-09-22T10:14:03.482+02:00",
  "age_seconds": 0.2,
  "age_basis": "monotonic",
  "duration_ms": 143,
  "ok": true,
  "error": null,
  "warnings": [],
  "data": { "kind": "http", "http_status": 200, "...": "..." }
}
```

`ok` significa **exclusivamente** "la observación se pudo tomar". Un HTTP 500 recibido
limpiamente es `ok: true` con `data.http_status: 500`. Un DNS que no resuelve es `ok: false`
con `error` poblado.

Toda observación se persiste en el flujo rotativo `observations` del proyecto, para poder
citarla y compararla después.

---

## 4. Familia `measure.*`

### 4.1 `facts.measure.http`

Una petición HTTP. Devuelve estado y cuerpo, crudos.

**Entrada**

| Nombre | Tipo | Req. | Defecto | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `url` | string | sí | — | Absoluta. Sujeta a la política de red |
| `method` | enum | no | `GET` | `GET POST PUT PATCH DELETE HEAD OPTIONS` |
| `headers` | record\<string,string> | no | `{}` | Redactadas en la salida y en disco |
| `body` | string \| json | no | — | Objeto ⇒ se serializa a JSON y se fija `content-type` si falta |
| `timeout_ms` | int | no | `10000` | 1–120 000 |
| `follow_redirects` | bool | no | `false` | En `false`, un 302 se devuelve como 302 |
| `max_body_bytes` | int | no | `1048576` | Al exceder: se trunca, se marca, `warning` |

**Salida (`data`)**

```json
{
  "kind": "http",
  "http_status": 200,
  "status_text": "OK",
  "http_version": "1.1",
  "headers": { "content-type": "application/json; charset=utf-8" },
  "body": { "orders": [] },
  "body_format": "json | text | base64 | blob",
  "body_bytes": 17,
  "body_truncated": false,
  "timing_ms": { "dns": 1, "connect": 3, "tls": null, "ttfb": 118, "total": 143 },
  "redirect_chain": [],
  "peer": { "address": "127.0.0.1", "port": 3000, "family": 4 },
  "tls": null
}
```

`body_format` describe **cómo se codificó, no qué significa**. Si el `content-type` declara
JSON y parsea, `body` es el objeto y el formato es `json`; si declara JSON y no parsea, se
devuelve el texto tal cual con formato `text` y un `warning` con código
`BODY_CONTENT_TYPE_MISMATCH`. Sin corregirlo y sin opinar.

`peer` es nuevo en v2 y no es cosmético: con la validación por IP de
[03-protocolo §5](03-protocolo.md), decir **a qué dirección se conectó realmente** es parte
de la honestidad de la medida.

**Lo que no hace**: no comprueba si el estado es el esperado (no hay `expect_status`), no
valida el cuerpo contra un esquema, no reintenta, no sigue redirecciones salvo que se le
pida, no reenvía credenciales del entorno.

---

### 4.2 `facts.measure.ws`

Se conecta a un WebSocket, escucha N segundos y devuelve lo que llegó.

**Entrada**

| Nombre | Tipo | Req. | Defecto | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `url` | string | sí | — | `ws://` o `wss://` |
| `listen_seconds` | number | sí | — | 0.1–120 |
| `headers` | record | no | `{}` | Para auth de handshake |
| `subprotocols` | string[] | no | `[]` | |
| `send` | array | no | `[]` | `{ payload: string\|json, delay_ms: 0 }` |
| `max_messages` | int | no | `1000` | Al llegar se deja de acumular; la escucha sigue |
| `max_message_bytes` | int | no | `65536` | Por mensaje; al exceder, se trunca o va a blob |
| `max_total_bytes` | int | no | `8388608` | **Nuevo en v2**: tope agregado |

**Salida (`data`)**

```json
{
  "kind": "ws",
  "connected": true,
  "opened_at": "2026-09-22T10:14:03.500+02:00",
  "handshake_ms": 12,
  "negotiated_subprotocol": null,
  "closed": { "at": "…", "code": 1000, "reason": "", "by": "server | client | timeout" },
  "listen_seconds_requested": 5,
  "listen_seconds_actual": 5.01,
  "messages": [
    { "seq": 1, "at": "…", "offset_ms": 340, "direction": "in",
      "type": "text", "bytes": 42,
      "payload": { "tick": 1 }, "payload_format": "json" }
  ],
  "message_count": 7,
  "messages_truncated": false,
  "bytes_total": 294
}
```

Cada mensaje trae su hora absoluta y su offset desde la apertura. La escucha **siempre**
cumple el tiempo pedido salvo que el servidor cierre o el cliente cancele. Cero mensajes en
N segundos es una observación perfectamente válida: `ok: true`, `message_count: 0`. No es
un error, y el módulo no dice si el silencio es un problema.

**Lo que no hace**: no interpreta payloads, no espera un mensaje concreto (no hay
`wait_for`), no reconecta.

---

### 4.3 `facts.measure.browser` — y el cambio estructural de v2

La v1 metía Playwright + Chromium dentro del servidor. Para una **base** eso es
inaceptable: son cientos de megabytes de descarga y una dependencia nativa que rompe
instalaciones en entornos sin las bibliotecas del sistema, impuesta a todo el que quiera
usar el núcleo para cualquier otra cosa.

En v2:

- Vive en un paquete aparte, `@plinth/module-facts-browser`, con Playwright como
  **dependencia opcional**.
- Se monta explícitamente: `facts({ browser: true })` importando el paquete.
- Si no está o Chromium no arranca, las tools no se publican.
- El pool de navegadores se crea en `init()` del módulo y se libera en `dispose()`.

Además, en un protocolo sin sesiones, abrir una página por llamada y cerrarla es a menudo
lo contrario de lo que se quiere (un panel autenticado tras varios pasos). Por eso v2
separa lo que la v1 mezclaba:

| Tool | Papel |
|---|---|
| `facts.browser.open` | Crea un contexto, devuelve un **handle** con TTL. Aquí van `storage` y `viewport` |
| `facts.measure.browser` | Observa: navega (o usa un handle), ejecuta acciones mecánicas, lee selectores, devuelve el estado |
| `facts.browser.close` | Libera el handle. Idempotente |

`facts.measure.browser` sin `context` crea un contexto efímero y lo cierra: el caso simple
sigue siendo una sola llamada.

**Entrada de `facts.measure.browser`**

| Nombre | Tipo | Req. | Defecto | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `url` | string | sí* | — | *Opcional si se da `context` y ya está en la página |
| `context` | string | no | — | Handle de `facts.browser.open` |
| `wait_until` | enum | no | `networkidle` | `load domcontentloaded networkidle` |
| `settle_ms` | int | no | `0` | Espera fija adicional |
| `timeout_ms` | int | no | `30000` | 1 000–120 000 |
| `selectors` | array | no | `[]` | Ver abajo |
| `capture` | object | no | ver abajo | |
| `viewport` | object | no | `{width:1280,height:800}` | Ignorado si hay `context` |
| `actions` | array | no | `[]` | Solo mecánicas |

`selectors[]`: `{ name, selector, read, attribute? }` con
`read ∈ text | html | value | count | attribute | exists`.

`capture`: `{ console: true, network: true, page_errors: true, screenshot: false, full_html: false }`.

`actions[]`, en orden, **solo mecánicas**: `click`, `fill` (con `value`), `press` (con
`key`), `select` (con `values`), `hover`, `wait_for_selector` (con `state`), `wait_ms`,
`scroll`. Sin aserciones: una acción que no se puede ejecutar produce un elemento de error
en `action_results`, no un fallo de test.

**Salida (`data`)**

```json
{
  "kind": "browser",
  "context": "bx_01K5…" ,
  "final_url": "http://localhost:3000/dashboard",
  "http_status": 200,
  "title": "Dashboard",
  "loaded_at": "…",
  "load_ms": 842,
  "action_results": [
    { "index": 0, "type": "click", "selector": "#refresh", "executed": true, "at": "…", "error": null }
  ],
  "selectors": {
    "total": { "found": true, "count": 1, "read": "text", "value": "42 €" },
    "banner": { "found": false, "count": 0, "read": "text", "value": null }
  },
  "console": [ { "at": "…", "level": "error", "text": "TypeError: x is not a function", "location": "app.js:120:8" } ],
  "page_errors": [ { "at": "…", "name": "TypeError", "message": "…", "stack": "…" } ],
  "network": [ { "at": "…", "method": "GET", "url": "…", "http_status": 200, "resource_type": "fetch", "duration_ms": 31, "response_bytes": 210, "failure": null } ],
  "screenshot": { "blob": "sha256-…", "bytes": 91234, "content_type": "image/png", "width": 1280, "height": 800 },
  "full_html": null
}
```

`found: false` es una observación, no un error: el selector no estaba.

> **Nota sobre `action_results`.** En v1 el campo se llamaba `ok`. Se renombra a `executed`
> porque `ok` ya significa otra cosa muy concreta en la envoltura (§3) y tenerlo con dos
> sentidos en la misma respuesta es justo el tipo de ambigüedad que este módulo existe para
> evitar.

**Lo que no hace**: no evalúa JavaScript arbitrario que le pase el llamante — las lecturas
son declarativas vía `selectors`, y esa puerta cerrada es lo que impide que la lógica de un
proyecto se cuele dentro del servidor. No compara contra un baseline visual. No espera por
texto concreto. No dice si el panel "funciona".

**Red dentro del navegador.** Un navegador ignora la validación de IP del cliente HTTP: la
página puede pedir lo que quiera. Por eso el contexto se crea con una ruta de interceptación
que aplica **la misma política de red** a cada petición de la página, y las bloqueadas
aparecen en `network[]` con `failure: "blocked_by_policy"`. Es una observación, y el
llamante la ve.

---

### 4.4 `facts.measure.diff`

Compara dos observaciones del mismo proyecto y el mismo `kind`. Describe qué cambió, campo
a campo.

**Entrada**

| Nombre | Tipo | Req. | Defecto | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `a` | string | no | penúltima del proyecto/kind | Lado A (la anterior) |
| `b` | string | no | última del proyecto/kind | Lado B (la actual) |
| `kind` | enum | no | — | Obligatorio si se omiten los ids |
| `ignore` | string[] | no | ver abajo | JSON Pointer. Sustituye la lista entera |
| `remeasure` | bool | no | `false` | `true` ⇒ toma una observación nueva con el `target` de A y la usa como B |

`ignore` por defecto excluye lo que cambia en cada observación sin significar nada:
`/observed_at`, `/age_seconds`, `/age_basis`, `/duration_ms`, `/observation_id`,
`/data/timing_ms`, `/data/headers/date`, `/data/peer`, `/data/messages/*/at`,
`/data/messages/*/offset_ms`, `/data/network/*/duration_ms`, `/data/load_ms`.

**Salida (`data`)**

```json
{
  "kind": "diff",
  "a": { "observation_id": "o_…", "observed_at": "…", "age_seconds": 3600 },
  "b": { "observation_id": "o_…", "observed_at": "…", "age_seconds": 0.1 },
  "comparable": true,
  "identical": false,
  "change_count": 2,
  "changes": [
    { "path": "/data/http_status", "op": "replace", "from": 200, "to": 500 },
    { "path": "/data/body/orders/3", "op": "add", "from": null, "to": { "id": 41 } }
  ],
  "changes_truncated": false,
  "ignored_paths": ["/observed_at", "…"]
}
```

`op ∈ add | remove | replace` — el vocabulario de JSON Patch, mecánico y no valorativo. **No
existe** un campo que diga si el cambio es bueno. Comparar dos `kind` distintos devuelve
`comparable: false` con `changes: []`; no se inventa una correspondencia.

Si el número de cambios supera `max_changes` (1 000), se truncan, se marca
`changes_truncated` y se añade un `warning`. Un diff de un millón de líneas no ayuda a
nadie, y truncar es honesto; resumir no lo sería.

---

## 5. La afirmación

```json
{
  "claim_id": "c_01K5Z9M5P0RA2CF7XN4T6WQJBE",
  "project": "checkout-web",
  "statement": "GET /api/orders responds 200 with an empty array",
  "evidence": [
    { "type": "observation", "observation_id": "o_01K5Z9K2QX7T4B",
      "snapshot": { "tool": "facts.measure.http", "target": {…}, "observed_at": "…", "data": {…} } }
  ],
  "observed_by": "claude-opus-5 (session 3f9a1c7e)",
  "observed_at": "2026-09-22T10:14:03.482+02:00",
  "recorded_at": "2026-09-22T10:14:07.005+02:00",
  "tags": ["api", "orders"],
  "retracted": null
}
```

- **`statement`**: texto libre, 1–2 000 caracteres. El módulo **no lo parsea, no lo valida
  semánticamente y no lo interpreta**. Es la afirmación de quien la hace.
- **`evidence`**: lista con al menos un elemento, de una de dos formas:
  - `{ type: "observation", observation_id }` — referencia a una observación de este
    servidor. Se verifica que exista **en el mismo proyecto** y se deja **incrustada** en el
    registro, para que la afirmación siga siendo auditable cuando el búfer rote.
  - `{ type: "external", description, uri? }` — evidencia que este servidor no tomó (un
    log, una captura, una observación humana). Se guarda literal, sin comprobar, y queda
    claramente distinguible de la propia.
- **`observed_by`**: quién. Obligatorio, 1–200 caracteres, sin valor por defecto. Una
  afirmación sin autor no entra.
- **`observed_at`**: cuándo se observó lo que sostiene la afirmación. Si toda la evidencia
  es propia, se **deriva** del `observed_at` más antiguo de las observaciones citadas y no
  se puede sobrescribir. Si hay evidencia externa, quien llama debe proporcionarlo.
- **`recorded_at`**: cuándo se escribió. Lo pone el servidor.
- **`retracted`**: `null`, o `{ at, by, reason, superseded_by }`.

> El servidor **no comprueba que la evidencia respalde la afirmación** — eso sería
> interpretar. Comprueba que exista y que sea del proyecto.

---

## 6. Familia `recall.*`

Ninguna mide. Ninguna borra.

### 6.1 `facts.recall.assert`

| Nombre | Tipo | Req. | Notas |
|---|---|---|---|
| `project` | string | sí | |
| `statement` | string | sí | 1–2 000 |
| `evidence` | array | sí | ≥ 1 elemento |
| `observed_by` | string | sí | 1–200, sin defecto |
| `observed_at` | ISO 8601 | condicional | Obligatorio con evidencia externa; **prohibido** si toda es propia |
| `tags` | string[] | no | ≤ 20, normalizadas como `project` |

Errores: `EVIDENCE_REQUIRED`, `OBSERVATION_NOT_FOUND` (inexistente o de otro proyecto),
`OBSERVED_AT_REQUIRED`, `OBSERVED_AT_NOT_ALLOWED`.

Devuelve la `Claim` completa tal como quedó escrita.

### 6.2 `facts.recall.retract`

Marca una afirmación como retractada. **No se borra nunca**, ni aquí ni por ninguna otra
vía: no existe tool de borrado ni parámetro que lo permita, y la interfaz del almacén no
tiene `delete` ([04-almacenamiento §5](04-almacenamiento.md)).

| Nombre | Tipo | Req. | Notas |
|---|---|---|---|
| `project` | string | sí | |
| `claim_id` | string | sí | |
| `reason` | string | sí | 1–1 000. Sin motivo no se retracta |
| `by` | string | sí | Quién retracta |
| `superseded_by` | string | no | `claim_id` existente en el mismo proyecto |

Retractar lo ya retractado devuelve `ALREADY_RETRACTED` con la retractación existente y **no
escribe una segunda línea**. `superseded_by` no puede apuntar a sí misma ni cerrar un ciclo
(`CIRCULAR_SUPERSEDE`, comprobado recorriendo la cadena con detección de visitados).

### 6.3 `facts.recall.supersede` (nuevo en v2)

Asienta la afirmación nueva y retracta la vieja apuntándola, **en un único commit atómico**
(`appendBatch`). Es la secuencia que todo el mundo hace a mano y que, interrumpida a la
mitad, deja el registro diciendo algo falso: una afirmación retractada sin sustituta, o dos
vigentes que se contradicen.

Parámetros: los de `recall.assert` para la nueva, más `supersedes` (`claim_id`), `reason` y
`by` para la retractación. Devuelve ambas `Claim`.

### 6.4 `facts.recall.query`

Lee el registro. **Nunca mide.**

| Nombre | Tipo | Req. | Defecto | Notas |
|---|---|---|---|---|
| `project` | string | sí | — | |
| `text` | string | no | — | Subcadena, sin distinguir mayúsculas, **sin ranking** |
| `tags` | string[] | no | — | Conjunción: todas |
| `include_retracted` | bool | no | `false` | |
| `only_retracted` | bool | no | `false` | |
| `observed_by` | string | no | — | Coincidencia exacta |
| `observed_after` / `observed_before` | ISO 8601 | no | — | Sobre `observed_at` |
| `stale_seconds` | int | no | `3600` | Umbral de la marca `stale` |
| `limit` | int | no | `50` | 1–500 |
| `cursor` | string | no | — | Opaco. Ver [04 §3.4](04-almacenamiento.md) |
| `order` | enum | no | `observed_desc` | + `observed_asc`, `recorded_desc`, `recorded_asc` |
| `evidence` | enum | no | `ref` | **Nuevo**: `none \| ref \| full` |

**Salida (`data`)**

```json
{
  "kind": "claims",
  "total_matched": 3,
  "claims": [
    {
      "claim_id": "c_…",
      "statement": "…",
      "evidence": [ { "type": "observation", "observation_id": "o_…",
                      "ref": { "tool": "facts.measure.http", "http_status": 200 } } ],
      "observed_by": "…",
      "observed_at": "2026-09-22T10:14:03.482+02:00",
      "age_seconds": 2876.5,
      "age_basis": "wall",
      "stale": true,
      "recorded_at": "…",
      "tags": ["api"],
      "retracted": null,
      "remeasure_with": {
        "tool": "facts.measure.http",
        "arguments": { "project": "checkout-web", "url": "http://localhost:3000/api/orders", "method": "GET" }
      }
    }
  ],
  "next_cursor": null
}
```

- **`stale` es aritmética pura** (`age_seconds > stale_seconds`), no un juicio: es el umbral
  que pidió quien llama.
- **`remeasure_with` es el mecanismo de F1**: aparece siempre que la evidencia sea propia. El
  registro te entrega la forma de volver a medir en vez de fingir que sabe el estado actual.
  **No lleva credenciales**: reproduce URL y método; quien vuelva a medir las aporta. Las
  **omite**, no las redacta: un `[redacted:47 bytes]` reproducido como cabecera sería una
  petición rota con aspecto de válida.
- **`evidence: 'ref'` es el nuevo defecto.** En v1 cada afirmación arrastraba su
  evidencia incrustada completa, así que una consulta de 50 afirmaciones podía devolver
  megabytes de cuerpos HTTP al contexto del modelo. `ref` devuelve lo justo para
  identificarla; `full` trae el snapshot entero; `none` lo omite.
  (La clave no se llama `summary` a propósito: F2 la prohíbe, y una excepción en el único
  módulo factual del proyecto sería el primer paso para vaciar la regla.)
- Por defecto se ocultan las retractadas, para que un lector descuidado no cite una
  afirmación muerta. **Nunca desaparecen**: `include_retracted: true` las trae.

### 6.5 `facts.recall.history`

Los eventos crudos de una afirmación, en orden.

Entrada: `project`, `claim_id`. Salida:
`{ kind: "history", claim_id, events: [...], current: <Claim> }`.

`events` es literalmente lo que hay en `claims.jsonl` para ese id: `assert`, luego `retract`
si lo hubo. Es la garantía auditable de que nada se reescribió.

### 6.6 `facts.recall.export` (nuevo en v2)

Volcado íntegro del registro de un proyecto, sin filtros y sin interpretación.

Entrada: `project`, `format ∈ jsonl | json`, `include_observations` (bool, defecto `false`).

Salida: un `resource_link` a un blob con el volcado, más `bytes` y `sha256`. No se devuelve
inline: un registro completo no cabe en el contexto de nadie y fingir que sí es un mal
servicio.

Existe porque un registro del que no puedes salir no es tuyo. Es también la vía de
migración y de copia de seguridad.

---

## 7. Recursos MCP (solo lectura)

El módulo expone dos recursos, para inspección humana y para clientes que prefieran leer a
llamar:

| URI | Contenido |
|---|---|
| `facts://projects` | Lista de proyectos con recuento de afirmaciones, vigentes y retractadas, y fecha de la última |
| `facts://{project}/claims` | El `claims.jsonl` del proyecto, crudo, como `application/x-ndjson` |

Ambos llevan `ttlMs` y `cacheScope: "private"`. El segundo se sirve como stream, no se carga
en memoria.

---

## 8. Criterio de aceptación del módulo

Estas pruebas fallan si el módulo empieza a opinar. No son ejemplos: son el contrato. Se
ejecutan como parte de `@plinth/conformance` con el perfil `factual` — ver
[07-conformidad-y-pruebas](07-conformidad-y-pruebas.md), donde están las que valen para
cualquier módulo. Aquí van las propias de este dominio.

1. **500 no es error.** Un servicio que responde 500 produce `ok: true`, `error: null`,
   `isError: false`, `data.http_status: 500`.
2. **Cero mensajes es una observación.** `measure.ws` sobre un WS silencioso durante 2 s:
   `ok: true`, `message_count: 0`, `listen_seconds_actual ≈ 2`.
3. **Selector ausente es una observación.** `found: false`, no error.
4. **Recordar no mide.** Con el servicio caído, `recall.query` responde con normalidad y no
   genera tráfico. Verificable interceptando el socket y contando conexiones: cero.
5. **Edad propia por afirmación.** Cada `claim` lleva su `age_seconds` derivado de su
   `observed_at`, no el de la consulta.
6. **La retractación no borra.** Tras `recall.retract`, `claims.jsonl` tiene más bytes, la
   línea original es idéntica **byte a byte**, y `recall.history` devuelve los dos eventos.
7. **Solo append.** Una secuencia de asserts y retracts; tras cada operación, cada byte del
   fichero previo sigue en su sitio (comparación de prefijo).
8. **`supersede` es atómico.** Inyectando un fallo entre las dos escrituras, el registro
   queda sin ninguna de las dos, nunca con una.
9. **Aislamiento entre proyectos.** Una observación de A no se puede citar en B
   (`OBSERVATION_NOT_FOUND`), y una `recall.query` sobre B nunca devuelve afirmaciones de A.
10. **Diff no valora.** Un cambio de 200 a 500 y uno de 500 a 200 producen estructuras
    simétricas: mismo `change_count`, ningún campo que distinga cuál es mejor.
11. **`remeasure_with` no lleva credenciales.** Una observación hecha con `Authorization`
    produce un `remeasure_with` sin esa cabecera.
12. **La política del navegador se aplica dentro de la página.** Una página que hace `fetch`
    a un host denegado produce una entrada en `network[]` con
    `failure: "blocked_by_policy"` y ninguna conexión saliente real.
13. **Cero conocimiento de proyecto.** Búsqueda en el código fuente de puertos, rutas de
    API, nombres de servicio o selectores literales de cualquier app real: cero
    coincidencias.

---

## 9. Extensiones que respetarían el contrato

Compatibles, fuera de v2.0. Cada una debe pasar la §8 entera y el perfil `factual`.

- `facts.measure.tcp` — un puerto acepta conexión o no, con su hora.
- `facts.measure.dns` — qué resuelve un nombre, con TTL y servidor consultado.
- `facts.measure.process` — existe o no un proceso con ese patrón de línea de comandos.
- `facts.measure.file` — mtime, tamaño y hash de un fichero. Lectura, jamás escritura.
- `facts.recall.link` — relacionar dos afirmaciones sin valorar la relación.

Y lo que **nunca** entra, por mucho que se pida:
`measure.assert_status`, `recall.summarize`, `project.health`, `measure.wait_until`,
`recall.delete`, `recall.rank`.
