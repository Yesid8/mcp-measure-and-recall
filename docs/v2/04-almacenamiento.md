# Almacenamiento

> Documento 04 de 11 · Plinth v2.0 · Paquete `@plinth/storage`

Un log de eventos append-only, un índice derivado y un almacén de blobs por contenido.
Genérico y sin dominio: el módulo facts guarda afirmaciones, un módulo Gantt guardaría
revisiones de plan, un simulador guardaría trazas. Las tres cosas son lo mismo.

---

## 1. Disposición en disco

```
$PLINTH_DATA_DIR/                          # por defecto ~/.plinth
├── server.json                            # config efectiva, para diagnóstico. No es fuente de verdad
├── LOCK                                   # lock de instancia: un proceso por directorio de datos
└── projects/
    └── <project-normalizado>/
        ├── logs/
        │   ├── claims.jsonl               # flujo "claims" del módulo facts
        │   ├── claims.jsonl.lock
        │   ├── claims.idx                 # checkpoint del índice. DERIVADO: borrable
        │   ├── observations.jsonl         # búfer rotativo de observaciones
        │   ├── observations.jsonl.1       # segmentos rotados
        │   └── plans.jsonl                # otro módulo, otro flujo. Mismo mecanismo
        └── blobs/
            ├── sha256/a1/b2/a1b2c3….bin
            └── sha256/a1/b2/a1b2c3….meta.json
```

Reglas de ruta, verificadas en cada acceso:

1. El nombre de proyecto ya viene normalizado y no puede contener separadores.
2. Toda ruta se construye con `path.join` desde la raíz y luego se comprueba que
   `path.resolve(p).startsWith(root + sep)`. Además se resuelve con `fs.realpath` para que
   un enlace simbólico no escape.
3. Cualquier ruta que no supere la comprobación es `PATH_NOT_ALLOWED`, nunca un acceso.
   `STORAGE_ERROR` queda para los fallos de E/S reales.
4. El proceso nunca escribe fuera de `$PLINTH_DATA_DIR`.

El `LOCK` de instancia evita que dos procesos compartan directorio de datos. Si está
tomado por un PID vivo, el arranque falla con un mensaje que lo nombra. Si el PID no
existe, el lock es rancio y se toma.

---

## 2. El log de eventos

### 2.1 Formato de línea

Una línea = un evento = un objeto JSON en una sola línea terminada en `\n`.

```jsonl
{"seq":1,"id":"e_01K5…","at":"2026-09-22T10:14:07.005+02:00","op":"assert","key":"c_01K5…","body":{…}}
{"seq":2,"id":"e_01K5…","at":"2026-09-22T11:02:41.118+02:00","op":"retract","key":"c_01K5…","body":{…}}
```

| Campo | Papel |
|---|---|
| `seq` | Entero monótono desde 1 dentro del flujo. Es el ancla de la paginación |
| `id` | `e_<ULID>` del evento |
| `at` | Reloj de pared en el momento de escribir |
| `op` | Verbo del dominio. El almacén no lo interpreta |
| `key` | Entidad a la que afecta. Reproducir los eventos de una `key` da su estado |
| `body` | Carga útil, opaca para el almacén, validada por el módulo |

El almacén **no conoce `op`**. Un flujo se declara con un esquema zod de `body` y una
función de reducción; `@plinth/storage` solo garantiza orden, durabilidad e integridad.

### 2.2 Escritura: durabilidad con *group commit*

El punto débil de la v1: `fsync` por línea, con un lock de fichero y 5 s de timeout. Con
carga concurrente eso son ~2–10 ms por escritura serializados, y el lock se convierte en el
cuello de botella.

v2:

```
append(event)
  ├─ Serializa a JSON. Rechaza si contiene \n sin escapar (imposible con JSON.stringify,
  │  pero se comprueba: una línea partida rompe el fichero para siempre).
  ├─ Encola en el buffer del flujo y devuelve una promesa.
  ├─ Si no hay commit en vuelo, programa uno en el siguiente tick (o al llegar a
  │  maxBatchBytes = 256 KiB, o a maxBatchDelay = 2 ms).
  └─ El commit:
        write(fd, concatenación del lote)     ← una sola llamada
        fdatasync(fd)                          ← un solo fsync para todo el lote
        resuelve TODAS las promesas del lote
```

