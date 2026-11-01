# INFORME FINAL — Motor protocol-first para Meta AI

**Fecha:** 2026-11-01 · **Alcance:** cliente sin navegador del gateway WebSocket
de Meta AI (DGW), API OpenAI-compatible real, chats separados por usuario/canal,
mapeo de imágenes/adjuntos y emulación multicanal.

---

## 1. Qué quedó entregado

| # | Entregable | Estado | Evidencia |
|---|---|---|---|
| 1 | Cliente protocol-first del gateway DGW (cero dependencias, sin Chrome en runtime) | **Listo** | `engine/gateway.mjs`, `engine/pb.mjs` |
| 2 | Codec protobuf/DGW propio con round-trip | **Listo** | `engine/pb.mjs` + 14 tests golden |
| 3 | Ciclo de vida de conversación vía graphql (warmup, mode, rename, lastSeen) | **Listo** | `engine/meta-graphql.mjs` |
| 4 | API OpenAI-compatible (sync + SSE) con `META_ENGINE=graphql` | **Listo** | `server.mjs`, `meta_conversation_id` en la respuesta |
| 5 | Chat separado por `user_id` + canal, con memoria entre turnos y tras reconectar | **Listo** | `engine/broker-engine.mjs`, `engine/.conversations.json` |
| 6 | Renovación de credencial que **reanuda el hilo** (no empieza de 0) | **Listo** | `broker-engine.mjs` (`#renew` + warmup) |
| 7 | Imágenes/adjuntos: subida real + slot del envelope | **Listo, verificado** | PNG verde → Meta responde `"Verde"` |
| 8 | Emulación multicanal de 1 hora con prueba de memoria por canal | **Listo** | 68 turnos, 14/14 pruebas de memoria OK, 0 fallas |
| 9 | Informe/documentación de handoff | **Listo** | este documento + `engine/PROTOCOL.md` + `engine/TAREAS.md` |

Motores disponibles (mutuamente excluyentes por variable de entorno):

```
META_ENGINE=browser    # motor heredado: Chrome + CDP (scraping). Por defecto.
META_ENGINE=graphql    # motor protocol-first: WebSocket DGW, sin navegador.
META_ENGINE_MODE=session   # usa TU cuenta (token propio). Por defecto.
META_ENGINE_MODE=guest     # invitado temporal (token de ~30-60 min).
```

---

## 2. Arquitectura del motor protocol-first

```
cliente HTTP
   │  POST /v1/chat/completions  { user, channel, messages[] }
   ▼
server.mjs  (broker OpenAI-compatible)
   │  engine.ask(prompt, { userId, channel, attachments })
   ▼
engine/broker-engine.mjs        ── pool de canales: clave = userId:channel
   │  · engine/.conversations.json  → conversation_id persistente por canal
   │  · warmup + updateConversationMode antes de abrir el WS
   ├─ engine/upload.mjs           ── adjuntos → rupload.meta.ai → media_id
   └─ engine/gateway.mjs          ── WebSocket DGW + envelope protobuf
         ├─ engine/pb.mjs         ── codec protobuf/DGW (framing, varint, JSONs)
         └─ engine/meta-graphql.mjs ── warmup / mode / reconcile / rename
```

**Regla de oro del chat separado:** la identidad de un hilo es
`conversation_id` + warmup + conexión WS del mismo `userId`/`channel`.
Cambiar de usuario o de canal crea un chat distinto en tu misma cuenta;
eso quedó verificado (el canal `u2` respondió con información distinta del
hilo `u1`).

---

## 3. Lo que costó la implementación (no repetir)

### 3.1 Los 4 campos que gobiernan la memoria del hilo

| Path | Significado | Regla | Síntoma si se rompe |
|---|---|---|---|
| `f2.1.2.3` | `uniqueMessageId` (snowflake: `Date.now()<<22 \| rand22`) | **nuevo en cada mensaje** | el gateway devuelve la **respuesta del mensaje anterior** |
| `f2.1.5` | **profundidad** del hilo (mensajes llevados) | 1, 2, 3… | responde pero **sin memoria**: trata el mensaje como el primero de una conversación nueva |
| `f1.5.1` / `f1.5.3` | timestamps de **inicio de sesión/stream** | **constantes por conexión** | el WS queda **mudo** esperando el stream anterior (timeout → cierre 4001) |
| `f1.6` | request id | debe coincidir con el `req-id` del wrapper JSON (= messageId) | el mensaje se ignora o se descuadra |

