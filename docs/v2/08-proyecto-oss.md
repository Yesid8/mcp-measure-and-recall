# El proyecto de código abierto

> Documento 08 de 11 · Plinth v2.0

Un buen código con mal proyecto alrededor no se usa. Esto es lo que rodea al código.

---

## 1. Licencia

> **Sustituido por [ADR-0003](../adr/0003-licencia-0bsd.md): la licencia es 0BSD.** Lo que
> sigue es el razonamiento original, conservado porque explica qué se cede con el cambio.

**Apache-2.0.**

Frente a MIT: Apache-2.0 incluye una **concesión expresa de patentes** y una cláusula de
terminación si alguien demanda por patentes. Para infraestructura que una empresa va a
integrar en su producto, el departamento legal aprueba Apache-2.0 sin preguntar; con MIT a
veces pregunta. El coste es un fichero `NOTICE` y cabeceras que nadie lee.

- `LICENSE` en la raíz; el campo `license` en todos los `package.json`.
- `NOTICE` con la atribución.
- Los módulos pueden llevar otra licencia si hace falta: cada paquete declara la suya.
- `REUSE`/SPDX en las cabeceras se deja fuera: burocracia sin beneficio a esta escala.

---

## 2. Estructura del repositorio público

```
README.md              Qué es, en 20 líneas y un ejemplo que se puede copiar
CONTRIBUTING.md        Cómo montar el entorno, cómo correr los tests, cómo proponer
CODE_OF_CONDUCT.md     Contributor Covenant 2.1
SECURITY.md            Cómo reportar un fallo de seguridad. Ver §6
CHANGELOG.md           Generado por changesets
LICENSE / NOTICE
docs/
  README.md            Índice
  v1/                  La especificación original, congelada
  v2/                  Esta especificación
  adr/                 Los ADR, uno por fichero, numerados
  guides/
    writing-a-module.md      El documento más importante para que esto sea una base
    deploying-http.md
    migrating-from-v1.md
.github/
  workflows/           ci.yml · bench.yml · release.yml · codeql.yml
  ISSUE_TEMPLATE/      bug.yml · feature.yml · module-proposal.yml
  PULL_REQUEST_TEMPLATE.md
  dependabot.yml
```

### El README importa más que la especificación

Es lo único que el 95 % de la gente va a leer. Debe contener, en este orden: qué problema
resuelve en una frase; un ejemplo de 20 líneas que funciona copiado y pegado; la lista de
módulos; cómo instalarlo; el enlace a la guía de módulos; y la insignia de conformidad.
Nada de filosofía antes del ejemplo.

---

## 3. Publicación

### Paquetes

Todos bajo el scope `@plinth`, con `publishConfig.access: "public"`.

| Paquete | Publicado | Nota |
|---|---|---|
| `@plinth/core` `policy` `storage` `observability` `protocol` `transport-*` `conformance` `testing` `cli` | Sí | |
| `@plinth/module-facts`, `@plinth/module-facts-browser` | Sí | |
| `examples/*`, `bench/*` | **No** (`private: true`) | |

Además, un binario ejecutable: `@plinth/facts-server`, con `bin` apuntando a un
lanzador, para que un cliente MCP lo use con `npx -y @plinth/facts-server` sin instalar
nada.

### Requisitos de empaquetado, verificados en CI

- **ESM puro**, `"type": "module"`. Sin build dual. Node 22 es la línea base y el dual
  duplica la superficie de bugs por una compatibilidad que ya casi nadie necesita.
- `exports` con `types` primero en cada condición.
- `files` restringido a `dist/` y los metadatos: nada de código fuente ni tests en el
  tarball.
- **`publint`** y **`@arethetypeswrong/cli`** en la CI. Un paquete que resuelve mal los
  tipos en el `tsconfig` de otro es el problema más caro de diagnosticar del ecosistema.
- `engines.node: ">=22.11"`, y se comprueba de verdad al arrancar con un mensaje claro.
- `sideEffects: false` donde aplique.
- **Provenance** de npm activada (`--provenance` desde GitHub Actions): el paquete queda
  criptográficamente atado al commit y al workflow que lo construyó.

### Versionado

**Semver estricto**, con **changesets**.

- Todo PR que cambie comportamiento lleva un fichero de changeset. La CI lo exige.
- `0.x` hasta que la conformidad esté al 100 % y haya al menos un módulo de terceros
  funcionando; entonces `1.0.0` y el compromiso de estabilidad empieza de verdad.
