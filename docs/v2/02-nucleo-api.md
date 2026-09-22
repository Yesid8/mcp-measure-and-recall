# API del núcleo

> Documento 02 de 11 · Plinth v2.0 · Paquete `@plinth/core`

Este documento es la superficie pública. Lo que no aparece aquí es privado y puede cambiar
sin aviso; lo que aparece está bajo semver desde la 1.0.0.

---

## 1. `Result`: los fallos esperados son valores

```ts
export type Result<T, E = ToolError> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E }

export const Ok:  <T>(value: T) => Result<T, never>
export const Err: <E extends ToolError>(error: E) => Result<never, E>
```

Un handler devuelve `Result`. **Lanzar es un bug**, y el núcleo lo trata como tal: lo
registra con traza completa, incrementa `plinth.tool.panic`, y responde `-32603 Internal
error` sin filtrar detalle al cliente.

Helpers mínimos, sin biblioteca de mónadas:

```ts
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T }
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T
export function mapOk<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E>
/** Ejecuta una promesa y convierte un throw en Err(code). Para envolver E/S de terceros. */
export function attempt<T>(
  fn: () => Promise<T>,
  onThrow: (e: unknown) => ToolError,
): Promise<Result<T>>
```

### `ToolError`

```ts
export interface ToolError {
  /** SCREAMING_SNAKE_CASE, estable, parte del contrato público. */
  readonly code: string
  /** Qué falló, mecánicamente. Nunca qué significa ni qué hacer al respecto. */
  readonly message: string
  /** Datos estructurados del fallo. Se serializa tal cual al cliente. */
  readonly detail?: Readonly<Record<string, unknown>>
  /** Causa original. Va al log, NUNCA al cliente. */
  readonly cause?: unknown
  /**
   * Cómo debe viajar al cliente. Por defecto 'tool': llega como isError:true,
   * que es lo que permite al modelo corregirse. Ver 03-protocolo §4.
   */
  readonly channel?: 'tool' | 'protocol'
}
```

Códigos base del núcleo, disponibles para todos los módulos:

| `code` | Cuándo | Canal |
|---|---|---|
| `INVALID_PROJECT` | `project` vacío o inválido tras normalizar | tool |
| `INVALID_INPUT` | La entrada no valida contra el esquema | tool |
| `HOST_NOT_ALLOWED` | Destino de red negado por la política | tool |
| `PATH_NOT_ALLOWED` | Ruta fuera de las raíces concedidas | tool |
| `PROCESS_NOT_ALLOWED` | Binario no concedido por la política | tool |
| `TIMEOUT` | Se agotó el `deadline` de la llamada | tool |
| `CANCELLED` | El cliente canceló (cerró el stream) | tool |
| `RESOURCE_EXHAUSTED` | Cola de concurrencia llena para esa clase | tool |
| `HANDLE_NOT_FOUND` | Handle inexistente, caducado o de otro proyecto | tool |
| `STORAGE_ERROR` | Fallo de E/S en el directorio de datos | tool |
| `LOCK_TIMEOUT` | No se obtuvo el lock de escritura a tiempo | tool |
| `UNSUPPORTED` | Capacidad deshabilitada en tiempo de ejecución por configuración | tool |
| `INTERNAL` | Bug. Solo lo emite el núcleo al capturar un throw | protocol |

Un módulo registra sus propios códigos en su manifiesto; el núcleo falla al arrancar si un
módulo reutiliza un código base con otro significado.

---

## 2. `defineTool`

