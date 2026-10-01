# Cómo usar facts-mcp

> Para quien va a consumir este servidor MCP —otro agente, otra aplicación— sin haber visto
> el repositorio. Una página.

## Qué es, y qué no es

Un servidor MCP que **mide y recuerda, y nunca juzga**. Mide un servicio HTTP o WebSocket y
devuelve la medida cruda con su hora. Guarda afirmaciones con su evidencia en un registro
por proyecto del que nada se borra.

No sabe nada de tu aplicación: el proyecto es un parámetro de cada llamada, y lo que puede
alcanzar lo decide quien lo arranca. Tres reglas lo sostienen:

1. **Si algo se puede medir ahora, no se responde de memoria.** `recall.*` nunca mide.
   Devuelve cada afirmación con su edad y, si su evidencia es una medida, `remeasure_with`:
   la tool y los argumentos exactos para volver a medirla.
2. **Toda respuesta lleva la hora**, y cada elemento de una lista lleva **su propia** edad.
3. **Ningún campo es un juicio.** `ok` significa solo *"se pudo observar"*.

## Conectarlo

Compilado desde un clon (`npm ci && npm run build`), el bloque para el cliente MCP:

```jsonc
{
  "mcpServers": {
    "facts": {
      "command": "node",
      "args": ["C:/ruta/a/mcp-measure-and-recall/dist/main.js"],
      "env": {
        "PLINTH_DATA_DIR": "C:/ruta/a/datos-de-este-cliente",
        "PLINTH_FACTS_NET_PROFILE": "loopback"
      }
    }
  }
}
```

**`PLINTH_DATA_DIR` propio es obligatorio en la práctica.** El servidor toma un `LOCK` sobre
su directorio de datos: dos procesos escribiendo el mismo registro podrían partir una línea.
Si otro cliente ya usa ese directorio, el tuyo no arranca.

Qué puede alcanzar, según `PLINTH_FACTS_NET_PROFILE`:

| Perfil | Alcanza |
|---|---|
| `loopback` (defecto) | Servicios de la misma máquina |
| `private` | La misma máquina y redes privadas (equipos de tu LAN) |
| `allowlist` | Exactamente los `host:puerto` de `PLINTH_FACTS_ALLOW_HOSTS`, p. ej. `api.example.com:443,www.example.com:443`. Es la forma de medir una web pública |
| `deny-all` | Nada |

El perfil activo aparece en las `instructions` que el servidor entrega al conectar.

Habla las dos eras del protocolo MCP: la de sesión (`2025-06-18` y `2025-11-25`, que se
abre con `initialize` y es la que usan hoy Claude Code y la mayoría de clientes) y la sin
estado de `2026-07-28` (`server/discover` y un sobre `_meta` en cada petición). No hay nada
que configurar: la era la decide el primer mensaje del cliente.

### Los nombres, tal como los ve Claude Code

Claude Code solo admite letras, dígitos, `_` y `-` en el nombre de una herramienta, y
reescribe el resto como `_`. `facts.recall.query` aparece como
`mcp__facts__facts_recall_query`, y esa forma —con el nombre del servidor delante— es la que
usan `--allowedTools` y los permisos de `.claude/settings.json`:

```
claude -p "..." --allowedTools mcp__facts__facts_measure_http,mcp__facts__facts_recall_query
```

## Las seis tools

| Tool | Devuelve |
|---|---|
| `facts.measure.http` | Estado, cabeceras, cuerpo, tiempos y la IP a la que se conectó de verdad |
| `facts.measure.ws` | Los mensajes de N segundos, cada uno con hora absoluta y offset |
| `facts.recall.assert` | La afirmación escrita, con su evidencia incrustada |
| `facts.recall.retract` | La afirmación marcada como retractada, con motivo. No se borra |
| `facts.recall.query` | Afirmaciones con su edad, su marca `stale` y `remeasure_with` |
| `facts.recall.history` | Los eventos crudos de una afirmación, en orden |

El ciclo normal es **medir → asentar → consultar**: `measure.*` devuelve un
`observation_id`, lo citas como evidencia en `recall.assert` con `observed_by` (quién eres),
y más tarde `recall.query` te lo devuelve con su edad.

## Las trampas