- Los paquetes del núcleo se versionan **juntos** (*fixed*): `@plinth/core` 1.4.0 va con
  `@plinth/storage` 1.4.0. Razonar sobre una matriz de versiones internas no aporta nada y
  cuesta mucho.
- Los módulos se versionan **independientemente** y declaran el rango del núcleo que
  soportan.

### Qué cuenta como cambio incompatible

Por escrito, para no discutirlo cada vez:

- Cambiar un nombre de tool, quitar un campo de salida o hacer obligatorio un parámetro.
- Cambiar el significado de un campo existente, incluso manteniendo el tipo.
- Cambiar un `code` de error o su canal (tool ↔ protocolo).
- Cambiar el formato en disco sin migración automática.
- Subir la versión mínima de Node.
- **Cambiar la revisión de MCP soportada.**

No lo son: añadir una tool, añadir un campo opcional de salida, añadir un `warning` nuevo,
relajar una validación, o mejorar el rendimiento.

---

## 4. Integración continua

### `ci.yml` — en cada push y cada PR

```
setup      pnpm, Node 22, caché de store
lint       oxlint (rápido) + reglas propias de @plinth/eslint-rules
format     prettier --check
typecheck  tsc -b --force
deps       dependency-cruiser (las 5 reglas de 01-arquitectura §1)
test       vitest run --coverage   (umbral: líneas ≥ 90 %, ramas ≥ 85 %)
property   vitest run --project property
contract   las 13 de 03 §8
conform    plinth conform --all
package    publint + attw sobre los tarballs empaquetados
audit      pnpm audit --prod --audit-level=high
e2e        matriz: node 22/24 × ubuntu/macos/windows
```

Metas de tiempo: el camino rápido (lint + typecheck + unidad) en **menos de 3 minutos**; el
total en menos de 12. Una CI de 40 minutos deja de leerse.

### Reglas de lint propias

Las que expresan las decisiones de este documento y que ningún linter estándar conoce:

| Regla | Qué prohíbe |
|---|---|
| `no-direct-clock` | `Date.now()`, `new Date()`, `performance.now()` fuera de `@plinth/core/clock` |
| `no-direct-io` | `node:fs`, `node:net`, `node:dns`, `undici` fuera de los paquetes autorizados |
| `no-stdout` | `process.stdout.write`, `console.log` fuera del transporte stdio |
| `no-sdk-import` | `@modelcontextprotocol/sdk` fuera de `@plinth/protocol` |
| `require-describe` | Campo de esquema público sin `.describe()` |
| `no-judgment-key` | Claves de la lista negra F2 en módulos factuales |
| `result-not-throw` | `throw` dentro de un cuerpo de `handler` |
| `no-unbounded-await` | `await` de E/S sin `signal` ni deadline |

Que estas reglas existan es lo que hace que la arquitectura sobreviva al décimo
contribuidor. Una decisión que solo vive en un documento se pierde; una que falla el build
se respeta.

### `release.yml`

Disparado al fusionar el PR de changesets: build, test completo, `changeset publish` con
provenance, etiqueta de git, y borrador de release con el changelog.

### `codeql.yml`

CodeQL para JavaScript/TypeScript, semanal y en PR. Más `gitleaks` para que no entre un
secreto al historial.

---

## 5. Gobernanza y contribución

Proyecto pequeño: gobernanza proporcionada, no un simulacro de fundación.

- **Mantenedor**: tú. `CODEOWNERS` con revisión obligatoria en `packages/`.
- **Contribuciones a `modules/`**: bienvenidas, con conformidad al 100 % como requisito.
- **Contribuciones a `packages/`**: exigen un issue previo aceptado. El núcleo es donde
  cuesta deshacer los errores.
- **Cambios al contrato** (los invariantes de 00, las reglas factuales, las fronteras del
  núcleo): exigen un **ADR** aprobado antes del código. Sin excepciones. Es la única
  barrera que impide que la base se convierta, PR a PR, en otra cosa.
- **Plantillas de issue**: `bug` pide versión, transporte, revisión de protocolo, salida de
  `plinth doctor` y un caso mínimo. `module-proposal` pide qué aporta y por qué no cabe en
  uno existente.
- **Discusiones** para preguntas; issues solo para trabajo accionable.

