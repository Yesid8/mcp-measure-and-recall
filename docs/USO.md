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

El perfil activo aparece en las `instructions` de `server/discover`.

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

## Qué hacer con lo que estorbe

Anótalo en [hallazgos-uso-real.md](hallazgos-uso-real.md): qué intentaste, qué esperabas,
qué obtuviste, y qué seguiste haciendo a mano. Las molestias reales son lo que decide qué
entra en la etapa B; las conjeturas no.