- **El cliente no conecta.** Lee su stderr. Toda negativa a arrancar empieza por
  `facts-mcp:` y dice el motivo: el directorio lo retiene otro proceso (y cuál), o una
  variable de configuración no es válida (y cuál).
- **Barras invertidas en Windows.** En JSON `\` es un escape: escribe `C:/ruta` o `C:\\ruta`.
  Un escapado malo crea un directorio con nombre corrupto sin avisar.
- **Un 500 es `ok: true`.** El servidor respondió y eso se midió bien; si el 500 es un
  problema lo decides tú. `ok: false` es solo lo que impidió medir: conexión rechazada,
  DNS, TLS, timeout.
- **Una medida fallida también es evidencia.** "En ese puerto no responde nadie" se puede
  asentar citando el `observation_id` de un `CONNECTION_REFUSED`. Lo que el servidor rechazó
  sin llegar a mirar (`HOST_NOT_ALLOWED`, `URL_INVALID`) no se guarda.
- **`HOST_NOT_ALLOWED` no es un fallo del destino**: es el perfil de red. Pide a quien
  arranca el servidor que lo amplíe; ninguna llamada puede hacerlo.
- **`recall.*` nunca mide**, así que su respuesta puede estar vieja. Mira `age_seconds` y
  `stale`; si importa, vuelve a medir con `remeasure_with`. Lo que ese bloque no incluye
  porque llevaba credenciales está nombrado en `omitted`: ponlo tú.
- **Las credenciales se redactan** antes de guardar, devolver o registrar nada, también en
  el texto de una afirmación. No pegues un token en `statement` esperando recuperarlo.
- **La paginación** de `recall.query` es sobre una instantánea: un cursor solo vale con los
  mismos filtros y orden con que se emitió.

## Construir un servidor propio sobre el núcleo

El paquete exporta el núcleo con el que está hecho facts-mcp, para montar otro servidor MCP
con sus propias herramientas. La forma es `ProtocolServer` más `serveStdio`, **no**
`build()`: `build()` *es* facts-mcp, con su nombre, sus instrucciones, y un almacén que
escribe cada observación en disco bajo un `LOCK` de instancia. `ProtocolServer` no escribe
nada en ningún sitio salvo que se le pase `recordObservation`; hay una prueba de contrato
que lo fija.

```ts
import { ProtocolServer, SystemClock, Ok, defineTool, ndjsonLog, serveStdio } from '@plinth/facts'
import { z } from 'zod'

const salud = defineTool({
  name: 'salud',
  title: 'Estado del servicio',
  description: 'Devuelve el estado del servicio tal como lo informa. No lo valora.',
  input: z.object({}).strict(),
  output: z.object({ estado: z.string().describe('Tal como lo informa el servicio.') }).strict(),
  target: () => ({}),
  handler: async () => Ok({ estado: 'ok' }),
})

const server = new ProtocolServer({
  info: { name: 'mi-servidor', version: '1.0.0' },
  instructions: 'Qué hace este servidor, para el modelo que lo lee.',
  tools: [salud],
  clock: new SystemClock(),
  log: ndjsonLog(process.stderr),
  toolPrefix: 'planner', // publica planner.salud; '' publica salud a secas
  requireProject: false, // sin project en entradas, salidas ni ToolContext
})
serveStdio(server)
```

| Opción | Por defecto | Qué hace |
|---|---|---|
| `toolPrefix` | `'facts'` | Se publica `<prefijo>.<nombre>`; `''` publica el nombre a secas |
| `requireProject` | `true` | Con `false`, el núcleo no exige, no normaliza ni informa `project`; `ToolContext.project` llega vacío |
| `recordObservation` | ninguno | Recibe los resultados de las herramientas marcadas `records: true`. Sin él no se escribe nada |

Al elegir nombres, piense en su forma reescrita: dos herramientas que solo difieran en `.`
frente a `_` (`planner.salud` y `planner_salud`) serían la misma en Claude Code.
`ProtocolServer` se niega a construirse con un par así, en lugar de dejar que el cliente
llame a una u otra al azar.

## Qué hacer con lo que estorbe

Anótalo en [hallazgos-uso-real.md](hallazgos-uso-real.md): qué intentaste, qué esperabas,
qué obtuviste, y qué seguiste haciendo a mano. Las molestias reales son lo que decide qué
entra en la etapa B; las conjeturas no.
