# Estado de ejecución — etapas A1 a A4, más B0

> 2026-09-22 · Lo que se construyó, lo que se verificó y lo que queda.
> El plan que gobierna esto es [09-plan-de-ejecucion](v2/09-plan-de-ejecucion.md).

---

## Resumen

| Etapa | Estado | Criterio de salida |
|---|---|---|
| **A1** — Esqueleto y protocolo | **completa** | 17 comprobaciones; `npx .` arranca y un cliente real lista y llama |
| **A2** — Política de red y `measure.http` | **completa** | 43 comprobaciones; los 7 criterios del plan en verde |
| **A3** — Almacén y `recall.*` | **completa** | 23 comprobaciones, incluidas las tres que no podían fallar |
| **A4** — `measure.ws` y el binario | **completa** | 10 comprobaciones; verificado desde un tarball limpio |
| **B0** — `LOCK` de instancia | **completa** (adelantada) | 7 comprobaciones; dos procesos reales, el segundo se niega a arrancar |
| **A5** — Rodaje con un consumidor real | **aplazada** (la hará el primer consumidor, desde su proyecto) | Ver §4 |
| **A6** — Documento de traspaso | **completa** | [USO.md](USO.md) |

**470 tests en verde**, unitarios y de contrato. Al cierre de A4 eran 160; el resto los
añadieron las revisiones de código posteriores, que cubrieron rutas de error, bordes de
protocolo y fallos propios de Windows. `typecheck`, `lint`, `format:check` y `test` limpios,
sin errores sueltos en ejecuciones repetidas, y la CI los repite en Linux y Windows.

> **B0 se adelantó a A5 a propósito.** Su escenario real *es* A5: dos clientes MCP, cada uno
> lanzando su servidor sobre el mismo directorio. Sin `LOCK`, las escrituras de dos procesos
> pueden intercalarse y partir una línea del registro — corrompiendo justo la evidencia que
> esa etapa existe para producir. Ahora un segundo proceso **no arranca**: escribe en
> `stderr` el PID que retiene el directorio y qué hacer al respecto. Detalle en §6.

---

## 1. El hallazgo que cambió A1

El ARRANQUE ordenaba instalar el SDK, leer sus tipos y **parar y avisar** si no encajaban con
la especificación. Se hizo esa comprobación antes de escribir código, y no encajaban.

**La revisión `2026-07-28` existe y es la actual.** Verificado en la página de versioning
(la declara *Current*), en `docs/specification/2026-07-28/` del repositorio, y en el esquema
normativo `schema/2026-07-28/schema.ts`. Las siete afirmaciones del documento 03 sobre esa
revisión son **ciertas**. La especificación estaba bien.

**El paquete `@modelcontextprotocol/sdk` no la habla.** `1.30.0` es su única versión (único
dist-tag, sin *prerelease*), se publicó el 2026-07-27 —un día antes de la fecha de la
revisión— y declara en su propio artefacto:

```
LATEST_PROTOCOL_VERSION = '2025-11-25'   ·   incluye '2026-07-28' → false
```

`server/discover`, `resultType` y `subscriptions/listen` tienen **cero** presencia en él,
mientras que `initialize`, `sampling`, `roots` y `elicitation` —lo que la spec da por
eliminado— están presentes.

**Decisión tomada** (usted eligió la opción de mayor cobertura): implementar el protocolo
contra el esquema normativo, versionado en `vendor/mcp-schema-2026-07-28.ts`.

> ### Corrección — la conclusión era equivocada
>
> Esta sección decía *"ningún SDK de TypeScript la habla"*. **Es falso**, y la causa está
> aguas arriba: el ARRANQUE nombraba `@modelcontextprotocol/sdk`, que es la línea **v1**. La
> v2 abandonó el paquete monolítico y se publicó como `@modelcontextprotocol/server`,
> `/client` y `/core`, hoy en `2.0.0` estable, y esa sí modela `2026-07-28`.
>
> Todo lo *medido* arriba sigue siendo cierto. Lo que falló fue el alcance de la búsqueda:
> medí el paquete que el prompt nombraba sin comprobar si el ecosistema se había
> reorganizado. **Fijar un nombre de paquete es fijar una suposición.**
>
> [ADR-0002](adr/0002-el-sdk-v2-se-publico-con-otro-nombre.md) recoge la decisión: la
> implementación propia **se queda hasta después de A5** —funciona, está probada, y parar el
> único hito que produce información real sería repetir el error que ADR-018 vino a
> corregir— y en B1 se hace un *spike* acotado con las 13 comprobaciones de
> [03 §8](v2/03-protocolo.md) como criterio. Ambos desenlaces son un éxito.
>
> Que esto cueste un *spike* y no una reescritura es la frontera de `src/protocol/`
> cobrándose sola, antes de lo previsto. ADR-004, ADR-010 y la "excepción única" de ADR-018
> siguen intactos.

