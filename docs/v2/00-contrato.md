# Plinth — Contrato del núcleo

> Especificación v2.0 · 2026-09-22 · Sustituye a [v1/00-especificacion.md](../v1/00-especificacion.md)
> Documento 00 de 11. Índice en [README](../README.md).

---

## 0. Nota sobre el nombre

`Plinth` (plinto: la base sobre la que se apoya una columna) es el nombre de trabajo del
proyecto y el *scope* npm de todos los paquetes: `@plinth/core`, `@plinth/storage`, etc.

El nombre aparece en exactamente tres sitios del código: el campo `name` de cada
`package.json`, la constante `PACKAGE_SCOPE` en `packages/core/src/meta.ts`, y el prefijo
de variables de entorno `PLINTH_`. Cambiarlo es un *find & replace* de cinco minutos.
**Antes de la primera publicación hay que comprobar que el scope está libre en npm.**

---

## 1. Qué es Plinth

Una **base para construir servidores MCP**, no un servidor MCP concreto.

Plinth resuelve, una sola vez y bien, el trabajo que todo servidor MCP serio repite:
hablar la revisión vigente del protocolo, validar entrada y salida contra esquemas,
distinguir un fallo del modelo de un fallo del servidor, cancelar trabajo a tiempo, no
convertirse en un proxy de salida, registrar hechos de forma auditable, y demostrar con
pruebas ejecutables que cumple su propio contrato.

Encima de esa base se montan **módulos**: paquetes que aportan tools, recursos y
configuración, y que no saben nada de transportes, de JSON-RPC ni de versiones de
protocolo. El primer módulo es `@plinth/module-facts` — la reescritura del "MCP de
Hechos" de la v1. Un simulador de protocolos o una herramienta de planificación Gantt son
otros dos módulos, escritos por ti, que reutilizan todo lo anterior sin tocar una línea
del núcleo.

```
┌─────────────────────────────────────────────────────────────┐
│  módulos   facts   ·   protocol-sim   ·   gantt   ·   …      │  ← tu dominio
├─────────────────────────────────────────────────────────────┤
│  núcleo    tools · política · almacén · reloj · observab.    │  ← Plinth
├─────────────────────────────────────────────────────────────┤
│  protocolo adaptador MCP 2026-07-28  ·  stdio · HTTP         │  ← aislado
└─────────────────────────────────────────────────────────────┘
```

### La prueba de que la base es una base

Un servidor de hechos y una herramienta Gantt no se parecen en nada. Lo que comparten es
justamente lo que Plinth contiene: identidad de proyecto, un registro append-only de lo
que pasó, marcas de tiempo honestas, validación, límites de recursos, trazas. Si un día
hace falta añadir al núcleo algo que solo sirve a uno de los dos módulos, el diseño ha
fallado y ese algo pertenece al módulo. Esa frase es operativa: la comprobación 42 de
[07-conformidad-y-pruebas §2](07-conformidad-y-pruebas.md) la convierte en un test que falla.

---

## 2. Invariantes del núcleo

Cinco reglas. Valen para **todos** los módulos, incluidos los que escribas tú. El kit de
conformidad las comprueba automáticamente sobre cualquier módulo registrado.

### N1 — Toda respuesta trae su hora

Toda salida de toda tool lleva `observed_at` (ISO 8601 con offset, reloj de pared) y
`age_seconds` (número, derivado de un reloj **monótono**, no de restar dos fechas de
pared). En una medida fresca `age_seconds ≈ 0`; en un dato recuperado de un registro es su
antigüedad real.

Cuando una respuesta contiene una colección de elementos con historia propia (afirmaciones,
revisiones de un plan, muestras de una traza), **cada elemento lleva su propio
`observed_at` y `age_seconds`**, además de los de la operación.

> **Cambio respecto a v1.** v1 llamaba a este campo `measured_at`. En v2 el núcleo lo llama
> `observed_at` porque no todos los módulos "miden": un módulo Gantt *observa* el estado de
> un plan. La regla es idéntica; solo cambia el nombre para que sea de todos. Ver
> [10-decisiones § ADR-011](10-decisiones.md).

### N2 — Los fallos esperados son valores, no excepciones

Un handler devuelve `Ok(valor)` o `Err(error)`. Lanzar una excepción significa **bug**, y el
núcleo la convierte en un error de protocolo `-32603` con traza en el log y sin detalle al
cliente.

Esto no es estilo: es lo que permite que el núcleo decida correctamente, en un solo sitio,
si algo va como *tool execution error* (`isError: true`, con texto que el modelo puede usar
para corregirse) o como error JSON-RPC (§ [03-protocolo](03-protocolo.md)).

### N3 — Ningún destino sale de la política

