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
- Agente de OpenCode restringido (sin herramientas) para que el cerebro solo
  componga texto: nadie que escriba en WhatsApp debe poder disparar shell/edición.
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

- [ ] T1 — Agente de OpenCode `donbot`: modo seleccionable, modelo
       `opencode/mimo-v2.6-flash-free`, permisos deny-all (solo texto).
- [ ] T2 — `relay/responder-donbot.mjs`: lock único, marca propia con baseline
       silencioso, procesa la cola en orden, compone con `opencode run`, envía
       con `relay/wsp.mjs --enviar`, registra fallos sin reintentar en bucle.
- [ ] T3 — Entrada de medio: imagen vía `--file`, audio por transcripción,
       video por caption.
- [ ] T4 — Unidad systemd de usuario `donbot-responder.service` (observable,
       `Restart=on-failure`).
- [ ] T5 — Verificación: `node --check`, prueba en seco de composición y de
       envío, y lectura de la marca/baseline.
- [ ] T6 — Commit del work-unit en el branch.

## Acceptance criteria

1. Con la cola vacía de nuevas invocaciones, el consumidor arranca sin responder
   a las 76 líneas históricas (baseline silencioso).
2. Una invocación nueva provoca UNA respuesta en el chat, firmada `🤖 [DONBOT]`.
3. El agente restringido no puede ejecutar shell ni editar archivos.
4. Un segundo proceso del consumidor no arranca (lock).

## Checks

- `node --check relay/responder-donbot.mjs`
- `node --test 'agent/*.test.js'` (runner del proyecto)
- Prueba de composición en seco y de envío con `WSP_CDP=http://127.0.0.1:9233`

## Status

- Route: delegated direct (writer trigger: 2+ archivos no triviales).
- Resolved mode: TDD off (fuente: decisión previa del proyecto).
- Progress: diseño cerrado; T1–T5 en implementación.
- Next step: verificar T5 y pedir orden para arrancar la unidad (R3).