---

## 2. Qué se construyó

```
src/
├── kernel/      Result, Clock (edad monótona), ULID, project, redacción, Envelope
├── protocol/    JSON-RPC 2026-07-28, server/discover, tools/list, tools/call, errores
├── transport/   stdio: framing por líneas, captura de console, cancelación
├── policy/      clasificación IPv4/IPv6 y el procedimiento de 7 pasos
├── store/       log append-only, rutas con realpath, LOCK de instancia
└── tools/       measure.http, measure.ws, recall.{assert,retract,query,history}
```

**Seis tools**, todas con `project` como parámetro y ninguna con conocimiento de dominio.

### Decisiones que merecen su atención

**La redacción se amplió a `data`, no solo a `target`.** Un test descubrió que un `set-cookie`
de respuesta llegaba en claro al cliente y al disco: la v2 especificaba redactar los
argumentos, pero una *respuesta* también trae credenciales. Corregido en el único punto por
el que pasa todo, la construcción de la envoltura.

**`ok` se deriva, nunca se pasa.** Es exactamente `error === null`. Dejar que un handler lo
fije por su cuenta es como "ok" empieza a significar "el servicio está bien", que es lo único
que no puede significar.

**`remeasure_with` omite las credenciales en vez de redactarlas.** Un marcador `[redacted:N]`
reproducido como cabecera sería una petición rota con aspecto de válida.

**`measure.ws` es un cliente RFC 6455 propio, no una dependencia.** La política exige conectar
a la IP validada conservando Host y SNI originales, y ningún cliente de terceros expone eso.
Solo lo que necesita una medida: sin reconexión, sin extensiones.

**Las sugerencias de caché salen de un solo sitio, y cubren `server/discover`.** La etapa A
siguió el documento 03 al pie de la letra, y ese documento solo las pedía en `tools/list`;
la norma ([SEP-2549](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching))
las exige en los seis métodos cacheables, `server/discover` incluido. **Estábamos fuera de
norma.** Corregido: una función `cacheHints()` las produce, las usan ambos métodos, y las
cuatro reglas fáciles de romper —`ttlMs >= 0` donde `0` es "inmediatamente rancio";
`input_required` sin sugerencias; mismo `cacheScope` en todas las páginas; `"public"` no es
control de acceso— están escritas donde alguien las rompería. `tools/call` **no** las lleva:
la lista es cerrada, y sugerir caché sobre una observación sería justo lo contrario de lo que
este servidor existe para garantizar.

---

## 3. Qué se verificó, y cómo

Las comprobaciones son el contrato, no ejemplos. Fallan si el servidor empieza a opinar.

**Del protocolo** (13 del [03 §8](v2/03-protocolo.md), menos las cuatro de HTTP): `discover`
sin E/S, `-32602` sin `protocolVersion`, `-32022` con la lista soportada, `initialize` que
nombra la versión, orden determinista con `ttlMs`/`cacheScope`, cancelación que detiene la
tool en <100 ms y no envía nada más, un
throw como `-32603` sin traza, y argumentos inválidos como **tool error** y no JSON-RPC.

**De la red**: 21 casos de clasificación IP (incluidos `::ffff:127.0.0.1`, `100.64.0.0/10` y
los bordes de `172.16/12`); `*.localhost` que resuelve a IP pública, rechazado; nombre con una
dirección loopback y otra pública, rechazado; `169.254.169.254` rechazado en **los cuatro
perfiles**, allowlist incluida; redirección a destino denegado, rechazada en el salto;
exactamente una petición al fixture —cero reintentos—; bomba de descompresión cortada al 100:1.

**Del almacén**: tras retractar, el fichero **crece** y el prefijo es **idéntico byte a byte**
—comparación de bytes, no de contenido equivalente—; `history` devuelve ambos eventos; una
cola parcial sin `\n` se trunca al abrir sin perder lo confirmado; una línea corrupta en medio
se salta con aviso y la consulta responde igual; retractar dos veces no escribe una segunda
línea; un ciclo de `superseded_by` se detecta.

