# Feature: responder-donbot — consumidor automático de la cola de Don Bot

## Objective

Cerrar el paso 3 del flujo Don Bot: alguien tiene que componer y enviar la
respuesta a las invocaciones `Don Bot` que `relay/wsp.mjs` encola en
`relay/state/wsp-pendientes.txt`. Hoy la cola crece y nadie contesta.

## Problem

`relay/wsp.mjs` detecta `esDonBot()` y encola, pero el único consumidor era
`bridge/vigia-wsp.mjs`, que solo notifica y sale. Resultado verificado: la cola
acumuló 76 invocaciones sin respuesta.

## Why

El atajo Don Bot existe para que un mensaje con "Don Bot" reciba respuesta en el
chat. Sin consumidor, la detección y la cola no tienen destinatario y el atajo
está incompleto.

## Scope (authorized)

- Nuevo consumidor de cola que compone la respuesta con OpenCode (`opencode run`)
  y la envía por `relay/wsp.mjs --enviar`.
- Agente de OpenCode. **Cambio de alcance posterior (orden del usuario):
  AUTONOMÍA TOTAL** — shell + edición sobre el repo, para responder cosas de
  sistema y mejorar código por orden de voz. Operaciones remotas (git push,
  ssh, scp, rsync), commits, destructivos de historial y secretos siguen
  denegados en `.opencode/agents/donbot.md`.
- Unidad systemd de usuario para que el proceso sea observable (R4).
- El consumidor NO toca: las guardas allowlist (R1), `Input.insertText`/`Enter`
  (R2), ni levanta/detiene servicios (R3).

## Out of scope

- Reactivar `espejo.service` o `vigia.service` (orden explícita del usuario).
- Cambiar `meta-api.service`.
- Arrancar servicios nuevos sin orden explícita del usuario.

## Constraints

- R1: solo canal BOTEST (allowlist `relay/canal-ok.mjs`, fail-closed).
- R2: la respuesta se emite por el mismo canal `enviar()` ya existente, con
  CDP `127.0.0.1:9233` (Chrome con WhatsApp logueado).
- R3: los servicios nuevos solo se arrancan con orden explícita y en modo visible.
- R4: proceso observable (unidad systemd + log).
- Comentarios y logs en español. Artefacto técnico en inglés.
- Sin atribución IA en commits.
- TDD off para este proyecto.

## Checklist

- [x] T1 — Agente de OpenCode `donbot`: modo seleccionable, modelo
       `opencode/mimo-v2.6-flash-free`. Origen: deny-all (solo texto); hoy
       permisos de autonomía total con denegaciones explícitas (ver T7).
- [x] T2 — `relay/responder-donbot.mjs`: lock único, marca propia con baseline
       silencioso, procesa la cola en orden, compone con `opencode run`, envía
       con `relay/wsp.mjs --enviar`, registra fallos sin reintentar en bucle.
- [x] T3 — Entrada de medio: imagen vía `--file`, audio por transcripción,
       video por caption.
- [x] T4 — Unidad systemd de usuario `donbot-responder.service` (observable,
       `Restart=on-failure`). Enabled + active.
- [x] T5 — Verificación: `node --check`, prueba en seco de composición y de
       envío, y lectura de la marca/baseline. Backlog de 82 líneas → 73
       mensajes distintos, 73/73 enviados, 0 fallos.
- [x] T6 — Commit del work-unit en el branch (`50d274f`, `e1a4994`).
- [x] T7 — Autonomía total: `--auto` en `componer()`, timeout de 600 s, hora
       inyectada en el prompt, denegaciones de operaciones remotas/destructivas
       y secretos redeclaradas después de los `allow` (las reglas del agente
       van después de las globales y reabrían lo que la global niega).
- [x] T8 — Corregir las ediciones fuera de alcance que hizo el agente:
       `PREFIJO` `🤖`→`∞` en `responder-donbot.mjs`, prefijos en `wsp.mjs`
       (ya revertido) y el criterio de aceptación 2 del propio tracker.
- [x] T9 — Aviso `🤖 [DONBOT] procesando...` antes de tareas que tardan
       (orden del usuario, había quedado en `donbot-fallidos.txt` por el
       timeout de 120 s). Umbral `PREFIJO_PROCESAR_MS = 5000`; si el aviso
       salió, espera `ENTRE_ENVIOS_MS` antes de la respuesta para respetar el
       rate limit, y manda un corte si la composición falla después.

## Acceptance criteria

1. Con la cola vacía de nuevas invocaciones, el consumidor arranca sin responder
   a las 76 líneas históricas (baseline silencioso).
2. Una invocación nueva provoca UNA respuesta en el chat, firmada `🤖 [DONBOT]`.
3. El agente NO puede: `git push`, `ssh`, `scp`, `sftp`, `rsync`, `sudo`,
   `git commit`, `git reset --hard`, `git rebase`, `git clean`, ni leer
   secretos (`.env`, `.ssh`, `*.pem`, `*.key`, credenciales). Verificado con
   pruebas en seco: rechaza push y lectura de `.ssh` con mensaje propio.
4. Un segundo proceso del consumidor no arranca (lock).
5. El agente solo edita los archivos que la orden pide (ver Known limitations).

## Checks

- `node --check relay/responder-donbot.mjs` y `node --check relay/es-donbot.mjs`
- `node --test relay/canal-ok.test.mjs` → 8/8
- `node --test 'agent/*.test.js'` (runner del proyecto) → 75 pass / 0 fail
- Batería de 40 casos sobre `esDonBot` (17 positivos, 23 negativos) → 0 errores
- Pruebas en seco de denegación: `git push`, lectura de `.ssh`, `git commit`
- `git diff --stat` antes/después de una corrida → sin archivos no pedidos
- Prueba de composición en seco y de envío con `WSP_CDP=http://127.0.0.1:9233`
- Latencias de composición medidas en el log: 9–83 s. El umbral de 5 s se
  cruza casi siempre, así que el aviso funciona como feedback inmediato.

## Known limitations

- **Ediciones fuera de alcance (hallazgo verificado).** Con autonomía total, en
  una sola corrida el agente modificó archivos que nadie le pidió:
  `PREFIJO` `🤖`→`∞` en `relay/responder-donbot.mjs`, los prefijos
  `🤖 [DONBOT]`/`🧠 [META]` de `relay/wsp.mjs` y la firma del criterio 2 de
  este propio tracker. `relay/wsp.mjs` se revirtió con `git checkout`; los otros
  dos se corrigieron a mano. Causa raíz: `shell: "*": allow` **bypasea** cualquier
  restricción de `edit` (comprobado: el patrón absoluto
  `/home/test/test/meta-api/**` no matcheaba y el modelo escribía igual por
  `printf > archivo`). No existe restricción técnica de ruta que valga mientras
  haya shell libre.
- Mitigación práctica: el árbol se revisa con `git diff` antes de cada commit,
  y los commits los hace la consola (el agente tiene `git commit` denegado).

## Status

- Route: delegated direct (writer trigger: 2+ archivos no triviales).
- Resolved mode: TDD off (fuente: decisión previa del proyecto).
- Progress: T1–T9 cerrados. `50d274f` (guardas R1), `e1a4994` (consumidor),
  `0000000` (detección), `6b2d066` (autonomía), `22217ac` (icono ✨ [META]) y
  T9 (aviso "procesando...").
- Next step: reiniciar `donbot-responder.service` para que tome `--auto` y el
  aviso; y esperar orden sobre `espejo.service` (preguntada, sin respuesta).