```ts
export interface ToolDefinition<I, O> {
  /** Sin prefijo de módulo. [a-z0-9_.-]{1,96}. El núcleo antepone `${module.id}.` */
  readonly name: string
  /** Nombre legible para interfaces. */
  readonly title: string
  /**
   * Qué hace, en imperativo y en inglés. Es prompt: el modelo decide con esto.
   * Debe decir qué NO hace y qué handles produce o consume.
   */
  readonly description: string

  readonly input: z.ZodType<I>
  readonly output: z.ZodType<O>

  /** Pistas del protocolo. Ver §2.2. */
  readonly annotations?: ToolAnnotations
  /** Iconos opcionales (MCP `icons`). src DEBE ser https: o data:. */
  readonly icons?: readonly Icon[]

  /** Clase de concurrencia. Por defecto 'cpu'. Ver §5. */
  readonly concurrency?: ConcurrencyClass
  /** Presupuesto de latencia y tope duro. */
  readonly timeout?: { readonly defaultMs: number; readonly maxMs: number }
  /** Presupuesto p99 para el aviso de rendimiento. Ver 06. */
  readonly budgetMs?: number

  readonly handler: (input: I, ctx: ToolContext) => Promise<Result<O>>
}

export function defineTool<I, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O>
```

`defineTool` no hace magia: valida la forma en tiempo de compilación, congela el objeto y
lo devuelve. Existe para que el tipado infiera `I` y `O` desde los esquemas sin anotarlos a
mano.

### 2.1 Reglas sobre los esquemas

- `input` **debe** ser un `z.object(...)`. El protocolo exige que `inputSchema` sea un
  objeto JSON Schema; una tool sin parámetros usa `z.object({}).strict()`, que produce
  `{"type":"object","additionalProperties":false}`.
- `output` **debe** describir solo el `data` de dominio. La envoltura (`observed_at`,
  `age_seconds`, `project`, …) la añade el núcleo, y el `outputSchema` que ve el cliente es
  la composición de ambas, generada automáticamente.
- Todo campo lleva `.describe(...)`. La CI falla si un campo de un esquema público no tiene
  descripción: el cliente y el modelo leen eso.
- El JSON Schema se genera con `z.toJSONSchema(schema, { target: 'draft-2020-12' })` y se
  cachea al arrancar. `tools/list` no serializa nada en caliente.

### 2.2 `ToolAnnotations`

```ts
export interface ToolAnnotations {
  /** No modifica nada observable. */ readonly readOnlyHint?: boolean
  /** Puede destruir o sobrescribir. */ readonly destructiveHint?: boolean
  /** Repetirla con los mismos argumentos no añade efecto. */ readonly idempotentHint?: boolean
  /** Toca un mundo abierto (la red) y no solo datos propios. */ readonly openWorldHint?: boolean
}
```

Son **pistas para el cliente, no garantías**, y la especificación obliga al cliente a
tratarlas como no confiables. Aun así Plinth las usa internamente: el kit de conformidad
verifica que una tool anotada `readOnlyHint` no llame a ninguna API de escritura del
almacén, que una anotada `openWorldHint: false` no obtenga permiso de red, y que una
anotada `idempotentHint` devuelva el mismo `data` ante la misma entrada, salvo en los
campos de tiempo. La anotación es,
dentro de Plinth, un contrato comprobable.

---

## 3. `ToolContext`

Todo lo que un handler puede hacer llega por aquí. Un handler que importe `node:fs`,
`node:net`, `undici` o `Date.now()` directamente es un fallo de revisión y el linter lo
detecta.

```ts
export interface ToolContext {
  /** Cancelación: unión de la del transporte y la del deadline. */
  readonly signal: AbortSignal
  /** Instante monótono (ms) en que expira la llamada. */
  readonly deadline: number
  /** Milisegundos que quedan. Calcularlo a mano es un error frecuente. */
  remainingMs(): number

  readonly clock: Clock
  readonly project: string            // ya normalizado
  readonly requestId: string          // r_<ULID>
  readonly client: { name?: string; version?: string }

  readonly policy: Policy
  readonly storage: StorageScope      // ya acotado al proyecto
  readonly handles: HandleStore       // ver §6
  readonly log: Logger
  readonly trace: Tracer
  readonly config: unknown            // la config del módulo, ya validada

  /** Emite notifications/progress si el cliente la pidió; no-op si no. */
  progress(done: number, total?: number, message?: string): void
}
```