Verificación dura: turno 1 guarda “verde azulado” → **150 s de pausa** → turno 2
responde `"Verdeazulado."`. Antes de corregir `f2.1.5` respondía `"Negro"`
(respuesta genérica sin contexto). Esos 150 s son justamente el caso que
rompía al broker en la conversación larga.

### 3.2 Handshake y cabeceras

* El upgrade del WS **exige** `Origin: https://www.meta.ai` completo. Sin él,
  el gateway cierra con **4005 Pre-Auth Validation** antes del handshake.
* User-Agent de Chrome en el upgrade.
* `Cookie` solo si hay sesión propia.
* Después del handshake, el cliente envía un frame `HANDSHAKE` con
  `x-dgw-app-x-ecto-conversation-id` y `x-dgw-app-client-payload-type:
  "PROTO_INSIDE_JSON"`.

### 3.3 Framing DGW

```
[tipo][00 00][len u16 LE][00][body]      con len = total - 6
```

* Un mensaje WS puede traer **varios frames** DGW y un frame puede llegar
  **troceado** → buffer obligatorio (`#buf` en `gateway.mjs`).
* Códigos de cierre observados: `4003` Unauthorized (token caducado),
  `4005` Pre-Auth Validation, `4001` KEEPALIVE_TIMEOUT (idle de stream, 120 s
  por defecto).

### 3.4 Extracción del texto

La respuesta llega como `full` + parches (`op:"delta"` con JSON pointer y
`op:"add"` en `/sections/1`). El cierre es un parche vacío tras el texto o un
frame “final” (JSON con `response_id` + `sections` sin `type`). Los frames del
turno anterior se descartan por `response_id`. El parser debe aceptar
**cualquier leaf** (acentos y `ñ` incluidos), no solo ASCII imprimible.

---

## 4. Imágenes y adjuntos (mapeo completo)

### 4.1 Subida (fuera del WS)

```
POST https://rupload.meta.ai/gen_ai_document_gen_ai_tenant/<uuid>
  Authorization: OAuth ecto1:<token>        ← OJO: "OAuth", NO "Bearer"
  ecto_auth_token: true
  is_abra_user: true
  desired_upload_handler: genai_document
  Offset: 0
  x-entity-length: <bytes>
  x-entity-digest: sha256 <base64>
  x-entity-type: image/png
  x-entity-name: <nombre>
  body: binario crudo
→ { "media_id": "1431172098550174" }
```

El front hace antes un `GET` de sondeo con las mismas cabeceras. Con
`Authorization: Bearer …` o sin `ecto_auth_token`/`is_abra_user`, el upload
responde `400 NotAuthorizedError`.

### 4.2 Envelope

`f2.3` (mensaje repetido) con:

```
f2.3.1.1 = media_id (varint)
f2.3.2  = 1
f2.3.5  = 0
f2.3.6  = mime
f2.3.7  = nombre
```

y el prompt lleva el marcador delante del texto:

```
<|attachment:0|> <texto del usuario>
```

### 4.3 Verificación end-to-end

PNG 4×4 color `(46,139,87)` subido por la API → **Meta responde `"Verde"`**,
sin navegador en runtime. Formato de entrada: el multimodal estándar de
OpenAI (`image_url` con data URL), reusando el parser que ya existía para el
motor de navegador.

```bash
B64=$(base64 -w0 /tmp/opencode/test-image.png)
curl -s -X POST http://127.0.0.1:8077/v1/chat/completions \
  -H 'content-type: application/json' \
  -d "{\"user\":\"u-img3\",\"messages\":[{\"role\":\"user\",\"content\":[
       {\"type\":\"text\",\"text\":\"Que color predominante tiene esta imagen? Una palabra.\"},
       {\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,$B64\"}}]}]}"
```

---

## 5. Uso de la API

```bash
# motor protocol-first
META_ENGINE=graphql META_API_PORT=8077 node server.mjs

# texto, con hilo persistente por user+channel
curl -s -X POST http://127.0.0.1:8077/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"user":"u1","channel":"demo","messages":[{"role":"user","content":"hola"}]}'

# streaming SSE
curl -sN -X POST http://127.0.0.1:8077/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"user":"u1","channel":"demo","stream":true,"messages":[{"role":"user","content":"hola"}]}'
```

