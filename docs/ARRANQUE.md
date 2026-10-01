# Arranque — prompts para Claude Code

> **Corregido el 2026-09-22.** La versión anterior ordenaba instalar
> `@modelcontextprotocol/sdk`. Ese es el paquete **v1**, congelado en la revisión
> `2025-11-25`. La implementación de `2026-07-28` se publicó con nombres nuevos. El error
> costó una etapa entera de trabajo bien hecho contra el artefacto equivocado; ver
> [ADR-0002](adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md).

Estado actual: **etapas A1–A4 completas y B0 saldada**, 470 tests en verde.
Detalle en [estado-de-ejecucion.md](estado-de-ejecucion.md). Lo siguiente es **A5**.

---

## Los paquetes del SDK, para que no vuelva a pasar

| Paquete | Versión | Qué es |
|---|---|---|
| `@modelcontextprotocol/server` | `2.0.0` | **El que se usa.** Servidor, revisión `2026-07-28`. Export `./stdio` |
| `@modelcontextprotocol/client` | v2 | Cliente. Para los tests de contrato |
| `@modelcontextprotocol/core` | `2.0.0` | Tipos compartidos. Entra como dependencia |
| ~~`@modelcontextprotocol/sdk`~~ | `1.30.0` | **NO.** Línea v1, habla `2025-11-25` |

Aviso de la guía oficial de migración: *"Nothing in v2 puts a 2026-07-28 byte on the wire by
default"*. La revisión moderna es **opt-in explícito**.

---

## A5 — Rodaje contra servicios reales

> **Esta etapa cambió el 2026-09-22.** Antes pedía verificar la lista de comprobaciones de
> una aplicación concreta. Era un criterio de otro proyecto: mezclaba el entregable —la API,
> limpia para cualquier app— con su primer consumidor. El intento de ejecutarlo encontró que
> esa lista no existía, y el agente paró en vez de inventar un sustituto, que fue lo
> correcto. **Cada aplicación que la use es un proyecto distinto.**

El prompt está abajo. No lleva huecos que rellenar: el agente descubre sus propios objetivos,
que es exactamente lo que hará quien use esto dentro de seis meses.

```
Estás en la raíz de este repositorio. Lee docs/README.md y docs/estado-de-ejecucion.md para
situarte: las etapas A1-A4 están completas y 470 tests están en verde. Esta es A5.

Conecta el servidor MCP:

{
  "mcpServers": {
    "facts": {
      "command": "node",
      "args": ["<ruta-al-repositorio>/dist/main.js"],
      "env": { "PLINTH_DATA_DIR": "<ruta-al-repositorio>/.data-a5" }
    }
  }
}

Cuidado con las barras invertidas si construyes esa ruta desde un script: un escapado malo
crea un directorio con el nombre corrupto y no te enteras. Si el cliente no conecta, lee el
stderr antes de dar por roto el servidor; el mensaje empieza por "facts-mcp:".

TAREA
Someter las seis tools -measure.http, measure.ws, recall.assert, recall.retract,
recall.query, recall.history- a servicios REALES de esta máquina, y anotar todo lo que
estorbe.

Esto NO es una demostración de que funciona. Es la primera vez que la API se usa sin que
nadie la haya diseñado para el caso, y el entregable son las molestias.

LA REGLA QUE DEFINE ESTA ETAPA
Los objetivos son heterogéneos y ANÓNIMOS. Sondea qué hay escuchando en la máquina y mídelo
sin necesitar saber qué es. Exactamente como lo hará quien use esto contra una aplicación
que hoy no existe.

NADA de lo que encuentres entra en el código, ni en un test, ni en un valor por defecto.
Ni un puerto, ni una ruta, ni un nombre de servicio. Al terminar, `git diff` sobre src/
tiene que estar VACÍO. Si algo hay que arreglar, se anota; no se arregla aquí.

OBJETIVOS MÍNIMOS, cada uno porque ejercita algo distinto:
- un servicio HTTP que responda 200 con JSON        -> el camino feliz
- uno que responda 200 con HTML grande              -> el ruido: cuánto contexto cuesta
- uno que responda 4xx o 5xx                        -> que un error del servicio sea ok:true
- un puerto abierto que NO hable HTTP               -> distinguir "hay algo" de "no hay nada"
- un puerto cerrado                                 -> CONNECTION_FAILED
- un host que no resuelva                           -> DNS_FAILURE
- un WebSocket, si encuentras alguno                -> measure.ws fuera del fixture
- una secuencia completa: medir -> recall.assert citando la medida -> recall.query ->
  recall.retract con motivo -> recall.history

Usa un project fijo: rodaje. Anota la hora de inicio y la de fin.

EL ENTREGABLE: docs/hallazgos-uso-real.md, escrito SOBRE LA MARCHA
- Qué no pudiste hacer con las seis tools, y qué habría hecho falta.
- Campos de la respuesta que SOBRAN: ruido que te ocupó contexto sin aportar. Cuantifícalo.
- Campos que FALTAN: algo que tuviste que deducir o pedir dos veces.
- Descripciones de tool que entendiste mal a la primera. Cita la frase exacta.
- Errores que no te dijeron qué hacer a continuación.
- QUÉ TUVISTE QUE SEGUIR HACIENDO A MANO. Es la sección más importante.
- Si algo te sorprendió para bien, anótalo también: sirve para no quitarlo luego.

Si el rodaje no encuentra nada que anotar, sospecha que tus objetivos se parecían
demasiado entre sí, y busca uno más raro antes de darlo por terminado.
```

---

## A6 — El documento de traspaso