Ninguna tool abre un socket, resuelve un DNS, lee un fichero ni lanza un proceso sin pasar
por `ctx.policy`. La política se decide al arrancar el servidor, no dentro de un handler, y
niega por defecto. Un módulo que necesite alcanzar algo declara la capacidad que necesita;
el operador la concede o no.

### N4 — Todo trabajo es cancelable y acotado

Todo handler recibe un `AbortSignal` y un `deadline`. Toda operación de E/S lo propaga. No
hay bucles sin comprobación de cancelación, no hay `await` sin timeout, no hay reintentos
implícitos. Cuando el cliente cierra el stream, el trabajo para.

### N5 — El registro no se reescribe

Todo almacén de Plinth es un log de eventos *append-only*. No hay `UPDATE`, no hay `DELETE`,
no hay compactación destructiva. El estado actual es una proyección de los eventos. Los
índices son caché derivada, reconstruible y borrable sin pérdida.

---

## 3. La política factual (opt-in)

La v1 hacía de "no opinar" una propiedad del servidor. En v2 es una **política que un
módulo declara**, porque no todo módulo puede cumplirla ni debe: una herramienta Gantt
calcula holguras y marca la ruta crítica, y eso es aritmética legítima que el filtro de
la v1 habría rechazado.

Un módulo declara `policy: "factual"` y con ello acepta dos reglas adicionales, que el kit
de conformidad verifica:

### F1 — Lo medible no se responde de memoria

Si un dato se puede medir ahora, ninguna tool del módulo puede devolverlo desde su
registro. El registro guarda afirmaciones históricas con su evidencia; no es una caché del
estado actual.

En la práctica: las tools de lectura del registro no ejecutan medidas ni sintetizan estado
actual; devuelven cada afirmación con su edad y su marca `stale`; y cuando la afirmación
versa sobre algo medible incluyen `remeasure_with` — el nombre exacto de la tool y los
argumentos con los que se tomó la evidencia — para que quien lea pueda volver a medir sin
adivinar. El servidor **no decide** si hay que volver a medir: da la edad y el cómo.

### F2 — Ningún campo de salida es un juicio

Ningún esquema de salida del módulo contiene una clave cuyo valor sea una valoración:
`health`, `status: "ok"|"degraded"`, `score`, `severity`, `passed`, `is_healthy`,
`summary`, `recommendation`, `should_*`. Un `200` es un `200`; que eso sea bueno lo decide
quien pregunta.

La única excepción documentada es `ok`, que significa exactamente *"la observación se pudo
tomar"* y nunca *"el sistema observado está bien"*. Un HTTP 500 recibido limpiamente es
`ok: true` con `status: 500`.

> El linter de esquemas que impone F2 vive en `@plinth/conformance` y la lista negra es
> configurable por módulo: un módulo factual puede justificar una excepción declarándola,
> con un comentario, en su manifiesto. Declarar una excepción es visible en el diff y en la
> review; olvidarse de F2 no lo era en la v1.

---

## 4. Fronteras del núcleo

Prohibiciones duras sobre `@plinth/core` y sus paquetes hermanos. Un cambio que cruce
cualquiera de estas líneas no es una mejora del núcleo: es un módulo.

**El núcleo no conoce ningún dominio.** Cero rutas, puertos, nombres de servicio, esquemas
de negocio o selectores. Si `packages/` contiene la cadena `localhost:3000`, algo está mal
puesto.

**El núcleo no importa el SDK de MCP.** El modelo de tools del núcleo es independiente del
protocolo. Solo `@plinth/protocol` conoce `@modelcontextprotocol/sdk`. Esta frontera es lo
que hace que una revisión del protocolo — y ya ha habido una demoledora en 2026 — toque un
paquete y no once.

**El núcleo no escribe fuera de su directorio de datos.** Ni `git`, ni builds, ni
instalaciones, ni arranque de servicios, ni edición de ficheros de ningún proyecto. Toda
ruta que se resuelva fuera de `PLINTH_DATA_DIR` es un error.

**El núcleo no reintenta en silencio.** Un fallo de red es un resultado: se devuelve como
tal, con su hora. Sin backoff oculto, sin fallback a otra URL. Una política de reintentos
es una decisión de dominio y vive en el módulo que la quiera, explícita en su esquema.

**El núcleo no usa funciones obsoletas del protocolo.** La revisión 2026-07-28 deja
obsoletos *Roots*, *Sampling* y *Logging*. Plinth no los implementa ni los expone: los
directorios entran por parámetro de tool o por configuración, el log va a `stderr` y a
OpenTelemetry, y la generación con LLM no es asunto de un servidor MCP.

---

## 5. Modelo de proyecto

Un `project` es una cadena libre normalizada que aísla los datos de un consumidor del
servidor. Se crea en su primer uso; no hay que declararlo.