### `Clock`

```ts
export interface Clock {
  /** Reloj de pared. Para `observed_at`. ISO 8601 con offset. */
  now(): Date
  /** Reloj monótono en ms. Para duraciones y edades. Inmune a saltos de NTP. */
  monotonic(): number
  /** Espera cancelable. Nunca usar setTimeout suelto. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}
```

El reloj se inyecta. En los tests es un `FakeClock` de `@plinth/testing` y por eso la suite
de conformidad puede comprobar `age_seconds` sin esperas reales y sin *flakiness*.

> **Por qué `age_seconds` sale del reloj monótono.** Restar dos `Date` da resultados
> absurdos si el reloj del sistema salta (NTP, suspensión, contenedor que arranca con la
> hora mal). Un `age_seconds` negativo en una respuesta destruye la única regla que hace
> valioso el servidor. El núcleo guarda, junto a cada `observed_at`, el instante monótono
> correspondiente, y la edad se calcula sobre ese. Para datos leídos de disco — donde el
> monótono de la escritura ya no existe — la edad sale de la diferencia de relojes de
> pared, y el núcleo la marca con `age_basis: "wall"` frente a `"monotonic"`, para que la
> diferencia sea visible y no supuesta.

---

## 4. La envoltura de salida

Todas las tools de Plinth devuelven la misma envoltura. El núcleo la construye; el handler
solo aporta `data`.

```ts
export interface Envelope<T> {
  /** o_<ULID>. Identificador citable de esta observación. */
  readonly observation_id: string
  /** r_<ULID>. La petición que la produjo. Se persiste: es lo que hace posible `plinth replay`. */
  readonly request_id: string
  /** Nombre completo de la tool: "facts.measure.http". */
  readonly tool: string
  /** El project ya normalizado. */
  readonly project: string
  /** Los argumentos EFECTIVOS: tras defaults, normalización y redacción. */
  readonly target: Readonly<Record<string, unknown>>

  readonly observed_at: string        // ISO 8601 con offset
  readonly age_seconds: number
  readonly age_basis: 'monotonic' | 'wall'
  readonly duration_ms: number

  /**
   * "La observación se pudo tomar". NO es un juicio sobre lo observado.
   * Un HTTP 500 recibido limpiamente es ok: true con data.http_status === 500.
   *
   * SE DERIVA, nunca se pasa: `ok === (error === null)`, y el núcleo lo calcula.
   * Un handler que pudiera fijarlo por su cuenta es exactamente como `ok` empieza a
   * significar "el servicio observado está bien", que es lo único que no puede significar.
   */
  readonly ok: boolean
  readonly error: { code: string; message: string; detail?: unknown } | null

  readonly data: T | null
  /** Avisos no fatales: cuerpo truncado, línea de log ilegible, etc. */
  readonly warnings: readonly Warning[]
}
```

`target` es lo que hay que repetir para volver a observar igual. Se persiste con los
secretos ya redactados (§7).

`warnings` sustituye a la tentación de usar `error` para cosas no fatales:

```ts
export interface Warning {
  readonly code: string      // 'BODY_TRUNCATED' | 'BODY_CONTENT_TYPE_MISMATCH' |
                             // 'RESULT_LINKED' | 'LOG_LINE_UNREADABLE' | 'LOG_SEQ_GAP'
  readonly message: string
  readonly detail?: Readonly<Record<string, unknown>>
}
```

---

## 5. Concurrencia y límites

```ts
export type ConcurrencyClass = 'cpu' | 'net' | 'disk' | 'browser' | string
```

Cada clase tiene un semáforo con un máximo de permisos en vuelo y una cola acotada. Al
arrancar:

```ts
createServer({
  concurrency: {
    cpu:     { max: availableParallelism(), queue: 256 },
    net:     { max: 64,  queue: 512 },
    disk:    { max: 8,   queue: 512 },
    browser: { max: 2,   queue: 16  },
  },
})
```

