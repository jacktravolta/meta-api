# canal-estable-clear

## Objetivo
Que cada canal se identifique por **id de usuario + id de proyecto** (no por un
hash del primer mensaje), que el hilo se retome SIEMPRE en la misma conversacion
de Meta (se conserva la memoria y no se duplican las conversaciones en su
historial), que los archivos que genera Meta vivan en el storage del canal
(`<canal>/archivos/<turno>/`), y que exista un **clear** explicito que limpie el
canal (conversacion nueva) sin cambiar su id.

## Problema (evidencia: store engine/.conversations.json + capturas del usuario)
1. **Clave volatil.** `server.mjs` derivaba la clave del hilo con
   `payload.user || x-meta-conversation || claveAutomatica(msgs)`, y
   `claveAutomatica` es el hash del PRIMER mensaje del usuario. Si ese primer
   mensaje cambia (o el cliente no manda `user`), la clave cambia y se abre una
   conversacion NUEVA en Meta: el historial del usuario muestra N entradas
   "[90] [PETICION ACTUAL] Usu..." para el MISMO canal. El store tiene ~40
   claves `auto-*` de las ~108 totales.
2. **Store sin la estructura del canal.** El store del broker
   (`engine/.conversations.json`) se indexa por `${userId}:${channel}`; con la
   clave automatica no queda registro de a que canal (usuario + proyecto)
   pertenece cada conversacion.
3. **Storage disperso.** Los archivos se guardaban en
   `engine/.media/<conversationIdDeMeta>/<turno>/`: Meta ROTA el id de
   conversacion entre turnos, asi que un canal vivia repartido en N carpetas y
   no se podia leer "la carpeta del canal".
4. **No hay "clear".** El broker solo cambia de conversacion cuando un turno
   FALLA (`#resetHilo`, archivo protegido): no hay forma de limpiar el canal de
   forma explicita. El boton "Nueva conversacion" del webchat inventaba un
   `hiloId` nuevo, lo que dejaba la conversacion vieja en el historial de Meta
   (otra fuente de duplicados).
5. **Turnos largos se cortan.** `META_TURN_DEADLINE_MS` (75 s) cortaba
   presentaciones: "turno sin respuesta completa en 37909ms (meta se quedo
   pensando)" -> 504 y turno perdido (y el reset del hilo, otro duplicado).

## Alcance autorizado
- T1 `server.mjs`: identidad de canal (`user` + `project`), generacion por
  canal (clear), storage `<canal>/archivos/<turno>/`, marca de canal al
  principio del prompt, endpoint `POST /v1/chat/clear`, timeouts mas holgados.
- T2 `engine/artifacts.mjs`: el historial de entregas por hilo se lee del
  storage nuevo del canal y, como respaldo, del `.hilo/<hash>` legacy (para no
  perder el historial de los hilos ya vivos).
- T3 `webchat/server.py`: proxy `POST /api/clear` + timeout del proxy holgado.
- T4 `webchat/index.html`: boton "Limpiar canal" (mismo `hiloId`, canal
  limpio) en vez de inventar un hilo nuevo.

## Restricciones
- NO tocar `engine/broker-engine.mjs`, `engine/gateway.mjs`, `engine/prompt.mjs`,
  `agent/sandbox.js` ni los `.json` de estado del broker
  (`engine/.conversations.json`, `engine/.rooms.json`).
- NO reiniciar systemd. NO Docker. NO commitear: restriction vigente durante
  la implementacion, LEVANTADA el 2026-11-02 por el usuario ("comitea"); el
  commit se hizo por unidades de trabajo (ver "Commits").
- No romper a los clientes que hoy no mandan `project`: sin `project`, la clave
  sigue siendo el `user` de antes (mismo hilo, misma memoria).
- Comentarios y UI en espanol; identificadores en el idioma del archivo.

## Criterio de aceptacion
- Dos turnos seguidos con el mismo `user` + `project` -> UNA sola conversacion
  en el historial de Meta y la misma `meta_conversation_id`.
- "Limpiar canal" -> el siguiente turno abre una conversacion nueva en Meta
  manteniendo el mismo id de canal.
- Los archivos del turno quedan en `engine/.media/<canal>/archivos/<turno>/` y
  se sirven en `/v1/media/<canal>/archivos/<turno>/<archivo>` con el MIME real.
- Un turno de presentacion (~40-60 s de reflexion de Meta) NO se corta por
  deadline.

## Verificacion
- `node --check server.mjs` y `node --check engine/artifacts.mjs`.
- Reinicio de la API (8055) y del webchat (8060) con las variables del
  entorno ya usadas en esta sesion.
- E2E por el proxy: 2 turnos con el mismo canal -> mismo
  `meta_conversation_id`; `POST /api/clear` -> id de conversacion nuevo.
- E2E de artefactos: pedir un pptx -> URL 200 con MIME real.

