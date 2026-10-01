# Decisiones y cambios respecto a la v1

> Documento 10 de 11 · Plinth v2.0

---

## 1. Qué cambia de la v1, y por qué

La v1 era una buena especificación. Su problema no era la calidad sino el encaje: describía
**un servidor**, y lo que hacía falta era **una base**. Esta tabla es el diff conceptual.

| # | v1 | v2 | Por qué |
|---|---|---|---|
| 1 | Un solo servidor, monolítico | Núcleo + módulos, monorepo | Es lo que se pidió: una base para varios proyectos |
| 2 | Sin versión de protocolo MCP | Pinchado en `2026-07-28` | La revisión de 2026 eliminó sesiones, `initialize`, peticiones servidor→cliente y la reanudación SSE. Una especificación sin versión describe un protocolo que ya no existe |
| 3 | Sin `outputSchema` | `outputSchema` + `structuredContent` en toda tool | El cliente valida la respuesta y el modelo la entiende sin adivinar |
| 4 | Todo error por JSON-RPC | Tabla de canal por situación | La especificación pide que los errores de validación lleguen como *tool execution errors* para que el modelo se corrija solo |
| 5 | `measured_at` | `observed_at` | El campo es del núcleo y no todo módulo mide |
| 6 | Edad restando fechas de pared | Edad sobre reloj monótono, con `age_basis` | Un salto de NTP producía edades negativas y destruía la regla R2 |
| 7 | Lista de hosts por nombre | Resolución, validación por IP y conexión a la IP fijada | El filtro por nombre era vulnerable a DNS rebinding, a redirecciones y a `169.254.169.254` |
| 8 | Playwright dentro del servidor | Paquete opcional aparte | Cientos de MB y una dependencia nativa impuestos a todo el que quiera la base para otra cosa |
| 9 | `fsync` por línea, lock a 5 s | *Group commit* + cola por flujo | El lock era el cuello de botella; ahora N escrituras cuestan un `fsync` |
| 10 | Escaneo lineal del JSONL | Índice derivado con checkpoint | Una consulta sobre 100 000 afirmaciones era O(n) con lectura de disco, cada vez |
| 11 | "Se salta la línea ilegible" | Recuperación especificada: cola parcial, hueco de `seq`, avisos | "Se salta" no es un algoritmo |
| 12 | Blobs referenciados no se recolectan | Algoritmo de GC con ventana de gracia y parada ante avisos | |
| 13 | Evidencia completa en cada consulta | `evidence: none \| summary \| full`, con `summary` por defecto | 50 afirmaciones podían devolver megabytes al contexto del modelo |
| 14 | Retractar y sustituir, dos llamadas | `recall.supersede` atómico | Interrumpido a la mitad, el registro dice algo falso |
| 15 | "No opina" como propiedad del servidor | Política `factual` opt-in por módulo | Un módulo Gantt calcula holguras: eso es aritmética, no juicio. Forzar F2 a todo módulo habría hecho la base inservible |
| 16 | §10: catorce comprobaciones en prosa | 54 comprobaciones ejecutables | Un contrato que no se ejecuta se erosiona en el tercer PR |
| 17 | `HECHOS_*`, prosa y campos mezclando idiomas | Prosa en español, todo lo demás en inglés | |
| 18 | `action_results[].ok` | `action_results[].executed` | `ok` ya significa otra cosa muy concreta en la envoltura |
| 19 | Sin límite de tamaño de respuesta | `RESULT_LINKED` sobre 1 MiB | Una respuesta enorme reventaba el contexto del cliente en silencio |
| 20 | Sin modelo de autorización | Tres modos obligatorios en HTTP | En HTTP, `project` como argumento libre es lectura arbitraria de cualquier registro |

### Lo que NO cambia

Y merece decirse, porque era lo bueno de la v1 y sobrevive entero:

- Las dos reglas: lo medible no se responde de memoria; toda respuesta trae su hora.
- La distinción entre **error de observación** y **observación de un error**. Un 500 es
  `ok: true`.
- El registro append-only donde nada se borra nunca, y la retractación con motivo.
- La evidencia incrustada para que la afirmación sobreviva a la rotación.
- `remeasure_with` como mecanismo, no como sugerencia.
- La lista de lo que nunca entrará: `assert_status`, `summarize`, `health`, `wait_until`,
  `delete`, `rank`.
- Las lecturas declarativas del navegador en vez de `evaluate` de JS arbitrario.
- El tono: prohibiciones explícitas, y una tabla de decisiones con su alternativa
  descartada.

---

## 2. Registro de decisiones (ADR)

Formato corto. Cada uno va también como fichero en `docs/adr/NNNN-*.md` al arrancar el
repositorio.

---

### ADR-001 — Monorepo con núcleo y módulos separados