Cuando la cola de una clase está llena, la llamada falla **inmediatamente** con
`RESOURCE_EXHAUSTED` y el `detail` dice cuántas hay en vuelo y cuántas en cola. No se
encola indefinidamente: una cola infinita convierte una sobrecarga en un timeout del
cliente diez minutos después, que es peor que un no rotundo.

El semáforo es propio (~60 líneas, sin dependencia), FIFO, y libera el permiso en `finally`
incluso si el handler lanza.

---

## 6. Handles: estado entre llamadas sin sesiones

La revisión MCP 2026-07-28 **elimina las sesiones del protocolo**. No existe estado por
conexión. Lo que necesite durar entre llamadas se referencia con un identificador explícito
que el cliente arrastra como argumento.

El núcleo da la pieza completa, para que ningún módulo la reinvente mal:

```ts
export interface HandleStore {
  create<T>(kind: string, value: T, opts: { ttlMs: number }): Promise<string>
  get<T>(kind: string, id: string): Promise<Result<T>>     // Err(HANDLE_NOT_FOUND)
  touch(kind: string, id: string): Promise<void>           // renueva el TTL
  release(kind: string, id: string): Promise<void>
}
```

Garantías:

- El identificador es opaco, de 26 caracteres de entropía ULID + 128 bits aleatorios, con
  prefijo por `kind`.
- Está **atado al proyecto**: `get` desde otro proyecto devuelve `HANDLE_NOT_FOUND`, no un
  error distinto, para no filtrar existencia.
- En transporte HTTP está además atado a la identidad autorizada de la petición.
- Caduca. El barrido es perezoso, en el acceso, más un barrido periódico.
- Un handle caducado produce un *tool execution error* con un mensaje que dice cómo crear
  uno nuevo — que es exactamente lo que la especificación recomienda para que el modelo se
  recupere solo.

**Obligación documental**: la `description` de la tool que crea un handle debe decir cuánto
vive ("browser contexts expire after 10 minutes of inactivity"), porque el modelo lo lee
antes de decidir crearlo.

---

## 7. Redacción de secretos

Un servidor que guarda peticiones con cabeceras dentro es un almacén de credenciales por
accidente. El núcleo redacta en un único punto —la construcción de la envoltura— y todo
módulo lo hereda.

**La redacción cubre `target` y `data`, en ambos sentidos.** Una petición lleva credenciales
hacia fuera (`authorization`), y una respuesta las trae hacia dentro (`set-cookie`). La
primera implementación solo cubría `target`, y un test encontró un `set-cookie` llegando en
claro al cliente y al disco. Media redacción es cero redacción.

```ts
export interface RedactionPolicy {
  /** Nombres de cabecera/campo cuyo valor se sustituye siempre. */
  readonly keys: readonly string[]
  /** Patrones aplicados a valores de texto en cualquier posición. */
  readonly patterns: readonly RegExp[]
  /** Máximo de bytes de contexto que se conservan alrededor. */
  readonly keepBytes: number
}
```

Por defecto:

- **Claves** (comparación sin distinguir mayúsculas): `authorization`, `proxy-authorization`,
  `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `api-key`, `apikey`, `token`,
  `access_token`, `refresh_token`, `id_token`, `password`, `secret`, `private_key`,
  `client_secret`, `session`, `sid`.
- **Patrones**: `Bearer <token>`, JWT (`eyJ[A-Za-z0-9_-]{10,}\.…`), claves de formato común
  (`sk-`, `ghp_`, `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`), URL con userinfo
  (`scheme://user:pass@`), y bloques PEM.

El valor redactado es `"[redacted:<n> bytes]"`, que conserva la longitud —útil para
diagnosticar— sin conservar el secreto.

Reglas:

1. Los valores se envían **íntegros** al destino y se redactan solo de camino a la salida y
   al disco.
2. La redacción se aplica **antes** de persistir, nunca después. No hay una ventana en la
   que el secreto esté en el fichero.
