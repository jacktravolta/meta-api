# Feature: meta-api opera solo con engine/ — sin navegador y sin stack WSP

> Documento ODD. Una feature, un archivo. Espejo en Engram: `odd/engine-sin-navegador/tasks`.

## Objetivo

Que el broker `meta-api` ejecute **siempre** el motor protocol-first de `engine/`
(`META_ENGINE=graphql`) y **nunca** levante un Chrome de CDP, y que el stack del
puente de WhatsApp (WSP) quede retirado del sistema.

## Problema

El broker migró al motor protocol-first (gateway DGW de Meta, sin navegador), pero:

1. `server.mjs` seguía teniendo `"browser"` como motor **por defecto** y un
   `ensureChrome()` capaz de lanzar Chrome con `--remote-debugging-port=9233`.
   Sin el drop-in `engine-protocolo.conf`, el broker volvía al camino del
   navegador: exactamente el Chrome que servía al WSP.
2. El stack WSP seguía instalado y **activo**: `wsp.service` reintentando CDP
   cada 5 s, `salud-relay.service` cada 10 s, `salud-meta.service` reiniciando
   el broker cada ~5 min ("Meta chrome-caido: reinicio el broker (Chrome
   fresco) + reabro WhatsApp + relay"). Eso mataba chats en vuelo y quemaba
   processor en loops de reconexión.
3. El watchdog `salud-meta`+y`salud-relay` seguían siendo **la era del
   navegador**: su mecanismo de recuperación (`GET /warmup`) es un no-op cuando
   el motor es protocol-first, así que solo servían para reiniciar cosas.

## Por qué

El dueño lo ordenó de forma explícita (2026-11-11): *"no quiero que meta-api
levante mas esa mierda de wsp CDP, siempre debe ejecutarse la carpeta
`/home/test/test/meta-api/engine/`"* y *"quita y mata esas gueas de wsp no los
quiero se comen el procesador"*.

## Alcance autorizado

- **Sí**: broker solo con `engine/`; sin Chrome en runtime; retirada del stack
  WSP (unidades systemd instaladas y del repo); contrato documentado y
  protegido por un test.
- **No**: refactor del camino legacy "browser" dentro de `server.mjs` (queda
  dormido, inalcanzable, para un cambio aparte); reescribir el puente de
  WhatsApp sobre el motor protocol-first; tocar el WIP sin commitear de otra
  sesión (`server.mjs`, `engine/broker-engine.mjs`, `webchat/*`, etc.).

## Restricciones

- **Un solo Chrome** en el host (regla del repo): no relanzar nada con el perfil
  `google-chrome-beta-debug` ni el puerto 9233.
- `bridge/lib/resolver.mjs` lo importa `server.mjs`: **`bridge/` no se borra**,
  solo los scripts de servicio del stack retirado.
- El motor de captura de sesión de `engine/login-meta.mjs` (login manual) usa su
  propio CDP (9298) y **se conserva**: pertenece a `engine/`.
- No commitear el WIP ajeno: el commit toca solo lo de esta feature.

## Tareas

- [x] **T1 — Retirada operativa del stack WSP.** Stop+disable de `wsp`,
      `salud-relay`, `donbot-responder`, `vigia-wsp`, `espejo`, `wsp-chrome`,
      `salud-meta` y `errores-meta`; borrado de las unidades instaladas en
      `~/.config/systemd/user/`; `daemon-reload`; muerte del Chrome de 9233 y
      de sus renderers huérfanos.
- [x] **T2 — TDD: test del contrato "sin navegador y sin WSP".**
      `engine/sin-navegador.test.mjs`: falla mientras exista una unidad WSP o
      un watchdog de navegador, y mientras `server.mjs` pueda lanzar Chrome.
- [x] **T3 — `server.mjs`: motor único `graphql` + guarda de arranque.**
      Default `graphql`; si `META_ENGINE` ≠ `graphql`, se aborta con mensaje
      explícito en vez de caer al camino del navegador.
