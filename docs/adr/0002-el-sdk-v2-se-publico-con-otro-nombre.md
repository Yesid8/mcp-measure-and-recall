# ADR-0002 — El SDK de `2026-07-28` existe, y se publicó con otro nombre

**Estado**: aceptada, 2026-09-22 · **Sustituye a [ADR-0001](0001-implementar-protocolo-sin-sdk.md)
en su decisión, y confirma su método.** Reinstaura
[ADR-003](../v2/10-decisiones.md) como intención, con migración condicionada a medida.

---

## Contexto

ADR-0001 concluyó que ningún SDK de TypeScript habla `2026-07-28` y, en consecuencia,
implementó el protocolo contra el esquema normativo versionado en `vendor/`.

**Sus medidas eran correctas. Su conclusión no.** La causa es un error en el prompt de
arranque, no en la ejecución:

> `ARRANQUE.md`, etapa A1: *"Lo primero que haces, antes de escribir el adaptador:
> `npm install @modelcontextprotocol/sdk`"*

Ese es el paquete **v1**. Todo lo que ADR-0001 midió sobre él es cierto y sigue siéndolo:
`1.30.0` es su única versión, su único dist-tag es `latest`, declara
`LATEST_PROTOCOL_VERSION = '2025-11-25'`, y `server/discover`, `resultType` y
`subscriptions/listen` no existen en él.

Lo que el prompt le impidió encontrar es que **la v2 del SDK se publicó bajo nombres
nuevos**, abandonando el paquete monolítico:

| Paquete | dist-tags | Notas |
|---|---|---|
| `@modelcontextprotocol/sdk` | `latest: 1.30.0` | Línea **v1**. Habla `2025-11-25`. Es lo que ADR-0001 midió |
| `@modelcontextprotocol/server` | `latest: 2.0.0` | **Estable.** Deps: `@modelcontextprotocol/core@2.0.0`, `zod ^4.2.0`. Node ≥ 20. Exports: `.`, `./stdio`, `./validators/ajv`, `./validators/cf-worker` |
| `@modelcontextprotocol/client` | v2 | Contraparte cliente |
| `@modelcontextprotocol/core` | `2.0.0` | Tipos y protocolo compartidos |

La guía de migración oficial (`ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28`)
describe exactamente el modelo que el documento 03 especifica: `server/discover` en lugar
del handshake, construcción por petición sin estado de sesión, `requestState` opaco y
sellado con HMAC para MRTR, validación de salida contra `outputSchema`, y
`serveStdio(() => buildServer())`. Salieron primero como beta
(`npm install @modelcontextprotocol/server@beta`) junto con las betas de Python, Go y C#;
hoy `latest` ya es `2.0.0`.

Un detalle de la guía que conviene tener presente: *"Nothing in v2 puts a 2026-07-28 byte on
the wire by default"*. La revisión moderna es **opt-in explícito**, no el comportamiento por
defecto del paquete.

### Medidas sobre el artefacto instalado

Verificado el 2026-09-22 instalando `@modelcontextprotocol/server@2.0.0` y
`@modelcontextprotocol/client@2.0.0`, y leyendo el paquete, no la documentación. Esto es lo
que el *spike* de B1 hereda ya comprobado, para que no vuelva a arrancar sobre supuestos:

- Los tres paquetes existen en `latest: 2.0.0`. `server` exporta `.`, `./stdio`,
  `./validators/ajv` y `./validators/cf-worker`, como decía la guía.
- `./stdio` exporta `serveStdio(factory, options)` y `StdioServerTransport`. La **factoría**
  es la construcción por petición que exige un protocolo sin sesiones.
- El paquete modela la revisión de verdad, no solo la menciona: `ResultMetaObject` de
  `2026-07-28`, `server/discover`, `resultType` documentado como *"the
  protocol-revision-2026-07-28 wire discrimination field"*, y las deprecaciones de SEP-2577
  anotadas una por una.

**Confirmación del opt-in, y un matiz que importa.** Las constantes del paquete siguen
declarando la era anterior:

```
LATEST_PROTOCOL_VERSION            = '2025-11-25'
DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26'
```

Eso **no contradice** que soporte `2026-07-28`: describe el camino por defecto, que es
exactamente lo que advierte la guía. El SDK v2 soporta **ambas eras** y las discrimina en
tiempo de ejecución con `isLegacyRequest`, `classifyInboundRequest` y `legacyStatelessFallback`.
Leer solo esas constantes —el método que siguió ADR-0001 sobre el v1— habría llevado otra vez
a la conclusión equivocada. **En B1, la revisión se comprueba en el cable**: qué responde
`server/discover` y qué `resultType` sale, no qué dice una constante.

**Cuatro construcciones del documento 03 existen con otro nombre**, y conviene saberlo antes
de anotarlas como ausencias:

