# ADR-0003 — Licencia 0BSD

**Estado**: aceptada, 2026-09-22 · **Sustituye a [ADR-012](../v2/10-decisiones.md)**
(Apache-2.0) y a [08 §1](../v2/08-proyecto-oss.md).

## Contexto

ADR-012 eligió Apache-2.0 por su concesión expresa de patentes y su cláusula de terminación,
pensando en empresas que integran la infraestructura en su producto. Al preparar la
publicación, el propietario pidió **la licencia más abierta posible**.

## Decisión

**0BSD** (BSD de cero cláusulas, SPDX `0BSD`): permiso para usar, copiar, modificar y
distribuir con cualquier fin, con o sin pago, **sin exigir atribución**, más la exención de
garantía.

Frente a las alternativas que también cumplen "lo más abierta posible":

| Opción | Por qué no |
|---|---|
| Unlicense, CC0 | Son cesiones al dominio público, y en países de derecho civil —España y Latinoamérica incluidos— el autor no puede renunciar a todos sus derechos; la cesión queda en parte sin efecto. 0BSD es una licencia, y vale igual en todas partes |
| MIT | Exige conservar el aviso de copyright. 0BSD es MIT sin esa condición |
| MIT-0 | Equivalente en la práctica; 0BSD está aprobada por la OSI desde antes y es la más citada |

## Consecuencias

- `LICENSE` en la raíz, `"license": "0BSD"` en `package.json`. No hace falta `NOTICE`.
- **Se pierde la concesión expresa de patentes** que motivaba ADR-012. Para este servidor el
  riesgo es bajo —no implementa nada patentable conocido—, pero si una empresa lo pidiera
  como condición, la vuelta a Apache-2.0 es posible mientras todas las contribuciones sigan
  siendo del propietario, y deja de serlo sin el acuerdo de cada contribuyente.
