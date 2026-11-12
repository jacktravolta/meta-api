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

- [x] **T1** Versionados: fuera de git las salidas de runtime de `bridge/`
      (10 archivos: `agent-log.txt`, `dictado-log.txt`, `espejo-log.txt`,
      `espejo-msg.txt`, `msg-tecnica.txt`, `espejo-vistos.json`,
      `espejo-vistos-img.json`, `hilo-nuevo.json`, `turno.json`, `wsp-qr.png`).
      El mas importante era `espejo-log.txt`: arrastraba conversaciones
      completas dentro del repo. Los archivos siguen en disco (los scripts los
      regeneran) y ahora estan ignorados.
- [x] **T2** Versionados: **33 scripts sin una sola referencia** en el repo
      (grep de basename sobre los versionados, cero coincidencias):
      29 de `bridge/` (diagnosticos del CDP de WhatsApp, era WSP retirada) y
      4 de `engine/` (`sweep.mjs` —"experimento temporal" segun su propio
      archivo—, `probe-img.mjs`, `probe-tools.mjs`, `screenshot-juego.mjs`).
      Se conserva `engine/mejorar-imagen.mjs`: es herramienta de uso manual, no
      un residuo.
- [x] **T3** Locales: `webchat/__pycache__/`, `state/` (5 volcados), 9
      `engine/diag-*.mjs` de una vez (NO `engine/diag-vacio.mjs`, que esta
      versionado), `.atl/.skill-registry.cache.json`.
- [x] **T4** `.gitignore`: cubren lo borrado (`__pycache__/`, `*.pyc`, `state/`,
      los logs de `bridge/`, `engine/.prompt-ajustes.json`, `games/`,
      `.codegraph/`).
- [x] **T5** Verificado: tests en verde, `/health` 200, front 200.

## Evidencia

- `node --test engine/*.test.mjs` → 117 pass, 0 fail.
- `node --test agent/*.test.js` → 1 fallo **preexistente**
  (`agent/sandbox.test.js` "selfCheck enforces the whole default posture",
  depende del host): reproducido en un worktree limpio de HEAD, sin mis cambios.
- `curl http://127.0.0.1:8055/` → 200; `/health` → 200.
- `git status --porcelain` → arbol limpio.
- 11 commits en la sesion, del `8cf7000` al `79533fc`.

## Lo que quedo (y por que)

- `bridge/` conserva los scripts del WSP que el documento de la feature
  `guard-canal-whatsapp` referencia (`chk-wsp.mjs`, `probe-wsp.mjs`,
  `ver-wsp.mjs`, `wsp-qr.mjs`, `fix-wsp-layout.mjs`, `reload-wsp.mjs`,
  `simular-usuario.mjs`, `espejo-meta-wsp.mjs`, `enviar-media-wsp.mjs`). Son
  historia documentada de una feature cerrada; borrarlos dejaria los docs
  mintiendo. Si en algun momento se limpian esos docs, se borran con ellos.
- `bridge/lib/` esta vivo: `bridge/lib/resolver.mjs` lo importa `server.mjs`.
- `bridge/reglas.txt` es contenido (reglas del donbot), no salida de runtime.
- `engine/capture-*.mjs`, `engine/dgw-*.mjs` y `engine/probe.mjs` se quedan:
  son los arneses con los que se descubrio el protocolo; su conocimiento esta
  en `engine/PROTOCOL.md` pero el arnes sirve para re-verificar.
- `engine/fixtures/capture-ws-*.json` se quedan: son capturas del protocolo
  real, no se regeneran baratas.


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