| Documento 03 | En el SDK v2 |
|---|---|
| `requestState` sellado con HMAC | `createRequestStateCodec` |
| Claves de `_meta` | `PROTOCOL_VERSION_META_KEY`, `CLIENT_CAPABILITIES_META_KEY`, `SERVER_INFO_META_KEY` |
| MRTR / `input_required` | `inputRequired`, `isInputRequiredResult` |
| `-32022` y `-32021` | `UnsupportedProtocolVersionError`, `MissingRequiredClientCapabilityError` |

Las tres claves de `_meta` coinciden **literalmente** con las que ya implementa
`src/protocol/jsonrpc.ts`, lo cual es una señal favorable sobre la fidelidad de la
implementación propia al esquema normativo.

**`ttlMs` / `cacheScope`: ver el apéndice al final de este documento.** Buscado por el
nombre correcto, el SDK **sí** los implementa; la nota anterior que los daba por "ausentes
por ese nombre" era un grep negativo tomado por conclusión.

## Decisión

**No se revierte nada ahora. Se condiciona la migración a una medida, y A5 va primero.**

1. **La implementación propia se queda, tal cual, hasta después de A5.** Funciona, tiene 93
   comprobaciones en verde y un recorrido de extremo a extremo desde el tarball. Detener el
   único hito que produce información real —verificar una aplicación real— para cambiar una capa
   que ya cumple sería repetir el error que ADR-018 vino a corregir.
2. **En la etapa B se hace un *spike* acotado**: sustituir el interior de `src/protocol/`
   por `@modelcontextprotocol/server@2.0.0`, con las 13 comprobaciones de
   [03 §8](../v2/03-protocolo.md) como criterio de aceptación, sin tocar una sola línea
   fuera de `src/protocol/` y `src/transport/`. Tiempo acotado; si se desborda, se para.
3. **El resultado decide, y ambos desenlaces son aceptables**:
   - Las 13 en verde ⇒ se adopta el SDK y se borra la implementación propia. Se recupera
     ADR-003 con su razonamiento entero: la próxima revisión del protocolo la absorbe un
     tercero.
   - El SDK no puede expresar algo que la especificación exige ⇒ se conserva la
     implementación propia, y **ese hallazgo es la justificación medida** que ADR-0001
     quería tener y no podía.
4. **`vendor/mcp-schema-2026-07-28.ts` se queda en cualquiera de los dos casos.** Como
   oráculo de conformidad tiene valor propio: si nuestros tipos —o los del SDK— se desvían
   de los normativos, el `typecheck` lo dice.

## Por qué no se migra inmediatamente

Porque no hay evidencia todavía de que el SDK v2 sea mejor **para este servidor**. Es
estable desde hace poco, la guía advierte de que la superficie pública pudo cambiar entre
las betas y la estable, y lo que tenemos funciona y está probado. La diferencia entre ADR-003
y ADR-0001 no es quién tiene razón en abstracto: es cuánto cuesta mantener ~500 líneas de
protocolo propio frente a cuánto cuesta depender de un paquete de 2.0.0 recién estabilizado.
Eso se mide en la etapa B, no se debate ahora.

## Lo que este ADR no cambia

ADR-0001 acertó en el método y esa parte se conserva entera: comprobó antes de escribir,
midió el artefacto instalado en vez de creerse la documentación, escaló según lo ordenado, y
dejó escrita la reversibilidad. **La frontera de `src/protocol/` es lo que hace barato este
ADR**, y es exactamente lo que ADR-003 y la "excepción única" de ADR-018 querían comprar. Se
ha cobrado la póliza antes de lo previsto.

Siguen en pie sin cambios: ADR-004 (solo la revisión moderna), ADR-010 (handles en vez de
sesiones), ADR-018 (construir `facts` primero) y la excepción de protocolo.

## Corrección aguas arriba

`docs/ARRANQUE.md` queda corregido para nombrar los tres paquetes v2 y advertir de que
`@modelcontextprotocol/sdk` es la línea v1. El fallo fue del prompt, y dejarlo sin arreglar
repetiría el error en la siguiente etapa que instale algo.

**Lección para futuros arranques**: fijar un nombre de paquete en un prompt es fijar una
suposición. Si se nombra, se nombra con la comprobación al lado: *"verifica que ese paquete
es el que habla la revisión; si el ecosistema se ha reorganizado, busca antes de concluir
que no existe"*.

---

## Apéndice — `ttlMs` / `cacheScope`: resuelto, y es normativo

Añadido el 2026-09-22, tras la verificación de los paquetes v2 contra el artefacto
instalado. Era lo único que quedaba sin comprobar.

**No es nomenclatura nuestra: es obligatorio, y con más alcance del que decía el documento
03.** La fuente es
[server/utilities/caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)
(SEP-2549):

> *"Servers **MUST** include caching hints on results with `resultType: "complete"`
> returned by the following operations: `server/discover`, `tools/list`, `prompts/list`,
> `resources/list`, `resources/templates/list`, `resources/read`."*

Tres consecuencias operativas:

1. **Buscar `CacheableResult`, no `ttlMs`.** La revisión introduce los dos campos a través
   de una interfaz con ese nombre. Un `grep ttlMs` sobre el paquete puede no encontrarlos si
   el SDK los modela como tipo compuesto y no como propiedades sueltas. Este es el mismo
   patrón de error que ADR-0001: buscar el nombre que uno espera en vez de el que el
   ecosistema usó.