Así, N escrituras concurrentes cuestan **un** `fsync`, y una escritura aislada cuesta lo
mismo que antes más 0–2 ms. La durabilidad no se relaja: nadie recibe `Ok` antes de que su
byte esté en disco.

Modos, configurables por flujo:

| Modo | `fsync` | Cuándo |
|---|---|---|
| `durable` (defecto) | Por lote, antes de resolver | Registros que no se pueden perder |
| `batched` | Por lote, cada ≤ 50 ms | Trazas de alto volumen. Se pierde ≤ 50 ms al caer |
| `none` | Nunca explícito | Solo en tests |

Exclusión mutua:

- **Dentro del proceso**: una única cola por flujo. No hay carrera; no hace falta lock.
  **La cola debe existir antes de que se acepte el primer `append`.** Si abrir un proyecto
  es asíncrono y dos llamadas concurrentes pueden entrar mientras se abre, ambas leen el
  mismo `seq` final y escriben con él. La apertura se memoiza por *(proyecto, flujo)* —se
  guarda la **promesa**, no el resultado—, de modo que la segunda llamada espera a la
  primera en vez de repetirla. Un `seq` duplicado rompe la paginación por cursor y el
  índice a la vez, así que la propiedad se garantiza por construcción y el test solo la
  confirma.
- **Entre procesos**: el `LOCK` de instancia ya garantiza un proceso por directorio de
  datos. El `.lock` por fichero se mantiene como cinturón y tirantes (`O_CREAT|O_EXCL` +
  PID + detección de rancio), con `LOCK_TIMEOUT` a los 5 s.

### 2.3 Lectura y recuperación de fallos

Un `fsync` puede cortarse a mitad de un fallo de energía. Consecuencia: la **última** línea
puede estar incompleta. Nunca una del medio, porque las escrituras están serializadas y son
secuenciales.

Al abrir un flujo:

```
 1. Leer del final hacia atrás hasta el último \n.
 2. Si hay bytes tras el último \n → cola parcial:
      - se trunca el fichero a esa posición (es la ÚNICA escritura destructiva que
        Plinth hace, y solo sobre una línea que nunca fue confirmada a nadie);
      - se registra a nivel warn con los bytes descartados.
 3. Escanear hacia delante desde el checkpoint del índice, validando:
      - JSON parseable
      - `seq` consecutivo
      - `body` conforme al esquema del flujo
 4. Una línea que falle cualquiera de las tres se SALTA, se cuenta, y produce un
    `warning` con código `LOG_LINE_UNREADABLE` en toda respuesta que lea ese flujo.
    NUNCA se repara reescribiendo.
 5. Un hueco en `seq` es un `warning` `LOG_SEQ_GAP`, no un fallo: el fichero sigue
    siendo la mejor fuente disponible y ocultar el hueco sería peor.
```

### 2.4 Rotación

Los flujos de registro (`claims`) **no rotan nunca**. Ese es el contrato.

Los flujos de volumen (`observations`, trazas) rotan por número de eventos y por tamaño:
`observations.jsonl` → `observations.jsonl.1` → … y se descartan los segmentos más viejos
al superar `retention`. Rotar no pierde nada citable, porque **la evidencia citada se
incrusta en el registro en el momento de citarla** (ver [05-modulo-facts §5](05-modulo-facts.md)).

Rotación atómica: `rename` del actual a `.1` con el fichero cerrado, apertura de uno nuevo,
todo dentro de la cola del flujo. Un lector concurrente que tenga abierto el fd viejo
termina de leerlo sin error.

---

## 3. El índice

Consultar `claims.jsonl` linealmente es O(n) por consulta. Con 100 000 afirmaciones, una
consulta con filtro de texto son decenas de milisegundos de CPU y megabytes de lectura,
cada vez.

### 3.1 Qué es

Una estructura en memoria, **derivada al cien por cien**, con un checkpoint en disco para
no reconstruirla en cada arranque:

```ts
interface LogIndex {
  bySeq:     Uint32Array            // seq → offset de byte
  byKey:     Map<string, number[]>  // key → seqs de sus eventos, en orden
  current:   Map<string, Snapshot>  // key → estado reducido actual
  byTag:     Map<string, Set<string>>   // tag → keys
  byAuthor:  Map<string, Set<string>>
  timeline:  Float64Array           // seq → epoch ms de observed_at, para rangos y orden
  tokens?:   Map<string, Set<string>>   // token en minúsculas → keys (ver §3.3)
}
```