**Estado**: aceptada · **Contexto**: hacen falta varios servidores MCP (hechos, simulador
de protocolos, Gantt) que comparten infraestructura y no comparten dominio.

**Alternativas**: (a) un repositorio por servidor, copiando la infraestructura;
(b) una sola biblioteca monolítica; (c) monorepo con núcleo y módulos.

**Decisión**: (c), **con la secuencia corregida por ADR-018**: el monorepo se crea en la
etapa D, no al principio. **Consecuencias**: hace falta disciplina de fronteras —de ahí
`dependency-cruiser` y las reglas de lint propias— y versionado *fixed* del núcleo. A
cambio, una mejora de seguridad o rendimiento llega a los tres dominios a la vez.

---

### ADR-002 — TypeScript sobre Node 22, ESM puro

**Alternativas**: Python (SDK maduro, pero Playwright de segunda y distribución peor para
clientes MCP); Go (binario único, ecosistema MCP más joven); TypeScript con módulos fuera
de proceso (máxima flexibilidad, mucha complejidad).

**Decisión**: TypeScript, ESM puro, sin build dual. **Consecuencias**: se renuncia a
consumidores CJS. Es aceptable en 2026 y ahorra la mitad de la superficie de bugs de
empaquetado.

---

### ADR-003 — Usar el SDK oficial de MCP, aislado tras un adaptador

**Estado**: vigente como intención; **suspendida en la práctica** hasta el *spike* de la
etapa B. La etapa A implementó el protocolo contra el esquema normativo por un error de
nombre de paquete en el arranque; el historial completo está en
[ADR-0001](../adr/0001-implementar-protocolo-sin-sdk.md) y
[ADR-0002](../adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md). La frontera de
`src/protocol/` que esta decisión compraba **se conserva intacta y ya se ha cobrado una vez**.

**Contexto**: implementar JSON-RPC, SSE y las reglas de cabeceras a mano es factible y es
una fuente permanente de deuda; la revisión 2026-07-28 lo demuestra.

**Decisión**: `@modelcontextprotocol/sdk` como dependencia de **un solo paquete**,
`@plinth/protocol`. El modelo de tools del núcleo no lo conoce.

**Consecuencias**: una capa de traducción que hay que mantener. A cambio, una revisión del
protocolo toca un paquete y 13 tests. Regla de lint `no-sdk-import` para que la frontera no
se erosione.

---

### ADR-004 — Soportar solo `2026-07-28`, sin modo *dual-era*

> **Revisada por [ADR-0004](../adr/0004-hablar-tambien-la-era-de-sesion.md)**: los clientes
> desplegados —Claude Code entre ellos— abren con `initialize` y no conectaban. El servidor
> habla ahora ambas eras, elegidas por conexión.

**Contexto**: los clientes *legacy* esperan `initialize`. Soportar ambos mundos significa
dos máquinas de estado, dos modelos de sesión y el doble de tests.

**Decisión**: solo la revisión moderna. Un `initialize` recibe un error cuyo mensaje nombra
las versiones soportadas —lo que la especificación pide, porque es el único diagnóstico que
verá el usuario de un cliente antiguo.

**Consecuencias**: clientes sin actualizar no funcionan. Si hiciera falta, iría en
`@plinth/protocol-legacy`, nunca dentro de `@plinth/protocol`. **Revisar en `1.0.0`**.

---

### ADR-005 — Log de eventos JSONL append-only, no SQLite

**Alternativas**: SQLite (consultas, transacciones, índices gratis), un log JSONL con
índice derivado.

**Decisión**: JSONL. **Motivo**: "no se borra nunca" se *demuestra* con el fichero a la
vista; se inspecciona con `tail`, se copia con `rsync`, se diffea con `git`, y no hay
dependencia nativa. El coste —índices y consultas a mano— se paga una vez en el núcleo y lo
disfrutan todos los módulos.

**Consecuencias**: un despliegue con varias réplicas necesita otro backend. La interfaz
`EventLog` está diseñada para que `@plinth/storage-postgres` sea posible sin tocar módulos.

---

### ADR-006 — Índice derivado con checkpoint, y que sea borrable

**Contexto**: escanear linealmente no escala; un índice en disco como fuente de verdad
rompería N5.

**Decisión**: índice en memoria, checkpoint binario con CRC, reconstruible al cien por
cien. Borrarlo no pierde nada, y hay un test que lo demuestra.

**Consecuencias**: coste de arranque en frío (< 400 ms para 100 000 eventos) y memoria
proporcional al log. Ambos medidos y con presupuesto.

---

### ADR-007 — Validar la red por IP resuelta, no por nombre