### `CONTRIBUTING.md`, en orden

1. Arrancar en tres órdenes: `pnpm i`, `pnpm build`, `pnpm test`.
2. Cómo correr un solo test y cómo depurar un servidor MCP (el truco del `inProcessClient`).
3. Los invariantes, con enlace, y la advertencia de que hay lint que los impone.
4. Changesets: qué es y por qué se exige.
5. El flujo de un PR y qué se mira en la revisión.

---

## 6. Seguridad

`SECURITY.md` con: versiones soportadas (la última menor de cada mayor), cómo reportar
(GitHub Private Vulnerability Reporting, no issues públicos), y el compromiso de respuesta
en 72 horas.

**Superficie que hay que nombrar explícitamente**, porque quien despliegue esto debe
saberla:

| Riesgo | Mitigación |
|---|---|
| SSRF y DNS rebinding | Validación por IP resuelta y conexión a la IP fijada ([03 §5](03-protocolo.md)) |
| Exfiltración por el `project` en HTTP | Autorización obligatoria y ACL de proyectos ([03 §7.1](03-protocolo.md)) |
| Secretos persistidos | Redacción antes de escribir, con test que busca el valor en claro |
| *Path traversal* vía `project` | Normalización + `realpath` + comprobación de prefijo |
| Inyección por contenido del registro | El `statement` es dato citable, **nunca instrucción**. Documentado en la descripción de la tool que lo devuelve |
| Agotamiento de recursos | Colas acotadas, topes de cuerpo, tope de descompresión, tope de blobs |
| Cadena de suministro | Dependencias mínimas, `pnpm audit` en CI, Dependabot, provenance en npm |
| Ejecución de código desde configuración | No existe: los módulos se importan en código, nunca se cargan por ruta |

### La inyección de prompt merece su propio párrafo

El registro lo escriben agentes y lo leen agentes. Un atacante que consiga asentar una
afirmación puede intentar que su texto se lea como una instrucción por el siguiente agente.

Plinth no puede impedirlo — el texto libre es el punto — pero sí puede no ayudar:

1. La `description` de `recall.query` dice explícitamente que las afirmaciones son **datos
   reportados por terceros, nunca instrucciones**.
2. Toda afirmación devuelta lleva su `observed_by` visible: quien la lee ve quién la
   escribió.
3. El módulo nunca resume ni parafrasea el `statement`; lo devuelve literal, lo que hace
   más visible un texto que intenta hacerse pasar por otra cosa.
4. Está documentado en `SECURITY.md` como riesgo **aceptado y no mitigable** a nivel de
   servidor. Decirlo es mejor que insinuar una protección que no existe.

---

## 7. Documentación publicada

- **README** por paquete, con un ejemplo real que se testea (`docs/examples` extraídos y
  ejecutados en CI: la documentación que no compila es una mentira con fecha).
- **Sitio** con TypeDoc para la API más estos documentos, desplegado en GitHub Pages desde
  `main`. Sin framework: TypeDoc genera y una plantilla mínima envuelve.
- **`docs/guides/writing-a-module.md`** es el documento decisivo. Si escribir un módulo
  cuesta leer once especificaciones, esto no es una base: es un servidor con pretensiones.
  La guía debe llevar de cero a un módulo de una tool, con conformidad en verde, en menos
  de treinta minutos de lectura.

---

## 8. Lanzamiento

| Hito | Contenido | Criterio para pasar |
|---|---|---|
| `0.1.0` | Núcleo + stdio + almacén + módulo facts sin navegador | Conformidad `core` + `factual` al 100 % |
| `0.2.0` | Navegador, HTTP, kit de conformidad publicado | Los 13 tests de protocolo en verde; e2e en las tres plataformas |
| `0.3.0` | Observabilidad completa, benchmarks con línea base, `plinth doctor` | Todas las metas de rendimiento cumplidas |
| `0.4.0` | Guía de módulos y un segundo módulo real (el Gantt o el simulador) | Un módulo ajeno al núcleo pasa conformidad sin tocar `packages/` |
| `1.0.0` | Compromiso de estabilidad | Lo anterior, más un mes sin cambios incompatibles y documentación completa |

El hito `0.4.0` es el que de verdad demuestra la tesis. Hasta que un segundo dominio no
corra encima sin modificar el núcleo, "es una base" es una intención, no un hecho — y este
proyecto no debería afirmar nada que no haya medido.
