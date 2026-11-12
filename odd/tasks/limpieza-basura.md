# limpieza-basura

## Objetivo

Quitar del repo la basura acumulada (residuos de runtime versionados,
diagnosticos de una sola vez de una era retirada, caches y volcados) **sin
tocar nada que este vivo ni el trabajo en curso**.

## Problema

El repo tiene 186 archivos versionados y mezcla tres cosas que no conviven:
codigo vivo, salidas de runtime (logs, espejos, volcados JSON, un PNG de QR) y
scripts de diagnostico de una vez de la era WSP/navegador (retirada en
`c936d6f`). Ahi se "codea" basura: lo que no se versiona ocupa disco y lo que
si se versiona ocupa contexto de cada lectura del repo.

Ademas hay entradas sin commitear mezcladas con trabajo real (WIP): hay que
separarlas con criterio, no por fecha.

## Por que

El usuario: "limpiarlo solo de lo que sea basura, hay mucha basura".

## Alcance autorizado

- Borrar residuos de runtime versionados que no son codigo.
- Borrar diagnosticos de una vez sin referencias (comprobado por grep).
- Borrar caches y volcados locales (no versionados).
- Ampliar `.gitignore` para que lo que se limpio no vuelva.
- NO tocar: codigo vivo, WIP sin commitear, fixtures con conocimiento unico,
  documentacion de proceso (`odd/`, `openspec/`, `docs/`).

## Restricciones

- `bridge/lib/resolver.mjs` y `bridge/lib/cdp.mjs` **estan vivos**
  (`server.mjs` importa el resolver). `bridge/` NO se borra entero.
- `engine/sin-navegador.test.mjs` protege la retirada del stack WSP: esos
  archivos no deben volver.
- Los fixtures de captura (`engine/fixtures/`) conservan conocimiento del
  protocolo: no se borran sin evidencia de que no tienen consumidor.
- Nada que pertenezca a `odd/tasks/*.md` (WIP) se toca.

## Checklist

- [ ] **T1** Versionados: salidas de runtime (logs, espejos, volcados, PNG).
- [ ] **T2** Versionados: scripts de una vez sin referencias (`refs=0`).
- [ ] **T3** Locales: `__pycache__`, volcados de `state/`, backups `.bak-*`,
      caches de herramientas.
- [ ] **T4** `.gitignore`: cubrir lo borrado para que no vuelva.
- [ ] **T5** Verificar: tests en verde + `/health` 200 + front 200.

## Criterios de aceptacion

1. Ningun archivo borrado tiene referencias en codigo vivo, systemd ni docs.
2. `node --test engine/*.test.mjs` en verde.
3. `/health` responde 200 y el front responde 200 en 8055.
4. El WIP sin commitear sigue intacto (`git status` lo muestra igual).
5. `.gitignore` cubre los residuos eliminados.

## Checks aplicables

- `node --test engine/*.test.mjs`
- Humo HTTP en 8055.
- `git status --porcelain` para confirmar que el WIP sobrevivio.

## Progreso

- [x] **T3 (parcial)** — Residuos locales sin versionar borrados (316 KB):
      `webchat/__pycache__/` (bytecode Python), `state/` (5 volcados de
      diagnostico: `conversacion-larga-5h*.txt`, `telemetria-meta.jsonl`),
      9 `engine/diag-*.mjs` de una vez (NO se borro `engine/diag-vacio.mjs`,
      que esta versionado), `.atl/.skill-registry.cache.json`.
      El servicio sigue sano tras la limpieza: `/health` -> 200.

## Evidencia

- T3: `git status --porcelain --untracked-files=all` ya no lista residuos;
  `curl /health` -> HTTP 200.

## Ruta por tarea

| Tarea | Ruta | Motivo |
| --- | --- | --- |
| T1-T5 | delegada (1 writer) | borra muchos archivos + edita `.gitignore`: no es un cambio mecanico de un archivo |

## Estrategia de entrega

`ask-on-risk` (default). Forecast bajo 400 lineas: un solo PR.

## Modo TDD

Estandar (no hay `strict_tdd: true` en engram). Runner: `node --test engine/*.test.mjs`.

## Siguiente paso

Esperar el informe de mapeo (referencias por archivo) y congelar la lista
exacta de borrado antes de tocar nada.