Borrar `claims.idx` no pierde información: se reconstruye leyendo el `.jsonl`. La CI tiene
un test que hace exactamente eso y compara los resultados de 50 consultas byte a byte.

### 3.2 Checkpoint

- Se escribe cada `PLINTH_INDEX_CHECKPOINT_EVERY` eventos (por defecto 1 000) o cada 30 s.
- Formato binario propio, con cabecera: versión, `seq` hasta el que cubre, hash del
  esquema del flujo, y CRC32C del cuerpo.
- Escritura atómica: fichero temporal en el mismo directorio + `fsync` + `rename`.
- Al cargar: si la versión, el hash de esquema o el CRC no casan, **se descarta y se
  reconstruye**. Un índice sospechoso nunca se usa.
- Tras cargar el checkpoint se reproduce la cola del `.jsonl` desde su `seq`.

Coste de arranque medido en el benchmark: reconstrucción completa de 100 000 eventos
< 400 ms; carga de checkpoint + cola < 40 ms.

### 3.3 Búsqueda de texto

La v1 especifica "subcadena, sin distinguir mayúsculas, sin ranking". Se mantiene el
contrato — **sin relevancia, sin puntuación, sin ordenación por parecido**, porque eso
sería interpretar — pero se acelera:

- Índice invertido de tokens: se normaliza (NFKD, minúsculas, sin diacríticos) y se parte
  por `\P{L}\P{N}`. `tokens` mapea token → keys.
- Una consulta con `text` se resuelve así: se tokeniza igual, se intersecan los conjuntos
  del token más raro hacia el más común, y **luego se verifica la subcadena literal** sobre
  los candidatos. El resultado es idéntico al escaneo lineal; solo se miran menos
  candidatos.
- Una consulta cuyo `text` no produzca ningún token (por ejemplo `"/api/"`) cae al escaneo
  lineal sobre el conjunto ya filtrado por los demás criterios.
- El orden del resultado lo fija `order`, nunca la búsqueda.

### 3.4 Paginación

```
cursor = base64url({ v: 1, seq: <último seq devuelto>, f: <hash del filtro>, o: <order> })
```

- `f` es un hash estable del conjunto de filtros. Si el cliente cambia un filtro y reusa el
  cursor, se devuelve `INVALID_INPUT` en vez de resultados incoherentes en silencio.
- La paginación es por `seq`, no por *offset*, así que añadir eventos durante el recorrido
  no salta ni duplica elementos.
- `total_matched` es el recuento exacto del filtro, calculado sobre el índice.

---

## 4. Blobs

Almacén por contenido para cuerpos de respuesta, capturas, trazas y cualquier cosa grande.

- **Clave**: `sha256` del contenido en hexadecimal. Idéntico contenido, una sola copia.
- **Ruta**: `blobs/sha256/<2 primeros>/<2 siguientes>/<hash completo>.bin`, para no meter
  cien mil ficheros en un directorio.
- **Metadatos**: un `.meta.json` hermano con `bytes`, `content_type`, `created_at` y
  `sources` (los `seq` de eventos que lo referencian).
- **Escritura atómica**: se escribe a temporal calculando el hash al vuelo, `fsync`,
  `rename` al destino final. Si el destino ya existe, se descarta el temporal.
- **Umbral**: cualquier carga que supere `PLINTH_INLINE_LIMIT` (256 KiB por defecto) va a
  blob. Por debajo, va inline en el evento.
- **Referencia**: `{ "blob": "sha256-a1b2…", "bytes": 91234, "content_type": "image/png" }`.
  El adaptador de protocolo la puede convertir en un `resource_link` MCP.

### Recolección de basura

```
plinth gc [--project P] [--dry-run]
```

1. Recorre los logs **no rotativos** y recoge todos los hashes referenciados: conjunto R.
2. Recorre los segmentos vivos de los flujos rotativos: conjunto V.
3. Para cada blob en disco no presente en R ∪ V y con `created_at` anterior a la ventana de
   gracia (24 h, para no cazar un blob recién escrito cuyo evento aún no ha confirmado):
   se borra.
4. Nada se borra si el escaneo de algún log produjo `LOG_LINE_UNREADABLE`: una línea que no
   se pudo leer puede contener una referencia.