## Estado / progreso
- [x] T0 Diagnostico (store, captura del usuario, logs de los 504).
- [x] T1 Identidad de canal + storage + clear + timeouts (server.mjs).
- [x] T2 Historial por hilo con respaldo del legacy (engine/artifacts.mjs).
- [x] T3 Proxy del clear + timeout (webchat/server.py).
- [x] T4 Boton "Limpiar canal" (webchat/index.html).
- [x] T5 Reinicio + E2E (mismo hilo, clear, artefactos).
- [x] T6 Sandbox POR HILO + recursos del sandbox + shim de render_helpers
      (engine/artifacts.mjs): sin esto el .pptx no se podia reproducir.
- [x] T7 MIME servido por contenido (no por extension) en /v1/media.
- [x] T8 Commits de unidad de trabajo (4 unidades + este doc) y espejo engram.

## Evidencia observada (2026-11-02, API 8055 + webchat 8060)
- Canal estable: 2 turnos con user=90/project=1 -> MISMA `meta_conversation_id`
  (a539c638...) y meta responde "sigo con el hilo [90][1]".
- Clear: `POST /v1/chat/clear` -> `{canal:"90_1", generacion:1}`; el turno
  siguiente -> conversacion NUEVA (8c522ca0...), el id del canal intacto.
-Otro proyecto (90/2) -> conversion distinta (no se cruzan hilos).
- Storage: `engine/.media/<canal>/archivos/<turno>/<archivo>`; el historial del
  hilo en `<canal>/.hilo/` y el sandbox del hilo en `<canal>/.sandbox-cache/`.
  Las carpetas internas (`.hilo`, `.sandbox-cache`, `.scripts`, `.canales`)
  responden 404.
- Timeouts: con idle 45 s el gateway cortaba el turno ("stream sin frames por
  45000ms (meta se quedo pensando)") aunque el deadline fuera de 3 min. Con
  idle 120 s / deadline 300 s / presupuesto 420 s, un turno de presentacion de
  226 s se completo sin 504.
- `.pptx` (canal 90_4): turno 1 -> chart_precip.png + chart_temp.png +
  slide_content.md; turno 2 -> `santiago_clima_ppt_clima_Santiago.pptx`
  (101 157 B, magic PK, mime
  application/vnd.openxmlformats-officedocument.presentationml.presentation).
- Causa del `.pptx` perdido: el sandbox de meta es POR HILO (las imagenes
  `resource/*.webp` y los graficos que genero el turno anterior) y su helper
  `render_helpers.py` solo existe en su sandbox. Sin cache por hilo, sin bajar
  los recursos con su nombre original y sin el shim, el script del .pptx
  fallaba con FileNotFoundError y no se entregaba nada.
- Tests: 43 pass (gateway, limites, prompt, toolcall) + prueba offline del
  espejo sobre los dumps reales (con cache: .pptx; sin cache: se reproduce el
  bug).

## Commits (2026-11-02, rama feat/consola-prefijo)
| Commit | Unidad | Archivos |
| --- | --- | --- |
| `945cedc` | Modulos del engine que `server.mjs` importa (sin trackear: el arbol commiteado no arrancaba) | `engine/prompt.mjs`, `engine/prompt.test.mjs`, `engine/dump.mjs`, `engine/ajustes.mjs`, `engine/apikeys.mjs` |
| `8579af9` | Espejo de artefactos por canal + sandbox POR HILO | `engine/artifacts.mjs` |
| `9740203` | Canal estable, clear explicito, media por canal, timeouts | `server.mjs` |
| `b26ff13` | App webchat (proxy + boton "Limpiar canal") | `webchat/server.py`, `webchat/index.html` |
| (este commit) | Documento del feature | `odd/tasks/canal-estable-clear.md` |

Orden obligatorio: `945cedc` -> `8579af9` -> `9740203` -> `b26ff13`.
`server.mjs` importa los cuatro modulos de `945cedc`; con `9740203` sin
`945cedc` el arbol no arranca (imports rotos).

Fuera de estas unidades (WIP de otra linea de trabajo, NO commiteado):
`engine/gateway.mjs`, `engine/broker-engine.mjs`, `engine/limites.test.mjs`,
`relay/responder-donbot.mjs`, `systemd/*.service`, `engine/INTEGRACION.md`,
`.atl/skill-registry.md`, `.gitignore`, `bridge/*` (logs/estado runtime),
`engine/diag-*.mjs` (scripts de diagnostico), `state/`, `games/`,
`.codegraph/`, `webchat/__pycache__/`.

## Ruta elegida
Delegated direct (writer unico): 4 archivos no triviales -> trigger de writer.
RDD global OFF (`gentle-ai review mode status`): la revision nativa no se
lanza; la entrega sigue la politica del repositorio. La revision del
mapeo de unidades se delego a un subagente `explore` y fallo con HTTP 429
del proveedor de modelos; el mapeo se hizo en el orquestador con lecturas
acotadas (diff por funcion y por import).

## Pronostico de entrega
Pronostico original: ~180 lineas. Real: **~2.474 lineas authored** en el
feature (engine/artifacts.mjs 1.335, server.mjs 456, webchat/ 1.474) mas
620 lineas de los modulos del engine que `server.mjs` necesita -> **~3.094
lineas**, muy por encima del budget de 400.

**`size:exception` aceptada por el usuario** ("comitea", 2026-11-02): se
committea en 4 unidades de trabajo en vez de una, sin PR encadenado
todavia. Push/PR: decision del usuario.
