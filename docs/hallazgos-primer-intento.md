# A5 — el primer intento, y lo que dejó

> 2026-09-22 · **La etapa A5 no se completó.** No por un fallo del servidor: la lista de
> comprobaciones que debía verificarse contra una aplicación real no existía, y se decidió
> aplazar la prueba hasta que la haga su primer consumidor, desde su propio proyecto.
>
> Este documento existe para que quien retome A5 no repita la búsqueda.

---

## 1. Qué se intentó y dónde se paró

El objetivo era verificar con las seis tools una lista de comprobaciones de una aplicación
local que este proyecto no conoce. Faltaban dos datos: dónde corría la aplicación y dónde
estaba esa lista.

**El primero lo resolvió el propio servidor.** El segundo no existía, y ahí se paró: sin
comprobaciones con ruta, puerto, mensaje o panel, no había nada que medir contra la app.

### Cómo se encontró la aplicación

Se sondearon con `facts.measure.http` los puertos locales a la escucha, sin saber qué era
cada uno. Las respuestas cayeron en cuatro grupos:

| Grupo | Medida |
|---|---|
| **Tres puertos** | `200 text/html`, con un comentario HTML que identifica la app |
| Dos puertos | `CONNECTION_RESET` — aceptan la conexión y la cortan: hablan un protocolo binario, no HTTP |
| Dos puertos | `TIMEOUT` |
| Tres puertos | `CONNECTION_FAILED` |

Los tres primeros eran instancias del mismo binario, confirmado por PID. Los números de
puerto, las rutas y los PID se omiten: describen una máquina, no el servidor.

---

## 2. Los hallazgos que sí produjo el contacto real

Diez llamadas a `facts.measure.http` contra servicios reales — no fixtures. Es poco, pero es
uso real y vale como entrada de la etapa B.

### A favor de la herramienta

**Sirvió para descubrir, no solo para verificar.** La app se localizó sondeando puertos con
la tool. Que `CONNECTION_RESET`, `TIMEOUT` y `CONNECTION_FAILED` sean códigos distintos
resultó directamente útil: separa "hay algo que no habla HTTP" de "no hay nada" de "el
destino rechaza". Un `ok: false` genérico habría aplanado las tres situaciones, y un puerto
con un protocolo binario no se habría distinguido de uno cerrado.

**Ningún campo invitó a concluir nada.** Un `200` con HTML fue un `200` con HTML. Que eso
significara "la app está sana" lo decidió quien preguntaba, que es el reparto que el
servidor existe para mantener.

### Lo que estorbó

**Diez preguntas del mismo tipo fueron diez llamadas.** No hay forma de medir varias rutas
en una invocación, así que localizar la app costó diez ciclos con su envoltura completa cada
uno. Para una lista de quince comprobaciones serán quince envolturas en contexto.

> Candidato de etapa B: `measure.tcp` — *"¿hay algo escuchando en este puerto?"* es la
> pregunta que se hizo diez veces aquí, y no necesita HTTP para responderse. Está ya
> especificada en [05 §9](v2/05-modulo-facts.md) como extensión compatible.

**El cuerpo ocupó contexto sin aportar.** Con `max_body_bytes: 800` llegaron 800 bytes de
`<!DOCTYPE html>` por puerto, cuando lo que identificaba la app eran los primeros ~60
caracteres. `HEAD` evitaría el cuerpo, pero entonces se pierde el comentario HTML que fue
justo lo que la identificó.

> Candidato de etapa B, y es un parámetro, no una tool: algo como `body_head_bytes`,
> distinto de `max_body_bytes`, para pedir el principio del cuerpo sin descargarlo entero.

### Sin evaluar

`recall.assert`, `recall.retract`, `recall.query`, `recall.history` y `measure.ws` **no se
usaron**. No se asentó ninguna afirmación: hacerlo sin una comprobación que la pidiera
habría sido ruido en el registro, no evidencia.

---

## 3. El dato que A5 quería medir, y que sigue sin existir

> ¿Verifico mi aplicación con esto, en vez de a mano? ¿Y tardo más o menos?

**No se puede responder todavía, y no se va a estimar a posteriori**: un número ajustado al
resultado es exactamente lo que A5 pedía evitar. Quien retome la etapa debe anotar su
estimación *antes* de empezar.

---

## 4. Para quien retome A5

1. **La lista de comprobaciones.** No un documento formal: qué se verifica hoy a mano de la
   aplicación, con su ruta, puerto o panel. Es lo único que falta para que A5 arranque.
2. **Conectar el servidor** como indica [USO.md](USO.md), con su propio `PLINTH_DATA_DIR`.
3. **Anotar la hora de inicio y la estimación manual antes de empezar.**

Los dos candidatos de etapa B de §2 ya están identificados por uso real, no por conjetura.
Si aparecen otra vez en la prueba de verdad, entran con dos evidencias en vez de una.