- **Normalización**: minúsculas; se recortan espacios de los extremos; cada carrera de
  caracteres fuera de `[a-z0-9._-]` se colapsa en un solo `-`; se recortan `-` inicial y
  final.
- **Restricciones**: 1–64 caracteres tras normalizar; no puede ser `.`, `..` ni cadena
  vacía; no puede contener `/` ni `\` (garantía anti *path traversal*, reforzada por una
  comprobación de ruta resuelta en el almacén).
- Toda tool que reciba `project` **devuelve el `project` normalizado**, para que quien
  llama vea con qué identidad se escribió. Un typo fragmenta un registro; devolver la forma
  normalizada lo hace visible en la primera llamada.
- Aislamiento estricto: los datos de un proyecto nunca aparecen en una consulta de otro, y
  un identificador emitido en el proyecto A no es resoluble desde el B.

En transporte stdio el `project` es un argumento de confianza: quien lanza el proceso ya
controla la máquina. **En transporte HTTP no lo es**, y la §7.1 de
[03-protocolo](03-protocolo.md) especifica cómo se ata el `project` a la autorización de la
petición en vez de creerse el argumento.

---

## 6. Identificadores

Todo identificador emitido por Plinth tiene la forma `<prefijo>_<ULID>`:

- **ULID** de 26 caracteres, Crockford base32, ordenable lexicográficamente por tiempo,
  monótono dentro del mismo milisegundo. Implementación propia en `@plinth/core`
  (~40 líneas, `crypto.randomFillSync`), sin dependencia externa.
- **Prefijos** reservados por el núcleo: `o_` observación, `e_` evento de log,
  `b_` blob, `r_` petición, `t_` traza. Cada módulo registra sus propios prefijos
  (`c_` afirmación, en el módulo facts) y el núcleo rechaza colisiones al arrancar.
- Los identificadores son **opacos** para el cliente: se devuelven, se pasan de vuelta, no
  se parsean. Que sean ordenables es una propiedad interna, no un contrato público.

> Por qué ULID y no UUIDv7: ambos son ordenables por tiempo; ULID se lee, se escribe y se
> pega sin guiones, y es la mitad de largo en base32. Para un identificador que un modelo
> de lenguaje debe transcribir de una respuesta a la siguiente llamada, eso importa.

---

## 7. Convenciones de idioma

- **Documentación en prosa**: español.
- **Código, identificadores, nombres de tool, nombres de campo, códigos de error,
  mensajes de log, mensajes de commit y comentarios**: inglés.

Un proyecto de código abierto con nombres de campo en español pierde a sus contribuidores
fuera del ámbito hispanohablante; una documentación en inglés mediocre pierde claridad. La
v1 mezclaba ambos (`HECHOS_DATA_DIR`, `statement`, prosa en español). v2 fija la línea.

---

## 8. Glosario

| Término | Significado en Plinth |
|---|---|
| **Núcleo** (*core*) | `@plinth/core` y sus paquetes hermanos. Sin dominio, sin SDK de MCP |
| **Módulo** | Paquete que aporta tools y recursos. Es donde vive tu dominio |
| **Servidor** | Una composición concreta: núcleo + N módulos + política + transporte |
| **Observación** | Envoltura común de salida: qué se miró, cuándo, cuánto tardó, qué salió |
| **Afirmación** (*claim*) | Entrada del registro del módulo facts: enunciado + evidencia + autor + fecha |
| **Política** | El conjunto de capacidades concedidas al arrancar: red, disco, procesos |
| **Conformidad** | Suite ejecutable que verifica N1–N5 y, si aplica, F1–F2 |
| **Envoltura** (*envelope*) | La parte de una salida que pone el núcleo, común a todas las tools |

---

## 9. Qué hay que leer después

| Si quieres… | Lee |
|---|---|
| Ver cómo encaja todo y cómo se añade un módulo | [01-arquitectura](01-arquitectura.md) |
| Escribir una tool | [02-nucleo-api](02-nucleo-api.md) |
| Entender el binding MCP y la seguridad de red | [03-protocolo](03-protocolo.md) |
| Guardar algo de forma auditable | [04-almacenamiento](04-almacenamiento.md) |
| Ver el contrato completo del módulo de hechos | [05-modulo-facts](05-modulo-facts.md) |
| Saber qué se mide y qué se traza | [06-observabilidad-y-rendimiento](06-observabilidad-y-rendimiento.md) |
| Demostrar que cumple | [07-conformidad-y-pruebas](07-conformidad-y-pruebas.md) |
| Publicarlo | [08-proyecto-oss](08-proyecto-oss.md) |
| **Construirlo** | [09-plan-de-ejecucion](09-plan-de-ejecucion.md) |
| Saber por qué se decidió así | [10-decisiones](10-decisiones.md) |