**Las tres que no podían fallar**:

- Con el servicio caído, `recall.query` responde y **no abre un solo socket**.
- Dos afirmaciones en la misma respuesta con **edades distintas**, cada una de su propio
  `observed_at`, con `stale` calculado contra el umbral que pidió el llamante.
- Un `FakeClock` que salta **10 s hacia atrás** no produce una edad negativa. El reloj de pared
  y el monótono son variables separadas en el fake, que es la única forma de probarlo.

**De extremo a extremo, desde el tarball instalado**: medir → afirmar citando la medida →
romper el servicio → consultar (el registro **no sabe** que se rompió; entrega
`remeasure_with`) → seguirlo y encontrar el 500 como `ok: true` → retractar con motivo y
sustituir → `history` muestra `assert -> retract`, y la afirmación vieja sigue ahí.

**Auditoría de credenciales contra disco real**: la credencial llega **intacta** al servicio,
vuelve **redactada**, y una búsqueda en todos los ficheros del almacén da **cero**.

**Auditoría del contrato**: cero claves de juicio (`health`, `score`, `severity`, `passed`,
`summary`, `recommendation`) en los esquemas; cero tools prohibidas; `update`/`delete`
ausentes de la interfaz del almacén; cero puertos, rutas o nombres de servicio de ninguna app
en `src/`; el protocolo confinado a `src/protocol/` y `src/transport/`; una única rama sobre
el código de estado, y es mecánica (seguir una redirección cuando se pidió).

---

## 4. A5 — lo que falta, y es de quien lo consuma

El criterio de éxito del plan no es el número de tests. Es una frase:

> ¿Puede otro agente, que no ha visto este repositorio, verificar con esto una aplicación
> que nosotros no conocemos, en vez de hacerlo a mano?

**Queda aplazada, por decisión del propietario**: el servidor se mantiene libre de uso real
hasta que un consumidor lo pruebe desde su propio proyecto. Un primer intento contra una
aplicación local se detuvo porque la lista de comprobaciones que debía verificar no
existía; lo que sí produjo —dos candidatos de etapa B por uso real, `measure.tcp` y un
`body_head_bytes`— está en [hallazgos-primer-intento.md](hallazgos-primer-intento.md), y el
rodaje inicial contra puertos locales en [hallazgos-uso-real.md](hallazgos-uso-real.md).

Quien lo consuma tiene todo lo necesario en [USO.md](USO.md): el bloque de configuración,
los perfiles de red y las trampas conocidas.

Lo que ese agente debe anotar mientras trabaja, porque es el entregable de A5 y la entrada de
la etapa B — en [hallazgos-uso-real.md](hallazgos-uso-real.md):

- Qué comprobación **no** se pudo hacer con las seis tools, y qué habría hecho falta.
- Campos de la respuesta que **sobran** (ruido en el contexto) o que **faltan**.
- Descripciones de tool que el modelo **entendió mal**.
- Errores que no dicen qué hacer.
- Qué hubo que seguir haciendo **a mano**.

Si la verificación no se puede completar con el servidor, **eso no es un fracaso**: es el
resultado de la etapa, y el documento de hallazgos es el entregable.

---

## 5. Lo que deliberadamente NO se construyó

Está especificado y pospuesto a propósito. Entra cuando el uso lo pida, no antes.

| Pospuesto | Dónde está especificado | Entra cuando |
|---|---|---|
| `measure.diff` | [05 §4.4](v2/05-modulo-facts.md) | Haya que comparar dos medidas a ojo |
| `recall.supersede` (atómico) | [05 §6.3](v2/05-modulo-facts.md) | Una secuencia a medias haga daño real |
| `recall.export` | [05 §6.6](v2/05-modulo-facts.md) | Haga falta sacar el registro |
| Navegador (Playwright) | [05 §4.3](v2/05-modulo-facts.md) | Haya que abrir un panel y mirarlo |
| Índice y *group commit* | [04 §2.2, §3](v2/04-almacenamiento.md) | Una consulta real sea lenta. **Medir antes** |
| Rotación, GC, blobs | [04 §2.4, §4](v2/04-almacenamiento.md) | El almacén crezca de verdad |
| Transporte HTTP y autorización | [03 §7](v2/03-protocolo.md) | Etapa D |
| Monorepo y extracción del núcleo | [01](v2/01-arquitectura.md), [02](v2/02-nucleo-api.md) | Etapa D, tras un segundo dominio |

