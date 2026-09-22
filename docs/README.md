# Plinth — especificación

Un servidor MCP que **solo sostiene hechos**, y —más adelante, si el uso lo justifica— la
base sobre la que montar otros.

- **Medir** — apunta a un servicio y devuelve la medida cruda con su hora: estado y cuerpo
  de una ruta, mensajes que un WebSocket entrega en N segundos, diferencia contra la medida
  anterior. Nunca una conclusión.
- **Recordar** — un registro por proyecto donde cada entrada es *afirmación + evidencia +
  quién la midió + cuándo*, y donde una afirmación no se borra nunca: se marca como
  retractada, con el motivo.

---

## Las tres reglas

Sin ellas esto no aporta nada sobre un agente cualquiera.

1. **Si algo se puede medir ahora, no se responde de memoria.** El registro guarda
   afirmaciones históricas con su evidencia; no es una caché del estado actual. Cuando
   devuelve una afirmación sobre algo medible, entrega también **cómo volver a medirla**.
2. **Toda respuesta trae la hora en que se midió**, para que se note cuando está vieja. Y
   cada elemento de una colección lleva **su propia edad**, no la de la consulta.
3. **No interpreta ni puntúa.** Ningún campo de salida es un juicio: nada de `health`,
   `score`, `severity`, `passed`, `recommendation`. En el momento en que emita juicios deja
   de ser una fuente y pasa a ser otro agente al que hay que verificar — que es exactamente
   el trabajo que existe para ahorrar.

Y la distinción que lo sostiene todo: **un error de observación no es lo mismo que la
observación de un error**. Un HTTP 500 recibido limpiamente es un éxito de la herramienta,
con `ok: true`. Solo es error lo que impidió medir.

---

## Estado y orden de construcción

> **Revisado el 2026-09-22.** La versión anterior de este plan construía primero un núcleo
> reutilizable y validaba al final que servía para un segundo dominio. Eso era diseñar una
> base antes de su segundo usuario: abstraída de un solo caso, es una conjetura, y las
> costuras salen donde las puso el primer módulo, no donde de verdad se repiten.
> El orden está invertido. Ver [ADR-018](v2/10-decisiones.md).

| Etapa | Qué | Estado |
|---|---|---|
| **A** | `facts` como **un solo paquete**: 6 tools, stdio, sin monorepo | **completa** |
| **A5** | Rodaje contra servicios reales y heterogéneos | **aplazada**: la hará el primer consumidor |
| **A6** | Documento de traspaso: [USO.md](USO.md) | **completa** |
| **B** | Arreglar lo que el rodaje rompió. Nada más | |
| **C** | Segundo dominio, en el mismo repo, **copiando y pegando** | |
| **D** | Extraer el núcleo de lo que de verdad se repitió | |

**El criterio de éxito no son las comprobaciones de conformidad.** Es esto:

> ¿Puede otro Claude Code, que no ha visto este repositorio, conectar el servidor y
> verificar una aplicación que **nosotros no conocemos**, sin que el servidor sepa nada de
> ella?

El entregable de este proyecto es **la API, limpia para cualquier app**. Quien la consuma
—una aplicación industrial, un simulador de protocolos, una herramienta de planificación— es un
proyecto distinto y posterior. Si una sola línea de `src/` sabe algo de una app concreta,
esto ha fallado, por muchas comprobaciones que estén en verde.

La única frontera que se aísla desde el primer día es la del protocolo: la revisión MCP
`2026-07-28` acaba de mover sesiones, handshake, errores y transporte a la vez. Esa costura
está demostrada por los hechos, no supuesta.

**Empezar por**: [09-plan-de-ejecucion](v2/09-plan-de-ejecucion.md), etapa A1.

---

## Los documentos, y qué papel tiene cada uno ahora

| # | Documento | Papel |
|---|---|---|
| 00 | [Contrato](v2/00-contrato.md) | Invariantes, las tres reglas, fronteras. **Vigente entero** |
| 01 | [Arquitectura](v2/01-arquitectura.md) | Monorepo y capas. *Borrador de la extracción (etapa D)* |
| 02 | [API del núcleo](v2/02-nucleo-api.md) | `Result`, envoltura, redacción **vigentes**; módulos, handles y concurrencia *a la etapa D* |
| 03 | [Protocolo y transportes](v2/03-protocolo.md) | **Vigente entero** salvo HTTP (§7), que va a la etapa D |
| 04 | [Almacenamiento](v2/04-almacenamiento.md) | Log y blobs **vigentes**; índice y *group commit* *a la etapa B, si se miden lentos* |
| 05 | [Módulo `facts`](v2/05-modulo-facts.md) | El diseño de lo que se construye. 12 tools especificadas, **6 en la etapa A** |
| 06 | [Observabilidad](v2/06-observabilidad-y-rendimiento.md) | *Etapa D.* En la A, NDJSON a `stderr` y nada más |
| 07 | [Conformidad](v2/07-conformidad-y-pruebas.md) | Las 54 comprobaciones. *Como tests normales en A, como paquete en D* |
| 08 | [Proyecto OSS](v2/08-proyecto-oss.md) | *Etapa D.* No se publica una API que no se ha usado dos veces. Licencia: 0BSD ([ADR-0003](adr/0003-licencia-0bsd.md)) |
| 09 | [**Plan de ejecución**](v2/09-plan-de-ejecucion.md) | **Empezar aquí** |
| 10 | [Decisiones](v2/10-decisiones.md) | Cambios v1→v2 y 19 ADR con sus alternativas descartadas |

La [especificación v1](v1/00-especificacion.md) queda congelada como referencia histórica.
Qué cambió y por qué, en [10-decisiones §1](v2/10-decisiones.md).

---

## Las 6 tools de la etapa A

| Tool | Qué devuelve |
|---|---|
| `facts.measure.http` | Estado, cuerpo, cabeceras, tiempos y **a qué IP se conectó de verdad** |
| `facts.measure.ws` | Los mensajes que llegaron en N segundos, con hora absoluta y offset |
| `facts.recall.assert` | La afirmación tal como quedó escrita, con su evidencia incrustada |
| `facts.recall.retract` | La afirmación marcada, con motivo. Nunca borrada |
| `facts.recall.query` | Afirmaciones con su edad, su marca `stale` y cómo volver a medirlas |
| `facts.recall.history` | Los eventos crudos de una afirmación, en orden |

Las otras seis están especificadas en [05](v2/05-modulo-facts.md) y **esperan a que el uso
las pida**: `measure.diff`, `measure.browser`, `browser.open`, `browser.close`,
`recall.supersede`, `recall.export`.

---

## Qué no entra nunca

Por mucho que se pida, y porque cada una rompe la regla 1 o la 3:

`measure.assert_status` · `measure.wait_until` · `recall.summarize` · `recall.rank` ·
`recall.delete` · `project.health`
