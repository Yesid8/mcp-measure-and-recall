# ADR-0004 — Hablar también la era de sesión (`initialize`)

**Estado**: aceptada, 2026-09-30 · **Revisa [ADR-004](../v2/10-decisiones.md)** (solo la
revisión moderna) y la parte de [ADR-0001](0001-implementar-protocolo-sin-sdk.md) que lo
aplicaba. Deja intacto [ADR-0002](0002-el-sdk-v2-se-publico-con-otro-nombre.md).

## Contexto

El servidor hablaba solo `2026-07-28`: sin `initialize`, con un sobre `_meta` obligatorio en
cada petición. Al conectarlo un consumidor real con Claude Code 2.0.33 y 2.1.281, ninguno
llegaba a usarlo:

- Claude Code abre con `initialize`, y la respuesta era `-32022` *"this server implements
  MCP 2026-07-28, which removed the initialize handshake"*. Estado: `failed`.
- Aunque se saltara el saludo, sus `tools/list` y `tools/call` no llevan `_meta`, y cada uno
  se rechazaba con `-32602` *"missing required _meta field"*.

Un servidor que el cliente más usado no puede abrir no sirve a nadie, por correcta que sea
su revisión del protocolo.

## Medida previa: ¿lo resuelve ya el SDK v2?

Instalado `@modelcontextprotocol/server@2.1.0` (hoy `latest` es `2.2.0`) y leído el paquete:

- `@modelcontextprotocol/core` declara `SUPPORTED_PROTOCOL_VERSIONS` desde `2025-11-25`
  hasta `2024-10-07`, con `LATEST_PROTOCOL_VERSION = '2025-11-25'`.
- `serveStdio` decide **la era por conexión con el primer mensaje**: `initialize` sin sobre
  moderno abre la era de sesión, y un sobre `_meta` válido la de `2026-07-28`. Su opción
  `legacy` vale `'serve'` por defecto.

Es decir: **sí, el SDK v2 habla ambos ciclos**. Adoptarlo resolvería esto, pero es el
*spike* B1 entero —sustituir `src/protocol/` y `src/transport/` con las 13 comprobaciones de
03 §8 como criterio—, y lo que bloquea al consumidor es una sola cosa acotada.

## Decisión

Implementar en la capa propia **el mismo modelo que usa el SDK**, para que una migración
futura no cambie el comportamiento observable:

1. `initialize` con `2025-06-18` o `2025-11-25` abre una sesión con esa versión; con
   cualquier otra se responde la más alta de las dos, y es el cliente quien decide si sigue.
   La respuesta lleva `protocolVersion`, `capabilities: { tools }`, `serverInfo` e
   `instructions`.
2. `notifications/initialized` se acepta, y `ping` se responde en ambas eras.
3. En una conexión abierta con `initialize`, una petición **sin** sobre `_meta` se atiende
   con la versión negociada, y su resultado tiene la forma de esa era: sin `resultType` ni
   sugerencias de caché.
4. Una petición **con** sobre se atiende como `2026-07-28`, en cualquier conexión. Una
   conexión que no abrió sesión sigue exigiendo el sobre. `server/discover` no cambia.

Solo se aceptan las dos versiones de 2025 que tienen `structuredContent` y `outputSchema`,
de los que depende cada resultado. Las anteriores no los conocen.

El estado de la sesión vive en el transporte —uno por conexión, en `serveStdio`— y no en
`ProtocolServer`, que sigue sin estado propio: `handle(mensaje, sesión)`.

## Consecuencias

- Claude Code 2.0.33 conecta (`"status":"connected"`) y llama herramientas; comprobado con
  `claude -p … --mcp-config … --strict-mcp-config --output-format stream-json` contra el
  binario compilado.
- La comprobación 4 de [03 §8](../v2/03-protocolo.md) —*`initialize` se rechaza nombrando
  la versión*— queda sustituida por el flujo completo de la era de sesión sobre el
  transporte real.
- El *spike* B1 sigue en pie y ahora tiene un criterio más: las pruebas de ambas eras deben
  pasar sin cambios.