La duplicación que aparezca hasta entonces **es el dato** que dirá qué pertenece al núcleo.

---

## 6. Deuda conocida

- **`measure.ws` no valida `max_total_bytes` con la misma precisión que `max_messages`**: corta
  al superar el agregado, pero el mensaje que cruza el umbral se cuenta entero. Es honesto —se
  marca `messages_truncated`— pero no es un corte exacto al byte.
- ~~**El `LOCK` de instancia no está implementado.**~~ **Saldado (B0, 2026-09-22.)** Mi
  evaluación original —"en stdio el riesgo es bajo"— era errónea, y la corrección es suya:
  cada cliente MCP arranca su propio proceso, así que dos servidores sobre el mismo
  `PLINTH_DATA_DIR` no es un caso raro, es lo normal en cuanto haya dos aplicaciones
  conectadas. Y A5 es exactamente ese escenario. Implementado en
  [`src/store/instance-lock.ts`](../src/store/instance-lock.ts) con `O_CREAT|O_EXCL`, PID
  dentro y detección de lock rancio; un segundo proceso **no arranca** y dice qué hacer.
  7 comprobaciones, más una verificación con dos procesos reales.
- **Sin `.lock` por fichero.** La cola por flujo serializa dentro del proceso, y el `LOCK` de
  instancia garantiza que solo hay uno. Es el "cinturón y tirantes" de
  [04 §2.2](v2/04-almacenamiento.md) lo que falta, no la exclusión.
- ~~**Avisos de fin de línea CRLF en Windows.**~~ Resuelto: `.gitattributes` fija LF.

---

## 7. Revisión contra la especificación — 2026-09-22

Cuatro auditorías independientes contrastaron el código con los documentos 00 a 10, la
especificación v1 y los ADR. Lo que encontraron, y qué se hizo con cada cosa.

### Corregido

| Hallazgo | Ahora |
|---|---|
| **El perfil de red no se podía elegir**: el binario solo medía la propia máquina | `PLINTH_FACTS_NET_PROFILE` y `PLINTH_FACTS_ALLOW_HOSTS` ([`src/config.ts`](../src/config.ts)). Un valor inválido —o un comodín en la lista— detiene el arranque. El perfil activo va en `server/discover` |
| Las afirmaciones se escribían al disco **sin redactar** (02 §7) | `statement`, autor, descripción y URI de evidencia, motivo y autor de la retracción se redactan antes de escribir |
| Secretos en la *query* de una URL (`?token=`) llegaban al disco | Redactados por nombre de parámetro; el *userinfo* solo reemplaza `usuario:clave`, no la URL entera |
| `remeasure_with` podía reenviar marcadores de redacción | Deja fuera lo redactado con el grano más fino que conserva el resto, y lo nombra en `omitted` |
| El log de `stderr` no redactaba (06 §2) | Mensaje y campos pasan por la redacción |
| Una medida fallida no se podía citar (v1 §3, 05 §3) | Se guarda toda medida que llegó a observar; solo lo rechazado antes de mirar queda fuera |
| DNS sin *timeout*: una resolución colgada retenía la llamada (00, 03 §5.1) | La espera se corta al abortar la señal; y el núcleo deja de esperar a una tool que ignora su señal un segundo después |
| Apagado sin gracia (02 §9) | `drain()`: aborta lo que está en curso y espera hasta 5 s |
| Una petición cancelada seguía recibiendo respuesta (03 §6) | No se envía nada más de ella |
| Errores de transporte sin hora (03 §4, N1) | `-32700` y `-32603` llevan `observed_at` y `age_seconds` |
| `arguments` no-objeto era un error de tool (03 §4) | `-32602`, como pide `CallToolRequest` |
| `server/discover` anunciaba `resources` sin implementarlos | Retirado |
| Cursor de `recall.query` como desplazamiento decimal (04 §5) | Opaco, sobre una instantánea del registro y atado a los filtros; otro filtro es `INVALID_INPUT` |
| `recall.retract` y `recall.assert` descartaban avisos de integridad (04 §2.3) | Los propagan |
| `measure.ws` aceptaba `https://` y hablaba en claro al 443 | Cada tool acepta solo sus esquemas |
| Un cuerpo de texto salía etiquetado como JSON (05 §4.1) | Solo lo que la tool serializa lleva `application/json` |
| `realpath` solo en la raíz del proyecto (04 §1) | También en `logs/`; un enlace en lugar de un log se rechaza |
| Líneas del registro sin `body`, `id` o `at` pasaban la validación (04 §2.3) | Se saltan con `LOG_LINE_UNREADABLE` |
| `max_message_bytes` y `max_total_bytes` sin tope | 16 MiB y 64 MiB |
| El umbral `stale` no era configurable (05 §1) | `PLINTH_FACTS_DEFAULT_STALE_SECONDS` |
| El esquema normativo de `vendor/` no comprobaba nada | Un test tipado ata cada constante y clave `_meta` al esquema: una deriva rompe el `typecheck` |
| Comprobaciones de 07 solo en prosa | Tests: #10, #27, #28, #29, #41, #46, #50, #54, y la salida de cada tool contra su esquema. El test "recall abre cero sockets", que no podía fallar, ahora cuenta conexiones de verdad |
| Plan y estado atados a una aplicación concreta | Redactados en términos de cualquier consumidor |
| Licencia sin decidir | 0BSD, [ADR-0003](adr/0003-licencia-0bsd.md) |