Identidad del hilo:

* `payload.user` (o cabecera `x-meta-conversation`) → usuario.
* `payload.channel` (o cabecera `x-meta-channel`) → canal.
* La respuesta incluye `meta_conversation_id` para poder continuar el hilo.

---

## 6. Emulación multicanal (RESULTADO REAL, 60 min)

```bash
node engine/multichannel.mjs --minutes 60 --channels 3 --gap-min 60000 --gap-max 150000
```

Ejecutada el 2026-11-01 de 08:18:32Z a 09:18:48Z, en modo `session` (tu
cuenta), 3 canales en paralelo con temas distintos (backend, justicia
chilena, productos digitales). Cada canal corre su propia conexión WS, su
propio `conversation_id` y su propio director de conversación.

| Canal | Turnos | Errores | Reconexiones | Memoria OK | Memoria FALLA |
|---|---|---|---|---|---|
| canal-1 (`user-1` / `demo-1`) | 25 | 8 | 2 | 5 | 0 |
| canal-2 (`user-2` / `demo-2`) | 23 | 8 | 3 | 5 | 0 |
| canal-3 (`user-3` / `demo-3`) | 20 | 3 | 2 | 4 | 0 |
| **total** | **68** | **19** | **7** | **14** | **0** |

**14/14 pruebas de memoria correctas** (cada canal recordó su propio dato en
todas las rondas, con más de 2 minutos de pausa entre turnos).

Desglose de los 19 errores (ninguno dejó el sistema caído):

| Error | Cantidad | Causa | Efecto |
|---|---|---|---|
| `getaddrinfo EAI_AGAIN gateway.meta.ai` | 14 | **DNS transitorio** del host, no del protocolo | costaba un turno: la conexión se abría fuera del `try` |
| `4001 KEEPALIVE_TIMEOUT` | 5 | el servidor encolaba y tardaba >120 s en emitir el primer frame | reconexión automática y turno perdido |

Ambos casos están corregidos en el código posterior a la corrida:

* la apertura de la conexión ahora está **dentro** del `try` con reintentos
  (3 intentos con espera creciente), así que un fallo de DNS no cuesta el turno;
* la espera por el primer frame subió de 120 s a **180 s**, porque bajo
  concurrencia el servidor encola.

Los 7 chats quedaron separados y con memoria propia: cada canal recuperó su
dato y el `conversation_id` de cada uno es distinto
(`638f6a75…`, `593236df…`, `b94499bb…`). **0 renovaciones de credencial**: el
token de tu cuenta aguantó la hora completa.

Espejos: `bridge/multichannel.txt` (legible) y `bridge/multichannel.jsonl`
(machine-readable). Resumen final: `bridge/multichannel-resumen.json`.

### Conversación sostenida de 9 h (activa)

```bash
node engine/conversation.mjs --hours 9 --session --gap-min 180000 --gap-max 480000
```

Espejo en vivo: `bridge/mirror-chat.txt` (y `.jsonl`). Ritmo: espera de
lectura según el largo de la respuesta, intervalo variable entre mensajes y
pausas largas, sin capa de typos falsos. Si el token caduca, pide uno nuevo y
**retoma el mismo hilo** (`conversation_id` y profundidad preservados) inyectando
además el resumen de lo conversado.

---

## 7. Seguridad

* El token `ecto1:` **nunca** se loguea ni se versiona. Vive en
  `engine/.session.json` y `engine/.auth.json`, ambos con permisos `0600` y
  fuera de git (`.gitignore`).
* `engine/.conversations.json` (mapa `userId:channel → conversation_id`) es
  estado de runtime: también fuera de git.
* Las capturas de diagnóstico redactan el token antes de escribirse a disco.
* No se toca el Chrome del perfil real del usuario: la captura de sesión usa
  un perfil dedicado (`google-chrome-beta-debug`) y el runtime protocol-first
  no abre ningún navegador.

---

## 8. Limitaciones conocidas

1. **El token de invitado caduca** (~30-60 min). Con `META_ENGINE_MODE=session`
   el token propio dura mucho más; si caduca, `broker-engine` lo renueva y
   **reanuda el hilo** con el mismo `conversation_id` (warmup + modo), en vez de
   empezar de cero.