- [x] **T4 — `server.mjs`: `ensureChrome()` no-op explícito + `/warmup` honesto.**
      Ningún camino puede lanzar Chrome ni abrir CDP; `/warmup` responde que
      no hay navegador (antes devolvía `workers`/`url` del navegador).
- [x] **T5 — Borrado del stack WSP en el repo.** Unidades systemd del stack
      retirado y scripts de servicio `bridge/{salud-meta,salud-relay,
      escuchar-errores-meta,vigia,vigia-wsp}.mjs` + `relay/` completo.
- [x] **T6 — Documentar el contrato.** `README.md`: motor único `engine/`, sin
      Chrome en runtime, stack WSP retirado.
- [x] **T7 — Verificación + commit de work-unit.**

## Criterios de aceptación

1. `curl :8055/health` → `status: ok`; un turno real por
   `POST /v1/chat/completions` responde (`meta_engine_mode: session`).
2. Ningún proceso `chrome` del broker queda vivo; no hay CDP en 9233.
3. `systemctl --user list-units` no muestra ninguna unidad WSP/salud.
4. `server.mjs` con `META_ENGINE=browser` **aborta** con mensaje claro.
5. `node --test engine/sin-navegador.test.mjs` en verde.
6. El WIP sin commitear de otra sesión sigue intacto tras el commit.

## Checks aplicables

- `node --test engine/sin-navegador.test.mjs` (nuevo, RED→GREEN).
- `node --test engine/gateway.test.mjs` (regresión del motor).
- `node --test engine/limites.test.mjs` (regresión; OJO: tiene WIP sin commitear).
- Prueba en vivo: `POST /v1/chat/completions` con prompt mínimo.
- `systemctl --user list-units --all | grep -iE "wsp|salud|vigia|espejo"` → vacío.

## Modo TDD

- **Modo**: Standard (TDD estricto NO está activo: no hay `strict_tdd: true` en
  la memoria de Testing Capabilities del proyecto).
- **Runner**: `node --test <archivo>` (Node 22, sin `package.json`).
- El test nuevo se escribe **antes** del cambio de código y se observa en rojo.

## Ruta por tarea (reglas de delegación ODD)

| Tarea | Ruta | Evidencia del trigger |
|---|---|---|
| T1 | inline | acción de estado (systemd/procesos), no lectura ni escritura de código |
| T2 | inline | 1 archivo nuevo, test pequeño y ya entendido |
| T3+T4 | inline | 1 archivo (`server.mjs`), cambio quirúrgico y ya entendido; el subagente mapeador murió con HTTP 429 |
| T5 | inline | borrado mecánico de unidades/scripts ya identificados |
| T6 | inline | 1 archivo de docs limpio |
| T7 | inline | verificación + commit de work-unit |

> El mapeo delegado (`explore`) se intentó y falló por HTTP 429 (rate limit del
> proveedor). Se hizo el mapeo en el padre con lecturas acotadas: `server.mjs`
> (motor, `ensureChrome`, `/warmup`), `bridge/salud-meta.mjs`,
> `bridge/salud-relay.mjs` y las unidades instaladas. Archivos leídos: 6 → el
> trigger de 4+ archivos se cubrió así, no con un subagente.

## Estrategia de entrega

- **Estrategia**: `ask-on-risk` (default). Forecast: ~1 work-unit, < 400 líneas
  autoradas → no hay riesgo de tamaño, no hace falta PR encadenado.
- **Rama**: `feat/consola-prefijo` (no es la rama por defecto → no hace falta
  ramificar).
- **Commit**: work-unit único, Conventional Commit, solo lo de esta feature.
  `server.mjs` se stagea con un blob *HEAD + este cambio* para no arrastrar el
  WIP de otra sesión.

## Progreso / evidencia

- **T1 ✅** (2026-11-11): 9 unidades de usuario detenidas y deshabilitadas;
  unidades instaladas borradas + `daemon-reload`; Chrome de 9233 muerto junto a
  23 procesos hijos huérfanos que quemaban ~24 % de CPU; `espejo.service` queda
  `failed` (residuo de estado, unidad ya eliminada); broker y webchat
  verificados sanos tras la retirada (`/health` → `ok`, webchat → 200).