**Contexto**: la v1 validaba el nombre. `evil.localhost` puede resolver a una IP pública, y
entre validar y conectar cabe una segunda resolución distinta (TOCTOU).

**Decisión**: resolver, clasificar **todas** las direcciones, rechazar si alguna cae fuera
del perfil, y conectar a la IP validada con Host y SNI originales. Cada redirección
revalida. Link-local siempre denegado.

**Consecuencias**: no se puede usar un resolvedor de sistema con caché opaca en el camino
crítico, y hay que fijar `lookup` en el agente HTTP. Es el precio de que el servidor no sea
un proxy de exfiltración.

---

### ADR-008 — La política factual es opt-in por módulo

**Contexto**: la v1 hacía de "no opinar" una ley universal. Un módulo Gantt calcula ruta
crítica y holgura; con la lista negra de la v1, `is_critical` estaría prohibido.

**Decisión**: F1 y F2 se activan con `policy: 'factual'`. El módulo facts la declara; los
demás deciden.

**Consecuencias**: el núcleo debe distinguir perfiles en la conformidad. A cambio, la regla
se aplica donde tiene sentido y no se convierte en un obstáculo que la gente acaba
desactivando entera.

---

### ADR-009 — El navegador es un paquete opcional

**Decisión**: `@plinth/module-facts-browser`, con Playwright opcional y ocultación de tools
si no está disponible.

**Consecuencias**: una llamada más al montar. A cambio, `@plinth/core` se instala en dos
segundos y funciona en contenedores mínimos.

---

### ADR-010 — Handles explícitos en vez de sesiones

**Contexto**: la revisión 2026-07-28 elimina el estado por conexión. Un contexto de
navegador o una sesión de simulación no pueden vivir en la conexión.

**Decisión**: `HandleStore` en el núcleo, con identificadores opacos, atadura a proyecto (y
a identidad en HTTP), TTL, y un error de caducidad que dice cómo crear uno nuevo. La
descripción de la tool que crea un handle **debe** decir cuánto vive.

**Consecuencias**: el modelo tiene que arrastrar el handle entre llamadas. Es exactamente lo
que la especificación recomienda, y hacerlo bien una vez en el núcleo evita que cada módulo
lo haga mal.

---

### ADR-011 — `measured_at` → `observed_at`

**Contexto**: el campo es del núcleo; no todos los módulos miden.

**Decisión**: renombrar. Sin alias de compatibilidad: la v1 nunca se implementó, así que no
hay nada roto.

**Consecuencias**: la documentación de la v1 usa otro nombre. Está anotado en
`docs/guides/migrating-from-v1.md`. **Si se prefiere conservar `measured_at`, es la
decisión más fácil de revertir de todo este documento**: es un renombrado mecánico en el
núcleo y en el módulo facts.

---

### ADR-012 — Apache-2.0

> **Sustituida por [ADR-0003](../adr/0003-licencia-0bsd.md)**: el proyecto se publica bajo
> 0BSD, la licencia más abierta que es válida en todas las jurisdicciones.

Concesión expresa de patentes y cláusula de terminación. Coste: un `NOTICE`. Ver
[08 §1](08-proyecto-oss.md).

---

### ADR-013 — Los fallos esperados son valores (`Result`), no excepciones

**Contexto**: el adaptador debe decidir, en un solo sitio, si algo va por el canal de tool o
por el de protocolo. Con excepciones, esa decisión se dispersa por cada `catch`.

**Decisión**: `Result` en los handlers; un `throw` significa bug y produce `-32603`. Regla
de lint `result-not-throw`.

**Consecuencias**: hay que envolver la E/S de terceros con `attempt()`. A cambio, el mapeo
de errores es una tabla en un fichero y no una arqueología.

---

### ADR-014 — Sin carga dinámica de módulos

**Decisión**: los módulos se importan y se componen en código; no se cargan por ruta ni por
configuración.

**Motivo**: cargar código arbitrario desde configuración es una superficie de ataque
—especialmente en un servidor que ya tiene acceso a la red y al disco— a cambio de una
flexibilidad que nadie ha pedido. Un servidor es un programa de veinte líneas, no un
contenedor de plugins.

---

### ADR-015 — `@opentelemetry/api` y nada más

**Decisión**: la biblioteca depende solo de la API de OTel; el SDK y los exportadores los
aporta la aplicación. Sin proveedor registrado, todo es no-op.

**Motivo**: es la regla de instrumentación de bibliotecas. Arrastrar el SDK a un paquete
base obliga a todo consumidor a heredar una configuración de telemetría que no eligió.

---

### ADR-016 — El `project` no es etiqueta de métrica por defecto

**Motivo**: es una cadena libre controlada por el llamante. Como etiqueta, es una explosión
de cardinalidad y, en HTTP, una denegación de servicio contra el backend de métricas.
Activable con `PLINTH_METRICS_PROJECT_LABEL=1` donde el conjunto sea conocido y pequeño.

