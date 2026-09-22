# ADR-0001 — Implementar el protocolo sin el SDK oficial

**Estado**: aceptada, 2026-09-22 · **Anula la decisión de [ADR-003](../v2/10-decisiones.md)
sin anular su razonamiento.**

---

## Contexto

La especificación (documentos 00–10) está escrita íntegramente contra la revisión MCP
`2026-07-28`, y [ADR-003](../v2/10-decisiones.md) decidió usar `@modelcontextprotocol/sdk`
aislado tras `src/protocol/`. El ARRANQUE de la etapa A1 ordenaba instalar el SDK, leer sus
tipos y, si no encajaban, **parar y avisar antes de escribir código contra otra revisión**.

Se hizo esa comprobación antes de escribir nada. Estos son los hechos medidos, no supuestos:

**La revisión `2026-07-28` existe y es la actual.** Verificado en tres fuentes
independientes: `modelcontextprotocol.io/specification/versioning` la declara *Current*;
existe `docs/specification/2026-07-28/` en el repositorio; y el esquema normativo
`schema/2026-07-28/schema.ts` (98 426 bytes, HTTP 200) declara
`LATEST_PROTOCOL_VERSION = "2026-07-28"`. Las siete afirmaciones del documento 03 sobre esa
revisión (sin `initialize`, `server/discover` obligatorio, `resultType` en todo resultado,
sin sesiones ni `Mcp-Session-Id`, `subscriptions/listen`, *Roots*/*Sampling*/*Logging*
obsoletos, y MRTR con `resultType: "input_required"`) son **ciertas**.

**Ningún SDK de TypeScript la habla.** `@modelcontextprotocol/sdk@1.30.0` es la única
versión publicada bajo el único dist-tag existente (`latest`); se publicó el **2026-07-27**,
un día antes de la fecha de la revisión. Leído de su propio artefacto instalado:

```
LATEST_PROTOCOL_VERSION      = '2025-11-25'
SUPPORTED_PROTOCOL_VERSIONS  = 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07
incluye '2026-07-28'         → false
```

Contraste de superficie sobre `dist/esm/types.js` del paquete real:

| Construcción | Documento 03 | SDK 1.30.0 |
|---|---|---|
| `server/discover` | obligatorio | ausente |
| `resultType` | en todo resultado | ausente |
| `subscriptions/listen` | sustituye a GET y a `resources/subscribe` | ausente |
| `Mcp-Session-Id` | eliminada | ausente (pero hay sesiones) |
| `initialize` | eliminado | presente, y negocia la versión |
| `sampling` / `roots` / `elicitation` | obsoletos o sustituidos por MRTR | presentes |

No hay versión *prerelease*: `npm view dist-tags` devuelve únicamente `latest: 1.30.0`.

## Decisión

**Implementar la capa de protocolo directamente contra el esquema normativo**, sin el SDK.

El esquema se descarga una vez y se versiona en `vendor/mcp-schema-2026-07-28.ts`. Es
TypeScript puro: tipos más diez constantes, entre ellas los códigos `-32020`, `-32021` y
`-32022` que el documento 03 ya citaba. Es la fuente oficial, no una interpretación.

La frontera de ADR-003 **se mantiene intacta y gana importancia**: nada de protocolo sale de
`src/protocol/`. Lo que cambia es qué vive dentro de esa carpeta — un adaptador sobre el SDK
antes, la implementación del transporte ahora.

### Alternativas descartadas

**(a) Usar el SDK sobre `2025-11-25` y migrar después.** Es el camino corto y es el que más
cobertura pierde. El código hablaría un dialecto con `initialize`, sesiones y peticiones
servidor→cliente: exactamente lo que los documentos 03 y 10 declaran eliminado. La
especificación quedaría desalineada con el código desde el primer día, y las comprobaciones
1–5 y 10–12 del [03 §8](../v2/03-protocolo.md) no se podrían escribir tal como están.
Además, ADR-004 (solo la revisión moderna, sin modo *dual-era*) quedaría vacío de contenido.

**(b) Esperar a que el SDK se actualice.** Sin fecha anunciada y sin *prerelease*. Bloquea
el hito que de verdad decide el proyecto —verificar algo real con el servidor— por una
dependencia que no controlamos.

## Consecuencias

**A favor.** El servidor cumple la especificación tal como está escrita, sin reescribirla.
ADR-004, ADR-010 (handles en vez de sesiones) y la "excepción única" de ADR-018 —aislar el
protocolo desde el primer día porque la revisión movió sesiones, handshake, errores y
transporte a la vez— siguen en pie y ahora están respaldados por una medida, no por una
lectura. El alcance real es acotado: para stdio, `2026-07-28` es JSON-RPC delimitado por
líneas más un router de cuatro métodos, precisamente porque la revisión eliminó el
handshake, las sesiones y la reanudación.

**En contra.** Hay que mantener ~400–600 líneas propias que el SDK habría dado hechas, y la
conformidad con el protocolo depende de nuestros tests y del esquema versionado, no de una
dependencia mantenida por terceros. Las validaciones de cabeceras de HTTP
([03 §7](../v2/03-protocolo.md)) habrá que escribirlas a mano cuando se llegue a ese
transporte; en la etapa A solo hay stdio, donde no existen.

**Reversibilidad.** Cuando un SDK soporte `2026-07-28`, sustituir la implementación por el
adaptador es un cambio confinado a `src/protocol/`, y las comprobaciones de
[03 §8](../v2/03-protocolo.md) son exactamente la red que dice si la sustitución fue fiel.
Esa es la frontera que ADR-003 quería comprar, y se conserva entera.

## Verificación

El esquema versionado es la referencia: `vendor/mcp-schema-2026-07-28.ts` se compila con el
resto del proyecto, de modo que si nuestros tipos se desvían de los normativos, el
`typecheck` falla.