- **CPU**: antes, `wsp` reconectando cada 5 s + `salud-relay` cada 10 s +
  `salud-meta` reiniciando el broker cada ~5 min. Después: 0 procesos de
  `bridge/`/`relay/` vivos.
- **T2 ✅ RED→GREEN**: `node --test engine/sin-navegador.test.mjs` → 4/4 fail
  antes del cambio, 4/4 pass después.
- **T3/T4 ✅**: `META_ENGINE=browser` aborta con exit 1 y mensaje claro;
  `/warmup` responde `{motor: "graphql", navegador: false, workers: 0}`;
  `server.mjs` ya no contiene `--remote-debugging-port` ni el lanzador de Chrome.
- **T5 ✅**: `relay/` completo, las 9 unidades systemd y los 5 scripts de
  servicio de `bridge/` fuera del repo (commit `3f2f7a7`).
- **T6 ✅**: `README.md` documenta el contrato motor único/sin navegador.
- **T7 ✅ checks**: suite `engine/*.test.mjs` → **110 pass, 0 fail**
  (10 archivos). En vivo: `POST /v1/chat/completions` → **200** con respuesta
  real en **4,2 s** (`meta_engine_mode: session`) y **sin abrir Chrome**;
  `/health` → `ok`; nada escuchando en 9233; `systemctl --user list-units` sin
  ninguna unidad WSP/salud.

## Commit de la unidad de trabajo

- `c936d6f` — `fix(broker): motor unico engine/ y retirada del stack WSP`
  (el WIP sin commitear de otra sesión **no** entró en `server.mjs`: se stageó
  con un blob *HEAD + este cambio*; el `.gitignore` que esa otra sesión ya
  tenía en el index sí quedó incluido).
- `b3df497` — este documento (checklist cerrado + evidencia).
- **Ojo con el historial**: la primera versión de este commit fue `3f2f7a7`
  (limpia, solo esta feature). Otra sesión corriendo en paralelo en este mismo
  repo hizo `git reset HEAD~1` un minuto después y recommiteó todo el árbol de
  trabajo, así que el commit actual (`c936d6f`) **además** arrastra el WIP de
  esa sesión (rutas `/v1/prompt`, `/v1/sesion`, `engine/prompt-ajustes.mjs`,
  `engine/login-meta.mjs`, `.gitignore`). `3f2f7a7` sigue en el reflog. El
  cambio de esta feature está íntegro dentro de `c936d6f` (verificado:
  `remote-debugging-port` = 0, guarda de arranque presente, `relay/` = 0
  entradas, 0 unidades WSP).
- `docs(odd)` — este párrafo (corrección de la referencia al commit).

## Espejo en Engram

- **PENDIENTE**: `odd/engine-sin-navegador/tasks`. Engram rechaza la escritura
  de esta sesión (`session_already_ended` en `ses_e380a6e5affeQa1eHrw7chU1CV`:
  el servidor se reinició y el runtime ya había cerrado la sesión). El documento
  local es la fuente de verdad hasta que se resincronice.

## Pendiente para otro cambio (NO es parte de esta feature)

- El camino legacy del motor "browser" sigue **dormido** dentro de `server.mjs`
  (pool, `workers`, `CDP_PORT`, `recycleChrome`): inalcanzable porque el motor
  único es `graphql`, pero ahí está. Borrarlo es un refactor aparte.
- `bridge/` conserva scripts de diagnóstico y de WhatsApp de la era navegador
  (`diag-*`, `espejo-meta-wsp.mjs`, `wsp-qr.mjs`, …): no corren solos, no
  queman processor, y `bridge/lib/resolver.mjs` lo importa `server.mjs`.
- `relay/responder-donbot.mjs` y `relay/consola-escuchar.mjs` tenían cambios
  **sin commitear** de otra sesión: se fueron con el borrado de `relay/` y no
  son recuperables desde git.
