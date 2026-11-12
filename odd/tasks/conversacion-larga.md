# Conversación larga de 5 h contra meta-api

> Feature ODD — registro durable local.
> **Mirror Engram: PENDIENTE** — la sesión `ses_e380a6e5affeQa1eHrw7chU1CV` figura como *ended*
> en Engram (`session_already_ended`) y `mem_save` / `mem_session_summary` no pueden confirmar el
> registro. No se inventa un session ID. Se re-sincroniza cuando exista una sesión registrable.

## Objetivo

Mantener una conversación humana y encadenada contra `POST /v1/chat/completions` durante 5 horas,
con todo el diálogo en un `.txt` que se pueda seguir con `tail -f`, mostrando explícitamente
**quién pregunta y quién responde**.

## Problema

El broker expone un motor protocol-first (`engine/`, `META_ENGINE=graphql`) que ya responde, pero
no había ninguna forma de ejercitarlo de forma sostenida ni de observar el comportamiento real
en el tiempo. La primera corrida de 5 h (12:23–13:30 del 2026-11-11) falló con `fetch failed`
en 2 de 66 turnos y acumuló 11 reintentos.

## Por qué

- Producir evidencia de campo del comportamiento del motor (latencias, stalls, reintentos).
- Tener una conversación con memoria de hilo, para validar que las respuestas encadenadas
  realmente usan el contexto de la sala.

## Alcance

- `engine/conversacion-larga.mjs` — runner de la conversación (cliente HTTP, ritmo humano, log).
- `state/conversacion-larga-*.txt` — logs de las corridas (artefactos de runtime, no versionables).

**Fuera de alcance:** tocar `server.mjs`, `engine/broker-engine.mjs` o cualquier timeout del motor
(pertenecen a otra sesión con WIP abierto). Este trabajo solo mejora el *cliente de prueba*.

## Restricciones y decisiones

| Decisión | Motivo |
| --- | --- |
| Sala fija `user=daniel` + `project=conversacion-larga` | `canalIdDe(usuario, proyecto)` produce una clave estable → mismo `meta_conversation_id` → el hilo recuerda. Verificado: Meta recuerda "Peumo" y "Carla". |
| Cliente con `node:http`, no `fetch` | `fetch` usa undici por debajo, con `headersTimeout = 300 s`: cortaba la conexión antes que el broker y dejaba turnos huérfanos. |
| `TIMEOUT_MS = 900000` (15 min) | El peor caso real del motor es 600 s (ver descubrimientos) + cola del modo serializado. El cliente debe ganar siempre al broker. |
| Reintentos con pausa de 60–120 s, máx. 3 | Un turno huérfano sigue vivo hasta 600 s: reintentar antes es encolar, no recuperar. |
| Sin dependencias nuevas | El repo no tiene `package.json`; no se puede instalar `undici`. |

## Tareas

- [x] **T1** — Verificar el contrato de la API (auth abierta en loopback, sala por `user`+`project`, memoria del hilo). *Ruta: inline* (lectura de 2 archivos: `server.mjs:2100-2131`, `server.mjs:2560-2589`; 0 archivos ≥ 4 → no dispara mapping; 1 archivo no trivial → no dispara writer). Evidencia: la memoria del hilo se comprobó en vivo (preguntó por "Peumo" y lo repitió).
- [x] **T2** — Runner de la conversación: temas encadenados, entradillas, citas de la respuesta previa, ritmo humano, log con roles. *Ruta: inline* (1 archivo nuevo, diseño ya definido; sin investigación pendiente). Evidencia: `node --check` OK + corrida de validación con turnos reales.
- [x] **T3** — Diagnóstico del `fetch failed` y corrección del cliente. *Ruta: inline* (1 archivo). Evidencia: journal del motor → `KEEPALIVE_TIMEOUT` a 299903/600000 ms; reescritura a `node:http` con 900 s.
- [x] **T4** — Repetir la prueba de 5 h desde cero con el cliente corregido. *Ruta: inline* (operación). Evidencia: corrida 13:08–18:08, turno 001 OK en 13,8 s, 0 reintentos.
- [ ] **T5** — Commit del runner en un work-unit propio. *Pendiente de autorización del usuario* (hay WIP de otra sesión sin commitear en 10 archivos).

## Criterios de aceptación

1. El `.txt` distingue emisor y receptor en cada turno. ✔
2. El hilo conserva memoria entre turnos (mismo `meta_conversation_id`, referencias cruzadas). ✔
3. Un turno lento no se corta prematuramente ni deja turnos huérfanos en el broker. ✔
4. La corrida se sostiene 5 h sin intervención. *En curso.*

## Verificación y evidencia

| Corrida | Log | Resultado |
| --- | --- | --- |
| 1 (fetch/undici, 600 s) | `state/conversacion-larga-5h-undici-fetch.txt` | 66 turnos, 2 `ERROR 0` a 300,9 s, 11 reintentos → turnos huérfanos en cascada |
| 2 (`node:http`, 600 s) | `state/conversacion-larga-5h-http600s.txt` | primer turno stalled 11 min → el timeout de 600 s del cliente iguala al del broker (carrera perdida) |
| 3 (`node:http`, 900 s) | `state/conversacion-larga-5h.txt` | 13:08 → 18:08, turno 001 OK 13,8 s, 0 reintentos |

Comandos de verificación usados: `node --check engine/conversacion-larga.mjs`,
`journalctl --user -u meta-api.service`, `curl /health`, `ss -tnp | grep 8055`.

## Modo TDD

No aplica: script de herramienta de observación, sin lógica de negocio ni suite propia. Checks
aplicables = validación de sintaxis + corrida real contra el broker.

## Estrategia de entrega

- Work-unit: 1 commit si el usuario lo pide (`feat(conversacion): runner de prueba de 5 h`).
- Líneas estimadas: ~420 en `engine/conversacion-larga.mjs` (por encima de la heurística de 400;
  se acepta porque es un archivo autocontenido de datos + lógica, no se divide artificialmente).
- RDD: apagado globalmente → sin ciclo de revisión nativo; los checks son los funcionales de arriba.

## Próximo paso

Vigilar `state/conversacion-larga-5h.txt` hasta las 18:08 y reportar turnos lentos, reintentos y
errores. Al cierre, commitear T5 si hay autorización.

## Hallazgos que requieren decisión del mantenedor

1. **`KEEPALIVE_TIMEOUT` de 300/600 s en el motor**: cuando Meta "se queda pensando", el turno
   tarda 5–10 min y el cliente queda colgado esperando. Debería haber un timeout *por turno* en el
   broker más corto, con error claro al cliente.
2. **`POST /v1/chat/completions/async` devuelve un `chat.completion` completo** en vez de `{job_id}`
   (`server.mjs:2524` sirve ambas rutas con el mismo handler).
3. **`/health` no refleja la cola**: con un turno en vuelo sigue reportando `jobs_pending: 0` y
   `concurrency: 0`, aunque las peticiones siguientes están esperando.