2. **Si tras buscar `CacheableResult` sigue sin aparecer, es un hueco real del SDK** — y
   entonces es exactamente la justificación medida que este ADR pedía para conservar la
   implementación propia. Ese hallazgo, con la cita normativa al lado, vale más que las
   otras doce comprobaciones de B1 juntas.
3. **Hay un incumplimiento nuestro que corregir antes de B1.** El documento 03 §2.2 solo
   exigía las sugerencias en `tools/list`. La norma las exige también en
   **`server/discover`**. Si la implementación de la etapa A siguió el documento al pie de
   la letra, `server/discover` no las lleva. El documento 03 queda corregido; la
   comprobación 5 del [03 §8](../v2/03-protocolo.md) ahora cubre ambos.

Y cuatro detalles que es fácil incumplir sin darse cuenta, ahora escritos en
[03 §2.2](../v2/03-protocolo.md): `ttlMs` debe ser `>= 0`; los resultados
`input_required` no llevan sugerencias y un reintento MRTR no se puede cachear; cada página
lleva su propio `ttlMs` pero todas comparten `cacheScope`; y `"public"` puede compartirse
entre contextos de autorización distintos, así que no es un control de acceso.

### Resultado de las tres consecuencias — verificado el 2026-09-22

**(1) y (2): no es un hueco del SDK.** Buscando `CacheableResult` —no `ttlMs`— aparecen de
inmediato en `@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts`:

```ts
interface CacheHint { ttlMs?: number; cacheScope?: CacheScope }
type CacheScope = 'public' | 'private'

declare const CACHEABLE_RESULT_METHODS: readonly [
  "tools/list", "prompts/list", "resources/list",
  "resources/templates/list", "resources/read", "server/discover"
]
```

Esa lista es **exactamente** la de SEP-2549, `server/discover` incluido, y el SDK la declara
**cerrada**: *"no other operation's result ever receives cache fields from the SDK"*.
Resuelve los valores en el *encode seam* consciente de la era, con precedencia campo a
campo —lo que devolvió el handler, luego la sugerencia configurada, luego el defecto—, y
transporta la sugerencia en una propiedad con clave de símbolo, que nunca se serializa, de
modo que una respuesta de la era 2025 no cambia de forma.

**Un detalle que B1 debe vigilar**: el defecto del SDK es `{ ttlMs: 0, cacheScope: 'private' }`,
y `0` significa **"inmediatamente rancio"**. Adoptar el SDK sin configurar `cacheHints`
cambiaría la sugerencia de 5 minutos a cero — un cambio observable en el cable que la
comprobación 5 **no** detectaría, porque `0 >= 0` la satisface. Hay que fijar el valor
explícitamente al migrar.

**(3): el incumplimiento estaba, y ya está corregido.** La etapa A había seguido el
documento al pie de la letra, así que `server/discover` salía sin sugerencias de caché —
fuera de norma. Corregido en `src/protocol/server.ts`: las sugerencias las produce ahora una
sola función `cacheHints()`, usada por `server/discover` y por `tools/list`, con las cuatro
reglas escritas como comentario en el punto donde alguien las rompería. Se añadieron
comprobaciones que recorren **ambos** métodos, verifican que `ttlMs` es entero `>= 0`, que
el `cacheScope` es `"private"` —el conjunto de tools puede variar con la autorización, así
que `"public"` sería incorrecto— y que `tools/call` **no** las lleva, por estar fuera de la
lista cerrada. El *spike* de B1 compara ya dos implementaciones conformes.

### La lección, por tercera vez

ADR-0001 buscó la revisión en el paquete que nombraba el prompt. Esta nota buscó `ttlMs` en
vez de `CacheableResult`. El patrón es el mismo: **buscar el nombre que uno espera en lugar
del que usó el ecosistema, y tomar un grep negativo por una conclusión.** Un grep negativo
es una pregunta. Antes de escribir "no existe", hay que buscar el concepto por el nombre de
su interfaz, por el de su SEP y por el de su tipo.

## Apéndice — sobre el `LOCK` de B0

La implementación —`O_CREAT|O_EXCL` con el PID dentro, lock rancio por
`process.kill(pid, 0)`, y `release` que solo borra si sigue siendo suyo— es la correcta y
resuelve el escenario que la motivaba.

Queda un borde conocido, y basta con dejarlo escrito: **el PID se reutiliza**. Tras un
reinicio, o tras dar la vuelta el contador de PID, `process.kill(pid, 0)` puede devolver
cierto para un proceso que no es el nuestro, y el lock rancio se toma por vivo — el servidor
se niega a arrancar sin motivo. Es infrecuente y el mensaje de error nombra el PID, así que
es diagnosticable a mano. Si alguna vez molesta, el arreglo barato es guardar en el lock un
identificador de instancia aleatorio junto al PID y la hora de arranque, y considerarlo
vivo solo si los tres concuerdan.