La API está terminada cuando alguien que no ha visto el repositorio puede usarla. Eso no se
declara: se escribe. Prompt para la sesión siguiente:

```
Escribe docs/USO.md, dirigido a quien vaya a consumir este servidor MCP: otro Claude Code,
contra una aplicación que nosotros no conocemos. Una página, no once.

Contenido:
- Qué es y qué NO es, con las tres reglas del README.
- Cómo conectarlo: el bloque mcpServers listo para copiar, con PLINTH_DATA_DIR propio y
  obligatorio, y por qué lo es.
- Las seis tools, una línea cada una, y qué devuelven.
- LAS TRAMPAS, que son las que cuestan una tarde:
  · si el cliente no conecta, leer stderr (el LOCK de instancia);
  · las barras invertidas de Windows en el JSON de configuración;
  · que un 500 es ok:true y NO es un fallo de la herramienta;
  · que recall.* nunca mide, y por eso su respuesta puede estar vieja: para eso está
    remeasure_with.
- Dónde reportar lo que estorbe, para que el segundo consumidor no repita el trabajo del
  primero.

Incorpora lo que diga docs/hallazgos-uso-real.md: si algo confundió al agente de A5,
confundirá al siguiente.

CRITERIO DE SALIDA: una sesión limpia de Claude Code, con SOLO este documento y el bloque de
configuración, conecta el servidor y completa medir -> asentar -> consultar sin preguntar
nada. Cada pregunta que haga es un agujero de este documento.
```

---

## Etapa B — después de A5, y en este orden

La entrada son los documentos de hallazgos de uso real (`docs/hallazgos-*.md`). **El orden
lo marcan ellos, no esta lista.**

**B0 — Saldar el `LOCK` de instancia. ✅ Hecho el 2026-09-22, antes de A5.** Se adelantó
porque su escenario real es A5 mismo: dejarlo abierto arriesgaba corromper la evidencia que
esa etapa produce. `O_CREAT|O_EXCL` con el PID dentro, detección de lock rancio por
`process.kill(pid, 0)`, y un `release` que solo borra el lock si sigue siendo suyo.
Implementado en [`src/store/instance-lock.ts`](../src/store/instance-lock.ts); 7
comprobaciones más una verificación con dos procesos reales compartiendo directorio.

Queda una sola tarea que entra sin que el uso la pida:

**B1 — *Spike* del SDK v2, acotado.** Ver [ADR-0002](adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md).

```
Spike acotado, con permiso para abandonarlo.

Sustituye el interior de `src/protocol/` por `@modelcontextprotocol/server@2.0.0`
(instala también `@modelcontextprotocol/client@2` para los tests de contrato). Lee antes la
guía de migración en ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 y ten
presente que la revisión 2026-07-28 es opt-in explícito en ese paquete.

Reglas:
- No tocas NADA fuera de `src/protocol/` y `src/transport/`. Si la migración te obliga a
  cambiar `src/tools/` o `src/kernel/`, para: significa que la frontera no era tan limpia
  como creíamos, y ese hallazgo vale más que la migración.
- El criterio de aceptación son las 13 comprobaciones de docs/v2/03-protocolo.md §8, sin
  modificarlas. Si hay que cambiar un test para que pase, no pasa.
- `vendor/mcp-schema-2026-07-28.ts` se queda pase lo que pase: es el oráculo que detecta si
  nuestros tipos, o los del SDK, se desvían del esquema normativo.

Ambos desenlaces son un éxito del spike:
- Las 13 en verde → adoptamos el SDK, borramos la implementación propia, y la próxima
  revisión del protocolo la absorbe un tercero.
- El SDK no puede expresar algo que la especificación exige → conservamos la implementación
  propia, y escribes un ADR con QUÉ exactamente no podía. Eso es la justificación medida
  que hoy no tenemos.

Si te desbordas de tiempo, para y reporta dónde. Abandonar el spike es un resultado, no un
fallo.
```

El resto son candidatos y **solo entran si los hallazgos los pidieron**: `measure.diff`,
`recall.supersede`, `recall.export`, índice y *group commit* (medir antes), navegador,
enlazado de resultados grandes, `measure.tcp` / `measure.process`.

---

## Lo que hay que vigilar en la revisión de cada etapa

Cinco cosas que se pierden fácil y son justo lo que hace valioso esto:

1. **`age_seconds` por elemento**, no el de la consulta, y sobre reloj monótono: con un
   `FakeClock` que salte hacia atrás no puede dar negativo.
2. **Un 500 es `ok: true`.** Si un estado HTTP de error se convierte en error de
   herramienta, el contrato se rompió.
3. **`ok` se deriva de `error === null`**, nunca lo fija un handler.
4. **Ningún campo de salida que sea un juicio.** Ni `health`, ni `passed`, ni `summary`.
5. **El protocolo dentro de `src/protocol/`.** Es la frontera que acaba de pagar sola el
   ADR-0002; merece una regla de lint en cuanto duela.
6. **Ningún camino falla abierto.** Tres de los cuatro defectos que encontró la revisión de
   código eran el mismo error: *en el borde, entregar más de lo que se verificó* — la
   redacción devolviendo el resto intacto pasado el límite de profundidad, `measure.ws`
   reportando medio mensaje como entero, las credenciales cruzando una redirección de
   origen. Ante cualquier límite, tope o truncado, la pregunta es **qué entrega este camino
   cuando no pudo terminar de mirar**, y la respuesta correcta es *menos*, marcado con un
   `warning`. Sitios donde el patrón sigue vivo: `max_body_bytes`, `max_total_bytes` de
   `measure.ws`, y `changes_truncated` cuando llegue `measure.diff`.