### Divergencias deliberadas — el código manda, el documento se queda atrás

| Documento | Dice | El código hace, y por qué |
|---|---|---|
| 03 §1, §8.4 | Solo `2026-07-28`; `initialize` se rechaza | Ambas eras por conexión, `initialize` incluido: Claude Code no conectaba ([ADR-0004](adr/0004-hablar-tambien-la-era-de-sesion.md)) |
| 05 §4.1 | `body_format: json\|text\|base64\|blob` | `none` en lugar de `blob`: no hay almacén de blobs (pospuesto) y un cuerpo vacío necesita nombre |
| 05 §6.4 | `ref` con `{tool, http_status}` | `{tool, observed_at}`: vale para toda tool, no solo HTTP |
| 05 §6.5 | `remeasure_with` con URL y método | Todos los argumentos efectivos menos lo redactado, más `omitted` |
| 02 §3 | Cinco códigos de aviso | Doce; los nuevos nombran casos reales (`REDIRECT_NOT_FOLLOWED`, `OBSERVATION_NOT_RECORDED`, `WS_PROTOCOL_ERROR`…) |
| 02 §2 | `ToolError.channel`; `ctx.deadline`, `remainingMs`, `progress` | No existen: el canal lo decide el núcleo en un solo sitio, y ninguna tool necesitó el resto |
| 02 §7 | Límite de redacción con `[unredacted:omitted]` y aviso | `[redacted: depth limit]` sin aviso; falla cerrado, que es lo que importa |
| 02 §1 | `readOnlyHint` implica cero escrituras | `measure.*` lo declara y guarda la observación: la pista MCP habla del entorno, no del almacén propio |
| 03 §5.2 | `allowPorts`, `maxResponseBytes`, `connectTimeoutMs` en la política | Los topes los da cada llamada (`max_body_bytes`, `timeout_ms`), acotados por esquema |
| 05 §6.2 | `EVIDENCE_REQUIRED` | El esquema exige `minItems: 1` y responde `INVALID_INPUT` antes de llegar al handler |
| 06 §2 | Log con `t`, `lvl`, `req` y eventos estables | `{at, level, msg, fields}`; el formato del 06 es de la etapa D |

### Pendiente, con etapa asignada

- **Almacén de blobs** (04 §4): el plan A3 lo incluía; se pospone hasta que un cuerpo grande
  moleste de verdad, junto con rotación y GC.
- **`server.json`** de diagnóstico (04 §1) y el aviso en log al truncar una cola parcial.
- **Ficheros de proyecto de la etapa D**: `CHANGELOG` y *changesets*, plantillas de *issues*,
  `CODEOWNERS`, `dependabot`, CodeQL, guías. `SECURITY.md` y `CONTRIBUTING.md` ya existen.
- **Pruebas de propiedades** (07 §5) y **recursos abiertos tras abortar** (07 #19).
- **Umbrales de tiempo de 03 §8** (*discover* en < 5 ms): se comprueban con holgura, porque
  en CI compartida un umbral de milisegundos falla por ruido, no por regresión.