3. **Todo límite de la redacción falla cerrado.** El recorrido tiene topes —profundidad,
   número de nodos, tiempo— porque un objeto hostil puede ser inmenso. Al alcanzar
   cualquiera de ellos, lo que queda sin inspeccionar **se sustituye entero** por
   `"[unredacted:omitted]"` y se emite un `warning`; no se emite en claro. Un filtro de
   seguridad que deja pasar lo que no pudo mirar no es un filtro: es un filtro con una
   puerta, y la puerta está justo donde un atacante pondrá el secreto. La misma regla vale
   para el truncado de cuerpos y para el umbral de blobs.
4. `@plinth/conformance` incluye un test que hace una llamada con `Authorization` y luego
   busca el valor en claro en **todos** los ficheros del almacén. Debe dar cero. Y otro que
   lo repite con el secreto **más allá** del límite de profundidad.

---

## 8. `defineModule` y `createServer`

```ts
export interface Module<C = unknown> {
  readonly id: string                    // [a-z][a-z0-9-]{1,31}
  readonly version: string
  readonly description: string
  /** Activa las reglas F1 y F2. Ver 00-contrato §3. */
  readonly policy?: 'factual'
  readonly idPrefixes?: readonly string[]
  readonly errorCodes?: readonly string[]
  readonly config: z.ZodType<C>
  readonly tools: readonly ToolDefinition<any, any>[]
  readonly resources?: readonly ResourceDefinition[]
  /** Recursos caros (pool de navegadores, handles de fichero). */
  init?(ctx: ModuleContext<C>): Promise<ModuleHandle>
}

export interface ModuleHandle { dispose(): Promise<void> }

export function defineModule<C>(m: Module<C>): (config?: Partial<C> & { namespace?: string }) => MountedModule
```

```ts
export function createServer(opts: {
  name: string
  version: string
  modules: readonly MountedModule[]
  policy: PolicyConfig
  concurrency?: Partial<Record<ConcurrencyClass, { max: number; queue: number }>>
  storage?: { dataDir: string }
  observability?: { level?: LogLevel; otel?: boolean; budgets?: 'warn' | 'error' | 'off' }
  /** Solo dev/test: valida cada salida contra su outputSchema. */
  validateOutput?: boolean
}): Server

export interface Server {
  listen(transport: Transport): Promise<void>
  /** Cierra transportes, espera a las llamadas en vuelo (con tope) y libera módulos. */
  close(opts?: { graceMs?: number }): Promise<void>
  /** Para tests y para el kit de conformidad: invoca sin transporte. */
  call(tool: string, args: unknown, opts?: CallOptions): Promise<Envelope<unknown>>
}
```

### Validaciones al arrancar — falla pronto, falla ruidoso

`createServer` lanza (no devuelve `Result`: esto es configuración, no operación) si:

1. Dos tools resuelven al mismo nombre completo.
2. Dos módulos reclaman el mismo prefijo de identificador o el mismo código de error.
3. Un esquema no genera JSON Schema 2020-12 válido.
4. Un campo público carece de `.describe()`.
5. Un módulo `factual` tiene una clave prohibida por F2 sin excepción declarada.
6. Falta una variable de entorno obligatoria de la configuración de algún módulo.
7. La política concede `net` a un módulo cuyas tools están todas anotadas
   `openWorldHint: false`, o al revés.

---

## 9. Apagado ordenado

```
SIGINT / SIGTERM / stdin cerrado (stdio)
  → el transporte deja de aceptar peticiones nuevas
  → se abortan los signals de las llamadas en vuelo con grace (por defecto 5 s)
  → se espera a que resuelvan; las que no, se registran
  → el almacén hace flush del buffer de group commit y fsync
  → cada módulo ejecuta dispose() en orden inverso de montaje
  → se cierran los exportadores de OTel
  → process.exit(0)
```

Un `dispose()` que tarde más que el grace se registra y se abandona; el proceso no se
queda colgado. Perder un navegador sin cerrar es un problema menor; no terminar nunca es
uno mayor.
