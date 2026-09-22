# Hallazgos — rodaje contra servicios reales

> **Inicio: 2026-09-22, 10:54.** Escrito sobre la marcha.
>
> Primera vez que la API se usa contra objetivos que nadie diseñó para ella. El entregable
> son las molestias, no la demostración de que funciona.

---

## 0. Método

19 puertos locales a la escucha, medidos **sin saber qué es cada uno**. Ese anonimato es
deliberado: es la situación de quien apunte esto a una aplicación que hoy no existe.

Los números de puerto se omiten: describen una máquina, no el servidor. Lo que importa es
cómo se repartieron las respuestas.

---

## 1. El barrido, y lo que costó

| Puertos | Resultado | Detalle | Envoltura | ms |
|---|---|---|---|---|
| 1 | **HTTP 302** | `text/html` 106 B | 3 396 B | 33 |
| 2 | **HTTP 200** | `text/html` 2 048 B truncado | 7 230 B | 5–7 |
| 1 | **HTTP 503** | `text/html` 326 B | 3 000 B | 8 |
| 6 | `CONNECTION_RESET` | | ~1 315 B | 2–8 |
| 3 | `CONNECTION_FAILED` | | ~1 301 B | 2–4 |
| 1 | `CONNECTION_REFUSED` | | 1 339 B | 3 |
| 5 | `TIMEOUT` | | ~1 260 B | ~2 010 |

**19 llamadas · 39,4 KB de envolturas · media 2 121 B por llamada.**

### Hallazgo 1 — los objetivos mínimos salieron solos, menos dos

El barrido cubrió sin buscarlos: 5xx real (un 503), HTML grande (dos 200 truncados),
puerto que no habla HTTP (`CONNECTION_RESET` en seis puertos), puerto cerrado
(`CONNECTION_FAILED`). Faltan por conseguir: **JSON 200**, **DNS_FAILURE** y **WebSocket**.

### Hallazgo 2 — cuatro códigos distintos donde un `ok:false` habría dado uno

`TIMEOUT`, `CONNECTION_REFUSED`, `CONNECTION_RESET` y `CONNECTION_FAILED` separan cuatro
situaciones que de verdad son distintas:

- `CONNECTION_RESET`: **hay algo escuchando y no habla HTTP.** Aceptó la conexión y la
  cortó al ver la petición.
- `CONNECTION_FAILED`: el puerto figura a la escucha pero la conexión no prospera —
  filtrado, o atado a otra interfaz.
- `TIMEOUT`: acepta y **no responde nada**. Distinto de cortar.
- `CONNECTION_REFUSED`: nadie escucha en esa dirección concreta.

**Esto es lo mejor que ha dado la herramienta hasta ahora.** Lo anoto explícitamente para
que no se simplifique más adelante en aras de una API más limpia.

### Hallazgo 3 — el `TIMEOUT` cuesta el timeout entero, y no hay forma de decir "solo mira"

Cinco puertos consumieron ~2 s cada uno: **10 de los ~12 s del barrido se fueron en esperar
a puertos que no iban a responder.** Con el `timeout_ms` por defecto de 10 s habrían sido
50 s de los 52.

No existe forma de preguntar *"¿hay algo escuchando?"* sin hacer una petición HTTP completa
y esperar su timeout. `measure.tcp` —ya especificada en [05 §9](v2/05-modulo-facts.md) como
extensión compatible— resolvería exactamente esto. **Segunda vez que aparece este candidato
por uso real**, no por conjetura.

### Hallazgo 4 — la envoltura pesa más que la medida

Media de **2 121 B por llamada**, y las respuestas útiles no llegaban a 400 B de contenido.
Desglose de una respuesta de error (1 313 B, un `CONNECTION_RESET`):

- `target` repite los argumentos que acabo de enviar, incluidos los defaults que no puse
  (`method`, `follow_redirects`, `max_body_bytes`, `timeout_ms`): ~180 B.
- `observation_id`, `request_id`, `tool`, `project`: cuatro identificadores, ~150 B.
- `observed_at`, `age_seconds`, `age_basis`, `duration_ms`: ~110 B.
- `error.detail` con la causa: útil.

Para **un barrido de reconocimiento**, `target` es puro eco y `request_id` no me sirvió
nunca. En cambio para *asentar una afirmación* `target` es justo lo que hace reproducible la
medida. **No sobra en general: sobra en este modo de uso.** Lo que falta es poder pedir menos
—algo como `verbosity: 'compact'`— no quitar campos del contrato.

---

## 2. Dónde se paró

El rodaje terminó aquí por decisión de proyecto: el servidor se mantiene libre de uso real
hasta que lo pruebe su primer consumidor, desde su propio proyecto. Quien lo haga anota
aquí lo que encuentre.
Quedan sin cubrir **JSON 200**, **DNS_FAILURE**, **WebSocket** y las cuatro tools `recall.*`.