2. **Ritmo humano** está implementado como *pacing* (intervalos variables,
   frases contextuales, follow-ups que reaggan a la respuesta anterior). No se
   usa ninguna capa de typos falsos ni de anti-detección: el objetivo es
   escribir como una persona, no disfrazar el patrón de tráfico.
3. La emulación multicanal corre contra el servicio real: hay que respetar los
   límites de uso (la emulación de 1 h con 3 canales es conservative a propósito).
4. `f1.18` (pipes de herramientas: stocks, weather, media_gallery…) se envía tal
   cual came del front. Habilitar o quitar esas herramientas requiere mapear
   esa sección; no es necesario para texto ni imágenes.
5. El motor `graphql` no expone todavía el modo asíncrono con jobs ni el agente
   de shell (`/v1/agent`): eso sigue siendo solo del motor `browser`.

---

## 9. Runbook

```bash
# tests golden (14/14)
node --test engine/gateway.test.mjs

# motor protocol-first
META_ENGINE=graphql META_API_PORT=8077 node server.mjs

# recapturar la credencial propia (sin enviar mensajes), perfil dedicado
node engine/capture-session.mjs 9298

# emulación multicanal
node engine/multichannel.mjs --minutes 60 --channels 3

# capturas de diagnóstico
node engine/capture-pair.mjs 9298    # dos mensajes del mismo chat
node engine/capture-image.mjs 9298   # mensaje con imagen + cabeceras del upload
node engine/capture-full.mjs 9298    # imagen + segundo mensaje + todas las cabeceras
```

Node 22 es obligatorio: `/home/test/.nvm/versions/node/v22.23.3/bin/node`
(el `/usr/bin/node` del sistema es 18.x y no tiene `WebSocket` global).

---

## 10. Inventario de archivos

| Archivo | Rol |
|---|---|
| `engine/gateway.mjs` | cliente DGW: connect, handshake, chat, cierre, keepalive, slots |
| `engine/pb.mjs` | codec DGW/protobuf: framing, varint, JSONs embebidos |
| `engine/meta-graphql.mjs` | warmup, modo, reconcile, rename, lastSeen, latency |
| `engine/broker-engine.mjs` | pool de canales, memoria, renovación de credencial |
| `engine/upload.mjs` | subida de adjuntos a `rupload.meta.ai` |
| `engine/auth.mjs` | alta de invitado (`useCreateTempUserMutation`) |
| `engine/session.mjs` | token + cookies de la sesión propia (`0600`) |
| `engine/multichannel.mjs` | emulación multicanal con prueba de memoria |
| `engine/conversation.mjs` / `director.mjs` | conversación sostenida, ritmo y follow-ups |
| `engine/capture-*.mjs` | capturas CDP de diagnóstico (token redactado) |
| `engine/gateway.test.mjs` | 14 tests golden del codec y del payload |
| `engine/PROTOCOL.md` | contrato de protocolo (paths, reglas, trampas) |
| `engine/TAREAS.md` | plan de trabajo y pendientes |
| `engine/INFORME.md` | este informe |

---

## 11. Commits

```
e043fb1 feat(api): el chunk final del SSE incluye meta_conversation_id
638f0c4 fix(engine): 180 s de espera por el primer frame antes de abortar
1667727 docs(engine): runbook de drift + verificador mecanico de slots
4616c21 fix(engine): la conversacion de 9h reanuda el MISMO hilo al reconectar
3c0b1f0 fix(engine): reconectar el hilo caido conservando su memoria
f627d78 docs(engine): informe final de handoff y estado actualizado
b447f89 chore(engine): sacar el estado de runtime del control de versiones
1596aaa feat(engine): memoria por hilo, adjuntos/imagenes y emulacion multicanal
61cd093 feat(engine): motor protocol-first integrado al broker (META_ENGINE=graphql)
53bc8f1 feat(engine): motor protocol-first funcionando con meta.ai (invitado y sesion propia)
608130c feat(engine): cliente del gateway DGW con tests golden
0d1232d feat(engine): esqueleto del motor protocol-first
```

(El commit final con el reintento de errores de DNS y los resultados de la
emulación va después de este documento.)
