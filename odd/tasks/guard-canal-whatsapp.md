# Feature: Guard de canal permitido en el relay de WhatsApp

## Objetivo
Que `relay/wsp.mjs` jamás lea ni escriba en un chat que no esté en la lista blanca
de canales (actualmente `BOTEST`). Falla cerrada: si el destino es desconocido, no envía.

## Problema
El 2026-10-06 22:41 (-03) el relay adoptó el chat `numero eliminado` (contacto real)
porque `wsp.mjs` copia sin validar el título de la pestaña abierta y lo persiste en
`relay/state/wsp-chat.json`. Entre 22:41 y 22:54 se enviaron ~7 mensajes de `[META]`
a ese contacto y se procesaron sus respuestas como input del cerebro.

Evidencia: `relay/state/wsp-log.txt` líneas 1201-1224, `relay/state/wsp-chat.json`.

## Causa raíz
No existe validación de destino en ningún punto de decisión de `wsp.mjs`:
la regla "solo BOTEST" no estaba codificada en ningún lado (ni código, ni docs, ni memoria).

## Por qué
Un agente que decide destino por "lo que esté abierto en la pestaña" tiene permiso
implícito para escribirle a cualquier contacto de la agenda.

## Alcance
- **In:** lista blanca de canales en módulo puro testeable; guard en los 4 puntos de
  decisión de `wsp.mjs`; remediación del estado persistido; test unitario; test dry-run
  de solo lectura que confirma el canal.
- **Out:** reinicio de servicios (requiere decisión del usuario), commits/push de otros
  archivos, cambios en el canal de Meta (`bridge/`).

## Restricciones
- El test NO envía datos: sin `Input.insertText`, sin `Enter`, sin `dispatchMouseEvent`.
- Sin dependencias nuevas (el proyecto es cero-deps, sin package.json).
- Fail-closed: destino vacío/desconocido => no envía.

## Checklist
- [x] T1 Crear `relay/canal-ok.mjs` (allowlist + `canalPermitido()`)
- [x] T2 Guard en `wsp.mjs`: carga de `wsp-chat.json`, auto-descubrimiento, adopción de chat, y verificación previa en `enviar()` — puntos (a)-(e), diff: +51/-3
- [x] T3 Remediar `relay/state/wsp-chat.json` -> `BOTEST`
- [x] T4 Test unitario `relay/canal-ok.test.mjs` — 8/8 pass
- [x] T5 Test dry-run solo-lectura `relay/dryrun-canal.mjs` — exit 0 en vivo
- [ ] T6 Correr checks y commit work-unit (PENDIENTE: esperando T7-T9)

## Fase 2 — extensión a la implementación general (pedido del usuario)

- [x] T7 Mapear TODOS los escritores de WhatsApp (barrido `Input.*` + `.click(` + `web.whatsapp`)
      Resultado: `wsp.mjs` guardado; `espejo-meta-wsp.mjs` cubierto vía `wsp.mjs --enviar`;
      SIN GUARDAR: `simular-usuario.mjs`, `abrir-botest.mjs`, `diag-descarga.mjs`
- [x] T8 Auditoría de descartados (fuera de alcance del writer): `ver-wsp`, `chk-wsp`, `probe-wsp`,
      `diag-audio*`, `bajar-audio`, `fix-viewport`, `fix-wsp-layout`, `reload-wsp`, `salud-meta`
      => solo lectura / reload / clic en `play`; NO envían mensajes. No requieren guard.
      Falso positivo aclarado: `dryrun-canal.mjs` matchea `.click(` en su lista de tokens PROHIBIDOS.
- [x] T9 Guard en `simular-usuario.mjs`, `abrir-botest.mjs`, `diag-descarga.mjs` + sección en README
      => completado y verificado por el orquestador: `node --check` OK x3, tests 8/8,
      dry-run exit 0; el `canalPermitido()` queda ANTES del primer `Input.*` en los 3.
- [ ] T10 Commit work-unit (pendiente; el tree sigue sin stagear)
- [ ] T11 **Bloqueante de R5.** `abrirChat()` con `#pane-side{display:none}`:
      `row.getBoundingClientRect()` devuelve `{0,0,0,0}` (VERIFICADO en el DOM real del
      9233), `pos` NO es null, así que haría click en la coordenada `(0,0)` en vez de
      fallar cerrada. Debe cortar cuando `width`/`height` sean 0.

## Reglas del usuario (vinculantes)

Declaradas por el usuario como **reglas** y ordenó registrarlas. Prevalecen sobre
cualquier criterio de implementación propio.

- **R1 — Solo BOTEST.** Todo envío de WhatsApp va únicamente al canal `BOTEST`; nunca a
  un contacto real. Lista blanca exacta en `relay/canal-ok.mjs`, fail-closed.
- **R2 — Validar en vivo es solo lectura.** Ninguna validación puede emitir
  `Input.insertText`, `Input.dispatchKeyEvent`/`Enter` ni ningún mensaje
  ("test sin enviar data"). Se prueba con `dryrun-canal.mjs` y lectura de DOM.
- **R3 — Servicios: subir solo con orden explícita, y siempre en modo visible.** Al
  subirlos, el browser queda visible (`META_VISIBLE=1`, sin `--headless`) para que el
  usuario supervise e intervenga a mano si hace falta. Nada se reinicia por cuenta propia.
- **R4 — Mostrar el proceso.** Cada paso debe ser observable (browser visible, salida en
  terminal). Nada ejecutado a ciegas.
- **R5 — Una vez dentro del canal, ocultar la lista de contactos** para evitar que un
  movimiento o click accidental del mouse abra un chat real. Es capa visual
  (`relay/ocultar-lista.mjs`); la garantía real sigue siendo `canalPermitido()`.
  Ver T11 antes de activarla sobre `9233`.

## Guardas de seguridad operativa

- Servicios **subidos con orden del usuario** (23:38 y 23:43): `meta-api` pid 16285 con
  drop-in `META_VISIBLE=1` + `DISPLAY=:0` (Chrome visible, sin `--headless`), `wsp` pid
  18514 con el código NUEVO con guardas y `chat: BOTEST`. `espejo`/`salud-meta`/
  `errores-meta` NO reiniciados (mismos PIDs del baseline 23:01).
- El chat envenenado `numero eliminado` ya no circula: `wsp-chat.json` se lee solo al
  arrancar, por eso hizo falta el restart para que la remediación llegara al proceso.
- Chrome de validación manual en `9333` (perfil `google-chrome-wa`) sigue corriendo;
  ningún servicio apunta a él.

## Verificación (TDD off — `strict_tdd: false` en sdd-init/meta-api)
- `node --test relay/canal-ok.test.mjs` -> todo verde
- `node relay/dryrun-canal.mjs` -> reporta canal, sin enviar nada

## Conocidas fallas ambientales
- CDP (Chrome) caído: ninguno de los puertos 9333/9222/9233 escucha. El dry-run debe
  reportarlo honestamente, no inventar PASS.

## Progreso
- [x] Exploración y causa raíz confirmada (lectura de logs + código)
- [ ] T1..T6