---

### ADR-017 — Windows es plataforma de primera

**Motivo**: un servidor MCP se lanza desde un editor, y muchos editores corren en Windows.
Rutas, `fsync`, bloqueo de ficheros y lanzamiento de procesos se comportan distinto. La
matriz de CI lo cubre desde el principio, porque añadirlo tarde significa reescribir la
capa de ficheros.

---

### ADR-018 — Construir `facts` primero; extraer el núcleo después

**Estado**: aceptada, 2026-09-22 · **Sustituye la secuencia de ADR-001 sin anular su
contenido.**

**Contexto**: la primera versión de este plan construía el núcleo en las fases 1–4 y
validaba en la fase 9 que servía para un segundo dominio. Una revisión externa señaló el
sesgo, y tiene razón: **una base abstraída de un solo caso es una conjetura**. Las costuras
salen donde las puso el primer módulo, no donde de verdad se repiten, y eso no se descubre
hasta que el segundo módulo pelea con el núcleo. La señal de alarma era visible sin leer el
código: una v1 congelada y una v2 cerrada, con tabla de cambios, y cero líneas escritas —
dos versiones de una especificación revisadas contra nada.

**Alternativas**: (a) seguir con el plan original; (b) tirar los documentos y empezar de
cero; (c) invertir el orden conservando los documentos con otro papel.

**Decisión**: (c). Se construye `facts` como **un solo paquete**, con las carpetas internas
marcando las costuras conocidas pero sin extraer paquetes ni publicar API. El núcleo se
extrae en la etapa D, de lo que la etapa C demuestre que se repitió **literalmente** entre
dos dominios. Los documentos 00–08 no se tiran: pasan a ser el diseño de `facts` y el
borrador de esa extracción.

**Excepción única**: la capa de protocolo se aísla desde el primer día. No por simetría con
un segundo módulo hipotético, sino porque la revisión `2026-07-28` acaba de mover sesiones,
handshake, errores y transporte a la vez. Esa costura está demostrada por los hechos.

**Consecuencias**: se acepta duplicación en la etapa C, deliberadamente, porque es el dato
que dice qué pertenece al núcleo. Se retrasa la publicación en npm. Y se acepta un
desenlace que antes no estaba sobre la mesa: **si al llegar a la etapa D los dos dominios
comparten menos de lo que parecía, la conclusión correcta es que no había base**, y dos
programas buenos valen más que una abstracción mediocre.

---

### ADR-019 — Salir con 6 tools, no con 12

**Contexto**: el documento 05 especifica doce tools para "medir y recordar". Ninguna se ha
usado todavía en serio.

**Decisión**: la etapa A publica seis —`measure.http`, `measure.ws`, `recall.assert`,
`recall.retract`, `recall.query`, `recall.history`— y las otras seis esperan a que el uso
las pida, con el criterio de entrada escrito en [09 etapa B](09-plan-de-ejecucion.md).

**Motivo**: cada tool publicada es superficie que hay que describir bien para el modelo,
versionar y mantener. Una tool que nadie ha usado no se sabe si está bien diseñada; solo se
sabe que existe. `measure.diff` es el caso más claro: no tiene sentido hasta que existan
dos observaciones que comparar, y es mejor diseñarla el día que duela compararlas a mano.

**Consecuencias**: se retrasan comodidades reales (`supersede` atómico, `export`). Están
especificadas y el coste de añadirlas es bajo; el coste de haberlas diseñado a ciegas, no.

---

## 3. Decisiones pendientes

Cosas que esta especificación **no** decide, deliberadamente, y que habrá que decidir con
información que hoy no existe. Cada una debe terminar en un ADR.

| Pendiente | Cuándo decidir | Qué hará falta saber |
|---|---|---|
| Nombre y scope definitivos | Etapa D (no se publica antes) | Si `@plinth` está libre en npm |
| API exacta del SDK | Etapa A1 | Los tipos de la versión que se instale |
| Si `recall.query` necesita ordenación por relevancia | Etapa B, con hallazgos en mano | Si el escaneo por subcadena resulta insuficiente en la práctica. Sospecha: no, y añadirla rozaría F2 |
| Backend de almacenamiento alternativo | Si aparece un despliegue multi-réplica | Qué garantías hacen falta de verdad |
| OAuth en HTTP | Si hay despliegue público | Qué proveedor de identidad |
| Segundo módulo: Gantt o simulador | Etapa C | Cuál de los dos está más definido en tu cabeza. El que más estire el núcleo es el mejor candidato |
| Si `age_basis: "wall"` debería persistir el monótono | Si aparece deriva de reloj real | Medición |