`--dry-run` es el modo por defecto en CI. El barrido automático corre al arrancar, en
segundo plano y con prioridad baja, salvo `PLINTH_GC_ON_START=0`.

---

## 5. API pública

```ts
export interface StorageScope {          // ya acotado a un proyecto
  log<E>(name: string): EventLog<E>
  blobs(): BlobStore
  readonly project: string
}

export interface EventLog<E> {
  append(op: string, key: string, body: E): Promise<Result<AppendReceipt>>
  /** Varios eventos, un único commit. Atómico: o entran todos o ninguno. */
  appendBatch(events: readonly NewEvent<E>[]): Promise<Result<AppendReceipt[]>>

  /** Eventos crudos de una key, en orden. La garantía auditable. */
  history(key: string): Promise<Result<readonly LoggedEvent<E>[]>>
  /** Estado reducido actual de una key. */
  current<S>(key: string): Promise<Result<S | null>>

  query<S>(q: QuerySpec): Promise<Result<Page<S>>>
  /** Recorrido completo sin filtros ni tope. Para export y para el GC. */
  scan(): AsyncIterable<LoggedEvent<E>>

  readonly stats: { events: number; bytes: number; warnings: readonly Warning[] }
}

export interface AppendReceipt { seq: number; id: string; at: string; bytes: number }

export interface QuerySpec {
  text?: string
  tags?: readonly string[]            // conjunción
  author?: string
  from?: string; to?: string          // sobre observed_at
  include?: readonly string[]         // estados del dominio a incluir
  order?: 'observed_desc' | 'observed_asc' | 'recorded_desc' | 'recorded_asc'
  limit?: number                      // 1–500, por defecto 50
  cursor?: string
}

export interface Page<S> {
  items: readonly S[]
  total_matched: number
  next_cursor: string | null
  warnings: readonly Warning[]
}
```

Notas de diseño:

- **`scan()` es un `AsyncIterable`**, no un array: un export de un log de un gigabyte no
  cabe en memoria y no debería intentarlo.
- **`appendBatch` es atómico** porque hay operaciones de dominio que son varias cosas a la
  vez (retractar una afirmación y asentar la que la sustituye) y dejarlas a medias produce
  un registro que miente.
- **No hay `update` ni `delete`.** No es que estén desaconsejados: no existen en la
  interfaz. Es N5 convertido en tipos.

---

## 6. Números y presupuestos

Medidos por `bench/storage.bench.ts` en CI, con umbrales que fallan el build.

| Operación | Meta | Condición |
|---|---|---|
| `append` aislado, `durable` | < 5 ms p99 | SSD NVMe, Linux, ext4 |
| `append` bajo 64 concurrentes | > 8 000 ev/s | Gracias al *group commit* |
| `history(key)` con índice | < 1 ms p95 | |
| `query` con tags + rango, 100 k eventos | < 25 ms p95 | |
| `query` con texto, 100 k eventos | < 40 ms p95 | Índice invertido |
| Reconstrucción de índice, 100 k eventos | < 400 ms | Arranque en frío sin checkpoint |
| Carga de checkpoint + cola | < 40 ms | Arranque normal |
| Memoria del índice, 100 k eventos | < 60 MB | |
| Escritura de blob de 10 MiB | < 120 ms | Incluye hash y `fsync` |

---

## 7. Lo que este almacén NO es

- **No es una base de datos.** No hay transacciones entre flujos, ni joins, ni consultas
  arbitrarias. Si un módulo necesita eso, el módulo trae su base de datos y la declara;
  el núcleo no se convierte en un ORM.
- **No está pensado para escritura masiva concurrente desde varios procesos.** El `LOCK` de
  instancia lo dice de frente. Un despliegue con varias réplicas necesita otro backend, y
  eso será `@plinth/storage-postgres` implementando `EventLog`, con su propio ADR.
- **No cifra en reposo.** Si el registro va a contener datos sensibles, eso es cifrado de
  disco o de volumen, no un problema del formato. Está documentado, no resuelto a medias.
- **No replica ni hace copia de seguridad.** Un `.jsonl` append-only es, precisamente, lo
  más fácil del mundo de copiar con `rsync` y lo más fácil de inspeccionar con `tail`. Esa
  es la ventaja del formato y es deliberada.
